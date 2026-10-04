/**
 * Public surface of the tool-bridge module.
 *
 * The runtime path virtualizes client tools as a text contract; these exports are the
 * pieces a route needs to build the prompt, parse what comes back, validate it, and
 * replay the result on the next turn.
 *
 * @module tools
 */

export {
    ASSISTANT_ROLE_PREFIX,
    EXTERNAL_TOOL_PREFIX,
    FUNCTION_CALLS_CLOSE_TAG,
    FUNCTION_CALLS_OPEN_TAG,
    TOOL_POLICY_DECISIONS,
    TOOL_RESULT_ROLE_PREFIX,
    TOOL_RISK_LEVELS,
    TOOL_SIDE_EFFECTS,
    VALIDATION_STATUSES,
    buildCallId,
    buildForcedToolCallPrompt,
    createValidationError,
    fallbackCallId,
    formatAssistantToolCallsLine,
    formatToolResultLine,
    normalizeRiskLevel,
    normalizeSideEffect,
    sanitizeToolNameForId,
    serializeToolArguments
} from './contract.js';

export {
    buildExternalToolRegistry,
    createRegistryIndex,
    findExternalToolByName,
    normalizeToolDefinition
} from './registry.js';

export {
    createExternalToolCallStreamParser,
    createToolCallFilter,
    parseExternalToolCallsFromText,
    parseToolCallsFromText,
    stripFunctionCallMarkup
} from './parser.js';

export { createPolicyContext, evaluateToolPolicy } from './policy.js';

export { validateToolCall, validateToolCalls } from './validator.js';

export {
    buildAssistantToolCallsLine,
    buildExternalToolsPrompt,
    buildExternalToolsReminder,
    buildToolExposure,
    buildToolResultLine,
    normalizeExternalToolChoice,
    rememberAssistantToolCalls,
    resolveToolResultTarget,
    serializeAssistantToolCalls
} from './router.js';
