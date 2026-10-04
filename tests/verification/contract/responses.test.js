/**
 * BEHAVIOUR-SPEC §3 — Responses API wire contract.
 *
 * Non-streaming shape, the documented input forms, the streaming event order
 * with increasing `sequence_number`, tool-call events and
 * `previous_response_id` chaining (including the direct-upstream passthrough).
 */

import { createResponseChainIndex } from '../../../src/routes/engine.js';
import { createAssembly, createEventFactory, parseSse, promptTextOf } from './harness.js';

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

const eventTypes = (body) =>
    parseSse(body).records.map((record) => {
        if (record.data === '[DONE]') return '[DONE]';
        try {
            return JSON.parse(record.data).type;
        } catch {
            return `unparsable:${record.data}`;
        }
    });

const eventPayloads = (body) =>
    parseSse(body)
        .records.filter((record) => record.data && record.data !== '[DONE]')
        .map((record) => JSON.parse(record.data));

describe('§3 non-streaming response', () => {
    test('the documented body shape', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'Hi there' } });
        const res = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'Say hello' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: expect.stringMatching(/^resp_/),
            object: 'response',
            created: expect.any(Number),
            model: 'opencode/big-pickle',
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Hi there' }]
                }
            ],
            usage: {
                input_tokens: expect.any(Number),
                output_tokens: expect.any(Number),
                total_tokens: expect.any(Number),
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: expect.any(Number) }
            }
        });
        // The estimate is ceil(promptChars / 4) over the prompt actually sent.
        const prompt = fake.calls.prompts.at(-1);
        expect(res.body.usage.input_tokens).toBe(Math.ceil(promptTextOf(prompt.args).length / 4));
        expect(res.body).not.toHaveProperty('reasoning');
    });

    test('reasoning is reported when the model produced it', async () => {
        const { http } = await assembly({ runtime: { reply: 'Answer', reasoning: 'Because' } });
        const res = await http.post('/v1/responses').send({ model: 'opencode/big-pickle', input: 'q' });
        expect(res.status).toBe(200);
        expect(res.body.reasoning).toMatchObject({ summary: 'Because' });
        expect(res.body.usage.output_tokens_details.reasoning_tokens).toBe(Math.ceil('Because'.length / 4));
    });

    test('[FINDING-8 fixed] empty answer text produces an empty output array', async () => {
        // Defect fixed during verification: the engine used to fall back to
        // `JSON.stringify(responseRes.data)` and leak the SDK object as the
        // answer text. BEHAVIOUR-SPEC §3: "Empty output text produces an empty
        // `output` array rather than a null item".
        const { http } = await assembly({ runtime: { reply: '' } });
        const res = await http.post('/v1/responses').send({ model: 'opencode/big-pickle', input: 'q' });
        expect(res.status).toBe(200);
        expect(res.body.output).toEqual([]);
        expect(res.body.usage).toMatchObject({
            input_tokens: expect.any(Number),
            output_tokens: 0,
            total_tokens: expect.any(Number)
        });
    });

    test('the chat surface does not leak an empty answer (contrast case)', async () => {
        const { http } = await assembly({ runtime: { reply: '' } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'q' }] });
        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe('');
    });

    test('a missing input is a 400', async () => {
        const { http, fake } = await assembly();
        for (const payload of [
            { model: 'opencode/big-pickle' },
            { model: 'opencode/big-pickle', input: [] }
        ]) {
            const res = await http.post('/v1/responses').send(payload);
            expect(res.status).toBe(400);
            expect(res.body.error.message).toBe('input is required');
        }
        expect(fake.calls.created).toHaveLength(0);
    });

    test('[FINDING-7 fixed] an empty input string is rejected as "input is required"', async () => {
        // Defect fixed during verification. BEHAVIOUR-SPEC §3: "`input`
        // missing/empty → 400 input is required"; no upstream session may open.
        const { http, fake } = await assembly();
        const res = await http.post('/v1/responses').send({ model: 'opencode/big-pickle', input: '' });
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('input is required');
        expect(fake.calls.created).toHaveLength(0);
    });

    test.each([
        ['a plain string', { input: 'hello' }],
        ['the prompt shorthand', { prompt: 'hello' }],
        ['the messages shorthand', { messages: [{ role: 'user', content: 'hello' }] }],
        [
            'an input item array',
            {
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
            }
        ]
    ])('accepts %s', async (_label, payload) => {
        const { http } = await assembly({ runtime: { reply: 'ok' } });
        const res = await http.post('/v1/responses').send({ model: 'opencode/big-pickle', ...payload });
        expect(res.status).toBe(200);
        expect(res.body.output[0].content[0].text).toBe('ok');
    });
});

