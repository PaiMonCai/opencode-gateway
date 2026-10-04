import request from 'supertest';
import http from 'http';
import { jest } from '@jest/globals';

/**
 * Conversation session reuse.
 *
 * A client that addresses a conversation with a session identity header must
 * keep one backend session across turns (that is what gives the provider a
 * stable `x-opencode-session`), and a client that sends no such header must keep
 * the original stateless behaviour.
 *
 * The SDK is mocked with a small stateful backend: sessions own their message
 * list, prompts append to it, and reads return it. That is enough to observe
 * session creation, prompt routing, and what each turn actually sends.
 */
const sdkState = {
    sessions: new Map(),
    prompts: [],
    createCount: 0,
    suppressNextAssistant: false,
    failTurnOnce: false,
    hangNextPrompt: false,
    replyOverrideNext: null,
    failMessagesTimes: 0,
    promptQueue: []
};

const resetSdkState = () => {
    sdkState.sessions = new Map();
    sdkState.prompts = [];
    sdkState.createCount = 0;
    sdkState.suppressNextAssistant = false;
    sdkState.failTurnOnce = false;
    sdkState.hangNextPrompt = false;
    sdkState.replyOverrideNext = null;
    sdkState.failMessagesTimes = 0;
    sdkState.promptQueue = [];
};

const promptTextOf = (args) => (args?.body?.parts || [])
    .map((part) => part.text || '')
    .join('\n\n');

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{
                id: 'opencode',
                models: {
                    'kimi-k2.5': { name: 'Kimi k2.5', release_date: '2024-01-15' },
                    'gpt-5-nano': { name: 'GPT-5 Nano', release_date: '2025-01-15' }
                }
            }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => {
        sdkState.createCount += 1;
        const id = `session-${sdkState.createCount}`;
        sdkState.sessions.set(id, []);
        return { data: { id } };
    }),
    sessionPrompt: jest.fn(async (args) => {
        if (sdkState.hangNextPrompt) {
            sdkState.hangNextPrompt = false;
            return new Promise(() => {});
        }
        const id = args?.path?.id;
        const session = sdkState.sessions.get(id) || [];
        sdkState.sessions.set(id, session);
        const text = promptTextOf(args);
        sdkState.prompts.push({ sessionId: id, parts: args?.body?.parts || [], system: args?.body?.system, model: args?.body?.model });

        const turn = session.filter((entry) => entry.info.role === 'assistant').length + 1;
        const reply = sdkState.replyOverrideNext || `reply-${turn}:${text.slice(0, 40)}`;
        sdkState.replyOverrideNext = null;
        session.push({
            info: { id: `msg-user-${id}-${turn}`, role: 'user', sessionID: id },
            parts: [{ type: 'text', text }]
        });
        if (sdkState.suppressNextAssistant) {
            sdkState.suppressNextAssistant = false;
            return { data: { parts: [] } };
        }
        if (sdkState.failTurnOnce) {
            sdkState.failTurnOnce = false;
            session.push({
                info: {
                    id: `msg-assistant-${id}-${turn}`,
                    role: 'assistant',
                    sessionID: id,
                    error: { name: 'RateLimitError', message: 'rate limit exceeded' }
                },
                parts: []
            });
            return { data: { parts: [] } };
        }
        session.push({
            info: {
                id: `msg-assistant-${id}-${turn}`,
                role: 'assistant',
                sessionID: id,
                finish: 'stop',
                time: { created: Date.now(), completed: Date.now() }
            },
            parts: [{ type: 'text', text: reply }]
        });
        return { data: { parts: [{ type: 'text', text: reply }] } };
    }),
    sessionMessages: jest.fn(async (args) => {
        if (sdkState.failMessagesTimes > 0) {
            sdkState.failMessagesTimes -= 1;
            throw new Error('session read failed');
        }
        const id = args?.path?.id;
        return (sdkState.sessions.get(id) || []).map((entry) => ({
            info: { ...entry.info },
            parts: [...entry.parts]
        }));
    }),
    sessionDelete: jest.fn(async (args) => {
        sdkState.sessions.delete(args?.path?.id);
        return {};
    }),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            for (const event of sdkState.promptQueue) yield event;
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: { get: jest.fn((url, options, callback) => {
        const res = { statusCode: 200, headers: {}, on: jest.fn((event, handler) => {
            if (event === 'data') handler(Buffer.from(''));
            if (event === 'end') handler();
        }) };
        callback(res);
        return { on: jest.fn(), destroy: jest.fn() };
    }) }
}));

