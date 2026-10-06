/**
 * Conversation store: the tracked conversations, the anchor index behind derived
 * identity, the TTL/LRU caps that bound how many upstream sessions are paid for,
 * and the per-conversation FIFO turn lock. Clock and session closer are injected.
 */

/** Idle conversations are closed after 30 minutes. */
export const DEFAULT_CONVERSATION_TTL_MS = 30 * 60 * 1000;
/**
 * Upper bound on tracked conversations, so a client spraying random session ids
 * cannot make the proxy accumulate (and pay for) unbounded backend sessions.
 */
export const DEFAULT_MAX_CONVERSATION_ENTRIES = 1000;
/**
 * Derived conversations from the same anchor (same scope, same first message) are
 * told apart by their transcript prefix, so a bounded candidate list per anchor
 * is enough to tell one conversation from its look-alikes.
 */
export const DEFAULT_MAX_CONVERSATION_CANDIDATES = 16;
/** Floor for the turn-lock wait when no request timeout is configured. */
export const DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * One tracked conversation.
 *
 * @typedef {object} ConversationEntry
 * @property {string} sessionId          backend session this conversation owns
 * @property {'runtime'|'direct'} mode   which upstream owns it
 * @property {number} sentCount          delivered messages the session holds
 * @property {string|null} sentDigest    rolling digest over those messages
 * @property {string|null} replyDigest   digest of the last answer, for echo disambiguation
 * @property {string|null} startKey      derived-identity anchor, null for header identities
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {number} expiresAt
 */

/**
 * Fields a caller may hand to {@link ConversationStore.put}.
 *
 * @typedef {object} ConversationEntryPatch
 * @property {string} sessionId
 * @property {'runtime'|'direct'} [mode]
 * @property {number} [sentCount]
 * @property {string|null} [sentDigest]
 * @property {string|null} [replyDigest]
 * @property {string|null} [startKey]
 */

/**
 * @typedef {object} ConversationStore
 * @property {() => number} size
 * @property {(key: string|null|undefined) => ConversationEntry|null} get
 * @property {(key: string|null|undefined) => ConversationEntry|null} touch
 * @property {(key: string|null|undefined, patch: ConversationEntryPatch) => ConversationEntry|null} put
 * @property {(key: string|null|undefined) => ConversationEntry|null} drop
 * @property {(key: string|null|undefined) => Promise<ConversationEntry|null>} discard
 * @property {(key: string|null|undefined, entry?: ConversationEntry|null) => Promise<ConversationEntry|null>} evict
 * @property {(startKey: string|null|undefined) => Array<{key: string, entry: ConversationEntry}>} candidatesFor
 * @property {() => Promise<number>} sweep
 * @property {(key: string|null|undefined, timeoutMs?: number) => Promise<(() => void)|null>} acquireLock
 * @property {(key: string|null|undefined) => boolean} isLocked
 */

/**
 * Create an empty conversation store.
 *
 * @param {object} [options]
 * @param {{ now: () => number }} [options.clock] injected time source
 * @param {{ debug?: Function, warn?: Function }|null} [options.logger]
 * @param {number} [options.ttlMs] idle TTL for an entry
 * @param {number} [options.maxEntries] LRU cap over tracked conversations
 * @param {number} [options.maxCandidates] cap over candidates sharing one anchor
 * @param {number} [options.lockTimeoutMs] default bounded wait for a turn lock
 * @param {((sessionId: string, mode: 'runtime'|'direct') => Promise<void>)|null} [options.closeSession]
 *   closer for a session the store no longer tracks; the caller (registry) skips
 *   direct sessions and sessions a live `previous_response_id` chain references.
 * @returns {ConversationStore}
 */