describe('§3 streaming events', () => {
    test('the documented order, [DONE] and strictly increasing sequence numbers', async () => {
        const { http } = await assembly({
            runtime: { eventStream: createEventFactory({ deltas: ['Hel', 'lo'] }) }
        });
        const res = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'hi', stream: true });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);

        const types = eventTypes(res.text);
        expect(types).toEqual([
            'response.created',
            'response.output_item.added',
            'response.content_part.added',
            'response.output_text.delta',
            'response.output_text.delta',
            'response.output_text.done',
            'response.content_part.done',
            'response.output_item.done',
            'response.completed',
            '[DONE]'
        ]);

        const payloads = eventPayloads(res.text);
        const numbers = payloads.map((payload) => payload.sequence_number);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        expect(new Set(numbers).size).toBe(numbers.length);

        const created = payloads.find((payload) => payload.type === 'response.created');
        expect(created.response.object).toBe('response');
        expect(created.response.model).toBe('opencode/big-pickle');
        const deltaText = payloads
            .filter((payload) => payload.type === 'response.output_text.delta')
            .map((payload) => payload.delta)
            .join('');
        expect(deltaText).toBe('Hello');
        const completed = payloads.at(-1);
        expect(completed.response.usage).toMatchObject({
            input_tokens: expect.any(Number),
            output_tokens: expect.any(Number),
            total_tokens: expect.any(Number)
        });
    });

    test('reasoning events appear when reasoning arrives, before response.completed', async () => {
        const { http } = await assembly({
            runtime: { eventStream: createEventFactory({ deltas: ['A'], reasoning: 'Think' }) }
        });
        const res = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'hi', stream: true });

        const types = eventTypes(res.text);
        expect(types).toContain('response.reasoning_summary_text.delta');
        expect(types).toContain('response.reasoning_summary_text.done');
        expect(types.indexOf('response.reasoning_summary_text.delta')).toBeLessThan(
            types.indexOf('response.completed')
        );
        expect(types.at(-1)).toBe('[DONE]');
    });

    test('tool calls stream as function_call argument events', async () => {
        const { http } = await assembly({
            runtime: {
                reply: '<function_calls>{"name":"weather","arguments":{"city":"Tokyo"}}</function_calls>',
                eventStream: createEventFactory({
                    deltas: [
                        '<function_calls>{"name":"weather",',
                        '"arguments":{"city":"Tokyo"}}</function_calls>'
                    ]
                })
            }
        });
        const res = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'weather?',
            stream: true,
            tools: [
                {
                    type: 'function',
                    name: 'weather',
                    description: 'Weather',
                    parameters: { type: 'object', properties: { city: { type: 'string' } } }
                }
            ]
        });

        expect(res.status).toBe(200);
        const types = eventTypes(res.text);
        expect(types).toContain('response.function_call_arguments.delta');
        expect(types).toContain('response.function_call_arguments.done');
        expect(types).toContain('response.output_item.done');
        expect(types.at(-1)).toBe('[DONE]');

        const done = eventPayloads(res.text).find(
            (payload) =>
                payload.type === 'response.output_item.done' && payload.item?.type === 'function_call'
        );
        expect(done).toBeTruthy();
        expect(done.item.name).toBe('weather');
        expect(JSON.parse(done.item.arguments)).toEqual({ city: 'Tokyo' });
    });
});

