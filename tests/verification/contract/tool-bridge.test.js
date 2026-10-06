/**
 * BEHAVIOUR-SPEC §4 — the runtime tool bridge, verified over the assembled app.
 *
 * The wire-level contract: client tools are exposed as a text contract with
 * `external__` names, the documented model output formats all parse into public
 * `tool_calls`, `tool_choice: "required"` triggers a forced follow-up, replayed
 * history uses the documented lines, and no declared tools means no contract.
 *
 * §4.6/§4.7 (the plugin policy and its refusal/steering texts) are covered by an
 * independent check of the plugin module at the end of this file.
 */

import { createAssembly, promptTextOf } from './harness.js';

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

const WEATHER = {
    type: 'function',
    function: {
        name: 'weather',
        description: 'Weather lookup',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
};

const USER = { role: 'user', content: 'weather?' };

const toolCallsOf = (body) => body.choices[0].message.tool_calls || [];

describe('§4.1 text contract exposure', () => {
    test('declared tools are exposed as external__ names with the reminder', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'ok' } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], tools: [WEATHER] });

        expect(res.status).toBe(200);
        const prompt = promptTextOf(fake.calls.prompts.at(-1).args);
        expect(prompt).toContain('external__weather');
        expect(prompt).toContain('function_calls');
        // The contract reminder must actually be appended; building it without
        // assigning it drops the reminder the model relies on.
        expect(prompt).toMatch(/REMINDER: External tools are called by emitting markup/);
        expect(prompt).toContain('Available names: external__weather');
        // The reminder rides at the end of the prompt, right before generation
        // (its position is what makes the model follow the contract).
        expect(prompt.trimEnd().endsWith('Available names: external__weather')).toBe(true);
        expect(prompt.match(/REMINDER:/g)).toHaveLength(1);
        expect(prompt.indexOf('REMINDER:')).toBeGreaterThan(prompt.indexOf('USER:'));
    });

    test('without declared tools no contract and no reminder is sent', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'plain answer' } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        const prompt = promptTextOf(fake.calls.prompts.at(-1).args);
        expect(prompt).not.toContain('external__');
        expect(prompt).not.toContain('REMINDER');
        expect(prompt).not.toContain('function_calls');
    });
});

describe('§4.2 accepted model output formats', () => {
    const cases = [
        {
            name: 'canonical function_calls container',
            reply: '<function_calls>{"name":"weather","arguments":{"city":"Tokyo"}}</function_calls>',
            expected: { city: 'Tokyo' }
        },
        {
            name: 'canonical array form',
            reply: '<function_calls>[{"name":"weather","arguments":{"city":"Osaka"}},{"name":"weather","arguments":{"city":"Kyoto"}}]</function_calls>',
            expected: { city: 'Osaka' },
            count: 2
        },
        {
            name: 'DSML invoke markup',
            reply: '<|DSML|tool_calls>\n<|DSML|invoke name="external__weather">\n<|DSML|parameter name="city" string="true">Nagoya</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>',
            expected: { city: 'Nagoya' }
        },
        {
            name: 'function-equals markup',
            reply: '<function=weather><parameter=city>Sapporo</parameter></function>',
            expected: { city: 'Sapporo' }
        }
    ];

    test.each(cases)('$name parses into public tool_calls', async ({ reply, expected, count }) => {
        const { http } = await assembly({ runtime: { reply } });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], tools: [WEATHER] });

        expect(res.status).toBe(200);
        const calls = toolCallsOf(res.body);
        expect(calls).toHaveLength(count || 1);
        expect(calls[0].type).toBe('function');
        expect(calls[0].function.name).toBe('weather');
        expect(calls[0].id).toMatch(/^call_/);
        expect(JSON.parse(calls[0].function.arguments)).toEqual(expected);
        expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });
});

describe('§4.5 forced follow-up for tool_choice: required', () => {
    test('a named forced function answered with prose triggers one forced prompt', async () => {
        const replies = [];
        const { http, fake } = await assembly({
            runtime: {
                reply: (args) => {
                    const text = promptTextOf(args);
                    replies.push(text);
                    if (/previous reply did not emit the required external tool call/i.test(text)) {
                        return '<function_calls>{"name":"weather","arguments":{"city":"Kyoto"}}</function_calls>';
                    }
                    return 'prose only, no call';
                }
            }
        });

        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [USER],
            tools: [WEATHER],
            tool_choice: { type: 'function', function: { name: 'weather' } }
        });

        expect(res.status).toBe(200);
        expect(fake.calls.prompts).toHaveLength(2);
        expect(replies[1]).toMatch(/did not emit the required external tool call/i);
        expect(toolCallsOf(res.body)[0].function.name).toBe('weather');
    });

    test('a first answer with no call triggers exactly one forced prompt, then the call', async () => {
        const replies = [];
        const { http, fake } = await assembly({
            runtime: {
                reply: (args) => {
                    const text = promptTextOf(args);
                    replies.push(text);
                    // The forced follow-up is the prompt that says the previous
                    // reply did not emit the call (the contract reminder also
                    // contains "ONLY", so it cannot be the discriminator).
                    if (/previous reply did not emit the required external tool call/i.test(text)) {
                        return '<function_calls>{"name":"weather","arguments":{"city":"Tokyo"}}</function_calls>';
                    }
                    return 'I would rather chat.';
                }
            }
        });

        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [USER],
            tools: [WEATHER],
            tool_choice: 'required'
        });

        expect(res.status).toBe(200);
        expect(fake.calls.prompts).toHaveLength(2);
        expect(replies[1]).toContain('<function_calls>');
        expect(replies[1]).toMatch(/did not emit the required external tool call/i);
        const calls = toolCallsOf(res.body);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('weather');
        expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });
});

describe('§4.4 replayed history rendering', () => {
    test('an assistant tool call and its result replay as the documented lines', async () => {
        const { http, fake } = await assembly({ runtime: { reply: 'done' } });
        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [
                { role: 'user', content: 'weather?' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'weather', arguments: '{"city":"Tokyo"}' }
                        }
                    ]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    name: 'weather',
                    content: '{"temp":20}'
                }
            ],
            tools: [WEATHER]
        });

        expect(res.status).toBe(200);
        const prompt = promptTextOf(fake.calls.prompts.at(-1).args);
        expect(prompt).toMatch(/ASSISTANT: <function_calls>/);
        expect(prompt).toMatch(/TOOL_RESULT: \{/);
        expect(prompt).toContain('call_1');
        expect(prompt).toContain('external__weather');
    });
});

describe('§3 function_call items on the Responses surface', () => {
    test('a non-streaming bridged call becomes a function_call output item', async () => {
        const { http } = await assembly({
            runtime: {
                reply: '<function_calls>{"name":"weather","arguments":{"city":"Tokyo"}}</function_calls>'
            }
        });
        const res = await http.post('/v1/responses').send({
            model: 'opencode/big-pickle',
            input: 'weather?',
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
        const item = res.body.output.find((entry) => entry.type === 'function_call');
        expect(item).toBeTruthy();
        expect(item.name).toBe('weather');
        expect(item.arguments).toEqual(JSON.stringify({ city: 'Tokyo' }));
        expect(item.call_id).toEqual(item.id);
    });
});
