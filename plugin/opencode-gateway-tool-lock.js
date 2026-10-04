// OpenCode server plugin loaded by the backend that opencode-gateway starts.
//
// OpenCode Zen's free tier rejects any request whose tool list differs from
// the one the official client sends ("free tier can only be used from within
// OpenCode"). Disabling tools per request strips them from that list, so the
// proxy leaves the list alone and enforces its tool policy here, at execution
// time, instead.
//
// The policy is carried in the session title the proxy sets when it creates a
// session: "[tools:none]", "[tools:*]" or "[tools:webfetch,read]". Sessions
// without a policy (and failed lookups) deny every tool. Child sessions spawned
// by the task tool inherit the policy of their parent.

/** Session-title policy marker. @type {RegExp} */
const POLICY = /\[tools:([^\]]*)\]/;
/** How many parent sessions to walk before giving up. @type {number} */
const MAX_DEPTH = 8;

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
 * External tools only exist as text in the system prompt; models that call them
 * natively land in OpenCode's "invalid" tool.
 *
 * @param {string} requested Requested tool name.
 * @returns {string} Error message.
 */
export const externalToolMessage = (requested) =>
    `${requested} is not a native tool. Call it by replying with only ` +
    `<function_calls>{"name":"${requested}","arguments":{...}}</function_calls>`;

/**
 * Build the tool-lock plugin.
 *
 * @param {object} input Plugin context.
 * @param {any} input.client OpenCode SDK client (`session.get` is used).
 * @returns {Promise<{ 'tool.execute.before': (input: any, output: any) => Promise<void> }>}
 *   Plugin hooks.
 */
export const OpencodeGatewayToolLock = async ({ client }) => {
    /**
     * Resolve the effective policy for a session, walking up the parent chain so
     * child sessions inherit their parent's policy.
     *
     * @param {string} sessionID Session id.
     * @returns {Promise<string|null>} Policy payload, or `null` when unknown.
     */
    const policyOf = async (sessionID) => {
        let id = sessionID;
        for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
            const res = await client.session.get({ path: { id } });
            const session = res?.data;
            if (!session) return null;
            const found = parsePolicy(session.title);
            if (found !== null) return found;
            id = session.parentID;
        }
        return null;
    };

    return {
        'tool.execute.before': async (input, output) => {
            // External tools only exist as a text contract in the system prompt.
            // Models that call them natively land in OpenCode's "invalid" tool;
            // point them back to the contract instead of letting them flail.
            const requested = output?.args?.tool;
            if (
                input.tool === 'invalid' &&
                typeof requested === 'string' &&
                requested.startsWith('external__')
            ) {
                throw new Error(externalToolMessage(requested));
            }

            // Fail closed: a policy that cannot be read denies everything.
            let policy;
            try {
                policy = (await policyOf(input.sessionID)) ?? null;
            } catch {
                policy = null;
            }
            if (policy === '*') return;
            const allowed = policy && policy !== 'none' ? policy.split(',') : [];
            if (allowed.some((name) => toolMatches(input.tool, name))) return;
            throw new Error(denyMessage(input.tool));
        }
    };
};

export default OpencodeGatewayToolLock;
