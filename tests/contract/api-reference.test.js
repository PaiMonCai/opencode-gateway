import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

/**
 * Contract tests for `docs/zh/api-reference.md` and `docs/BEHAVIOUR-SPEC.md`.
 *
 * The checks cover the endpoint set, auth, error bodies and codes, SSE framing
 * and terminal events, usage keys, the upstream selection matrix and the
 * 503/504 semantics. No test binds a fixed port, reaches the network, or needs
 * a real OpenCode runtime.
 */

/** State the fake SDK reads from, driven per test. */
const state = {
    sessionCounter: 0,
    currentSessionId: null,
    promptHangs: false,
    releasePromptHang: null,
    messagesError: null,
    messages: [],
    reply: { content: 'Hello from the runtime', reasoning: '' },
    onCreateSession: null
};

const resetState = () => {
    state.sessionCounter = 0;
    state.currentSessionId = null;
    state.promptHangs = false;
    state.releasePromptHang = null;
    state.messagesError = null;
    state.messages = [];
    state.reply = { content: 'Hello from the runtime', reasoning: '' };
    state.onCreateSession = null;
};

/** Fake SDK client: enough surface for runtime turns. */
const fakeSdk = {
    config: {
        providers: jest.fn(async () => ({
            data: {
                providers: [
                    {
                        id: 'opencode',
                        models: {
                            'kimi-k2.5': { name: 'Kimi k2.5' },
                            'kimi-k2.5-free': { name: 'Kimi k2.5 free' },
                            'paid-model': { name: 'Paid model' }
                        }
                    },
                    {
                        id: 'opencode-go',
                        models: { 'some-model': { name: 'Go model' }, limited: { name: 'Limited' } }
                    }
                ]
            }
        })),
        update: jest.fn(async () => ({})),
        get: jest.fn(async () => ({ data: { plugin: [] } }))
    },
    tool: { ids: jest.fn(async () => ({ data: ['web_fetch'] })) },
    session: {
        create: jest.fn(async () => {
            state.sessionCounter += 1;
            const id = `session-${state.sessionCounter}`;
            state.currentSessionId = id;
            state.messages = [];
            state.onCreateSession?.(id);
            return { data: { id } };
        }),
        prompt: jest.fn(async () => {
            // A held turn parks here until the test releases it, so the response
            // it belongs to can still finish and free the server it runs on.
            if (state.promptHangs) {
                await new Promise((resolve) => {
                    state.releasePromptHang = resolve;
                });
            }
            state.messages = [
                {
                    info: { id: `msg-${state.sessionCounter}`, role: 'assistant', finish: 'stop' },
                    parts: [
                        {
                            id: `part-r-${state.sessionCounter}`,
                            type: 'reasoning',
                            text: state.reply.reasoning
                        },
                        { id: `part-t-${state.sessionCounter}`, type: 'text', text: state.reply.content }
                    ]
                }
            ];
            return { data: { parts: [] } };
        }),
        messages: jest.fn(async () => {
            if (state.messagesError) throw state.messagesError;
            return state.messages;
        }),
        delete: jest.fn(async () => ({}))
    },
    event: {
        subscribe: jest.fn(async () => ({
            stream: (async function* () {
                const sessionId = state.currentSessionId;
                if (!sessionId) return;
                const chunks = String(state.reply.content || '').split(' ');
                if (state.reply.reasoning) {
                    yield {
                        type: 'message.part.updated',
                        properties: {
                            part: { id: 'part-reasoning', type: 'reasoning', sessionID: sessionId }
                        }
                    };
                    yield {
                        type: 'message.part.delta',
                        properties: {
                            sessionID: sessionId,
                            partID: 'part-reasoning',
                            field: 'text',
                            delta: state.reply.reasoning
                        }
                    };
                }
                for (let index = 0; index < chunks.length; index += 1) {
                    if (index === 0) {
                        yield {
                            type: 'message.part.updated',
                            properties: { part: { id: 'part-text', type: 'text', sessionID: sessionId } }
                        };
                    }
                    yield {
                        type: 'message.part.delta',
                        properties: {
                            sessionID: sessionId,
                            partID: 'part-text',
                            field: 'text',
                            delta: index === 0 ? chunks[index] : ` ${chunks[index]}`
                        }
                    };
                }
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        }))
    }
};

const sdkModule = { createOpencodeClient: jest.fn(() => fakeSdk) };

jest.unstable_mockModule('@opencode-ai/sdk', () => sdkModule);

const { createApp } = await import('../../src/app.js');
const { createConversationRegistry } = await import('../../src/conversation/index.js');
const { createLogger } = await import('../../src/logging/index.js');
const { createResponseChainIndex } = await import('../../src/routes/engine.js');
const { createDirectUpstream, createRuntimeUpstream, createUpstreamRouter } =
    await import('../../src/upstreams/index.js');

const logger = createLogger({ level: 'error', json: false, debug: false });

/**
 * Build an application with the fake SDK and an optional stub direct upstream.
 *
 * @param {Record<string, any>} config Gateway config.
 * @param {object} [options] Builder options.
 * @param {typeof fetch} [options.fetch] Direct upstream transport.
 * @param {number} [options.lockTimeoutMs] Conversation lock wait (tests).
 * @returns {import('express').Application} Application.
 */
const buildApp = (config, { fetch: directFetch = null, lockTimeoutMs = null } = {}) => {
    const runtime = createRuntimeUpstream({ config, logger, sdk: sdkModule });
    const direct = createDirectUpstream({
        config,
        logger,
        // Direct turns must reach the stub upstream started by the test; without a
        // key the direct path is never taken, so the real fetch stays idle.
        fetch: directFetch || ((...args) => globalThis.fetch(...args))
    });
    const responseChains = createResponseChainIndex({ logger });
    const registry = createConversationRegistry({
        config,
        logger,
        sessionBackend: runtime,
        deleteSession: (sessionId) => runtime.deleteSession(sessionId),
        isSessionHeld: (sessionId) => responseChains.isHeld(sessionId),
        lockTimeoutMs
    });
    const router = createUpstreamRouter({ config, logger, direct, runtime, registry });
    return createApp({ config, logger, registry, router, responseChains, ensureBackend: async () => {} });
};

const baseConfig = (overrides = {}) => ({
    PORT: 10000,
    API_KEY: '',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 5000,
    DISABLE_TOOLS: true,
    DEBUG: false,
    ...overrides
});

const chat = (app, body) => request(app).post('/v1/chat/completions').send(body);
const responses = (app, body) => request(app).post('/v1/responses').send(body);

beforeEach(() => {
    jest.clearAllMocks();
    resetState();
});

afterEach(() => {
    // A test that fails mid-flight must not leave a hanging prompt behind: every
    // later turn would wait for it.
    state.promptHangs = false;
    state.messagesError = null;
});

describe('auth and error shapes (api-reference)', () => {
    test('missing bearer key answers the documented invalid_api_key body', async () => {
        const app = buildApp(baseConfig({ API_KEY: 'secret' }));
        const res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' }
        });
    });

    test('an unknown route answers the documented 404 body', async () => {
        const app = buildApp(baseConfig());
        const res = await request(app).get('/nope');
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: { message: 'Route not found: GET /nope', type: 'not_found_error' }
        });
    });

    test('a missing messages array is a 400', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, { model: 'opencode/kimi-k2.5' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.message).toBe('messages array is required');
    });

    test('only system messages are a 400 before any session is created', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'system', content: 'be nice' }]
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.message).toBe('messages must include at least one non-system text message');
        expect(fakeSdk.session.create).not.toHaveBeenCalled();
    });

    test('a missing input is a 400', async () => {
        const app = buildApp(baseConfig());
        const res = await responses(app, { model: 'opencode/kimi-k2.5' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.message).toBe('input is required');
    });

    test('an unknown model is a 404 model_not_found', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, {
            model: 'opencode/not-a-model',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(res.statusCode).toBe(404);
        expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_found' });
    });
});

