import request from 'supertest';
import { jest } from '@jest/globals';

/**
 * The contract reminder is appended as the last part of a turn.
 *
 * `src/tools/router.js` documents the reminder as the reason an obvious
 * single-tool request went from 4/8 to 8/8 parseable calls: it sits immediately
 * before generation instead of inside the 16KB+ system prompt. The rewrite once
 * dropped it (the producer never exposed the key the call sites read), so this
 * suite pins the wiring rather than just the helper that builds the text.
 */
const prompts = [];

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi k2.5' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['web_fetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'test-session-id' } })),
    sessionPrompt: jest.fn(async (args) => {
        prompts.push(args);
        return { data: { parts: [{ type: 'text', text: 'Mock response' }] } };
    }),
    sessionMessages: jest.fn(async () => [
        {
            info: { role: 'assistant', finish: 'stop', time: { created: 1, completed: 2 } },
            parts: [{ type: 'text', text: 'Mock response' }]
        }
    ]),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            // Non-streaming requests poll instead of collecting events.
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = {
                statusCode: 200,
                headers: { 'content-type': 'image/png' },
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(Buffer.from(''));
                    if (event === 'end') handler();
                })
            };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                resume: jest.fn(),
                setEncoding: jest.fn(),
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler('{"healthy":true}');
                    if (event === 'end') handler();
                })
            };
            callback(response);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

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

const { createApp } = await import('../../src/app.js');
const { createLogger } = await import('../../src/logging/index.js');
const { createConversationRegistry } = await import('../../src/conversation/index.js');
const { createDirectUpstream, createRuntimeUpstream, createUpstreamRouter } =
    await import('../../src/upstreams/index.js');
const { createResponseChainIndex } = await import('../../src/routes/engine.js');
const { buildToolExposure } = await import('../../src/tools/router.js');
const { buildExternalToolRegistry } = await import('../../src/tools/registry.js');
const sdk = await import('@opencode-ai/sdk');

const CONFIG = {
    PORT: 10000,
    API_KEY: 'test-key',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 5000,
    DISABLE_TOOLS: false,
    DEBUG: false
};

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a URL',
            parameters: { type: 'object', properties: { url: { type: 'string' } } }
        }
    }
];

const buildApp = () => {
    const config = /** @type {any} */ (CONFIG);
    const logger = createLogger({ level: 'error', json: false, debug: false });
    const runtime = createRuntimeUpstream({ config, logger, sdk });
    const direct = createDirectUpstream({
        config,
        logger,
        fetch: async () => {
            throw new Error('direct upstream is not used in this suite');
        }
    });
    const responseChains = createResponseChainIndex({ logger });
    const registry = createConversationRegistry({
        config,
        logger,
        sessionBackend: runtime,
        deleteSession: (sessionId) => runtime.deleteSession(sessionId),
        isSessionHeld: (sessionId) => responseChains.isHeld(sessionId)
    });
    const router = createUpstreamRouter({ config, logger, direct, runtime, registry });
    return createApp({
        config,
        logger,
        registry,
        router,
        responseChains,
        ensureBackend: async () => {}
    });
};

const lastParts = () => {
    const prompt = prompts[prompts.length - 1];
    return prompt?.body?.parts || [];
};

describe('tool contract reminder placement', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prompts.length = 0;
    });

    test('appends the reminder as the last part when the request declares tools', async () => {
        const app = buildApp();
        const expected = buildToolExposure(buildExternalToolRegistry(TOOLS), 'auto').reminder;
        expect(typeof expected).toBe('string');
        expect(expected.length).toBeGreaterThan(0);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'hello' }],
                tools: TOOLS
            });

        expect(res.statusCode).toEqual(200);
        const parts = lastParts();
        expect(parts.length).toBeGreaterThan(0);
        expect(parts[parts.length - 1]).toEqual({ type: 'text', text: expected });
    });

    test('does not append a reminder when the request declares no tools', async () => {
        const app = buildApp();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        const parts = lastParts();
        const reminder = buildToolExposure(buildExternalToolRegistry(TOOLS), 'auto').reminder;
        expect(parts.some((part) => part.text === reminder)).toBe(false);
    });
});
