/**
 * Final reconciliation for streamed external tool-call markup.
 *
 * Streaming parsers and text filters deliberately retain ambiguous suffixes while
 * a turn is live. At end-of-stream those buffers must be flushed, combined with
 * the raw reasoning/content channels, and parsed once more. Some models even open
 * markup in reasoning and close it in content, so a joined-channel retry is
 * required when neither channel yields a complete call by itself.
 *
 * @module tools/stream-reconciliation
 */

import { parseExternalToolCallsFromText } from './parser.js';

/**
 * @typedef {((chunk: string) => string) & {flush: () => string}} FlushableFilter
 */

/**
 * @typedef {((chunk: string) => import('./contract.js').WireToolCall[]) & {flush: () => import('./contract.js').WireToolCall[]}} FlushableToolParser
 */

/**
 * @param {object} options Stream parsing state.
 * @param {import('./registry.js').ExternalTool[]} options.registry Request tool registry.
 * @param {import('./contract.js').WireToolCall[]} options.streamedToolCalls Calls already emitted live.
 * @param {FlushableToolParser} options.reasoningParser Reasoning-channel parser.
 * @param {FlushableToolParser} options.contentParser Content-channel parser.
 * @param {FlushableFilter} options.reasoningFilter Reasoning-channel text filter.
 * @param {FlushableFilter} options.contentFilter Content-channel text filter.
 * @param {string} options.rawReasoning Raw reasoning seen during streaming.
 * @param {string} options.rawContent Raw content seen during streaming.
 * @param {string|null|undefined} [options.snapshotReasoning] Optional authoritative reasoning snapshot.
 * @param {string|null|undefined} [options.snapshotContent] Optional authoritative content snapshot.
 * @returns {{
 *   parsedToolCalls: import('./contract.js').WireToolCall[],
 *   finalReasoningText: string,
 *   finalContentText: string
 * }} Reconciled calls and channel text.
 */
export function reconcileStreamedToolCalls({
    registry,
    streamedToolCalls,
    reasoningParser,
    contentParser,
    reasoningFilter,
    contentFilter,
    rawReasoning,
    rawContent,
    snapshotReasoning = null,
    snapshotContent = null
}) {
    const flushedReasoningCalls = reasoningParser.flush ? reasoningParser.flush() : [];
    const flushedContentCalls = contentParser.flush ? contentParser.flush() : [];
    const flushedReasoningText = reasoningFilter.flush ? reasoningFilter.flush() : '';
    const flushedContentText = contentFilter.flush ? contentFilter.flush() : '';

    const finalReasoningText = (snapshotReasoning || rawReasoning) + flushedReasoningText;
    const finalContentText = (snapshotContent || rawContent) + flushedContentText;

    if (streamedToolCalls.length > 0) {
        return {
            parsedToolCalls: streamedToolCalls,
            finalReasoningText,
            finalContentText
        };
    }

    if (registry.length === 0) {
        return {
            parsedToolCalls: [],
            finalReasoningText,
            finalContentText
        };
    }

    const perChannel = [
        ...flushedReasoningCalls,
        ...flushedContentCalls,
        ...parseExternalToolCallsFromText(registry, finalReasoningText, finalContentText)
    ];

    const parsedToolCalls =
        perChannel.length > 0
            ? perChannel
            : parseExternalToolCallsFromText(registry, finalReasoningText + finalContentText);

    return {
        parsedToolCalls,
        finalReasoningText,
        finalContentText
    };
}
