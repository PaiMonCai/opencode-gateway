/**
 * Text-contract primitives for the runtime tool bridge.
 *
 * The runtime path cannot hand a native tool list to a free-tier model, so declared
 * tools are virtualized: renamed into the `external__<name>` namespace, described in
 * the prompt, and asked back as markup
 * (`<function_calls>{"name":...,"arguments":{}}</function_calls>`). This module owns
 * that vocabulary only — namespaces, risk/side-effect enums, markup and replay tags,
 * call-id rules, and the prompts that state the contract.
 *
 * @module tools/contract
 */

/**
 * Namespace prefix that isolates client-declared tools from OpenCode's own tool names.
 *
 * @type {string}
 */
export const EXTERNAL_TOOL_PREFIX = 'external__';

/**
 * Canonical opening tag of a tool-call block.
 *
 * @type {string}
 */
export const FUNCTION_CALLS_OPEN_TAG = '<function_calls>';

/**
 * Canonical closing tag of a tool-call block.
 *
 * @type {string}
 */
export const FUNCTION_CALLS_CLOSE_TAG = '</function_calls>';

/**
 * Line prefix used when replaying an assistant turn that carried tool calls.
 *
 * @type {string}
 */
export const ASSISTANT_ROLE_PREFIX = 'ASSISTANT: ';

/**
 * Line prefix used when replaying a tool result turn.
 *
 * @type {string}
 */
export const TOOL_RESULT_ROLE_PREFIX = 'TOOL_RESULT: ';

/**
 * Declared risk level of a tool. Defaults are inferred from the tool name and
 * side effect, but a client may declare `x_proxy_risk_level` explicitly.
 *
 * @type {Readonly<{ LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' }>}
 */
export const TOOL_RISK_LEVELS = Object.freeze({
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
});

/**
 * Side effect a tool is expected to have. Used for risk inference and for the
 * confirmation policy.
 *
 * @type {Readonly<{
 *     NONE: 'none',
 *     READ: 'read',
 *     WRITE: 'write',
 *     DELETE: 'delete',
 *     EXTERNAL_NOTIFICATION: 'external_notification',
 *     PAYMENT: 'payment'
 * }>}
 */
export const TOOL_SIDE_EFFECTS = Object.freeze({
    NONE: 'none',
    READ: 'read',
    WRITE: 'write',
    DELETE: 'delete',
    EXTERNAL_NOTIFICATION: 'external_notification',
    PAYMENT: 'payment'
});

/**
 * Outcome of a policy evaluation for one tool call.
 *
 * @type {Readonly<{ ALLOW: 'allow', DENY: 'deny', REQUIRE_CONFIRMATION: 'require_confirmation' }>}
 */
export const TOOL_POLICY_DECISIONS = Object.freeze({
    ALLOW: 'allow',
    DENY: 'deny',
    REQUIRE_CONFIRMATION: 'require_confirmation'
});

/**
 * Outcome of validating one parsed tool call against its declared schema.
 *
 * @type {Readonly<{ VALID: 'valid', REPAIRABLE: 'repairable', REJECTED: 'rejected' }>}
 */
export const VALIDATION_STATUSES = Object.freeze({
    VALID: 'valid',
    REPAIRABLE: 'repairable',
    REJECTED: 'rejected'
});

/**
 * How a request wants tools to be used, derived from `tool_choice`.
 *
 * @typedef {object} NormalizedToolChoice
 * @property {'auto'|'none'|'required'} mode Requested mode.
 * @property {string|null} requiredTool Namespaced name of the forced tool, if any.
 */

/**
 * A raw call recovered from model output, before registry mapping.
 *
 * @typedef {object} RawToolCall
 * @property {string} [id] Call id echoed by the model, when present.
 * @property {string} name Name as emitted (namespaced or original).
 * @property {string|Record<string, unknown>} arguments Arguments as emitted.
 */

/**
 * A tool call in the OpenAI wire shape.
 *
 * @typedef {object} WireToolCall
 * @property {string} id Call id.
 * @property {'function'} type Always `function`.
 * @property {{ name: string, arguments: string }} function Function payload.
 */

/**
 * Validation problem attached to a rejected or repairable call.
 *
 * @typedef {object} ValidationErrorInfo
 * @property {string} code Machine-readable code.
 * @property {string} message Human-readable message.
 * @property {string[]} path Path of the offending argument.
 */

/** @type {string[]} */
const RISK_LEVEL_VALUES = Object.values(TOOL_RISK_LEVELS);

/** @type {string[]} */
const SIDE_EFFECT_VALUES = Object.values(TOOL_SIDE_EFFECTS);

/**
 * Coerce a declared risk level to a known value.
 *
 * @param {unknown} value Declared value.
 * @param {string} [fallback] Value used when `value` is unknown or empty.
 * @returns {string} A known risk level.
 */
