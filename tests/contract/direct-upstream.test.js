import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

/**
 * Direct upstream mode.
 *
 * With a key configured, models that OpenCode serves over its own
 * OpenAI-compatible endpoints are sent straight there (Go subscription ->
 * `/zen/go/v1`, paid Zen -> `/zen/v1`), while free-tier Zen models stay on the
 * runtime. These tests run a stub upstream so the exact outbound request can be
 * asserted, and drive the runtime through the same mocked SDK the other suites
 * use so "did it go direct?" is observable.
 */
const sdkState = {
    sessions: new Map(),
    createCount: 0,
    prompts: []
};

const resetSdkState = () => {
    sdkState.sessions = new Map();
    sdkState.createCount = 0;
    sdkState.prompts = [];
};

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [
                {
                    id: 'opencode',
                    models: {
                        'kimi-k2.5': { name: 'Kimi k2.5' },
                        'big-pickle': { name: 'Big Pickle' },
                        'big-pickle-free': { name: 'Big Pickle Free' }
                    }
                },
                {
                    id: 'opencode-go',
                    models: { 'kimi-k3': { name: 'Kimi k3' } }
                }
            ]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['web_fetch'] })),
    sessionCreate: jest.fn(async () => {
        sdkState.createCount += 1;
        const id = `session-${sdkState.createCount}`;
        sdkState.sessions.set(id, []);
        return { data: { id } };
    }),
    sessionPrompt: jest.fn(async (args) => {
        const id = args?.path?.id;
        const session = sdkState.sessions.get(id) || [];
        sdkState.sessions.set(id, session);
        sdkState.prompts.push({ sessionId: id, parts: args?.body?.parts || [] });
        const reply = 'runtime reply';
        session.push({
            info: {
                id: `msg-assistant-${id}`,
                role: 'assistant',
                sessionID: id,
                finish: 'stop',
                time: { created: Date.now(), completed: Date.now() }
            },
            parts: [{ type: 'text', text: reply }]
        });
        return { data: { parts: [{ type: 'text', text: reply }] } };
    }),
    sessionMessages: jest.fn(async (args) =>
        (sdkState.sessions.get(args?.path?.id) || []).map((entry) => ({
            info: { ...entry.info },
            parts: [...entry.parts]
        }))
    ),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = {
                statusCode: 200,
                headers: {},
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

const httpServer = http; // the real module, captured before jest replaces 'http'
// Everything that reaches the SDK must be imported dynamically, after
// `jest.unstable_mockModule` has run.
const sdk = await import('@opencode-ai/sdk');
const { createApp } = await import('../../src/app.js');
const { createConversationRegistry } = await import('../../src/conversation/index.js');
const { createLogger } = await import('../../src/logging/index.js');
const { createResponseChainIndex } = await import('../../src/routes/engine.js');
const { createDirectUpstream, createRuntimeUpstream, createUpstreamRouter } =
    await import('../../src/upstreams/index.js');

/**
 * Build an application the way `index.js` does, with the mocked SDK. The
 * pre-rewrite suite called `createApp(config).app`; the rewrite keeps the frozen
 * signature `buildApp({config, logger, registry, router, tools, engine})`.
 *
 * @param {Record<string, any>} config Gateway config.
 * @returns {import('express').Application} Application.
 */
const buildApp = (config) => {
    const logger = createLogger({ level: 'error', json: false, debug: false });
    const runtime = createRuntimeUpstream({ config, logger, sdk });
    const direct = createDirectUpstream({
        config,
        logger,
        fetch: (...args) => globalThis.fetch(...args)
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
    return createApp({ config, logger, registry, router, responseChains, ensureBackend: async () => {} });
};

/** Stub upstream: records every request and answers from a per-test handler. */
const startStubUpstream = async (handler) => {
    const calls = [];
    const server = httpServer.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const record = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: body ? JSON.parse(body) : null
            };
            calls.push(record);
            handler(record, res);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        calls,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
};

const jsonReply = (record, res, payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
        JSON.stringify(
            payload ?? {
                id: 'chatcmpl-upstream',
                object: 'chat.completion',
                created: 1,
                model: record.body.model,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'direct reply' },
                        finish_reason: 'stop'
                    }
                ],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
            }
        )
    );
};