describe('chat completions contract', () => {
    test('non-streaming body shape and usage keys', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hello there' }]
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.object).toBe('chat.completion');
        expect(res.body.id).toMatch(/^chatcmpl-/);
        expect(typeof res.body.created).toBe('number');
        expect(res.body.model).toBe('opencode/kimi-k2.5');
        expect(res.body.choices[0].index).toBe(0);
        expect(res.body.choices[0].finish_reason).toBe('stop');
        expect(res.body.choices[0].message.content).toBe('Hello from the runtime');
        expect(res.body.usage).toMatchObject({
            prompt_tokens: expect.any(Number),
            completion_tokens: expect.any(Number),
            total_tokens: expect.any(Number)
        });
        expect(res.body.usage.completion_tokens_details).toEqual({ reasoning_tokens: expect.any(Number) });
    });

    test('reasoning_content appears only when the model produced reasoning', async () => {
        const app = buildApp(baseConfig());
        let res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(res.body.choices[0].message).not.toHaveProperty('reasoning_content');

        state.reply = { content: 'answer', reasoning: 'thinking' };
        res = await chat(app, { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.body.choices[0].message.reasoning_content).toBe('thinking');
    });

    test('streaming frames are SSE chunks ending with [DONE] and a usage block', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'stream please' }],
            stream: true
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const body = res.text;
        expect(body).toContain('data: [DONE]');
        const records = body
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .filter((payload) => payload !== '[DONE]')
            .map((payload) => JSON.parse(payload));
        expect(records.length).toBeGreaterThan(0);
        // Every record carries the same completion id; the delta chunks also carry
        // the documented object/model, while the terminal (usage) chunk keeps its
        // own shape of id + choices + usage.
        records.forEach((record) => {
            expect(record.id).toMatch(/^chatcmpl-/);
            if (record.object !== undefined) {
                expect(record.object).toBe('chat.completion.chunk');
                expect(record.model).toBe('opencode/kimi-k2.5');
            }
        });
        const final = records[records.length - 1];
        expect(['stop', 'tool_calls']).toContain(final.choices[0].finish_reason);
        expect(final.usage.prompt_tokens).toEqual(expect.any(Number));
        expect(final.choices[0].delta).toEqual({});
    });
});

