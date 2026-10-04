/**
 * Contract-level verification harness (T5 phase 2).
 *
 * Built on the **real production assembly** (`buildRuntime` from
 * `src/bootstrap.js`, the same graph `index.js` uses) so that a missing
 * dependency injection or a wiring mistake cannot be hidden by a hand-built app.
 * Only two dependencies are replaced:
 *  - the OpenCode SDK client (a stateful fake runtime that keeps per-session
 *    messages, so baselines and delta turns are exercised over real HTTP), and
 *  - the direct upstream base URLs, pointed at a local stub server on port 0.
 *
 * Everything else — config loading, HTTP edge, routes, engine, conversation
 * registry, upstream router — is the production code path.
 */

import request from 'supertest';

import { buildRuntime } from '../../../src/bootstrap.js';
import { loadConfig } from '../../../src/config/index.js';
import { createApp } from '../../../src/app.js';
import { createConversationRegistry } from '../../../src/conversation/registry.js';
import { createResponseChainIndex } from '../../../src/routes/engine.js';
import {
    createDirectUpstream,
    createRuntimeUpstream,
    createUpstreamRouter
} from '../../../src/upstreams/index.js';
import { sleep, startStubServer } from '../modules/fixtures.js';

/** Model catalogs the fake runtime advertises. */
export const DEFAULT_MODELS = {
    opencode: {
        'kimi-k2.5': { name: 'Kimi K2.5' },
        'big-pickle': { name: 'Big Pickle' },
        'mystery-model': { name: 'Mystery Model' },
        'mystery-free': { name: 'Mystery Free' }
    },
    'opencode-go': {
        'glm-5': { name: 'GLM-5' }
    }
};

/**
 * Text of a `session.prompt` call, whatever shape the engine used.
 *
 * @param {any} args Prompt arguments.
 * @returns {string}
 */