describe('direct upstream mode', () => {
    let upstream;
    let app;

    const makeApp = (overrides = {}) =>
        buildApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 2000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            ZEN_API_KEY: 'upstream-key',
            DIRECT_GO_BASE_URL: `${upstream.baseUrl}/zen/go/v1`,
            DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen/v1`,
            ...overrides
        });

    beforeEach(async () => {
        jest.clearAllMocks();
        resetSdkState();
        upstream = await startStubUpstream((record, res) => {
            if (record.url.endsWith('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        object: 'list',
                        data: [{ id: 'stub-model', name: 'Stub Model', created: 1 }]
                    })
                );
                return;
            }
            jsonReply(record, res);
        });
        app = makeApp();
    });

    afterEach(async () => {
        await upstream.close();
    });

    test('serves a Go model straight from the upstream with the official fingerprint', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('direct reply');
        // The client keeps seeing the model it asked for...
        expect(res.body.model).toEqual('opencode-go/kimi-k3');
        // ...and the runtime was not involved at all.
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();

        expect(upstream.calls).toHaveLength(1);
        const [call] = upstream.calls;
        expect(call.url).toEqual('/zen/go/v1/chat/completions');
        expect(call.headers.authorization).toEqual('Bearer upstream-key');
        expect(call.headers['x-opencode-client']).toEqual('cli');
        expect(call.headers['x-opencode-project']).toEqual('global');
        expect(call.headers['x-opencode-session']).toMatch(/^ses_/);
        expect(call.headers['x-opencode-request']).toMatch(/^msg_/);
        expect(String(call.headers['user-agent'])).toContain('opencode/');
        // The upstream gets the bare model id, the proxy extension is stripped.
        expect(call.body.model).toEqual('kimi-k3');
        expect(call.body.opencode).toBeUndefined();
        expect(call.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    test('passes tools through natively instead of bridging them', async () => {
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'web_fetch',
                    description: 'fetch',
                    parameters: { type: 'object', properties: {} }
                }
            }
        ];
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode-go/kimi-k3',
                messages: [{ role: 'user', content: 'go' }],
                tools,
                tool_choice: 'auto'
            });

        expect(upstream.calls[0].body.tools).toEqual(tools);
        expect(upstream.calls[0].body.tool_choice).toEqual('auto');
    });

    test('keeps one conversation on one upstream session, and separates conversations', async () => {
        const send = (sessionHeader) =>
            request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .set('session-id', sessionHeader)
                .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });

        await send('conversation-a');
        await send('conversation-a');
        await send('conversation-b');

        const ids = upstream.calls.map((call) => call.headers['x-opencode-session']);
        expect(ids[0]).toEqual(ids[1]);
        expect(ids[2]).not.toEqual(ids[0]);
    });

    test('routes free-tier Zen models to the runtime instead', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/big-pickle-free', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(upstream.calls).toHaveLength(0);
    });

    test('falls back to the runtime when the direct upstream rejects the key', async () => {
        await upstream.close();
        upstream = await startStubUpstream((record, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Invalid API key.' } })
            );
        });
        app = makeApp();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(res.body.choices[0].message.content).toEqual('runtime reply');
    });

    test('relays upstream failures verbatim instead of swallowing them', async () => {
        await upstream.close();
        upstream = await startStubUpstream((record, res) => {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_exceeded' } }));
        });
        app = makeApp();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(429);
        expect(res.body.error.message).toEqual('rate limited');
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
    });

    test('relays an upstream SSE stream with the model name restored', async () => {
        await upstream.close();
        upstream = await startStubUpstream((record, res) => {
            if (!record.body?.stream) return jsonReply(record, res);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const chunk = (delta) =>
                `data: ${JSON.stringify({
                    id: 'chatcmpl-upstream',
                    object: 'chat.completion.chunk',
                    model: record.body.model,
                    choices: [{ index: 0, delta, finish_reason: null }]
                })}\n\n`;
            res.write(chunk({ role: 'assistant', content: 'di' }));
            res.write(chunk({ content: 'rect' }));
            res.write('data: [DONE]\n\n');
            res.end();
        });
        app = makeApp();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'stream-conversation')
            .send({
                model: 'opencode-go/kimi-k3',
                messages: [{ role: 'user', content: 'hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"content":"di"');
        expect(res.text).toContain('"content":"rect"');
        expect(res.text).toContain('"model":"opencode-go/kimi-k3"');
        expect(res.text).not.toContain('"model":"kimi-k3"');
        expect(res.text).toContain('data: [DONE]');
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        // The streamed conversation keeps its upstream session for the next turn.
        const firstSession = upstream.calls[0].headers['x-opencode-session'];
        const followUp = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'stream-conversation')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'again' }] });
        expect(followUp.statusCode).toEqual(200);
        expect(upstream.calls[1].headers['x-opencode-session']).toEqual(firstSession);
    });

    test('honours the free-tier and fallback switches', async () => {
        const forcedDirect = makeApp({ DIRECT_FREE_VIA_RUNTIME: false });
        const res = await request(forcedDirect)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/big-pickle-free', messages: [{ role: 'user', content: 'hello' }] });
        expect(res.statusCode).toEqual(200);
        expect(upstream.calls).toHaveLength(1);

        const noFallbackApp = makeApp({ DIRECT_FALLBACK_TO_RUNTIME: false });
        await upstream.close();
        upstream = await startStubUpstream((record, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
        });
        const strictApp = buildApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 2000,
            DISABLE_TOOLS: false,
            ZEN_API_KEY: 'upstream-key',
            DIRECT_FALLBACK_TO_RUNTIME: false,
            DIRECT_GO_BASE_URL: `${upstream.baseUrl}/zen/go/v1`,
            DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen/v1`
        });
        const rejected = await request(strictApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });
        expect(rejected.statusCode).toEqual(401);
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        expect(noFallbackApp).toBeDefined();
    });

    test('stays on the runtime when no upstream key is configured', async () => {
        const keylessApp = makeApp({ ZEN_API_KEY: '' });
        const res = await request(keylessApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/kimi-k3', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        expect(upstream.calls).toHaveLength(0);
        expect(sdkMocks.sessionCreate).toHaveBeenCalled();
    });
});