jest.unstable_mockModule('http', () => ({
    default: { get: jest.fn((url, options, callback) => {
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
    }) }
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

const { createApp } = await import('../../src/proxy.js');

const makeApp = (overrides = {}) => createApp({
    PORT: 10000,
    API_KEY: 'test-key',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 2000,
    DISABLE_TOOLS: false,
    DEBUG: false,
    ...overrides
}).app;

const chat = (app, { sessionId, header = 'session-id', messages, model = 'opencode/kimi-k2.5' }) => {
    let req = request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-key');
    if (sessionId !== undefined) req = req.set(header, sessionId);
    return req.send({ model, messages });
};

const contentOf = (res) => res.body?.choices?.[0]?.message?.content || '';
const lastPrompt = () => sdkState.prompts[sdkState.prompts.length - 1];

describe('conversation session reuse', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSdkState();
        app = makeApp();
    });

    test('reuses one backend session per session header and sends only the appended turns', async () => {
        const first = await chat(app, {
            sessionId: 'conv-a',
            messages: [{ role: 'user', content: 'first question' }]
        });
        expect(first.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);

        const second = await chat(app, {
            sessionId: 'conv-a',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'second question' }
            ]
        });
        expect(second.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);
        expect(sdkState.prompts).toHaveLength(2);
        expect(sdkState.prompts[0].sessionId).toEqual('session-1');
        expect(sdkState.prompts[1].sessionId).toEqual('session-1');

        // The echoed assistant turn stays out of the context, and the earlier
        // user turn is not repeated inside a session that already holds it.
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('second question');
        expect(sentText).not.toContain('first question');
        expect(contentOf(second)).toContain('reply-2');
    });

    test('keeps separate conversations on separate sessions', async () => {
        await chat(app, { sessionId: 'conv-a', messages: [{ role: 'user', content: 'a' }] });
        await chat(app, { sessionId: 'conv-b', messages: [{ role: 'user', content: 'b' }] });

        expect(sdkState.createCount).toEqual(2);
        expect(sdkState.prompts[0].sessionId).not.toEqual(sdkState.prompts[1].sessionId);
    });

    test('stays stateless when no session header is present', async () => {
        await chat(app, { messages: [{ role: 'user', content: 'a' }] });
        await chat(app, {
            messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'b' }]
        });

        expect(sdkState.createCount).toEqual(2);
        expect(sdkState.prompts[0].sessionId).not.toEqual(sdkState.prompts[1].sessionId);
    });

    test('starts a fresh session when the client rewrites the history', async () => {
        await chat(app, { sessionId: 'conv-a', messages: [{ role: 'user', content: 'first question' }] });
        const rewritten = await chat(app, {
            sessionId: 'conv-a',
            messages: [
                { role: 'user', content: 'EDITED first question' },
                { role: 'user', content: 'second question' }
            ]
        });

        expect(rewritten.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('EDITED first question');
        expect(sentText).toContain('second question');
    });

    test('starts a fresh session when the model or tool policy changes', async () => {
        await chat(app, { sessionId: 'conv-a', messages: [{ role: 'user', content: 'question' }] });
        await chat(app, {
            sessionId: 'conv-a',
            model: 'opencode/gpt-5-nano',
            messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'more' }]
        });

        expect(sdkState.createCount).toEqual(2);
    });

    test('accepts the harness style session header', async () => {
        await chat(app, {
            sessionId: 'harness-conversation',
            header: 'x-deepseek-harness-session-id',
            messages: [{ role: 'user', content: 'one' }]
        });
        await chat(app, {
            sessionId: 'harness-conversation',
            header: 'x-deepseek-harness-session-id',
            messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'two' }]
        });

        expect(sdkState.createCount).toEqual(1);
    });

    test('expires idle conversations after the configured TTL', async () => {
        const ttlApp = makeApp({ SESSION_TTL_MS: 40 });
        await chat(ttlApp, { sessionId: 'conv-ttl', messages: [{ role: 'user', content: 'one' }] });
        await new Promise((resolve) => setTimeout(resolve, 80));
        await chat(ttlApp, {
            sessionId: 'conv-ttl',
            messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'two' }]
        });

        expect(sdkState.createCount).toEqual(2);
    });

    test('never reports the previous turn of a reused session as the current answer', async () => {
        const shortTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 300 });
        const first = await chat(shortTimeoutApp, {
            sessionId: 'conv-stale',
            messages: [{ role: 'user', content: 'first question' }]
        });
        expect(contentOf(first)).toContain('reply-1');

        // The second turn produces no new assistant message. Without the
        // baseline filter the finished previous answer would be returned as if
        // it were this turn's response.
        sdkState.suppressNextAssistant = true;
        const second = await chat(shortTimeoutApp, {
            sessionId: 'conv-stale',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'second question' }
            ]
        });

        expect(second.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(second.body)).not.toContain('reply-1');
    });

    test('prefers the more specific header when several are sent', async () => {
        await chat(app, {
            sessionId: 'from-session-id',
            messages: [{ role: 'user', content: 'one' }]
        });
        // Same conversation, addressed by the harness header this time: a
        // different identity must not silently share the first session.
        await chat(app, {
            sessionId: 'from-harness',
            header: 'x-deepseek-harness-session-id',
            messages: [{ role: 'user', content: 'one' }]
        });

        expect(sdkState.createCount).toEqual(2);
    });

    test('reuses the backend session for /v1/responses chained by the same header', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'resp-conv')
            .send({ model: 'opencode/kimi-k2.5', input: 'first question' });
        expect(first.statusCode).toEqual(200);

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'resp-conv')
            .send({
                model: 'opencode/kimi-k2.5',
                input: [
                    { role: 'user', content: 'first question' },
                    { role: 'assistant', content: 'echo' },
                    { role: 'user', content: 'second question' }
                ]
            });

        expect(second.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('second question');
        expect(sentText).not.toContain('first question');
    });

    test('does not disturb a previous_response_id chain when a header appears later', async () => {
        // The chain starts without a session header, so its session is unknown to
        // the conversation map. A later header-only request must not treat that
        // session as a stale entry and delete it out from under the chain.
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first question' });
        expect(first.statusCode).toEqual(200);

        const chainedSession = sdkState.prompts[0].sessionId;
        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'conv-chain')
            .send({
                model: 'opencode/kimi-k2.5',
                previous_response_id: first.body.id,
                input: 'second question'
            });
        expect(second.statusCode).toEqual(200);
        expect(sdkState.prompts[1].sessionId).toEqual(chainedSession);

        const third = await chat(app, {
            sessionId: 'conv-chain',
            messages: [{ role: 'user', content: 'third question' }]
        });
        expect(third.statusCode).toEqual(200);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalledWith({ path: { id: chainedSession } });
    });

    test('can be disabled entirely', async () => {        const statelessApp = makeApp({ SESSION_REUSE_ENABLED: false });
        await chat(statelessApp, { sessionId: 'conv-off', messages: [{ role: 'user', content: 'one' }] });
        await chat(statelessApp, {
            sessionId: 'conv-off',
            messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'two' }]
        });

        expect(sdkState.createCount).toEqual(2);
    });
});

