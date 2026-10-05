/**
 * Responses API SSE wire writer.
 *
 * This owns sequence numbering and the output-item/content scaffolding required
 * by the Responses event protocol. Tool validation, polling and retry decisions
 * remain in the turn engine.
 *
 * @module routes/streaming/responses-writer
 */

import crypto from 'node:crypto';

import { prepareSse, writeSseDone, writeSseEvent } from './sse.js';

/** @typedef {import('../../tools/contract.js').WireToolCall} WireToolCall */

/**
 * @typedef {object} ResponsesStreamWriter
 * @property {string} responseId
 * @property {WireToolCall[]} streamedToolCalls
 * @property {() => void} start
 * @property {(toolCall: WireToolCall) => void} functionCall
 * @property {(delta: string) => void} reasoningDelta
 * @property {(delta: string) => void} textDelta
 * @property {(reasoning: string) => void} finishReasoning
 * @property {(content: string) => void} finishText
 * @property {(response: Record<string, unknown>) => void} complete
 * @property {() => void} done
 */

/**
 * @param {import('../../tools/contract.js').WireToolCall} toolCall Validated call.
 * @returns {Record<string, unknown>} Completed Responses function_call item.
 */
export function buildResponsesFunctionCallOutputItem(toolCall) {
    return {
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
    };
}

/**
 * @param {string|null|undefined} text Assistant text.
 * @returns {Record<string, unknown>|null} Completed message item, or null.
 */
export function buildResponsesMessageOutputItem(text) {
    if (!text) return null;
    return {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }]
    };
}

/**
 * @param {object} options Writer options.
 * @param {import('express').Response} options.res Response stream.
 * @param {string} options.model Client-visible model.
 * @param {string} [options.responseId] Stable response id.
 * @param {string} [options.outputItemId] Message item id.
 * @param {string} [options.reasoningItemId] Reasoning item id.
 * @param {() => number} [options.clockSeconds] Unix-seconds clock.
 * @returns {ResponsesStreamWriter} Stateful Responses SSE writer.
 */
export function createResponsesStreamWriter({
    res,
    model,
    responseId = `resp_${crypto.randomUUID()}`,
    outputItemId = `msg_${crypto.randomUUID()}`,
    reasoningItemId = 'reasoning-0',
    clockSeconds = () => Math.floor(Date.now() / 1000)
}) {
    const messageOutputIndex = 0;
    const reasoningOutputIndex = 1;
    const contentIndex = 0;
    let nextOutputIndex = 2;
    let sequenceNumber = 0;
    let announcedOutput = false;
    let announcedContent = false;
    let announcedReasoning = false;
    /** @type {import('../../tools/contract.js').WireToolCall[]} */
    const streamedToolCalls = [];

    const nextSeq = () => sequenceNumber++;
    /** @param {Record<string, unknown>} payload Event payload. @returns {boolean} */
    const emit = (payload) => writeSseEvent(res, payload);

    const start = () => {
        prepareSse(res);
        emit({
            type: 'response.created',
            sequence_number: nextSeq(),
            response: {
                id: responseId,
                object: 'response',
                created: clockSeconds(),
                model
            }
        });
    };

    const ensureTextScaffold = () => {
        if (!announcedOutput) {
            emit({
                type: 'response.output_item.added',
                sequence_number: nextSeq(),
                output_index: messageOutputIndex,
                item: {
                    id: outputItemId,
                    type: 'message',
                    status: 'in_progress',
                    role: 'assistant',
                    content: []
                }
            });
            announcedOutput = true;
        }
        if (!announcedContent) {
            emit({
                type: 'response.content_part.added',
                sequence_number: nextSeq(),
                output_index: messageOutputIndex,
                content_index: contentIndex,
                item_id: outputItemId,
                part: { type: 'output_text', text: '' }
            });
            announcedContent = true;
        }
    };

    const ensureReasoningScaffold = () => {
        if (announcedReasoning) return;
        emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item: {
                id: reasoningItemId,
                type: 'reasoning',
                status: 'in_progress',
                summary: [{ type: 'summary_text', text: '' }]
            }
        });
        announcedReasoning = true;
    };

    /** @param {WireToolCall} toolCall Validated tool call. @returns {void} */
    const functionCall = (toolCall) => {
        const outputIndex = nextOutputIndex++;
        const functionCallItem = buildResponsesFunctionCallOutputItem(toolCall);
        streamedToolCalls.push(toolCall);
        emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { ...functionCallItem, status: 'in_progress' }
        });
        emit({
            type: 'response.function_call_arguments.delta',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            delta: toolCall.function.arguments
        });
        emit({
            type: 'response.function_call_arguments.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            arguments: toolCall.function.arguments
        });
        emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: functionCallItem
        });
    };

    /** @param {string} delta Reasoning delta. @returns {void} */
    const reasoningDelta = (delta) => {
        if (!delta) return;
        ensureReasoningScaffold();
        emit({
            type: 'response.reasoning_summary_text.delta',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item_id: reasoningItemId,
            summary_index: 0,
            delta
        });
    };

    /** @param {string} delta Text delta. @returns {void} */
    const textDelta = (delta) => {
        if (!delta) return;
        ensureTextScaffold();
        emit({
            type: 'response.output_text.delta',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            content_index: contentIndex,
            item_id: outputItemId,
            delta
        });
    };

    /** @param {string} reasoning Full reasoning text. @returns {void} */
    const finishReasoning = (reasoning) => {
        if (!announcedReasoning) return;
        emit({
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item_id: reasoningItemId,
            summary_index: 0,
            text: reasoning
        });
        emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item: {
                id: reasoningItemId,
                type: 'reasoning',
                status: 'completed',
                summary: [{ type: 'summary_text', text: reasoning }]
            }
        });
    };

    /** @param {string} content Full answer text. @returns {void} */
    const finishText = (content) => {
        if (!announcedContent || !content?.trim()) return;
        emit({
            type: 'response.output_text.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            content_index: contentIndex,
            item_id: outputItemId,
            text: content
        });
        emit({
            type: 'response.content_part.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            content_index: contentIndex,
            item_id: outputItemId,
            part: { type: 'output_text', text: content }
        });
        emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            item: {
                id: outputItemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: content }]
            }
        });
    };

    /** @param {Record<string, unknown>} response Completed response object. @returns {void} */
    const complete = (response) => {
        emit({ type: 'response.completed', sequence_number: nextSeq(), response });
    };

    return {
        responseId,
        streamedToolCalls,
        start,
        functionCall,
        reasoningDelta,
        textDelta,
        finishReasoning,
        finishText,
        complete,
        done: () => {
            writeSseDone(res);
        }
    };
}
