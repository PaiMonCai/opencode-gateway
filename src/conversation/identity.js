/**
 * Conversation identity: explicit (a session identity header the client or the
 * gateway in front of us sets) or implicit (inferred from the request content).
 * Reads plain header maps only — never `req`/`res`, never an upstream.
 */

import crypto from 'node:crypto';

import { canonicalMessageFingerprint, hashMessage, prefixDigest } from './planner.js';

/**
 * Header spellings accepted as a conversation identity, most specific first: the
 * first non-empty value wins. `x-opencode-session` leads deliberately — it is the
 * identity the operator configures on the gateway side, and a client-supplied
 * `session-id` must not displace it. The full value keys the conversation
 * (truncating would alias two distinct long ids); only the log preview is cut.
 *
 * The 11 names are frozen; `SESSION_HEADER_NAMES` narrows or reorders them. See
 * `docs/BEHAVIOUR-SPEC.md` §1, `docs/zh/configuration.md` and
 * `docs/{zh,en}/api-reference.md`.
 *
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_CONVERSATION_HEADER_NAMES = Object.freeze([
    'x-opencode-session',
    'x-session-id',
    'x-thread-id',
    'x-conversation-id',
    'x-deepseek-harness-session-id',
    'session-id',
    'session_id',
    'thread-id',
    'thread_id',
    'conversation-id',
    'conversation_id'
]);

/** Maximum length of a logged identity preview. */
export const IDENTITY_PREVIEW_LENGTH = 64;

/**
 * @typedef {object} ConversationIdentity
 * @property {'header'|'derived'|'none'} source
 * @property {string|null} header     header name, `'derived'`, or null for `none`
 * @property {string|null} value      full header value (header identities only)
 * @property {string} preview         short, log-safe rendering
 * @property {string|null} startKey   anchor key (derived identities only)
 * @property {string|null} entryKey   candidate key for a fresh derived conversation
 */

/**
 * A stored conversation candidate, as handed over by the store.
 *
 * @typedef {object} ConversationCandidate
 * @property {string} key
 * @property {import('./store.js').ConversationEntry} entry
 */

/**
 * Lowercase header names, trim, drop empties, deduplicate. Accepts the
 * comma-separated env form as well as an array, and falls back to the default
 * list when the configured list carries nothing usable.
 *
 * @param {unknown} names configured header names
 * @returns {Array<string>}
 */
export function normalizeHeaderNames(names) {
    const list = typeof names === 'string' ? names.split(',') : Array.isArray(names) ? names : [];
    const configured = list
        .map((name) =>
            String(name ?? '')
                .trim()
                .toLowerCase()
        )
        .filter(Boolean);
    return [...new Set(configured.length ? configured : DEFAULT_CONVERSATION_HEADER_NAMES)];
}

/**
 * Normalize a header map to lowercase, single string values. A header that
 * arrived repeated (array) keeps its first entry, which is what a session
 * identity means.
 *
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
export function normalizeHeaders(headers) {
    /** @type {Record<string, string>} */
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [rawName, rawValue] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
        const name = String(rawName).toLowerCase();
        const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (typeof value === 'string') out[name] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') out[name] = String(value);
    }
    return out;
}

/**
 * Read the explicit conversation identity from the request headers.
 *
 * @param {object} params
 * @param {unknown} params.headers raw header map
 * @param {unknown} [params.headerNames] configured names (defaults applied)
 * @param {boolean} [params.enabled] false when session reuse is disabled
 * @returns {ConversationIdentity|null} null when no header carries a value
 */
export function readHeaderIdentity({ headers, headerNames, enabled = true }) {
    if (!enabled) return null;
    const source = normalizeHeaders(headers);
    for (const name of normalizeHeaderNames(headerNames)) {
        const value = source[name];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        return {
            source: 'header',
            header: name,
            value: trimmed,
            preview: trimmed.slice(0, IDENTITY_PREVIEW_LENGTH),
            startKey: null,
            entryKey: null
        };
    }
    return null;
}

/**
 * Scope a derived conversation is isolated by: the gateway's own address and
 * credential are all we have to tell one client from another, so both take part,
 * together with the model, tool policy and mode already in `scope`.
 *
 * @param {object} params
 * @param {unknown} params.headers raw header map
 * @param {string} params.scope  model/tool/mode scope from {@link conversationScopeFor}
 * @param {string|null} [params.clientAddress] socket address when the caller has one
 * @returns {string}
 */
