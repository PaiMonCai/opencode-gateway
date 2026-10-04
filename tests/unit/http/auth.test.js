import { describe, expect, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
    createAuthMiddleware,
    extractBearerToken,
    hasValidBearerAuth,
    isAuthorized,
    shouldAllowOperationalEndpoint
} from '../../../src/http/auth.js';

/**
 * Build a tiny app that only mounts the auth middleware in front of two routes.
 *
 * @param {{apiKey?: string, bypassPaths?: string[]}} [options] Middleware options.
 * @returns {import('express').Express} Express app.
 */
function buildApp(options = {}) {
    const app = express();
    app.use(createAuthMiddleware(options));
    app.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [] }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    return app;
}

describe('extractBearerToken', () => {
    test.each([
        ['Bearer abc', 'abc'],
        ['bearer abc', 'abc'],
        ['BEARER abc', 'abc'],
        ['Bearer   abc  ', 'abc'],
        ['Basic abc', null],
        ['abc', null],
        ['', null],
        [undefined, null],
        [null, null]
    ])('extractBearerToken(%p) === %p', (value, expected) => {
        expect(extractBearerToken(value)).toBe(expected);
    });

    test('uses the first value of a repeated header', () => {
        expect(extractBearerToken(['Bearer one', 'Bearer two'])).toBe('one');
    });
});

describe('isAuthorized', () => {
    test('an empty key disables authentication', () => {
        expect(isAuthorized(undefined, '')).toBe(true);
        expect(isAuthorized(undefined, '   ')).toBe(true);
    });

    test('accepts only the exact bearer key', () => {
        expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
        expect(isAuthorized('bearer secret', 'secret')).toBe(true);
        expect(isAuthorized('Bearer nope', 'secret')).toBe(false);
        expect(isAuthorized('secret', 'secret')).toBe(false);
        expect(isAuthorized(undefined, 'secret')).toBe(false);
        expect(isAuthorized('Bearer secret-extra', 'secret')).toBe(false);
    });

    test('hasValidBearerAuth reads the request header', () => {
        const req = /** @type {import('express').Request} */ ({
            headers: { authorization: 'Bearer key' }
        });

        expect(hasValidBearerAuth(req, 'key')).toBe(true);
        expect(hasValidBearerAuth(req, 'other')).toBe(false);
    });
});

describe('shouldAllowOperationalEndpoint', () => {
    const req = /** @type {import('express').Request} */ ({
        headers: { authorization: 'Bearer key' }
    });

    test('disabled endpoints are never served', () => {
        expect(shouldAllowOperationalEndpoint(req, { enabled: false, requireAuth: false }, 'key')).toBe(
            false
        );
    });

    test('endpoints without auth are served to anyone', () => {
        expect(
            shouldAllowOperationalEndpoint(
                /** @type {import('express').Request} */ ({ headers: {} }),
                { enabled: true, requireAuth: false },
                'key'
            )
        ).toBe(true);
    });

    test('endpoints requiring auth honour the bearer key', () => {
        expect(shouldAllowOperationalEndpoint(req, { enabled: true, requireAuth: true }, 'key')).toBe(true);
        expect(
            shouldAllowOperationalEndpoint(
                /** @type {import('express').Request} */ ({ headers: {} }),
                { enabled: true, requireAuth: true },
                'key'
            )
        ).toBe(false);
    });
});

describe('createAuthMiddleware over HTTP', () => {
    test('lets every request through when no key is configured', async () => {
        const response = await request(buildApp()).get('/v1/models');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ object: 'list', data: [] });
    });

    test('rejects a missing key with the documented 401 body', async () => {
        const response = await request(buildApp({ apiKey: 'secret' })).get('/v1/models');

        expect(response.status).toBe(401);
        expect(response.body).toEqual({
            error: {
                message: 'Invalid API key',
                type: 'invalid_request_error',
                code: 'invalid_api_key'
            }
        });
        expect(response.headers['www-authenticate']).toContain('Bearer');
    });

    test('rejects a wrong key', async () => {
        const response = await request(buildApp({ apiKey: 'secret' }))
            .get('/v1/models')
            .set('Authorization', 'Bearer wrong');

        expect(response.status).toBe(401);
    });

    test('accepts the configured key', async () => {
        const response = await request(buildApp({ apiKey: 'secret' }))
            .get('/v1/models')
            .set('Authorization', 'Bearer secret');

        expect(response.status).toBe(200);
    });

    test('never authenticates preflight requests', async () => {
        const response = await request(buildApp({ apiKey: 'secret' })).options('/v1/models');

        expect(response.status).toBeLessThan(400);
    });

    test('always lets the bypass paths through', async () => {
        const response = await request(buildApp({ apiKey: 'secret' })).get('/health');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ok' });
    });

    test('honours a custom bypass list', async () => {
        const app = express();
        app.use(createAuthMiddleware({ apiKey: 'secret', bypassPaths: ['/open'] }));
        app.get('/open', (_req, res) => res.json({ open: true }));
        app.get('/closed', (_req, res) => res.json({ open: false }));

        expect((await request(app).get('/open')).status).toBe(200);
        expect((await request(app).get('/closed')).status).toBe(401);
    });
});