export function promptTextOf(args) {
    const parts = args?.body?.parts;
    if (Array.isArray(parts)) {
        return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return typeof args?.body?.prompt === 'string' ? args.body.prompt : '';
}

/**
 * Render a client transcript the way the engine estimates prompt tokens:
 * `<ROLE>: <text>` per deliverable message, joined by a blank line. The
 * estimate is `ceil(rendered.length / 4)` (BEHAVIOUR-SPEC §2).
 *
 * @param {Array<{role?: string, content?: unknown}>} messages Client messages.
 * @returns {string}
 */
export function renderedHistory(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(
            (message) => `${String(message?.role || 'user').toUpperCase()}: ${String(message?.content ?? '')}`
        )
        .join('\n\n');
}

/**
 * A stateful fake OpenCode runtime client.
 *
 * `prompt` appends the user turn and a finished assistant message to the
 * session, so `session.messages` reads back a realistic transcript — that is
 * what makes conversation reuse, baselines and delta turns testable end to end.
 *
 * @param {object} [options]
 * @param {object} [options.models] Provider → model map.
 * @param {string|((args: any, calls: any) => string)} [options.reply] Answer text.
 * @param {string|((args: any, calls: any) => string)|null} [options.reasoning] Reasoning text.
 * @param {(args: any, calls: any) => Error|null} [options.promptError] Fail a prompt.
 * @param {() => AsyncIterable<object>} [options.eventStream] Event source factory.
 * @returns {{client: object, calls: object, sessions: Map<string, object[]>}}
 */
export function createFakeRuntime({
    models = DEFAULT_MODELS,
    reply = 'Runtime answer',
    reasoning = null,
    promptError = null,
    hang = false,
    eventStream = null
} = {}) {
    let counter = 0;
    /** @type {Map<string, object[]>} */
    const sessions = new Map();
    const calls = {
        created: [],
        prompts: [],
        messageReads: [],
        deleted: [],
        subscriptions: 0
    };

    const client = {
        config: {
            providers: async () => ({
                data: {
                    providers: Object.entries(models).map(([id, modelMap]) => ({
                        id,
                        models: modelMap
                    }))
                }
            }),
            get: async () => ({ data: { plugin: [] } }),
            update: async () => ({})
        },
        session: {
            create: async (args) => {
                counter += 1;
                const id = `ses-fake-${counter}`;
                calls.created.push({ args, id });
                sessions.set(id, []);
                return { data: { id } };
            },
            prompt: async (args, options) => {
                calls.prompts.push({ args, options });
                if (hang) return new Promise(() => {});
                const failure = typeof promptError === 'function' ? promptError(args, calls) : null;
                if (failure) throw failure;
                const id = args?.path?.id;
                const list = sessions.get(id) || [];
                const turn = list.length;
                list.push({
                    info: { id: `msg-u${turn}`, role: 'user', sessionID: id },
                    parts: [{ id: `prt-u${turn}`, type: 'text', text: promptTextOf(args) }]
                });
                const parts = [];
                if (reasoning) {
                    parts.push({
                        id: `prt-r${turn}`,
                        type: 'reasoning',
                        text: typeof reasoning === 'function' ? reasoning(args, calls) : reasoning
                    });
                }
                const text = typeof reply === 'function' ? reply(args, calls) : reply;
                if (text) parts.push({ id: `prt-a${turn}`, type: 'text', text });
                list.push({
                    info: {
                        id: `msg-a${turn}`,
                        role: 'assistant',
                        sessionID: id,
                        finish: 'stop',
                        time: { completed: Date.now() }
                    },
                    parts
                });
                sessions.set(id, list);
                return { data: { parts } };
            },
            messages: async (args) => {
                calls.messageReads.push(args);
                return { data: sessions.get(args?.path?.id) || [] };
            },
            delete: async (args) => {
                calls.deleted.push(args);
                sessions.delete(args?.path?.id);
                return {};
            }
        },
        event: {
            subscribe: async () => {
                calls.subscriptions += 1;
                const stream = eventStream
                    ? eventStream({ calls, sessions })
                    : (async function* empty() {})();
                return { stream };
            }
        }
    };

    return { client, calls, sessions };
}

/**
 * Event factory that streams a scripted answer for the session the engine just
 * created. Used by the streaming contract tests.
 *
 * @param {object} [options]
 * @param {string[]} [options.deltas] Answer text deltas.
 * @param {string|null} [options.reasoning] Reasoning delta.
 * @param {boolean} [options.omitFinish] Skip the `finish: stop` snapshot.
 * @param {number} [options.idleTimeoutMs] Overall timeout guard for the factory.
 * @returns {() => AsyncIterable<object>}
 */
export function createEventFactory({
    deltas = ['Streamed ', 'answer'],
    reasoning = null,
    omitFinish = false,
    id = 'msg-stream'
} = {}) {
    return ({ calls }) =>
        (async function* stream() {
            const deadline = Date.now() + 5_000;
            while (calls.created.length === 0 && Date.now() < deadline) await sleep(2);
            const sessionId = calls.created.at(-1)?.id;
            if (!sessionId) throw new Error('fake runtime: no session was created');
            if (reasoning) {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'prt-stream-r', sessionID: sessionId, type: 'reasoning' },
                        delta: reasoning
                    }
                };
            }
            for (const delta of deltas) {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'prt-stream-t', sessionID: sessionId, type: 'text' },
                        delta
                    }
                };
            }
            if (!omitFinish) {
                yield {
                    type: 'message.updated',
                    properties: { info: { id, sessionID: sessionId, finish: 'stop' } }
                };
            }
        })();
}

/** Default direct-upstream stub: a minimal OpenAI-shaped completion. */
export const defaultDirectHandler = (req, res, ctx) => {
    const body = ctx?.body ? JSON.parse(ctx.body) : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
        JSON.stringify({
            id: 'chatcmpl-upstream',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: body.model || 'upstream-model',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'Direct answer' },
                    finish_reason: 'stop'
                }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
    );
};

/**
 * Assemble the production runtime graph over fakes.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env] Environment overrides for `loadConfig`.
 * @param {object} [options.runtime] Options for {@link createFakeRuntime}.
 * @param {(req: any, res: any, ctx: any) => unknown} [options.directHandler] Stub direct handler.
 * @param {any} [options.logger] Logger.
 * @returns {Promise<object>} Harness with `app`, `http` (supertest agent), `fake`,
 *   `stub`, `registry`, `router`, `config` and `close()`.
 */
