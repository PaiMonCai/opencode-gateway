import crypto from 'crypto';
import { resolveLogger, toBool, toMillis } from './support.js';

/**
 * Direct upstream client.
 *
 * The gateway exists so an OpenAI-format gateway can talk to OpenCode. Two
 * upstream shapes are supported:
 *
 *  - the local OpenCode runtime (required for the Zen free tier, whose gate is
 *    an official-client identity no plain HTTP caller can reproduce), and
 *  - OpenCode's OpenAI-compatible endpoints themselves (`/zen/go/v1` for a Go
 *    subscription, `/zen/v1` for pay-as-you-go Zen), which need nothing more
 *    than a valid key and the conversation header.
 *
 * This module owns the second shape. Both `/chat/completions` and `/responses`
 * exist upstream, so the request body passes through untouched; the only things
 * added are the upstream key, the official client fingerprint, and the stable
 * conversation header. The response is handed back raw so the caller relays
 * upstream errors verbatim, with `model` rewritten back to the client-facing
 * name (including inside Responses events, where it lives on `response.model`).
 *
 * @typedef {object} DirectLabels
 * @property {string} id       Fully qualified `provider/model` id.
 * @property {string} name     Human readable name.
 * @property {string} [object] Always `model`.
 * @property {number} [created] Unix seconds.
 * @property {string} [owned_by] Provider id.
 *
 * @typedef {'free-tier'|'auth'|null} DirectFailureKind
 */

/** Go-subscription base URL. @type {string} */
export const DEFAULT_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** Pay-as-you-go Zen base URL. @type {string} */
export const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
/** What the official client sends; configurable so it can follow upstream. @type {string} */
export const DEFAULT_CLIENT_VERSION = '1.18.34';
/** Model catalog cache lifetime: 10 minutes. @type {number} */
export const DEFAULT_MODEL_CACHE_MS = 10 * 60 * 1000;
/** Path used for chat completions, both upstream dialects. @type {string} */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';
/** Path used for the Responses API. @type {string} */
export const RESPONSES_PATH = '/responses';

/**
 * Pick the direct base URL for a provider.
 *
 * `opencode-go/*` is served from the Go subscription endpoint, everything else
 * (paid Zen) from the Zen endpoint.
 *
 * @param {string} providerID Provider id, e.g. `opencode` or `opencode-go`.
 * @param {{goBaseUrl?: string, zenBaseUrl?: string}} [urls] Overrides.
 * @returns {string} Base URL without a trailing slash.
 */
export function resolveBaseUrlForProvider(providerID, { goBaseUrl, zenBaseUrl } = {}) {
    const go = goBaseUrl || DEFAULT_GO_BASE_URL;
    const zen = zenBaseUrl || DEFAULT_ZEN_BASE_URL;
    return String(providerID || '').toLowerCase() === 'opencode-go' ? go : zen;
}

/**
 * Headers of an official-client request: the fingerprint that makes upstream
 * treat us as OpenCode itself, plus the conversation identity headers.
 *
 * Every value here is observable upstream and relied upon, so the names and the
 * order of precedence are part of the contract:
 * `user-agent`, `x-opencode-client`, `x-opencode-project`, then the optional
 * `authorization`, `x-opencode-session`, `x-opencode-request`.
 *
 * @param {object} [options] Header inputs.
 * @param {string} [options.apiKey] Upstream key -> `authorization`.
 * @param {string} [options.sessionId] Conversation identity -> `x-opencode-session`.
 * @param {string} [options.requestId] Per-request id -> `x-opencode-request`.
 * @param {string} [options.clientVersion] Version inside the user agent.
 * @param {Record<string, string>} [options.extraHeaders] Applied before the
 *   identity headers, so they cannot be overwritten by accident.
 * @returns {Record<string, string>} Lowercase header map.
 */
