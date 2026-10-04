/**
 * Shared fakes for the conversation unit tests: a clock we control and a
 * session backend that behaves like the runtime's session store.
 *
 * Kept out of the `*.test.js` files so Jest does not treat it as a suite.
 */

/**
 * Deterministic time source.
 *
 * @param {number} [start]
 * @returns {{ now: () => number, advance: (ms: number) => number, set: (value: number) => number }}
 */
export function createFakeClock(start = 1_700_000_000_000) {
    let current = start;
    return {
        now: () => current,
        advance(ms) {
            current += ms;
            return current;
        },
        set(value) {
            current = value;
            return current;
        }
    };
}

/**
 * Minimal read-only session backend, shaped like `client.session.messages`.
 *
 * @param {Record<string, Array<{info?: {id?: string, role?: string}, parts?: Array<{id?: string, text?: string}>}>>} [initial]
 * @returns {{
 *   sessions: Map<string, Array<object>>,
 *   reads: Array<string>,
 *   failNextReads: number,
 *   failures: number,
 *   messages: (sessionId: string) => Promise<Array<object>>
 * }}
 */
export function createFakeSessionBackend(initial = {}) {
    const sessions = new Map(Object.entries(initial));
    return {
        sessions,
        reads: [],
        failNextReads: 0,
        failures: 0,
        async messages(sessionId) {
            this.reads.push(sessionId);
            if (this.failNextReads > 0) {
                this.failNextReads -= 1;
                this.failures += 1;
                throw new Error('session read failed');
            }
            return (sessions.get(sessionId) || []).map((entry) => ({
                info: { ...(entry.info || {}) },
                parts: [...(entry.parts || [])]
            }));
        }
    };
}

/**
 * A closable session backend recorder: records every delete, optionally holds
 * some ids open to model a live `previous_response_id` chain.
 *
 * @returns {{
 *   deleted: Array<string>,
 *   held: Set<string>,
 *   deleteSession: (sessionId: string) => Promise<void>,
 *   isSessionHeld: (sessionId: string) => boolean
 * }}
 */
export function createFakeCloser() {
    const deleted = [];
    const held = new Set();
    return {
        deleted,
        held,
        async deleteSession(sessionId) {
            deleted.push(sessionId);
        },
        isSessionHeld(sessionId) {
            return held.has(sessionId);
        }
    };
}

/**
 * A captured logger, so tests can assert what was reported without printing.
 *
 * @returns {{ records: Array<{level: string, message: string, fields: unknown}>, debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createFakeLogger() {
    const records = [];
    const record = (level) => (message, fields) => {
        records.push({ level, message, fields });
    };
    return {
        records,
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error')
    };
}

/** Two client turns (user, assistant, user) with distinguishable content. */
export const SAMPLE_TURNS = Object.freeze([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' }
]);

/**
 * Let fire-and-forget work (session closes scheduled from synchronous paths)
 * run before asserting on it.
 *
 * @returns {Promise<void>}
 */
export const settleAsyncWork = () => new Promise((resolve) => setImmediate(resolve));
