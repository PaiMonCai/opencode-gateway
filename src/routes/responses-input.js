/**
 * Responses API input -> chat-shaped transcript normalization.
 *
 * @module routes/responses-input
 */

import { EXTERNAL_TOOL_PREFIX, findExternalToolByName } from '../tools/index.js';
import {
    normalizeTextContent,
    normalizeToolArguments,
    normalizeToolResultContent
} from './input-normalization.js';

/**
 * Build a request-local Responses input normalizer.
 *
 * @param {import('../tools/registry.js').ExternalTool[]} externalToolRegistry Request registry.
 * @returns {(rawItems: unknown) => Array<Record<string, any>>} Chat-shaped messages.
 */
export function createResponsesInputNormalizer(externalToolRegistry = []) {
    /** @type {Map<string|undefined,string|undefined>} */
    const assistantToolCalls = new Map();

    /**
     * @param {string|undefined} toolCallId Call id.
     * @param {string|undefined} toolName Tool name.
     * @returns {void}
     */
    const rememberAssistantToolCall = (toolCallId, toolName) => {
        if (!toolCallId || !toolName) return;
        assistantToolCalls.set(toolCallId, toolName);
    };

    /** @param {Record<string, any>} item Tool-result item. @returns {string|null} */
    const buildToolResultLine = (item = {}) => {
        const text = normalizeToolResultContent(item?.content ?? item?.output ?? item?.result ?? item?.text);
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
        return `TOOL_RESULT: ${JSON.stringify({
            tool_call_id: toolCallId,
            name: toolName,
            content: text
        })}`;
    };

    /** @param {Record<string, any>} item Assistant item. @returns {string|null} */
    const buildAssistantToolCallsLine = (item = {}) => {
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
                    arguments: normalizeToolArguments(toolCall?.arguments ?? toolCall?.function?.arguments)
                };
            })
            .filter(Boolean);

        if (!serializedToolCalls.length) return null;
        return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
    };

    return function buildResponsesInputMessages(rawItems) {
        /** @type {Array<Record<string, any>>} */
        const normalized = [];
        if (!Array.isArray(rawItems)) return normalized;

        for (const item of rawItems) {
            if (!item) continue;

            if (item.type === 'function_call_output' || item.type === 'tool_result' || item.role === 'tool') {
                const toolResultLine = buildToolResultLine(item);
                if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
                continue;
            }

            if (item.type === 'function_call') {
                const assistantToolCallsLine = buildAssistantToolCallsLine(item);
                if (assistantToolCallsLine) {
                    normalized.push({
                        role: 'assistant',
                        content: assistantToolCallsLine,
                        isToolCalls: true
                    });
                }
                continue;
            }

            if (item.role === 'assistant' && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
                const assistantToolCallsLine = buildAssistantToolCallsLine(item);
                if (assistantToolCallsLine) {
                    normalized.push({
                        role: 'assistant',
                        content: assistantToolCallsLine,
                        isToolCalls: true
                    });
                }
            }

            if (item.type === 'message') {
                const content = normalizeTextContent(item.content);
                if (content) normalized.push({ role: item.role || 'user', content });
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
}