export function createConversationStore({
    clock = { now: () => Date.now() },
    logger = null,
    ttlMs = DEFAULT_CONVERSATION_TTL_MS,
    maxEntries = DEFAULT_MAX_CONVERSATION_ENTRIES,
    maxCandidates = DEFAULT_MAX_CONVERSATION_CANDIDATES,
    lockTimeoutMs = DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS,
    closeSession = null
} = {}) {
    const now = () => Number(clock.now());
    const effectiveTtl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_CONVERSATION_TTL_MS;
    const entryCap = Number(maxEntries) > 0 ? Number(maxEntries) : DEFAULT_MAX_CONVERSATION_ENTRIES;
    const candidateCap =
        Number(maxCandidates) > 0 ? Number(maxCandidates) : DEFAULT_MAX_CONVERSATION_CANDIDATES;
    const defaultLockTimeout =
        Number(lockTimeoutMs) > 0 ? Number(lockTimeoutMs) : DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS;

    /** @type {Map<string, ConversationEntry>} */
    const entries = new Map();
    /** Anchor index: conversation start -> entry keys, oldest first.
     * @type {Map<string, Array<string>>} */
    const index = new Map();
    /** Per-conversation FIFO tail; the lock is held until its tail resolves.
     * @type {Map<string, Promise<unknown>>} */
    const locks = new Map();

    /**
     * @param {ConversationEntry|null|undefined} entry
     * @returns {Promise<void>}
     */
    const closeTrackedSession = async (entry) => {
        if (!entry?.sessionId || !closeSession) return;
        try {
            await closeSession(entry.sessionId, entry.mode || 'runtime');
        } catch (error) {
            logger?.debug?.('Failed to close conversation session', {
                sessionId: entry.sessionId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    };

    /**
     * Fire-and-forget close for the synchronous paths, which must not await.
     *
     * @param {ConversationEntry|null|undefined} entry
     */
    const closeTrackedSessionQuietly = (entry) => {
        void closeTrackedSession(entry);
    };

    /**
     * @param {string|null|undefined} startKey
     * @param {string} key
     */
    const unindex = (startKey, key) => {
        if (!startKey || !key) return;
        const list = index.get(startKey);
        if (!list) return;
        const next = list.filter((candidate) => candidate !== key);
        if (next.length) index.set(startKey, next);
        else index.delete(startKey);
    };

    /**
     * @param {string} startKey
     * @param {string} key
     */
    const indexEntry = (startKey, key) => {
        if (!startKey || !key) return;
        const list = index.get(startKey) || [];
        const next = list.filter((candidate) => candidate !== key);
        next.push(key);
        while (next.length > candidateCap) {
            const dropped = next.shift();
            if (!dropped) break;
            const droppedEntry = entries.get(dropped) || null;
            entries.delete(dropped);
            closeTrackedSessionQuietly(droppedEntry);
        }
        index.set(startKey, next);
    };

    /**
     * Enforce the LRU cap, oldest `lastUsedAt` first. `sweep` never touches a
     * locked conversation, but the hard cap does: with more tracked conversations
     * than the cap allows the cap wins, and the entry is dropped so the next turn
     * of that conversation starts clean.
     */
    const enforceEntryCap = () => {
        if (entries.size <= entryCap) return;
        const overflow = [...entries.entries()]
            .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0))
            .slice(0, entries.size - entryCap);
        for (const [oldKey, oldEntry] of overflow) {
            entries.delete(oldKey);
            unindex(oldEntry.startKey, oldKey);
            closeTrackedSessionQuietly(oldEntry);
        }
    };

    /** @returns {number} */
    const size = () => entries.size;

    /**
     * @param {string|null|undefined} key
     * @returns {ConversationEntry|null}
     */
    const get = (key) => {
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        // A locked conversation is mid-turn: it refreshes its own entry when the turn
        // finishes, so it is never expired out from under the turn.
        if (entry.expiresAt <= now() && !locks.has(key)) {
            entries.delete(key);
            unindex(entry.startKey, key);
            closeTrackedSessionQuietly(entry);
            return null;
        }
        return entry;
    };

    /**
     * Keep an in-flight turn from having its session swept out from under it.
     *
     * @param {string|null|undefined} key
     * @returns {ConversationEntry|null}
     */
    const touch = (key) => {
        const entry = key ? entries.get(key) : null;
        if (!entry) return null;
        const stamp = now();
        entry.lastUsedAt = stamp;
        entry.expiresAt = stamp + effectiveTtl;
        return entry;
    };

    /**
     * Insert or refresh an entry.
     *
     * @param {string|null|undefined} key
     * @param {ConversationEntryPatch} patch
     * @returns {ConversationEntry|null} null when there is nothing to track
     */
    const put = (key, patch) => {
        if (!key || !patch?.sessionId) return null;
        const previous = entries.get(key) || null;
        const stamp = now();
        const startKey = patch.startKey ?? previous?.startKey ?? null;
        if (previous && previous.startKey && previous.startKey !== startKey) {
            unindex(previous.startKey, key);
        }
        /** @type {ConversationEntry} */
        const entry = {
            sessionId: patch.sessionId,
            // A runtime session is closed by sweep/eviction; a direct one is only a
            // header value we invented.
            mode: patch.mode || previous?.mode || 'runtime',
            sentCount: patch.sentCount ?? previous?.sentCount ?? 0,
            sentDigest: patch.sentDigest ?? previous?.sentDigest ?? null,
            replyDigest: patch.replyDigest ?? previous?.replyDigest ?? null,
            startKey,
            createdAt: previous?.createdAt ?? stamp,
            lastUsedAt: stamp,
            expiresAt: stamp + effectiveTtl
        };
        entries.set(key, entry);
        if (startKey) indexEntry(startKey, key);
        enforceEntryCap();
        return entry;
    };

    /**
     * Forget an entry without closing its session.
     *
     * @param {string|null|undefined} key
     * @returns {ConversationEntry|null}
     */
    const drop = (key) => {
        if (!key) return null;
        const entry = entries.get(key) || null;
        entries.delete(key);
        unindex(entry?.startKey, key);
        return entry;
    };

    /**
     * Drop the map entry and close the session it owned.
     *
     * @param {string|null|undefined} key
     * @returns {Promise<ConversationEntry|null>}
     */
    const discard = async (key) => {
        const entry = drop(key);
        await closeTrackedSession(entry);
        return entry;
    };

    /**
     * Evict an entry, closing the session it owned. An entry passed explicitly
     * is closed even when the map no longer holds it.
     *
     * @param {string|null|undefined} key
     * @param {ConversationEntry|null} [entry]
     * @returns {Promise<ConversationEntry|null>}
     */
    const evict = async (key, entry = null) => {
        if (!key) return null;
        const current = entries.get(key) || entry || null;
        const dropped = drop(key);
        await closeTrackedSession(dropped || current);
        return current;
    };

    /**
     * Live candidates sharing an anchor, pruning the expired ones on the way.
     *
     * @param {string|null|undefined} startKey
     * @returns {Array<{key: string, entry: ConversationEntry}>}
     */
    const candidatesFor = (startKey) => {
        if (!startKey) return [];
        const list = index.get(startKey) || [];
        /** @type {Array<{key: string, entry: ConversationEntry}>} */
        const live = [];
        const stamp = now();
        for (const key of list) {
            const entry = entries.get(key);
            if (!entry) continue;
            if (entry.expiresAt <= stamp) {
                entries.delete(key);
                unindex(entry.startKey, key);
                closeTrackedSessionQuietly(entry);
                continue;
            }
            live.push({ key, entry });
        }
        return live;
    };

    /**
     * Close every expired conversation that is not currently locked. A turn in
     * flight refreshes its entry only when it finishes, so a locked
     * conversation is never swept.
     *
     * @returns {Promise<number>} how many entries were dropped
     */
    const sweep = async () => {
        const stamp = now();
        const expired = [...entries.entries()].filter(
            ([key, entry]) => entry.expiresAt <= stamp && !locks.has(key)
        );
        for (const [key, entry] of expired) {
            entries.delete(key);
            unindex(entry.startKey, key);
            await closeTrackedSession(entry);
        }
        return expired.length;
    };

    /**
     * FIFO turn lock per conversation: two turns must never prompt the same
     * backend session at once, while different conversations run in parallel. A
     * waiter gives up after `timeoutMs` and gets `null` (the caller reports
     * `503 conversation_busy`), but keeps its place in the queue so the queue
     * keeps draining.
     *
     * @param {string|null|undefined} key
     * @param {number} [timeoutMs] non-positive waits indefinitely
     * @returns {Promise<(() => void)|null>} the release function, or null on timeout
     */
    const acquireLock = async (key, timeoutMs = defaultLockTimeout) => {
        if (!key) return () => {};
        const previous = locks.get(key) || Promise.resolve();
        /** @type {() => void} */
        let open = () => {};
        const gate = new Promise((resolve) => {
            open = () => resolve(undefined);
        });
        const tail = previous.then(() => gate);
        locks.set(key, tail);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            open();
            if (locks.get(key) === tail) locks.delete(key);
        };

        const budget = Number(timeoutMs);
        const timedOut = await new Promise((resolve) => {
            let settled = false;
            const timer =
                budget > 0
                    ? setTimeout(() => {
                          settled = true;
                          resolve(true);
                      }, budget)
                    : null;
            if (timer && typeof timer.unref === 'function') timer.unref();
            previous.then(() => {
                if (settled) return;
                if (timer) clearTimeout(timer);
                resolve(false);
            });
        });
        if (timedOut) {
            previous.then(() => release());
            return null;
        }
        return release;
    };

    /** @param {string|null|undefined} key */
    const isLocked = (key) => {
        if (!key) return false;
        return locks.has(key);
    };

    return {
        size,
        get,
        touch,
        put,
        drop,
        discard,
        evict,
        candidatesFor,
        sweep,
        acquireLock,
        isLocked
    };
}
