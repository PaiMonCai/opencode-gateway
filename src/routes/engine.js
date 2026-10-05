/**
 * OpenAI-surface turn engine.
 *
 * The engine owns everything a turn needs after the HTTP edge has parsed the
 * request: model resolution, the text-contract tool bridge, prompt assembly, the
 * runtime/direct upstream turn, retries, usage estimates, the `previous_response_id`
 * continuation flow and the streaming writers for both API shapes.
 *
 * `src/routes/{chat,responses,health,models}.js` are the route surfaces: they
 * parse, call an engine method and write the response. `src/app.js` installs the
 * HTTP edge and mounts them; `src/server.js` owns the process and the managed
 * backend. The conversation lifecycle is `src/conversation`, the upstreams are
 * `src/upstreams`, the tool contract is `src/tools`.
 *
 * @module routes/engine
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTransientUpstreamError } from '../errors/index.js';
import { createTurnLimiter } from '../concurrency/turn-limiter.js';
import { createOperationalSurface } from './operations.js';
import { createModelResolver } from './model-resolver.js';
import { createResponseChainIndex } from '../conversation/response-chains.js';
import { createStorageCleanup } from '../conversation/storage-cleanup.js';
import {
    conversationScopeFor as scopedConversationKey,
    deliverableMessages as deliverableConversationMessages,
    snapshotSessionState as conversationBaseline,
    toolsFingerprintFor
} from '../conversation/index.js';
import { newSessionId } from '../upstreams/direct-client.js';
import { createDirectTurnRunner } from './direct-turn.js';
import { createChatStreamWriter } from './streaming/chat-writer.js';
import {
    buildResponsesFunctionCallOutputItem,
    buildResponsesMessageOutputItem,
    createResponsesStreamWriter
} from './streaming/responses-writer.js';
import { writeResponsesFailure } from './streaming/sse.js';
import {
    EXTERNAL_TOOL_PREFIX,
    buildExternalToolRegistry,
    buildToolExposure,
    buildForcedToolCallPrompt,
    createExternalToolCallStreamParser,
    createToolCallFilter,
    evaluateToolPolicy,
    findExternalToolByName,
    parseExternalToolCallsFromText,
    stripFunctionCallMarkup,
    validateToolCalls
} from '../tools/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tool policy a turn runs under. The values mirror
 * {@link TOOL_MODE} below and travel through every resolver.
 *
 * @typedef {'disabled'|'external-bridge'|'internal-allowlist'} ToolMode
 */

/**
 * An error as the engine sees it: a normal `Error` carrying the optional
 * provider-shaped fields the monolith read straight off the thrown value.
 *
 * @typedef {Error & {statusCode?: number, code?: string, type?: string, availableModels?: string[]}} UpstreamErrorLike
 */

/**
 * Status and body {@link transformUpstreamError} maps a failure onto.
 *
 * @typedef {object} TransformedUpstreamError
 * @property {number} statusCode HTTP status to answer with.
 * @property {{message: string, type: string, code?: string, available_models?: string[]}} error
 *   OpenAI-compatible error body.
 */

/**
 * The turn the upstream router records when a direct request fails and the
 * runtime takes over.
 *
 * @typedef {object} FallbackTurn
 * @property {string} providerID Resolved provider id.
 * @property {string} modelID Resolved bare model id.
 * @property {string|null} key Conversation key the turn belongs to.
 * @property {'direct'|'runtime'} mode Upstream the turn was to run on.
 */

/**
 * One Responses-API item as a client sends it: a message, a function call, a
 * function-call output or a tool result. Every field is optional because the
 * engine narrows on `type` before reading them.
 *
 * @typedef {object} ResponsesItem
 * @property {string} [type] Item kind.
 * @property {string} [role] Message role.
 * @property {unknown} [content] Message or tool-result content.
 * @property {unknown} [output] Tool output.
 * @property {unknown} [result] Tool result.
 * @property {string} [text] Flat text.
 * @property {string} [name] Tool name.
 * @property {string} [call_id] Call id.
 * @property {string} [tool_call_id] Call id in the chat shape.
 * @property {string} [id] Item id.
 * @property {ResponsesItem[]} [tool_calls] Calls an assistant item carries.
 * @property {string|Record<string, unknown>} [arguments] Flat arguments.
 * @property {{name?: string, arguments?: string}} [function] Function payload.
 */

/**
 * The assistant message the chat surface returns.
 *
 * @typedef {object} AssistantMessageOut
 * @property {string} role Role, always `assistant`.
 * @property {string|null|undefined} content Answer text.
 * @property {string} [reasoning_content] Reasoning text.
 * @property {import('../tools/contract.js').WireToolCall[]} [tool_calls] Calls the model asked for.
 */

/**
 * The runtime's prompt result as the responses path reads it.
 *
 * @typedef {object} PromptResultLike
 * @property {{parts?: Array<{type?: string, text?: string}>, message?: string}} [data] SDK payload.
 */

/**
 * What `buildPromptParts` renders one client transcript into.
 *
 * @typedef {object} PromptParts
 * @property {Array<Record<string, unknown>>} parts Parts to send as the prompt.
 * @property {string} system System prompt rebuilt from the whole history.
 * @property {string} fullPromptText History rendered as plain text, for digests.
 * @property {string} lastUserMsg Last user message, for logging.
 */

/**
 * {@link import('../tools/parser.js').ToolCallFilter} with the `flush()` the
 * factory always attaches; the published typedef omits it.
 *
 * @typedef {import('../tools/parser.js').ToolCallFilter & {flush: () => string}} ToolCallFilterWithFlush
 */

/**
 * {@link import('../tools/parser.js').ExternalToolCallStreamParser} with the
 * `flush()` the factory always attaches; the published typedef omits it.
 *
 * @typedef {import('../tools/parser.js').ExternalToolCallStreamParser & {flush: () => import('../tools/contract.js').WireToolCall[]}} ExternalToolCallParserWithFlush
 */

/**
 * One content part of a {@link ChatMessage}.
 *
 * @typedef {object} ChatMessagePart
 * @property {string} [type] Part kind (`text`, `image_url`, `input_text`, ...).
 * @property {string} [text] Text payload, for text parts.
 * @property {string|{url?: string}} [image_url] Image URL or its OpenAI wrapper.
 */

/**
 * A tool call in the OpenAI wire shape, as clients and models emit it.
 *
 * @typedef {object} ToolCall
 * @property {string} [id] Call id.
 * @property {string} [type] Always `function`.
 * @property {{name?: string, arguments?: string}} [function] Function payload.
 * @property {string} [name] Flat name, as some clients emit it.
 * @property {string|Record<string, unknown>} [arguments] Flat arguments.
 */

/**
 * One message of a client transcript, in the OpenAI chat shape.
 *
 * @typedef {object} ChatMessage
 * @property {string} [role] Message role.
 * @property {string|ChatMessagePart[]|null} [content] Message content.
 * @property {string} [name] Author name (tool results).
 * @property {string} [tool_call_id] Call this tool result answers.
 * @property {ToolCall[]} [tool_calls] Calls the assistant asked for.
 * @property {string} [reasoning_content] Reasoning text some upstreams echo back.
 * @property {boolean} [isToolCalls] Internal marker: the content is a replayed tool call.
 */

/**
 * One error object as the engine reads it off a failed upstream turn: the SDK's
 * `Error` plus the payload it sometimes carries.
 *
 * @typedef {object} TurnError
 * @property {string} [name] Error name.
 * @property {string} [message] Human-readable message.
 * @property {{message?: string}} [data] SDK error payload.
 */

/**
 * What {@link pollForAssistantResponse} returns for one turn.
 *
 * @typedef {object} PollResultLike
 * @property {string} content Assistant text collected so far.
 * @property {string} reasoning Reasoning text collected so far.
 * @property {TurnError|null} error Upstream message error, when the turn failed.
 */

/**
 * What {@link collectFromEvents} returns for one turn. Every field is optional
 * because the two shapes it merges (a cut stream and a rejected collection) fill
 * different ones.
 *
 * @typedef {object} CollectedTurn
 * @property {string} [content] Assistant text.
 * @property {string} [reasoning] Reasoning text.
 * @property {TurnError} [error] Upstream message error.
 * @property {TurnError} [__error] The collection itself rejected.
 * @property {boolean} [noData] No event arrived inside the first-delta window.
 * @property {boolean} [idleTimeout] The stream went idle and was cut.
 * @property {boolean} [receivedDelta] Whether any text/tool progress was seen.
 * @property {boolean} [clientClosed] The caller aborted (client disconnected).
 */

/**
 * One `session.prompt` call the engine assembles by hand.
 *
 * @typedef {object} PromptParams
 * @property {{id: string}} path Session route.
 * @property {{model: {providerID: string, modelID: string}, system?: string, parts: Array<Record<string, unknown>>, tools?: Record<string, unknown>, max_tokens?: number|null, temperature?: number, top_p?: number, stop?: string[]|null}} body
 *   Prompt body.
 */

/**
 * The external tool contract of one turn, as `createExternalToolContext` builds
 * it: the registry, the full exposure and the two prompt fragments.
 *
 * @typedef {object} ExternalToolContext
 * @property {import('../tools/registry.js').ExternalTool[]} registry Request registry.
 * @property {{tools: import('../tools/registry.js').ExternalTool[], toolChoice: import('../tools/contract.js').NormalizedToolChoice, prompt: string, reminder?: string}} exposure
 *   Exposure the prompt fragments were built from; the tools-off branch builds none.
 * @property {import('../tools/contract.js').NormalizedToolChoice} toolChoice Normalized choice.
 * @property {string} prompt Contract prompt section.
 * @property {string} [reminder] Short contract reminder appended as the last part.
 */

/**
 * Tool policy of one request plus the pieces that enforce it.
 *
 * @typedef {object} RequestToolContext
 * @property {ToolMode} mode Policy the turn runs under.
 * @property {ExternalToolContext} external External contract (`external-bridge` only).
 * @property {{allowedToolNames: string[], requestedAllowlist: string[]|null, deniedRequestedTools: string[], resolutionPath: string, resultingMode: ToolMode, metricsEnabled: boolean}} internal
 *   How the internal allowlist was resolved.
 */

/**
 * One entry of the `previous_response_id` chain index.
 *
 * @typedef {object} ResponseChainEntry
 * @property {string} sessionId Session the response was produced from.
 * @property {string|undefined} model Model name the client asked for.
 * @property {number} expiresAt Epoch milliseconds the entry stops being usable.
 */

/**
 * What a finished turn hands to {@link storeConversationEntry} so the next turn
 * of the same conversation can reuse the session it used.
 *
 * @typedef {object} StoredTurnEntry
 * @property {string|null} sessionId Session the turn used.
 * @property {'runtime'|'direct'} [mode] Upstream that served it.
 * @property {number|undefined} [sentCount] Delivered messages the session holds.
 * @property {string|null|undefined} [sentDigest] Rolling digest over those messages.
 * @property {string|null} [replyText] Answer text, for echo disambiguation.
 * @property {string|null} [startKey] Derived-identity anchor.
 */

/** Sleep helper used by the transient-error backoff. @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error class names that mean "this failure is ours", not the runtime's. */
const INTERNAL_ERROR_NAMES = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'URIError',
    'EvalError',
    'AggregateError',
    'Object'
]);

/**
 * Map an upstream failure onto the OpenAI-compatible error surface.
 *
 * @param {UpstreamErrorLike} error Thrown upstream error.
 * @returns {TransformedUpstreamError} Status and error body to answer with.
 */
function transformUpstreamError(error) {
    // Default fallback. A failure of ours (a fetch blowing up as a TypeError, an
    // unexpected throw) answers the documented internal-error body: echoing its
    // message and constructor name leaked internals (`code: "TypeError"`) and
    // broke the declared shape. A failure the runtime reported keeps its own
    // message/code, so the client can still see why the turn failed.
    const isInternal = !error.name || INTERNAL_ERROR_NAMES.has(error.name);
    let statusCode = 500;
    let message = isInternal ? 'Internal server error' : error.message || 'Internal server error';
    let type = 'server_error';
    let code = isInternal ? 'internal_error' : error.code || error.name || 'internal_error';

    // Handle timeout errors
    if (error.message && error.message.includes('Request timeout')) {
        statusCode = 504;
        type = 'timeout';
        code = 'timeout';
        message = 'Request timeout';
    }
    // Handle file access errors (Windows compatibility)
    else if (error.message && error.message.includes('ENOENT')) {
        statusCode = 500;
        type = 'internal_error';
        code = 'file_access_error';
        message =
            'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
    }
    // Handle upstream provider errors (from OpenCode SDK)
    else if (error.statusCode) {
        statusCode = error.statusCode;

        // Map upstream error types to OpenAI-compatible types
        const upstreamType = error.code || error.type || '';
        const upstreamMessage = error.message || '';

        // Billing/credit errors - map to 402 Payment Required
        if (
            upstreamType === 'CreditsError' ||
            upstreamType === 'InsufficientBalanceError' ||
            upstreamMessage.toLowerCase().includes('insufficient balance') ||
            upstreamMessage.toLowerCase().includes('insufficient credits') ||
            upstreamMessage.toLowerCase().includes('billing') ||
            upstreamMessage.toLowerCase().includes('quota exceeded') ||
            upstreamMessage.toLowerCase().includes('credit limit')
        ) {
            statusCode = 402;
            type = 'insufficient_quota';
            code = 'insufficient_quota';
            message = upstreamMessage || 'Insufficient balance or quota exceeded';
        }
        // Rate limit errors - map to 429
        else if (
            upstreamType === 'RateLimitError' ||
            upstreamType === 'TooManyRequestsError' ||
            statusCode === 429 ||
            upstreamMessage.toLowerCase().includes('rate limit') ||
            upstreamMessage.toLowerCase().includes('too many requests')
        ) {
            statusCode = 429;
            type = 'rate_limit_exceeded';
            code = 'rate_limit_exceeded';
            message = upstreamMessage || 'Rate limit exceeded';
        }
        // Authentication errors - keep as 401
        else if (
            upstreamType === 'AuthenticationError' ||
            upstreamType === 'InvalidAPIKeyError' ||
            statusCode === 401 ||
            upstreamMessage.toLowerCase().includes('invalid api key') ||
            upstreamMessage.toLowerCase().includes('unauthorized') ||
            upstreamMessage.toLowerCase().includes('authentication')
        ) {
            statusCode = 401;
            type = 'invalid_api_key';
            code = 'invalid_api_key';
            message = upstreamMessage || 'Invalid API key';
        }
        // Permission errors - map to 403
        else if (
            upstreamType === 'PermissionError' ||
            statusCode === 403 ||
            upstreamMessage.toLowerCase().includes('permission denied') ||
            upstreamMessage.toLowerCase().includes('access denied')
        ) {
            statusCode = 403;
            type = 'permission_denied';
            code = 'permission_denied';
            message = upstreamMessage || 'Permission denied';
        }
        // Model not found - map to 404
        else if (
            upstreamType === 'NotFoundError' ||
            statusCode === 404 ||
            upstreamMessage.toLowerCase().includes('model not found') ||
            upstreamMessage.toLowerCase().includes('does not exist')
        ) {
            statusCode = 404;
            // Our own resolver reports `model_not_found` with the documented
            // api-reference body (`type: invalid_request_error`); an upstream
            // NotFoundError keeps the behaviour-spec type.
            type = upstreamType === 'model_not_found' ? 'invalid_request_error' : 'model_not_found';
            code = 'model_not_found';
            message = upstreamMessage || 'Model not found';
        }
        // Bad request - map to 400
        else if (statusCode === 400 || upstreamType === 'BadRequestError') {
            statusCode = 400;
            type = 'invalid_request_error';
            code = 'invalid_request_error';
            message = upstreamMessage || 'Invalid request';
        }
        // Server errors from upstream - map to 502/503
        else if (statusCode >= 500) {
            statusCode = 502;
            type = 'server_error';
            code = 'server_error';
            message = upstreamMessage || 'Upstream provider error';
        }
        // Default: pass through with mapped type
        else {
            type = upstreamType.toLowerCase().replace(/error$/, '_error') || 'upstream_error';
            code = upstreamType;
            message = upstreamMessage;
        }
    }

    return {
        statusCode,
        error: {
            message,
            type,
            ...(code && { code }),
            ...(error.availableModels && { available_models: error.availableModels })
        }
    };
}

