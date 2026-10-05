/**
 * Public surface of the conversation layer.
 *
 * `createConversationRegistry` is the entry point wired into the application;
 * the other exports are the pure building blocks, kept public so each can be
 * tested in isolation.
 */

export {
    createConversationRegistry,
    resolveConversationSettings,
    normalizeBool
} from './registry.js';

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