describe('responses contract', () => {
    test('non-streaming body shape and usage keys', async () => {
        const app = buildApp(baseConfig());
        const res = await responses(app, { model: 'opencode/kimi-k2.5', input: 'hello' });
        expect(res.statusCode).toBe(200);
        expect(res.body.object).toBe('response');
        expect(res.body.id).toMatch(/^resp_/);
        expect(res.body.model).toBe('opencode/kimi-k2.5');
        expect(Array.isArray(res.body.output)).toBe(true);
        expect(res.body.usage).toMatchObject({
            input_tokens: expect.any(Number),
            output_tokens: expect.any(Number),
            total_tokens: expect.any(Number),
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: expect.any(Number) }
        });
    });

    test('streaming emits the documented event sequence and terminates with [DONE]', async () => {
        const app = buildApp(baseConfig());
        const res = await responses(app, { model: 'opencode/kimi-k2.5', input: 'hello', stream: true });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: [DONE]');
        const events = res.text
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .filter((payload) => payload !== '[DONE]')
            .map((payload) => JSON.parse(payload));
        const types = events.map((event) => event.type);
        expect(types[0]).toBe('response.created');
        expect(types).toContain('response.output_item.added');
        expect(types).toContain('response.completed');
        expect(types[types.length - 1]).toBe('response.completed');
        const sequence = events.map((event) => event.sequence_number);
        expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
        expect(new Set(sequence).size).toBe(sequence.length);
    });

    test('an unknown previous_response_id is a 400', async () => {
        const app = buildApp(baseConfig());
        const res = await responses(app, {
            model: 'opencode/kimi-k2.5',
            input: 'continue',
            previous_response_id: 'resp_does_not_exist'
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.message).toBe('Invalid or expired previous_response_id');
    });
});