export function buildDirectHeaders({
    apiKey,
    sessionId,
    requestId,
    clientVersion = DEFAULT_CLIENT_VERSION,
    extraHeaders = {}
} = {}) {
    /** @type {Record<string, string>} */
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': `opencode/${clientVersion} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`,
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        ...extraHeaders
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (sessionId) headers['x-opencode-session'] = sessionId;
    if (requestId) headers['x-opencode-request'] = requestId;
    return headers;
}

/** `msg_` + lowercase hex, matching the shape the official client sends. @returns {string} */
export const newRequestId = () => `msg_${crypto.randomBytes(12).toString('hex')}`;

/** `ses_` + lowercase hex conversation identity for the direct upstream. @returns {string} */
export const newSessionId = () => `ses_${crypto.randomBytes(12).toString('hex')}`;

/**
 * Join a base URL and a path without doubling or dropping slashes.
 *
 * @param {unknown} baseUrl Base URL.
 * @param {unknown} path Path beginning with `/`.
 * @returns {string} Absolute URL.
 */
export function joinUrl(baseUrl, path) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

/**
 * Whether a direct upstream status means the configured key was rejected.
 *
 * @param {number} status HTTP status.
 * @returns {boolean} True for 401 and 403.
 */
export function isDirectAuthFailure(status) {
    return status === 401 || status === 403;
}

/**
 * The free tier answers `403 FreeTierError` for models it only serves to the
 * official client. That is a property of the model, not of the request, so the
 * caller can remember it and stop asking.
 *
 * @param {number} status HTTP status.
 * @param {string} [bodyText] Response body text.
 * @returns {boolean} True when this is a free-tier refusal.
 */
export function isFreeTierRefusal(status, bodyText) {
    if (status !== 403) return false;
    return /FreeTierError|free tier can only be used/i.test(String(bodyText || ''));
}

/**
 * Classify a direct failure so the router knows which fallback to apply.
 *
 * @param {number} status HTTP status from the direct upstream.
 * @param {string} [bodyText] Response body text.
 * @returns {DirectFailureKind} `'free-tier'`, `'auth'`, or `null` when the
 *   response should be relayed verbatim instead.
 */
export function classifyDirectFailure(status, bodyText) {
    if (isFreeTierRefusal(status, bodyText)) return 'free-tier';
    if (isDirectAuthFailure(status)) return 'auth';
    return null;
}

/**
 * Rewrite the `model` fields of one upstream payload in place.
 *
 * Responses events carry the model inside the nested response object, which is
 * why this is not a single assignment.
 *
 * @param {Record<string, any>} payload Parsed JSON payload.
 * @param {string} modelName Client-facing model name.
 * @returns {boolean} True when anything was rewritten.
 */
export function rewriteModelFields(payload, modelName) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    if (payload.model !== undefined) {
        payload.model = modelName;
        changed = true;
    }
    if (payload.response && typeof payload.response === 'object' && payload.response.model !== undefined) {
        payload.response.model = modelName;
        changed = true;
    }
    return changed;
}

/**
 * Record separators allowed by the SSE spec, longest first so a CRLF blank line
 * is never split into a shorter match.
 *
 * @type {readonly string[]}
 */
const SSE_RECORD_SEPARATORS = Object.freeze(['\r\n\r\n', '\n\n', '\r\r']);

/**
 * Find the earliest record separator in `text`.
 *
 * @param {string} text Buffered stream text.
 * @returns {{index: number, separator: string}|null} Boundary, or `null` when no
 *   complete record is buffered yet.
 */
function findRecordBoundary(text) {
    let best = null;
    for (const separator of SSE_RECORD_SEPARATORS) {
        const index = text.indexOf(separator);
        if (index === -1) continue;
        if (
            !best ||
            index < best.index ||
            (index === best.index && separator.length > best.separator.length)
        ) {
            best = { index, separator };
        }
    }
    return best;
}

/**
 * Matches one `data:` record and keeps its exact framing: the `data:` prefix,
 * the payload line and the trailing whitespace (which may be absent on a
 * truncated tail record). The payload line stops at either line terminator, so
 * a CRLF record does not lose its `\r` into the payload.
 *
 * @type {RegExp}
 */
