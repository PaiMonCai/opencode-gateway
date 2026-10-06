import request from 'supertest';
import http from 'http';
import { jest } from '@jest/globals';
import OpencodeGatewayToolLock from '../../plugin/opencode-gateway-tool-lock.js';
import * as pluginModule from '../../plugin/opencode-gateway-tool-lock.js';

const LOCK_SPEC = 'file:///home/node/project/plugin/opencode-gateway-tool-lock.js';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'big-pickle': { name: 'Big Pickle' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [LOCK_SPEC] } })),
    toolIds: jest.fn(async () => ({ data: ['bash', 'read', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'ses_test' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] }
    ]),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() }))
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: {
            providers: sdkMocks.configProviders,
            update: sdkMocks.configUpdate,
            get: sdkMocks.configGet
        },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { buildBackendConfigContent, checkHealth } = await import('../../src/server.js');
const sdkModule = await import('@opencode-ai/sdk');
const appModule = await import('../../src/app.js');
const conversationModule = await import('../../src/conversation/index.js');
const loggingModule = await import('../../src/logging/index.js');
const engineModule = await import('../../src/routes/engine.js');
const upstreamsModule = await import('../../src/upstreams/index.js');

/**
 * Build an application the way `index.js` does, with the mocked SDK.
 *
 * @param {Record<string, any>} config Gateway config.
 * @returns {{app: import('express').Application}} Application wrapper.
 */
const createApp = (config) => {
    const logger = loggingModule.createLogger({ level: 'error', json: false, debug: false });
    const runtime = upstreamsModule.createRuntimeUpstream({ config, logger, sdk: sdkModule });
    const direct = upstreamsModule.createDirectUpstream({
        config,
        logger,
        fetch: async () => {
            throw new Error('direct upstream is not used in this suite');
        }
    });
    const responseChains = engineModule.createResponseChainIndex({ logger });
    const registry = conversationModule.createConversationRegistry({
        config,
        logger,
        sessionBackend: runtime,
        deleteSession: (sessionId) => runtime.deleteSession(sessionId),
        isSessionHeld: (sessionId) => responseChains.isHeld(sessionId)
    });
    const router = upstreamsModule.createUpstreamRouter({ config, logger, direct, runtime, registry });
    const app = appModule.createApp({
        config,
        logger,
        registry,
        router,
        responseChains,
        ensureBackend: async () => {}
    });
    return { app };
};

// Stands in for the OpenCode backend's health endpoint; the API itself is mocked.
const backend = http.createServer((req, res) => {
    res.writeHead(req.url === '/global/health' ? 200 : 404);
    res.end(req.url === '/global/health' ? '{"healthy":true}' : '');
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
afterAll(() => backend.close());

const baseConfig = {
    PORT: 10000,
    API_KEY: 'k',
    OPENCODE_SERVER_URL: `http://127.0.0.1:${backend.address().port}`,
    REQUEST_TIMEOUT_MS: 5000,
    MANAGE_BACKEND: false,
    DEBUG: false
};

const chat = (app, body) =>
    request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer k')
        .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'hi' }], ...body });

describe('tool policy with the tool-lock plugin loaded', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.configGet.mockResolvedValue({ data: { plugin: [LOCK_SPEC] } });
    });

    test('keeps the official tool list and carries the deny-all policy in the session title', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        const res = await chat(app);

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
            body: { title: 'opencode-gateway [tools:none]' }
        });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('puts the internal allowlist into the policy instead of a tools map', async () => {
        const { app } = createApp({
            ...baseConfig,
            DISABLE_TOOLS: true,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'read']
        });
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
            body: { title: 'opencode-gateway [tools:webfetch,read]' }
        });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
    });

    test('external tool bridging still denies every internal tool', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true, INTERNAL_ALLOWED_TOOLS: ['read'] });
        await chat(app, {
            tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
        });

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
            body: { title: 'opencode-gateway [tools:none]' }
        });
    });

    test('DISABLE_TOOLS=false allows every tool', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: false });
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
            body: { title: 'opencode-gateway [tools:*]' }
        });
    });

    test('Responses API sessions get the same policy', async () => {
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer k')
            .send({ model: 'opencode/big-pickle', input: 'hi' });

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith({
            body: { title: 'opencode-gateway [tools:none]' }
        });
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toBeUndefined();
    });
});

describe('tool policy without the plugin', () => {
    test('falls back to the per-request tools map', async () => {
        jest.clearAllMocks();
        sdkMocks.configGet.mockResolvedValue({ data: { plugin: [] } });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { app } = createApp({ ...baseConfig, DISABLE_TOOLS: true });
        await chat(app);
        await chat(app);

        expect(sdkMocks.sessionCreate).toHaveBeenCalledWith(undefined);
        expect(sdkMocks.sessionPrompt.mock.calls.at(-1)[0].body.tools).toEqual({
            bash: false,
            read: false,
            webfetch: false
        });
        expect(
            warn.mock.calls.filter(([msg]) => String(msg).includes('opencode-gateway-tool-lock.js'))
        ).toHaveLength(1);
        warn.mockRestore();
    });
});

