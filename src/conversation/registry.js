/**
 * Conversation registry — the module's public surface.
 *
 * Ties identity, store, planner and baseline together behind the interface
 * frozen in `docs/ARCHITECTURE.md` §2:
 *
 * ```js
 * createConversationRegistry({ config, logger, clock }) -> Registry
 * Registry.resolveTurn({ headers, scope, deliverable, previousSessionId })
 * Registry.storeTurn({ key, sessionId, mode, plan, replyText, startKey })
 * Registry.discard({ key })
 * Registry.sweep()
 * ```
 *
 * Everything it needs from the outside world (time, the session reader used for
 * baselines, the session closer, the live response chains) is injected, so no
 * HTTP or SDK knowledge lives here.
 */

import {
    readHeaderIdentity,
    deriveIdentity,
    conversationKeyFor,
    matchDerivedEntry,
    normalizeHeaderNames
} from './identity.js';
import { planConversationTurn, planPinnedTurn, replyDigestFor } from './planner.js';
import {
    DEFAULT_CONVERSATION_TTL_MS,
    DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS,
    createConversationStore
} from './store.js';
import { snapshotSessionState } from './baseline.js';

/**
 * Coerce the loose truthiness the gateway accepts from env vars and config
 * files. Returns undefined for values that carry no signal, so callers can fall
 * back to their default.
 *
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
export function normalizeBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return undefined;
}

/**
 * @typedef {object} ConversationSettings
 * @property {boolean} reuseEnabled
 * @property {boolean} deriveEnabled
 * @property {number} ttlMs
 * @property {Array<string>} headerNames
 * @property {number} lockTimeoutMs
 */

/**
 * Resolve the conversation knobs out of a gateway config object (the env-var
 * shaped config `loadConfig` produces). Keeps today's names and defaults.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {ConversationSettings}
 */
export function resolveConversationSettings(config = {}) {
    const reuseEnabled = normalizeBool(config.SESSION_REUSE_ENABLED) ?? true;
    // Opt-in: with no session header the conversation has to be inferred from
    // the request itself, which cannot be as precise as an explicit id.
    const deriveEnabled = reuseEnabled && (normalizeBool(config.SESSION_DERIVE_ENABLED) ?? false);
    const configuredTtl = Number(config.SESSION_TTL_MS);
    const requestTimeout = Number(config.REQUEST_TIMEOUT_MS);
    return {
        reuseEnabled,
        deriveEnabled,
        ttlMs: configuredTtl > 0 ? configuredTtl : DEFAULT_CONVERSATION_TTL_MS,
        headerNames: normalizeHeaderNames(config.SESSION_HEADER_NAMES),
        // A turn may legitimately run up to REQUEST_TIMEOUT_MS, so allow that
        // plus margin before a queued turn gives up.
        lockTimeoutMs: requestTimeout > 0 ? requestTimeout + 60_000 : DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS
    };
}

/**
 * What a caller gets back from {@link Registry.resolveTurn}. `release` is
 * always callable and MUST be called in a `finally` block; check `busy` (or
 * `plan === null`) before using the turn.
 *
 * @typedef {object} ResolvedTurn
 * @property {import('./identity.js').ConversationIdentity} identity
 * @property {string|null} key
 * @property {import('./store.js').ConversationEntry|null} entry
 * @property {import('./planner.js').TurnPlan|null} plan
 * @property {import('./baseline.js').SessionBaseline|null} baseline
 * @property {string|null} sessionId   pinned session, or the entry's session
 * @property {boolean} busy            true when the turn lock could not be taken
 * @property {() => void} release
 */

