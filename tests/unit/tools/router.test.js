import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../../../src/tools/registry.js';
import {
    buildAssistantToolCallsLine,
    buildExternalToolsPrompt,
    buildExternalToolsReminder,
    buildToolExposure,
    buildToolResultLine,
    normalizeExternalToolChoice,
    rememberAssistantToolCalls,
    resolveToolResultTarget,
    serializeAssistantToolCalls
} from '../../../src/tools/router.js';

/**
 * Request-level exposure and replay semantics: what the model is told about the declared
 * tools, and how earlier tool calls and results are replayed into the transcript.
 */

const registry = () =>
    buildExternalToolRegistry([
        {
            type: 'function',
            function: {
                name: 'bash',
                description: 'Run a shell command',
                parameters: {
                    type: 'object',
                    properties: { command: { type: 'string' } },
                    required: ['command']
                }
            }
        },
        { type: 'function', function: { name: 'read', description: 'Read a file' } }
    ]);

describe('normalizeExternalToolChoice', () => {
    test('defaults to auto without tools', () => {
        expect(normalizeExternalToolChoice(undefined, [])).toEqual({ mode: 'auto', requiredTool: null });
        expect(normalizeExternalToolChoice('required', [])).toEqual({ mode: 'auto', requiredTool: null });
    });

    test('passes through auto and none', () => {
        expect(normalizeExternalToolChoice('auto', registry())).toEqual({ mode: 'auto', requiredTool: null });
        expect(normalizeExternalToolChoice('none', registry())).toEqual({ mode: 'none', requiredTool: null });
    });

    test('required without a named tool', () => {
        expect(normalizeExternalToolChoice('required', registry())).toEqual({
            mode: 'required',
            requiredTool: null
        });
    });

    test('accepts the nested Chat Completions forced shape', () => {
        expect(
            normalizeExternalToolChoice({ type: 'function', function: { name: 'bash' } }, registry())
        ).toEqual({
            mode: 'required',
            requiredTool: 'external__bash'
        });
    });

    test('accepts the flat Responses forced shape', () => {
        expect(normalizeExternalToolChoice({ type: 'function', name: 'read' }, registry())).toEqual({
            mode: 'required',
            requiredTool: 'external__read'
        });
    });

    test('namespaces a forced tool that is not declared', () => {
        expect(normalizeExternalToolChoice({ type: 'function', name: 'webfetch' }, registry())).toEqual({
            mode: 'required',
            requiredTool: 'external__webfetch'
        });
    });

    test('ignores unsupported shapes', () => {
        expect(normalizeExternalToolChoice({ type: 'web_search' }, registry())).toEqual({
            mode: 'auto',
            requiredTool: null
        });
        expect(normalizeExternalToolChoice({ type: 'function' }, registry())).toEqual({
            mode: 'auto',
            requiredTool: null
        });
    });
});

describe('buildExternalToolsPrompt', () => {
    test('is empty without tools', () => {
        expect(buildExternalToolsPrompt([], null)).toBe('');
        expect(buildExternalToolsPrompt(undefined, null)).toBe('');
    });

    test('states the markup-only contract and the namespaced names', () => {
        const prompt = buildExternalToolsPrompt(registry());
        expect(prompt).toContain('your entire assistant reply MUST be ONLY one or more <function_calls>');
        expect(prompt).toContain('{"name":"external__tool_name","arguments":{}}');
        expect(prompt).toContain('Available external tools: [');
        expect(prompt).toContain('"name":"external__bash"');
        expect(prompt).toContain('"client_name":"bash"');
        expect(prompt).toContain('"risk_level":"low"');
        expect(prompt).toContain('"side_effect":"none"');
        expect(prompt).toContain('"requires_confirmation":false');
    });

    test('adds a REQUIRED instruction that names the forced tool', () => {
        const prompt = buildExternalToolsPrompt(registry(), { type: 'function', name: 'bash' });
        expect(prompt).toContain('Tool use is REQUIRED for this turn. You MUST call external__bash');
    });

    test('adds a generic REQUIRED instruction when no tool is named', () => {
        const prompt = buildExternalToolsPrompt(registry(), 'required');
        expect(prompt).toContain('You MUST call an external tool before giving any final answer.');
    });

    test('forbids markup when tool use is disabled', () => {
        const prompt = buildExternalToolsPrompt(registry(), 'none');
        expect(prompt).toContain('Tool use is disabled for this turn. Do not emit <function_calls>.');
    });
});

describe('buildExternalToolsReminder', () => {
    test('is empty without tools or with tool use disabled', () => {
        expect(buildExternalToolsReminder([], null)).toBe('');
        expect(buildExternalToolsReminder(registry(), 'none')).toBe('');
    });

    test('names the forced tool and lists every available name', () => {
        const reminder = buildExternalToolsReminder(registry(), { type: 'function', name: 'read' });
        expect(reminder).toContain('REMINDER: External tools are called by emitting markup');
        expect(reminder).toContain(
            '<function_calls>{"name":"external__read","arguments":{...}}</function_calls>'
        );
        expect(reminder).toContain('Available names: external__bash, external__read');
    });

    test('falls back to the first tool as the example', () => {
        expect(buildExternalToolsReminder(registry())).toContain('{"name":"external__bash"');
    });
});

