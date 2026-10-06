/**
 * Runtime stream reconciliation.
 *
 * Reconciles a runtime event stream that ended without a complete answer (no
 * first delta, idle cutoff, rejected subscription, reasoning-only) against the
 * authoritative session snapshot, and emits the remaining deltas.
 *
 * @module routes/runtime-reconciliation
 */

/**
 * @typedef {object} TurnErrorLike
 * @property {string} [name]
 * @property {string} [message]
 * @property {{message?: string}} [data]
 */

/**
 * @typedef {object} CollectedTurnLike
 * @property {string} [content]
 * @property {string} [reasoning]
 * @property {TurnErrorLike} [error]
 * @property {TurnErrorLike} [__error]
 * @property {boolean} [noData]
 * @property {boolean} [idleTimeout]
 * @property {boolean} [clientClosed]
 */

/**
 * @typedef {object} PollResultLike
 * @property {string} content
 * @property {string} reasoning
 * @property {TurnErrorLike|null} error
 */

/**
 * @param {TurnErrorLike} error Runtime error.
 * @returns {string} Client-visible fallback text.
 */
function proxyErrorText(error) {
    return `[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`;
}

/**
 * @param {PollResultLike} polled Poll snapshot.
 * @param {(delta: string, isReasoning?: boolean) => void} sendDelta Delta sink.
 * @param {{rawContent?: string, rawReasoning?: string}} [trim] Already observed raw text.
 * @returns {void}
 */
function emitPolled(polled, sendDelta, trim = {}) {
    const { content = '', reasoning = '', error = null } = polled;
    if (error && !content && !reasoning) {
        sendDelta(proxyErrorText(error));
        return;
    }

    const remainingReasoning =
        trim.rawReasoning && reasoning.startsWith(trim.rawReasoning)
            ? reasoning.slice(trim.rawReasoning.length)
            : reasoning;
    const remainingContent =
        trim.rawContent && content.startsWith(trim.rawContent)
            ? content.slice(trim.rawContent.length)
            : content;

    if (remainingReasoning) sendDelta(remainingReasoning, true);
    if (remainingContent) sendDelta(remainingContent, false);
}

/**
 * Reconcile a Chat Completions runtime stream against session polling.
 *
 * @param {object} options Reconciliation dependencies.
 * @param {CollectedTurnLike|null} options.collected Event collector result.
 * @param {() => Promise<PollResultLike>} options.poll Authoritative session poll.
 * @param {(delta: string, isReasoning?: boolean) => void} options.sendDelta Delta sink.
 * @param {() => {streamedContent: string, streamedReasoning: string, rawStreamedContent: string, rawStreamedReasoning: string}} options.getState
 *   Current stream state; re-read after every emitted delta.
 * @param {(message: string, fields?: Record<string, unknown>) => void} [options.logDebug] Debug logger.
 * @param {string} [options.sessionId] Session id for logs.
 * @returns {Promise<{clientClosed: boolean}>} Whether the client already disconnected.
 */
export async function reconcileChatRuntimeStream({
    collected,
    poll,
    sendDelta,
    getState,
    logDebug = () => {},
    sessionId = ''
}) {
    if (collected?.clientClosed) {
        logDebug('Client closed the stream; ending the turn', { sessionId });
        return { clientClosed: true };
    }

    if (collected?.__error) {
        logDebug('SSE collect error, falling back to polling', {
            sessionId,
            error: collected.__error?.message
        });
        emitPolled(await poll(), sendDelta);
    } else if (collected?.noData) {
        logDebug('Fallback to polling (stream)', { sessionId });
        emitPolled(await poll(), sendDelta);
    } else if (collected?.idleTimeout) {
        logDebug('SSE idle timeout, polling for completion', { sessionId });
        const state = getState();
        emitPolled(await poll(), sendDelta, {
            rawContent: state.rawStreamedContent,
            rawReasoning: state.rawStreamedReasoning
        });
    }

    let state = getState();
    if (
        collected &&
        !state.streamedContent &&
        !state.streamedReasoning &&
        (collected.reasoning || collected.content)
    ) {
        if (collected.reasoning) sendDelta(collected.reasoning, true);
        if (collected.content) sendDelta(collected.content, false);
    }

    state = getState();
    if (!state.streamedContent && !state.streamedReasoning) {
        logDebug('SSE returned empty, falling back to polling', { sessionId });
        emitPolled(await poll(), sendDelta);
    } else if (state.streamedReasoning && !state.streamedContent) {
        logDebug('Reasoning streamed but no content, reconciling from snapshot', { sessionId });
        const snapshot = await poll().catch(() => null);
        if (snapshot?.content) {
            const remainingContent = state.rawStreamedContent
                ? snapshot.content.slice(state.rawStreamedContent.length)
                : snapshot.content;
            if (remainingContent) sendDelta(remainingContent, false);
        }
    }

    return { clientClosed: false };
}

/**
 * Reconcile a Responses API runtime stream against session polling.
 *
 * @param {object} options Reconciliation dependencies.
 * @param {CollectedTurnLike|null} options.collected Event collector result.
 * @param {() => Promise<PollResultLike>} options.poll Authoritative session poll.
 * @param {(delta: string, isReasoning?: boolean) => void} options.sendDelta Delta sink.
 * @param {() => {content: string, reasoning: string, rawContent: string, rawReasoning: string}} options.getState
 *   Current Responses stream state.
 * @param {(message: string, fields?: Record<string, unknown>) => void} [options.logDebug] Debug logger.
 * @param {string} [options.sessionId] Session id for logs.
 * @returns {Promise<{clientClosed: boolean}>} Whether the client already disconnected.
 */
export async function reconcileResponsesRuntimeStream({
    collected,
    poll,
    sendDelta,
    getState,
    logDebug = () => {},
    sessionId = ''
}) {
    if (collected?.clientClosed) {
        logDebug('Client closed the stream; ending the responses turn', { sessionId });
        return { clientClosed: true };
    }

    let state = getState();
    if (!state.content && !state.reasoning) {
        const polled = await poll();
        if (polled.error && !polled.content && !polled.reasoning) throw polled.error;
        if (polled.reasoning) sendDelta(polled.reasoning, true);
        if (polled.content) sendDelta(polled.content, false);
    } else if (collected?.idleTimeout) {
        const polled = await poll();
        emitPolled(polled, sendDelta, {
            rawContent: state.rawContent,
            rawReasoning: state.rawReasoning
        });
    } else if (collected && (collected.content || collected.reasoning)) {
        state = getState();
        if (!state.reasoning && collected.reasoning) sendDelta(collected.reasoning, true);
        if (!state.content && collected.content) sendDelta(collected.content, false);
    }

    return { clientClosed: false };
}
