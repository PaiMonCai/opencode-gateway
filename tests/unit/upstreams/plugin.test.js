import OpencodeGatewayToolLock from '../../../plugin/opencode-gateway-tool-lock.js';
import { denyMessage, normalizeToolName, parsePolicy, toolMatches } from '../../../plugin/tool-policy.js';
import HardToolLock from '../../../plugin/tool-lock.js';
import { sessionTitleForPolicy } from '../../../src/upstreams/runtime-client.js';

/**
 * Tool-lock plugin: the gate that keeps Zen free models usable. It reads the
 * policy the proxy writes into the session title and blocks everything the
 * policy does not allow, failing closed whenever the policy cannot be read.
 */
const sessions = {
    ses_none: { title: 'opencode-gateway [tools:none]' },
    ses_all: { title: 'opencode-gateway [tools:*]' },
    ses_list: { title: 'opencode-gateway [tools:webfetch,read]' },
    ses_namespaced: { title: 'opencode-gateway [tools:server.webfetch]' },
    ses_child: { title: 'Subtask (@general)', parentID: 'ses_list' },
    ses_plain: { title: 'New session' }
};

const fakeClient = () => ({
    session: {
        get: async ({ path }) => {
            if (path.id === 'ses_broken') throw new Error('backend down');
            return { data: sessions[path.id] };
        }
    }
});

const runTool = (hooks, sessionID, tool, args = {}) =>
    hooks['tool.execute.before']({ tool, sessionID, callID: 'c' }, { args });

describe('policy helpers', () => {
    test('parses the title the runtime client writes', () => {
        expect(parsePolicy(sessionTitleForPolicy('none'))).toBe('none');
        expect(parsePolicy(sessionTitleForPolicy('*'))).toBe('*');
        expect(parsePolicy(sessionTitleForPolicy('read,webfetch'))).toBe('read,webfetch');
        expect(parsePolicy('New session')).toBeNull();
        expect(parsePolicy(undefined)).toBeNull();
    });

    test('normalises and matches namespaced tool names', () => {
        expect(normalizeToolName('Web_Fetch')).toBe('webfetch');
        expect(toolMatches('webfetch', 'webfetch')).toBe(true);
        expect(toolMatches('server.webfetch', 'webfetch')).toBe(true);
        expect(toolMatches('mcp/read', 'read')).toBe(true);
        expect(toolMatches('bash', 'read')).toBe(false);
        expect(toolMatches('', 'read')).toBe(false);
    });
});

describe('opencode-gateway-tool-lock', () => {
    let hooks;

    beforeAll(async () => {
        hooks = await OpencodeGatewayToolLock({ client: fakeClient() });
    });

    test('denies every tool for a deny-all session', async () => {
        await expect(runTool(hooks, 'ses_none', 'bash')).rejects.toThrow(denyMessage('bash'));
    });

    test('allows only the listed tools', async () => {
        await expect(runTool(hooks, 'ses_list', 'webfetch')).resolves.toBeUndefined();
        await expect(runTool(hooks, 'ses_list', 'read')).resolves.toBeUndefined();
        await expect(runTool(hooks, 'ses_list', 'bash')).rejects.toThrow(
            'Tool "bash" is disabled by opencode-gateway'
        );
    });

    test('allows everything for a wildcard session', async () => {
        await expect(runTool(hooks, 'ses_all', 'bash')).resolves.toBeUndefined();
    });

    test('child sessions inherit the parent policy', async () => {
        await expect(runTool(hooks, 'ses_child', 'read')).resolves.toBeUndefined();
        await expect(runTool(hooks, 'ses_child', 'write')).rejects.toThrow('disabled');
    });

    test('fails closed without a policy or when the lookup fails', async () => {
        await expect(runTool(hooks, 'ses_plain', 'read')).rejects.toThrow('disabled');
        await expect(runTool(hooks, 'ses_missing', 'read')).rejects.toThrow('disabled');
        await expect(runTool(hooks, 'ses_broken', 'read')).rejects.toThrow('disabled');
    });

    test('steers native external-tool calls back to the text contract', async () => {
        await expect(
            runTool(hooks, 'ses_none', 'invalid', { tool: 'external__get_weather' })
        ).rejects.toThrow(
            '<function_calls>{"name":"external__get_weather","arguments":{...}}</function_calls>'
        );
    });

    test('an invalid native call that is not an external tool still hits the policy', async () => {
        await expect(runTool(hooks, 'ses_none', 'invalid', { tool: 'bash' })).rejects.toThrow('disabled');
        await expect(runTool(hooks, 'ses_all', 'invalid', { tool: 'bash' })).resolves.toBeUndefined();
    });
});

describe('tool-lock (hard disable)', () => {
    test('denies permission requests and every tool', async () => {
        const hooks = await HardToolLock();
        const output = {};

        await hooks['permission.ask']({}, output);
        expect(output.status).toBe('deny');
        await expect(hooks['tool.execute.before']({ tool: 'bash' })).rejects.toThrow(
            'Tool "bash" is disabled by opencode-gateway'
        );
    });
});