export function normalizeRiskLevel(value, fallback = TOOL_RISK_LEVELS.LOW) {
    if (!value || typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    return RISK_LEVEL_VALUES.includes(normalized) ? normalized : fallback;
}

/**
 * Coerce a declared side effect to a known value.
 *
 * @param {unknown} value Declared value.
 * @param {string} [fallback] Value used when `value` is unknown or empty.
 * @returns {string} A known side effect.
 */
export function normalizeSideEffect(value, fallback = TOOL_SIDE_EFFECTS.NONE) {
    if (!value || typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    return SIDE_EFFECT_VALUES.includes(normalized) ? normalized : fallback;
}

/**
 * Build a validation error record.
 *
 * @param {string} code Machine-readable code.
 * @param {string} message Human-readable message.
 * @param {string[]} [path] Path of the offending argument.
 * @returns {ValidationErrorInfo} Validation error.
 */
export function createValidationError(code, message, path = []) {
    return { code, message, path };
}

/**
 * Reduce a tool name to the character set allowed in an OpenAI call id. Namespaced
 * names survive untouched (`external__bash` → `external__bash`), unknown characters
 * become underscores.
 *
 * @param {unknown} name Tool name.
 * @returns {string} Sanitized name.
 */
export function sanitizeToolNameForId(name) {
    return String(name ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Build the call id emitted for a bridged call: `call_<sanitized name>_<n>`. A bridged
 * call whose name is `external__bash` therefore yields `call_external__bash_1`.
 *
 * @param {string} name Namespaced tool name.
 * @param {number} sequence 1-based occurrence of that tool in the turn.
 * @returns {string} Call id.
 */
export function buildCallId(name, sequence) {
    return `call_${sanitizeToolNameForId(name)}_${sequence}`;
}

/**
 * Build the fallback call id used when a replayed tool result has no `tool_call_id`.
 *
 * @param {string} name Namespaced tool name.
 * @returns {string} Call id.
 */
export function fallbackCallId(name) {
    return `call_${sanitizeToolNameForId(name)}`;
}

/**
 * Serialize tool arguments for replay: strings pass through verbatim, an absent value
 * becomes `{}`, and anything else is JSON-encoded.
 *
 * @param {unknown} args Arguments as received from the client.
 * @returns {string} JSON text (or the original string).
 */
export function serializeToolArguments(args) {
    if (typeof args === 'string') return args;
    if (args === undefined) return '{}';
    try {
        return JSON.stringify(args);
    } catch {
        return '{}';
    }
}

/**
 * Render the replay line for an assistant turn that produced tool calls.
 *
 * @param {Array<{ id: string, name: string, arguments: string }>} calls Serialized calls.
 * @returns {string|null} `ASSISTANT: <function_calls>[...]</function_calls>`, or null when empty.
 */
export function formatAssistantToolCallsLine(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return null;
    return `${ASSISTANT_ROLE_PREFIX}${FUNCTION_CALLS_OPEN_TAG}${JSON.stringify(calls)}${FUNCTION_CALLS_CLOSE_TAG}`;
}

/**
 * Render the replay line for a tool result.
 *
 * @param {{ toolCallId: string, name: string, content: string }} result Result payload.
 * @returns {string|null} `TOOL_RESULT: {...}`, or null when there is no content.
 */
export function formatToolResultLine(result) {
    if (!result || !result.content) return null;
    return `${TOOL_RESULT_ROLE_PREFIX}${JSON.stringify({
        tool_call_id: result.toolCallId,
        name: result.name,
        content: result.content
    })}`;
}

/**
 * Build the single forced follow-up prompt used when `tool_choice` demanded a call but
 * the model answered with prose.
 *
 * @param {string} requiredTool Namespaced name of the forced tool.
 * @param {{ forbidThinkBlock?: boolean }} [options] Extra guard for models with a think channel.
 * @returns {string} Prompt text.
 */
export function buildForcedToolCallPrompt(requiredTool, options = {}) {
    const forbidThinkBlock = Boolean(options.forbidThinkBlock);
    return (
        'SYSTEM: Your previous reply did not emit the required external tool call. ' +
        `Reply now with ONLY ${FUNCTION_CALLS_OPEN_TAG}{"name":"${requiredTool}","arguments":{}}` +
        `${FUNCTION_CALLS_CLOSE_TAG} or an array inside ${FUNCTION_CALLS_OPEN_TAG}...` +
        `${FUNCTION_CALLS_CLOSE_TAG}. Do not output any prose, reasoning, markdown` +
        `${forbidThinkBlock ? ', or <think> block' : ''}. ` +
        'Infer the correct arguments from the conversation so far.'
    );
}
