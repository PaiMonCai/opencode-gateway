import { EventEmitter } from 'node:events';

import { describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
    REQUEST_ID_HEADER,
    createRequestContextMiddleware,
    createRequestId,
    getAbortSignal,
    getRequestContext,
    normalizeRequestId
} from '../../../src/http/request-context.js';

/**
 * Minimal request/response doubles: the middleware only uses `headers`, `path`,
 * `setHeader`, `once` and `writableEnded`.
 *
 * @param {{headers?: Record<string, string>, writableEnded?: boolean}} [options] Double options.
 * @returns {{req: any, res: any}} Doubles.
 */
function createDoubles(options = {}) {
    const req = new EventEmitter();
    req.headers = options.headers ?? {};
    req.method = 'GET';
    req.path = '/v1/models';

    const res = new EventEmitter();
    res.writableEnded = options.writableEnded ?? false;
    res.headers = {};
    res.setHeader = (name, value) => {
        res.headers[name] = value;
    };
    return { req, res };
}

describe('createRequestId', () => {
    test('returns a unique id every time', () => {
        const first = createRequestId();
        const second = createRequestId();

        expect(typeof first).toBe('string');
        expect(first).not.toBe(second);
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('normalizeRequestId', () => {
    test('keeps short, boring ids', () => {
        expect(normalizeRequestId('abc-123_ok')).toBe('abc-123_ok');
        expect(normalizeRequestId('  padded  ')).toBe('padded');
        expect(normalizeRequestId(['first', 'second'])).toBe('first');
    });

    test('rejects ids that could poison logs or headers', () => {
        expect(normalizeRequestId(undefined)).toBeNull();
        expect(normalizeRequestId('')).toBeNull();
        expect(normalizeRequestId('   ')).toBeNull();
        expect(normalizeRequestId('has space')).toBeNull();
        expect(normalizeRequestId('new\nline')).toBeNull();
        expect(normalizeRequestId('<script>')).toBeNull();
        expect(normalizeRequestId('x'.repeat(129))).toBeNull();
    });
});

describe('createRequestContextMiddleware', () => {
    test('generates an id and echoes it in the response header', () => {
        const { req, res } = createDoubles();
        const next = jest.fn();

        createRequestContextMiddleware({ idFactory: () => 'generated-id' })(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.id).toBe('generated-id');
        expect(req.requestId).toBe('generated-id');
        expect(res.headers[REQUEST_ID_HEADER]).toBe('generated-id');
        expect(req.context.id).toBe('generated-id');
        expect(req.context.startedAt).toBeLessThanOrEqual(Date.now());
        expect(req.context.abortedBy).toBeNull();
        expect(req.context.signal).toBeInstanceOf(AbortSignal);
        expect(req.abortSignal).toBe(req.context.signal);
    });

    test('uses a valid client id and ignores an invalid one', () => {
        const first = createDoubles({ headers: { [REQUEST_ID_HEADER]: 'client-id' } });
        createRequestContextMiddleware({ idFactory: () => 'generated' })(first.req, first.res, jest.fn());
        expect(first.req.id).toBe('client-id');

        const second = createDoubles({ headers: { [REQUEST_ID_HEADER]: 'bad id with spaces' } });
        createRequestContextMiddleware({ idFactory: () => 'generated' })(second.req, second.res, jest.fn());
        expect(second.req.id).toBe('generated');
    });

    test('aborts the signal when the client disconnects', () => {
        const { req, res } = createDoubles({ writableEnded: false });
        createRequestContextMiddleware({ idFactory: () => 'id' })(req, res, jest.fn());

        expect(req.context.signal.aborted).toBe(false);
        res.emit('close');

        expect(req.context.abortedBy).toBe('client');
        expect(req.context.signal.aborted).toBe(true);
    });

    test('does not abort after a completed response', () => {
        const { req, res } = createDoubles({ writableEnded: true });
        createRequestContextMiddleware({ idFactory: () => 'id' })(req, res, jest.fn());

        res.emit('close');

        expect(req.context.abortedBy).toBeNull();
        expect(req.context.signal.aborted).toBe(false);
    });

    test('scopes the logger per request', () => {
        const child = { scope: 'http', fields: { requestId: 'id' } };
        const logger = { child: jest.fn(() => child) };
        const { req, res } = createDoubles();

        createRequestContextMiddleware({ logger: /** @type {any} */ (logger), idFactory: () => 'id' })(
            req,
            res,
            jest.fn()
        );

        expect(logger.child).toHaveBeenCalledWith('http', { requestId: 'id' });
        expect(req.context.logger).toBe(child);
    });

    test('works without a logger', () => {
        const { req, res } = createDoubles();
        createRequestContextMiddleware()(req, res, jest.fn());

        expect(req.context.logger).toBeNull();
    });
});

describe('getRequestContext / getAbortSignal', () => {
    test('return undefined for a bare request', () => {
        const req = /** @type {import('express').Request} */ ({});

        expect(getRequestContext(req)).toBeUndefined();
        expect(getAbortSignal(req)).toBeUndefined();
    });
});

describe('request context over HTTP', () => {
    test('sets the request id header on a real response', async () => {
        const app = express();
        app.use(createRequestContextMiddleware({ idFactory: () => 'fixed-id' }));
        app.get('/health', (req, res) => res.json({ id: req.id }));

        const response = await request(app).get('/health');

        expect(response.status).toBe(200);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('fixed-id');
        expect(response.body).toEqual({ id: 'fixed-id' });
    });
});
