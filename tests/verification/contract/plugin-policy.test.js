/**
 * BEHAVIOUR-SPEC §4.6/§4.7 — the tool-lock plugin that gates the runtime path.
 *
 * The plugin is loaded by the OpenCode backend, not by this process, so it is
 * verified here directly against a fake SDK client: policy parsing, fail-closed
 * defaults, parent inheritance, the documented refusal text and the steering of
 * native `external__*` calls back to the text contract.
 */

import OpencodeGatewayToolLock, {
    denyMessage,
    externalToolMessage,
    normalizeToolName,
    parsePolicy
} from '../../../plugin/opencode-gateway-tool-lock.js';
import { sessionTitleForPolicy } from '../../../src/upstreams/runtime-client.js';

/** @param {Record<string, {title?: string, parentID?: string}>} sessions */
const fakeClient = (sessions) => ({
    session: {
        get: async ({ path }) => ({ data: sessions[path.id] || null })
    }
});

const hookFor = async (sessions) => {
    const plugin = await OpencodeGatewayToolLock({ client: fakeClient(sessions) });
    return plugin['tool.execute.before'];
};

const call = (hook, tool, sessionID = 's1') => hook({ tool, sessionID }, { args: {} });

describe('§4.6 policy parsing and enforcement', () => {
    test('the session title the proxy writes is the format the plugin reads', () => {
        expect(sessionTitleForPolicy('none')).toBe('opencode-gateway [tools:none]');
        expect(sessionTitleForPolicy('*')).toBe('opencode-gateway [tools:*]');
        expect(sessionTitleForPolicy('webfetch,read')).toBe('opencode-gateway [tools:webfetch,read]');
        expect(parsePolicy(sessionTitleForPolicy('webfetch,read'))).toBe('webfetch,read');
    });

    test('[tools:*] allows every tool', async () => {
        const hook = await hookFor({ s1: { title: 'opencode-gateway [tools:*]' } });
        await expect(call(hook, 'bash')).resolves.toBeUndefined();
        await expect(call(hook, 'webfetch')).resolves.toBeUndefined();
    });

    test('[tools:none] denies every tool with the documented refusal text', async () => {
        const hook = await hookFor({ s1: { title: 'opencode-gateway [tools:none]' } });
        await expect(call(hook, 'bash')).rejects.toThrow(
            'Tool "bash" is disabled by opencode-gateway. Do not call it again.'
        );
        expect(denyMessage('bash')).toContain('"bash"');
        expect(denyMessage('bash')).toContain('disabled');
    });

    test('an allowlist admits matches by name and by namespace suffix', async () => {
        const hook = await hookFor({ s1: { title: 'opencode-gateway [tools:webfetch,read]' } });
        await expect(call(hook, 'webfetch')).resolves.toBeUndefined();
        await expect(call(hook, 'read')).resolves.toBeUndefined();
        await expect(call(hook, 'server.webfetch')).resolves.toBeUndefined();
        await expect(call(hook, 'bash')).rejects.toThrow(/disabled by opencode-gateway/);
        expect(normalizeToolName('Web-Fetch')).toBe('webfetch');
    });

    test('a session without a policy denies everything (fail closed)', async () => {
        const hook = await hookFor({ s1: { title: 'no policy here' } });
        await expect(call(hook, 'bash')).rejects.toThrow(/disabled by opencode-gateway/);
    });

    test('an unreadable policy denies everything (fail closed)', async () => {
        const plugin = await OpencodeGatewayToolLock({
            client: {
                session: {
                    get: async () => {
                        throw new Error('session lookup failed');
                    }
                }
            }
        });
        const hook = plugin['tool.execute.before'];
        await expect(call(hook, 'bash')).rejects.toThrow(/disabled by opencode-gateway/);
    });

    test('an unknown session denies everything', async () => {
        const hook = await hookFor({});
        await expect(call(hook, 'bash')).rejects.toThrow(/disabled by opencode-gateway/);
    });

    test('a child session inherits its parent policy', async () => {
        const hook = await hookFor({
            parent: { title: 'opencode-gateway [tools:*]' },
            child: { title: 'child turn', parentID: 'parent' }
        });
        await expect(call(hook, 'bash', 'child')).resolves.toBeUndefined();
    });
});

describe('§4.7 steering native external__ calls back to the text contract', () => {
    test('a native external__ call is refused with the function_calls instruction', async () => {
        const hook = await hookFor({ s1: { title: 'opencode-gateway [tools:*]' } });
        await expect(
            hook(
                { tool: 'invalid', sessionID: 's1' },
                { args: { tool: 'external__weather', parameters: {} } }
            )
        ).rejects.toThrow(
            /<function_calls>\{"name":"external__weather","arguments":\{\.\.\.\}\}<\/function_calls>/
        );
        expect(externalToolMessage('external__weather')).toContain('not a native tool');
    });

    test('the steering wins even for a wildcard session, and a non-external invalid call hits the policy', async () => {
        const wildcard = await hookFor({ s1: { title: 'opencode-gateway [tools:*]' } });
        await expect(
            wildcard({ tool: 'invalid', sessionID: 's1' }, { args: { tool: 'external__anything' } })
        ).rejects.toThrow(/is not a native tool/);

        const denied = await hookFor({ s1: { title: 'opencode-gateway [tools:none]' } });
        await expect(
            denied({ tool: 'invalid', sessionID: 's1' }, { args: { tool: 'not_external' } })
        ).rejects.toThrow(/disabled by opencode-gateway/);
    });
});
