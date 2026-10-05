import { describe, expect, test } from '@jest/globals';

import { createResponsesInputNormalizer } from '../../../src/routes/responses-input.js';
import { buildExternalToolRegistry } from '../../../src/tools/registry.js';

describe('Responses input normalizer', () => {
    test('normalizes messages and input_text items', () => {
        const build = createResponsesInputNormalizer();
        expect(
            build([
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
                { type: 'input_text', text: 'again' }
            ])
        ).toEqual([
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'again' }
        ]);
    });

    test('links assistant calls to later tool results', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                function: {
                    name: 'lookup',
                    parameters: { type: 'object', properties: {} }
                }
            }
        ]);
        const build = createResponsesInputNormalizer(registry);
        const messages = build([
            {
                type: 'function_call',
                call_id: 'call_1',
                name: 'lookup',
                arguments: '{}'
            },
            {
                type: 'function_call_output',
                call_id: 'call_1',
                output: 'done'
            }
        ]);

        expect(messages[0].role).toBe('assistant');
        expect(messages[0].content).toContain('external__lookup');
        expect(messages[1]).toEqual({
            role: 'tool',
            content: 'TOOL_RESULT: {"tool_call_id":"call_1","name":"external__lookup","content":"done"}'
        });
    });
});