describe('operational surfaces', () => {
    test('GET /health is always ok', async () => {
        const app = buildApp(baseConfig());
        const res = await request(app).get('/health');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
    });

    test('GET /health/details honours the auth flags and reports the documented keys', async () => {
        const openApp = buildApp(
            baseConfig({ HEALTH_DETAILS_ENABLED: true, HEALTH_DETAILS_REQUIRE_AUTH: false })
        );
        const open = await request(openApp).get('/health/details');
        expect(open.statusCode).toBe(200);
        expect(open.body.internal_tools.config).toMatchObject({
            allowed_tools: expect.any(Array),
            metrics_enabled: expect.any(Boolean)
        });
        expect(open.body.internal_tools.metrics).toMatchObject({
            externalBridgeRequests: expect.any(Number),
            internalAllowlistRequests: expect.any(Number),
            disabledRequests: expect.any(Number),
            discoveryFailures: expect.any(Number),
            fallbackToDisabled: expect.any(Number)
        });
        expect(open.body.internal_tools.cache).toMatchObject({ tool_ids_cached: expect.any(Boolean) });
        expect(open.body.internal_tools.audit.available).toBe(true);

        const authApp = buildApp(
            baseConfig({
                API_KEY: 'secret',
                HEALTH_DETAILS_ENABLED: true,
                HEALTH_DETAILS_REQUIRE_AUTH: true
            })
        );
        const unauthorized = await request(authApp).get('/health/details');
        expect(unauthorized.statusCode).toBe(401);
        expect(unauthorized.text).toBe('Unauthorized');

        const offApp = buildApp(baseConfig({ HEALTH_DETAILS_ENABLED: false }));
        const off = await request(offApp).get('/health/details');
        expect(off.statusCode).toBe(404);
        expect(off.text).toBe('Not found');
    });

    test('GET /metrics is 404 while disabled and exposes the documented metric names when enabled', async () => {
        const offApp = buildApp(baseConfig({ METRICS_ENABLED: false }));
        expect((await request(offApp).get('/metrics')).statusCode).toBe(404);

        const onApp = buildApp(baseConfig({ METRICS_ENABLED: true, METRICS_REQUIRE_AUTH: false }));
        const res = await request(onApp).get('/metrics');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/plain');
        for (const metric of [
            'opencode_internal_tool_mode_requests_total',
            'opencode_internal_tool_discovery_failures_total',
            'opencode_internal_tool_fallback_disabled_total',
            'opencode_internal_tool_cache_ids'
        ]) {
            expect(res.text).toContain(metric);
        }
    });

    test('GET /v1/models uses the runtime catalog', async () => {
        const app = buildApp(baseConfig());
        const res = await request(app).get('/v1/models');
        expect(res.statusCode).toBe(200);
        expect(res.body.object).toBe('list');
        expect(res.body.data[0]).toMatchObject({
            id: 'opencode/kimi-k2.5',
            object: 'model',
            owned_by: 'opencode'
        });
    });
});

describe('conversation failures: 503 conversation_busy / 503 session_state_unavailable / 504 timeout', () => {
    test('a waiter that cannot take the conversation lock gets 503 conversation_busy', async () => {
        // /v1/responses is the endpoint without the global request lock, so a turn
        // holding the conversation really does make the next one wait.
        const app = buildApp(baseConfig({ REQUEST_TIMEOUT_MS: 30000 }), { lockTimeoutMs: 100 });
        state.promptHangs = true;
        const first = responses(app, {
            model: 'opencode/kimi-k2.5',
            input: 'hold the conversation'
        }).set('x-opencode-session', 'busy-conversation');
        const firstDone = new Promise((resolve) => first.end(() => resolve()));
        try {
            await new Promise((resolve) => setTimeout(resolve, 150));

            const second = await responses(app, {
                model: 'opencode/kimi-k2.5',
                input: 'me too'
            }).set('x-opencode-session', 'busy-conversation');
            expect(second.statusCode).toBe(503);
            expect(second.body).toEqual({
                error: { message: 'Conversation is busy with another request', type: 'conversation_busy' }
            });
        } finally {
            // Release the holder and wait for its response: a turn left parked
            // keeps supertest's per-test server open and stops Jest from exiting.
            state.promptHangs = false;
            state.releasePromptHang?.();
            await firstDone;
        }
    }, 15000);
});