describe('responses, free-tier learning and the model catalog', () => {
    let upstream;
    let app;

    const makeApp = (overrides = {}) =>
        buildApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 2000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            ZEN_API_KEY: 'upstream-key',
            DIRECT_GO_BASE_URL: `${upstream.baseUrl}/zen/go/v1`,
            DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen/v1`,
            ...overrides
        });

    const responsesReply = (record, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                id: 'resp_upstream',
                object: 'response',
                created_at: 1,
                model: record.body.model,
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'responses answer' }]
                    }
                ]
            })
        );
    };

    beforeEach(async () => {
        jest.clearAllMocks();
        resetSdkState();
        upstream = await startStubUpstream((record, res) => {
            if (record.url.endsWith('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        object: 'list',
                        data: [{ id: 'stub-model', name: 'Stub Model', created: 1 }]
                    })
                );
                return;
            }
            if (record.url.endsWith('/responses')) return responsesReply(record, res);
            jsonReply(record, res);
        });
        app = makeApp();
    });

    afterEach(async () => {
        await upstream.close();
    });

    test('passes /v1/responses straight through and keeps the conversation header', async () => {
        const send = () =>
            request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .set('session-id', 'resp-conversation')
                .send({ model: 'opencode-go/kimi-k3', input: 'hello' });

        const first = await send();
        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toEqual('resp_upstream');
        expect(first.body.model).toEqual('opencode-go/kimi-k3');
        expect(first.body.output[0].content[0].text).toEqual('responses answer');
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();

        expect(upstream.calls).toHaveLength(1);
        expect(upstream.calls[0].url).toEqual('/zen/go/v1/responses');
        expect(upstream.calls[0].body.model).toEqual('kimi-k3');
        expect(upstream.calls[0].body.input).toEqual('hello');
        expect(upstream.calls[0].headers['x-opencode-session']).toMatch(/^ses_/);

        const second = await send();
        expect(second.statusCode).toEqual(200);
        expect(upstream.calls[1].headers['x-opencode-session']).toEqual(
            upstream.calls[0].headers['x-opencode-session']
        );
    });

    test('learns that an unsuffixed free model belongs to the runtime', async () => {
        await upstream.close();
        upstream = await startStubUpstream((record, res) => {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'FreeTierError',
                        message: "OpenCode's free tier can only be used from within OpenCode"
                    }
                })
            );
        });
        app = makeApp();

        // First attempt goes direct, is refused, and is served by the runtime.
        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'hello' }] });
        expect(first.statusCode).toEqual(200);
        expect(first.body.choices[0].message.content).toEqual('runtime reply');
        expect(upstream.calls).toHaveLength(1);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);

        // The refusal is remembered: the same model no longer touches the upstream.
        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'again' }] });
        expect(second.statusCode).toEqual(200);
        expect(upstream.calls).toHaveLength(1);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(2);
    });

    test('resolves a model from the upstream catalog when the runtime is gone', async () => {
        sdkMocks.configProviders.mockRejectedValue(new Error('runtime unavailable'));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode-go/stub-model', messages: [{ role: 'user', content: 'hello' }] });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('direct reply');
        expect(res.body.model).toEqual('opencode-go/stub-model');
        // Served without touching the runtime session machinery at all.
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        expect(upstream.calls.some((call) => call.url === '/zen/go/v1/chat/completions')).toBe(true);
    });

    test('publishes the upstream catalog when the runtime cannot list models', async () => {
        sdkMocks.configProviders.mockRejectedValueOnce(new Error('runtime unavailable'));

        const res = await request(app).get('/v1/models').set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        const ids = res.body.data.map((model) => model.id);
        expect(ids).toContain('opencode-go/stub-model');
        expect(ids).toContain('opencode/stub-model');
        expect(upstream.calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(2);
    });
});