describe('§3 failures and effort mapping', () => {
    test('a failure after the headers emits response.failed followed by [DONE]', async () => {
        const { http, fake } = await assembly({
            runtime: {
                reply: '',
                eventStream: () =>
                    async function* stream() {
                        const sessionId = fake.calls.created.at(-1)?.id;
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'm-err',
                                    sessionID: sessionId,
                                    finish: 'stop',
                                    error: { name: 'MessageAbortedError', message: 'Aborted' }
                                }
                            }
                        };
                    }
            }
        });
        fake.client.session.messages = async () => [
            {
                info: {
                    id: 'm-err',
                    role: 'assistant',
                    finish: 'stop',
                    error: { name: 'MessageAbortedError', message: 'Aborted' }
                },
                parts: []
            }
        ];

        const res = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'hi', stream: true });

        expect(res.status).toBe(200);
        const types = eventTypes(res.text);
        expect(types).toContain('response.failed');
        expect(types.at(-1)).toBe('[DONE]');
        // Never a second JSON body after the stream opened.
        expect(res.text.startsWith('data: ')).toBe(true);
        const failed = eventPayloads(res.text).find((payload) => payload.type === 'response.failed');
        expect(failed.response.error.message).toBe('Aborted');
    });

    test('reasoning_effort maps to the documented effort values', async () => {
        const cases = [
            ['minimal', 'none'],
            ['low', 'low'],
            ['medium', 'medium'],
            ['high', 'high'],
            ['xhigh', 'high']
        ];
        for (const [input, expected] of cases) {
            const { http } = await assembly({ runtime: { reply: 'A', reasoning: 'R' } });
            const res = await http
                .post('/v1/responses')
                .send({ model: 'opencode/big-pickle', input: 'q', reasoning_effort: input });
            expect(res.status).toBe(200);
            expect(res.body.reasoning.effort).toBe(expected);
        }
    });
});

describe('§3 response-chain TTL', () => {
    test('a chained response id expires after the documented 30 minutes', () => {
        let now = 1_700_000_000_000;
        const chains = createResponseChainIndex({ clock: () => now });
        chains.store('resp_1', 'ses_1', 'opencode/big-pickle');

        now += 30 * 60 * 1000 - 1;
        expect(chains.get('resp_1')).toEqual({
            sessionId: 'ses_1',
            model: 'opencode/big-pickle',
            expiresAt: expect.any(Number)
        });

        now += 1;
        expect(chains.get('resp_1')).toBeNull();
    });
});

describe('§3 previous_response_id chaining', () => {
    test('a known id continues the same upstream session', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'first' } });
        const first = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'turn one' });
        expect(first.status).toBe(200);
        expect(fake.calls.created).toHaveLength(1);
        const sessionId = fake.calls.created[0].id;

        const second = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'turn two',
            previous_response_id: first.body.id
        });
        expect(second.status).toBe(200);
        expect(fake.calls.created).toHaveLength(1); // no new session
        expect(fake.calls.prompts.at(-1).args.path.id).toBe(sessionId);
    });

    test('an unknown or expired id on the runtime path is a 400', async () => {
        const { http } = await assembly();
        const res = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'continue',
            previous_response_id: 'resp_does_not_exist'
        });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: { message: 'Invalid or expired previous_response_id' }
        });
    });

    test('in direct mode the id is forwarded to the upstream untouched', async () => {
        const { http, directRequests } = await assembly({ env: { OPENCODE_ZEN_API_KEY: 'dummy-key' } });
        const res = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'continue',
            previous_response_id: 'resp_upstream_123'
        });

        expect(res.status).toBe(200);
        expect(directRequests).toHaveLength(1);
        const sent = JSON.parse(directRequests[0].body);
        expect(sent.previous_response_id).toBe('resp_upstream_123');
        expect(sent.model).toBe('big-pickle');
        expect(directRequests[0].headers['x-opencode-session']).toEqual(expect.any(String));
    });
});