const SSE_DATA_RECORD = /^(data:[^\S\r\n]*)([^\r\n]*)([\s\S]*)$/;

/**
 * Rewrite one raw SSE record so its `model` fields carry the client-facing
 * name. Records that are not JSON, keepalives and `[DONE]` pass through
 * byte-for-byte, and a rewritten record keeps its original framing — including
 * CRLF separators and a missing trailing blank line on a tail record, which is
 * never synthesized.
 *
 * @param {string} record Raw SSE record, with whatever terminator it arrived with.
 * @param {string} modelName Client-facing model name.
 * @returns {string} The record to forward.
 */
export function rewriteSseRecord(record, modelName) {
    if (!modelName) return record;
    const match = SSE_DATA_RECORD.exec(record);
    if (!match) return record;
    const [, prefix, payloadLine, trailing] = match;
    const payloadText = payloadLine.trim();
    if (!payloadText || payloadText === '[DONE]') return record;
    try {
        const payload = JSON.parse(payloadText);
        if (!rewriteModelFields(payload, modelName)) return record;
        return `${prefix}${JSON.stringify(payload)}${trailing}`;
    } catch {
        return record;
    }
}

/**
 * Rewrite the `model` field of an SSE stream (chat chunks and Responses events
 * alike) so the client keeps seeing the model name it asked for, without
 * buffering or reordering anything else.
 *
 * Records are split on the separators the SSE spec allows (`\n\n`, `\r\n\r\n`,
 * `\r\r`) and are forwarded with their original separator bytes. A tail record
 * without a terminator is flushed as-is at the end.
 *
 * @param {AsyncIterable<Uint8Array>} source Upstream body stream.
 * @param {string} modelName Client-facing model name.
 * @returns {AsyncGenerator<Uint8Array>} Rewritten byte stream.
 */
export async function* rewriteSseModel(source, modelName) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = findRecordBoundary(buffer);
        while (boundary) {
            const end = boundary.index + boundary.separator.length;
            const record = buffer.slice(0, end);
            buffer = buffer.slice(end);
            yield encoder.encode(rewriteSseRecord(record, modelName));
            boundary = findRecordBoundary(buffer);
        }
    }
    buffer += decoder.decode();
    if (buffer) yield encoder.encode(rewriteSseRecord(buffer, modelName));
}

/**
 * Best-effort answer text of one relayed SSE chunk, used only to fingerprint
 * the answer a client may echo back on the next turn.
 *
 * @param {Uint8Array|string} chunk Raw SSE chunk.
 * @returns {string} Delta text, or `''` when the chunk carries none.
 */
export function collectSseDeltaText(chunk) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!text.startsWith('data:')) return '';
    const payloadText = text.replace(/^data:\s*/, '').trim();
    if (!payloadText || payloadText === '[DONE]') return '';
    try {
        const payload = JSON.parse(payloadText);
        const delta = payload?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') return delta.content;
        if (typeof payload?.choices?.[0]?.text === 'string') return payload.choices[0].text;
        // Responses API events stream answer text as typed deltas.
        if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string')
            return payload.delta;
    } catch {
        // Partial records are ignored; the fingerprint is best effort.
    }
    return '';
}

/**
 * Answer text of a non-streaming payload, in either upstream dialect.
 *
 * @param {Record<string, any>} payload Parsed response body.
 * @returns {string|null} Assistant text, or `null` when the shape is unknown.
 */
export function extractAssistantText(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const chatContent = payload.choices?.[0]?.message?.content;
    if (typeof chatContent === 'string') return chatContent;
    if (Array.isArray(payload.output)) {
        return payload.output
            .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join('');
    }
    return null;
}

