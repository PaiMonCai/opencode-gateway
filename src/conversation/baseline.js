/**
 * Session baseline.
 *
 * A reused backend session already holds the earlier turns. Polling and event
 * collection must ignore the message/part ids that existed before the turn
 * started, or the previous answer gets reported as this turn's. The baseline is
 * exactly that set of pre-existing ids.
 *
 * Reading it is best-effort by nature, but *not* optional: a turn that cannot
 * read its baseline fails closed (`503 session_state_unavailable`) instead of
 * falling back to unfiltered polling.
 */

/** Error code the HTTP layer maps to a `503` for a failed baseline read. */
export const SESSION_STATE_UNAVAILABLE = 'session_state_unavailable';

/**
 * Thrown when a turn needs a baseline and none could be read.
 */
export class BaselineUnavailableError extends Error {
    /**
     * @param {string} [message]
     */
    constructor(message = 'Could not read the session state for this conversation; retry the request') {
        super(message);
        this.name = 'BaselineUnavailableError';
        this.statusCode = 503;
        this.code = SESSION_STATE_UNAVAILABLE;
        this.type = SESSION_STATE_UNAVAILABLE;
    }
}

/**
 * @typedef {object} SessionBaseline
 * @property {boolean} ok             false when the state could not be read
 * @property {Set<string>} messageIds message ids that already existed
 * @property {Set<string>} partIds    part ids that already existed
 */

/**
 * A minimal read-only view of a backend session. The runtime client implements
 * it; tests provide a fake.
 *
 * @typedef {object} SessionBackend
 * @property {(sessionId: string) => Promise<Array<{info?: {id?: string}, parts?: Array<{id?: string}>}>|{data?: unknown}>} messages
 */

/** @returns {SessionBaseline} */
const emptyBaseline = () => ({ ok: true, messageIds: new Set(), partIds: new Set() });

/**
 * Collect the ids a session already holds.
 *
 * One retry: a transient read failure must not silently downgrade this to "no
 * baseline", which would let the previous turn be reported as the current
 * answer. When both attempts fail the result is `ok: false` with empty sets —
 * callers must fail the turn, never poll unfiltered.
 *
 * @param {object} params
 * @param {string|null|undefined} params.sessionId
 * @param {SessionBackend|null} [params.sessionBackend]
 * @param {{ debug?: Function, warn?: Function }|null} [params.logger]
 * @param {number} [params.maxAttempts] attempts before giving up (default 2)
 * @returns {Promise<SessionBaseline>}
 */
export async function snapshotSessionState({
    sessionId,
    sessionBackend = null,
    logger = null,
    maxAttempts = 2
}) {
    /** @type {SessionBaseline} */
    const result = emptyBaseline();
    if (!sessionId) return result;
    const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 2));
    // One retry: a transient read failure must not silently downgrade this to
    // "no baseline", which would let the previous turn be reported as the
    // current answer (the whole point of the snapshot).
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            if (!sessionBackend || typeof sessionBackend.messages !== 'function') {
                throw new Error('no session backend available');
            }
            const response = await sessionBackend.messages(sessionId);
            // The runtime client wraps reads in `{ data }`; tests hand back the
            // list directly.
            const raw = /** @type {any} */ (response);
            const messages = raw?.data || raw || [];
            if (!Array.isArray(messages)) throw new Error('unexpected message list shape');
            result.messageIds.clear();
            result.partIds.clear();
            for (const entry of messages) {
                if (entry?.info?.id) result.messageIds.add(entry.info.id);
                for (const part of entry?.parts || []) {
                    if (part?.id) result.partIds.add(part.id);
                }
            }
            return result;
        } catch (error) {
            logger?.debug?.('Failed to snapshot session state', {
                sessionId,
                attempt,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    result.ok = false;
    result.messageIds.clear();
    result.partIds.clear();
    return result;
}

/**
 * Fail closed when a required baseline is missing.
 *
 * @param {SessionBaseline|null|undefined} baseline
 * @returns {SessionBaseline} the same baseline when it is usable
 * @throws {BaselineUnavailableError} when it is not
 */
export function assertBaseline(baseline) {
    if (!baseline || baseline.ok !== true) throw new BaselineUnavailableError();
    return baseline;
}

/**
 * True when a baseline was required and could not be read.
 *
 * @param {SessionBaseline|null|undefined} baseline
 * @returns {boolean}
 */
export function isBaselineUnavailable(baseline) {
    return baseline != null && baseline.ok === false;
}