describe('conversation session reuse regressions', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSdkState();
        app = makeApp();
    });

    test('a retried turn rebuilds the full history for the fresh session', async () => {
        const first = await chat(app, {
            sessionId: 'conv-retry',
            messages: [{ role: 'user', content: 'remember 41' }]
        });
        expect(first.statusCode).toEqual(200);

        // The upstream throttles the first attempt of turn two; the proxy rotates
        // to a new session, which must receive the whole history, not the delta.
        sdkState.failTurnOnce = true;
        const second = await chat(app, {
            sessionId: 'conv-retry',
            messages: [
                { role: 'user', content: 'remember 41' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'what number?' }
            ]
        });
        expect(second.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);

        const retryPrompt = sdkState.prompts[sdkState.prompts.length - 1];
        expect(retryPrompt.sessionId).toEqual('session-2');
        const retryText = promptTextOf({ body: { parts: retryPrompt.parts } });
        expect(retryText).toContain('remember 41');
        expect(retryText).toContain('what number?');

        // And the next turn keeps reusing the rotated session with a delta only.
        const third = await chat(app, {
            sessionId: 'conv-retry',
            messages: [
                { role: 'user', content: 'remember 41' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'what number?' },
                { role: 'assistant', content: contentOf(second) },
                { role: 'user', content: 'double it' }
            ]
        });
        expect(third.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);
        const thirdText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(thirdText).toContain('double it');
        expect(thirdText).not.toContain('remember 41');
    });

    test('fails the turn instead of serving the previous answer when the snapshot cannot be read', async () => {
        const shortTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 300 });
        const first = await chat(shortTimeoutApp, {
            sessionId: 'conv-snap',
            messages: [{ role: 'user', content: 'first question' }]
        });
        expect(contentOf(first)).toContain('reply-1');

        // Both snapshot attempts fail, so the proxy cannot tell the previous turn
        // apart from this one and must not answer with stale content.
        sdkState.failMessagesTimes = 2;
        const second = await chat(shortTimeoutApp, {
            sessionId: 'conv-snap',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'second question' }
            ]
        });
        expect(second.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(second.body)).not.toContain('reply-1');
        expect(second.body.error.type).toEqual('session_state_unavailable');
    });

    test('a previous_response_id chained turn never returns the previous answer', async () => {
        const shortTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 300 });
        const first = await request(shortTimeoutApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first question' });
        expect(first.statusCode).toEqual(200);

        sdkState.suppressNextAssistant = true;
        const second = await request(shortTimeoutApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                previous_response_id: first.body.id,
                input: 'second question'
            });

        expect(second.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(second.body)).not.toContain('reply-1');
    });

    test('detects an edit anywhere in the delivered prefix, not just at the tail', async () => {
        await chat(app, { sessionId: 'conv-prefix', messages: [{ role: 'user', content: 'A' }] });
        await chat(app, {
            sessionId: 'conv-prefix',
            messages: [
                { role: 'user', content: 'A' },
                { role: 'assistant', content: 'x' },
                { role: 'user', content: 'B' }
            ]
        });
        expect(sdkState.createCount).toEqual(1);

        const edited = await chat(app, {
            sessionId: 'conv-prefix',
            messages: [
                { role: 'user', content: 'EDITED A' },
                { role: 'assistant', content: 'x' },
                { role: 'user', content: 'B' },
                { role: 'user', content: 'C' }
            ]
        });
        expect(edited.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('EDITED A');
        expect(sentText).toContain('C');
    });

    test('rotates instead of re-appending a delta that is only the echoed answer', async () => {
        const first = await chat(app, { sessionId: 'conv-echo', messages: [{ role: 'user', content: 'A' }] });
        const echoed = await chat(app, {
            sessionId: 'conv-echo',
            messages: [
                { role: 'user', content: 'A' },
                { role: 'assistant', content: contentOf(first) }
            ]
        });

        expect(echoed.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('A');
        expect(sentText).toContain('ASSISTANT:');
    });

    test('rejects an empty prompt before creating a session, header or not', async () => {
        const withHeader = await chat(app, {
            sessionId: 'conv-empty',
            messages: [{ role: 'system', content: 'only a system prompt' }]
        });
        expect(withHeader.statusCode).toEqual(400);
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();

        const withoutHeader = await chat(app, {
            messages: [{ role: 'system', content: 'only a system prompt' }]
        });
        expect(withoutHeader.statusCode).toEqual(400);
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
    });

    test('closes the session it owned when a reused turn fails', async () => {
        const shortTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 300 });
        const first = await chat(shortTimeoutApp, {
            sessionId: 'conv-fail',
            messages: [{ role: 'user', content: 'first question' }]
        });
        const reused = sdkState.prompts[0].sessionId;

        sdkState.suppressNextAssistant = true;
        const second = await chat(shortTimeoutApp, {
            sessionId: 'conv-fail',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'second question' }
            ]
        });
        expect(second.statusCode).toBeGreaterThanOrEqual(400);
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: reused } });

        // The conversation is forgotten as well, so the next turn starts clean.
        sdkState.suppressNextAssistant = false;
        sdkState.prompts = [];
        const third = await chat(shortTimeoutApp, {
            sessionId: 'conv-fail',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'third question' }
            ]
        });
        expect(third.statusCode).toEqual(200);
        expect(sdkState.prompts[0].sessionId).not.toEqual(reused);
    });

    test('keeps a session referenced by a live response chain when a conversation is evicted', async () => {
        // The chain's session is created without a header, then a header-only
        // rewrite arrives: the rewrite must not delete the chain's session.
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first question' });
        const chainedSession = sdkState.prompts[0].sessionId;

        const chained = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('session-id', 'conv-chain-2')
            .send({
                model: 'opencode/kimi-k2.5',
                previous_response_id: first.body.id,
                input: 'second question'
            });
        expect(chained.statusCode).toEqual(200);

        const rewritten = await chat(app, {
            sessionId: 'conv-chain-2',
            messages: [{ role: 'user', content: 'unrelated rewrite' }]
        });
        expect(rewritten.statusCode).toEqual(200);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalledWith({ path: { id: chainedSession } });
    });

    test('reports the whole conversation in prompt_tokens even when only the delta is sent', async () => {
        const first = await chat(app, { sessionId: 'conv-tokens', messages: [{ role: 'user', content: 'first question' }] });
        const second = await chat(app, {
            sessionId: 'conv-tokens',
            messages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'second question' }
            ]
        });

        expect(second.statusCode).toEqual(200);
        // The delta is short, so a delta-only estimate would be a couple of tokens.
        expect(second.body.usage.prompt_tokens).toBeGreaterThan(5);
    });
});

