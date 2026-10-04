/**
 * BEHAVIOUR-SPEC §1 (endpoints, auth, CORS, body errors, 404 shape) and §7
 * (operational surfaces), verified through the real assembled app.
 *
 * These cases are independent of `tests/contract/**`: they assert the published
 * contract from `docs/en/api-reference.md` and `docs/BEHAVIOUR-SPEC.md`, and
 * build their own fakes.
 */

import { DEFAULT_JSON_BODY_LIMIT } from '../../../src/http/middleware.js';
import { createAssembly } from './harness.js';

/** @type {Array<{close: () => Promise<void>}>} */
const open = [];

afterEach(async () => {
    while (open.length) await open.pop().close();
});

const assembly = async (options) => {
    const instance = await createAssembly(options);
    open.push(instance);
    return instance;
};

describe('§1 endpoints', () => {
    test('GET /health is always 200 with the documented body and needs no auth', async () => {
        const { http } = await assembly({ env: { API_KEY: 'secret' } });
        const res = await http.get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    test('an unknown route answers the informative 404 shape', async () => {
        const { http } = await assembly();
        const res = await http.get('/nope');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: { message: 'Route not found: GET /nope', type: 'not_found_error' }
        });
        expect(res.body.error).not.toHaveProperty('code');

        const post = await http.post('/v1/unknown');
        expect(post.status).toBe(404);
        expect(post.body.error.message).toBe('Route not found: POST /v1/unknown');
    });

    test('auth: missing or wrong bearer key answers the documented 401', async () => {
        const { http } = await assembly({ env: { API_KEY: 'secret' } });

        const missing = await http.get('/v1/models');
        expect(missing.status).toBe(401);
        expect(missing.body).toEqual({
            error: {
                message: 'Invalid API key',
                type: 'invalid_request_error',
                code: 'invalid_api_key'
            }
        });

        const wrong = await http.get('/v1/models').set('Authorization', 'Bearer nope');
        expect(wrong.status).toBe(401);
        expect(wrong.body.error.code).toBe('invalid_api_key');

        const wrongScheme = await http.get('/v1/models').set('Authorization', 'Basic secret');
        expect(wrongScheme.status).toBe(401);

        const ok = await http.get('/v1/models').set('Authorization', 'Bearer secret');
        expect(ok.status).toBe(200);
    });

    test('auth is off when API_KEY is unset', async () => {
        const { http } = await assembly();
        const res = await http.get('/v1/models');
        expect(res.status).toBe(200);
    });

    test('malformed JSON answers 400 Invalid JSON in request body', async () => {
        const { http } = await assembly();
        const res = await http
            .post('/v1/chat/completions')
            .set('Content-Type', 'application/json')
            .send('{"model": "opencode/big-pickle", "messages": [');
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('Invalid JSON in request body');
    });

    test('the JSON body limit is the documented 50 MB', async () => {
        expect(DEFAULT_JSON_BODY_LIMIT).toBe('50mb');
        const { http } = await assembly();
        // A payload over the limit is rejected before it reaches a route.
        const res = await http
            .post('/v1/chat/completions')
            .set('Content-Type', 'application/json')
            .send(`{"model":"m","messages":[{"role":"user","content":"${'x'.repeat(51 * 1024 * 1024)}"}]}`);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('Request body too large');
    }, 60_000);

    test('CORS allows the configured conversation headers and the documented methods', async () => {
        const { http } = await assembly();
        const res = await http
            .options('/v1/chat/completions')
            .set('Origin', 'http://example.test')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type,authorization,x-opencode-session');

        expect([200, 204]).toContain(res.status);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        const allowHeaders = String(res.headers['access-control-allow-headers'] || '').toLowerCase();
        expect(allowHeaders).toContain('authorization');
        expect(allowHeaders).toContain('x-opencode-session');
    });

    test('GET /v1/models lists the runtime catalog in the documented shape', async () => {
        const { http } = await assembly();
        const res = await http.get('/v1/models');
        expect(res.status).toBe(200);
        expect(res.body.object).toBe('list');
        expect(Array.isArray(res.body.data)).toBe(true);
        const first = res.body.data[0];
        expect(first).toMatchObject({
            id: expect.any(String),
            object: 'model',
            created: expect.any(Number),
            owned_by: expect.any(String)
        });
        expect(res.body.data.map((model) => model.id)).toContain('opencode/kimi-k2.5');
        expect(res.body.data.map((model) => model.id)).toContain('opencode-go/glm-5');
    });
});

