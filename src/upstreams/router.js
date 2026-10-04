import { newSessionId } from './direct-client.js';
import { resolveLogger, toBool } from './support.js';

/**
 * Upstream router.
 *
 * Decides, per turn, whether the request goes to the direct upstream (OpenCode's
 * own OpenAI-compatible endpoints) or to the local runtime, resolves the
 * conversation turn (and with it the per-conversation lock), and owns the one
 * piece of routing state that has to be learned at runtime: a model the direct
 * upstream refuses with `403 FreeTierError` is remembered as runtime-only for an
 * hour, because that refusal is a property of the model, not of the request.
 *
 * Routing rules (stable, mirrored in `docs/{zh,en}/api-reference.md`):
 *
 * | model | upstream |
 * |:--|:--|
 * | `opencode-go/*` | direct → `zen/go/v1` |
 * | paid `opencode/*` | direct → `zen/v1` |
 * | `opencode/*-free`, learned free-tier models | runtime |
 * | no upstream key configured | runtime |
 *
 * @typedef {object} PlanDescriptor
 * @property {string} providerID Resolved provider id.
 * @property {string} modelID Resolved bare model id.
 * @property {object} [headers] Client request headers (conversation identity).
 * @property {object} [deliverable] Deliverable body of the turn.
 * @property {string} [toolMode] Tool mode of the turn.
 * @property {string} [toolsFingerprint] Tool-list fingerprint of the turn.
 * @property {object} [scope] Identity scope (from the HTTP edge).
 * @property {string|null} [previousSessionId] Session referenced by
 *   `previous_response_id`, when the client used it.
 * @property {string|null} [clientAddress] Socket address, when the caller has one.
 *
 * @typedef {object} TurnPlanResult
 * @property {'direct'|'runtime'} mode Chosen upstream.
 * @property {string} reason Human-readable reason, for logs.
 * @property {object} turn Result of `registry.resolveTurn(...)`; the
 *   per-conversation lock is already held through `turn.release`.
 * @property {string|null} sessionId Session to reuse, or `null` when the caller
 *   must create one (runtime path).
 * @property {boolean} busy True when the turn lock could not be taken; the
 *   caller must answer `503 conversation_busy` instead of using the turn.
 */

/** Why the router chose an upstream; also the `fallback()` reason vocabulary. */
export const PLAN_REASON = Object.freeze({
    DIRECT: 'direct',
    DIRECT_DISABLED: 'direct-disabled',
    NO_UPSTREAM_KEY: 'no-upstream-key',
    PROVIDER_NOT_DIRECT: 'provider-not-direct',
    FREE_TIER_MODEL: 'free-tier-model',
    FREE_TIER_LEARNED: 'free-tier-learned'
});

/** Reasons accepted by {@link createUpstreamRouter} `fallback()`. */
export const FALLBACK_REASON = Object.freeze({
    FREE_TIER: 'free-tier',
    AUTH: 'auth',
    TRANSPORT: 'transport'
});

/** How long a learned runtime-only model stays remembered: 1 hour. @type {number} */
export const RUNTIME_ONLY_TTL_MS = 60 * 60 * 1000;

/** Free-tier Zen models say so in their name. @param {string} modelID @returns {boolean} */
export const isFreeTierModelId = (modelID) => /-free$/i.test(String(modelID || ''));

/**
 * TTL map of models the direct upstream refused for free-tier reasons.
 *
 * Kept separate from the router so tests can drive the clock and so the state
 * survives a router rebuild if the caller keeps the tracker.
 *
 * @param {object} [options] Tracker options.
 * @param {number} [options.ttlMs] Learning lifetime.
 * @param {() => number} [options.clock] Clock, injectable for tests.
 * @returns {{
 *   remember: (providerID: string, modelID: string) => void,
 *   has: (providerID: string, modelID: string) => boolean,
 *   forget: (providerID: string, modelID: string) => void,
 *   clear: () => void,
 *   size: () => number
 * }} Tracker.
 */
export function createRuntimeOnlyTracker({ ttlMs = RUNTIME_ONLY_TTL_MS, clock = Date.now } = {}) {
    /** @type {Map<string, number>} key -> expiry timestamp */
    const entries = new Map();
    /**
     * @param {string} providerID Provider id.
     * @param {string} modelID Bare model id.
     * @returns {string} Tracker key.
     */
    const keyFor = (providerID, modelID) => `${providerID}/${modelID}`;

    return {
        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         */
        remember(providerID, modelID) {
            if (!providerID || !modelID) return;
            entries.set(keyFor(providerID, modelID), clock() + ttlMs);
        },
        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         * @returns {boolean} True while the model is still remembered.
         */
        has(providerID, modelID) {
            const expiresAt = entries.get(keyFor(providerID, modelID));
            if (!expiresAt) return false;
            if (expiresAt <= clock()) {
                entries.delete(keyFor(providerID, modelID));
                return false;
            }
            return true;
        },
        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         */
        forget(providerID, modelID) {
            entries.delete(keyFor(providerID, modelID));
        },
        /** Drop every learned model. */
        clear() {
            entries.clear();
        },
        /** @returns {number} Number of remembered models. */
        size() {
            return entries.size;
        }
    };
}

