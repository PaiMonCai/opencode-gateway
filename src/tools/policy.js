/**
 * Tool policy evaluation.
 *
 * A policy context is derived from configuration once per request and then consulted for
 * every parsed call: an allowlist short-circuits to allow, a denylist denies, and anything
 * else falls back to the risk/confirmation rules.
 *
 * @module tools/policy
 */

import { TOOL_POLICY_DECISIONS, TOOL_RISK_LEVELS, TOOL_SIDE_EFFECTS } from './contract.js';

/**
 * Configuration keys the policy reads.
 *
 * @typedef {object} PolicyConfig
 * @property {string} [EXTERNAL_TOOL_POLICY_MODE] `enforce` (default) or `report-only`.
 * @property {string} [EXTERNAL_TOOL_DEFAULT_RISK_LEVEL] Risk level for unclassified tools.
 * @property {string[]} [EXTERNAL_TOOL_ALLOWLIST] Names allowed without further checks.
 * @property {string[]} [EXTERNAL_TOOL_DENYLIST] Names always denied.
 * @property {string[]} [EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR] Names needing confirmation.
 */

/**
 * Normalized policy state.
 *
 * @typedef {object} PolicyContext
 * @property {string} mode Enforcement mode.
 * @property {string} defaultRiskLevel Risk level for unclassified tools.
 * @property {Set<string>} allowlist Allowed names.
 * @property {Set<string>} denylist Denied names.
 * @property {Set<string>} confirmationRequired Names needing confirmation.
 */

/**
 * Result of evaluating one call.
 *
 * @typedef {object} PolicyDecision
 * @property {string} status One of {@link TOOL_POLICY_DECISIONS}.
 * @property {string} [code] Machine-readable reason for a denial.
 * @property {string} [reason] Human-readable reason.
 * @property {string} [effectiveRisk] Risk level the call was allowed at.
 * @property {{
 *     toolName: string,
 *     namespacedName: string,
 *     argumentsPreview: unknown,
 *     risk: string
 * }} [confirmationPayload] What the client must confirm, when confirmation is required.
 */

/**
 * Turn a configuration list into a set of non-empty trimmed names.
 *
 * @param {unknown} values Configured names.
 * @returns {Set<string>} Normalized names.
 */
function toSet(values) {
    if (!Array.isArray(values)) return new Set();
    return new Set(
        values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    );
}

/**
 * Normalize a configuration object into a policy context.
 *
 * @param {PolicyConfig} [config] Configuration to read.
 * @returns {PolicyContext} Normalized policy state.
 */
export function createPolicyContext(config = {}) {
    return {
        mode: config.EXTERNAL_TOOL_POLICY_MODE || 'enforce',
        defaultRiskLevel: config.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL || TOOL_RISK_LEVELS.LOW,
        allowlist: toSet(config.EXTERNAL_TOOL_ALLOWLIST || []),
        denylist: toSet(config.EXTERNAL_TOOL_DENYLIST || []),
        confirmationRequired: toSet(config.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR || [])
    };
}

/**
 * Evaluate whether one tool call may run.
 *
 * Order matters: an allowlist entry always allows, a denylist entry always denies, and
 * only then do the destructive/RISK rules apply. `report-only` mode records the
 * confirmation requirement without blocking.
 *
 * @param {import('./registry.js').ExternalTool|null|undefined} tool Registered tool.
 * @param {unknown} args Parsed arguments (used for the confirmation preview).
 * @param {{ config?: PolicyConfig }} [context] Policy context, already resolved.
 * @returns {PolicyDecision} Decision.
 */
export function evaluateToolPolicy(tool, args, context = {}) {
    if (!tool) {
        return {
            status: TOOL_POLICY_DECISIONS.DENY,
            code: 'unknown_tool',
            reason: 'Tool is not registered for this request.'
        };
    }

    const policy = createPolicyContext(context.config);
    const toolNames = [tool.originalName, tool.namespacedName].filter(Boolean);
    const inAllowlist = toolNames.some((name) => policy.allowlist.has(name));
    const inDenylist = toolNames.some((name) => policy.denylist.has(name));
    const requiresConfirmation =
        tool.requiresConfirmation || toolNames.some((name) => policy.confirmationRequired.has(name));

    if (inAllowlist) {
        return {
            status: TOOL_POLICY_DECISIONS.ALLOW,
            effectiveRisk: tool.riskLevel || policy.defaultRiskLevel
        };
    }

    if (inDenylist) {
        return {
            status: TOOL_POLICY_DECISIONS.DENY,
            code: 'tool_denied_by_policy',
            reason: `Tool ${tool.originalName} is denied by policy.`
        };
    }

    if (
        !inAllowlist &&
        (tool.sideEffect === TOOL_SIDE_EFFECTS.DELETE || tool.riskLevel === TOOL_RISK_LEVELS.CRITICAL)
    ) {
        return {
            status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
            reason: `Tool ${tool.originalName} is high risk and requires confirmation.`,
            confirmationPayload: {
                toolName: tool.originalName,
                namespacedName: tool.namespacedName,
                argumentsPreview: args,
                risk: tool.riskLevel
            }
        };
    }

    if (requiresConfirmation && policy.mode !== 'report-only') {
        return {
            status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
            reason: `Tool ${tool.originalName} requires confirmation before execution.`,
            confirmationPayload: {
                toolName: tool.originalName,
                namespacedName: tool.namespacedName,
                argumentsPreview: args,
                risk: tool.riskLevel
            }
        };
    }

    return {
        status: TOOL_POLICY_DECISIONS.ALLOW,
        effectiveRisk: tool.riskLevel || policy.defaultRiskLevel
    };
}
