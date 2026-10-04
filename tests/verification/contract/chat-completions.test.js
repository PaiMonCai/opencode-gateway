/**
 * BEHAVIOUR-SPEC §2 — Chat Completions wire contract, through the assembled app.
 *
 * Independent of `tests/contract/**`: the fakes are this suite's own (stateful
 * fake runtime + stub direct upstream), and the assertions come from
 * `docs/en/api-reference.md` and `docs/BEHAVIOUR-SPEC.md`.
 */

import { createAssembly, createEventFactory, parseSse, renderedHistory } from './harness.js';

/** @type {Array<{close: () => Promise<void>}>} */
const open = [];

afterEach(async () => {
    while (open.length) await open.pop().close();
});

const assembly = async (options) => {
    const instance = await createAssembly(options);
    open.push(instance);
    return instance;
};

const USER = { role: 'user', content: 'Hello' };

describe('§2 request validation', () => {
    test('a missing or empty messages array is rejected before any upstream session', async () => {
        const { http, fake } = await assembly();

        const missing = await http.post('/v1/chat/completions').send({ model: 'opencode/big-pickle' });
        expect(missing.status).toBe(400);
        expect(missing.body.error.message).toBe('messages array is required');

        const empty = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [] });
        expect(empty.status).toBe(400);
        expect(empty.body.error.message).toBe('messages array is required');

        expect(fake.calls.created).toHaveLength(0);
    });

    test('a body with no deliverable turn is rejected before any upstream session', async () => {
        const { http, fake } = await assembly();
        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [{ role: 'system', content: 'You are helpful.' }]
        });
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('messages must include at least one non-system text message');
        expect(fake.calls.created).toHaveLength(0);
    });

    test('an unknown model answers 404 model_not_found in the documented shape', async () => {
        const { http } = await assembly();
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/does-not-exist', messages: [USER] });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({
            message: expect.stringContaining('Model not found'),
            type: 'invalid_request_error',
            code: 'model_not_found'
        });
    });
});

describe('§2 non-streaming response', () => {
    test('the documented body shape, including usage and the requested model name', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'Runtime answer' } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: expect.stringMatching(/^chatcmpl-/),
            object: 'chat.completion',
            created: expect.any(Number),
            model: 'opencode/big-pickle',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'Runtime answer' },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: expect.any(Number),
                completion_tokens: expect.any(Number),
                total_tokens: expect.any(Number),
                completion_tokens_details: { reasoning_tokens: expect.any(Number) }
            }
        });
        // Reasoning is absent when the model produced none.
        expect(res.body.choices[0].message).not.toHaveProperty('reasoning_content');
        expect(res.body.usage.total_tokens).toBe(
            res.body.usage.prompt_tokens + res.body.usage.completion_tokens
        );
        // ceil(chars / 4) over the rendered history ("USER: Hello").
        expect(res.body.usage.prompt_tokens).toBe(Math.ceil(renderedHistory([USER]).length / 4));
        // completion estimate covers the answer text.
        expect(res.body.usage.completion_tokens).toBe(Math.ceil('Runtime answer'.length / 4));
        expect(fake.calls.created).toHaveLength(1);
    });

    test('reasoning_content appears only when the model produced reasoning', async () => {
        const { http } = await assembly({ runtime: { reply: 'Answer', reasoning: 'Thinking' } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.reasoning_content).toBe('Thinking');
        expect(res.body.usage.completion_tokens_details.reasoning_tokens).toBe(
            Math.ceil('Thinking'.length / 4)
        );
    });

    test('a reused conversation reports prompt_tokens over the whole conversation', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'R1' } });
        const headers = { 'x-opencode-session': 'conv-tokens' };

        const first = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'AAAA' }] });
        expect(first.status).toBe(200);
        expect(first.body.usage.prompt_tokens).toBe(
            Math.ceil(renderedHistory([{ role: 'user', content: 'AAAA' }]).length / 4)
        );

        const second = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'AAAA' },
                    { role: 'assistant', content: 'R1' },
                    { role: 'user', content: 'BBBB' }
                ]
            });
        expect(second.status).toBe(200);
        // BEHAVIOUR-SPEC §2: on a reused conversation prompt_tokens covers the
        // whole conversation, even though only the appended turn was sent.
        const wholeConversation = renderedHistory([
            { role: 'user', content: 'AAAA' },
            { role: 'assistant', content: 'R1' },
            { role: 'user', content: 'BBBB' }
        ]);
        expect(second.body.usage.prompt_tokens).toBe(Math.ceil(wholeConversation.length / 4));
        expect(renderedHistory([{ role: 'user', content: 'BBBB' }]).length).toBeLessThan(
            wholeConversation.length
        );
        expect(fake.calls.created).toHaveLength(1); // one upstream session for both turns
    });

    test('ignored fields and the opencode extension never reach the upstream prompt', async () => {
        const { http, fake } = await assembly();
        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [USER],
            frequency_penalty: 0.5,
            presence_penalty: 0.5,
            n: 2,
            seed: 12345,
            response_format: { type: 'json_object' },
            logprobs: true,
            top_logprobs: 4,
            parallel_tool_calls: false,
            service_tier: 'auto',
            stream_options: { include_usage: true },
            user: 'u-1',
            metadata: { zz: 'ZZ_METADATA_MARKER' },
            opencode: { marker: 'ZZ_OPENCODE_MARKER' }
        });
        expect(res.status).toBe(200);

        const prompt = fake.calls.prompts.at(-1);
        const promptText = JSON.stringify(prompt.args);
        expect(promptText).not.toContain('ZZ_METADATA_MARKER');
        expect(promptText).not.toContain('ZZ_OPENCODE_MARKER');
        expect(promptText).not.toContain('12345');
        expect(promptText).not.toContain('json_object');
    });
});