/**
 * Create the upstream router.
 *
 * @param {object} options Router options.
 * @param {Record<string, any>} [options.config] Config with environment-style keys
 *   (`DIRECT_ENABLED`, `DIRECT_FREE_VIA_RUNTIME`, `DIRECT_FALLBACK_TO_RUNTIME`,
 *   `ZEN_API_KEY`).
 * @param {any} [options.logger] Logger dependency.
 * @param {any} options.direct Direct upstream (`createDirectUpstream`).
 * @param {any} options.runtime Runtime upstream (`createRuntimeUpstream`).
 * @param {any} [options.catalog] Model catalog, when the layer above
 *   needs one; unused for routing, accepted for wiring symmetry.
 * @param {any} options.registry Conversation registry (must expose
 *   `resolveTurn` and optionally `discard`).
 * @param {any} [options.tracker] Runtime-only tracker, default a new one.
 * @returns {object} Router with `plan`, `fallback`, `shouldUseDirect` and
 *   inspection helpers.
 */
export function createUpstreamRouter(
    {
        config = {},
        logger = null,
        direct,
        runtime,
        catalog = null,
        registry,
        tracker = createRuntimeOnlyTracker()
    } = /** @type {any} */ ({})
) {
    const log = resolveLogger(logger, 'upstreams/router');
    if (!registry || typeof registry.resolveTurn !== 'function') {
        throw new Error('createUpstreamRouter requires a conversation registry with resolveTurn');
    }
    const directEnabled = toBool(config.DIRECT_ENABLED) ?? true;
    const freeViaRuntime = toBool(config.DIRECT_FREE_VIA_RUNTIME) ?? true;
    const fallbackToRuntime = toBool(config.DIRECT_FALLBACK_TO_RUNTIME) ?? true;
    const hasUpstreamKey = () => {
        if (direct && typeof direct.hasCredentials === 'function') return Boolean(direct.hasCredentials());
        return Boolean(String(config.ZEN_API_KEY || ''));
    };
    /**
     * @param {string} providerID Provider id.
     * @returns {boolean} True when the provider has a direct endpoint.
     */
    const supportsProvider = (providerID) => {
        if (direct && typeof direct.supports === 'function') return Boolean(direct.supports(providerID));
        const id = String(providerID || '').toLowerCase();
        return id === 'opencode' || id === 'opencode-go';
    };

    /**
     * Decide the upstream for one model without touching the conversation state.
     *
     * @param {string} providerID Provider id.
     * @param {string} modelID Bare model id.
     * @returns {{direct: boolean, reason: string}} Decision plus its reason.
     */
    const shouldUseDirect = (providerID, modelID) => {
        if (!directEnabled) return { direct: false, reason: PLAN_REASON.DIRECT_DISABLED };
        if (!hasUpstreamKey()) return { direct: false, reason: PLAN_REASON.NO_UPSTREAM_KEY };
        if (!supportsProvider(providerID)) return { direct: false, reason: PLAN_REASON.PROVIDER_NOT_DIRECT };
        // Free-tier Zen models can only be served by the runtime.
        if (freeViaRuntime && String(providerID).toLowerCase() === 'opencode' && isFreeTierModelId(modelID)) {
            return { direct: false, reason: PLAN_REASON.FREE_TIER_MODEL };
        }
        if (tracker.has(providerID, modelID)) return { direct: false, reason: PLAN_REASON.FREE_TIER_LEARNED };
        return { direct: true, reason: PLAN_REASON.DIRECT };
    };

    return {
        /**
         * Plan one turn: choose the upstream, resolve the conversation turn and
         * derive the session id to use.
         *
         * The registry resolution takes the per-conversation turn lock, so `plan()`
         * is async. The caller owns `turn.release` and MUST call it in a `finally`
         * block, and must check `busy` before using `sessionId`: when the lock could
         * not be taken the turn is refused with `conversation_busy`.
         *
         * `previousSessionId` is only forwarded to the registry for runtime turns.
         * A direct turn must not be pinned: the id belongs to the upstream
         * (`previous_response_id` is relayed as-is) and there is no runtime session
         * state to snapshot, so pinning it would force a baseline read the direct
         * path never needs — and fail the turn with `session_state_unavailable`
         * before the upstream is even called (ARCHITECTURE §2: `baseline` is `null`
         * in direct mode).
         *
         * @param {PlanDescriptor} descriptor Turn descriptor.
         * @returns {Promise<TurnPlanResult>} Mode, reason, turn and session id.
         */
        async plan(descriptor) {
            const {
                providerID,
                modelID,
                headers,
                deliverable,
                toolMode,
                toolsFingerprint,
                scope,
                previousSessionId,
                clientAddress
            } = descriptor;
            const decision = shouldUseDirect(providerID, modelID);
            const mode = decision.direct ? 'direct' : 'runtime';
            const turn = await registry.resolveTurn({
                headers,
                scope,
                deliverable,
                ...(mode === 'runtime' && previousSessionId !== undefined && { previousSessionId }),
                ...(clientAddress !== undefined && { clientAddress }),
                ...(toolMode !== undefined && { toolMode }),
                ...(toolsFingerprint !== undefined && { toolsFingerprint })
            });
            // Annotate the turn so `fallback()` can act on it without a second lookup.
            if (turn && typeof turn === 'object') {
                turn.mode = mode;
                turn.providerID = providerID;
                turn.modelID = modelID;
            }
            // The registry already decided between reusing an entry's session and
            // starting fresh; direct turns additionally carry their own conversation
            // identity (nothing to create upstream), runtime turns need a session the
            // caller creates when the conversation does not have one yet.
            const existingSessionId = turn?.sessionId || null;
            const sessionId = mode === 'direct' ? existingSessionId || newSessionId() : existingSessionId;
            log.debug('Upstream planned', {
                providerID,
                modelID,
                mode,
                reason: decision.reason,
                sessionId,
                busy: turn?.busy === true
            });
            return { mode, reason: decision.reason, turn, sessionId, busy: turn?.busy === true };
        },

        /**
         * Record the outcome of a failed direct attempt.
         *
         * A free-tier refusal is remembered for an hour; in every case the direct
         * session mapping is dropped so the retry (or the next turn) starts on the
         * runtime instead of reusing a session the direct upstream never saw.
         *
         * Session state is dropped asynchronously (the registry closes what it owns),
         * but this stays fire-and-forget so the caller can relay the upstream error
         * without waiting.
         *
         * @param {any} turn Turn returned by `plan()`.
         * @param {string} reason `'free-tier'`, `'auth'` or `'transport'`
         *   (`direct.classify()` returns the first two).
         * @returns {void}
         */
        fallback(turn, reason) {
            const normalized = String(reason || '').toLowerCase();
            const isFreeTier = normalized === FALLBACK_REASON.FREE_TIER || /free.?tier/.test(normalized);
            if (isFreeTier && turn?.providerID && turn?.modelID) {
                tracker.remember(turn.providerID, turn.modelID);
                log.warn('Model refused by the direct upstream is now runtime-only', {
                    providerID: turn.providerID,
                    modelID: turn.modelID
                });
            }
            // Direct sessions exist only as a client-side identity, so dropping the
            // entry cannot leak an upstream session.
            if (turn?.mode === 'direct' && turn?.key && typeof registry.discard === 'function') {
                Promise.resolve(registry.discard({ key: turn.key })).catch((error) => {
                    log.debug('Failed to drop direct session state after fallback', {
                        error: error.message
                    });
                });
                log.debug('Dropped direct session state after fallback', { reason: normalized });
            }
        },

        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         * @returns {{direct: boolean, reason: string}} Routing decision.
         */
        shouldUseDirect,

        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         * @returns {boolean} True while the model is learned runtime-only.
         */
        isRuntimeOnly: (providerID, modelID) => tracker.has(providerID, modelID),

        /**
         * @param {string} providerID Provider id.
         * @param {string} modelID Bare model id.
         */
        rememberRuntimeOnly: (providerID, modelID) => tracker.remember(providerID, modelID),

        /** @returns {boolean} Whether `DIRECT_FALLBACK_TO_RUNTIME` allows falling back. */
        allowsFallback: () => fallbackToRuntime,

        /** @returns {boolean} Whether direct mode may be used at all. */
        isDirectEnabled: () => hasUpstreamKey(),

        /** @returns {object|null} The model catalog passed in at construction. */
        catalog,

        /** @returns {object} The runtime upstream, for the layer that drives turns. */
        runtime,

        /** @returns {object} The direct upstream, for the layer that drives turns. */
        direct,

        /** @returns {object} The runtime-only tracker. */
        tracker
    };
}
