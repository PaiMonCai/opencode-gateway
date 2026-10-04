/**
 * Turn planner.
 *
 * The OpenAI surface is stateless: every request carries the whole transcript,
 * while a backend session already holds the turns the proxy sent earlier. This
 * module decides, for one turn, whether that session may be reused and which
 * slice of the transcript still has to be sent.
 *
 * Pure logic only: no HTTP, no SDK, no clock. The only inputs are the stored
 * entry and the delivered messages, so the same call always yields the same
 * plan.
 */

import crypto from 'node:crypto';

/**
 * @typedef {import('./store.js').ConversationEntry} ConversationEntry
 */

/**
 * A plan for one turn, always describing what a *fresh* session would need so
 * every rotation path can reuse it unchanged.
 *
 * - `reuse` — the stored session already holds `sentCount` delivered turns;
 * - `rewrite` — an entry existed but could not be reused (rewritten history);
 * - `pinned` — the turn continues a `previous_response_id` chain: the session
 *   is fixed by the caller and MUST NOT be re-registered via `storeTurn`;
 * - `rotation` — produced by `planRotationTurn` after a retry/failure rotated
 *   the session, so `delta` is deliberately the full history;
 * - `delta` — the non-system messages to send to the backend;
 * - `deltaStartIndex` — index of `delta[0]` inside the delivered transcript;
 * - `sentCount` — how many delivered messages the session holds afterwards;
 * - `sentDigest` — rolling digest over those `sentCount` messages.
 *
 * @typedef {object} TurnPlan
 * @property {boolean} reuse
 * @property {boolean} rewrite
 * @property {boolean} pinned
 * @property {boolean} rotation
 * @property {Array<object>} delta
 * @property {number} deltaStartIndex
 * @property {number} sentCount
 * @property {string} sentDigest
 */

/**
 * Observation hooks for planning. Logging only: options never change the plan.
 *
 * @typedef {object} PlannerOptions
 * @property {{ debug?: Function, warn?: Function }|null} [logger]
 * @property {string|null} [sessionId] session the plan is computed for
 */

/** Seed of the rolling prefix digest, so it can never collide with a bare hash. */
export const PREFIX_DIGEST_SEED = 'opencode-gateway-conversation';

/**
 * Deep, key-order independent copy of a JSON-ish value. Two messages that carry
 * the same data always serialize to the same string, whatever order their keys
 * arrive in, which is what keeps a digest from churning the session.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item));
    if (value && typeof value === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalize(/** @type {Record<string, unknown>} */ (value)[key]);
        }
        return out;
    }
    return value;
}

/**
 * Stable fingerprint of one client message. The proxy ignores plenty of fields
 * and clients do not promise a key order, so only the fields that change what
 * the backend sees take part, and they are canonicalized.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function canonicalMessageFingerprint(message) {
    if (!message || typeof message !== 'object') return JSON.stringify(message ?? null);
    const source = /** @type {Record<string, any>} */ (message);
    /** @type {Record<string, unknown>} */
    const canonical = {
        role: String(source.role || 'user').toLowerCase(),
        name: source.name ?? null,
        content: canonicalize(source.content ?? null),
        tool_call_id: source.tool_call_id ?? null
    };
    if (Array.isArray(source.tool_calls)) {
        canonical.tool_calls = canonicalize(
            source.tool_calls.map((toolCall) => ({
                id: toolCall?.id ?? null,
                name: toolCall?.function?.name ?? toolCall?.name ?? null,
                arguments: toolCall?.function?.arguments ?? toolCall?.arguments ?? null
            }))
        );
    }
    return JSON.stringify(canonical);
}

/**
 * SHA-256 of {@link canonicalMessageFingerprint}.
 *
 * @param {unknown} message
 * @returns {string} hex digest
 */
export function hashMessage(message) {
    return crypto.createHash('sha256').update(canonicalMessageFingerprint(message)).digest('hex');
}

/**
 * Rolling digest over the first `count` delivered messages. Comparing it with
 * the stored digest detects an edit, reorder, or truncation anywhere in the
 * prefix — a tail-only hash would let an edited earlier turn through.
 *
 * @param {Array<unknown>} messages
 * @param {number} count
 * @returns {string} hex digest
 */
export function prefixDigest(messages, count) {
    const list = Array.isArray(messages) ? messages : [];
    const limit = Math.max(0, Math.min(Number(count) || 0, list.length));
    let digest = crypto.createHash('sha256').update(PREFIX_DIGEST_SEED).digest('hex');
    for (let i = 0; i < limit; i += 1) {
        digest = crypto
            .createHash('sha256')
            .update(`${digest}\u0000${hashMessage(list[i])}`)
            .digest('hex');
    }
    return digest;
}

/**
 * System messages are rebuilt and re-sent on every turn, so they are not part
 * of the conversation a backend session accumulates.
 *
 * @param {unknown} messages
 * @returns {Array<object>} the non-system messages, in order
 */
export function deliverableMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter(
        (message) => String(message?.role || 'user').toLowerCase() !== 'system'
    );
}

/**
 * Fingerprint of the tool contract a request carries (names + choice mode).
 * The tool policy rides in the session title and is fixed when the session is
 * created, so two turns with different tool sets must not share a session.
 *
 * @param {unknown} tools
 * @param {unknown} toolChoice
 * @returns {string} `-` when the request carries no tools
 */
