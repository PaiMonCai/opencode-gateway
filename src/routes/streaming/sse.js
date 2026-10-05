/**
 * Shared Server-Sent Events helpers used by the OpenAI-compatible route surface.
 *
 * This module owns wire framing only: headers, `data:` records, keepalives and
 * direct-upstream SSE relay. Turn/session policy remains in the engine.
 *
 * @module routes/streaming/sse
 */

import { collectSseDeltaText, rewriteSseModel } from '../../upstreams/direct-client.js';

/**
 * Apply standard SSE response headers.
 *
 * @param {import('express').Response} res Response to configure.
 * @param {{flush?: boolean}} [options] Whether to flush headers immediately.
 * @returns {void}
 */
export function prepareSse(res, { flush = false } = {}) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (flush) res.flushHeaders?.();
}

/**
 * Write one JSON SSE data record.
 *
 * @param {import('express').Response} res Response to write.
 * @param {unknown} payload JSON payload.
 * @returns {boolean} Node write() backpressure signal.
 */
export function writeSseEvent(res, payload) {
    return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Write the OpenAI-compatible stream terminator.
 *
 * @param {import('express').Response} res Response to write.
 * @returns {boolean} Node write() backpressure signal.
 */
export function writeSseDone(res) {
    return res.write('data: [DONE]\n\n');
}

/**
 * Start an SSE keepalive comment loop.
 *
 * @param {import('express').Response} res Response to keep alive.
 * @param {number} [intervalMs] Keepalive interval.
 * @returns {() => void} Idempotent stop function.
 */
export function startSseKeepalive(res, intervalMs = 15000) {
    let timer = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
        if (!timer) return;
        clearInterval(timer);
        timer = /** @type {any} */ (null);
    };
}

/**
 * Relay a direct-upstream event stream while rewriting the client-visible model.
 *
 * @param {object} options Relay options.
 * @param {import('express').Response} options.res Downstream response.
 * @param {any} options.body Upstream response body.
 * @param {string} options.clientModelName Client-visible model name.
 * @param {((text: string|null) => void)|null} [options.onSuccess] Completion observer.
 * @returns {Promise<string>} Text observed across streamed deltas.
 */
export async function relayDirectSse({ res, body, clientModelName, onSuccess = null }) {
    prepareSse(res, { flush: true });
    let streamedContent = '';

    for await (const chunk of rewriteSseModel(body, clientModelName)) {
        if (res.writableEnded || res.destroyed) break;
        streamedContent += collectSseDeltaText(chunk);
        res.write(chunk);
    }

    if (onSuccess) onSuccess(streamedContent);
    if (!res.writableEnded && !res.destroyed) res.end();
    return streamedContent;
}

/**
 * Report a Responses API failure on an already-open SSE stream.
 *
 * @param {import('express').Response} res Open response stream.
 * @param {unknown} error OpenAI-shaped error payload.
 * @returns {void}
 */
export function writeResponsesFailure(res, error) {
    writeSseEvent(res, {
        type: 'response.failed',
        response: { error }
    });
    writeSseDone(res);
}
