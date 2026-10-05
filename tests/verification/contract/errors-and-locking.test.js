/**
 * BEHAVIOUR-SPEC §6 — error semantics, the conversation-lock 503s, the 504
 * timeout, and the assembly-level baseline decision
 * (`baseline === null` for direct vs `ok === false` for a required runtime
 * snapshot).
 */

import { createAssembly, createAssemblyWithShortLock, createEventFactory } from './harness.js';

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

const shortLock = async (ms, options) => {
    const instance = await createAssemblyWithShortLock(ms, options);
    open.push(instance);
    return instance;
};

const USER = { role: 'user', content: 'Hello' };

/** A runtime whose prompt never resolves: keeps a turn in flight. */
const HANGING_RUNTIME = { hang: true };

describe('§6 timeout and upstream error mapping', () => {
    test('a turn that produces nothing within REQUEST_TIMEOUT_MS answers 504 timeout', async () => {
        const { http } = await assembly({
            env: { OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '250' },
            runtime: HANGING_RUNTIME
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(504);
        expect(res.body).toEqual({
            error: { message: 'Request timeout', type: 'timeout', code: 'timeout' }
        });
    }, 20_000);

    test('a billing failure maps to 402 insufficient_quota', async () => {
        const error = Object.assign(new Error('quota exceeded for this workspace'), { statusCode: 402 });
        const { http } = await assembly({ runtime: { promptError: () => error } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(402);
        expect(res.body.error).toMatchObject({
            type: 'insufficient_quota',
            code: 'insufficient_quota'
        });
    });

    test('a throttling failure maps to 429 rate_limit_exceeded', async () => {
        const error = Object.assign(new Error('throttled by provider'), { statusCode: 429 });
        const { http } = await assembly({ runtime: { promptError: () => error } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(429);
        expect(res.body.error).toMatchObject({
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
        });
    });

    test('a 400 validation error uses the literal documented body', async () => {
        const { http } = await assembly();
        // BEHAVIOUR-SPEC §2 documents this body as `{"error":{"message":...}}` —
        // no type/code — which is what the route answers.
        const res = await http.post('/v1/chat/completions').send({ model: 'opencode/big-pickle' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: { message: 'messages array is required' } });
    });

    test('a 404 model error keeps the envelope (plus the documented model list)', async () => {
        const { http } = await assembly();
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/nope', messages: [USER] });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({
            message: expect.stringContaining('Model not found'),
            type: 'invalid_request_error',
            code: 'model_not_found'
        });
        // Extension beyond the documented body: the available catalog.
        expect(Array.isArray(res.body.error.available_models)).toBe(true);
    });

    test('a malformed-JSON error keeps the envelope', async () => {
        const { http } = await assembly();
        const res = await http
            .post('/v1/chat/completions')
            .set('Content-Type', 'application/json')
            .send('{oops');
        expect(res.status).toBe(400);
        expect(res.body.error).toEqual({
            message: 'Invalid JSON in request body',
            type: 'invalid_request_error',
            code: 'invalid_request_error'
        });
    });
});

test('[FINDING-11 fixed] an unexpected runtime failure answers the documented 500 body', async () => {
    // api-reference documents 500 as
    // `{"message":"Internal server error","type":"server_error","code":"internal_error"}`.
    // Before the fix the mapper defaulted to `code = error.code ||
    // error.constructor.name` and leaked the message (the real-SDK smoke answered
    // `{"message":"fetch failed","type":"internal_error","code":"TypeError"}`).
    // Failures that are ours now answer the documented body; a failure the
    // runtime reported keeps its own message and code (see responses.test.js).
    const { http } = await assembly({
        runtime: { promptError: () => new TypeError('fetch failed') }
    });
    const res = await http
        .post('/v1/chat/completions')
        .send({ model: 'opencode/big-pickle', messages: [USER] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
        error: {
            message: 'Internal server error',
            type: 'server_error',
            code: 'internal_error'
        }
    });
});

describe('§6 conversation lock', () => {
    test('a second concurrent turn on the same conversation answers 503 conversation_busy', async () => {
        // Verify the Responses surface directly; Chat has a matching case below.
        const { http } = await shortLock(80, {
            env: { OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '600' },
            runtime: HANGING_RUNTIME
        });

        // Supertest requests are lazy: `.then()` starts the request immediately.
        const first = http
            .post('/v1/responses')
            .set('x-opencode-session', 'conv-busy')
            .send({ model: 'opencode/big-pickle', input: 'first' })
            .then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 60));

        const second = await http
            .post('/v1/responses')
            .set('x-opencode-session', 'conv-busy')
            .send({ model: 'opencode/big-pickle', input: 'second' });

        expect(second.status).toBe(503);
        expect(second.body).toEqual({
            error: { message: 'Conversation is busy with another request', type: 'conversation_busy' }
        });

        const firstRes = await first;
        expect(firstRes.status).toBe(504);
    }, 20_000);

    test('chat turns for different conversations run independently', async () => {
        const { http } = await shortLock(80, {
            env: { OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '1000' },
            runtime: {
                reply: async (args) => {
                    const promptText = (args?.body?.parts || [])
                        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
                        .join('');
                    if (promptText.includes('slow')) {
                        await new Promise((resolve) => setTimeout(resolve, 350));
                        return 'slow answer';
                    }
                    return 'fast answer';
                }
            }
        });

        const slow = http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-slow')
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'slow' }] })
            .then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const otherStartedAt = Date.now();
        const other = await http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-other')
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'fast' }] });
        const otherElapsed = Date.now() - otherStartedAt;

        expect(other.status).toBe(200);
        expect(other.body.choices[0].message.content).toBe('fast answer');
        expect(otherElapsed).toBeLessThan(250);

        const slowResponse = await slow;
        expect(slowResponse.status).toBe(200);
        expect(slowResponse.body.choices[0].message.content).toBe('slow answer');
    }, 20_000);

    test('chat turns on the same conversation use the conversation lock', async () => {
        const { http } = await shortLock(80, {
            env: { OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '600' },
            runtime: HANGING_RUNTIME
        });

        const first = http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-chat-busy')
            .send({ model: 'opencode/big-pickle', messages: [USER] })
            .then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 60));

        const second = await http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-chat-busy')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(second.status).toBe(503);
        expect(second.body).toEqual({
            error: { message: 'Conversation is busy with another request', type: 'conversation_busy' }
        });

        const firstRes = await first;
        expect(firstRes.status).toBe(504);
    }, 20_000);

    test('a client disconnect releases the conversation lock', async () => {
        const harness = await shortLock(400, {
            runtime: { eventStream: createEventFactory({ deltas: ['partial '], omitFinish: true }) }
        });
        const server = harness.app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const port = server.address().port;
        const base = `http://127.0.0.1:${port}`;

        try {
            const controller = new AbortController();
            const response = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-opencode-session': 'conv-abort' },
                body: JSON.stringify({
                    model: 'opencode/big-pickle',
                    messages: [USER],
                    stream: true
                }),
                signal: controller.signal
            });
            expect(response.status).toBe(200);
            const reader = response.body.getReader();
            const firstChunk = await reader.read();
            expect(firstChunk.done).toBe(false);
            controller.abort();
            try {
                await reader.cancel();
            } catch {
                // the socket is already gone
            }

            // Give the server a moment to observe the close and release the turn.
            await new Promise((resolve) => setTimeout(resolve, 150));

            const followUp = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-opencode-session': 'conv-abort' },
                body: JSON.stringify({
                    model: 'opencode/big-pickle',
                    messages: [
                        USER,
                        { role: 'assistant', content: 'partial ' },
                        { role: 'user', content: 'next' }
                    ]
                })
            });
            const body = await followUp.json();
            expect(followUp.status).toBe(200);
            expect(body.object).toBe('chat.completion');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }, 20_000);
});

