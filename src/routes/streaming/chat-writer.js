/**
 * Chat Completions SSE wire writer.
 *
 * The engine decides which deltas/tool calls are valid. This module only renders
 * those decisions into OpenAI-compatible `chat.completion.chunk` records.
 *
 * @module routes/streaming/chat-writer
 */

import { writeSseDone, writeSseEvent } from './sse.js';

/** @typedef {import('../../tools/contract.js').WireToolCall} WireToolCall */

/**
 * @param {object} options Writer options.
 * @param {import('express').Response} options.res Response stream.
 * @param {string} options.id Chat completion id.
 * @param {string} options.model Client-visible model.
 * @param {() => number} [options.clockSeconds] Unix-seconds clock.
 * @returns {{
 *   toolCall: (toolCall: import('../../tools/contract.js').WireToolCall, index: number) => void,
 *   toolCalls: (toolCalls: import('../../tools/contract.js').WireToolCall[]) => void,
 *   delta: (text: string, isReasoning?: boolean) => void,
 *   finish: (usage: {promptTokens: number, completionTokens: number, reasoningTokens: number}, finishReason?: string) => void,
 *   done: () => void
 * }}
 */
export function createChatStreamWriter({
    res,
    id,
    model,
    clockSeconds = () => Math.floor(Date.now() / 1000)
}) {
    /**
     * @param {Record<string, unknown>} delta Delta payload.
     * @param {string|null} [finishReason] Finish reason.
     * @returns {Record<string, unknown>} Chat chunk.
     */
    const base = (delta, finishReason = null) => ({
        id,
        object: 'chat.completion.chunk',
        created: clockSeconds(),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    });

    /**
     * @param {WireToolCall} call Validated tool call.
     * @param {number} index Tool-call index.
     * @returns {void}
     */
    const toolCall = (call, index) => {
        writeSseEvent(
            res,
            base({
                tool_calls: [
                    {
                        index,
                        id: call.id,
                        type: 'function',
                        function: {
                            name: call.function.name,
                            arguments: call.function.arguments
                        }
                    }
                ]
            })
        );
    };

    /**
     * @param {WireToolCall[]} calls Validated tool calls.
     * @returns {void}
     */
    const toolCalls = (calls) => {
        if (!calls.length) return;
        writeSseEvent(
            res,
            base({
                tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.function.name,
                        arguments: call.function.arguments
                    }
                }))
            })
        );
    };

    /**
     * @param {string} text Text delta.
     * @param {boolean} [isReasoning] Whether this is reasoning text.
     * @returns {void}
     */
    const delta = (text, isReasoning = false) => {
        if (!text) return;
        writeSseEvent(res, base(isReasoning ? { reasoning_content: text } : { content: text }));
    };

    /**
     * @param {{promptTokens: number, completionTokens: number, reasoningTokens: number}} usage Usage counters.
     * @param {string} [finishReason] Final reason.
     * @returns {void}
     */
    const finish = ({ promptTokens, completionTokens, reasoningTokens }, finishReason = 'stop') => {
        writeSseEvent(res, {
            id,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens + reasoningTokens,
                total_tokens: promptTokens + completionTokens + reasoningTokens,
                completion_tokens_details: { reasoning_tokens: reasoningTokens }
            }
        });
    };

    return {
        toolCall,
        toolCalls,
        delta,
        finish,
        done: () => {
            writeSseDone(res);
        }
    };
}