describe('§7 operational surfaces', () => {
    test('/health/details is 404 Not found while disabled', async () => {
        // OPS=off is the way to switch the details endpoint off (the per-endpoint
        // switches are removed settings).
        const { http } = await assembly({ env: { OPENCODE_PROXY_OPS: 'off' } });
        const res = await http.get('/health/details');
        expect(res.status).toBe(404);
        expect(res.text).toBe('Not found');
    });

    test('/health/details answers plain-text 401 when auth is required and missing', async () => {
        const { http } = await assembly({
            env: {
                OPENCODE_PROXY_OPS: 'health',
                API_KEY: 'secret'
            }
        });
        const res = await http.get('/health/details');
        expect(res.status).toBe(401);
        expect(res.text).toBe('Unauthorized');
        expect(res.headers['content-type']).not.toMatch(/application\/json/);

        const authorized = await http.get('/health/details').set('Authorization', 'Bearer secret');
        expect(authorized.status).toBe(200);
    });

    test('/health/details exposes the documented diagnostics keys', async () => {
        const { http } = await assembly({
            env: {
                OPENCODE_PROXY_OPS: 'health',
                API_KEY: 'k'
            }
        });
        const res = await http.get('/health/details').set('Authorization', 'Bearer k');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.proxy).toBe(true);
        expect(res.body.internal_tools.config).toEqual({
            allowed_tools: expect.anything(),
            metrics_enabled: expect.any(Boolean),
            discovery_fixture: expect.anything()
        });
        expect(res.body.internal_tools.cache).toEqual({
            tool_ids_cached: expect.any(Boolean),
            tool_id_count: expect.any(Number),
            age_ms: null
        });
        expect(res.body.internal_tools.audit).toEqual({
            available: true,
            fields: expect.any(Array)
        });
        // BEHAVIOUR-SPEC §7 documents the counters in the payload; they are
        // present while internal tool metrics are enabled (the default).
        expect(res.body.internal_tools.metrics).toEqual({
            externalBridgeRequests: expect.any(Number),
            internalAllowlistRequests: expect.any(Number),
            disabledRequests: expect.any(Number),
            discoveryFailures: expect.any(Number),
            fallbackToDisabled: expect.any(Number)
        });
    });

    test('/health/details always reports the internal tool counters', async () => {
        // Internal tool metrics are always collected now: the switch that used
        // to null them out was a removed setting (they are cheap counters, and
        // `/metrics` is the endpoint that decides whether they are exported).
        const { http } = await assembly({
            env: {
                OPENCODE_PROXY_OPS: 'health',
                API_KEY: 'k'
            }
        });
        const res = await http.get('/health/details').set('Authorization', 'Bearer k');
        expect(res.status).toBe(200);
        expect(res.body.internal_tools.metrics).toEqual(
            expect.objectContaining({
                internalAllowlistRequests: expect.any(Number),
                externalBridgeRequests: expect.any(Number)
            })
        );
    });

    test('/metrics is 404 while disabled and 401 without auth when enabled', async () => {
        const disabled = await assembly({ env: { OPENCODE_PROXY_OPS: 'health' } });
        const disabledRes = await disabled.http.get('/metrics');
        expect(disabledRes.status).toBe(404);
        expect(disabledRes.text).toBe('Not found');

        const guarded = await assembly({
            env: { OPENCODE_PROXY_OPS: 'full', API_KEY: 'k' }
        });
        const guardedRes = await guarded.http.get('/metrics');
        expect(guardedRes.status).toBe(401);
        expect(guardedRes.text).toBe('Unauthorized');
    });

    test('/metrics publishes the documented Prometheus metric names', async () => {
        const { http } = await assembly({
            env: { OPENCODE_PROXY_OPS: 'full', API_KEY: 'k' }
        });
        const res = await http.get('/metrics').set('Authorization', 'Bearer k');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        for (const metric of [
            'opencode_internal_tool_mode_requests_total{mode="external_bridge"}',
            'opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}',
            'opencode_internal_tool_mode_requests_total{mode="disabled"}',
            'opencode_internal_tool_discovery_failures_total',
            'opencode_internal_tool_fallback_disabled_total',
            'opencode_internal_tool_cache_ids'
        ]) {
            expect(res.text).toContain(metric);
        }
    });

    test('/health stays 200 while the runtime is broken, and /v1/models still answers', async () => {
        const { http, fake } = await assembly({
            runtime: {
                models: {},
                promptError: () => new Error('runtime down')
            }
        });
        fake.client.config.providers = async () => {
            throw new Error('providers unavailable');
        };

        expect((await http.get('/health')).status).toBe(200);
        const models = await http.get('/v1/models');
        expect([200]).toContain(models.status); // upstream catalog fallback or the fallback model
        expect(Array.isArray(models.body.data)).toBe(true);
    });
});