describe('tool-lock plugin', () => {
    const sessions = {
        ses_none: { title: 'opencode-gateway [tools:none]' },
        ses_all: { title: 'opencode-gateway [tools:*]' },
        ses_fetch: { title: 'opencode-gateway [tools:webfetch,read]' },
        ses_child: { title: 'Subtask (@general)', parentID: 'ses_fetch' },
        ses_plain: { title: 'New session' }
    };
    const client = {
        session: {
            get: jest.fn(async ({ path }) => {
                if (path.id === 'ses_broken') throw new Error('backend down');
                return { data: sessions[path.id] };
            })
        }
    };
    let hooks;
    const run = (sessionID, tool) =>
        hooks['tool.execute.before']({ tool, sessionID, callID: 'c' }, { args: {} });

    beforeAll(async () => {
        hooks = await OpencodeGatewayToolLock({ client });
    });

    test('denies every tool for a deny-all session', async () => {
        await expect(run('ses_none', 'bash')).rejects.toThrow('Tool "bash" is disabled by opencode-gateway');
    });

    test('allows only listed tools', async () => {
        await expect(run('ses_fetch', 'webfetch')).resolves.toBeUndefined();
        await expect(run('ses_fetch', 'read')).resolves.toBeUndefined();
        await expect(run('ses_fetch', 'bash')).rejects.toThrow('disabled');
    });

    test('allows everything for a wildcard session', async () => {
        await expect(run('ses_all', 'bash')).resolves.toBeUndefined();
    });

    test('child sessions inherit the parent policy', async () => {
        await expect(run('ses_child', 'read')).resolves.toBeUndefined();
        await expect(run('ses_child', 'write')).rejects.toThrow('disabled');
    });

    test('points native calls to external tools back to the text contract', async () => {
        const hook = hooks['tool.execute.before'];
        await expect(
            hook(
                { tool: 'invalid', sessionID: 'ses_none', callID: 'c' },
                { args: { tool: 'external__get_weather', error: 'unavailable' } }
            )
        ).rejects.toThrow('<function_calls>{"name":"external__get_weather"');
    });

    test('fails closed without a policy or when the lookup fails', async () => {
        await expect(run('ses_plain', 'read')).rejects.toThrow('disabled');
        await expect(run('ses_missing', 'read')).rejects.toThrow('disabled');
        await expect(run('ses_broken', 'read')).rejects.toThrow('disabled');
    });
});

describe('backend wiring', () => {
    test('adds the tool-lock plugin to existing OPENCODE_CONFIG_CONTENT', () => {
        const config = JSON.parse(buildBackendConfigContent('{"plugin":["/x.js"],"theme":"system"}'));
        expect(config.theme).toEqual('system');
        expect(config.plugin[0]).toEqual('/x.js');
        expect(config.plugin[1]).toMatch(/plugin[\\/]opencode-gateway-tool-lock\.js$/);
        expect(JSON.parse(buildBackendConfigContent('')).plugin).toHaveLength(1);
    });

    test('health check uses /global/health and requires healthy=true', async () => {
        const routes = {
            '/global/health': [200, '{"healthy":true,"version":"1"}'],
            '/health': [200, '<!doctype html>']
        };
        let healthy = true;
        const server = http.createServer((req, res) => {
            const [status, body] = routes[req.url] || [404, ''];
            res.writeHead(status);
            res.end(req.url === '/global/health' && !healthy ? '{"healthy":false}' : body);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
            await expect(checkHealth(url)).resolves.toBe(true);
            healthy = false;
            await expect(checkHealth(url)).rejects.toThrow('unhealthy');
        } finally {
            server.close();
        }
    });
});

describe('runtime loader contract', () => {
    test('the plugin file exports nothing but its factory', async () => {
        // opencode 1.18 registers every function export of a plugin file as a
        // plugin of its own; the bogus entries it creates make Plugin.trigger
        // throw on every turn (TypeError: null is not an object), so a helper
        // that leaks into this module breaks the whole runtime path.
        expect(Object.keys(pluginModule)).toEqual(['default']);
        expect(typeof pluginModule.default).toBe('function');
    });

    test('the factory returns every hook the runtime calls unconditionally', async () => {
        const plugin = await OpencodeGatewayToolLock({
            client: { session: { get: async () => ({ data: { title: 'opencode-gateway [tools:*]' } }) } }
        });
        for (const hook of [
            'tool.execute.before',
            'tool.execute.after',
            'config',
            'event',
            'dispose',
            'chat.message',
            'chat.params'
        ]) {
            expect(typeof plugin[hook]).toBe('function');
        }
    });
});
