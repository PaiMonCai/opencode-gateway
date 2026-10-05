/**
 * Chat transcript -> runtime prompt rendering.
 *
 * This module owns only the pure/request-local transcript rendering needed by
 * Chat Completions. Turn/session ownership stays in the route orchestrator.
 *
 * @module routes/chat-prompt
 */

import { getImageDataUri } from '../http/image-data.js';
import { EXTERNAL_TOOL_PREFIX, findExternalToolByName } from '../tools/index.js';
import { normalizeTextContent, normalizeToolArguments } from './input-normalization.js';

/**
 * @typedef {object} ChatPromptBuilderOptions
 * @property {(message: string, fields?: unknown) => void} [logWarn] Warning logger.
 */

/**
 * Build one request-local Chat prompt renderer.
 *
 * @param {ChatPromptBuilderOptions} [options] Builder dependencies.
 * @returns {(rawMessages: Array<Record<string, any>>, externalToolRegistry?: import('../tools/registry.js').ExternalTool[], options?: {toolCallMap?: Map<string|undefined,string|undefined>, includeFromIndex?: number}) => Promise<{parts: Array<Record<string, unknown>>, system: string, fullPromptText: string, lastUserMsg: string}>}
 */
export function createChatPromptBuilder({ logWarn = () => {} } = {}) {
    return async function buildPromptParts(rawMessages, externalToolRegistry = [], options = {}) {
        /** @type {Array<Record<string, unknown>>} */
        const parts = [];
        /** @type {string[]} */
        const systemChunks = [];
        /** @type {string[]} */
        const userContents = [];
        /** @type {Map<string|undefined, string|undefined>} */
        const assistantToolCalls = options.toolCallMap || new Map();
        const includeFromIndex =
            Number.isInteger(options.includeFromIndex) && Number(options.includeFromIndex) > 0
                ? Number(options.includeFromIndex)
                : 0;
        let deliveredCount = -1;
        /** @type {string[]} */
        const historyTexts = [];

        /**
         * @param {string} role Message role.
         * @param {string|undefined} name Optional author name.
         * @param {string} text Rendered text.
         * @returns {string} Role-prefixed line.
         */
        const formatRoleLine = (role, name, text) => {
            const roleLabel = role.toUpperCase();
            const nameSuffix = name ? `(${name})` : '';
            return `${roleLabel}${nameSuffix}: ${text}`;
        };

        for (const m of rawMessages) {
            const role = String(m?.role || 'user').toLowerCase();
            const content = m?.content;

            if (role === 'system') {
                const text = normalizeTextContent(content);
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
                    const line = `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
                    historyTexts.push(line);
                    if (deliver) parts.push({ type: 'text', text: line });
                }
            }

            if (role === 'tool') {
                const text = normalizeTextContent(content);
                if (text) {
                    const mappedTool =
                        findExternalToolByName(externalToolRegistry, m?.name) ||
                        findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id));
                    const toolName =
                        mappedTool?.namespacedName ||
                        assistantToolCalls.get(m?.tool_call_id) ||
                        m?.name ||
                        `${EXTERNAL_TOOL_PREFIX}unknown`;
                    const toolCallId = m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    const toolResultText = `TOOL_RESULT: ${JSON.stringify({
                        tool_call_id: toolCallId,
                        name: toolName,
                        content: text
                    })}`;
                    historyTexts.push(toolResultText);
                    if (deliver) parts.push({ type: 'text', text: toolResultText });
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
                continue;
            }

            if (!Array.isArray(content)) continue;
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
                    continue;
                }

                if (part.type !== 'image_url' || !deliver) continue;
                const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                if (!imageUrl) continue;

                try {
                    const dataUri = await getImageDataUri(imageUrl);
                    const mime = dataUri.split(';')[0].split(':')[1];
                    parts.push({ type: 'file', mime, url: dataUri, filename: 'image' });
                } catch (error) {
                    logWarn('[Proxy] Skipping image due to error:', {
                        error: error instanceof Error ? error.message : String(error)
                    });
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
}