describe('turn timeouts and client disconnects', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSdkState();
        app = makeApp();
    });

    test('times out a hung /v1/responses prompt instead of holding the turn forever', async () => {
        const shortTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 250 });
        sdkState.hangNextPrompt = true;

        const startedAt = Date.now();
        const res = await request(shortTimeoutApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'hang forever' });

        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }, 10000);

    test('releases the conversation when the client disconnects mid-stream', async () => {
        const longTimeoutApp = makeApp({ REQUEST_TIMEOUT_MS: 30000 });
        sdkState.hangNextPrompt = true;

        // The abort has to reach a real socket: supertest's per-request server keeps a
        // TCPSERVERWRAP handle open when a request is aborted before it completes, which
        // leaves jest hanging ("did not exit") after the suite has passed. Listening on
        // an ephemeral port and destroying the raw socket instead reproduces the
        // disconnect and still lets the server be closed deterministically.
        const server = http.createServer(longTimeoutApp);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        try {
            const payload = JSON.stringify({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'hang' }],
                stream: true
            });
            const pending = http.request({
                host: '127.0.0.1',
                port: server.address().port,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    Authorization: 'Bearer test-key',
                    'session-id': 'conv-abort',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            });
            pending.on('error', () => {});
            pending.end(payload);
            await new Promise((resolve) => setTimeout(resolve, 150));
            pending.destroy();

            // The aborted turn must unwind and hand the conversation back: this second
            // request would otherwise sit behind the global lock and the turn lock.
            const second = await chat(longTimeoutApp, {
                sessionId: 'conv-abort',
                messages: [{ role: 'user', content: 'after the disconnect' }]
            });
            expect(second.statusCode).toEqual(200);
            expect(contentOf(second)).toContain('reply-1');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }, 10000);
});

