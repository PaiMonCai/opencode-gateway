/**
 * Pure helpers for resolving configured internal OpenCode tool allowlists.
 *
 * @module tools/internal-resolution
 */

/**
 * Lowercase and drop separators so `web_fetch`, `WebFetch` and `webfetch`
 * compare in the same namespace.
 *
 * @param {unknown} name Tool name as configured or discovered.
 * @returns {string} Normalized name.
 */
export function normalizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9./]/g, '');
}

/**
 * @param {Array<unknown>} [entries] Configured tool names.
 * @returns {string[]} Trimmed, de-duplicated, non-empty names.
 */
export function normalizeConfiguredToolNames(entries = []) {
    return [...new Set(entries.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

/**
 * @param {Array<unknown>} [ids] Tool ids as reported by the backend.
 * @returns {string[]} Non-empty string ids.
 */
export function normalizeBackendToolIds(ids = []) {
    return /** @type {string[]} */ (ids.filter((id) => typeof id === 'string' && id.trim()));
}

/**
 * @param {unknown} toolId Backend tool id.
 * @param {string} allowedToolName Configured name.
 * @returns {boolean} Whether both values refer to the same built-in tool.
 */
export function matchesAllowedToolName(toolId, allowedToolName) {
    const id = normalizeToolName(toolId);
    const name = normalizeToolName(allowedToolName);
    if (!id || !name) return false;
    return id === name || id.endsWith(`.${name}`) || id.endsWith(`/${name}`);
}

/**
 * Resolve a configured allowlist against the backend's discovered tool ids.
 *
 * @param {Array<unknown>} [ids] Backend tool ids.
 * @param {Array<unknown>} [allowedToolNames] Configured names.
 * @returns {{normalizedIds: string[], normalizedAllowedNames: string[], matchedToolIds: string[], unmatchedAllowedNames: string[]}}
 *   Normalized inputs and match results.
 */
export function resolveInternalAllowedToolIds(ids = [], allowedToolNames = []) {
    const normalizedIds = normalizeBackendToolIds(ids);
    const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames);
    /** @type {Set<string>} */
    const matchedToolIds = new Set();
    /** @type {string[]} */
    const unmatchedAllowedNames = [];

    normalizedAllowedNames.forEach((allowedToolName) => {
        const matches = normalizedIds.filter((toolId) => matchesAllowedToolName(toolId, allowedToolName));
        if (matches.length === 0) {
            unmatchedAllowedNames.push(allowedToolName);
            return;
        }
        matches.forEach((match) => matchedToolIds.add(match));
    });

    return {
        normalizedIds,
        normalizedAllowedNames,
        matchedToolIds: [...matchedToolIds],
        unmatchedAllowedNames
    };
}

/**
 * @param {string[]} [ids] Backend tool ids.
 * @returns {Record<string, boolean>} Every id mapped to false.
 */
export function buildDisabledToolOverrides(ids = []) {
    /** @type {Record<string, boolean>} */
    const overrides = {};
    ids.forEach((id) => {
        overrides[id] = false;
    });
    return overrides;
}
