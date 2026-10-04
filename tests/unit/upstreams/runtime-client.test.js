import {
    buildModelsList,
    createRuntimeUpstream,
    extractFromParts,
    pollForAssistantResponse,
    promptWithTimeout,
    sessionTitleForPolicy
} from '../../../src/upstreams/runtime-client.js';
import { delay, startStub } from './helpers.js';

/**
 * Runtime upstream: the SDK-facing half of the upstream layer. Everything is
 * driven by a fake SDK (no OpenCode runtime, no network) so the behaviour that
 * matters — session lifecycle, prompt timeout/abort, baseline-filtered polling
 * and the event-stream contract — is asserted directly.
 */

/**
 * Minimal SDK stub.
 *
 * @param {object} [overrides] Per-test overrides.
 * @returns {object} Fake SDK client.
 */
const fakeClient = (overrides = {}) => ({
    session: {
        create: async () => ({ data: { id: 'ses_new' } }),
        delete: async () => ({}),
        prompt: async () => ({ data: { parts: [] } }),
        messages: async () => ({ data: [] }),
        ...(overrides.session || {})
    },
    event: {
        subscribe: async () => ({ stream: (async function* empty() {})() }),
        ...(overrides.event || {})
    },
    config: {
        providers: async () => ({ data: { providers: [] } }),
        ...(overrides.config || {})
    }
});

/**
 * A push-driven async iterable, so event ordering is fully controlled by the
 * test instead of by timing.
 *
 * @returns {{push: (value: object) => void, end: () => void, stream: AsyncIterable<object>}} Queue handle.
 */
const createQueue = () => {
    const items = [];
    let resolveNext = null;
    let closed = false;
    const settle = (result) => {
        const resolve = resolveNext;
        resolveNext = null;
        resolve(result);
    };
    return {
        push(value) {
            if (resolveNext) settle({ value, done: false });
            else items.push(value);
        },
        end() {
            closed = true;
            if (resolveNext) settle({ value: undefined, done: true });
        },
        stream: {
            [Symbol.asyncIterator]() {
                return this;
            },
            next() {
                if (items.length) return Promise.resolve({ value: items.shift(), done: false });
                if (closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                    resolveNext = resolve;
                });
            }
        }
    };
};

const assistantMessage = (
    id,
    { finish = 'stop', text = '', reasoning = '', error = null, completed = true } = {}
) => ({
    info: {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        finish,
        error,
        time: completed ? { created: 1, completed: 2 } : {}
    },
    parts: [
        ...(text ? [{ type: 'text', text }] : []),
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : [])
    ]
});

describe('sessionTitleForPolicy / extractFromParts / buildModelsList', () => {
    test('carries the policy in the title the plugin parses', () => {
        expect(sessionTitleForPolicy('none')).toBe('opencode-gateway [tools:none]');
        expect(sessionTitleForPolicy('*')).toBe('opencode-gateway [tools:*]');
        expect(sessionTitleForPolicy('webfetch,read')).toBe('opencode-gateway [tools:webfetch,read]');
    });

    test('splits parts into text, reasoning and tools', () => {
        const parts = [
            { type: 'text', text: 'a' },
            { type: 'reasoning', text: 'why' },
            { type: 'text', text: 'b' },
            { type: 'tool', id: 't1', tool: 'bash' }
        ];

        expect(extractFromParts(parts)).toEqual({ content: 'ab', reasoning: 'why', toolParts: [parts[3]] });
        expect(extractFromParts(undefined)).toEqual({ content: '', reasoning: '', toolParts: [] });
    });

    test('flattens both provider catalog shapes', () => {
        const models = buildModelsList([
            {
                id: 'opencode',
                models: { 'big-pickle': { name: 'Big Pickle', release_date: '2024-01-01T00:00:00Z' } }
            },
            { id: 'opencode-go', models: { 'kimi-k3': 'Kimi' } }
        ]);

        expect(models.map((m) => m.id)).toEqual(['opencode/big-pickle', 'opencode-go/kimi-k3']);
        expect(models[0].name).toBe('Big Pickle');
        // A provider that lists a model as a bare string keeps the id as the name.
        expect(models[1].name).toBe('kimi-k3');
        expect(models[0].created).toBe(Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000));
        expect(models.every((m) => m.object === 'model')).toBe(true);
    });
});

