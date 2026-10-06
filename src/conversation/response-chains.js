/**
 * Stateful `previous_response_id` chain index: response id → runtime session, so
 * Responses API clients can continue without resending history, and the
 * conversation store does not delete a session a live chain still owns.
 *
 * @module conversation/response-chains
 */

/**
 * Create a response-chain index.
 *
 * @param {object} [options] Index options.
 * @param {() => number} [options.clock] Clock, injectable for tests.
 * @param {number} [options.ttlMs] Entry lifetime in milliseconds.
 * @param {(sessionId: string) => Promise<void>} [options.deleteSession] Closer for
 *   expired sessions that nothing else references.
 * @param {any} [options.logger] Logger dependency.
 * @returns {{
 *     get: (responseId: string) => ({sessionId: string, model: string|undefined}|null),
 *     store: (responseId: string, sessionId: string, model?: string) => void,
 *     isHeld: (sessionId: string) => boolean,
 *     sweep: () => Promise<void>,
 *     size: () => number
 * }} The index.
 */
export function createResponseChainIndex({
    clock = () => Date.now(),
    ttlMs = 30 * 60 * 1000,
    deleteSession = async () => {},
    logger = null
} = {}) {
    /** @type {Map<string, {sessionId: string, model: string|undefined, expiresAt: number}>} */
    const entries = new Map();

    /**
     * @param {string} responseId Response id.
     * @returns {{sessionId: string, model: string|undefined}|null} Live entry, or null when absent/expired.
     */
    const get = (responseId) => {
        const state = entries.get(responseId);
        if (!state) return null;
        if (state.expiresAt <= clock()) {
            entries.delete(responseId);
            return null;
        }
        return state;
    };

    return {
        get,
        /**
         * @param {string} responseId Response id.
         * @param {string} sessionId Session that produced it.
         * @param {string} [model] Model name.
         * @returns {void}
         */
        store(responseId, sessionId, model) {
            if (!responseId || !sessionId) return;
            entries.set(responseId, { sessionId, model, expiresAt: clock() + ttlMs });
        },
        /**
         * @param {string} sessionId Session id.
         * @returns {boolean} True while a live chain references the session.
         */
        isHeld(sessionId) {
            if (!sessionId) return false;
            for (const [id, state] of entries.entries()) {
                if (state.expiresAt <= clock()) {
                    entries.delete(id);
                    continue;
                }
                if (state.sessionId === sessionId) return true;
            }
            return false;
        },
        /**
         * Drop expired entries and close the sessions nothing references any more.
         *
         * @returns {Promise<void>}
         */
        async sweep() {
            const now = clock();
            const expired = [];
            for (const [id, state] of entries.entries()) {
                if (state.expiresAt <= now) {
                    expired.push(state);
                    entries.delete(id);
                }
            }
            if (!expired.length) return;
            for (const state of expired) {
                if (
                    entries.size &&
                    [...entries.values()].some((live) => live.sessionId === state.sessionId)
                ) {
                    continue;
                }
                try {
                    await deleteSession(state.sessionId);
                } catch (error) {
                    logger?.debug?.('Failed to delete expired response session', {
                        sessionId: state.sessionId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
        },
        /** @returns {number} Number of tracked chains. */
        size() {
            return entries.size;
        }
    };
}