// --- Mutex Logic with Timeout ---
/**
 * Read an image and inline it as a `data:` URI.
 *
 * @param {string} url Absolute `http(s)` URL or an already-inlined `data:` URI.
 * @returns {Promise<string>} The `data:` URI.
 */
async function getImageDataUri(url) {
    if (url.startsWith('data:')) {
        return url;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid URL scheme: ${url}`);
    }

    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
            }

            const contentType = res.headers['content-type'] || 'image/jpeg';
            /** @type {Buffer[]} */
            const chunks = [];

            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(`data:${contentType};base64,${base64}`);
                } catch (e) {
                    reject(new Error(`Failed to encode image: ${/** @type {Error} */ (e).message}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image fetch timeout'));
        });
    });
}

const DEFAULT_POLL_INTERVAL_MS = 500;
// Backoff base for transient upstream error retries (issue #5): 800ms, 1600ms.
const RETRY_BACKOFF_BASE_MS = 800;
const RETRY_MAX_ATTEMPTS = 3;
// Reasoning models can take well over 10s before emitting their first token.
// A short window here makes the event stream give up and fall back to polling on
// every request, which loses true streaming. Configurable for slow backends.
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS =
    Number(process.env.OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS) || 30000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS) || 8000;

// cannot make the proxy accumulate (and pay for) unbounded backend sessions.
// message) are kept apart by their transcript prefix, so a bounded candidate
// list per anchor is enough to tell one conversation from its look-alikes.

/**
 * True when at least one of the messages that will actually be delivered to the
 * backend carries usable content. The chat handler validates the built parts so
 * it can answer 400 before creating a backend session; along a reused session
 * the same question is asked about the appended turns only.
 *
 * @param {Array<ChatMessage>} messages full client history, in order
 * @param {number} includeFromIndex index of the first non-system message to deliver
 * @returns {boolean} True when a delivered message carries usable content.
 */
function hasDeliverablePromptContent(messages, includeFromIndex = 0) {
    let deliveredCount = -1;
    for (const message of Array.isArray(messages) ? messages : []) {
        const role = String(message?.role || 'user').toLowerCase();
        if (role === 'system') continue;
        deliveredCount += 1;
        if (deliveredCount < includeFromIndex) continue;
        const content = message?.content;
        if (typeof content === 'string' && content.length > 0) return true;
        if (
            Array.isArray(content) &&
            content.some((part) => {
                if (!part) return false;
                if (part.type === 'text') return String(part.text || '').length > 0;
                return part.type === 'image_url';
            })
        )
            return true;
        if (role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length)
            return true;
        if (role === 'tool') return true;
    }
    return false;
}

const TOOL_LOCK_PLUGIN_FILE = 'opencode-gateway-tool-lock.js';
const TOOL_LOCK_PLUGIN_PATH = path.join(__dirname, '..', 'plugin', TOOL_LOCK_PLUGIN_FILE);

// Lowercase and drop separators so `web_fetch`, `WebFetch` and `webfetch` match.
/**
 * @param {unknown} name Tool name as configured or discovered.
 * @returns {string} Normalized name.
 */
function normalizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9./]/g, '');
}

/**
 * Robust Health Check Helper

/**
 * Create the turn engine.
 *
 * @param {object} options Engine options.
 * @param {Record<string, any>} options.config Resolved gateway config (env-shaped keys).
 * @param {any} options.logger Logger dependency.
 * @param {any} options.registry Conversation registry (`createConversationRegistry`).
 * @param {any} options.router Upstream router (`createUpstreamRouter`).
 * @param {any} [options.tools] Tool contract module, injectable for tests.
 * @param {any} [options.responseChains] `previous_response_id` chain index.
 * @param {any} [options.turnLimiter] Process-wide bounded turn limiter, injectable for tests.
 * @param {() => Promise<void>} [options.ensureBackend] Starts/awaits the managed backend.
 * @returns {object} Engine with the two handlers and the ops surfaces.
 */