describe('§6 baseline decision at the assembly level', () => {
    test('a reused runtime session whose snapshot fails answers 503 session_state_unavailable', async () => {
        const { http, fake } = await assembly();
        const headers = { 'x-opencode-session': 'conv-baseline' };

        const first = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'one' }] });
        expect(first.status).toBe(200);

        // The runtime can no longer read the session it owns.
        fake.client.session.messages = async () => {
            throw new Error('session state unavailable');
        };

        const second = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'one' },
                    { role: 'assistant', content: 'Runtime answer' },
                    { role: 'user', content: 'two' }
                ]
            });

        expect(second.status).toBe(503);
        expect(second.body.error).toMatchObject({
            message: 'Could not read the session state for this conversation; retry the request',
            type: 'session_state_unavailable'
        });
    });

    test('a direct conversation never asks the runtime for a baseline', async () => {
        const { http, fake } = await assembly({ env: { OPENCODE_ZEN_API_KEY: 'dummy-key' } });
        const messages = [{ role: 'user', content: 'one' }];

        const first = await http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-direct')
            .send({ model: 'opencode/big-pickle', messages });
        expect(first.status).toBe(200);

        // Any runtime session read would now fail loudly; a direct turn must not
        // need one (ARCHITECTURE §2: `baseline` is null in direct mode).
        fake.client.session.messages = async () => {
            throw new Error('the runtime does not know a direct session');
        };

        const second = await http
            .post('/v1/chat/completions')
            .set('x-opencode-session', 'conv-direct')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'one' },
                    { role: 'assistant', content: 'Direct answer' },
                    { role: 'user', content: 'two' }
                ]
            });
        expect(second.status).toBe(200);
        expect(second.body.choices[0].message.content).toBe('Direct answer');
    });

    test('[FINDING-9 fixed] a pinned runtime turn answers 503 session_state_unavailable on a bad snapshot', async () => {
        // Defect fixed during verification (was: the responses handler threw into
        // `transformUpstreamError`, whose `statusCode >= 500` branch rewrote the
        // documented 503 into 502 `server_error`). api-reference documents this
        // body as `{message, type: 'session_state_unavailable'}` — no `code`.
        const { http, fake } = await assembly();
        const first = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'first'
        });
        expect(first.status).toBe(200);

        fake.client.session.messages = async () => {
            throw new Error('snapshot unavailable');
        };
        const second = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'second',
            previous_response_id: first.body.id
        });

        expect(second.status).toBe(503);
        expect(second.body).toEqual({
            error: {
                message: 'Could not read the session state for this conversation; retry the request',
                type: 'session_state_unavailable'
            }
        });
    });

    test('the chat path answers the documented 503 for the same failure', async () => {
        const { http, fake } = await assembly();
        const headers = { 'x-opencode-session': 'conv-chat-503' };
        await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'one' }] });
        fake.client.session.messages = async () => {
            throw new Error('snapshot unavailable');
        };
        const res = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'one' },
                    { role: 'assistant', content: 'Runtime answer' },
                    { role: 'user', content: 'two' }
                ]
            });
        expect(res.status).toBe(503);
        expect(res.body.error.type).toBe('session_state_unavailable');
    });
});
