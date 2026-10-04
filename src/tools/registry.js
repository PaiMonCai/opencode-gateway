/**
 * External tool registry.
 *
 * Normalizes the two function-tool shapes a request can carry, assigns the
 * `external__` namespace (keeping duplicates apart), infers risk/side-effect metadata,
 * and resolves the names a model actually emits back to the declared tool.
 *
 * @module tools/registry
 */

import {
    EXTERNAL_TOOL_PREFIX,
    TOOL_RISK_LEVELS,
    TOOL_SIDE_EFFECTS,
    normalizeRiskLevel,
    normalizeSideEffect
} from './contract.js';

/**
 * The two accepted declaration shapes, normalized.
 *
 * Chat Completions nests the definition: `{ type:'function', function:{ name, parameters } }`.
 * The Responses API keeps it flat: `{ type:'function', name, parameters }`.
 *
 * @typedef {object} NormalizedToolDefinition
 * @property {string} name Declared (client-facing) name.
 * @property {unknown} description Declared description.
 * @property {unknown} parameters JSON schema of the arguments.
 * @property {unknown} enabled `false` removes the tool from exposure.
 * @property {unknown} x_proxy_side_effect Explicit side effect override.
 * @property {unknown} x_proxy_risk_level Explicit risk level override.
 * @property {unknown} x_proxy_requires_confirmation Explicit confirmation override.
 */

/**
 * One entry of the external tool registry.
 *
 * @typedef {object} ExternalTool
 * @property {string} id Stable synthetic id (`external_tool_<n>`).
 * @property {string} originalName Client-facing name.
 * @property {string} namespacedName Name presented to the model (`external__<name>`).
 * @property {string} description Trimmed description.
 * @property {Record<string, unknown>} parameters Normalized JSON schema.
 * @property {string} sideEffect Inferred or declared side effect.
 * @property {string} riskLevel Inferred or declared risk level.
 * @property {boolean} requiresConfirmation Whether policy confirmation is needed.
 * @property {boolean} enabled Whether the tool is exposed to the model.
 * @property {unknown} sourceTool The declaration this entry came from.
 */

/**
 * @typedef {object} BuildRegistryOptions
 * @property {string} [prefix] Namespace prefix override.
 */

/**
 * Trim a declared description to a string.
 *
 * @param {unknown} value Declared description.
 * @returns {string} Trimmed description, or an empty string.
 */
function normalizeDescription(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Keep a usable JSON schema, falling back to an empty object schema.
 *
 * @param {unknown} parameters Declared parameters.
 * @returns {Record<string, unknown>} Usable schema object.
 */
function normalizeParameters(parameters) {
    if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
        return /** @type {Record<string, unknown>} */ (parameters);
    }
    return { type: 'object', properties: {} };
}

/**
 * Normalize a function-tool declaration from either API shape.
 *
 * Callers used to read `tool.function.name` directly, so every Responses-API tool was
 * silently dropped from the registry. An empty registry means no tool contract reaches
 * the prompt and no tool-call markup is ever parsed back out, which is indistinguishable
 * from a model that simply refuses to call tools.
 *
 * @param {unknown} tool Raw declaration.
 * @returns {NormalizedToolDefinition|null} Normalized definition, or null when unusable.
 */
export function normalizeToolDefinition(tool) {
    if (!tool || typeof tool !== 'object') return null;
    const candidate = /** @type {Record<string, unknown>} */ (tool);
    if (candidate.type !== 'function') return null;
    const definition =
        candidate.function && typeof candidate.function === 'object'
            ? /** @type {Record<string, unknown>} */ (candidate.function)
            : candidate;
    const name = String(definition.name || '').trim();
    if (!name) return null;
    return {
        name,
        description: definition.description,
        parameters: definition.parameters,
        enabled: definition.enabled,
        x_proxy_side_effect: definition.x_proxy_side_effect ?? candidate.x_proxy_side_effect,
        x_proxy_risk_level: definition.x_proxy_risk_level ?? candidate.x_proxy_risk_level,
        x_proxy_requires_confirmation:
            definition.x_proxy_requires_confirmation ?? candidate.x_proxy_requires_confirmation
    };
}

/**
 * Infer the side effect of a tool from an explicit declaration or its name prefix.
 *
 * @param {Partial<NormalizedToolDefinition>} [definition] Normalized definition.
 * @returns {string} Side effect.
 */
function inferSideEffect(definition = {}) {
    const declared = definition.x_proxy_side_effect;
    if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

    const name = String(definition.name || '').toLowerCase();
    if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
    if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
    if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
    return TOOL_SIDE_EFFECTS.NONE;
}

/**
 * Infer the risk level from an explicit declaration or the side effect.
 *
 * @param {Partial<NormalizedToolDefinition>} [definition] Normalized definition.
 * @param {string} [sideEffect] Inferred side effect.
 * @returns {string} Risk level.
 */
