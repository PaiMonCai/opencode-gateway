import { describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { InternalError, InvalidRequestError } from '../../../src/errors/index.js';
import {
    DEFAULT_JSON_BODY_LIMIT,
    createBodyParsers,
    createCorsMiddleware,
    createErrorHandler,
    createNotFoundHandler
} from '../../../src/http/middleware.js';
import { createRequestContextMiddleware, REQUEST_ID_HEADER } from '../../../src/http/request-context.js';
import { installHttpLayer } from '../../../src/http/index.js';

/**
 * Build an app with the body parsers and the terminal error handler installed.
 *
 * @param {{limit?: string}} [options] Parser options.
 * @returns {import('express').Express} Express app.
 */
function buildApp(options = {}) {
    const app = express();
    const [jsonBody, urlencodedBody] = createBodyParsers(options);
    app.use(jsonBody);
    app.use(urlencodedBody);
    app.post('/echo', (req, res) => res.json({ body: req.body }));
    app.use(createErrorHandler());
    return app;
}

describe('createCorsMiddleware', () => {
    test('answers preflights with the conversation headers allowed', async () => {
        const app = express();
        app.use(createCorsMiddleware({ headerNames: ['session-id', 'x-opencode-session'] }));
        app.get('/v1/models', (_req, res) => res.json({ object: 'list' }));

        const response = await request(app)
            .options('/v1/models')
            .set('Origin', 'http://client.test')
            .set('Access-Control-Request-Method', 'GET')
            .set('Access-Control-Request-Headers', 'authorization, content-type, session-id');

        expect(response.status).toBeLessThan(400);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        const allowedHeaders = response.headers['access-control-allow-headers'];
        expect(allowedHeaders).toContain('Authorization');
        expect(allowedHeaders).toContain('session-id');
        expect(allowedHeaders).toContain('x-opencode-session');
    });

    test('sets the allow-origin header on plain responses', async () => {
        const app = express();
        app.use(createCorsMiddleware());
        app.get('/health', (_req, res) => res.json({ status: 'ok' }));

        const response = await request(app).get('/health').set('Origin', 'http://client.test');

        expect(response.headers['access-control-allow-origin']).toBe('*');
    });
});

describe('createBodyParsers', () => {
    test('parses JSON and urlencoded bodies', async () => {
        const app = buildApp();

        const json = await request(app).post('/echo').send({ model: 'opencode/x' });
        expect(json.status).toBe(200);
        expect(json.body).toEqual({ body: { model: 'opencode/x' } });

        const form = await request(app)
            .post('/echo')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('model=opencode%2Fx');
        expect(form.body).toEqual({ body: { model: 'opencode/x' } });
    });

    test('rejects malformed JSON with a documented 400', async () => {
        const response = await request(buildApp())
            .post('/echo')
            .set('Content-Type', 'application/json')
            .send('{ not json');

        expect(response.status).toBe(400);
        expect(response.body.error).toEqual({
            message: 'Invalid JSON in request body',
            type: 'invalid_request_error',
            code: 'invalid_request_error'
        });
    });

    test('rejects an oversized body with a documented 400', async () => {
        const response = await request(buildApp({ limit: '200b' }))
            .post('/echo')
            .send({ payload: 'x'.repeat(1000) });

        expect(response.status).toBe(400);
        expect(response.body.error.message).toBe('Request body too large');
    });

    test('defaults to the pre-rewrite body limit', () => {
        expect(DEFAULT_JSON_BODY_LIMIT).toBe('50mb');
    });
});

describe('createErrorHandler', () => {
    test('renders a taxonomy error with its documented body', async () => {
        const app = express();
        app.get('/boom', () => {
            throw new InvalidRequestError('model is required');
        });
        app.use(createErrorHandler());

        const response = await request(app).get('/boom');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: {
                message: 'model is required',
                type: 'invalid_request_error',
                code: 'invalid_request_error'
            }
        });
    });

    test('hides unexpected failures', async () => {
        const app = express();
        app.get('/boom', () => {
            throw new Error('database credentials in message');
        });
        app.use(createErrorHandler());

        const response = await request(app).get('/boom');

        expect(response.status).toBe(500);
        expect(response.body.error).toEqual({
            message: 'Internal server error',
            type: 'server_error',
            code: 'internal_error'
        });
    });

    test('logs the failure with the request id', async () => {
        const error = jest.fn();
        const logger = { error };
        const app = express();
        app.use(createRequestContextMiddleware({ idFactory: () => 'req-1' }));
        app.get('/boom', () => {
            throw new InternalError('nope');
        });
        app.use(createErrorHandler({ logger: /** @type {any} */ (logger) }));

        await request(app).get('/boom');

        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][0]).toBe('request failed');
        expect(error.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', statusCode: 500 });
    });

    test('defers to Express when the response already started', () => {
        const error = new Error('too late');
        const next = jest.fn();
        const handler = createErrorHandler();

        handler(error, /** @type {any} */ ({}), /** @type {any} */ ({ headersSent: true }), next);

        expect(next).toHaveBeenCalledWith(error);
    });
});

describe('createNotFoundHandler', () => {
    test('answers unknown routes with an OpenAI-shaped 404', async () => {
        const app = express();
        app.use(createNotFoundHandler());

        const response = await request(app).get('/v1/unknown');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            error: {
                message: 'Route not found: GET /v1/unknown',
                type: 'not_found_error'
            }
        });
    });

    test('names the method and path so an operator can diagnose the miss', async () => {
        const app = express();
        app.use(createNotFoundHandler());

        const response = await request(app).post('/v1/chat/completions');

        expect(response.status).toBe(404);
        expect(response.body.error.message).toBe('Route not found: POST /v1/chat/completions');
        expect(response.body.error.code).toBeUndefined();
    });
});

describe('installHttpLayer', () => {
    test('installs cors, context, parsers and auth in order', async () => {
        const app = express();
        const layer = installHttpLayer(app, {
            config: /** @type {any} */ ({
                API_KEY: 'secret',
                SESSION_HEADER_NAMES: ['session-id']
            })
        });
        app.get('/health', (_req, res) => res.json({ status: 'ok' }));
        app.post('/v1/echo', (req, res) => res.json({ body: req.body, id: req.id }));
        app.use(layer.errorHandler);
        app.use(layer.notFoundHandler);

        const health = await request(app).get('/health');
        expect(health.status).toBe(200);
        expect(health.headers['access-control-allow-origin']).toBe('*');
        expect(health.headers[REQUEST_ID_HEADER]).toBeTruthy();

        const unauthorized = await request(app).post('/v1/echo').send({});
        expect(unauthorized.status).toBe(401);

        const authorized = await request(app)
            .post('/v1/echo')
            .set('Authorization', 'Bearer secret')
            .set('Origin', 'http://client.test')
            .send({ model: 'opencode/x' });
        expect(authorized.status).toBe(200);
        expect(authorized.body.body).toEqual({ model: 'opencode/x' });
        expect(authorized.body.id).toBeTruthy();

        const missing = await request(app).get('/v1/nope').set('Authorization', 'Bearer secret');
        expect(missing.status).toBe(404);
    });

    test('works without a config (open proxy, default headers)', async () => {
        const app = express();
        const layer = installHttpLayer(app);
        app.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [] }));
        app.use(layer.errorHandler);

        const response = await request(app).get('/v1/models');

        expect(response.status).toBe(200);
    });
});
