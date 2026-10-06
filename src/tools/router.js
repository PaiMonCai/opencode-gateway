/**
 * Request-level tool exposure and replay: what the model is told about the declared tools
 * (`tool_choice` semantics, the contract prompt and its final reminder), and how a previous
 * turn's tool calls and results are replayed into the transcript in text-contract form.
 *
 * @module tools/router
 */

import {
    EXTERNAL_TOOL_PREFIX,
    fallbackCallId,
    formatAssistantToolCallsLine,
    formatToolResultLine,
    serializeToolArguments
} from './contract.js';
import { findExternalToolByName } from './registry.js';

/**
 * Map `tool_choice` onto the contract's three modes.
 *
 * Chat Completions sends `{ type:'function', function:{ name } }`; the Responses API
 * sends `{ type:'function', name }`. Both are accepted so a forced tool choice is not
 * silently ignored.
 *
 * @param {unknown} toolChoice Raw `tool_choice` value.
 * @param {import('./registry.js').ExternalTool[]|unknown} registry Request registry.
 * @returns {import('./contract.js').NormalizedToolChoice} Normalized choice.
 */
export function normalizeExternalToolChoice(toolChoice, registry) {
    if (!toolChoice || !Array.isArray(registry) || registry.length === 0) {
        return { mode: 'auto', requiredTool: null };
    }
    if (toolChoice === 'auto' || toolChoice === 'none') {
        return { mode: toolChoice, requiredTool: null };
    }
    if (toolChoice === 'required') {
        return { mode: 'required', requiredTool: null };
    }
    const choice = /** @type {{ type?: unknown, name?: unknown, function?: { name?: unknown } }} */ (
        toolChoice
    );
    const requestedName = choice?.function?.name || choice?.name;
    if (choice?.type === 'function' && requestedName) {
        const mappedTool = findExternalToolByName(registry, requestedName);
        return {
            mode: 'required',
            requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${String(requestedName)}`
        };
    }
    return { mode: 'auto', requiredTool: null };
}

/**
 * The system-prompt section that states the text contract for the exposed tools.
 *
 * @param {import('./registry.js').ExternalTool[]|unknown} registry Exposed registry.
 * @param {unknown} [toolChoice] Raw `tool_choice`.
 * @returns {string} Prompt section, or an empty string when there are no tools.
 */
export function buildExternalToolsPrompt(registry, toolChoice = null) {
    if (!Array.isArray(registry) || registry.length === 0) return '';
    const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
    /** @type {string[]} */
    const choiceInstructions = [];
    if (normalizedChoice.mode === 'required') {
        if (normalizedChoice.requiredTool) {
            choiceInstructions.push(
                `Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`
            );
        } else {
            choiceInstructions.push(
                'Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.'
            );
        }
    } else if (normalizedChoice.mode === 'none') {
        choiceInstructions.push('Tool use is disabled for this turn. Do not emit <function_calls>.');
    }

    return [
        'External tools are virtualized by this proxy. They are not OpenCode tools.',
        'When you need an external tool, your entire assistant reply MUST be ONLY one or more <function_calls>...</function_calls> blocks.',
        'Do NOT output <think>, explanations, markdown, prose, or any text before or after <function_calls> blocks when making a tool call.',
        'Each block must contain JSON with this exact shape:',
        '{"name":"external__tool_name","arguments":{}}',
        'Arguments must be a valid JSON object that matches the declared schema.',
        'Use only the namespaced names listed below. Do not use original client tool names inside function calls.',
        'If tool results are later provided as TOOL_RESULT messages, use those results to continue normally.',
        ...choiceInstructions,
        `Available external tools: ${JSON.stringify(
            registry.map((tool) => ({
                name: tool.namespacedName,
                client_name: tool.originalName,
                description: tool.description,
                parameters: tool.parameters,
                risk_level: tool.riskLevel,
                side_effect: tool.sideEffect,
                requires_confirmation: tool.requiresConfirmation
            }))
        )}`
    ].join('\n');
}

/**
 * Short imperative restatement of the markup contract, appended as the final prompt part
 * rather than buried in the system prompt.
 *
 * Position matters more than wording: with the contract only in the system prompt the
 * markup is frequently missed, and harnesses like pi send system prompts of 16KB or more,
 * where it gets lost entirely.
 *
 * @param {import('./registry.js').ExternalTool[]|unknown} registry Exposed registry.
 * @param {unknown} [toolChoice] Raw `tool_choice`.
 * @returns {string} Reminder text, or an empty string when tools are off or unused.
 */
export function buildExternalToolsReminder(registry, toolChoice = null) {
    if (!Array.isArray(registry) || registry.length === 0) return '';
    const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
    if (normalizedChoice.mode === 'none') return '';
    const exampleName = normalizedChoice.requiredTool || registry[0].namespacedName;
    return [
        'REMINDER: External tools are called by emitting markup, not through any native tool API.',
        `To call one, your entire reply must be ONLY <function_calls>{"name":"${exampleName}","arguments":{...}}</function_calls>`,
        'with no prose, no markdown and no <think> block. Otherwise answer normally.',
        `Available names: ${registry.map((tool) => tool.namespacedName).join(', ')}`
    ].join('\n');
}

/**
 * Full exposure for one request: the enabled tools, the normalized choice, and the two
 * prompt fragments that carry the contract.
 *
 * @param {import('./registry.js').ExternalTool[]|unknown} registry Request registry.
 * @param {unknown} [toolChoice] Raw `tool_choice`.
 * @returns {{
 *     tools: import('./registry.js').ExternalTool[],
 *     toolChoice: import('./contract.js').NormalizedToolChoice,
 *     prompt: string,
 *     reminder: string
 * }} Exposure.
 */
export function buildToolExposure(registry, toolChoice = null) {
    const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
    const exposedTools = Array.isArray(registry) ? registry.filter((tool) => tool.enabled !== false) : [];
    return {
        tools: exposedTools,
        toolChoice: normalizedChoice,
        prompt: buildExternalToolsPrompt(exposedTools, toolChoice),
        reminder: buildExternalToolsReminder(exposedTools, toolChoice)
    };
}

/**
 * Serialize a previous assistant turn's tool calls for replay.
 *
 * Names are mapped back into the `external__` namespace; ids echoed by the client are
 * preserved and an id-less call falls back to `call_<n>`.
 *
 * @param {unknown} toolCalls Calls as received from the client.
 * @param {import('./registry.js').ExternalTool[]} [registry] Request registry.
 * @returns {Array<{ id: string, name: string, arguments: string }>} Serialized calls.
 */
export function serializeAssistantToolCalls(toolCalls, registry = []) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
    return /** @type {Array<{ id: string, name: string, arguments: string }>} */ (
        toolCalls
            .map((toolCall, index) => {
                const call =
                    /** @type {{ call_id?: string, id?: string, name?: string, arguments?: unknown, function?: { name?: string, arguments?: unknown } }} */ (
                        toolCall
                    );
                const rawName = call?.function?.name || call?.name;
                const mappedTool = findExternalToolByName(registry, rawName);
                const name = mappedTool?.namespacedName || rawName;
                if (!name) return null;
                return {
                    id: call?.call_id || call?.id || `call_${index + 1}`,
                    name,
                    arguments: serializeToolArguments(call?.function?.arguments ?? call?.arguments)
                };
            })
            .filter(Boolean)
    );
}

/**
 * Replay line for an assistant turn that carried tool calls.
 *
 * @param {unknown} toolCalls Calls as received from the client.
 * @param {import('./registry.js').ExternalTool[]} [registry] Request registry.
 * @returns {string|null} `ASSISTANT: <function_calls>[...]</function_calls>`, or null.
 */
export function buildAssistantToolCallsLine(toolCalls, registry = []) {
    return formatAssistantToolCallsLine(serializeAssistantToolCalls(toolCalls, registry));
}

/**
 * Resolve the namespaced name and call id of a replayed tool result.
 *
 * The result may carry the tool name, the id of the assistant call it answers, or both.
 * The assistant-call map fills in whichever is missing; an unresolvable name becomes
 * `external__unknown` so the line still parses at the other end.
 *
 * @param {{ name?: string, toolCallId?: string }} source Result as received.
 * @param {object} options Resolution context.
 * @param {import('./registry.js').ExternalTool[]} [options.registry] Request registry.
 * @param {Map<string, string>} [options.assistantToolCalls] Assistant call id → namespaced name.
 * @returns {{ name: string, toolCallId: string }} Resolved name and id.
 */
export function resolveToolResultTarget(source, options = {}) {
    const { registry = [], assistantToolCalls = new Map() } = options;
    const remembered = source?.toolCallId ? assistantToolCalls.get(source.toolCallId) : undefined;
    const mappedTool =
        findExternalToolByName(registry, source?.name) || findExternalToolByName(registry, remembered);
    const name = mappedTool?.namespacedName || remembered || source?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
    return { name, toolCallId: source?.toolCallId || fallbackCallId(name) };
}

/**
 * Replay line for a tool result, resolving its name against the request registry.
 *
 * @param {{ name?: string, toolCallId?: string, content: string }} result Result as received.
 * @param {object} [options] Resolution context.
 * @param {import('./registry.js').ExternalTool[]} [options.registry] Request registry.
 * @param {Map<string, string>} [options.assistantToolCalls] Assistant call id → namespaced name.
 * @returns {string|null} `TOOL_RESULT: {...}`, or null when there is no content.
 */
export function buildToolResultLine(result, options = {}) {
    const target = resolveToolResultTarget(result, options);
    if (options.assistantToolCalls) options.assistantToolCalls.set(target.toolCallId, target.name);
    return formatToolResultLine({
        toolCallId: target.toolCallId,
        name: target.name,
        content: result?.content
    });
}

/**
 * Remember the assistant calls a turn issued, so the matching results can resolve their
 * names on the next request.
 *
 * @param {unknown} toolCalls Calls as received from the client.
 * @param {import('./registry.js').ExternalTool[]} [registry] Request registry.
 * @param {Map<string, string>} [target] Map to fill; a new one is created when omitted.
 * @returns {Map<string, string>} Call id → namespaced name.
 */
export function rememberAssistantToolCalls(toolCalls, registry = [], target = new Map()) {
    serializeAssistantToolCalls(toolCalls, registry).forEach((call) => {
        target.set(call.id, call.name);
    });
    return target;
}
