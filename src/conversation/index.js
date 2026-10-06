/**
 * Public surface of the conversation layer: `createConversationRegistry` is the
 * wired entry point, the other exports are pure building blocks kept public for
 * isolated testing.
 */

export { createConversationRegistry, resolveConversationSettings, normalizeBool } from './registry.js';

export {
    readHeaderIdentity,
    deriveIdentity,
    matchDerivedEntry,
    conversationKeyFor,
    conversationScopeFor,
    derivedScopeFor,
    normalizeHeaderNames,
    normalizeHeaders,
    DEFAULT_CONVERSATION_HEADER_NAMES,
    IDENTITY_PREVIEW_LENGTH
} from './identity.js';

export {
    planConversationTurn,
    planRotationTurn,
    planPinnedTurn,
    prefixDigest,
    deliverableMessages,
    hasDeliverablePromptContent,
    canonicalMessageFingerprint,
    canonicalize,
    hashMessage,
    replyDigestFor,
    toolsFingerprintFor,
    PREFIX_DIGEST_SEED
} from './planner.js';

export {
    createConversationStore,
    DEFAULT_CONVERSATION_TTL_MS,
    DEFAULT_MAX_CONVERSATION_ENTRIES,
    DEFAULT_MAX_CONVERSATION_CANDIDATES,
    DEFAULT_CONVERSATION_LOCK_TIMEOUT_MS
} from './store.js';

export {
    snapshotSessionState,
    assertBaseline,
    isBaselineUnavailable,
    BaselineUnavailableError,
    SESSION_STATE_UNAVAILABLE
} from './baseline.js';
