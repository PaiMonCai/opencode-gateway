import { describe, expect, test } from '@jest/globals';
import { convertRequest, convertResponse } from '../../../src/protocol/bridge.js';
import { transcodeSse } from '../../../src/protocol/stream.js';
import { createDirectUpstream, upstreamProtocolOf } from '../../../src/upstreams/direct-client.js';

const chat = {
    model: 'step-5-preview-free',
    messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read', arguments: '{"path":"file.txt"}' }
                }
            ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'contents' }
    ],
    tools: [
        {
            type: 'function',
            function: {
                name: 'read',
                description: 'Read file',
                parameters: { type: 'object', properties: { path: { type: 'string' } } }
            }
        }
    ],
    tool_choice: 'auto',
    stream: false,
    reasoning_effort: 'high'
};

describe('three-protocol normalized request bridge', () => {
    test('Chat -> Responses -> Chat keeps tools, IDs, system, reasoning and user data', () => {
        const responses = convertRequest('chat', 'responses', chat);
        expect(responses.instructions).toBe('Be concise.');
        expect(responses.input).toContainEqual(
            expect.objectContaining({ type: 'function_call', call_id: 'call_1' })
        );
        expect(responses.input).toContainEqual(
            expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' })
        );
        expect(responses.reasoning.effort).toBe('high');
        const back = convertRequest('responses', 'chat', responses);
        expect(back.messages[0].role).toBe('system');
        expect(back.messages[2].tool_calls[0].id).toBe('call_1');
        expect(back.messages[3].tool_call_id).toBe('call_1');
    });
    test('Chat -> Messages -> Chat preserves function tool result linkage', () => {
        const anthropic = convertRequest('chat', 'messages', chat);
        expect(anthropic.system).toBe('Be concise.');
        expect(
            anthropic.messages.some((m) => m.content.some((p) => p.type === 'tool_use' && p.id === 'call_1'))
        ).toBe(true);
        expect(
            anthropic.messages.some((m) =>
                m.content.some((p) => p.type === 'tool_result' && p.tool_use_id === 'call_1')
            )
        ).toBe(true);
        const back = convertRequest('messages', 'chat', anthropic);
        expect(back.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
    });
    test('Cross-protocol Responses previous_response_id is explicitly rejected, never silently lost', () => {
        expect(() =>
            convertRequest('responses', 'chat', {
                model: 'x',
                input: 'hi',
                previous_response_id: 'resp_123'
            })
        ).toThrow(/previous_response_id/);
    });
    test('Responses ↔ Anthropic Messages round trips without losing user input', () => {
        const request = {
            model: 'my-model',
            stream: false,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
        };
        const messages = convertRequest('responses', 'messages', request);
        expect(messages.messages[0].content[0].text).toBe('hello');
        const back = convertRequest('messages', 'responses', messages);
        expect(back.input[0].content[0].text).toBe('hello');
    });
    test('Unknown image/file content fails instead of silently vanishing', () => {
        expect(() =>
            convertRequest('chat', 'messages', {
                ...chat,
                messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: 'abc' }] }]
            })
        ).toThrow(/Unsupported content block/);
    });
    test('Chat and Responses final answers survive conversion both directions', () => {
        const answer = {
            id: 'c1',
            model: 'bare',
            choices: [
                {
                    message: {
                        content: 'Hello',
                        tool_calls: [
                            { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4 }
        };
        const converted = convertResponse('chat', 'responses', answer);
        expect(converted.output.find((x) => x.type === 'function_call').call_id).toBe('c2');
        expect(converted.usage.input_tokens).toBe(5);
        const back = convertResponse('responses', 'chat', converted);
        expect(back.choices[0].message.tool_calls[0].id).toBe('c2');
    });
    test('Message tool-use answer converts to OpenAI tool_calls', () => {
        const native = {
            id: 'msg_1',
            model: 'bare',
            content: [{ type: 'tool_use', id: 'call42', name: 'write', input: { value: 1 } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 2 }
        };
        const converted = convertResponse('messages', 'chat', native);
        expect(converted.choices[0].message.tool_calls[0].function.name).toBe('write');
        expect(converted.choices[0].finish_reason).toBe('tool_calls');
    });
});
const streamOf = (...pieces) =>
    (async function* () {
        for (const p of pieces) yield Buffer.from(p);
    })();
async function outputOf(source, from, to) {
    let result = '';
    for await (const chunk of transcodeSse(source, from, to, 'opencode-go/step-5-preview-free'))
        result += chunk.toString();
    return result;
}
describe('incremental cross-protocol SSE', () => {
    test('Chat text and tool deltas are emitted to Responses and complete correctly', async () => {
        const upstream = [
            'data: {"id":"c","choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
            'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n'
        ];
        const result = await outputOf(streamOf(...upstream), 'chat', 'responses');
        expect(result).toContain('response.created');
        expect(result).toContain('response.output_text.delta');
        expect(result).toContain('response.function_call_arguments.delta');
        expect(result).toContain('response.completed');
        expect(result).toContain('opencode-go/step-5-preview-free');
    });
    test('Responses text SSE to Chat retains incremental chunks', async () => {
        const source = streamOf(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
        );
        const out = await outputOf(source, 'responses', 'chat');
        expect(out).toContain('"content":"A"');
        expect(out).toContain('"content":"B"');
        expect(out).toContain('"finish_reason":"stop"');
        expect(out).toContain('data: [DONE]');
    });
    test('Anthropic text stream to Chat works without buffering full response', async () => {
        const out = await outputOf(
            streamOf(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            ),
            'messages',
            'chat'
        );
        expect(out).toContain('"content":"hi"');
        expect(out).toContain('[DONE]');
    });
    test('truncated stream rejects rather than synthesizing success', async () => {
        await expect(outputOf(streamOf('data: {"choices": []}\n\n'), 'chat', 'responses')).rejects.toThrow(
            /without success/
        );
    });
});
describe('Direct gateway active protocol negotiation', () => {
    test('model catalog protocol hint routes proactively without a protocol-failure roundtrip', async () => {
        const calls = [];
        const gateway = createDirectUpstream({
            config: { ZEN_API_KEY: 'secret' },
            fetch: async (url) => {
                calls.push(url);
                if (url.endsWith('/models'))
                    return new Response(
                        JSON.stringify({
                            data: [{ id: 'step-5-preview-free', protocol: 'chat/completions' }]
                        })
                    );
                return new Response(
                    JSON.stringify({
                        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
                    })
                );
            }
        });
        await gateway.listModels();
        calls.length = 0;
        const result = await gateway.responses({
            providerID: 'opencode-go',
            modelID: 'step-5-preview-free',
            body: { input: 'hi' },
            stream: false
        });
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].endsWith('/chat/completions')).toBe(true);
    });

    test('only ModelProtocolUnsupported triggers converted retry, then caches native protocol', async () => {
        const calls = [];
        const gateway = createDirectUpstream({
            config: { ZEN_API_KEY: 'secret' },
            fetch: async (url, init) => {
                calls.push({ url, body: JSON.parse(init.body) });
                if (url.endsWith('/responses'))
                    return new Response(
                        JSON.stringify({
                            error: {
                                type: 'ModelProtocolUnsupported',
                                message: 'Model does not support this protocol'
                            }
                        }),
                        { status: 400 }
                    );
                return new Response(
                    JSON.stringify({
                        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
                    })
                );
            }
        });
        const options = {
            providerID: 'opencode-go',
            modelID: 'step-5-preview-free',
            body: { model: 'step-5-preview-free', input: 'hello' },
            stream: false
        };
        const a = await gateway.responses(options);
        expect(a.status).toBe(200);
        expect(upstreamProtocolOf(a)).toBe('chat');
        expect(calls.map((c) => new URL(c.url).pathname).slice(0, 2)).toEqual([
            '/zen/go/v1/responses',
            '/zen/go/v1/chat/completions'
        ]);
        await gateway.responses(options);
        expect(calls.at(-1).url.endsWith('/chat/completions')).toBe(true);
    });
    test('ordinary 400 is never retried', async () => {
        const calls = [];
        const gateway = createDirectUpstream({
            config: { ZEN_API_KEY: 'secret' },
            fetch: async (url) => {
                calls.push(url);
                return new Response(JSON.stringify({ error: { message: 'Invalid arguments' } }), {
                    status: 400
                });
            }
        });
        const result = await gateway.chatCompletion({
            providerID: 'opencode-go',
            modelID: 'x',
            body: { messages: [{ role: 'user', content: 'hi' }] }
        });
        expect(result.status).toBe(400);
        expect(calls).toHaveLength(1);
    });
});