function inferRiskLevel(definition = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE) {
    const declared = definition.x_proxy_risk_level;
    if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
    if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
        return TOOL_RISK_LEVELS.CRITICAL;
    }
    if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
        return TOOL_RISK_LEVELS.MEDIUM;
    }
    return TOOL_RISK_LEVELS.LOW;
}

/**
 * Decide whether a tool needs explicit confirmation before execution.
 *
 * @param {Partial<NormalizedToolDefinition>} [definition] Normalized definition.
 * @param {string} [sideEffect] Inferred side effect.
 * @param {string} [riskLevel] Inferred risk level.
 * @returns {boolean} True when confirmation is required.
 */
function inferRequiresConfirmation(
    definition = {},
    sideEffect = TOOL_SIDE_EFFECTS.NONE,
    riskLevel = TOOL_RISK_LEVELS.LOW
) {
    if (typeof definition.x_proxy_requires_confirmation === 'boolean') {
        return definition.x_proxy_requires_confirmation;
    }
    return (
        sideEffect === TOOL_SIDE_EFFECTS.WRITE ||
        riskLevel === TOOL_RISK_LEVELS.HIGH ||
        riskLevel === TOOL_RISK_LEVELS.CRITICAL
    );
}

/**
 * Build the registry for one request's declared tools.
 *
 * Duplicate client names are kept apart by suffixing `_2`, `_3`, ... so the model never
 * sees two identical names.
 *
 * @param {unknown} tools Declared tools, in either API shape.
 * @param {BuildRegistryOptions} [options] Registry options.
 * @returns {ExternalTool[]} Registry, in declaration order.
 */
export function buildExternalToolRegistry(tools, options = {}) {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    const prefix = options.prefix || EXTERNAL_TOOL_PREFIX;
    /** @type {ExternalTool[]} */
    const registry = [];
    const seenNamespaced = new Set();

    tools.forEach((tool, index) => {
        const definition = normalizeToolDefinition(tool);
        if (!definition) return;
        const originalName = definition.name;

        let namespacedName = `${prefix}${originalName}`;
        let counter = 2;
        while (seenNamespaced.has(namespacedName)) {
            namespacedName = `${prefix}${originalName}_${counter}`;
            counter += 1;
        }
        seenNamespaced.add(namespacedName);

        const sideEffect = inferSideEffect(definition);
        const riskLevel = inferRiskLevel(definition, sideEffect);
        registry.push({
            id: `external_tool_${index + 1}`,
            originalName,
            namespacedName,
            description: normalizeDescription(definition.description),
            parameters: normalizeParameters(definition.parameters),
            sideEffect,
            riskLevel,
            requiresConfirmation: inferRequiresConfirmation(definition, sideEffect, riskLevel),
            enabled: definition.enabled !== false,
            sourceTool: tool
        });
    });

    return registry;
}

/**
 * Resolve a model-emitted name to a registry entry.
 *
 * Exact namespaced/original matches win. Models frequently drop separators or change
 * case when emitting a name (the request declares `web_fetch`, the model writes
 * `webfetch`), so a separator/case-insensitive match is accepted as a fallback — but
 * only when it is unambiguous: an exact match always wins and a tie resolves to nothing.
 *
 * @param {ExternalTool[]|unknown} registry Registry to search.
 * @param {unknown} name Name as emitted.
 * @returns {ExternalTool|null} Matching entry, or null.
 */
export function findExternalToolByName(registry, name) {
    if (!name || !Array.isArray(registry)) return null;
    const exact = registry.find((tool) => tool.namespacedName === name || tool.originalName === name);
    if (exact) return exact;

    const normalized = normalizeToolNameForMatch(name);
    if (!normalized) return null;
    const matches = registry.filter(
        (tool) =>
            normalizeToolNameForMatch(tool.namespacedName) === normalized ||
            normalizeToolNameForMatch(tool.originalName) === normalized
    );
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Normalize a tool name for the fuzzy fallback lookup: lower case, separators dropped.
 *
 * @param {unknown} name Name to normalize.
 * @returns {string} Normalized name.
 */
function normalizeToolNameForMatch(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Build name lookups for callers that resolve many names per turn.
 *
 * @param {ExternalTool[]|null|undefined} registry Registry to index.
 * @returns {{ byOriginalName: Map<string, ExternalTool>, byNamespacedName: Map<string, ExternalTool> }}
 *   Index by both accepted names.
 */
export function createRegistryIndex(registry) {
    /** @type {Map<string, ExternalTool>} */
    const byOriginalName = new Map();
    /** @type {Map<string, ExternalTool>} */
    const byNamespacedName = new Map();
    (registry || []).forEach((tool) => {
        byOriginalName.set(tool.originalName, tool);
        byNamespacedName.set(tool.namespacedName, tool);
    });
    return { byOriginalName, byNamespacedName };
}