describe('§2 streaming response', () => {
    test('chunks, the final usage chunk and [DONE], with a stable id and the requested model', async () => {
        const { http } = await assembly({
            runtime: { eventStream: createEventFactory({ deltas: ['Hel', 'lo'] }) }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], stream: true });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);

        const { records } = parseSse(res.text);
        expect(records.at(-1).data).toBe('[DONE]');

        const payloads = records
            .filter((record) => record.data && record.data !== '[DONE]')
            .map((record) => JSON.parse(record.data));
        const chunks = payloads.filter((payload) => payload.choices?.[0]?.delta?.content !== undefined);
        expect(chunks.map((chunk) => chunk.choices[0].delta.content).join('')).toBe('Hello');

        const ids = new Set(payloads.map((payload) => payload.id));
        expect(ids.size).toBe(1);
        // Content chunks carry the documented envelope; the final usage chunk is
        // only specified as `choices` + `usage` (BEHAVIOUR-SPEC §2).
        for (const chunk of chunks) {
            expect(chunk.object).toBe('chat.completion.chunk');
            expect(chunk.model).toBe('opencode/big-pickle');
            expect(chunk.created).toEqual(expect.any(Number));
            expect(chunk.choices[0].index).toBe(0);
        }

        const finalChunk = payloads.at(-1);
        expect(finalChunk.choices[0].delta).toEqual({});
        expect(finalChunk.choices[0].finish_reason).toBe('stop');
        expect(finalChunk.usage).toMatchObject({
            prompt_tokens: expect.any(Number),
            completion_tokens: expect.any(Number),
            total_tokens: expect.any(Number),
            completion_tokens_details: { reasoning_tokens: expect.any(Number) }
        });
        // Content chunks carry finish_reason null until the end.
        for (const chunk of chunks) expect(chunk.choices[0].finish_reason).toBeNull();
    });

    test('reasoning streams as delta.reasoning_content before the answer', async () => {
        const { http } = await assembly({
            runtime: {
                eventStream: createEventFactory({ deltas: ['Answer'], reasoning: 'Think' })
            }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], stream: true });

        const payloads = parseSse(res.text)
            .records.filter((record) => record.data && record.data !== '[DONE]')
            .map((record) => JSON.parse(record.data));
        const reasoning = payloads
            .filter((payload) => payload.choices?.[0]?.delta?.reasoning_content)
            .map((payload) => payload.choices[0].delta.reasoning_content)
            .join('');
        expect(reasoning).toBe('Think');

        const answerIndex = payloads.findIndex(
            (payload) => payload.choices?.[0]?.delta?.content !== undefined
        );
        const reasoningIndex = payloads.findIndex(
            (payload) => payload.choices?.[0]?.delta?.reasoning_content !== undefined
        );
        expect(reasoningIndex).toBeLessThan(answerIndex);
    });
});

describe('§2 tool calls', () => {
    const TOOLS = [
        {
            type: 'function',
            function: {
                name: 'weather',
                description: 'Weather lookup',
                parameters: { type: 'object', properties: { city: { type: 'string' } } }
            }
        }
    ];

    test('a text-contract call becomes a public tool_calls item with a call_... id', async () => {
        const { http } = await assembly({
            runtime: {
                reply: 'Let me check.<function_calls>{"name":"weather","arguments":{"city":"Tokyo"}}</function_calls>'
            }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], tools: TOOLS });

        expect(res.status).toBe(200);
        const choice = res.body.choices[0];
        expect(choice.finish_reason).toBe('tool_calls');
        expect(choice.message.tool_calls).toHaveLength(1);
        const call = choice.message.tool_calls[0];
        expect(call.type).toBe('function');
        // BEHAVIOUR-SPEC §4.3: bridged ids are `call_external__<tool>_<n>`; the
        // public *name* must be the client's tool name, not the internal one.
        expect(call.id).toMatch(/^call_external__weather_\d+$/);
        expect(call.function.name).toBe('weather');
        expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Tokyo' });
        expect(JSON.stringify(res.body)).not.toContain('external__weather"');
    });

    test('without declared tools the model tool-call markup is stripped from the text', async () => {
        const { http } = await assembly({
            runtime: {
                reply: 'Before <function_calls>{"name":"weather","arguments":{}}</function_calls> after'
            }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe('Before  after');
        expect(res.body.choices[0].message).not.toHaveProperty('tool_calls');
        expect(res.body.choices[0].finish_reason).toBe('stop');
    });

    test('ids echoed by the client are preserved on the replayed call', async () => {
        const { http } = await assembly({ runtime: { reply: 'ok' } });
        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [
                { role: 'user', content: 'weather?' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_echoed_1',
                            type: 'function',
                            function: { name: 'weather', arguments: '{"city":"Tokyo"}' }
                        }
                    ]
                },
                { role: 'tool', tool_call_id: 'call_echoed_1', content: '{"temp":20}' }
            ],
            tools: TOOLS
        });
        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe('ok');
    });
});
