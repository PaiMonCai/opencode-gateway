import { describe, expect, test } from '@jest/globals';

import {
    AuthenticationError,
    ConversationBusyError,
    GatewayError,
    InternalError,
    InvalidRequestError,
    ModelNotFoundError,
    RateLimitError,
    SessionStateUnavailableError,
    TimeoutError,
    asGatewayError,
    codeForStatus,
    isTransientUpstreamError,
    toOpenAIError,
    transformUpstreamError
} from '../../../src/errors/index.js';

describe('toOpenAIError', () => {
    test('renders a validation failure with the documented body', () => {
        expect(toOpenAIError(new InvalidRequestError('Model is required'))).toEqual({
            statusCode: 400,
            body: {
                error: {
                    message: 'Model is required',
                    type: 'invalid_request_error',
                    code: 'invalid_request_error'
                }
            }
        });
    });

    test('renders the documented 401', () => {
        expect(toOpenAIError(new AuthenticationError('Invalid API key'))).toEqual({
            statusCode: 401,
            body: {
                error: {
                    message: 'Invalid API key',
                    type: 'invalid_request_error',
                    code: 'invalid_api_key'
                }
            }
        });
    });

    test('renders the documented 404', () => {
        expect(toOpenAIError(new ModelNotFoundError('Model not found'))).toEqual({
            statusCode: 404,
            body: {
                error: {
                    message: 'Model not found',
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            }
        });
    });

    test('renders the documented 504', () => {
        expect(toOpenAIError(new TimeoutError('Request timeout'))).toEqual({
            statusCode: 504,
            body: {
                error: { message: 'Request timeout', type: 'timeout', code: 'timeout' }
            }
        });
    });

    test('renders the documented conversation 503s with their own types', () => {
        expect(toOpenAIError(new ConversationBusyError()).body.error).toEqual({
            message: 'Conversation is busy with another request',
            type: 'conversation_busy',
            code: 'conversation_busy'
        });
        expect(toOpenAIError(new SessionStateUnavailableError()).statusCode).toBe(503);
        expect(toOpenAIError(new SessionStateUnavailableError()).body.error.type).toBe(
            'session_state_unavailable'
        );
    });

    test('renders the documented 429 and 402', () => {
        expect(toOpenAIError(new RateLimitError('slow down')).statusCode).toBe(429);
        expect(toOpenAIError(new GatewayError('no credits', { code: 'insufficient_quota' }))).toEqual({
            statusCode: 402,
            body: {
                error: {
                    message: 'no credits',
                    type: 'insufficient_quota',
                    code: 'insufficient_quota'
                }
            }
        });
    });

    test('hides the message of an unexpected failure', () => {
        const { statusCode, body } = toOpenAIError(new InternalError('connection string leaked'));

        expect(statusCode).toBe(500);
        expect(body.error.message).toBe('Internal server error');
        expect(body.error.type).toBe('server_error');
        expect(body.error.code).toBe('internal_error');
        expect(JSON.stringify(body)).not.toContain('connection string leaked');
    });

    test('hides the message of an arbitrary thrown error', () => {
        const { statusCode, body } = toOpenAIError(new Error('kaboom'));

        expect(statusCode).toBe(500);
        expect(body.error).toEqual({
            message: 'Internal server error',
            type: 'server_error',
            code: 'internal_error'
        });
    });

    test('maps foreign errors that carry an HTTP status', () => {
        const rateLimited = Object.assign(new Error('Too many requests'), { statusCode: 429 });
        expect(toOpenAIError(rateLimited)).toEqual({
            statusCode: 429,
            body: {
                error: {
                    message: 'Too many requests',
                    type: 'rate_limit_exceeded',
                    code: 'rate_limit_exceeded'
                }
            }
        });

        const notFound = Object.assign(new Error('no such session'), { status: 404 });
        expect(toOpenAIError(notFound).body.error.code).toBe('model_not_found');
    });

    test('hides foreign 5xx messages', () => {
        const upstream = Object.assign(new Error('upstream stack trace'), { statusCode: 502 });
        const { statusCode, body } = toOpenAIError(upstream);

        expect(statusCode).toBe(502);
        expect(body.error.message).toBe('Bad gateway');
        expect(body.error.code).toBe('internal_error');
    });

    test('handles non-Error throwables', () => {
        expect(toOpenAIError('just a string').body.error.code).toBe('internal_error');
        expect(toOpenAIError(undefined).statusCode).toBe(500);
    });
});

describe('asGatewayError', () => {
    test('returns taxonomy errors unchanged', () => {
        const error = new TimeoutError();

        expect(asGatewayError(error)).toBe(error);
    });

    test('wraps foreign errors and keeps the cause', () => {
        const cause = Object.assign(new Error('nope'), { statusCode: 401 });
        const wrapped = asGatewayError(cause);

        expect(wrapped).toBeInstanceOf(GatewayError);
        expect(wrapped.code).toBe('invalid_api_key');
        expect(wrapped.statusCode).toBe(401);
        expect(wrapped.cause).toBe(cause);
    });
});

describe('codeForStatus', () => {
    test.each([
        [400, 'invalid_request_error'],
        [401, 'invalid_api_key'],
        [402, 'insufficient_quota'],
        [403, 'permission_denied'],
        [404, 'model_not_found'],
        [429, 'rate_limit_exceeded'],
        [504, 'timeout'],
        [500, 'internal_error'],
        [502, 'internal_error'],
        [418, 'invalid_request_error']
    ])('maps %i to %s', (status, code) => {
        expect(codeForStatus(status)).toBe(code);
    });
});

describe('isTransientUpstreamError', () => {
    test('treats the known transient signatures as retryable', () => {
        for (const message of [
            'Insufficient balance',
            'CreditsError: out of credits',
            'rate limit exceeded',
            '429: {"error":"too many requests"}',
            'worker request limit reached',
            'upstream overloaded',
            'temporarily unavailable',
            'internal server error',
            'bad gateway',
            'service unavailable',
            'stream error'
        ]) {
            expect(isTransientUpstreamError(new Error(message))).toBe(true);
        }
    });

    test('uses a numeric status when the message does not say enough', () => {
        expect(isTransientUpstreamError(Object.assign(new Error('failed'), { statusCode: 500 }))).toBe(true);
        expect(isTransientUpstreamError(Object.assign(new Error('failed'), { statusCode: 429 }))).toBe(true);
        expect(isTransientUpstreamError(Object.assign(new Error('failed'), { data: { status: 503 } }))).toBe(
            true
        );
    });

    test('reads the SDK "<status>: {json}" message shape', () => {
        expect(isTransientUpstreamError(new Error('502: {"error":"bad gateway"}'))).toBe(true);
        expect(isTransientUpstreamError(new Error('400: {"error":"bad request"}'))).toBe(false);
    });

    test('also reads data.message', () => {
        expect(isTransientUpstreamError({ data: { message: 'rate limit exceeded' } })).toBe(true);
    });

    test('does not retry client errors or empty failures', () => {
        expect(isTransientUpstreamError(new Error('400: bad request'))).toBe(false);
        expect(isTransientUpstreamError(new Error('model not found'))).toBe(false);
        expect(isTransientUpstreamError(new Error(''))).toBe(false);
        expect(isTransientUpstreamError(null)).toBe(false);
        expect(isTransientUpstreamError(undefined)).toBe(false);
        expect(isTransientUpstreamError('rate limit')).toBe(false);
    });
});

describe('transformUpstreamError', () => {
    test('hides unexpected internal error details', () => {
        expect(transformUpstreamError(new TypeError('secret details'))).toEqual({
            statusCode: 500,
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        });
    });

    test('maps timeout and file access failures exactly', () => {
        expect(transformUpstreamError(new Error('Request timeout after 1000ms'))).toEqual({
            statusCode: 504,
            error: { message: 'Request timeout', type: 'timeout', code: 'timeout' }
        });

        const fileError = transformUpstreamError(new Error('ENOENT: missing file'));
        expect(fileError.statusCode).toBe(500);
        expect(fileError.error.code).toBe('file_access_error');
    });

    test('maps provider quota, rate-limit and model failures', () => {
        const quota = Object.assign(new Error('insufficient credits'), {
            name: 'CreditsError',
            statusCode: 401,
            code: 'CreditsError'
        });
        expect(transformUpstreamError(quota)).toEqual({
            statusCode: 402,
            error: {
                message: 'insufficient credits',
                type: 'insufficient_quota',
                code: 'insufficient_quota'
            }
        });

        const limited = Object.assign(new Error('too many requests'), {
            name: 'RateLimitError',
            statusCode: 429,
            code: 'RateLimitError'
        });
        expect(transformUpstreamError(limited).statusCode).toBe(429);

        const missing = Object.assign(new Error('model not found'), {
            name: 'NotFoundError',
            statusCode: 404,
            code: 'model_not_found',
            availableModels: ['opencode/example']
        });
        expect(transformUpstreamError(missing)).toEqual({
            statusCode: 404,
            error: {
                message: 'model not found',
                type: 'invalid_request_error',
                code: 'model_not_found',
                available_models: ['opencode/example']
            }
        });
    });

    test('maps upstream server failures to a gateway 502', () => {
        const upstream = Object.assign(new Error('provider unavailable'), {
            name: 'ProviderError',
            statusCode: 503,
            code: 'ProviderError'
        });
        expect(transformUpstreamError(upstream)).toEqual({
            statusCode: 502,
            error: {
                message: 'provider unavailable',
                type: 'server_error',
                code: 'server_error'
            }
        });
    });
});