/**
 * @typedef {object} Registry
 * @property {(params: {headers?: unknown, scope?: string, deliverable?: Array<object>, previousSessionId?: string|null, clientAddress?: string|null}) => Promise<ResolvedTurn>} resolveTurn
 * @property {(params: {key?: string|null, sessionId?: string|null, mode?: 'runtime'|'direct', plan?: import('./planner.js').TurnPlan|null, replyText?: string|null, startKey?: string|null}) => import('./store.js').ConversationEntry|null} storeTurn
 * @property {(params: {key?: string|null}) => Promise<import('./store.js').ConversationEntry|null>} discard
 * @property {() => Promise<number>} sweep
 * @property {ConversationSettings} settings
 */

/**
 * Create a conversation registry.
 *
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.config] env-shaped gateway config
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }|null} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 * @param {import('./baseline.js').SessionBackend|null} [options.sessionBackend]
 *   reader used for baselines (`session.messages(id)` on the runtime client)
 * @param {((sessionId: string) => Promise<void>)|null} [options.deleteSession]
 *   closes an upstream session the registry no longer tracks
 * @param {((sessionId: string) => boolean)|null} [options.isSessionHeld]
 *   true while a live `previous_response_id` chain references that session
 * @param {number|null} [options.lockTimeoutMs] override the configured turn-lock
 *   wait (tests and callers that resolve it themselves)
 * @returns {Registry}
 */
