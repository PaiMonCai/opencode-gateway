import request from 'supertest';
import { jest } from '@jest/globals';

/**
 * Boot contract: the assembly in `src/bootstrap.js` must produce a working
 * application with nothing but configuration and an SDK implementation.
 *
 * Route tests inject their own SDK, so this is where a missing SDK at assembly
 * time is caught — it otherwise only shows up as a startup failure.
 */

const fakeSdk = {
    config: {
        providers: jest.fn(async () => ({ data: { providers: [] } })),
        update: jest.fn(async () => ({})),
        get: jest.fn(async () => ({ data: { plugin: [] } }))
    },
    tool: { ids: jest.fn(async () => ({ data: [] })) },
    session: {
        create: jest.fn(async () => ({ data: { id: 'boot-session' } })),
        prompt: jest.fn(async () => ({ data: { parts: [] } })),
        messages: jest.fn(async () => []),
        delete: jest.fn(async () => ({}))
    },
    event: { subscribe: jest.fn(async () => ({ stream: (async function* () {})() })) }
};

const sdkModule = { createOpencodeClient: jest.fn(() => fakeSdk) };
jest.unstable_mockModule('@opencode-ai/sdk', () => sdkModule);

const { buildRuntime } = await import('../../src/bootstrap.js');
const { createLogger } = await import('../../src/logging/index.js');

const logger = createLogger({ level: 'error', json: false, debug: false });

const baseConfig = (overrides = {}) => ({
    PORT: 10000,
    BIND_HOST: '127.0.0.1',
    API_KEY: 'test-key',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:19999',
    REQUEST_TIMEOUT_MS: 2000,
    DISABLE_TOOLS: true,
    DEBUG: false,
    ...overrides
});

test('buildRuntime assembles a servable app from config + SDK alone', async () => {
    const runtime = buildRuntime({ config: baseConfig(), logger, sdk: sdkModule });
    expect(runtime.app).toBeDefined();
    expect(runtime.registry).toBeDefined();
    expect(runtime.router).toBeDefined();
    expect(runtime.engine).toBeDefined();

    const health = await request(runtime.app).get('/health');
    expect(health.statusCode).toBe(200);
    expect(health.body).toEqual({ status: 'ok', proxy: true });
});

test('the assembled app authenticates the /v1 surface and lists models without a runtime', async () => {
    const runtime = buildRuntime({ config: baseConfig(), logger, sdk: sdkModule });

    const unauthorized = await request(runtime.app).get('/v1/models');
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.body.error.code).toBe('invalid_api_key');

    const models = await request(runtime.app).get('/v1/models').set('Authorization', 'Bearer test-key');
    expect(models.statusCode).toBe(200);
    expect(models.body.object).toBe('list');
    expect(Array.isArray(models.body.data)).toBe(true);
    expect(models.body.data.length).toBeGreaterThan(0);
});

test('buildRuntime throws a readable error when the SDK is missing', () => {
    expect(() => buildRuntime({ config: baseConfig(), logger, sdk: null })).toThrow(/SDK/i);
});
