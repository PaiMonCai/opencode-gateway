import { describe, expect, test } from '@jest/globals';

import {
    buildResponsesMessageOutputItem,
    createResponsesStreamWriter
} from '../../../../src/routes/streaming/responses-writer.js';
import { createResponse } from './helpers.js';

const decode = (wire) => JSON.parse(wire.slice('data: '.length, -2));

describe('Responses SSE writer', () => {
    test('keeps sequence numbers monotonic across reasoning, text and function calls', () => {
        const res = createResponse();
        const writer = createResponsesStreamWriter({
            res: /** @type {any} */ (res),
            model: 'opencode/test',
            responseId: 'resp_test',
            outputItemId: 'msg_test',
            reasoningItemId: 'reasoning_test',
            clockSeconds: () => 456
        });

        writer.start();
        writer.reasoningDelta('why');
        writer.textDelta('answer');
        writer.functionCall(
            /** @type {any} */ ({
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' }
            })
        );
        writer.finishReasoning('why');
        writer.finishText('answer');
        writer.complete({ id: 'resp_test', object: 'response' });
        writer.done();

        const events = res.writes.slice(0, -1).map(decode);
        expect(events[0]).toMatchObject({
            type: 'response.created',
            sequence_number: 0,
            response: { id: 'resp_test', created: 456, model: 'opencode/test' }
        });
        expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
        expect(events.some((event) => event.type === 'response.reasoning_summary_text.delta')).toBe(true);
        expect(events.some((event) => event.type === 'response.output_text.delta')).toBe(true);
        expect(events.some((event) => event.type === 'response.function_call_arguments.done')).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'response.completed' });
        expect(res.writes.at(-1)).toBe('data: [DONE]\n\n');
        expect(writer.streamedToolCalls).toHaveLength(1);
    });

    test('omits empty message output items', () => {
        expect(buildResponsesMessageOutputItem('')).toBeNull();
        expect(buildResponsesMessageOutputItem('hello')).toMatchObject({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }]
        });
    });
});