export function createTurnEngine({
    config,
    logger = null,
    registry,
    router,
    tools: _tools = null,
    responseChains = createResponseChainIndex(),
    turnLimiter = null,
    ensureBackend = async () => {}
}) {
    if (!registry || typeof registry.resolveTurn !== 'function') {
        throw new Error('createTurnEngine requires a conversation registry');
    }
    if (!router || typeof router.plan !== 'function') {
        throw new Error('createTurnEngine requires an upstream router');
    }
    /** @type {any} */
    const log = logger && typeof logger.child === 'function' ? logger : null;
    const debugEnabled = Boolean(config.DEBUG);
    /** @param {...unknown} args Message and structured detail to log. */
    const logDebug = (...args) => {
        if (debugEnabled) log ? log.debug(...args) : console.log('[Proxy][Debug]', ...args);
    };
    /** @param {...unknown} args Message and structured detail to log. */
    const logWarn = (...args) => {
        if (log) log.warn(...args);
        else if (debugEnabled) console.warn('[Proxy]', ...args);
    };
    /**
     * Only used where the monolith used console.error.
     *
     * @param {unknown} message Message to log.
     * @param {unknown} [details] Structured detail to log.
     */
    const logError = (message, details) => {
        if (log) log.error(message, details);
        else console.error(message, details);
    };

    const client = router.runtime.client;
    const runtime = router.runtime;
    const direct = router.direct;

    const { listModels: getKnownModels, resolveRequestedModel } = createModelResolver({
        runtime,
        direct,
        logDebug
    });

    /**
     * Session state reader the conversation registry uses for baselines.
     *
     * @param {string} sessionId Session to read.
     * @returns {Promise<import('../conversation/baseline.js').SessionBaseline>} Snapshot.
     */
    const snapshotSessionState = (sessionId) =>
        conversationBaseline({ sessionId, sessionBackend: runtime, logger: log });

    /**
     * @param {string} providerID Resolved provider id.
     * @param {string} modelID Resolved bare model id.
     * @param {ToolMode} toolMode Tool policy of the turn.
     * @param {string|null} toolFingerprint Fingerprint of the exposed tool list.
     * @param {'runtime'|'direct'} mode Upstream the turn runs on.
     * @returns {string} Conversation scope.
     */
    const conversationScopeFor = (providerID, modelID, toolMode, toolFingerprint, mode) =>
        scopedConversationKey({ providerID, modelID, toolMode, toolFingerprint, mode });
    const conversationDeliverableMessages = deliverableConversationMessages;

    /**
     * Store the session a finished turn used, so the next turn reuses it.
     *
     * @param {string|null} key Conversation key.
     * @param {StoredTurnEntry} entry Session, plan and answer the turn produced.
     * @returns {void}
     */
    const storeConversationEntry = (key, entry) => {
        if (!key || !entry) return;
        registry.storeTurn({
            key,
            sessionId: entry.sessionId,
            mode: entry.mode || 'runtime',
            plan: { sentCount: entry.sentCount, sentDigest: entry.sentDigest },
            replyText: typeof entry.replyText === 'string' ? entry.replyText : null,
            startKey: entry.startKey || null
        });
    };

    /**
     * Drop a conversation and close the session it owned.
     *
     * @param {string|null} key Conversation key.
     * @returns {Promise<import('../conversation/store.js').ConversationEntry|null>} Discarded entry.
     */
    const discardConversationEntry = (key) => (key ? registry.discard({ key }) : Promise.resolve(null));

    /**
     * Drop a failed turn's conversation state (entry plus the session it used).
     *
     * @param {string|null} [key] Conversation key.
     * @param {string|null} [sessionId] Session to close when there is no entry.
     * @returns {Promise<void>}
     */
    const discardTurnState = async (key, sessionId) => {
        if (key) {
            await registry.discard({ key });
            return;
        }
        if (sessionId) await runtime.deleteSession(sessionId);
    };

    /**
     * A conversation scope includes the upstream mode, so the direct and runtime
     * turns of one conversation never share a session key.
     *
     * @param {string} providerID Resolved provider id.
     * @param {string} modelID Resolved bare model id.
     * @param {ToolMode} toolMode Tool policy of the turn.
     * @param {string|null} toolFingerprint Fingerprint of the exposed tool list.
     * @param {'direct'|'runtime'} mode Upstream the turn runs on.
     * @returns {string} Conversation scope.
     */
    const conversationScopeForTurn = (providerID, modelID, toolMode, toolFingerprint, mode) =>
        conversationScopeFor(providerID, modelID, toolMode, toolFingerprint, mode);

    /**
     * Resolve the conversation, take its turn lock, plan the delta and snapshot a
     * reused session's state.
     *
     * @param {object} params Resolution input.
     * @param {import('express').Request} params.req Incoming request.
     * @param {Array<object>} params.deliverable Non-system messages.
     * @param {string} params.scope Conversation scope.
     * @param {string|null} [params.previousSessionId] Session pinned by a response chain.
     * @returns {Promise<any>} `ResolvedTurn` from the conversation registry.
     */
    const resolveConversationTurn = ({ req, deliverable, scope, previousSessionId = null }) =>
        registry.resolveTurn({
            headers: req.headers,
            scope,
            deliverable,
            previousSessionId,
            clientAddress: req.socket?.remoteAddress || null
        });

    /** 503 body for a conversation whose lock wait expired. */
    const conversationBusyBody = () => ({
        error: { message: 'Conversation is busy with another request', type: 'conversation_busy' }
    });

    /** 503 body for process-wide capacity exhaustion. */
    const gatewayOverloadedBody = () => ({
        error: { message: 'Gateway is at capacity; retry shortly', type: 'gateway_overloaded' }
    });

    /**
     * Acquire one process-wide turn slot after the conversation lock is held.
     *
     * Taking locks in that order keeps duplicate requests for one conversation
     * from occupying multiple global permits while they wait on each other.
     *
     * @param {import('express').Response} res Response to write on overload.
     * @param {AbortSignal} signal Client-disconnect signal.
     * @returns {Promise<(() => void)|null>} Permit release function, or null.
     */
    const acquireTurnCapacity = async (res, signal) => {
        const release = await capacityLimiter.acquire({ signal });
        if (release) return release;
        if (signal.aborted || res.headersSent || res.writableEnded) return null;

        const snapshot = capacityLimiter.snapshot();
        logWarn('[Proxy] Gateway turn capacity exhausted', snapshot);
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(CONCURRENCY_WAIT_MS / 1000))));
        res.status(503).json(gatewayOverloadedBody());
        return null;
    };

    /** 503 body for a reused session whose baseline snapshot failed. */
    const sessionStateUnavailableBody = () => ({
        error: {
            message: 'Could not read the session state for this conversation; retry the request',
            type: 'session_state_unavailable'
        }
    });

    const RESPONSE_STATE_SWEEP_INTERVAL_MS = 60 * 1000;

    /**
     * @param {string} responseId Client-visible response id.
     * @returns {ResponseChainEntry|null} Live entry, or null when absent/expired.
     */
    const getResponseState = (responseId) => responseChains.get(responseId);

    /**
     * @param {string} responseId Client-visible response id.
     * @param {string} sessionId Session that produced it.
     * @param {string} model Model name as the client asked for it.
     * @returns {void}
     */
    const storeResponseState = (responseId, sessionId, model) =>
        responseChains.store(responseId, sessionId, model);
    const sweepResponseState = () => responseChains.sweep();
    const responseStateSweepTimer = setInterval(() => {
        sweepResponseState().catch(() => {});
        Promise.resolve(registry.sweep()).catch(() => {});
    }, RESPONSE_STATE_SWEEP_INTERVAL_MS);
    if (typeof responseStateSweepTimer.unref === 'function') responseStateSweepTimer.unref();

    const {
        OPENCODE_SERVER_URL,
        REQUEST_TIMEOUT_MS,
        MAX_CONCURRENT_TURNS = 20,
        MAX_PENDING_TURNS = 100,
        CONCURRENCY_WAIT_MS = 2000,
        DEBUG,
        DISABLE_TOOLS,
        INTERNAL_WEB_FETCH_ENABLED,
        INTERNAL_ALLOWED_TOOLS = [],
        INTERNAL_TOOL_METRICS_ENABLED = true,
        INTERNAL_TOOL_DISCOVERY_FIXTURE = [],
        PROMPT_MODE,
        OMIT_SYSTEM_PROMPT,
        AUTO_CLEANUP_CONVERSATIONS,
        CLEANUP_INTERVAL_MS,
        CLEANUP_MAX_AGE_MS,
        OPENCODE_HOME_BASE,
        EVENT_IDLE_TIMEOUT_MS = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS = DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS
    } = config;

    const capacityLimiter =
        turnLimiter ||
        createTurnLimiter({
            maxConcurrent: MAX_CONCURRENT_TURNS,
            maxPending: MAX_PENDING_TURNS,
            waitTimeoutMs: CONCURRENCY_WAIT_MS
        });

    const TOOL_MODE = Object.freeze({
        DISABLED: 'disabled',
        EXTERNAL_BRIDGE: 'external-bridge',
        INTERNAL_ALLOWLIST: 'internal-allowlist'
    });

    const TOOL_GUARD_MESSAGE =
        'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const EXTERNAL_TOOL_GUARD_MESSAGE =
        'OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools.';

    /**
     * @param {Array<unknown>} [entries] Configured tool names.
     * @returns {string[]} Trimmed, de-duplicated, non-empty names.
     */
    const normalizeConfiguredToolNames = (entries = []) => [
        ...new Set(entries.map((entry) => String(entry || '').trim()).filter(Boolean))
    ];

    /** @returns {string[]} Internal tool names this deployment allows. */
    const getEffectiveInternalAllowedTools = () => {
        const configuredTools = normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS);
        if (configuredTools.length > 0) return configuredTools;
        if (INTERNAL_WEB_FETCH_ENABLED) return ['web_fetch'];
        return [];
    };

    const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();

    /**
     * @param {string[]} [allowedToolNames] Names the turn may use.
     * @returns {string} Prompt section announcing the allowlist.
     */
    const buildInternalAllowlistPrompt = (allowedToolNames = []) => {
        if (allowedToolNames.length > 0) {
            return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${allowedToolNames.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`;
        }
        return 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';
    };

    /**
     * @param {string|null|undefined} systemMsg Client system message.
     * @param {string|null} [reasoningEffort] Normalized reasoning effort.
     * @param {ToolMode} [toolMode] Tool policy of the turn.
     * @param {string[]} [internalAllowedTools] Internal tools the turn may use.
     * @returns {string|undefined} System prompt, or undefined when it stays empty.
     */
    const buildSystemPrompt = (
        systemMsg,
        reasoningEffort = null,
        toolMode = TOOL_MODE.DISABLED,
        internalAllowedTools = []
    ) => {
        const parts = [];
        if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) {
            parts.push(systemMsg.trim());
        }
        if (reasoningEffort && reasoningEffort !== 'none') {
            parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
        }
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            parts.push(buildInternalAllowlistPrompt(internalAllowedTools));
        } else if (DISABLE_TOOLS && PROMPT_MODE !== 'plugin-inject') {
            parts.push(
                toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE
            );
        }
        const finalPrompt = parts.join('\n\n').trim();
        return finalPrompt || undefined;
    };

    /**
     * @param {unknown} [value] Requested reasoning effort.
     * @param {string|null} [fallback] Effort used when the request carries none.
     * @returns {string|null} Normalized effort.
     */
    const normalizeReasoningEffort = (value, fallback = null) => {
        if (!value || typeof value !== 'string') return fallback;
        /** @type {Record<string, string>} */
        const effortMap = {
            none: 'none',
            minimal: 'none',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'high'
        };
        return effortMap[value.toLowerCase()] || fallback;
    };

    /**
     * @param {string|undefined|null} text Model output.
     * @param {boolean} [trim] Whether the surviving text is trimmed.
     * @returns {string|undefined|null} Text without function-call markup.
     */
    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        return stripFunctionCallMarkup(text, trim);
    };

    /**
     * Flatten any content shape a client may send into plain text.
     *
     * @param {unknown} content Message content.
     * @returns {string} Text content.
     */
    const normalizeTextContent = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (part && typeof part.text === 'string') return part.text;
                    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text')
                        return part?.text || '';
                    return '';
                })
                .join('');
        }
        if (content && typeof (/** @type {{text?: unknown}} */ (content).text) === 'string')
            return /** @type {{text: string}} */ (content).text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'number' || typeof content === 'boolean') return String(content);
        return '';
    };

    /**
     * @param {unknown} args Tool arguments as the model emitted them.
     * @returns {string} JSON text.
     */
    const normalizeToolArguments = (args) => {
        if (typeof args === 'string') return args;
        if (args === undefined) return '{}';
        try {
            return JSON.stringify(args);
        } catch (e) {
            return '{}';
        }
    };

    /**
     * @param {unknown} content Tool result content.
     * @returns {string} Text content.
     */
    const normalizeToolResultContent = (content) => {
        const text = normalizeTextContent(content);
        if (text) return text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'object') {
            try {
                return JSON.stringify(content);
            } catch (e) {
                return '';
            }
        }
        return String(content);
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {unknown} [toolChoice] Raw `tool_choice`.
     * @returns {ExternalToolContext} Registry, exposure and prompt fragments.
     */
    const createExternalToolContext = (tools, toolChoice) => {
        const registry = buildExternalToolRegistry(tools);
        const exposure = buildToolExposure(registry, toolChoice);
        return {
            registry,
            exposure,
            toolChoice: exposure.toolChoice,
            prompt: exposure.prompt,
            // The contract reminder is appended as the last part of every turn:
            // it sits right before generation, where it is actually followed
            // (router.js documents the parse-rate effect of that position).
            reminder: exposure.reminder
        };
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {string[]} [effectiveInternalAllowlist] Internal tools that survived the
     *   request/server intersection.
     * @returns {ToolMode} Policy the turn runs under.
     */
    const resolveToolMode = (tools = [], effectiveInternalAllowlist = []) => {
        if (Array.isArray(tools) && tools.length > 0) {
            return TOOL_MODE.EXTERNAL_BRIDGE;
        }
        if (effectiveInternalAllowlist.length > 0) {
            return TOOL_MODE.INTERNAL_ALLOWLIST;
        }
        return TOOL_MODE.DISABLED;
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {unknown} [toolChoice] Raw `tool_choice`.
     * @param {{internal_allowed_tools?: unknown}|null} [requestOpencodeConfig] Per-request
     *   `opencode` config object.
     * @returns {RequestToolContext} Tool policy plus the contract it implies.
     */
    const createRequestToolContext = (tools, toolChoice, requestOpencodeConfig = undefined) => {
        let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
        let requestInternalAllowlist = null;

        if (requestOpencodeConfig && typeof requestOpencodeConfig === 'object') {
            if (Array.isArray(requestOpencodeConfig.internal_allowed_tools)) {
                requestInternalAllowlist = requestOpencodeConfig.internal_allowed_tools
                    .map((name) => String(name || '').trim())
                    .filter(Boolean);
            }
        }

        if (requestInternalAllowlist !== null) {
            effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter((name) =>
                requestInternalAllowlist.includes(name)
            );
        }

        const deniedRequestedTools = requestInternalAllowlist
            ? requestInternalAllowlist.filter((name) => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
            : [];

        const mode = resolveToolMode(tools, effectiveInternalAllowlist);
        /** @type {ExternalToolContext} */
        const external =
            mode === TOOL_MODE.EXTERNAL_BRIDGE
                ? createExternalToolContext(tools, toolChoice)
                : {
                      registry: [],
                      exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '' },
                      toolChoice: { mode: 'auto', requiredTool: null },
                      prompt: ''
                  };

        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode,
                metricsEnabled: INTERNAL_TOOL_METRICS_ENABLED
            }
        };
    };

    /**
     * Validate the model's calls against the request registry and drop the ones
     * the tool policy blocks.
     *
     * @param {unknown} parsedToolCalls Calls recovered from model output.
     * @param {import('../tools/registry.js').ExternalTool[]} registry Registry of the request.
     * @returns {{validCalls: import('../tools/validator.js').ValidatedToolCall[], invalidCalls: import('../tools/validator.js').InvalidToolCall[]}}
     *   Executable calls and rejects.
     */
    const finalizeValidatedToolCalls = (parsedToolCalls, registry) => {
        const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
        invalidCalls.forEach(({ call, validation }) => {
            logDebug('Rejected external tool call', {
                tool: /** @type {{function?: {name?: string}}|null} */ (call)?.function?.name,
                errors: validation?.errors?.map((error) => error.message)
            });
        });
        /** @type {import('../tools/validator.js').ValidatedToolCall[]} */
        const allowedCalls = [];
        validCalls.forEach((toolCall) => {
            const policyDecision = evaluateToolPolicy(toolCall.tool, toolCall.validatedArguments, { config });
            if (policyDecision.status === 'allow') {
                allowedCalls.push(toolCall);
                return;
            }
            logDebug('Blocked external tool call', {
                tool: toolCall.function.name,
                status: policyDecision.status,
                reason: policyDecision.reason
            });
        });
        return { validCalls: allowedCalls, invalidCalls };
    };

    /**
     * @param {import('../tools/validator.js').ValidatedToolCall[]} toolCalls Validated calls.
     * @returns {import('../tools/contract.js').WireToolCall[]} Calls in the OpenAI wire shape.
     */
    const toPublicToolCalls = (toolCalls) => {
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
        return toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            }
        }));
    };

    /**
     * Build the "call the tool again, properly" follow-up used when
     * `tool_choice: required` was answered with prose.
     *
     * @param {object} params Requester input.
     * @param {'auto'|'none'|'required'} params.mode Normalized `tool_choice` mode.
     * @param {string} params.sessionId Session the retry lands in.
     * @param {string|undefined} params.systemWithGuard System prompt to repeat.
     * @param {string|null} params.requiredTool Namespaced name to force.
     * @param {string} params.providerID Resolved provider id.
     * @param {string} params.modelID Resolved bare model id.
     * @param {Record<string, boolean>|null} params.toolOverrides Per-request tool map.
     * @param {number} params.requestTimeoutMs Turn timeout in milliseconds.
     * @param {(() => Promise<import('../conversation/baseline.js').SessionBaseline>)|null} [params.baselineProvider]
     *   Reader for the turns the session already holds.
     * @param {AbortSignal|null} [params.signal] Aborts with the client request.
     * @param {boolean} [params.forbidThinkBlock] Guard models with a think channel.
     * @returns {() => Promise<import('../upstreams/runtime-client.js').PollResult|null>} The requester.
     */
    const createForcedToolCallRequester =
        ({
            mode,
            sessionId,
            systemWithGuard,
            requiredTool,
            providerID,
            modelID,
            toolOverrides,
            requestTimeoutMs,
            baselineProvider = null,
            signal = null,
            forbidThinkBlock = false
        }) =>
        async () => {
            if (mode !== 'required') return null;
            if (!requiredTool) return null;
            /** @type {PromptParams} */
            const forcedPromptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID, modelID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts: [
                        {
                            type: 'text',
                            text: buildForcedToolCallPrompt(requiredTool, { forbidThinkBlock })
                        }
                    ]
                }
            };
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                forcedPromptParams.body.tools = toolOverrides;
            }
            // The retry lands in the same session, so the turns already there must be
            // excluded when polling for its answer.
            const baseline = baselineProvider ? await baselineProvider() : null;
            await promptWithTimeout(forcedPromptParams, requestTimeoutMs, signal);
            return pollForAssistantResponse(sessionId, requestTimeoutMs, DEFAULT_POLL_INTERVAL_MS, baseline);
        };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    /** @type {string[]|null} */
    let cachedToolIds = null;
    let cachedToolIdsAt = 0;
    /** @type {Record<string, boolean>|null} */
    let cachedDisabledToolOverrides = null;
    let cachedDisabledToolOverridesAt = 0;
    const internalToolMetrics = {
        externalBridgeRequests: 0,
        internalAllowlistRequests: 0,
        disabledRequests: 0,
        discoveryFailures: 0,
        fallbackToDisabled: 0
    };

    const operationalSurface = createOperationalSurface({
        config,
        capacityLimiter,
        allowedToolNames: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
        discoveryFixture: normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE),
        internalToolMetrics,
        getToolCacheSnapshot: () => ({ ids: cachedToolIds, updatedAt: cachedToolIdsAt })
    });
    const { handleHealth, handleHealthDetails, handleMetrics, getInternalToolDashboard, renderMetrics } =
        operationalSurface;

    /**
     * @param {string} event Event name.
     * @param {Record<string, unknown>} [details] Event payload.
     * @returns {void}
     */
    const logInternalToolEvent = (event, details = {}) => {
        if (!DEBUG && !INTERNAL_TOOL_METRICS_ENABLED) return;
        /** @type {Record<string, unknown>} */
        const payload = {
            event,
            ...details
        };
        if (INTERNAL_TOOL_METRICS_ENABLED) {
            payload.metrics = { ...internalToolMetrics };
        }
        logDebug('Internal tool event', payload);
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {Record<string, unknown>} [details] Extra fields to log.
     * @returns {void}
     */
    const trackToolMode = (toolMode, details = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
            internalToolMetrics.externalBridgeRequests += 1;
        } else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            internalToolMetrics.internalAllowlistRequests += 1;
        } else {
            internalToolMetrics.disabledRequests += 1;
        }
        logInternalToolEvent('tool-mode-selected', {
            toolMode,
            ...details
        });
    };

    /** @returns {Promise<string[]|null>} Backend tool ids, or null when undiscoverable. */
    const getBackendToolIds = async () => {
        if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) {
            return cachedToolIds;
        }
        const fixtureIds = normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE);
        if (fixtureIds.length > 0) {
            cachedToolIds = fixtureIds;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-fixture-loaded', { count: fixtureIds.length, fixtureIds });
            return fixtureIds;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data) ? idsRes.data : Array.isArray(idsRes) ? idsRes : [];
            cachedToolIds = ids;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-loaded', { count: ids.length });
            return ids;
        } catch (e) {
            internalToolMetrics.discoveryFailures += 1;
            logInternalToolEvent('backend-tool-ids-failed', { error: /** @type {Error} */ (e).message });
            return null;
        }
    };

    /**
     * @param {string[]} [ids] Backend tool ids.
     * @returns {Record<string, boolean>} Every id mapped to `false`.
     */
    const buildDisabledToolOverrides = (ids = []) => {
        /** @type {Record<string, boolean>} */
        const overrides = {};
        ids.forEach((id) => {
            overrides[id] = false;
        });
        return overrides;
    };

    /**
     * @param {Array<unknown>} [ids] Tool ids as the backend reports them.
     * @returns {string[]} Non-empty string ids.
     */
    const normalizeBackendToolIds = (ids = []) =>
        /** @type {string[]} */ (ids.filter((id) => typeof id === 'string' && id.trim()));

    // Built-in OpenCode tool IDs have no separators (`webfetch`), while configs
    // commonly spell them `web_fetch`; compare both sides in the same form.
    /**
     * @param {unknown} toolId Backend tool id.
     * @param {string} allowedToolName Configured name.
     * @returns {boolean} True when the two name the same tool.
     */
    const matchesAllowedToolName = (toolId, allowedToolName) => {
        const id = normalizeToolName(toolId);
        const name = normalizeToolName(allowedToolName);
        if (!id || !name) return false;
        return id === name || id.endsWith(`.${name}`) || id.endsWith(`/${name}`);
    };

    /**
     * @param {Array<unknown>} [ids] Backend tool ids.
     * @param {Array<unknown>} [allowedToolNames] Configured names.
     * @returns {{normalizedIds: string[], normalizedAllowedNames: string[], matchedToolIds: string[], unmatchedAllowedNames: string[]}}
     *   Normalized ids and how the allowlist resolved against them.
     */
    const resolveInternalAllowedToolIds = (ids = [], allowedToolNames = []) => {
        const normalizedIds = normalizeBackendToolIds(ids);
        const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames);
        /** @type {Set<string>} */
        const matchedToolIds = new Set();
        /** @type {string[]} */
        const unmatchedAllowedNames = [];

        normalizedAllowedNames.forEach((allowedToolName) => {
            const matches = normalizedIds.filter((toolId) => matchesAllowedToolName(toolId, allowedToolName));
            if (matches.length === 0) {
                unmatchedAllowedNames.push(allowedToolName);
                return;
            }
            matches.forEach((match) => matchedToolIds.add(match));
        });

        return {
            normalizedIds,
            normalizedAllowedNames,
            matchedToolIds: [...matchedToolIds],
            unmatchedAllowedNames
        };
    };

    /** @returns {Promise<Record<string, boolean>|null>} Tool map that disables every tool. */
    const getDisabledToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
            return cachedDisabledToolOverrides;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids)) return null;
        const overrides = buildDisabledToolOverrides(ids);
        cachedDisabledToolOverrides = overrides;
        cachedDisabledToolOverridesAt = Date.now();
        logInternalToolEvent('disabled-tool-overrides-loaded', { count: ids.length });
        return overrides;
    };

    // Tool enforcement. OpenCode Zen's free tier rejects any request whose tool
    // list differs from the official client's ("free tier can only be used from
    // within OpenCode"), and a per-request `tools` map strips tools from that
    // list. When the backend runs the opencode-gateway tool-lock plugin, the tool
    // list is left intact and the policy travels in the session title instead;
    // the plugin then refuses every tool the policy does not allow. Backends
    // without the plugin fall back to the `tools` map, which keeps tools off but
    // only works with models that skip the free-tier check.
    const TOOL_LOCK_CHECK_MS = 60 * 1000;
    let toolLockState = { loaded: false, checkedAt: 0, warned: false };

    /** @returns {Promise<boolean>} True when the backend loads the tool-lock plugin. */
    const isToolLockLoaded = async () => {
        if (toolLockState.checkedAt && Date.now() - toolLockState.checkedAt < TOOL_LOCK_CHECK_MS) {
            return toolLockState.loaded;
        }
        /** @type {Array<unknown>} */
        let plugins;
        try {
            const res = await client.config.get();
            plugins = Array.isArray(res?.data?.plugin) ? res.data.plugin : [];
        } catch (e) {
            // Backend unreachable: do not cache, the request will surface the error.
            return toolLockState.loaded;
        }
        const loaded = plugins.some(
            (spec) =>
                typeof spec === 'string' && spec.replace(/\\/g, '/').endsWith(`/${TOOL_LOCK_PLUGIN_FILE}`)
        );
        if (!loaded && !toolLockState.warned) {
            console.warn(
                `[Proxy] Backend at ${OPENCODE_SERVER_URL} does not load ${TOOL_LOCK_PLUGIN_FILE}; falling back to per-request tool overrides. OpenCode Zen free models reject those requests. Let the proxy start the backend (MANAGE_BACKEND=true) or add "${TOOL_LOCK_PLUGIN_PATH}" to the backend's "plugin" config.`
            );
            toolLockState.warned = true;
        }
        toolLockState = { ...toolLockState, loaded, checkedAt: Date.now() };
        return loaded;
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {string} Policy payload the tool-lock plugin parses.
     */
    const buildToolPolicy = (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            const names = normalizeConfiguredToolNames(
                internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
            )
                .map(normalizeToolName)
                .filter(Boolean);
            return names.length ? [...new Set(names)].join(',') : 'none';
        }
        return DISABLE_TOOLS ? 'none' : '*';
    };

    /**
     * @param {string} policy Policy payload.
     * @returns {string} Session title carrying it.
     */
    const sessionTitleForPolicy = (policy) => `opencode-gateway [tools:${policy}]`;

    // Resolves how a request's tool policy reaches the backend: a session title
    // for the tool-lock plugin, or a `tools` override map as the fallback.
    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {Promise<{title: string|undefined, toolOverrides: Record<string, boolean>|null}>}
     *   How the policy reaches the backend.
     */
    const resolveToolControl = async (toolMode, internalContext = {}) => {
        const policy = buildToolPolicy(toolMode, internalContext);
        if (await isToolLockLoaded()) {
            logInternalToolEvent('tool-policy-plugin', { toolMode, policy });
            return { title: sessionTitleForPolicy(policy), toolOverrides: null };
        }
        return { title: undefined, toolOverrides: await getToolOverridesForMode(toolMode, internalContext) };
    };

    /**
     * @param {{title?: string}|null} [toolControl] Tool control of the request.
     * @returns {Promise<string>} Id of the created session.
     */
    const createSession = async (toolControl) => {
        const sessionRes = await client.session.create(
            toolControl?.title ? { body: { title: toolControl.title } } : undefined
        );
        const sessionId = sessionRes?.data?.id;
        if (!sessionId) throw new Error('Failed to create OpenCode session');
        return sessionId;
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {Promise<Record<string, boolean>|null>} Per-request `tools` map, or null.
     */
    const getToolOverridesForMode = async (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
            if (toolMode === TOOL_MODE.DISABLED) {
                logInternalToolEvent('internal-tools-disabled', {
                    configuredAllowlist:
                        internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
                });
            }
            return getDisabledToolOverrides();
        }
        if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
            return null;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const resolution = resolveInternalAllowedToolIds(
            ids,
            internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
        );
        const { normalizedIds, normalizedAllowedNames, matchedToolIds, unmatchedAllowedNames } = resolution;
        if (matchedToolIds.length === 0) {
            internalToolMetrics.fallbackToDisabled += 1;
            logInternalToolEvent('internal-allowlist-unavailable', {
                configuredAllowlist: normalizedAllowedNames,
                availableToolIds: normalizedIds,
                unmatchedAllowlist: unmatchedAllowedNames,
                fallback: 'disabled'
            });
            return buildDisabledToolOverrides(normalizedIds);
        }
        /** @type {Record<string, boolean>} */
        const overrides = {};
        normalizedIds.forEach((id) => {
            overrides[id] = matchedToolIds.includes(id);
        });
        logInternalToolEvent('internal-allowlist-overrides-loaded', {
            configuredAllowlist: normalizedAllowedNames,
            matchedToolIds,
            unmatchedAllowlist: unmatchedAllowedNames,
            availableToolIdsCount: normalizedIds.length
        });
        return overrides;
    };

    /**
     * Prompt the runtime with a turn timeout and an abort signal.
     *
     * @param {PromptParams} promptParams Prompt to send.
     * @param {number} timeoutMs Turn timeout in milliseconds.
     * @param {AbortSignal|null} [signal] Aborts with the client request.
     * @returns {Promise<PromptResultLike>} The runtime's prompt result.
     */
    async function promptWithTimeout(promptParams, timeoutMs, signal = null) {
        return runtime.prompt(promptParams, { timeoutMs, signal });
    }

    /**
     * Poll a runtime session until the turn's answer is complete.
     *
     * @param {string} sessionId Session to poll.
     * @param {number} timeoutMs Turn timeout in milliseconds.
     * @param {number} intervalMs Poll interval in milliseconds.
     * @param {import('../conversation/baseline.js').SessionBaseline|null} [baseline] Snapshot to exclude.
     * @returns {Promise<PollResultLike>} Collected turn.
     */
    const pollForAssistantResponse = (sessionId, timeoutMs, intervalMs, baseline = null) =>
        runtime.pollForAssistantResponse({ sessionId, timeoutMs, intervalMs, baseline });

    /**
     * Collect a turn's answer from the runtime event stream.
     *
     * @param {string} sessionId Session to collect from.
     * @param {number} timeoutMs Turn timeout in milliseconds.
     * @param {(delta: string) => void} onDelta Called for every text delta.
     * @param {number} firstDeltaTimeoutMs How long to wait for the first delta.
     * @param {number} idleTimeoutMs How long the stream may stay idle.
     * @param {import('../conversation/baseline.js').SessionBaseline|null} [baseline] Snapshot to exclude.
     * @param {AbortSignal|null} [externalSignal] Aborts with the client request.
     * @returns {Promise<CollectedTurn>} Collected turn.
     */
    const collectFromEvents = (
        sessionId,
        timeoutMs,
        onDelta,
        firstDeltaTimeoutMs,
        idleTimeoutMs,
        baseline = null,
        externalSignal = null
    ) =>
        runtime.collectFromEvents({
            sessionId,
            timeoutMs,
            onDelta,
            firstDeltaTimeoutMs,
            idleTimeoutMs,
            baseline,
            signal: externalSignal
        });

    const storageCleanup = createStorageCleanup({
        enabled: AUTO_CLEANUP_CONVERSATIONS,
        intervalMs: CLEANUP_INTERVAL_MS,
        maxAgeMs: CLEANUP_MAX_AGE_MS,
        homeBase: OPENCODE_HOME_BASE,
        logDebug
    });
    const cleanupConversationFiles = storageCleanup.cleanup;

    const runDirectTurn = createDirectTurnRunner({
        direct,
        router,
        logWarn
    });

    /**
     * `POST /v1/chat/completions`.
     *
     * @param {import('express').Request} req Incoming request.
     * @param {import('express').Response} res Response to write.
     * @returns {Promise<void>}
     */
    const handleChat = async (req, res) => {
        try {
            /** @type {string|null} */
            let sessionId = null;
            /** @type {string|null} */
            let conversationKey = null;
            let turnPlan;
            /** @type {import('../conversation/baseline.js').SessionBaseline|null} */
            let turnBaseline = null;
            /** @type {(() => void)|null} */
            let releaseConversationLock = null;
            /** @type {(() => void)|null} */
            let releaseTurnCapacity = null;
            // Aborted when the client disconnects, so the turn ends (and its
            // conversation lock is released) instead of running to the timeout.
            const turnAbort = new AbortController();
            res.on('close', () => {
                if (!res.writableEnded) turnAbort.abort();
            });
            /** @type {{close: () => void}|null} */
            const eventStream = /** @type {{close: () => void}|null} */ (null);
            let stream;
            let pID = 'opencode';
            let mID = 'kimi-k2.5-free';
            let id = `chatcmpl-${crypto.randomUUID()}`;
            /** @type {ReturnType<typeof setInterval>|null} */
            let keepaliveInterval = null;

            try {
                const {
                    messages,
                    model,
                    tools = [],
                    tool_choice,
                    stream: requestStream,
                    temperature,
                    max_tokens,
                    top_p,
                    frequency_penalty,
                    presence_penalty,
                    stop,
                    reasoning_effort,
                    reasoning,
                    opencode: requestOpencodeConfig
                } = req.body;
                stream = Boolean(requestStream);
                if (!messages || !Array.isArray(messages) || messages.length === 0) {
                    res.status(400).json({ error: { message: 'messages array is required' } });
                    return;
                }

                const reasoningLevel = normalizeReasoningEffort(reasoning_effort || reasoning?.effort, null);

                const requestParams = {
                    temperature: typeof temperature === 'number' ? temperature : 0.7,
                    max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                    top_p: typeof top_p === 'number' ? top_p : 1.0,
                    frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
                    presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
                    stop: Array.isArray(stop) ? stop : stop ? [stop] : null,
                    reasoning_effort: reasoningLevel
                };

                logDebug('Request params', {
                    temperature: requestParams.temperature,
                    max_tokens: requestParams.max_tokens,
                    top_p: requestParams.top_p,
                    reasoning_effort: reasoningLevel
                });

                const resolvedModel = await resolveRequestedModel(model);
                pID = resolvedModel.providerID;
                mID = resolvedModel.modelID;
                if (resolvedModel.aliasFrom) {
                    logDebug('Resolved model alias', {
                        from: resolvedModel.aliasFrom,
                        to: resolvedModel.resolved
                    });
                }

                /**
                 * @param {unknown} content Message content.
                 * @returns {string} Text content.
                 */
                const normalizeMessageContent = (content) => normalizeTextContent(content);

                /**
                 * Render the client transcript into the prompt parts, the system
                 * prompt and the text history the conversation registry digests.
                 *
                 * @param {ChatMessage[]} rawMessages Full client history, in order.
                 * @param {import('../tools/registry.js').ExternalTool[]} [externalToolRegistry]
                 *   Registry of this request.
                 * @param {{toolCallMap?: Map<string|undefined, string|undefined>, includeFromIndex?: number}} [options]
                 *   Build options.
                 * @returns {Promise<PromptParts>} Parts plus the text renderings.
                 */
                const buildPromptParts = async (rawMessages, externalToolRegistry = [], options = {}) => {
                    /** @type {Array<Record<string, unknown>>} */
                    const parts = [];
                    /** @type {string[]} */
                    const systemChunks = [];
                    /** @type {string[]} */
                    const userContents = [];
                    /** @type {Map<string|undefined, string|undefined>} */
                    const assistantToolCalls = options.toolCallMap || new Map();
                    // A reused session already holds the earlier turns, so only the
                    // messages appended since the last request are delivered as parts.
                    // Everything is still walked: the system prompt is rebuilt from the
                    // full history and tool-call ids must resolve for older messages too,
                    // otherwise a tool result in the new turn loses its name.
                    const includeFromIndex =
                        Number.isInteger(options.includeFromIndex) &&
                        /** @type {number} */ (options.includeFromIndex) > 0
                            ? /** @type {number} */ (options.includeFromIndex)
                            : 0;
                    let deliveredCount = -1;
                    // Token accounting stays conversation-wide: on a reused session the
                    // earlier turns are part of the prompt the model sees even though
                    // they are not re-sent.
                    /** @type {string[]} */
                    const historyTexts = [];
                    /**
                     * @param {string} role Message role.
                     * @param {string|undefined} name Author name, when the client set one.
                     * @param {string} text Rendered text.
                     * @returns {string} `ROLE(name): text` line.
                     */
                    const formatRoleLine = (role, name, text) => {
                        const roleLabel = role.toUpperCase();
                        const nameSuffix = name ? `(${name})` : '';
                        return `${roleLabel}${nameSuffix}: ${text}`;
                    };

                    for (const m of rawMessages) {
                        const role = (m?.role || 'user').toLowerCase();
                        const content = m?.content;

                        if (role === 'system') {
                            const text = normalizeMessageContent(content);
                            if (text) systemChunks.push(text);
                            continue;
                        }

                        deliveredCount += 1;
                        const deliver = deliveredCount >= includeFromIndex;

                        if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                            const serializedToolCalls = m.tool_calls
                                .map((toolCall, index) => ({
                                    id: toolCall?.id || `call_${index + 1}`,
                                    name:
                                        findExternalToolByName(
                                            externalToolRegistry,
                                            toolCall?.function?.name || toolCall?.name
                                        )?.namespacedName ||
                                        toolCall?.function?.name ||
                                        toolCall?.name,
                                    arguments: normalizeToolArguments(
                                        toolCall?.function?.arguments ?? toolCall?.arguments
                                    )
                                }))
                                .filter((toolCall) => toolCall.name);
                            if (serializedToolCalls.length) {
                                serializedToolCalls.forEach((toolCall) => {
                                    assistantToolCalls.set(toolCall.id, toolCall.name);
                                });
                                historyTexts.push(
                                    `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
                                );
                                if (deliver) {
                                    parts.push({
                                        type: 'text',
                                        text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
                                    });
                                }
                            }
                        }

                        if (role === 'tool') {
                            const text = normalizeMessageContent(content);
                            if (text) {
                                const mappedTool =
                                    findExternalToolByName(externalToolRegistry, m?.name) ||
                                    findExternalToolByName(
                                        externalToolRegistry,
                                        assistantToolCalls.get(m?.tool_call_id)
                                    );
                                const toolName =
                                    mappedTool?.namespacedName ||
                                    assistantToolCalls.get(m?.tool_call_id) ||
                                    m?.name ||
                                    `${EXTERNAL_TOOL_PREFIX}unknown`;
                                const toolCallId =
                                    m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                                const toolResultText = `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
                                historyTexts.push(toolResultText);
                                if (deliver) {
                                    parts.push({ type: 'text', text: toolResultText });
                                }
                            }
                            continue;
                        }

                        if (!content) continue;

                        if (typeof content === 'string') {
                            const line = formatRoleLine(role, m?.name, content);
                            historyTexts.push(line);
                            if (deliver) {
                                if (role === 'user') userContents.push(content);
                                parts.push({ type: 'text', text: line });
                            }
                        } else if (Array.isArray(content)) {
                            for (const part of content) {
                                if (!part) continue;

                                if (part.type === 'text') {
                                    const text = part.text || '';
                                    const line = formatRoleLine(role, m?.name, text);
                                    historyTexts.push(line);
                                    if (deliver) {
                                        if (role === 'user') userContents.push(text);
                                        parts.push({ type: 'text', text: line });
                                    }
                                } else if (part.type === 'image_url') {
                                    if (!deliver) continue;
                                    const imageUrl =
                                        typeof part.image_url === 'string'
                                            ? part.image_url
                                            : part.image_url?.url;
                                    if (imageUrl) {
                                        try {
                                            const dataUri = await getImageDataUri(imageUrl);
                                            const mime = dataUri.split(';')[0].split(':')[1];
                                            parts.push({
                                                type: 'file',
                                                mime,
                                                url: dataUri,
                                                filename: 'image'
                                            });
                                        } catch (imgErr) {
                                            logWarn(
                                                '[Proxy] Skipping image due to error:',
                                                /** @type {Error} */ (imgErr).message
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    return {
                        parts,
                        system: systemChunks.join('\n\n'),
                        fullPromptText: historyTexts.join('\n\n'),
                        lastUserMsg: userContents[userContents.length - 1] || ''
                    };
                };

                const requestToolContext = createRequestToolContext(
                    tools,
                    tool_choice,
                    requestOpencodeConfig
                );
                const toolMode = requestToolContext.mode;
                const externalToolContext = requestToolContext.external;
                const externalToolRegistry = externalToolContext.registry;
                const externalToolChoice = externalToolContext.toolChoice;
                const internalToolContext = requestToolContext.internal;
                trackToolMode(toolMode, {
                    configuredAllowlist: internalToolContext.allowedToolNames,
                    requestedAllowlist: internalToolContext.requestedAllowlist,
                    deniedRequestedTools: internalToolContext.deniedRequestedTools,
                    resolutionPath: internalToolContext.resolutionPath,
                    resultingMode: internalToolContext.resultingMode,
                    route: '/v1/chat/completions'
                });

                // Which upstream serves this turn depends on the model alone: the
                // OpenCode-compatible endpoints answer directly, free-tier Zen
                // models need the runtime.
                const servingMode = router.shouldUseDirect(pID, mID).direct ? 'direct' : 'runtime';

                // The conversation is resolved first, because both upstreams need
                // the same identity: a stable session for x-opencode-session, or a
                // reusable runtime session. The registry takes the per-conversation
                // turn lock, plans the delta and snapshots a reused session.
                const deliverableMessages = conversationDeliverableMessages(messages);
                const conversationScope = conversationScopeForTurn(
                    pID,
                    mID,
                    toolMode,
                    toolsFingerprintFor(tools, tool_choice),
                    servingMode
                );
                const resolvedTurn = await resolveConversationTurn({
                    req,
                    deliverable: deliverableMessages,
                    scope: conversationScope
                });
                conversationKey = resolvedTurn.key;
                const conversationEntry = resolvedTurn.entry;
                releaseConversationLock = resolvedTurn.release;
                const conversationIdentity = resolvedTurn.identity;
                const derivedIdentity =
                    resolvedTurn.identity?.source === 'derived' ? resolvedTurn.identity : null;
                if (resolvedTurn.busy) {
                    res.status(503).json(conversationBusyBody());
                    return;
                }

                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;

                if (servingMode === 'direct') {
                    const sessionId =
                        conversationEntry?.mode === 'direct' && conversationEntry.sessionId
                            ? conversationEntry.sessionId
                            : newSessionId();
                    const turnPlanForDirect = resolvedTurn.plan;
                    const { opencode: _omitProxyExtension, ...upstreamBody } = req.body || {};
                    const directResult = await runDirectTurn({
                        path: '/chat/completions',
                        res,
                        providerID: pID,
                        modelID: mID,
                        sessionId,
                        body: upstreamBody,
                        stream,
                        clientModelName: `${pID}/${mID}`,
                        signal: turnAbort.signal,
                        fallbackTurn: {
                            providerID: pID,
                            modelID: mID,
                            key: conversationKey,
                            mode: 'direct'
                        },
                        onSuccess: (answerText) =>
                            storeConversationEntry(conversationKey, {
                                sessionId,
                                mode: 'direct',
                                sentCount: turnPlanForDirect.sentCount,
                                sentDigest: turnPlanForDirect.sentDigest,
                                replyText: typeof answerText === 'string' ? answerText : null,
                                startKey: derivedIdentity?.startKey || null
                            })
                    });
                    if (directResult.handled) return;
                }

                // Ensure backend is running
                await ensureBackend();

                // Set active model
                try {
                    await client.config.update({
                        body: {
                            activeModel: { providerID: pID, modelID: mID }
                        }
                    });
                } catch (confError) {
                    logDebug('Failed to set active model:', /** @type {Error} */ (confError).message);
                }

                // With the tool-lock plugin the session title carries the tool
                // policy, so it is resolved before any session is created.
                const toolControl = await resolveToolControl(toolMode, internalToolContext);
                turnPlan = resolvedTurn.plan;

                // Validate before any session is created or evicted: an early 400
                // must not leave an upstream session behind, and header-less
                // clients must see the same validation order as before.
                if (!hasDeliverablePromptContent(messages, turnPlan.deltaStartIndex)) {
                    res.status(400).json({
                        error: {
                            message: 'messages must include at least one non-system text message'
                        }
                    });
                    return;
                }

                if (turnPlan.reuse) {
                    sessionId = /** @type {string} */ (resolvedTurn.sessionId);
                    logDebug('Reusing conversation session', {
                        sessionId,
                        header: conversationIdentity?.header || 'derived',
                        deliveredTurns: resolvedTurn.entry?.sentCount,
                        appendedTurns: turnPlan.delta.length
                    });
                } else {
                    if (resolvedTurn.entry?.sessionId) {
                        await registry.discard({ key: conversationKey });
                    }
                    sessionId = await createSession(toolControl);
                    logDebug('Session created', {
                        sessionId,
                        historyRewritten: turnPlan.rewrite,
                        derived: Boolean(derivedIdentity)
                    });
                }

                const {
                    parts,
                    system: systemMsg,
                    fullPromptText,
                    lastUserMsg
                } = await buildPromptParts(messages, externalToolRegistry, {
                    includeFromIndex: turnPlan.deltaStartIndex
                });
                const systemWithGuard = buildSystemPrompt(
                    [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                    requestParams.reasoning_effort,
                    toolMode,
                    internalToolContext.allowedToolNames
                );
                if (!parts.length) {
                    res.status(400).json({
                        error: {
                            message: 'messages must include at least one non-system text message'
                        }
                    });
                    return;
                }
                logDebug('Request start', {
                    model: `${pID}/${mID}`,
                    stream: Boolean(stream),
                    userMessages: messages.length,
                    system: Boolean(systemMsg),
                    lastUserLength: lastUserMsg?.length || 0,
                    parts: parts.length,
                    disableTools: DISABLE_TOOLS,
                    toolMode,
                    internalAllowedTools: internalToolContext.allowedToolNames,
                    requestedInternalTools: internalToolContext.requestedAllowlist,
                    deniedRequestedTools: internalToolContext.deniedRequestedTools,
                    resolutionPath: internalToolContext.resolutionPath,
                    resultingMode: internalToolContext.resultingMode
                });

                id = `chatcmpl-${crypto.randomUUID()}`;
                keepaliveInterval = null;
                let completionTokens = 0;
                let reasoningTokens = 0;

                // A reused session already holds the earlier turns; remember what
                // exists now so neither polling nor the event stream can report an
                // older answer as this turn's result. Without the snapshot the
                // previous answer would be served as this turn's, so a failed read
                // fails the turn instead of falling back to unfiltered polling.
                if (turnPlan.reuse) {
                    turnBaseline = resolvedTurn.baseline;
                    if (!turnBaseline || !turnBaseline.ok) {
                        await discardConversationEntry(conversationKey);
                        res.status(503).json(sessionStateUnavailableBody());
                        return;
                    }
                }

                // Append a short contract reminder as the last part so the model
                // sees it immediately before generating. With the contract only in
                // the 16KB+ system prompt it gets buried; position matters a lot for
                // compliance. deepseek-v4-flash-free: 50% → 100% call rate.
                /**
                 * @param {Array<Record<string, unknown>>} builtParts Parts built for the turn.
                 * @returns {Array<Record<string, unknown>>} Parts with the reminder appended.
                 */
                const withToolReminder = (builtParts) =>
                    externalToolContext.reminder
                        ? [...builtParts, { type: 'text', text: externalToolContext.reminder }]
                        : builtParts;

                // Retrying rotates to an empty session, which needs the whole
                // history again: the delta window only makes sense for the session
                // that already holds the earlier turns.
                const rebuildPromptPartsForNewSession = async () => {
                    const rebuilt = await buildPromptParts(messages, externalToolRegistry, {
                        includeFromIndex: 0
                    });
                    if (rebuilt.parts.length) {
                        promptParams.body.parts = withToolReminder(rebuilt.parts);
                    }
                };

                /** @type {PromptParams} */
                const promptParams = {
                    path: { id: sessionId },
                    body: {
                        model: { providerID: pID, modelID: mID },
                        system: systemWithGuard,
                        parts: withToolReminder(parts),
                        ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                        ...(requestParams.temperature !== undefined && {
                            temperature: requestParams.temperature
                        }),
                        ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                        ...(requestParams.stop && { stop: requestParams.stop })
                    }
                };
                const { toolOverrides } = toolControl;
                if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                    promptParams.body.tools = toolOverrides;
                }

                const makeForcedChatToolCallRequester = () =>
                    createForcedToolCallRequester({
                        mode: externalToolChoice.mode,
                        sessionId: /** @type {string} */ (sessionId),
                        systemWithGuard,
                        requiredTool:
                            externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                        providerID: pID,
                        modelID: mID,
                        baselineProvider: () => snapshotSessionState(/** @type {string} */ (sessionId)),
                        toolOverrides,
                        requestTimeoutMs: REQUEST_TIMEOUT_MS,
                        signal: turnAbort.signal,
                        forbidThinkBlock: true
                    });
                let requestForcedChatToolCall = makeForcedChatToolCallRequester();

                res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                if (stream) {
                    const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                    /** @type {ToolCallFilterWithFlush} */
                    const filterContentDelta = /** @type {ToolCallFilterWithFlush} */ (
                        createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup
                        })
                    );
                    /** @type {ToolCallFilterWithFlush} */
                    const filterReasoningDelta = /** @type {ToolCallFilterWithFlush} */ (
                        createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup
                        })
                    );
                    /** @type {ExternalToolCallParserWithFlush} */
                    const parseContentToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                        createExternalToolCallStreamParser(externalToolRegistry)
                    );
                    /** @type {ExternalToolCallParserWithFlush} */
                    const parseReasoningToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                        createExternalToolCallStreamParser(externalToolRegistry)
                    );
                    let streamedContent = '';
                    let streamedReasoning = '';
                    let rawStreamedContent = '';
                    let rawStreamedReasoning = '';
                    /** @type {import('../tools/contract.js').WireToolCall[]} */
                    const streamedToolCalls = [];
                    keepaliveInterval = null;
                    completionTokens = 0;
                    reasoningTokens = 0;
                    const chatStreamWriter = createChatStreamWriter({
                        res,
                        id,
                        model: `${pID}/${mID}`
                    });

                    const ensureKeepalive = () => {
                        if (!keepaliveInterval) {
                            keepaliveInterval = setInterval(() => {
                                if (!res.destroyed) {
                                    res.write(': keepalive\n\n');
                                }
                            }, 15000);
                        }
                    };
                    ensureKeepalive();

                    /**
                     * @param {string} delta Text delta.
                     * @param {boolean} [isReasoning] Whether the delta is reasoning text.
                     * @returns {void}
                     */
                    const sendDelta = (delta, isReasoning = false) => {
                        if (!delta) return;
                        if (isReasoning) rawStreamedReasoning += delta;
                        else rawStreamedContent += delta;
                        const parsedDeltaToolCalls = isReasoning
                            ? parseReasoningToolCalls(delta)
                            : parseContentToolCalls(delta);
                        parsedDeltaToolCalls.forEach((toolCall) => {
                            streamedToolCalls.push(toolCall);
                            chatStreamWriter.toolCall(toolCall, streamedToolCalls.length - 1);
                        });
                        const filtered = isReasoning
                            ? filterReasoningDelta(delta)
                            : filterContentDelta(delta);
                        if (!filtered) return;
                        if (isReasoning) {
                            streamedReasoning += filtered;
                            reasoningTokens += Math.ceil(filtered.length / 4);
                        } else {
                            streamedContent += filtered;
                            completionTokens += Math.ceil(filtered.length / 4);
                        }
                        // Reasoning and answer remain separate wire fields; the writer owns
                        // only the Chat Completions SSE framing.
                        chatStreamWriter.delta(filtered, isReasoning);
                    };

                    let collected = null;
                    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                        if (attempt > 1) {
                            // Retry on a fresh session: the failed attempt left an errored
                            // assistant message in the old one, and re-prompting the same
                            // session would append a duplicate user turn to the context.
                            // Safe to rotate because nothing has been streamed yet.
                            try {
                                await client.session.delete({ path: { id: sessionId } });
                            } catch (e) {
                                logDebug('Failed to delete retried session', {
                                    sessionId,
                                    error: /** @type {Error} */ (e).message
                                });
                            }
                            sessionId = await createSession(toolControl);
                            promptParams.path.id = sessionId;
                            // The retry session is empty, so nothing from the old one
                            // qualifies as this turn's answer, and it needs the full
                            // history rather than the delta the old session got.
                            turnBaseline = null;
                            await rebuildPromptPartsForNewSession();
                            requestForcedChatToolCall = makeForcedChatToolCallRequester();
                            streamedContent = '';
                            streamedReasoning = '';
                            rawStreamedContent = '';
                            rawStreamedReasoning = '';
                            streamedToolCalls.length = 0;
                            completionTokens = 0;
                            reasoningTokens = 0;
                            await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                        }
                        try {
                            const collectPromise = collectFromEvents(
                                sessionId,
                                REQUEST_TIMEOUT_MS,
                                sendDelta,
                                EVENT_FIRST_DELTA_TIMEOUT_MS,
                                EVENT_IDLE_TIMEOUT_MS,
                                turnBaseline,
                                turnAbort.signal
                            );
                            /** @type {Promise<CollectedTurn>} */
                            const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                            client.session
                                .prompt(promptParams)
                                .catch((/** @type {Error} */ err) => logDebug('Prompt error:', err.message));
                            collected = await safeCollect;
                        } catch (e) {
                            logDebug('Stream error:', /** @type {Error} */ (e).message);
                        }

                        const attemptError = collected?.error || collected?.__error || null;
                        const nothingStreamed =
                            !rawStreamedContent && !rawStreamedReasoning && streamedToolCalls.length === 0;
                        if (
                            attemptError &&
                            nothingStreamed &&
                            attempt < RETRY_MAX_ATTEMPTS &&
                            isTransientUpstreamError(attemptError)
                        ) {
                            logWarn(
                                `[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`,
                                attemptError.data?.message ||
                                    attemptError.message ||
                                    attemptError.name ||
                                    'unknown'
                            );
                            continue;
                        }
                        break;
                    }

                    if (collected?.clientClosed) {
                        logDebug('Client closed the stream; ending the turn', { sessionId });
                        return;
                    }

                    if (collected && collected.__error) {
                        logDebug('SSE collect error, falling back to polling', {
                            sessionId,
                            error: collected.__error?.message
                        });
                        const { content, reasoning, error } = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                        if (error && !content && !reasoning) {
                            sendDelta(
                                `[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`
                            );
                        } else {
                            if (reasoning) sendDelta(reasoning, true);
                            if (content) sendDelta(content, false);
                        }
                    } else if (collected && collected.noData) {
                        logDebug('Fallback to polling (stream)', { sessionId });
                        const { content, reasoning, error } = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                        if (error && !content && !reasoning) {
                            sendDelta(
                                `[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`
                            );
                        } else {
                            if (reasoning) sendDelta(reasoning, true);
                            if (content) sendDelta(content, false);
                        }
                    } else if (collected && collected.idleTimeout) {
                        logDebug('SSE idle timeout, polling for completion', { sessionId });
                        const { content, reasoning, error } = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                        if (error && !content && !reasoning) {
                            sendDelta(
                                `[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`
                            );
                        } else {
                            const remainingReasoning =
                                reasoning && reasoning.startsWith(rawStreamedReasoning)
                                    ? reasoning.slice(rawStreamedReasoning.length)
                                    : reasoning;
                            const remainingContent =
                                content && content.startsWith(rawStreamedContent)
                                    ? content.slice(rawStreamedContent.length)
                                    : content;
                            if (remainingReasoning) sendDelta(remainingReasoning, true);
                            if (remainingContent) sendDelta(remainingContent, false);
                        }
                    }

                    if (
                        collected &&
                        !streamedContent &&
                        !streamedReasoning &&
                        (collected.reasoning || collected.content)
                    ) {
                        if (collected.reasoning) sendDelta(collected.reasoning, true);
                        if (collected.content) sendDelta(collected.content, false);
                    }

                    if (!streamedContent && !streamedReasoning) {
                        logDebug('SSE returned empty, falling back to polling', { sessionId });
                        const { content, reasoning, error } = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                        if (error && !content && !reasoning) {
                            sendDelta(
                                `[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`
                            );
                        } else {
                            if (reasoning) sendDelta(reasoning, true);
                            if (content) sendDelta(content, false);
                        }
                    } else if (streamedReasoning && !streamedContent) {
                        // Reconciliation for reasoning models: the reasoning streamed but the
                        // answer text never arrived because every delta was tagged as reasoning
                        // (issue #9). The message snapshot separates the two correctly, so
                        // recover the missing answer from it instead of returning empty content.
                        logDebug('Reasoning streamed but no content, reconciling from snapshot', {
                            sessionId
                        });
                        const snapshot = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        ).catch(() => null);
                        if (snapshot && snapshot.content) {
                            const remainingContent = rawStreamedContent
                                ? snapshot.content.slice(rawStreamedContent.length)
                                : snapshot.content;
                            if (remainingContent) sendDelta(remainingContent, false);
                        }
                    }

                    // Flush held buffers from the stream parsers and filters before final batch parse.
                    const flushedReasoningCalls = parseReasoningToolCalls.flush
                        ? parseReasoningToolCalls.flush()
                        : [];
                    const flushedContentCalls = parseContentToolCalls.flush
                        ? parseContentToolCalls.flush()
                        : [];
                    const flushedReasoningText = filterReasoningDelta.flush
                        ? filterReasoningDelta.flush()
                        : '';
                    const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                    const finalReasoningText = rawStreamedReasoning + flushedReasoningText;
                    const finalContentText = rawStreamedContent + flushedContentText;

                    // Parse each channel, then retry on the two joined. Models sometimes open a
                    // block in reasoning and close it in content, leaving neither channel with a
                    // complete block. The joined retry only runs when nothing was found, so a
                    // block contained in one channel is never counted twice.
                    const parseStreamedToolCalls = () => {
                        if (externalToolRegistry.length === 0) return [];
                        const perChannel = [
                            ...flushedReasoningCalls,
                            ...flushedContentCalls,
                            ...parseExternalToolCallsFromText(
                                externalToolRegistry,
                                finalReasoningText,
                                finalContentText
                            )
                        ];
                        if (perChannel.length > 0) return perChannel;
                        return parseExternalToolCallsFromText(
                            externalToolRegistry,
                            finalReasoningText + finalContentText
                        );
                    };

                    let parsedToolCalls =
                        streamedToolCalls.length > 0 ? streamedToolCalls : parseStreamedToolCalls();
                    if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                        const forcedResponse = await requestForcedChatToolCall();
                        if (forcedResponse) {
                            parsedToolCalls = parseExternalToolCallsFromText(
                                externalToolRegistry,
                                forcedResponse.reasoning,
                                forcedResponse.content
                            );
                        }
                    }
                    const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(
                        parsedToolCalls,
                        externalToolRegistry
                    );
                    const finalStreamedToolCalls = validatedStreamedToolCalls;
                    if (finalStreamedToolCalls.length > 0 && streamedToolCalls.length === 0) {
                        chatStreamWriter.toolCalls(finalStreamedToolCalls);
                    }

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                    chatStreamWriter.finish(
                        { promptTokens, completionTokens, reasoningTokens },
                        finalStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                    );
                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan?.sentCount,
                        sentDigest: turnPlan?.sentDigest,
                        replyText: streamedContent || null,
                        startKey: derivedIdentity?.startKey || null
                    });
                    chatStreamWriter.done();
                    res.end();
                } else {
                    let content = '';
                    let reasoning = '';
                    let error = null;
                    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                        if (attempt > 1) {
                            // Retry on a fresh session: the failed attempt left an errored
                            // assistant message in the old one, and re-prompting the same
                            // session would append a duplicate user turn to the context.
                            try {
                                await client.session.delete({ path: { id: sessionId } });
                            } catch (e) {
                                logDebug('Failed to delete retried session', {
                                    sessionId,
                                    error: /** @type {Error} */ (e).message
                                });
                            }
                            sessionId = await createSession(toolControl);
                            promptParams.path.id = sessionId;
                            // The retry session is empty, so nothing from the old one
                            // qualifies as this turn's answer, and it needs the full
                            // history rather than the delta the old session got.
                            turnBaseline = null;
                            await rebuildPromptPartsForNewSession();
                            requestForcedChatToolCall = makeForcedChatToolCallRequester();
                            await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                        }
                        const attemptStart = Date.now();
                        await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS, turnAbort.signal);
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - attemptStart, attempt });
                        const collected = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                        content = collected.content || '';
                        reasoning = collected.reasoning || '';
                        error = collected.error || null;
                        // Bounded retry for upstream throttling mislabeled as billing
                        // errors (401 CreditsError etc.); only when nothing usable was
                        // produced, so real failures still surface after RETRY_MAX_ATTEMPTS.
                        if (
                            error &&
                            !content &&
                            !reasoning &&
                            attempt < RETRY_MAX_ATTEMPTS &&
                            isTransientUpstreamError(error)
                        ) {
                            logWarn(
                                `[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`,
                                error.data?.message || error.message || error.name || 'unknown'
                            );
                            continue;
                        }
                        break;
                    }
                    if (error && !content && !reasoning) {
                        // Nothing usable came back, and the session is left holding a
                        // failed turn: close it so the conversation starts clean next
                        // time instead of leaking a full-history session nothing sweeps.
                        await discardTurnState(conversationKey, sessionId);
                        res.status(502).json({
                            error: {
                                message: error.data?.message || error.message || 'OpenCode provider error',
                                type: error.name || 'OpenCodeError'
                            }
                        });
                        return;
                    }
                    let parsedToolCalls =
                        externalToolRegistry.length > 0
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                    if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                        const forcedResponse = await requestForcedChatToolCall();
                        if (forcedResponse) {
                            content = forcedResponse.content || content;
                            reasoning = forcedResponse.reasoning || reasoning;
                            parsedToolCalls = parseExternalToolCallsFromText(
                                externalToolRegistry,
                                reasoning,
                                content
                            );
                        }
                    }
                    const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(
                        parsedToolCalls,
                        externalToolRegistry
                    );
                    const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                    const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

                    const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                    const completionTokensCalc = Math.ceil((content || '').length / 4);
                    const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
                    const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

                    const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
                    // Reasoning is emitted in its own `reasoning_content` field so clients
                    // can surface the thinking without it being wrapped in <think> tags and
                    // mixed into the answer `content`.
                    /** @type {AssistantMessageOut} */
                    const assistantMessage = {
                        role: 'assistant',
                        content: publicValidatedToolCalls.length > 0 ? safeContent || null : safeContent,
                        ...(safeReasoning ? { reasoning_content: safeReasoning } : {})
                    };
                    if (publicValidatedToolCalls.length > 0) {
                        assistantMessage.tool_calls = publicValidatedToolCalls;
                    }

                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan?.sentCount,
                        sentDigest: turnPlan?.sentDigest,
                        replyText: safeContent || '',
                        startKey: derivedIdentity?.startKey || null
                    });

                    res.json({
                        id: `chatcmpl-${crypto.randomUUID()}`,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: `${pID}/${mID}`,
                        choices: [
                            {
                                index: 0,
                                message: assistantMessage,
                                finish_reason: publicValidatedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                            }
                        ],
                        usage: {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokensCalc + reasoningTokensCalc,
                            total_tokens: totalTokens,
                            completion_tokens_details: {
                                reasoning_tokens: reasoningTokensCalc
                            }
                        }
                    });
                }
            } catch (error) {
                logError('[Proxy] API Error:', /** @type {UpstreamErrorLike} */ (error).message);
                logError('[Proxy] Error details:', error);

                if (keepaliveInterval) clearInterval(keepaliveInterval);

                if (res.writableEnded || res.destroyed) {
                    // The client is gone; there is nobody to report to.
                } else if (!res.headersSent) {
                    const transformed = transformUpstreamError(/** @type {UpstreamErrorLike} */ (error));
                    res.status(transformed.statusCode).json({ error: transformed.error });
                } else {
                    res.write(
                        `data: ${JSON.stringify({ error: { message: /** @type {UpstreamErrorLike} */ (error).message } })}\n\n`
                    );
                    res.end();
                }
                // The backend session only has a failed turn left in it, so the
                // conversation must not be pointed at it any more.
                await discardTurnState(conversationKey, sessionId);
            } finally {
                if (typeof releaseConversationLock === 'function') releaseConversationLock();
                if (typeof releaseTurnCapacity === 'function') releaseTurnCapacity();
                if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval)
                    clearInterval(keepaliveInterval);
                if (eventStream && eventStream.close) {
                    eventStream.close();
                }
            }
        } catch (error) {
            logError('[Proxy] Request Handler Error:', /** @type {UpstreamErrorLike} */ (error).message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: /** @type {UpstreamErrorLike} */ (error).message,
                        type: /** @type {UpstreamErrorLike} */ (error).constructor.name
                    }
                });
            }
        }
    };

    /**
     * `POST /v1/responses`.
     *
     * @param {import('express').Request} req Incoming request.
     * @param {import('express').Response} res Response to write.
     * @returns {Promise<unknown>} The response, or undefined when already sent.
     */
    const handleResponses = async (req, res) => {
        /** @type {string|null} */
        let conversationKey = null;
        let turnPlan = null;
        /** @type {import('../conversation/baseline.js').SessionBaseline|null} */
        let turnBaseline = null;
        /** @type {(() => void)|null} */
        let releaseConversationLock = null;
        /** @type {(() => void)|null} */
        let releaseTurnCapacity = null;
        // Aborted when the client disconnects, so a streaming turn does not hold
        // its conversation lock until the idle or request timeout fires.
        const turnAbort = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) turnAbort.abort();
        });
        try {
            const {
                model,
                input,
                reasoning_effort,
                reasoning: requestReasoning,
                max_output_tokens,
                tools = [],
                tool_choice,
                instructions,
                temperature,
                top_p,
                stream = false,
                messages: chatMessages,
                prompt,
                previous_response_id: previousResponseId,
                opencode: requestOpencodeConfig
            } = req.body;

            // Stateful continuation: reuse the session behind a previous response so the
            // client only needs to send the new turn (OpenAI Responses API semantics).
            const previousState = previousResponseId ? getResponseState(previousResponseId) : null;

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                null
            );

            const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
            const toolMode = requestToolContext.mode;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/responses'
            });
            logDebug('Responses API request', {
                model,
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                toolMode,
                internalAllowedTools: internalToolContext.allowedToolNames,
                requestedInternalTools: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode
            });
            const externalToolContext = requestToolContext.external;
            const externalToolRegistry = externalToolContext.registry;
            const externalToolChoice = externalToolContext.toolChoice;
            /** @type {Map<string|undefined, string|undefined>} */
            const assistantToolCalls = new Map();

            /**
             * @param {string|undefined} toolCallId Call id.
             * @param {string|undefined} toolName Namespaced name.
             * @returns {void}
             */
            const rememberAssistantToolCall = (toolCallId, toolName) => {
                if (!toolCallId || !toolName) return;
                assistantToolCalls.set(toolCallId, toolName);
            };

            /**
             * @param {ResponsesItem} [item] Tool-result item.
             * @returns {string|null} `TOOL_RESULT: {...}` line, or null when empty.
             */
            const buildResponsesToolResultLine = (item = {}) => {
                const text = normalizeToolResultContent(
                    item?.content ?? item?.output ?? item?.result ?? item?.text
                );
                if (!text) return null;
                const mappedTool =
                    findExternalToolByName(externalToolRegistry, item?.name) ||
                    findExternalToolByName(
                        externalToolRegistry,
                        assistantToolCalls.get(item?.call_id || item?.tool_call_id)
                    );
                const toolName =
                    mappedTool?.namespacedName ||
                    assistantToolCalls.get(item?.call_id || item?.tool_call_id) ||
                    item?.name ||
                    `${EXTERNAL_TOOL_PREFIX}unknown`;
                const toolCallId =
                    item?.call_id || item?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                rememberAssistantToolCall(toolCallId, toolName);
                return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
            };

            /**
             * @param {ResponsesItem} [item] Assistant item.
             * @returns {string|null} `ASSISTANT: <function_calls>[...]</function_calls>`, or null.
             */
            const buildResponsesAssistantToolCallsLine = (item = {}) => {
                const sourceCalls = Array.isArray(item?.tool_calls)
                    ? item.tool_calls
                    : item?.type === 'function_call'
                      ? [item]
                      : [];
                if (!sourceCalls.length) return null;
                const serializedToolCalls = sourceCalls
                    .map((toolCall, index) => {
                        const rawName = toolCall?.function?.name || toolCall?.name;
                        const mappedTool = findExternalToolByName(externalToolRegistry, rawName);
                        const namespacedName = mappedTool?.namespacedName || rawName;
                        if (!namespacedName) return null;
                        const toolCallId = toolCall?.call_id || toolCall?.id || `call_${index + 1}`;
                        rememberAssistantToolCall(toolCallId, namespacedName);
                        return {
                            id: toolCallId,
                            name: namespacedName,
                            arguments: normalizeToolArguments(
                                toolCall?.arguments ?? toolCall?.function?.arguments
                            )
                        };
                    })
                    .filter(Boolean);
                if (!serializedToolCalls.length) return null;
                return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
            };

            /**
             * @param {unknown} rawItems Items from the request.
             * @returns {ChatMessage[]} Messages in the chat shape.
             */
            const buildResponsesInputMessages = (rawItems) => {
                /** @type {ChatMessage[]} */
                const normalized = [];
                if (!Array.isArray(rawItems)) return normalized;
                for (const item of rawItems) {
                    if (!item) continue;

                    if (
                        item.type === 'function_call_output' ||
                        item.type === 'tool_result' ||
                        item.role === 'tool'
                    ) {
                        const toolResultLine = buildResponsesToolResultLine(item);
                        if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
                        continue;
                    }

                    if (item.type === 'function_call') {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine)
                            normalized.push({
                                role: 'assistant',
                                content: assistantToolCallsLine,
                                isToolCalls: true
                            });
                        continue;
                    }

                    if (
                        item.role === 'assistant' &&
                        Array.isArray(item?.tool_calls) &&
                        item.tool_calls.length
                    ) {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine)
                            normalized.push({
                                role: 'assistant',
                                content: assistantToolCallsLine,
                                isToolCalls: true
                            });
                    }

                    if (item.type === 'message') {
                        const role = item.role || 'user';
                        const content = normalizeTextContent(item.content);
                        if (content) normalized.push({ role, content });
                        continue;
                    }

                    if (item.type === 'input_text') {
                        if (item.text) normalized.push({ role: 'user', content: item.text });
                        continue;
                    }

                    const text = normalizeTextContent(item.content || item.text);
                    if (text) normalized.push({ role: item.role || 'user', content: text });
                }
                return normalized;
            };

            /** @type {ChatMessage[]} */
            let messages = [];
            if (Array.isArray(chatMessages) && chatMessages.length) {
                messages = buildResponsesInputMessages(chatMessages);
            } else if (typeof prompt === 'string' && prompt.trim()) {
                messages = [{ role: 'user', content: prompt }];
            } else if (typeof input === 'string' && input.trim()) {
                messages = [{ role: 'user', content: input }];
            } else if (Array.isArray(input)) {
                messages = buildResponsesInputMessages(input);
            } else if (input && typeof input === 'object') {
                if (
                    input.type === 'message' ||
                    input.type === 'function_call' ||
                    input.type === 'function_call_output' ||
                    input.type === 'tool_result'
                ) {
                    messages = buildResponsesInputMessages([input]);
                } else {
                    const content = normalizeTextContent(input.content || input.text);
                    if (content) {
                        messages = [{ role: input.role || 'user', content }];
                    }
                }
            }

            if (!messages.length) {
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            const resolvedModel = await resolveRequestedModel(model || previousState?.model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;

            // A direct turn never consults our own response store: the upstream
            // hands out the response ids the client chains with.
            const servingMode = router.shouldUseDirect(pID, mID).direct ? 'direct' : 'runtime';
            if (previousResponseId && !previousState && servingMode === 'runtime') {
                return res
                    .status(400)
                    .json({ error: { message: 'Invalid or expired previous_response_id' } });
            }

            if (servingMode === 'direct') {
                const deliverableMessages = conversationDeliverableMessages(messages);
                const conversationScope = conversationScopeForTurn(
                    pID,
                    mID,
                    toolMode,
                    toolsFingerprintFor(tools, tool_choice),
                    'direct'
                );
                const resolvedDirectTurn = await resolveConversationTurn({
                    req,
                    deliverable: deliverableMessages,
                    scope: conversationScope
                });
                conversationKey = resolvedDirectTurn.key;
                releaseConversationLock = resolvedDirectTurn.release;
                if (resolvedDirectTurn.busy) {
                    return res.status(503).json(conversationBusyBody());
                }
                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;
                const sessionId =
                    resolvedDirectTurn.entry?.mode === 'direct' && resolvedDirectTurn.entry.sessionId
                        ? resolvedDirectTurn.entry.sessionId
                        : newSessionId();
                const turnPlanForDirect = resolvedDirectTurn.plan;
                const directIdentity = resolvedDirectTurn.identity;
                const { opencode: _omitProxyExtension, ...upstreamBody } = req.body || {};

                const directResult = await runDirectTurn({
                    path: '/responses',
                    res,
                    providerID: pID,
                    modelID: mID,
                    sessionId,
                    body: { ...upstreamBody, model: mID },
                    stream,
                    clientModelName: `${pID}/${mID}`,
                    signal: turnAbort.signal,
                    fallbackTurn: { providerID: pID, modelID: mID, key: conversationKey, mode: 'direct' },
                    onSuccess: (answerText) =>
                        storeConversationEntry(conversationKey, {
                            sessionId,
                            mode: 'direct',
                            sentCount: turnPlanForDirect?.sentCount,
                            sentDigest: turnPlanForDirect?.sentDigest,
                            replyText: typeof answerText === 'string' ? answerText : null,
                            startKey: directIdentity?.startKey || null
                        })
                });
                if (directResult.handled) return;
                // Falling back to the runtime: hand the conversation lock back first,
                // because the runtime path resolves the same conversation and takes it.
                if (typeof releaseConversationLock === 'function') releaseConversationLock();
                releaseConversationLock = null;
                logWarn(
                    `[Proxy] Serving ${pID}/${mID} through the local runtime after the direct upstream refused it`
                );
            }

            await ensureBackend();

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch {
                // Best effort: a failed model switch must not fail the turn.
            }

            // Continue the stored session when chaining from previous_response_id;
            // otherwise reuse the session bound to the client's conversation header,
            // or start a fresh one. With the tool-lock plugin, a chained session
            // keeps the policy it was created with, so toolControl.title only
            // matters for new sessions.
            const toolControl = await resolveToolControl(toolMode, internalToolContext);
            const deliverableMessages = conversationDeliverableMessages(messages);
            const conversationScope = conversationScopeForTurn(
                pID,
                mID,
                toolMode,
                toolsFingerprintFor(tools, tool_choice),
                'runtime'
            );
            const resolvedTurn = await resolveConversationTurn({
                req,
                deliverable: deliverableMessages,
                scope: conversationScope,
                previousSessionId: previousState?.sessionId || null
            });
            conversationKey = resolvedTurn.key;
            releaseConversationLock = resolvedTurn.release;
            if (resolvedTurn.busy) {
                return res.status(503).json(conversationBusyBody());
            }
            if (!releaseTurnCapacity) {
                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;
            }
            turnPlan = resolvedTurn.plan;
            const derivedIdentity =
                resolvedTurn.identity?.source === 'derived' ? resolvedTurn.identity : null;

            let sessionId = resolvedTurn.sessionId;
            if (!sessionId) {
                if (resolvedTurn.entry?.sessionId) {
                    await registry.discard({ key: conversationKey });
                }
                sessionId = await createSession(toolControl);
                logDebug('Session created', {
                    sessionId,
                    historyRewritten: turnPlan?.rewrite,
                    derived: Boolean(derivedIdentity)
                });
            }

            if (turnPlan?.reuse || previousState?.sessionId) {
                turnBaseline = resolvedTurn.baseline;
                if (!turnBaseline || !turnBaseline.ok) {
                    // Answer here, exactly like the chat surface: throwing would send
                    // this through the upstream error mapper, which rewrites any 5xx
                    // into 502 server_error and loses the documented code.
                    return res.status(503).json(sessionStateUnavailableBody());
                }
            }

            const parts = [];
            const systemChunks = [];
            let fullPromptText = '';
            let deliveredCount = -1;
            const includeFromIndex = turnPlan?.reuse ? turnPlan.deltaStartIndex : 0;
            /**
             * @param {string|undefined} role Message role.
             * @param {ChatMessagePart[]|string|null|undefined} text Rendered text.
             * @returns {string} `ROLE: text` line.
             */
            const formatResponsesRoleLine = (role, text) =>
                `${String(role || 'user').toUpperCase()}: ${text}`;
            for (const msg of messages) {
                if (msg.role === 'system') {
                    if (msg.content) systemChunks.push(msg.content);
                    continue;
                }
                deliveredCount += 1;
                if (!msg.content) continue;
                const text =
                    msg.role === 'tool' ||
                    String(msg.content).startsWith('ASSISTANT: ') ||
                    String(msg.content).startsWith('TOOL_RESULT: ')
                        ? msg.content
                        : msg.role === 'user'
                          ? msg.content
                          : formatResponsesRoleLine(msg.role, msg.content);
                // Token accounting covers the whole conversation; only the appended
                // turns are actually sent when the session already holds the rest.
                fullPromptText += `${text}\n\n`;
                if (deliveredCount < includeFromIndex) continue;
                parts.push({ type: 'text', text });
            }

            const systemWithGuard = buildSystemPrompt(
                [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                reasoningLevel,
                toolMode,
                internalToolContext.allowedToolNames
            );

            const requestForcedResponsesToolCall = createForcedToolCallRequester({
                mode: externalToolChoice.mode,
                sessionId,
                systemWithGuard,
                requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                providerID: pID,
                modelID: mID,
                toolOverrides: toolControl.toolOverrides,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                baselineProvider: () => snapshotSessionState(sessionId),
                signal: turnAbort.signal,
                forbidThinkBlock: false
            });

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts: externalToolContext.reminder
                        ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                        : parts,
                    ...(max_output_tokens && { max_tokens: max_output_tokens }),
                    ...(temperature !== undefined && { temperature }),
                    ...(top_p !== undefined && { top_p })
                }
            };
            const { toolOverrides } = toolControl;
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                promptParams.body.tools = toolOverrides;
            }

            let content = '';
            let reasoning = '';
            if (stream) {
                const responsesStreamWriter = createResponsesStreamWriter({
                    res,
                    model: `${pID}/${mID}`
                });
                const { responseId, streamedToolCalls } = responsesStreamWriter;
                responsesStreamWriter.start();

                const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                /** @type {ToolCallFilterWithFlush} */
                const filterContentDelta = /** @type {ToolCallFilterWithFlush} */ (
                    createToolCallFilter({
                        disableTools: DISABLE_TOOLS,
                        forceStrip: shouldStripStreamingToolMarkup
                    })
                );
                /** @type {ToolCallFilterWithFlush} */
                const filterReasoningDelta = /** @type {ToolCallFilterWithFlush} */ (
                    createToolCallFilter({
                        disableTools: DISABLE_TOOLS,
                        forceStrip: shouldStripStreamingToolMarkup
                    })
                );
                /** @type {ExternalToolCallParserWithFlush} */
                const parseContentToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                    createExternalToolCallStreamParser(externalToolRegistry)
                );
                /** @type {ExternalToolCallParserWithFlush} */
                const parseReasoningToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                    createExternalToolCallStreamParser(externalToolRegistry)
                );
                let rawContent = '';
                let rawReasoning = '';
                /**
                 * @param {string} delta Text delta.
                 * @param {boolean} [isReasoning] Whether the delta is reasoning text.
                 * @returns {void}
                 */
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    if (isReasoning) rawReasoning += delta;
                    else rawContent += delta;
                    const parsedDeltaToolCalls = isReasoning
                        ? parseReasoningToolCalls(delta)
                        : parseContentToolCalls(delta);
                    if (parsedDeltaToolCalls.length > 0) {
                        const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(
                            parsedDeltaToolCalls,
                            externalToolRegistry
                        );
                        allowedDeltaToolCalls.forEach((toolCall) =>
                            responsesStreamWriter.functionCall(toolCall)
                        );
                    }
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        reasoning += filtered;
                        responsesStreamWriter.reasoningDelta(filtered);
                    } else {
                        if (!filtered.trim()) {
                            content += filtered;
                            return;
                        }
                        content += filtered;
                        responsesStreamWriter.textDelta(filtered);
                    }
                };

                let collected = null;
                try {
                    const collectPromise = collectFromEvents(
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        sendResponsesDelta,
                        EVENT_FIRST_DELTA_TIMEOUT_MS,
                        EVENT_IDLE_TIMEOUT_MS,
                        turnBaseline,
                        turnAbort.signal
                    );
                    /** @type {Promise<CollectedTurn>} */
                    const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                    client.session
                        .prompt(promptParams)
                        .catch((/** @type {Error} */ err) =>
                            logDebug('Responses prompt error:', err.message)
                        );
                    collected = await safeCollect;
                } catch (e) {
                    collected = { __error: e };
                }

                if (collected?.clientClosed) {
                    logDebug('Client closed the stream; ending the responses turn', { sessionId });
                    return res.end();
                }

                if (!content && !reasoning) {
                    const polled = await pollForAssistantResponse(
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        DEFAULT_POLL_INTERVAL_MS,
                        turnBaseline
                    );
                    if (polled.error && !polled.content && !polled.reasoning) throw polled.error;
                    if (polled.reasoning) sendResponsesDelta(polled.reasoning, true);
                    if (polled.content) sendResponsesDelta(polled.content, false);
                } else if (collected && collected.idleTimeout) {
                    const polled = await pollForAssistantResponse(
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        DEFAULT_POLL_INTERVAL_MS,
                        turnBaseline
                    );
                    const remainingReasoning =
                        polled.reasoning && polled.reasoning.startsWith(rawReasoning)
                            ? polled.reasoning.slice(rawReasoning.length)
                            : polled.reasoning;
                    const remainingContent =
                        polled.content && polled.content.startsWith(rawContent)
                            ? polled.content.slice(rawContent.length)
                            : polled.content;
                    if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
                    if (remainingContent) sendResponsesDelta(remainingContent, false);
                } else if (collected && (collected.content || collected.reasoning)) {
                    if (!reasoning && collected.reasoning) sendResponsesDelta(collected.reasoning, true);
                    if (!content && collected.content) sendResponsesDelta(collected.content, false);
                }

                responsesStreamWriter.finishReasoning(reasoning);
                responsesStreamWriter.finishText(content);

                let polledForToolCalls = null;
                if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
                    try {
                        polledForToolCalls = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                    } catch {
                        // Best effort: polling is optional once the stream produced calls.
                    }
                }

                // Flush held buffers from the stream parsers and filters before final batch parse.
                const flushedReasoningCalls = parseReasoningToolCalls.flush
                    ? parseReasoningToolCalls.flush()
                    : [];
                const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                const finalReasoningText =
                    (polledForToolCalls?.reasoning || rawReasoning) + flushedReasoningText;
                const finalContentText = (polledForToolCalls?.content || rawContent) + flushedContentText;

                // Parse each channel, then retry on the two joined. See the matching comment
                // in /v1/chat/completions for why the joined retry is gated on finding nothing.
                const parseStreamedToolCalls = () => {
                    if (externalToolRegistry.length === 0) return [];
                    const perChannel = [
                        ...flushedReasoningCalls,
                        ...flushedContentCalls,
                        ...parseExternalToolCallsFromText(
                            externalToolRegistry,
                            finalReasoningText,
                            finalContentText
                        )
                    ];
                    if (perChannel.length > 0) return perChannel;
                    return parseExternalToolCallsFromText(
                        externalToolRegistry,
                        finalReasoningText + finalContentText
                    );
                };

                let parsedToolCalls =
                    streamedToolCalls.length > 0 ? streamedToolCalls : parseStreamedToolCalls();
                if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                    const forcedResponse = await requestForcedResponsesToolCall();
                    if (forcedResponse) {
                        parsedToolCalls = parseExternalToolCallsFromText(
                            externalToolRegistry,
                            forcedResponse.reasoning,
                            forcedResponse.content
                        );
                    }
                }
                const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(
                    parsedToolCalls,
                    externalToolRegistry
                );
                const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));
                if (streamedToolCalls.length === 0) {
                    validatedStreamedToolCalls.forEach((toolCall) => {
                        responsesStreamWriter.functionCall(toolCall);
                    });
                }
                const streamOutput = [];
                const streamMessageOutputItem = buildResponsesMessageOutputItem(
                    safeContent && safeContent.trim() ? safeContent : ''
                );
                if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
                validatedStreamedToolCalls.forEach((toolCall) => {
                    streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall));
                });
                const promptTokens = Math.ceil(fullPromptText.length / 4);
                const completionTokens = Math.ceil(content.length / 4);
                const reasoningTokens = Math.ceil(reasoning.length / 4);
                const response = {
                    id: responseId,
                    object: 'response',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    reasoning: safeReasoning
                        ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) }
                        : undefined,
                    output: streamOutput,
                    usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens + reasoningTokens,
                        total_tokens: promptTokens + completionTokens + reasoningTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: reasoningTokens }
                    }
                };
                responsesStreamWriter.complete(response);
                responsesStreamWriter.done();
                storeResponseState(responseId, sessionId, `${pID}/${mID}`);
                // Only turns that went through conversation planning may be registered:
                // a `previous_response_id` turn owns a session this map knows nothing
                // about, and recording it with no delivered-turn count would let the
                // next header-only request evict a session the response chain still uses.
                if (turnPlan) {
                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan.sentCount,
                        sentDigest: turnPlan.sentDigest,
                        replyText: content || null,
                        startKey: derivedIdentity?.startKey || null
                    });
                }
                return res.end();
            }

            const responseRes = await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS, turnAbort.signal);
            const responseParts = responseRes.data?.parts || [];
            const promptContent = responseParts
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n');
            const promptReasoning = responseParts
                .filter((p) => p.type === 'reasoning')
                .map((p) => p.text)
                .join('\n');
            const promptParsedToolCalls =
                externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent)
                    : [];

            content = promptParsedToolCalls.length > 0 ? '' : promptContent;
            reasoning = promptReasoning;

            let promptBasedToolCalls = promptParsedToolCalls;
            const shouldPollForResponses = !promptContent && !promptReasoning;
            if (shouldPollForResponses) {
                const polledResponse = await pollForAssistantResponse(
                    sessionId,
                    REQUEST_TIMEOUT_MS,
                    DEFAULT_POLL_INTERVAL_MS,
                    turnBaseline
                );
                if (polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
                    throw polledResponse.error;
                }
                content = polledResponse.content || content;
                reasoning = polledResponse.reasoning || reasoning;
                promptBasedToolCalls =
                    externalToolRegistry.length > 0
                        ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                        : [];
            }

            if (!content && !reasoning && responseRes.data && promptBasedToolCalls.length === 0) {
                // A tool-only or empty turn has nothing to say: leaving the output
                // empty is the documented behaviour. Serializing the internal
                // payload here used to leak the runtime's part structure to the
                // client as if it were an answer.
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || '';
            }

            let parsedToolCalls =
                promptBasedToolCalls.length > 0
                    ? promptBasedToolCalls
                    : externalToolRegistry.length > 0
                      ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                      : [];
            if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                const forcedResponse = await requestForcedResponsesToolCall();
                if (forcedResponse) {
                    content = forcedResponse.content || content;
                    reasoning = forcedResponse.reasoning || reasoning;
                    parsedToolCalls = parseExternalToolCallsFromText(
                        externalToolRegistry,
                        reasoning,
                        content
                    );
                }
            }
            const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(
                parsedToolCalls,
                externalToolRegistry
            );
            const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
            const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

            const promptTokens = Math.ceil(fullPromptText.length / 4);
            const completionTokens = Math.ceil(content.length / 4);
            const reasoningTokens = Math.ceil(reasoning.length / 4);
            const output = [];
            const messageOutputItem = buildResponsesMessageOutputItem(safeContent);
            if (messageOutputItem) output.push(messageOutputItem);
            validatedToolCalls.forEach((toolCall) => {
                output.push(buildResponsesFunctionCallOutputItem(toolCall));
            });

            const responseId = `resp_${crypto.randomUUID()}`;
            const response = {
                id: responseId,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                reasoning: safeReasoning
                    ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) }
                    : undefined,
                output,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            storeResponseState(responseId, sessionId, `${pID}/${mID}`);
            // See the streaming branch: a `previous_response_id` turn must not
            // register a session the conversation map did not plan for.
            if (turnPlan) {
                storeConversationEntry(conversationKey, {
                    sessionId,
                    sentCount: turnPlan.sentCount,
                    sentDigest: turnPlan.sentDigest,
                    replyText: safeContent || '',
                    startKey: derivedIdentity?.startKey || null
                });
            }

            return res.json(response);
        } catch (error) {
            logError(
                '[Proxy] Responses API Error:',
                /** @type {TurnError} */ (error).message ||
                    /** @type {TurnError} */ (error).data?.message ||
                    /** @type {TurnError} */ (error).name ||
                    error
            );
            // The session is left holding a failed turn: close it when this turn
            // owned it (a previous_response_id chain keeps its own session).
            if (turnPlan) {
                await discardConversationEntry(conversationKey);
            } else {
                await discardTurnState(conversationKey, null);
            }
            const transformed = transformUpstreamError(/** @type {UpstreamErrorLike} */ (error));
            // Once the SSE headers are out, res.json() throws ERR_HTTP_HEADERS_SENT. That throw
            // escapes this async handler as an unhandled rejection, which terminates the whole
            // process under Node's default --unhandled-rejections=throw. Report the failure on
            // the already-open stream instead.
            if (res.headersSent) {
                try {
                    writeResponsesFailure(res, transformed.error);
                } catch (writeError) {
                    logDebug('Failed to report error on open response stream', {
                        error: /** @type {Error} */ (writeError).message
                    });
                }
                return res.end();
            }
            return res.status(transformed.statusCode).json({ error: transformed.error });
        } finally {
            if (typeof releaseConversationLock === 'function') releaseConversationLock();
            if (typeof releaseTurnCapacity === 'function') releaseTurnCapacity();
        }
    };

    return {
        handleChat,
        handleResponses,
        handleHealth,
        handleHealthDetails,
        handleMetrics,
        listModels: getKnownModels,
        resolveRequestedModel,
        getInternalToolDashboard,
        renderMetrics,
        cleanup: cleanupConversationFiles,
        responseChains,
        settings: registry.settings,

        /** Stops the periodic sweep this engine started. @returns {void} */
        close() {
            clearInterval(responseStateSweepTimer);
            storageCleanup.close();
        }
    };
}

export { createResponseChainIndex } from '../conversation/response-chains.js';