describe('createRuntimeUpstream session lifecycle', () => {
    test('creates a session with the policy title, or without an argument when there is none', async () => {
        const calls = [];
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({
                session: {
                    create: async (args) => {
                        calls.push(args);
                        return { data: { id: 'ses_9' } };
                    }
                }
            })
        });

        await expect(runtime.createSession({ title: 'opencode-gateway [tools:none]' })).resolves.toBe(
            'ses_9'
        );
        await expect(runtime.createSession(undefined)).resolves.toBe('ses_9');
        await expect(runtime.createSession({ toolOverrides: {} })).resolves.toBe('ses_9');

        expect(calls[0]).toEqual({ body: { title: 'opencode-gateway [tools:none]' } });
        expect(calls[1]).toBeUndefined();
        expect(calls[2]).toBeUndefined();
    });

    test('fails loudly when the SDK returns no session id', async () => {
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({ session: { create: async () => ({ data: {} }) } })
        });

        await expect(runtime.createSession()).rejects.toThrow('Failed to create OpenCode session');
    });

    test('normalises message shapes and swallows delete failures', async () => {
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({
                session: {
                    messages: async () => ({ data: [{ info: { id: 'm1' } }] }),
                    delete: async () => {
                        throw new Error('gone');
                    }
                }
            })
        });

        await expect(runtime.messages('ses_1')).resolves.toEqual([{ info: { id: 'm1' } }]);
        await expect(runtime.deleteSession('ses_1')).resolves.toBeUndefined();
        await expect(runtime.deleteSession(null)).resolves.toBeUndefined();
    });

    test('lists models from the runtime provider catalog', async () => {
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [{ id: 'opencode', models: { 'big-pickle': { name: 'Big Pickle' } } }]
                        }
                    })
                }
            })
        });

        await expect(runtime.listModels()).resolves.toEqual([
            {
                id: 'opencode/big-pickle',
                name: 'Big Pickle',
                object: 'model',
                created: 1704067200,
                owned_by: 'opencode'
            }
        ]);
    });

    test('exposes the event stream and rejects when the SDK has none', async () => {
        const queue = createQueue();
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({ event: { subscribe: async () => ({ stream: queue.stream }) } })
        });

        await expect(runtime.subscribe()).resolves.toBe(queue.stream);

        const broken = createRuntimeUpstream({ sdk: fakeClient({ event: { subscribe: async () => ({}) } }) });
        await expect(broken.subscribe()).rejects.toThrow('OpenCode event stream unavailable');
    });
});

describe('createRuntimeUpstream.ensureReady', () => {
    test('accepts a healthy runtime and caches the result', async () => {
        let hits = 0;
        const stub = await startStub((_req, res) => {
            hits += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"healthy":true}');
        });
        try {
            const runtime = createRuntimeUpstream({
                config: { OPENCODE_SERVER_URL: stub.baseUrl },
                sdk: fakeClient()
            });

            await expect(runtime.ensureReady()).resolves.toBe(true);
            await expect(runtime.ensureReady()).resolves.toBe(true);

            expect(hits).toBe(1);
            expect(stub.requests[0].url).toBe('/global/health');
        } finally {
            await stub.close();
        }
    });

    test('rejects an unhealthy runtime and an unreachable one', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"healthy":false}');
        });
        try {
            const runtime = createRuntimeUpstream({
                config: { OPENCODE_SERVER_URL: stub.baseUrl },
                sdk: fakeClient()
            });

            await expect(runtime.ensureReady()).rejects.toThrow('unhealthy');
        } finally {
            await stub.close();
        }

        const offline = createRuntimeUpstream({
            config: { OPENCODE_SERVER_URL: 'http://127.0.0.1:1' },
            sdk: fakeClient()
        });
        await expect(offline.ensureReady()).rejects.toThrow('unreachable');
    });
});