describe('upstream selection matrix', () => {
    /** Local stub upstream that records requests and answers as configured. */
    const startStubUpstream = async (handler) => {
        const seen = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                seen.push({ url: req.url, headers: req.headers, body });
                handler(req, res, body);
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        return {
            seen,
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((resolve) => server.close(resolve))
        };
    };

    test('without an upstream key everything goes to the runtime', async () => {
        const app = buildApp(baseConfig());
        const res = await chat(app, {
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(res.statusCode).toBe(200);
        expect(fakeSdk.session.prompt).toHaveBeenCalled();
    });

    test('an opencode-go model is relayed to the go endpoint and the model name is mapped back', async () => {
        const upstream = await startStubUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'x', model: 'go-internal-name', choices: [] }));
        });
        try {
            const app = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`
                })
            );
            const res = await chat(app, {
                model: 'opencode-go/some-model',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(res.statusCode).toBe(200);
            expect(upstream.seen[0].url).toBe('/go/chat/completions');
            expect(upstream.seen[0].headers.authorization).toBe('Bearer upstream-key');
            expect(JSON.parse(upstream.seen[0].body).model).toBe('some-model');
            expect(res.body.model).toBe('opencode-go/some-model');
            expect(fakeSdk.session.prompt).not.toHaveBeenCalled();
        } finally {
            await upstream.close();
        }
    });

    test('a paid opencode model is relayed to the zen endpoint', async () => {
        const upstream = await startStubUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'x', model: 'zen-internal', choices: [] }));
        });
        try {
            const app = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`
                })
            );
            const res = await chat(app, {
                model: 'opencode/paid-model',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(res.statusCode).toBe(200);
            expect(upstream.seen[0].url).toBe('/zen/chat/completions');
        } finally {
            await upstream.close();
        }
    });

    test('a -free model stays on the runtime even with a key configured', async () => {
        const upstream = await startStubUpstream((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{}');
        });
        try {
            const app = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`
                })
            );
            const res = await chat(app, {
                model: 'opencode/kimi-k2.5-free',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(res.statusCode).toBe(200);
            expect(upstream.seen).toHaveLength(0);
            expect(fakeSdk.session.prompt).toHaveBeenCalled();
        } finally {
            await upstream.close();
        }
    });

    test('a 403 FreeTierError is relayed when fallback is off and learned when fallback is on', async () => {
        const upstream = await startStubUpstream((_req, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: 'free tier' } })
            );
        });
        try {
            const strict = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`,
                    DIRECT_FALLBACK_TO_RUNTIME: false
                })
            );
            const relayed = await chat(strict, {
                model: 'opencode/paid-model',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(relayed.statusCode).toBe(403);
            expect(relayed.body.error.type).toBe('FreeTierError');

            const falling = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`
                })
            );
            const first = await chat(falling, {
                model: 'opencode/paid-model',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(first.statusCode).toBe(200);
            expect(fakeSdk.session.prompt).toHaveBeenCalledTimes(1);

            // The model is now learned as runtime-only: no further direct attempt.
            const directCallsBefore = upstream.seen.length;
            const second = await chat(falling, {
                model: 'opencode/paid-model',
                messages: [{ role: 'user', content: 'again' }]
            });
            expect(second.statusCode).toBe(200);
            expect(upstream.seen.length).toBe(directCallsBefore);
        } finally {
            await upstream.close();
        }
    });

    test('an upstream 429 is relayed verbatim in direct mode', async () => {
        const upstream = await startStubUpstream((_req, res) => {
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }));
        });
        try {
            const app = buildApp(
                baseConfig({
                    ZEN_API_KEY: 'upstream-key',
                    DIRECT_GO_BASE_URL: `${upstream.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${upstream.baseUrl}/zen`,
                    DIRECT_FALLBACK_TO_RUNTIME: false
                })
            );
            const res = await chat(app, {
                model: 'opencode-go/limited',
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(res.statusCode).toBe(429);
            expect(res.body).toEqual({ error: { message: 'rate limited', type: 'rate_limit' } });
        } finally {
            await upstream.close();
        }
    });
});