export function derivedScopeFor({ headers, scope, clientAddress = null }) {
    const source = normalizeHeaders(headers);
    const authorization = String(source.authorization || '');
    const forwarded = String(source['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
    const address = forwarded || clientAddress || String(source['x-real-ip'] || '');
    return [
        String(scope || ''),
        crypto.createHash('sha256').update(authorization).digest('hex').slice(0, 32),
        address
    ].join('\u0000');
}

/**
 * Derive a conversation identity from the request content: an anchor (client
 * scope + the first delivered message) plus a fresh candidate key, which only
 * survives when the lookup recognises no existing conversation.
 *
 * @param {object} params
 * @param {unknown} params.headers
 * @param {string} params.scope
 * @param {Array<object>} params.deliverable non-system messages, in order
 * @param {boolean} [params.enabled] true only when derivation is switched on
 * @param {string|null} [params.clientAddress]
 * @returns {ConversationIdentity|null} null when derivation is off or there is
 *   nothing to anchor on
 */
export function deriveIdentity({ headers, scope, deliverable, enabled = false, clientAddress = null }) {
    const messages = Array.isArray(deliverable) ? deliverable : [];
    if (!enabled || !messages.length) return null;
    const anchor = canonicalMessageFingerprint(messages[0]);
    const startKey = crypto
        .createHash('sha256')
        .update(`${derivedScopeFor({ headers, scope, clientAddress })}\u0000${anchor}`)
        .digest('hex');
    return {
        source: 'derived',
        header: 'derived',
        value: null,
        preview: '(derived)',
        startKey,
        // Fresh enough to be unique; only used when the lookup recognises nothing.
        entryKey: `derived:${crypto.randomUUID()}`
    };
}

/**
 * Stable key for an explicitly addressed conversation.
 *
 * @param {ConversationIdentity} identity
 * @param {string} scope
 * @returns {string|null} null when the identity is not header based
 */
export function conversationKeyFor(identity, scope) {
    if (!identity || identity.source !== 'header' || !identity.value) return null;
    return crypto
        .createHash('sha256')
        .update(`${identity.header}\u0000${identity.value}\u0000${String(scope || '')}`)
        .digest('hex');
}

/**
 * Scope of a conversation: everything that changes what the backend session must
 * contain, computed from request input only so it can be resolved before choosing
 * the upstream. `mode` takes part because a direct session is only a label we
 * invent while a runtime session is a real upstream object.
 *
 * @param {object} params
 * @param {string} params.providerID
 * @param {string} params.modelID
 * @param {string|null} [params.toolMode]
 * @param {string|null} [params.toolFingerprint]
 * @param {'direct'|'runtime'|string|null} [params.mode]
 * @returns {string}
 */
export function conversationScopeFor({
    providerID,
    modelID,
    toolMode = null,
    toolFingerprint = null,
    mode = null
}) {
    return [
        `${providerID}/${modelID}`,
        `mode:${toolMode || 'unknown'}`,
        toolFingerprint || '-',
        `upstream:${mode || 'unknown'}`
    ].join('\u0000');
}

/**
 * Recognise an existing derived conversation among the candidates sharing an
 * anchor. Returns null when nothing matches, or when several candidates match
 * equally well: refusing is the only safe answer, because merging two clients'
 * histories is a data leak. Identical prefixes are told apart by the answer the
 * client echoes back.
 *
 * @param {object} params
 * @param {Array<object>} params.deliverable non-system messages, in order
 * @param {Array<ConversationCandidate>} params.candidates live candidates for the anchor
 * @returns {ConversationCandidate|null}
 */
export function matchDerivedEntry({ deliverable, candidates }) {
    const messages = Array.isArray(deliverable) ? deliverable : [];
    const list = Array.isArray(candidates) ? candidates : [];
    /** @type {Array<ConversationCandidate>} */
    const matches = [];
    for (const candidate of list) {
        const { key, entry } = candidate || {};
        if (!key || !entry) continue;
        if (messages.length <= entry.sentCount) continue;
        if (prefixDigest(messages, entry.sentCount) !== entry.sentDigest) continue;
        matches.push({ key, entry });
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];

    const byReply = matches.filter(({ entry }) => {
        const echoed = /** @type {Record<string, any>|undefined} */ (messages[entry.sentCount]);
        return (
            Boolean(entry.replyDigest) &&
            Boolean(echoed) &&
            hashMessage({ role: 'assistant', content: echoed?.content ?? '' }) === entry.replyDigest
        );
    });
    if (byReply.length === 1) return byReply[0];
    return null;
}
