/**
 * Pure tool-policy helpers for the runtime plugin.
 *
 * Kept in a **separate module on purpose**: opencode 1.18 loads every function a plugin
 * file exports as a plugin of its own, and the bogus entries it registers make
 * `Plugin.trigger` fail on every turn (`TypeError: null is not an object`). Only
 * `opencode-gateway-tool-lock.js` may be listed in the runtime's `plugin` configuration.
 *
 * @module plugin/tool-policy
 */

/** Session-title policy marker. @type {RegExp} */
export const POLICY = /\[tools:([^\]]*)\]/;
/** How many parent sessions to walk before giving up. @type {number} */
export const MAX_DEPTH = 8;

/**
 * Normalise a tool name for comparison: lowercase, without separators, so
 * `Web_Fetch`, `web-fetch` and `webfetch` all compare equal.
 *
 * @param {string} name Raw tool name.
 * @returns {string} Normalised name.
 */
export const normalizeToolName = (name) =>
    String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9./]/g, '');

/**
 * Whether a requested tool is covered by one entry of the session policy.
 *
 * Entries match the tool name exactly, or as a suffix after `.`/`/`, which is
 * how namespaced tool ids (`server.webfetch`, `mcp/read`) stay addressable.
 *
 * @param {string} tool Requested tool name.
 * @param {string} name Policy entry.
 * @returns {boolean} True when the policy allows the tool.
 */
export const toolMatches = (tool, name) => {
    const t = normalizeToolName(tool);
    const n = normalizeToolName(name);
    if (!t || !n) return false;
    return t === n || t.endsWith('.' + n) || t.endsWith('/' + n);
};

/**
 * Read the policy out of a session title.
 *
 * @param {string} title Session title.
 * @returns {string|null} Policy payload (`'*'`, `'none'`, `'read,webfetch'`),
 *   or `null` when the title carries none.
 */
export const parsePolicy = (title) => {
    const found = POLICY.exec(String(title || ''));
    return found ? found[1].trim() : null;
};

/**
 * Message used when a tool is blocked by the session policy.
 *
 * @param {string} tool Requested tool name.
 * @returns {string} Error message.
 */
export const denyMessage = (tool) => `Tool "${tool}" is disabled by opencode-gateway. Do not call it again.`;

/**
 * Steer a native call to a bridged external tool back to the text contract.
 *
 * External tools only exist as text in the system prompt; models that call them natively
 * land in OpenCode's "invalid" tool.
 *
 * @param {string} requested Requested tool name.
 * @returns {string} Error message.
 */
export const externalToolMessage = (requested) =>
    `${requested} is not a native tool. Call it by replying with only ` +
    `<function_calls>{"name":"${requested}","arguments":{...}}</function_calls>`;
