/**
 * Verification fixtures, shared by the contract and module suites.
 *
 * Nothing here is imported from `tests/unit/**`: the unit helpers, clocks and
 * assertions are not reused, so a shared blind spot in the unit suite cannot
 * hide a defect from these tests.
 */

import http from 'node:http';

import { createConversationRegistry } from '../../../src/conversation/index.js';

/** Milliseconds helper that never leaves a live timer behind. */
export const sleep = (ms) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
    });

/**
 * A manual clock. Tests drive it exactly, so TTL/cache assertions never depend
 * on wall-clock time.
 *
 * @param {number} [start] Starting epoch milliseconds.
 * @returns {{now: () => number, advance: (ms: number) => number, set: (value: number) => number}}
 */
export function createFakeClock(start = 1_700_000_000_000) {
    let value = start;
    return {
        now: () => value,
        advance: (ms) => {
            value += Number(ms);
            return value;
        },
        set: (next) => {
            value = Number(next);
            return value;
        }
    };
}

/** @returns {{role: string, content: string}} */
export const userText = (text, extra = {}) => ({ role: 'user', content: text, ...extra });
/** @returns {{role: string, content: string}} */
export const assistantText = (text, extra = {}) => ({ role: 'assistant', content: text, ...extra });
/** @returns {{role: string, content: string}} */
export const systemText = (text) => ({ role: 'system', content: text });

/**
 * One OpenCode-shaped session message.
 *
 * @param {string} id Message id.
 * @param {string} role Role.
 * @param {Array<{id?: string, [key: string]: unknown}>} [parts] Message parts.
 * @param {Record<string, unknown>} [info] Extra message info (finish, error, ...).
 */
export const sessionMessage = (id, role, parts = [], info = {}) => ({
    info: { id, role, ...info },
    parts
});

/**
 * Fake runtime session reader. Steps are consumed in order; the last step is
 * reused forever, so `[new Error('boom')]` means "always fails".
 *
 * @param {Array<unknown>} steps Each step: a value to resolve with, an Error to
 *   throw, or a function `(sessionId, callNumber) => value|Promise<value>`.
 * @returns {{calls: string[], messages: (sessionId: string) => Promise<unknown>}}
 */
export function scriptedSessionBackend(steps) {
    const calls = [];
    let index = 0;
    return {
        calls,
        async messages(sessionId) {
            calls.push(sessionId);
            const position = Math.min(index, Math.max(0, steps.length - 1));
            index += 1;
            const step = steps[position];
            if (step instanceof Error) throw step;
            if (typeof step === 'function') return step(sessionId, calls.length);
            return step;
        }
    };
}

/**
 * Start a local HTTP server on port 0.
 *
 * The handler receives `(req, res, context)`; `context.body` is the fully read
 * request body and `context.requests` accumulates every request.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, ctx: {body: string, requests: Array<object>}) => unknown} handler
 * @returns {Promise<{port: number, url: string, requests: Array<object>, close: () => Promise<void>}>}
 */
export async function startStubServer(handler) {
    /** @type {Array<object>} */
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const record = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body
            };
            requests.push(record);
            try {
                if (handler) {
                    // A provided handler fully owns the response.
                    Promise.resolve(handler(req, res, { body, requests })).catch((error) => {
                        if (!res.headersSent) res.statusCode = 500;
                        res.end(String(error?.stack || error));
                    });
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{}');
            } catch (error) {
                if (!res.headersSent) res.statusCode = 500;
                res.end(String(error?.stack || error));
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        async close() {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

/**
 * Write an SSE response, optionally splitting each record across TCP writes so
 * a consumer that does not handle boundaries correctly fails visibly.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Array<string>} records Raw records (each includes its own newlines).
 * @param {{split?: boolean, pauseMs?: number}} [options]
 */
export async function writeSse(res, records, { split = false, pauseMs = 1 } = {}) {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
    });
    for (const record of records) {
        if (split && record.length > 4) {
            const cut = Math.floor(record.length / 2);
            res.write(record.slice(0, cut));
            await sleep(pauseMs);
            res.write(record.slice(cut));
            await sleep(pauseMs);
        } else {
            res.write(record);
            await sleep(pauseMs);
        }
    }
    res.end();
}

/** Read a fetch Response body as UTF-8 text. */
export const readBody = async (response) => await response.text();

/**
 * A fake OpenCode SDK client for `pollForAssistantResponse` / `collectFromEvents`.
 *
 * @param {object} [options]
 * @param {() => Array<object>} [options.messages] Messages for `session.messages`.
 * @param {() => AsyncIterable<object>|Array<object>} [options.events] Event source.
 * @returns {object} Fake client with `session.messages` and `event.subscribe`.
 */
export function fakeSdkClient({ messages = () => [], events = () => [] } = {}) {
    return {
        session: {
            messages: async () => messages()
        },
        event: {
            subscribe: async () => {
                const source = events();
                return {
                    stream: (async function* stream() {
                        for await (const event of source) yield event;
                    })()
                };
            }
        }
    };
}

/**
 * Wire the real conversation registry to the fake clock and spies.
 *
 * @param {object} [options]
 * @param {object} [options.clock] Fake clock.
 * @param {object|null} [options.sessionBackend] Fake session reader.
 * @param {object} [options.config] Env-shaped config overrides.
 * @param {number} [options.lockTimeoutMs] Turn-lock wait.
 * @param {Set<string>} [options.held] Session ids a live response chain holds.
 * @returns {{registry: object, clock: object, closed: string[], held: Set<string>, putSession: (key: string, sessionId: string, plan: object, extra?: object) => object|null}}
 */
export function createRegistryHarness({
    clock = createFakeClock(),
    sessionBackend = null,
    config = {},
    lockTimeoutMs = 200,
    held = new Set(),
    logger = null
} = {}) {
    /** @type {string[]} */
    const closed = [];
    const registry = createConversationRegistry({
        config: {
            REQUEST_TIMEOUT_MS: 5_000,
            SESSION_TTL_MS: 30 * 60 * 1000,
            ...config
        },
        clock,
        logger,
        sessionBackend,
        deleteSession: async (sessionId) => {
            closed.push(sessionId);
        },
        isSessionHeld: (sessionId) => held.has(sessionId),
        lockTimeoutMs
    });
    return { registry, clock, closed, held };
}