/**
 * Send one upstream request. Returns the raw response so the caller decides how
 * to relay it.
 *
 * The caller owns cancellation: pass `signal` (typically a per-turn
 * `AbortController` tied to the client socket). `timeoutMs` is an extra safety
 * net and is only armed when positive; `0` means "no local timer".
 *
 * @param {object} options Request options.
 * @param {string} [options.baseUrl] Upstream base, e.g. `https://opencode.ai/zen/go/v1`.
 * @param {string} [options.path] `/chat/completions` or `/responses`.
 * @param {string} [options.apiKey] Bearer key for the upstream.
 * @param {string} [options.sessionId] Conversation identity -> `x-opencode-session`.
 * @param {string} [options.requestId] Per-request id -> `x-opencode-request`.
 * @param {Record<string, any>} [options.body] Request body, already in the upstream dialect.
 * @param {AbortSignal|null} [options.signal] Caller-owned abort signal.
 * @param {number} [options.timeoutMs=0] Local timeout; `0` disables it.
 * @param {string} [options.clientVersion] Fingerprint user-agent version.
 * @param {Record<string, string>} [options.extraHeaders] Extra headers.
 * @param {typeof fetch} [options.fetchImpl] Fetch implementation.
 * @returns {Promise<Response>} The raw upstream response.
 */
export async function requestUpstream({
    baseUrl,
    path,
    apiKey,
    sessionId,
    requestId,
    body,
    signal = null,
    timeoutMs = 0,
    clientVersion = DEFAULT_CLIENT_VERSION,
    extraHeaders = {},
    fetchImpl = globalThis.fetch
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('No fetch implementation available for the direct upstream');
    }
    let timer = null;
    let combinedSignal = signal;
    let onCallerAbort = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
        const controller = new AbortController();
        onCallerAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onCallerAbort, { once: true });
        }
        timer = setTimeout(() => controller.abort(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        combinedSignal = controller.signal;
    }

    try {
        return await fetchImpl(joinUrl(baseUrl, path), {
            method: 'POST',
            headers: buildDirectHeaders({ apiKey, sessionId, requestId, clientVersion, extraHeaders }),
            body: JSON.stringify(body),
            signal: combinedSignal
        });
    } finally {
        if (timer) clearTimeout(timer);
        if (signal && onCallerAbort) signal.removeEventListener('abort', onCallerAbort);
    }
}

/**
 * Cached model catalogs of the direct upstreams. `/models` is public, so this
 * works even when the runtime (and its provider catalog) is not available.
 *
 * Failure semantics: a failed or empty refresh keeps the last good list; only a
 * successful non-empty fetch replaces the cache. `getModels()` never throws.
 *
 * @param {object} [options] Catalog options.
 * @param {typeof fetch} [options.fetchImpl] Fetch implementation.
 * @param {number} [options.ttlMs] Cache lifetime, default 10 minutes.
 * @param {any} [options.logger] Logger dependency.
 * @returns {{getModels: (options?: Record<string, any>) => Promise<DirectLabels[]>, invalidate: () => void}}
 *   Cached catalog accessor.
 */
