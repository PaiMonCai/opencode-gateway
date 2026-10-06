// OpenCode server plugin loaded by the backend that opencode-gateway starts.
//
// OpenCode Zen's free tier rejects any request whose tool list differs from the one the
// official client sends ("free tier can only be used from within OpenCode"). Disabling
// tools per request strips them from that list, so the proxy leaves the list alone and
// enforces its tool policy here, at execution time, instead.
//
// The policy is carried in the session title the proxy sets when it creates a session:
// "[tools:none]", "[tools:*]" or "[tools:webfetch,read]". Sessions without a policy (and
// failed lookups) deny every tool; child sessions spawned by the task tool inherit the
// policy of their parent.
//
// **Loader contract (opencode 1.18).** Two rules keep the runtime alive:
//
// 1. `Plugin.trigger` calls hooks by name without checking that the plugin
//    defined one, so this file must return **every** hook the runtime calls (see
//    `NOOP_HOOKS`). A plugin with only `tool.execute.before` fails every prompt
//    with `TypeError: null is not an object` before the model is reached.
// 2. The loader registers **every function this module exports** as a plugin of
//    its own, and the bogus entries it creates break the same calls: the module
//    therefore has exactly one export (the default factory) and keeps its pure
//    helpers in `./tool-policy.js`, which must never appear in the runtime's
//    `plugin` configuration.

import { MAX_DEPTH, toolMatches, parsePolicy, denyMessage, externalToolMessage } from './tool-policy.js';

/**
 * Hooks opencode calls unconditionally on every turn and at startup.
 *
 * @type {readonly string[]}
 */
const NOOP_HOOKS = Object.freeze([
    'config',
    'event',
    'dispose',
    'chat.message',
    'chat.params',
    'tool.execute.after'
]);

/**
 * Build the tool-lock plugin.
 *
 * @param {object} context Plugin context.
 * @param {any} context.client OpenCode SDK client (`session.get` is used).
 * @returns {Promise<Record<string, Function>>} Plugin hooks.
 */
const OpencodeGatewayToolLock = async ({ client }) => {
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

    /**
     * Deny tools the session policy does not cover.
     *
     * @param {{ tool: string, sessionID: string }} input Hook input.
     * @param {{ args?: { tool?: string } }} [output] Hook output.
     * @returns {Promise<void>} Resolves when the tool may run.
     */
    const enforceToolPolicy = async (input, output) => {
        // External tools exist only as a text contract in the system prompt, so a model
        // calling one natively lands in OpenCode's "invalid" tool: point it back to the
        // contract instead of letting it flail.
        const requested = output?.args?.tool;
        if (input.tool === 'invalid' && typeof requested === 'string' && requested.startsWith('external__')) {
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
    };

    /** @type {Record<string, Function>} */
    const hooks = { 'tool.execute.before': enforceToolPolicy };
    for (const name of NOOP_HOOKS) hooks[name] = async () => {};
    return hooks;
};

export default OpencodeGatewayToolLock;