export function toolsFingerprintFor(tools, toolChoice) {
    const names = (Array.isArray(tools) ? tools : [])
        .map((tool) => tool?.function?.name || tool?.name || tool?.type || '')
        .filter(Boolean)
        .sort();
    if (!names.length) return '-';
    const choiceSource = /** @type {Record<string, any>|null|undefined} */ (toolChoice);
    const choice =
        typeof toolChoice === 'string'
            ? toolChoice
            : choiceSource?.type ||
              (choiceSource?.function?.name ? `forced:${choiceSource.function.name}` : '');
    return crypto
        .createHash('sha256')
        .update(`${names.join(',')}\u0000${choice}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Digest of the answer a session produced for its last turn. It is what tells
 * two look-alike derived conversations apart when the client echoes the answer
 * back.
 *
 * @param {unknown} replyText
 * @returns {string|null} null when the answer carried no text
 */
export function replyDigestFor(replyText) {
    return typeof replyText === 'string' ? hashMessage({ role: 'assistant', content: replyText }) : null;
}

/**
 * Short, log-safe rendering of an assistant message's content.
 *
 * @param {unknown} content
 * @param {number} [length]
 * @returns {string}
 */
function previewOf(content, length = 40) {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return String(text ?? '').slice(0, length);
}

/**
 * Report an echoed assistant message that does not match the answer the session
 * actually produced. The echo is still skipped — that is the documented
 * behaviour, and normal clients replay our own text — but a mismatch means a
 * client injected an assistant message the model never produced, which silently
 * disappears from the upstream context. Debug-level observation only.
 *
 * @param {ConversationEntry} entry
 * @param {Record<string, any>|undefined} message skipped assistant message
 * @param {number} index            index inside the delivered transcript
 * @param {PlannerOptions} options
 */
function reportEchoMismatch(entry, message, index, options) {
    const logger = options.logger;
    if (!entry.replyDigest || !logger?.debug) return;
    const observed = hashMessage({ role: 'assistant', content: message?.content ?? '' });
    if (observed === entry.replyDigest) return;
    logger.debug('Skipped an echoed assistant turn that does not match the session answer', {
        sessionId: options.sessionId ?? entry.sessionId ?? null,
        messageIndex: index,
        matches: false,
        expected: entry.replyDigest,
        observed,
        preview: previewOf(message?.content)
    });
}

/**
 * Plan the turn against an existing entry.
 *
 * Reuse is only safe when the client's non-system history extends exactly what
 * was already delivered: `delta` is then only the appended turns. Any other
 * shape means the client rewrote the conversation, so the plan is the one a
 * fresh session needs — the full history.
 *
 * @param {ConversationEntry|null|undefined} entry
 * @param {Array<object>} deliverable non-system messages, in order
 * @param {PlannerOptions} [options] observation hooks (logging only)
 * @returns {TurnPlan}
 */
export function planConversationTurn(entry, deliverable, options = {}) {
    const messages = Array.isArray(deliverable) ? deliverable : [];
    /** @type {TurnPlan} */
    const fresh = {
        reuse: false,
        rewrite: Boolean(entry),
        pinned: false,
        rotation: false,
        delta: messages,
        deltaStartIndex: 0,
        sentCount: messages.length,
        sentDigest: prefixDigest(messages, messages.length)
    };
    if (!entry || !entry.sentCount) return fresh;
    // Nothing new to append (equal length) means the client replayed the same
    // history, and prompting an empty turn would fail: start clean instead.
    if (messages.length <= entry.sentCount) return fresh;
    // Any edit, reorder, or truncation inside the delivered prefix invalidates
    // the session, not just a change to its last message.
    if (prefixDigest(messages, entry.sentCount) !== entry.sentDigest) return fresh;

    const rawDelta = /** @type {Array<Record<string, any>>} */ (messages.slice(entry.sentCount));
    // Clients echo the previous assistant turn back in the history, and the
    // backend session already produced it. Sending it again would duplicate
    // the answer inside the context, so skip the echoed turns. A delta that is
    // nothing but echoes carries no new instruction: rotate and send the whole
    // history instead of re-appending the echo.
    let echoed = 0;
    while (echoed < rawDelta.length && String(rawDelta[echoed]?.role || '').toLowerCase() === 'assistant') {
        reportEchoMismatch(entry, rawDelta[echoed], entry.sentCount + echoed, options);
        echoed += 1;
    }
    if (echoed === rawDelta.length) return fresh;

    return {
        reuse: true,
        rewrite: false,
        pinned: false,
        rotation: false,
        delta: rawDelta.slice(echoed),
        deltaStartIndex: entry.sentCount + echoed,
        sentCount: messages.length,
        sentDigest: fresh.sentDigest
    };
}

/**
 * Plan for a turn that rotates to a brand-new session — a retry after a failed
 * turn, or any caller that decided the old session is not reusable. The new
 * session holds nothing, so the full history must be sent.
 *
 * @param {Array<object>} deliverable non-system messages, in order
 * @returns {TurnPlan}
 */
export function planRotationTurn(deliverable) {
    return { ...planConversationTurn(null, deliverable), rotation: true };
}

/**
 * Plan for a turn pinned to a session the caller owns (`previous_response_id`).
 * The session already holds earlier turns, so the whole turn is sent from index
 * 0 and the baseline filter is required; `pinned` keeps the turn from being
 * registered as a tracked conversation entry.
 *
 * @param {Array<object>} deliverable non-system messages, in order
 * @returns {TurnPlan}
 */
export function planPinnedTurn(deliverable) {
    const messages = Array.isArray(deliverable) ? deliverable : [];
    return {
        reuse: true,
        rewrite: false,
        pinned: true,
        rotation: false,
        delta: messages,
        deltaStartIndex: 0,
        sentCount: messages.length,
        sentDigest: prefixDigest(messages, messages.length)
    };
}