export function createModelCatalog({
    fetchImpl = globalThis.fetch,
    ttlMs = DEFAULT_MODEL_CACHE_MS,
    logger = null
} = {}) {
    const log = resolveLogger(logger, 'upstreams/catalog');
    /** @type {DirectLabels[]|null} */
    let cached = null;
    let cachedAt = 0;

    /**
     * Fetch one provider's catalog and map it to client-facing model entries.
     *
     * @param {string} providerID Provider id used as the `owned_by` value.
     * @param {string} baseUrl Upstream base URL.
     * @param {string} [apiKey] Upstream key.
     * @param {string} [clientVersion] Fingerprint version.
     * @returns {Promise<DirectLabels[]>} Models, or `[]` on any failure.
     */
    const fetchOne = async (providerID, baseUrl, apiKey, clientVersion) => {
        try {
            const response = await fetchImpl(joinUrl(baseUrl, '/models'), {
                headers: buildDirectHeaders({ apiKey, clientVersion })
            });
            if (!response.ok) {
                log.warn('Upstream model catalog responded with an error', {
                    providerID,
                    status: response.status
                });
                return [];
            }
            const payload = /** @type {{data?: Array<Record<string, any>>}} */ (await response.json());
            return (payload?.data || [])
                .filter((model) => model?.id)
                .map((model) => ({
                    id: `${providerID}/${model.id}`,
                    name: model.name || model.id,
                    object: 'model',
                    created: model.created || Math.floor(Date.now() / 1000),
                    owned_by: providerID
                }));
        } catch (error) {
            log.warn('Failed to fetch upstream model catalog', {
                providerID,
                error: error instanceof Error ? error.message : String(error)
            });
            return [];
        }
    };

    /** Last good catalog per provider, so one failing endpoint cannot drop the other. @type {Map<string, DirectLabels[]>} */
    const lastGood = new Map();

    /**
     * Fetch one provider's catalog, falling back to that provider's own last good
     * list when the refresh fails or comes back empty.
     *
     * @param {string} providerID Provider id.
     * @param {string} baseUrl Upstream base URL.
     * @param {string} [apiKey] Upstream key.
     * @param {string} [clientVersion] Fingerprint version.
     * @returns {Promise<DirectLabels[]>} This provider's models.
     */
    const lastGoodFor = async (providerID, baseUrl, apiKey, clientVersion) => {
        const fetched = await fetchOne(providerID, baseUrl, apiKey, clientVersion);
        if (fetched.length) lastGood.set(providerID, fetched);
        return lastGood.get(providerID) || [];
    };

    return {
        /**
         * @param {object} [options] Fetch options.
         * @param {string} [options.apiKey] Upstream key.
         * @param {string} [options.goBaseUrl] Go base URL override.
         * @param {string} [options.zenBaseUrl] Zen base URL override.
         * @param {string} [options.clientVersion] Fingerprint version.
         * @returns {Promise<DirectLabels[]>} Models; the last good list when the
         *   refresh fails, otherwise `[]`.
         */
        async getModels({ apiKey, goBaseUrl, zenBaseUrl, clientVersion } = {}) {
            if (cached && Date.now() - cachedAt < ttlMs) return cached;
            // Each provider keeps its own last good list: a single upstream being
            // briefly unreachable must not drop the models the other one serves.
            const [goModels, zenModels] = await Promise.all([
                lastGoodFor('opencode-go', goBaseUrl || DEFAULT_GO_BASE_URL, apiKey, clientVersion),
                lastGoodFor('opencode', zenBaseUrl || DEFAULT_ZEN_BASE_URL, apiKey, clientVersion)
            ]);
            const models = [...goModels, ...zenModels];
            // With no good list at all, report an empty catalog rather than `null`.
            if (!models.length) return [];
            cached = models;
            cachedAt = Date.now();
            return models;
        },
        /** Drop the cache so the next `getModels()` refetches. */
        invalidate() {
            cached = null;
            cachedAt = 0;
            lastGood.clear();
        }
    };
}

/**
 * @typedef {object} DirectContext
 * @property {string} providerID Provider id (`opencode` | `opencode-go`).
 * @property {string} modelID Bare upstream model id.
 * @property {object} body Client request body, passed through.
 * @property {boolean} [stream] Whether the client asked for SSE.
 * @property {string} sessionId Conversation identity sent as `x-opencode-session`.
 * @property {AbortSignal} [signal] Caller-owned abort signal.
 * @property {string} [requestId] Override the generated request id.
 */

