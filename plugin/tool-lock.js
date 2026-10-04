export const OpencodeGatewayToolLock = async () => ({
    "permission.ask": async (_input, output) => {
        output.status = "deny"
    },
    "tool.execute.before": async (input) => {
        throw new Error('Tool "' + input.tool + '" is disabled by opencode-gateway')
    },
})
export default OpencodeGatewayToolLock
