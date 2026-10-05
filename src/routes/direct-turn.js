/**
 * Direct-upstream turn runner.
 *
 * Owns one direct HTTP attempt, fallback classification and downstream relay.
 * Conversation planning and fallback retry orchestration stay in the turn engine.
 *
 * @module routes/direct-turn
 */

import { extractAssistantText, isDirectAuthFailure, isFreeTierRefusal } from '../upstreams/direct-client.js';
import { relayDirectSse } from './streaming/sse.js';

/**
 * @typedef {object} DirectTurnRunnerOptions
 * @property {any} direct Direct upstream adapter.
 * @property {any} router Upstream router, used for fallback policy/learning.
 * @property {(...args: unknown[]) => void} [logWarn] Warning logger.
 */

/**
 * @typedef {object} DirectTurnParams
 * @property {'/chat/completions'|'/responses'} path Upstream surface.
 * @property {import('express').Response} res Downstream response.
 * @property {string} providerID Provider id.
 * @property {string} modelID Bare model id.
 * @property {string} sessionId Direct session id.
 * @property {unknown} body Request body.
 * @property {boolean} stream Whether SSE was requested.
 * @property {string} clientModelName Client-visible model.
 * @property {AbortSignal} signal Client abort signal.
 * @property {any|null} [fallbackTurn] Router turn to mark on fallback.
 * @property {((answerText: string|null) => void)|null} [onSuccess] Success observer.
 */

/**
 * Build the direct-turn runner.
 *
 * @param {DirectTurnRunnerOptions} options Dependencies.
 * @returns {(params: DirectTurnParams) => Promise<{handled: boolean, reason?: string}>}
 */
export function createDirectTurnRunner({ direct, router, logWarn = () => {} }) {
    return async function runDirectTurn({
        path,
        res,
        providerID,
        modelID,
        sessionId,
        body,
        stream,
        clientModelName,
        signal,
        fallbackTurn = null,
        onSuccess = null
    }) {
        const directRequest = {
            providerID,
            modelID,
            body,
            stream: Boolean(stream),
            sessionId,
            signal
        };
        const allowsFallback = router.allowsFallback();

        /**
         * @param {'free-tier'|'auth'|'transport'} reason Failure kind.
         * @returns {{handled: boolean, reason: string}}
         */
        const fallback = (reason) => {
            if (fallbackTurn) router.fallback(fallbackTurn, reason);
            return { handled: false, reason };
        };

        let upstreamResponse;
        try {
            upstreamResponse =
                path === '/chat/completions'
                    ? await direct.chatCompletion(directRequest)
                    : await direct.responses(directRequest);
        } catch (error) {
            logWarn('[Proxy] Direct upstream request failed:', {
                error: /** @type {Error} */ (error).message
            });
            if (allowsFallback) return fallback('transport');
            throw error;
        }

        /**
         * @param {number} status HTTP status.
         * @param {string} detail Body.
         * @param {string|null|undefined} [contentType] Content type.
         * @returns {{handled: boolean}}
         */
        const relayFailure = (status, detail, contentType) => {
            if (res.headersSent) return { handled: true };
            res.status(status)
                .type(contentType || 'application/json')
                .send(detail);
            return { handled: true };
        };

        if (isDirectAuthFailure(upstreamResponse.status)) {
            const detail = await upstreamResponse.text().catch(() => '');

            if (isFreeTierRefusal(upstreamResponse.status, detail)) {
                logWarn(
                    `[Proxy] ${clientModelName} is served to the runtime only (free tier); routing it there from now on`
                );
                if (allowsFallback) return fallback('free-tier');
            }

            if (allowsFallback) {
                logWarn(
                    `[Proxy] Direct upstream rejected the key (${upstreamResponse.status}); using the runtime:`,
                    { detail: detail.slice(0, 200) }
                );
                return fallback('auth');
            }

            return relayFailure(
                upstreamResponse.status,
                detail || JSON.stringify({ error: { message: 'Upstream rejected the configured key' } }),
                upstreamResponse.headers?.get?.('content-type')
            );
        }

        if (!upstreamResponse.ok) {
            const detail = await upstreamResponse.text().catch(() => '');
            return relayFailure(
                upstreamResponse.status,
                detail,
                upstreamResponse.headers?.get?.('content-type')
            );
        }

        const contentType = upstreamResponse.headers?.get?.('content-type') || '';
        const isEventStream = Boolean(stream) && (contentType.includes('text/event-stream') || !contentType);

        if (!isEventStream) {
            const payload = await upstreamResponse.json();
            const answerText = extractAssistantText(payload);
            if (payload && typeof payload === 'object') {
                if (payload.model !== undefined) payload.model = clientModelName;
                if (
                    payload.response &&
                    typeof payload.response === 'object' &&
                    payload.response.model !== undefined
                ) {
                    payload.response.model = clientModelName;
                }
            }
            if (onSuccess) onSuccess(answerText);
            if (!res.headersSent) res.json(payload);
            return { handled: true };
        }

        await relayDirectSse({
            res,
            body: upstreamResponse.body,
            clientModelName,
            onSuccess
        });
        return { handled: true };
    };
}