/**
 * Create the direct upstream.
 *
 * The factory is the frozen interface from `docs/ARCHITECTURE.md` §2; the
 * primitives above stay exported so the routes layer, tests and the router can
 * use them without constructing the whole client.
 *
 * @param {object} options Factory options.
 * @param {Record<string, any>} [options.config] Config with the environment-style keys
 *   (`DIRECT_GO_BASE_URL`, `DIRECT_ZEN_BASE_URL`, `ZEN_API_KEY`,
 *   `REQUEST_TIMEOUT_MS`, `DIRECT_CLIENT_VERSION`).
 * @param {any} [options.logger] Logger dependency.
 * @param {typeof fetch} [options.fetch] Fetch implementation.
 * @returns {{
 *   chatCompletion: (ctx: DirectContext) => Promise<Response>,
 *   responses: (ctx: DirectContext) => Promise<Response>,
 *   listModels: () => Promise<DirectLabels[]>,
 *   supports: (providerID: string) => boolean,
 *   hasCredentials: () => boolean,
 *   baseUrlFor: (providerID: string) => string,
 *   classify: (response: Response, bodyText?: string) => DirectFailureKind
 * }} The direct upstream.
 */
export function createDirectUpstream({
    config = {},
    logger = null,
    fetch: fetchImpl = globalThis.fetch
} = {}) {
    const log = resolveLogger(logger, 'upstreams/direct');
    const goBaseUrl = config.DIRECT_GO_BASE_URL || DEFAULT_GO_BASE_URL;
    const zenBaseUrl = config.DIRECT_ZEN_BASE_URL || DEFAULT_ZEN_BASE_URL;
    const clientVersion = String(config.DIRECT_CLIENT_VERSION || DEFAULT_CLIENT_VERSION);
    const requestTimeoutMs = toMillis(config.REQUEST_TIMEOUT_MS, 300000);
    const directEnabled = toBool(config.DIRECT_ENABLED) ?? true;
    const getApiKey = () => String(config.ZEN_API_KEY || '');

    const catalog = createModelCatalog({ fetchImpl, logger: log });

    /**
     * @param {DirectContext} ctx Turn context.
     * @param {string} path Upstream path.
     * @returns {Promise<Response>} Raw response.
     */
    const send = (ctx, path) => {
        const { providerID, modelID, body, stream, sessionId, signal, requestId } = ctx || {};
        const baseUrl = resolveBaseUrlForProvider(providerID, { goBaseUrl, zenBaseUrl });
        log.debug('Direct upstream request', { baseUrl, path, providerID, modelID, sessionId });
        return requestUpstream({
            baseUrl,
            path,
            apiKey: getApiKey(),
            sessionId,
            requestId: requestId || newRequestId(),
            body: { ...body, model: modelID, stream: Boolean(stream) },
            signal,
            timeoutMs: requestTimeoutMs,
            clientVersion,
            fetchImpl
        });
    };

    return {
        /** @param {DirectContext} ctx */
        chatCompletion: (ctx) => send(ctx, CHAT_COMPLETIONS_PATH),
        /** @param {DirectContext} ctx */
        responses: (ctx) => send(ctx, RESPONSES_PATH),
        /** @returns {Promise<DirectLabels[]>} */
        listModels: () =>
            catalog.getModels({
                apiKey: getApiKey(),
                goBaseUrl,
                zenBaseUrl,
                clientVersion
            }),
        /**
         * @param {string} providerID Provider id.
         * @returns {boolean} True when the provider has a direct endpoint.
         */
        supports: (providerID) => {
            const id = String(providerID || '').toLowerCase();
            return id === 'opencode' || id === 'opencode-go';
        },
        /** @returns {boolean} True when direct mode is enabled and a key exists. */
        hasCredentials: () => Boolean(directEnabled && getApiKey()),
        /**
         * @param {string} providerID Provider id.
         * @returns {string} Base URL that would be used.
         */
        baseUrlFor: (providerID) => resolveBaseUrlForProvider(providerID, { goBaseUrl, zenBaseUrl }),
        /**
         * @param {Response} response Raw response.
         * @param {string} [bodyText] Already-read body text (avoids a second read).
         * @returns {DirectFailureKind} Fallback classification.
         */
        classify: (response, bodyText) => classifyDirectFailure(response?.status, bodyText ?? undefined)
    };
}
