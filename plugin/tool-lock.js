// Hard-disable plugin: refuses every tool and every permission request.
//
// Use this only when the proxy's session-title policy is not wanted and no tool may run
// at all; the default plugin (`opencode-gateway-tool-lock.js`) is the one that keeps Zen
// free-tier models usable by enforcing the policy carried in the session title.

/**
 * Build the deny-everything plugin.
 *
 * @returns {Promise<{
 *   'permission.ask': (input: any, output: any) => Promise<void>,
 *   'tool.execute.before': (input: any) => Promise<void>
 * }>} Plugin hooks.
 */
export const OpencodeGatewayToolLock = async () => ({
    'permission.ask': async (_input, output) => {
        output.status = 'deny';
    },
    'tool.execute.before': async (input) => {
        throw new Error('Tool "' + input.tool + '" is disabled by opencode-gateway');
    }
});

export default OpencodeGatewayToolLock;
