import { describe, expect, test } from '@jest/globals';

import {
    AuthenticationError,
    ConversationBusyError,
    ERROR_CODES,
    ERROR_STATUS_CODES,
    ERROR_TYPES,
    GatewayError,
    InsufficientQuotaError,
    InternalError,
    InvalidRequestError,
    ModelNotFoundError,
    PermissionDeniedError,
    RateLimitError,
    SessionStateUnavailableError,
    TimeoutError,
    isGatewayError
} from '../../../src/errors/index.js';

describe('error codes', () => {
    test('are exactly the documented public contract', () => {
        expect(Object.values(ERROR_CODES).sort()).toEqual(
            [
                'conversation_busy',
                'insufficient_quota',
                'internal_error',
                'invalid_api_key',
                'invalid_request_error',
                'model_not_found',
                'permission_denied',
                'rate_limit_exceeded',
                'session_state_unavailable',
                'timeout'
            ].sort()
        );
        expect(new Set(Object.values(ERROR_CODES)).size).toBe(Object.keys(ERROR_CODES).length);
    });

    test('map every code to a status and a public type', () => {
        for (const code of Object.values(ERROR_CODES)) {
            expect(ERROR_STATUS_CODES[code]).toBeGreaterThanOrEqual(400);
            expect(ERROR_STATUS_CODES[code]).toBeLessThan(600);
            expect(typeof ERROR_TYPES[code]).toBe('string');
        }
    });

    test('use the documented statuses and types', () => {
        expect(ERROR_STATUS_CODES[ERROR_CODES.INVALID_REQUEST]).toBe(400);
        expect(ERROR_STATUS_CODES[ERROR_CODES.INVALID_API_KEY]).toBe(401);
        expect(ERROR_STATUS_CODES[ERROR_CODES.MODEL_NOT_FOUND]).toBe(404);
        expect(ERROR_STATUS_CODES[ERROR_CODES.INSUFFICIENT_QUOTA]).toBe(402);
        expect(ERROR_STATUS_CODES[ERROR_CODES.RATE_LIMIT_EXCEEDED]).toBe(429);
        expect(ERROR_STATUS_CODES[ERROR_CODES.TIMEOUT]).toBe(504);
        expect(ERROR_STATUS_CODES[ERROR_CODES.CONVERSATION_BUSY]).toBe(503);
        expect(ERROR_STATUS_CODES[ERROR_CODES.SESSION_STATE_UNAVAILABLE]).toBe(503);
        expect(ERROR_STATUS_CODES[ERROR_CODES.INTERNAL]).toBe(500);

        expect(ERROR_TYPES[ERROR_CODES.INVALID_REQUEST]).toBe('invalid_request_error');
        expect(ERROR_TYPES[ERROR_CODES.TIMEOUT]).toBe('timeout');
        expect(ERROR_TYPES[ERROR_CODES.CONVERSATION_BUSY]).toBe('conversation_busy');
        expect(ERROR_TYPES[ERROR_CODES.SESSION_STATE_UNAVAILABLE]).toBe('session_state_unavailable');
        expect(ERROR_TYPES[ERROR_CODES.INTERNAL]).toBe('server_error');
    });
});

describe('GatewayError', () => {
    test('defaults to internal_error with the message hidden', () => {
        const error = new GatewayError('boom');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('GatewayError');
        expect(error.code).toBe('internal_error');
        expect(error.statusCode).toBe(500);
        expect(error.type).toBe('server_error');
        expect(error.expose).toBe(false);
        expect(error.details).toBeUndefined();
    });

    test('keeps caller-supplied metadata and the cause chain', () => {
        const cause = new Error('root cause');
        const error = new GatewayError('wrapped', {
            code: ERROR_CODES.TIMEOUT,
            details: { attempt: 2 },
            cause
        });

        expect(error.code).toBe('timeout');
        expect(error.statusCode).toBe(504);
        expect(error.type).toBe('timeout');
        expect(error.details).toEqual({ attempt: 2 });
        expect(error.cause).toBe(cause);
    });

    test('exposes messages of 4xx errors and hides 5xx ones by default', () => {
        expect(new GatewayError('bad input', { code: ERROR_CODES.INVALID_REQUEST }).expose).toBe(true);
        expect(new GatewayError('secret internals').expose).toBe(false);
        expect(new GatewayError('shown', { statusCode: 500, expose: true }).expose).toBe(true);
    });

    test('serializes itself for logs', () => {
        const error = new InvalidRequestError('field missing', { details: { field: 'model' } });

        expect(error.toJSON()).toEqual({
            name: 'InvalidRequestError',
            message: 'field missing',
            code: 'invalid_request_error',
            type: 'invalid_request_error',
            statusCode: 400,
            details: { field: 'model' }
        });
    });

    test('isGatewayError only accepts taxonomy errors', () => {
        expect(isGatewayError(new GatewayError('x'))).toBe(true);
        expect(isGatewayError(new Error('x'))).toBe(false);
        expect(isGatewayError('x')).toBe(false);
        expect(isGatewayError(null)).toBe(false);
    });
});

describe('GatewayError subclasses', () => {
    test.each([
        [InvalidRequestError, 'invalid_request_error', 400, 'invalid_request_error'],
        [AuthenticationError, 'invalid_api_key', 401, 'invalid_request_error'],
        [PermissionDeniedError, 'permission_denied', 403, 'permission_denied'],
        [ModelNotFoundError, 'model_not_found', 404, 'invalid_request_error'],
        [InsufficientQuotaError, 'insufficient_quota', 402, 'insufficient_quota'],
        [RateLimitError, 'rate_limit_exceeded', 429, 'rate_limit_exceeded'],
        [TimeoutError, 'timeout', 504, 'timeout'],
        [ConversationBusyError, 'conversation_busy', 503, 'conversation_busy'],
        [SessionStateUnavailableError, 'session_state_unavailable', 503, 'session_state_unavailable'],
        [InternalError, 'internal_error', 500, 'server_error']
    ])('%p carries its documented code/status/type', (ErrorClass, code, statusCode, type) => {
        const error = new ErrorClass();

        expect(error).toBeInstanceOf(GatewayError);
        expect(error.name).toBe(ErrorClass.name);
        expect(error.code).toBe(code);
        expect(error.statusCode).toBe(statusCode);
        expect(error.type).toBe(type);
    });

    test('use caller-provided defaults where the docs fix the message', () => {
        expect(new AuthenticationError().message).toBe('Invalid API key');
        expect(new ModelNotFoundError().message).toBe('Model not found');
        expect(new TimeoutError().message).toBe('Request timeout');
        expect(new InternalError().message).toBe('Internal server error');
        expect(new ConversationBusyError().message).toBe('Conversation is busy with another request');
        expect(new SessionStateUnavailableError().message).toContain('Could not read the session state');
    });

    test('do not leak the message of an internal error by default', () => {
        const error = new InternalError('connection string went here');

        expect(error.expose).toBe(false);
    });

    test('keep details for diagnostics', () => {
        const error = new SessionStateUnavailableError('nope', { details: { sessionId: 's1' } });

        expect(error.details).toEqual({ sessionId: 's1' });
        expect(error.expose).toBe(true);
    });
});