describe('promptWithTimeout', () => {
    test('resolves with the SDK result', async () => {
        const result = await promptWithTimeout({
            client: { session: { prompt: async () => ({ data: { ok: true } }) } },
            params: { path: { id: 'ses_1' }, body: {} },
            timeoutMs: 1000
        });

        expect(result).toEqual({ data: { ok: true } });
    });

    test('rejects with 504 request_timeout when the SDK hangs', async () => {
        await expect(
            promptWithTimeout({
                client: { session: { prompt: () => new Promise(() => {}) } },
                params: {},
                timeoutMs: 20
            })
        ).rejects.toMatchObject({ statusCode: 504, code: 'request_timeout' });
    });

    test('rejects with 499 client_closed when the caller aborts', async () => {
        const controller = new AbortController();
        const pending = promptWithTimeout({
            client: { session: { prompt: () => new Promise(() => {}) } },
            params: {},
            timeoutMs: 5000,
            signal: controller.signal
        });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ statusCode: 499, code: 'client_closed' });
    });
});

describe('pollForAssistantResponse', () => {
    /**
     * Drive a scripted list of message snapshots.
     *
     * @param {object[][]} snapshots Successive `session.messages` results.
     * @returns {{client: object, calls: () => number}} Fake client and call counter.
     */
    const scripted = (snapshots) => {
        let index = 0;
        return {
            client: {
                session: {
                    messages: async () => {
                        const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
                        index += 1;
                        return { data: snapshot };
                    }
                }
            },
            calls: () => index
        };
    };

    test('returns a finished assistant message', async () => {
        const { client } = scripted([[assistantMessage('m1', { text: 'hello', reasoning: 'why' })]]);

        await expect(
            pollForAssistantResponse({ client, sessionId: 'ses_1', timeoutMs: 5000 })
        ).resolves.toEqual({ content: 'hello', reasoning: 'why', error: null });
    });

    test('never reports a message that existed before the turn', async () => {
        const { client } = scripted([
            [
                assistantMessage('msg-old', { text: 'previous answer' }),
                assistantMessage('msg-new', { text: 'this turn' })
            ]
        ]);
        const baseline = { messageIds: new Set(['msg-old', 'msg-user']), partIds: new Set() };

        await expect(
            pollForAssistantResponse({ client, sessionId: 'ses_1', timeoutMs: 5000, baseline })
        ).resolves.toMatchObject({ content: 'this turn' });
    });

    test('waits for a message that only has a tool finish so far', async () => {
        const polled = scripted([
            [assistantMessage('m1', { finish: 'tool', text: 'let me look', completed: false })],
            [assistantMessage('m1', { finish: 'stop', text: 'final answer' })]
        ]);

        const result = await pollForAssistantResponse({
            client: polled.client,
            sessionId: 'ses_1',
            timeoutMs: 5000,
            intervalMs: 0,
            sleepFn: async () => {}
        });

        expect(result.content).toBe('final answer');
    });

    test('returns a partial answer when the turn times out mid-generation', async () => {
        const { client } = scripted([
            [assistantMessage('m1', { finish: null, text: 'half', completed: false })]
        ]);
        let clock = 0;

        const result = await pollForAssistantResponse({
            client,
            sessionId: 'ses_1',
            timeoutMs: 2500,
            intervalMs: 1000,
            now: () => clock,
            sleepFn: async (ms) => {
                clock += ms;
            }
        });

        expect(result).toEqual({ content: 'half', reasoning: '', error: null });
    });

    test('throws a request timeout when nothing usable arrives', async () => {
        const { client } = scripted([[]]);
        let clock = 0;

        await expect(
            pollForAssistantResponse({
                client,
                sessionId: 'ses_1',
                timeoutMs: 1000,
                intervalMs: 1000,
                now: () => clock,
                sleepFn: async (ms) => {
                    clock += ms;
                }
            })
        ).rejects.toThrow('Request timeout after 1000ms');
    });

    test('surfaces an upstream message error', async () => {
        const { client } = scripted([
            [assistantMessage('m1', { error: { name: 'AuthError' }, completed: false })]
        ]);

        await expect(
            pollForAssistantResponse({ client, sessionId: 'ses_1', timeoutMs: 5000, logger: () => {} })
        ).resolves.toMatchObject({ error: { name: 'AuthError' } });
    });
});