describe('buildToolExposure', () => {
    test('exposes only enabled tools while keeping the resolved choice', () => {
        const tools = registry();
        tools[1].enabled = false;
        const exposure = buildToolExposure(tools, 'required');
        expect(exposure.tools.map((tool) => tool.namespacedName)).toEqual(['external__bash']);
        expect(exposure.toolChoice).toEqual({ mode: 'required', requiredTool: null });
        expect(exposure.prompt).toContain('external__bash');
        expect(exposure.prompt).not.toContain('external__read');
    });

    test('degrades to empty prompts when every tool is disabled', () => {
        const tools = registry().map((tool) => ({ ...tool, enabled: false }));
        const exposure = buildToolExposure(tools, null);
        expect(exposure.tools).toEqual([]);
        expect(exposure.prompt).toBe('');
        expect(exposure.reminder).toBe('');
        expect(exposure.toolChoice).toEqual({ mode: 'auto', requiredTool: null });
    });

    test('handles an absent registry', () => {
        const exposure = buildToolExposure(null);
        expect(exposure).toEqual({
            tools: [],
            toolChoice: { mode: 'auto', requiredTool: null },
            prompt: '',
            reminder: ''
        });
    });
});

describe('serializeAssistantToolCalls', () => {
    test('maps client names back into the namespace and keeps echoed ids', () => {
        expect(
            serializeAssistantToolCalls(
                [
                    {
                        id: 'call_external__bash_1',
                        type: 'function',
                        function: { name: 'bash', arguments: '{"command":"ls"}' }
                    }
                ],
                registry()
            )
        ).toEqual([{ id: 'call_external__bash_1', name: 'external__bash', arguments: '{"command":"ls"}' }]);
    });

    test('accepts the flat Responses shape and call_id', () => {
        expect(
            serializeAssistantToolCalls(
                [{ call_id: 'call_9', name: 'read', arguments: { file: 'a.txt' } }],
                registry()
            )
        ).toEqual([{ id: 'call_9', name: 'external__read', arguments: '{"file":"a.txt"}' }]);
    });

    test('falls back to call_<n> when no id was echoed', () => {
        expect(serializeAssistantToolCalls([{ function: { name: 'bash' } }], registry())).toEqual([
            { id: 'call_1', name: 'external__bash', arguments: '{}' }
        ]);
    });

    test('keeps an undeclared tool name so the transcript still reads correctly', () => {
        expect(
            serializeAssistantToolCalls([{ id: 'x', name: 'webfetch', arguments: {} }], registry())
        ).toEqual([{ id: 'x', name: 'webfetch', arguments: '{}' }]);
    });

    test('drops entries without a name and tolerates empty input', () => {
        expect(serializeAssistantToolCalls([{ id: 'x' }], registry())).toEqual([]);
        expect(serializeAssistantToolCalls(undefined, registry())).toEqual([]);
    });
});

describe('replay lines and result resolution', () => {
    test('assistant calls replay as one canonical block', () => {
        expect(
            buildAssistantToolCallsLine(
                [{ id: 'call_external__bash_1', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
                registry()
            )
        ).toBe(
            'ASSISTANT: <function_calls>[{"id":"call_external__bash_1","name":"external__bash","arguments":"{\\"command\\":\\"ls\\"}"}]</function_calls>'
        );
    });

    test('a tool result names the tool and joins the assistant call id', () => {
        const assistantToolCalls = rememberAssistantToolCalls(
            [{ id: 'call_external__bash_1', function: { name: 'bash' } }],
            registry()
        );
        expect(assistantToolCalls.get('call_external__bash_1')).toBe('external__bash');
        expect(
            buildToolResultLine(
                { toolCallId: 'call_external__bash_1', content: 'a.txt' },
                {
                    registry: registry(),
                    assistantToolCalls
                }
            )
        ).toBe(
            'TOOL_RESULT: {"tool_call_id":"call_external__bash_1","name":"external__bash","content":"a.txt"}'
        );
    });

    test('a tool result named directly is mapped into the namespace', () => {
        expect(
            resolveToolResultTarget({ name: 'read', toolCallId: 'call_2' }, { registry: registry() })
        ).toEqual({
            name: 'external__read',
            toolCallId: 'call_2'
        });
    });

    test('an unresolvable result falls back to call_<name> and external__unknown', () => {
        expect(resolveToolResultTarget({}, { registry: registry() })).toEqual({
            name: 'external__unknown',
            toolCallId: 'call_external__unknown'
        });
    });

    test('an empty result produces no line', () => {
        expect(
            buildToolResultLine({ toolCallId: 'call_1', name: 'bash', content: '' }, { registry: registry() })
        ).toBeNull();
    });

    test('buildToolResultLine records the mapping for later results', () => {
        const map = new Map();
        buildToolResultLine(
            { name: 'bash', toolCallId: 'call_7', content: 'ok' },
            {
                registry: registry(),
                assistantToolCalls: map
            }
        );
        expect(map.get('call_7')).toBe('external__bash');
    });
});