export function createConversationRegistry({
    config = {},
    logger = null,
    clock = { now: () => Date.now() },
    sessionBackend = null,
    deleteSession = null,
    isSessionHeld = null,
    lockTimeoutMs = null
} = {}) {
    const settings = resolveConversationSettings(config);
    const lockWaitMs = Number(lockTimeoutMs) > 0 ? Number(lockTimeoutMs) : settings.lockTimeoutMs;

    const store = createConversationStore({
        clock,
        logger,
        ttlMs: settings.ttlMs,
        lockTimeoutMs: lockWaitMs,
        /**
         * A session the registry no longer tracks is closed — except a direct
         * session (nothing upstream to close) and a session a live
         * `previous_response_id` chain still references.
         *
         * @param {string} sessionId
         * @param {'runtime'|'direct'} mode
         */
        closeSession: async (sessionId, mode) => {
            if (!sessionId) return;
            if (mode === 'direct') return;
            if (isSessionHeld?.(sessionId)) {
                logger?.debug?.('Keeping session referenced by a response chain', { sessionId });
                return;
            }
            if (!deleteSession) return;
            await deleteSession(sessionId);
        }
    });

    /**
     * Resolve the conversation, take its turn lock, plan the delta and snapshot
     * the state of a session that already holds earlier turns.
     *
     * @param {object} params
     * @param {unknown} [params.headers] raw request headers
     * @param {string} [params.scope] model/tool/mode scope (see conversationScopeFor)
     * @param {Array<object>} [params.deliverable] non-system messages, in order
     * @param {string|null} [params.previousSessionId] session pinned by a response chain
     * @param {string|null} [params.clientAddress] socket address, when the caller has one
     * @returns {Promise<ResolvedTurn>}
     */
    const resolveTurn = async ({
        headers = {},
        scope = '',
        deliverable = [],
        previousSessionId = null,
        clientAddress = null
    } = {}) => {
        const messages = Array.isArray(deliverable) ? deliverable : [];
        // An explicit session header always wins; without one, and only when
        // derivation is enabled, the conversation is recognised from its content.
        const headerIdentity = readHeaderIdentity({
            headers,
            headerNames: settings.headerNames,
            enabled: settings.reuseEnabled
        });
        const derivedIdentity = headerIdentity
            ? null
            : deriveIdentity({
                  headers,
                  scope,
                  deliverable: messages,
                  enabled: settings.deriveEnabled,
                  clientAddress
              });
        const identity = headerIdentity ||
            derivedIdentity || {
                source: 'none',
                header: null,
                value: null,
                preview: '',
                startKey: null,
                entryKey: null
            };

        let key = null;
        /** @type {import('./store.js').ConversationEntry|null} */
        let entry = null;
        if (headerIdentity) {
            key = conversationKeyFor(headerIdentity, scope);
            entry = store.get(key);
        } else if (derivedIdentity?.startKey) {
            const candidates = store.candidatesFor(derivedIdentity.startKey);
            const found = matchDerivedEntry({ deliverable: messages, candidates });
            if (found) {
                key = found.key;
                entry = found.entry;
                store.touch(key);
            } else {
                // Fresh key per conversation; the lookup hands back the key of
                // the conversation it recognised instead.
                key = derivedIdentity.entryKey;
                if (candidates.length) {
                    logger?.debug?.('Derived conversation is ambiguous, starting a new session', {
                        candidates: candidates.length
                    });
                }
            }
        }

        // Held for the whole turn, so a concurrent turn on the same conversation
        // cannot use the same upstream session.
        const lock = await store.acquireLock(key, lockWaitMs);
        if (key && !lock) {
            logger?.warn?.('Conversation is busy with another request', { key });
            return {
                identity,
                key,
                entry: null,
                plan: null,
                baseline: null,
                sessionId: null,
                busy: true,
                release: () => {}
            };
        }

        // Now that the turn owns the conversation, re-read what the store holds:
        // a concurrent turn may have rotated or dropped the entry while this one
        // was queued, and reusing a session that is already gone would fail the
        // turn. A fresh key never has an entry, so this is a no-op for it.
        if (key) {
            const current = store.get(key);
            if (!current) entry = null;
            else if (!entry || current.sessionId !== entry.sessionId) entry = current;
        }

        const plan = previousSessionId ? planPinnedTurn(messages) : planConversationTurn(entry, messages);
        // A rotation (`reuse: false` with an entry present) needs a brand-new
        // session, so the entry's session is deliberately not handed back.
        const sessionId = previousSessionId || (plan.reuse ? entry?.sessionId || null : null);
        // A session that already holds earlier turns needs its existing ids
        // recorded, or polling would report the previous answer as this turn's.
        // A direct session is only a label we invent — upstream has no state to
        // read — and a direct turn relays the upstream response verbatim, so no
        // baseline is required (or possible) for it.
        const needsBaseline = plan.reuse && (Boolean(previousSessionId) || entry?.mode !== 'direct');
        const baseline = needsBaseline
            ? await snapshotSessionState({ sessionId, sessionBackend, logger })
            : null;

        return {
            identity,
            key,
            entry,
            plan,
            baseline,
            sessionId,
            busy: false,
            release: lock || (() => {})
        };
    };

    /**
     * Register the session a planned turn ended up using, so the next turn of
     * that conversation can reuse it. A no-op for a turn with no conversation
     * key and for a pinned (previous_response_id) turn: that session belongs to
     * the response chain, not to this map.
     *
     * @param {object} params
     * @param {string|null} [params.key]
     * @param {string|null} [params.sessionId]
     * @param {'runtime'|'direct'} [params.mode]
     * @param {import('./planner.js').TurnPlan|null} [params.plan]
     * @param {string|null} [params.replyText]
     * @param {string|null} [params.startKey]
     * @returns {import('./store.js').ConversationEntry|null}
     */
    const storeTurn = ({
        key = null,
        sessionId = null,
        mode = 'runtime',
        plan = null,
        replyText = null,
        startKey = null
    } = {}) => {
        if (!key || !sessionId || !plan || plan.pinned) return null;
        return store.put(key, {
            sessionId,
            mode,
            sentCount: plan.sentCount,
            sentDigest: plan.sentDigest,
            replyDigest: replyDigestFor(replyText),
            startKey: startKey || null
        });
    };

    /**
     * Drop a conversation and close the session it owned.
     *
     * @param {object} params
     * @param {string|null} [params.key]
     * @returns {Promise<import('./store.js').ConversationEntry|null>}
     */
    const discard = async ({ key = null } = {}) => store.discard(key);

    /** TTL + size caps. @returns {Promise<number>} */
    const sweep = () => store.sweep();

    return { resolveTurn, storeTurn, discard, sweep, settings };
}