export async function createAssembly({ env = {}, runtime = {}, directHandler = null, logger = null } = {}) {
    const stub = await startStubServer(directHandler || defaultDirectHandler);
    const config = loadConfig({
        env: {
            OPENCODE_PROXY_DIRECT_GO_URL: `${stub.url}/zen/go/v1`,
            OPENCODE_PROXY_DIRECT_ZEN_URL: `${stub.url}/zen/v1`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '5000',
            OPENCODE_PROXY_SESSION_TTL_MS: '1800000',
            OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS: '2000',
            OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS: '2000',
            ...env
        }
    });
    const fake = createFakeRuntime(runtime);
    const boot = buildRuntime({
        config,
        logger,
        sdk: fake.client,
        fetch: globalThis.fetch,
        ensureBackend: async () => {}
    });

    return {
        config,
        fake,
        stub,
        directRequests: stub.requests,
        ...boot,
        http: request(boot.app),
        close: async () => {
            await stub.close();
        }
    };
}

/**
 * The same production graph as {@link createAssembly}, with one knob overridden:
 * the conversation turn-lock wait (`lockTimeoutMs`). The production value is
 * `REQUEST_TIMEOUT_MS + 60s`, so verifying `503 conversation_busy` (and that a
 * client disconnect releases the lock) needs a short wait to stay fast. Every
 * module is the production one; only the wait budget differs.
 *
 * @param {number} lockTimeoutMs Turn-lock wait in milliseconds.
 * @param {object} [options] Same as {@link createAssembly}.
 * @returns {Promise<object>} Harness.
 */
export async function createAssemblyWithShortLock(
    lockTimeoutMs,
    { env = {}, runtime = {}, directHandler = null } = {}
) {
    const stub = await startStubServer(directHandler || defaultDirectHandler);
    const config = loadConfig({
        env: {
            OPENCODE_PROXY_DIRECT_GO_URL: `${stub.url}/zen/go/v1`,
            OPENCODE_PROXY_DIRECT_ZEN_URL: `${stub.url}/zen/v1`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '5000',
            OPENCODE_PROXY_SESSION_TTL_MS: '1800000',
            OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS: '2000',
            OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS: '2000',
            ...env
        }
    });
    const fake = createFakeRuntime(runtime);
    const rt = createRuntimeUpstream({ config, sdk: fake.client });
    const direct = createDirectUpstream({ config, fetch: globalThis.fetch });
    const responseChains = createResponseChainIndex({
        deleteSession: (sessionId) => rt.deleteSession(sessionId)
    });
    const registry = createConversationRegistry({
        config,
        sessionBackend: rt,
        deleteSession: (sessionId) => rt.deleteSession(sessionId),
        isSessionHeld: (sessionId) => responseChains.isHeld(sessionId),
        lockTimeoutMs
    });
    const router = createUpstreamRouter({ config, direct, runtime: rt, registry });
    const app = createApp({ config, registry, router, responseChains });
    return {
        config,
        fake,
        stub,
        directRequests: stub.requests,
        app,
        runtime: rt,
        direct,
        registry,
        router,
        responseChains,
        http: request(app),
        close: async () => {
            await stub.close();
        }
    };
}

/**
 * Parse an SSE response body into `{ records, data, raw }`.
 *
 * @param {string} body Raw body.
 * @returns {{records: Array<{event: string|null, data: string}>, raw: string}}
 */
export function parseSse(body) {
    const records = [];
    for (const block of String(body).split('\n\n')) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        /** @type {string|null} */
        let event = null;
        const dataLines = [];
        for (const line of trimmed.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (event || dataLines.length) records.push({ event, data: dataLines.join('\n') });
    }
    return { records, raw: String(body) };
}

/** Data-payload records with `[DONE]` removed. */
export const sseJson = (body) =>
    parseSse(body)
        .records.filter((record) => record.data && record.data !== '[DONE]')
        .map((record) => JSON.parse(record.data));

/** True when the stream ended with `data: [DONE]`. */
export const sseHasDone = (body) => /(^|\n)data: \[DONE\]\s*(\n|$)/.test(String(body));
