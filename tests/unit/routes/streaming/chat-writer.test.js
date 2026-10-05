import { describe, expect, test } from '@jest/globals';

import { createChatStreamWriter } from '../../../../src/routes/streaming/chat-writer.js';
import { createResponse } from './helpers.js';

const decode = (wire) => JSON.parse(wire.slice('data: '.length, -2));

describe('Chat SSE writer', () => {
    test('renders content, reasoning, tool calls, usage and DONE', () => {
        const res = createResponse();
        const writer = createChatStreamWriter({
            res: /** @type {any} */ (res),
            id: 'chatcmpl-test',
            model: 'opencode/test',
            clockSeconds: () => 123
        });
        const call = {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' }
        };

        writer.delta('hello');
        writer.delta('think', true);
        writer.toolCall(/** @type {any} */ (call), 0);
        writer.finish({ promptTokens: 3, completionTokens: 4, reasoningTokens: 2 }, 'tool_calls');
        writer.done();

        const content = decode(res.writes[0]);
        expect(content).toMatchObject({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'opencode/test',
            choices: [{ delta: { content: 'hello' } }]
        });

        const reasoning = decode(res.writes[1]);
        expect(reasoning.choices[0].delta).toEqual({ reasoning_content: 'think' });

        const tool = decode(res.writes[2]);
        expect(tool.choices[0].delta.tool_calls[0]).toMatchObject({
            index: 0,
            id: 'call_1',
            function: { name: 'search', arguments: '{"q":"x"}' }
        });

        const finish = decode(res.writes[3]);
        expect(finish).toEqual({
            id: 'chatcmpl-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: {
                prompt_tokens: 3,
                completion_tokens: 6,
                total_tokens: 9,
                completion_tokens_details: { reasoning_tokens: 2 }
            }
        });
        expect(res.writes[4]).toBe('data: [DONE]\n\n');
    });
});
