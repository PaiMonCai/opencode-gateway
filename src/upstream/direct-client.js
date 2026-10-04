import crypto from 'crypto';

/**
 * Direct upstream client.
 *
 * The middleware exists so an OpenAI-format gateway can talk to OpenCode. Two
 * upstream shapes are supported:
 *
 *  - the local OpenCode runtime (required for the Zen free tier, whose gate is
 *    an official-client identity no plain HTTP caller can reproduce), and
 *  - OpenCode's OpenAI-compatible endpoints themselves (`/zen/go/v1` for a Go
 *    subscription, `/zen/v1` for pay-as-you-go Zen), which need nothing more
 *    than a valid key and the conversation header.
 *
 * This module implements the second shape. Both `/chat/completions` and
 * `/responses` exist upstream, so requests pass through as they are; the only
 * things added are the upstream key, the official client fingerprint, and the
 * stable conversation header. `/models` is public, which also lets a
 * runtime-less deployment still publish a model list.
 */

export const DEFAULT_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
// What the official client sends; kept configurable so it can follow upstream.
export const DEFAULT_CLIENT_VERSION = '1.18.34';
export const DEFAULT_MODEL_CACHE_MS = 10 * 60 * 1000;

export function resolveBaseUrlForProvider(providerID, { goBaseUrl, zenBaseUrl } = {}) {
    const go = goBaseUrl || DEFAULT_GO_BASE_URL;
    const zen = zenBaseUrl || DEFAULT_ZEN_BASE_URL;
    return String(providerID || '').toLowerCase() === 'opencode-go' ? go : zen;
}

export function buildDirectHeaders({
    apiKey,
    sessionId,
    requestId,
    clientVersion = DEFAULT_CLIENT_VERSION,
    extraHeaders = {}
} = {}) {
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

/** `msg_` + lowercase hex, matching the shape the official client sends. */
export const newRequestId = () => `msg_${crypto.randomBytes(12).toString('hex')}`;

/** `ses_` + lowercase hex conversation identity for the direct upstream. */
export const newSessionId = () => `ses_${crypto.randomBytes(12).toString('hex')}`;

const joinUrl = (baseUrl, path) => `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;

export function isDirectAuthFailure(status) {
    return status === 401 || status === 403;
}

/**
 * The free tier answers `403 FreeTierError` for models it only serves to the
 * official client. That is a property of the model, not of the request, so the
 * caller can remember it and stop asking.
 */
export function isFreeTierRefusal(status, bodyText) {
    if (status !== 403) return false;
    return /FreeTierError|free tier can only be used/i.test(String(bodyText || ''));
}

function rewriteModelFields(payload, modelName) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    if (payload.model !== undefined) {
        payload.model = modelName;
        changed = true;
    }
    // Responses events carry the model inside the response object.
    if (payload.response && typeof payload.response === 'object' && payload.response.model !== undefined) {
        payload.response.model = modelName;
        changed = true;
    }
    return changed;
}

/**
 * Rewrite the `model` field of an SSE stream (chat chunks and Responses events
 * alike) so the client keeps seeing the model name it asked for, without
 * buffering or reordering anything else. Records that are not JSON pass through.
 */
export async function* rewriteSseModel(source, modelName) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const record = buffer.slice(0, boundary + 2);
            buffer = buffer.slice(boundary + 2);
            yield encoder.encode(rewriteSseRecord(record, modelName));
            boundary = buffer.indexOf('\n\n');
        }
    }
    buffer += decoder.decode();
    if (buffer) yield encoder.encode(rewriteSseRecord(buffer, modelName));
}

function rewriteSseRecord(record, modelName) {
    if (!modelName || !record.startsWith('data:')) return record;
    const payloadText = record.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') return record;
    try {
        const payload = JSON.parse(payloadText);
        if (!rewriteModelFields(payload, modelName)) return record;
        return `data: ${JSON.stringify(payload)}\n\n`;
    } catch {
        return record;
    }
}

/**
 * Send one upstream request. Returns the raw response so the caller decides how
 * to relay it.
 *
 * @param {object} options
 * @param {string} options.baseUrl upstream base, e.g. https://opencode.ai/zen/go/v1
 * @param {string} options.path    `/chat/completions` or `/responses`
 * @param {string} options.apiKey  Bearer key for the upstream
 * @param {string} [options.sessionId] conversation identity -> x-opencode-session
 * @param {string} [options.requestId] per-request id     -> x-opencode-request
 * @param {object} options.body    request body, already in the upstream dialect
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
    if (timeoutMs > 0 && typeof AbortController === 'function') {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
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
    }
}

/**
 * Cached model catalogs of the direct upstreams. `/models` is public, so this
 * works even when the runtime (and its provider catalog) is not available.
 *
 * @returns {{getModels: Function, invalidate: Function}}
 */
export function createModelCatalog({
    fetchImpl = globalThis.fetch,
    ttlMs = DEFAULT_MODEL_CACHE_MS,
    logger = () => {}
} = {}) {
    let cached = null;
    let cachedAt = 0;

    const fetchOne = async (providerID, baseUrl, apiKey, clientVersion) => {
        try {
            const response = await fetchImpl(joinUrl(baseUrl, '/models'), {
                headers: buildDirectHeaders({ apiKey, clientVersion })
            });
            if (!response.ok) return [];
            const payload = await response.json();
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
            logger('Failed to fetch upstream model catalog', { providerID, error: error.message });
            return [];
        }
    };

    return {
        async getModels({ apiKey, goBaseUrl, zenBaseUrl, clientVersion } = {}) {
            if (cached && Date.now() - cachedAt < ttlMs) return cached;
            const [goModels, zenModels] = await Promise.all([
                fetchOne('opencode-go', goBaseUrl || DEFAULT_GO_BASE_URL, apiKey, clientVersion),
                fetchOne('opencode', zenBaseUrl || DEFAULT_ZEN_BASE_URL, apiKey, clientVersion)
            ]);
            const models = [...goModels, ...zenModels];
            // Keep the last good list if the upstream is briefly unreachable.
            if (!models.length) return cached;
            cached = models;
            cachedAt = Date.now();
            return models;
        },
        invalidate() {
            cached = null;
            cachedAt = 0;
        }
    };
}