describe('derived conversation identity (no session header)', () => {
    const derivedApp = () => makeApp({ SESSION_DERIVE_ENABLED: true });

    beforeEach(() => {
        jest.clearAllMocks();
        resetSdkState();
    });

    test('recognises a conversation from its content and reuses the session', async () => {
        const app = derivedApp();
        const first = await chat(app, { messages: [{ role: 'user', content: 'remember the codeword ZEBRA' }] });
        expect(first.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);

        const second = await chat(app, {
            messages: [
                { role: 'user', content: 'remember the codeword ZEBRA' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'what was the codeword?' }
            ]
        });
        expect(second.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);
        expect(lastPrompt().sessionId).toEqual('session-1');
        const sentText = promptTextOf({ body: { parts: lastPrompt().parts } });
        expect(sentText).toContain('what was the codeword?');
        expect(sentText).not.toContain('remember the codeword ZEBRA');
    });

    test('is off by default', async () => {
        const app = makeApp();
        await chat(app, { messages: [{ role: 'user', content: 'same first message' }] });
        await chat(app, {
            messages: [
                { role: 'user', content: 'same first message' },
                { role: 'assistant', content: 'x' },
                { role: 'user', content: 'second' }
            ]
        });
        expect(sdkState.createCount).toEqual(2);
    });

    test('keeps conversations that start differently apart', async () => {
        const app = derivedApp();
        const a = await chat(app, { messages: [{ role: 'user', content: 'conversation A' }] });
        await chat(app, {
            messages: [
                { role: 'user', content: 'conversation A' },
                { role: 'assistant', content: contentOf(a) },
                { role: 'user', content: 'A again' }
            ]
        });
        await chat(app, { messages: [{ role: 'user', content: 'conversation B' }] });
        expect(sdkState.createCount).toEqual(2);
    });

    test('never merges two look-alike conversations when content cannot tell them apart', async () => {
        const app = derivedApp();
        // Two identical openings from the same client scope: both get their own
        // session, and the ambiguous follow-up must not be attached to either.
        const a = await chat(app, { messages: [{ role: 'user', content: 'hello' }] });
        await chat(app, { messages: [{ role: 'user', content: 'hello' }] });
        expect(sdkState.createCount).toEqual(2);

        const followUp = await chat(app, {
            messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: contentOf(a) },
                { role: 'user', content: 'first follow-up' }
            ]
        });
        expect(followUp.statusCode).toEqual(200);
        // Ambiguous prefix, identical replies: refuse to guess and start clean.
        expect(sdkState.createCount).toEqual(3);
    });

    test('uses the echoed answer to pick the right look-alike conversation', async () => {
        const app = derivedApp();
        const a = await chat(app, { messages: [{ role: 'user', content: 'hello' }] });
        // A second conversation with the same opening but a different answer
        // (the model replied differently), so the echo disambiguates.
        sdkState.replyOverrideNext = 'a different answer';
        const b = await chat(app, { messages: [{ role: 'user', content: 'hello' }] });
        expect(contentOf(b)).toEqual('a different answer');

        const resumedA = await chat(app, {
            messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: contentOf(a) },
                { role: 'user', content: 'continuing A' }
            ]
        });
        expect(resumedA.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(2);
        expect(lastPrompt().sessionId).toEqual(sdkState.prompts[0].sessionId);
        expect(lastPrompt().sessionId).not.toEqual(sdkState.prompts[1].sessionId);
    });

    test('an explicit session header still wins over derivation', async () => {
        const app = derivedApp();
        const first = await chat(app, {
            sessionId: 'explicit-conv',
            messages: [{ role: 'user', content: 'hello there' }]
        });
        const second = await chat(app, {
            sessionId: 'explicit-conv',
            messages: [
                { role: 'user', content: 'hello there' },
                { role: 'assistant', content: contentOf(first) },
                { role: 'user', content: 'again' }
            ]
        });
        expect(second.statusCode).toEqual(200);
        expect(sdkState.createCount).toEqual(1);
    });

    test('separates clients that share an opening message but differ in credentials', async () => {
        const app = derivedApp();
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hello' }] });
        await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .set('x-forwarded-for', '203.0.113.9')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hello' }] });

        expect(sdkState.createCount).toEqual(2);
    });

    test('a different model starts a different derived conversation', async () => {
        const app = derivedApp();
        await chat(app, { messages: [{ role: 'user', content: 'same opening' }] });
        await chat(app, {
            model: 'opencode/gpt-5-nano',
            messages: [
                { role: 'user', content: 'same opening' },
                { role: 'assistant', content: 'x' },
                { role: 'user', content: 'more' }
            ]
        });
        expect(sdkState.createCount).toEqual(2);
    });
});