describe('collectFromEvents', () => {
    /**
     * @param {object} [overrides] SDK overrides.
     * @returns {{runtime: object, queue: object}} Runtime and its event queue.
     */
    const setup = (overrides = {}) => {
        const queue = createQueue();
        const runtime = createRuntimeUpstream({
            sdk: fakeClient({
                event: { subscribe: async () => ({ stream: queue.stream }) },
                ...overrides
            })
        });
        return { runtime, queue };
    };

    const partUpdated = (part, delta) => ({
        type: 'message.part.updated',
        properties: { part: { sessionID: 'ses_1', ...part }, ...(delta !== undefined ? { delta } : {}) }
    });
    const partDelta = (partID, delta, field = 'text') => ({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', partID, delta, field }
    });
    const messageUpdated = (info) => ({
        type: 'message.updated',
        properties: { info: { sessionID: 'ses_1', ...info } }
    });

    test('accumulates text deltas and finishes on stop', async () => {
        const { runtime, queue } = setup();
        const deltas = [];
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            firstDeltaTimeoutMs: 1000,
            idleTimeoutMs: 1000,
            onDelta: (delta, isReasoning) => deltas.push([delta, isReasoning])
        });

        queue.push(partUpdated({ id: 'p1', type: 'text' }, 'Hel'));
        queue.push(partUpdated({ id: 'p1', type: 'text' }, 'lo'));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));

        await expect(pending).resolves.toEqual({ content: 'Hello', reasoning: '' });
        expect(deltas).toEqual([
            ['Hel', false],
            ['lo', false]
        ]);
    });

    test('routes reasoning text separately', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            idleTimeoutMs: 1000
        });

        queue.push(partUpdated({ id: 'r1', type: 'reasoning' }, 'thinking'));
        queue.push(partUpdated({ id: 'p1', type: 'text' }, 'answer'));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));

        await expect(pending).resolves.toEqual({ content: 'answer', reasoning: 'thinking' });
    });

    test('resolves newer message.part.delta events against the announced part type', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            idleTimeoutMs: 1000
        });

        // Type announcement first, then deltas that carry only the part id.
        queue.push(partUpdated({ id: 'p1', type: 'text' }));
        queue.push(partDelta('p1', 'from '));
        queue.push(partDelta('p1', 'deltas'));
        queue.push(partUpdated({ id: 'r1', type: 'reasoning' }));
        queue.push(partDelta('r1', 'because'));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));

        await expect(pending).resolves.toEqual({ content: 'from deltas', reasoning: 'because' });
    });

    test('ignores events whose part id existed before the turn', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            idleTimeoutMs: 1000,
            baseline: { messageIds: new Set(['m-old']), partIds: new Set(['p-old']) }
        });

        queue.push(partUpdated({ id: 'p-old', type: 'text' }, 'previous answer'));
        queue.push(messageUpdated({ id: 'm-old', finish: 'stop' }));
        queue.push(partUpdated({ id: 'p-new', type: 'text' }, 'this turn'));
        queue.push(messageUpdated({ id: 'm-new', finish: 'stop' }));

        await expect(pending).resolves.toEqual({ content: 'this turn', reasoning: '' });
    });

    test('falls back when no event arrives in the first-delta window', async () => {
        const { runtime } = setup();

        await expect(
            runtime.collectFromEvents({
                sessionId: 'ses_1',
                timeoutMs: 5000,
                firstDeltaTimeoutMs: 20,
                idleTimeoutMs: 1000
            })
        ).resolves.toEqual({ content: '', reasoning: '', noData: true });
    });

    test('cuts the stream after the idle window when text was streaming', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            firstDeltaTimeoutMs: 1000,
            idleTimeoutMs: 20
        });

        queue.push(partUpdated({ id: 'p1', type: 'text' }, 'partial'));

        await expect(pending).resolves.toMatchObject({
            content: 'partial',
            idleTimeout: true,
            receivedDelta: true
        });
    });

    test('keeps waiting while an internal tool call is active', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            firstDeltaTimeoutMs: 1000,
            idleTimeoutMs: 30
        });

        queue.push(partUpdated({ id: 't1', type: 'tool', state: { status: 'running' } }));
        await delay(60); // idle window fires at least once while the tool runs
        queue.push(partUpdated({ id: 't1', type: 'tool', state: { status: 'completed' } }));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));

        const result = await pending;
        expect(result.idleTimeout).toBeUndefined();
        expect(result.content).toBe('');
        expect(result.reasoning).toBe('');
    });

    test('ignores an intermediate stop while a tool call is still pending', async () => {
        const { runtime, queue } = setup();
        let settled = false;
        const pending = runtime
            .collectFromEvents({
                sessionId: 'ses_1',
                timeoutMs: 5000,
                firstDeltaTimeoutMs: 1000,
                idleTimeoutMs: 1000
            })
            .then((result) => {
                settled = true;
                return result;
            });

        queue.push(partUpdated({ id: 't1', type: 'tool', state: { status: 'pending' } }));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));
        await delay(10);
        expect(settled).toBe(false);

        queue.push(partUpdated({ id: 't1', type: 'tool', state: { status: 'completed' } }));
        queue.push(messageUpdated({ id: 'm1', finish: 'stop' }));

        await expect(pending).resolves.toMatchObject({ content: '', reasoning: '' });
    });

    test('resolves immediately with an upstream message error', async () => {
        const { runtime, queue } = setup();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            idleTimeoutMs: 1000
        });

        queue.push(
            messageUpdated({ id: 'm1', error: { name: 'CreditsError', data: { message: 'no balance' } } })
        );

        await expect(pending).resolves.toMatchObject({ error: { name: 'CreditsError' } });
    });

    test('ends collection when the client goes away', async () => {
        const { runtime, queue } = setup();
        const controller = new AbortController();
        const pending = runtime.collectFromEvents({
            sessionId: 'ses_1',
            timeoutMs: 5000,
            idleTimeoutMs: 1000,
            signal: controller.signal
        });

        queue.push(partUpdated({ id: 'p1', type: 'text' }, 'half'));
        await delay(5); // let the delta reach the collector before the client goes away
        controller.abort();

        await expect(pending).resolves.toEqual({ content: 'half', reasoning: '', clientClosed: true });
    });

    test('rejects when the overall turn timeout fires', async () => {
        const { runtime } = setup();

        await expect(
            runtime.collectFromEvents({
                sessionId: 'ses_1',
                timeoutMs: 20,
                firstDeltaTimeoutMs: 0,
                idleTimeoutMs: 0
            })
        ).rejects.toThrow('Request timeout after 20ms');
    });
});

describe('createRuntimeUpstream prompt wiring', () => {
    test('passes configuration timeouts and the caller signal to the SDK call', async () => {
        const calls = [];
        const runtime = createRuntimeUpstream({
            config: { REQUEST_TIMEOUT_MS: 50 },
            sdk: fakeClient({
                session: {
                    prompt: async (params) => {
                        calls.push(params);
                        return { data: 'ok' };
                    }
                }
            })
        });

        await expect(runtime.prompt({ path: { id: 'ses_1' }, body: { parts: [] } })).resolves.toEqual({
            data: 'ok'
        });
        expect(calls).toEqual([{ path: { id: 'ses_1' }, body: { parts: [] } }]);

        const hanging = createRuntimeUpstream({
            sdk: fakeClient({ session: { prompt: () => new Promise(() => {}) } })
        });
        await expect(hanging.prompt({}, { timeoutMs: 20 })).rejects.toMatchObject({
            code: 'request_timeout'
        });
    });
});
