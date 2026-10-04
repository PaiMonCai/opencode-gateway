/**
 * Frozen parity corpus for the tool bridge (Phase A).
 *
 * Every string here is either a documented markup variant or output captured verbatim
 * from a live model. `tests/unit/tools/parity.test.js` replays the corpus against
 * `src/tools/**` and compares the result with `golden-outputs.json`, which was recorded
 * from the pre-rewrite `src/tool-runtime/*` implementation (git HEAD, see that file's
 * `meta`). It is a recording of observable behaviour, not a copy of implementation code.
 *
 * Order matters: the golden file stores results as parallel arrays in exactly the
 * iteration order used by the test (documented per describe block in parity.test.js).
 */

/** Tool declarations in both accepted API shapes, plus two unusable entries. */
export const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Run a shell command',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string' }, timeout: { type: 'integer' } },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                offset: { type: 'integer' },
                follow: { type: 'boolean' },
                options: { type: 'object' }
            },
            required: ['file']
        }
    },
    { type: 'function', function: { name: 'bash' } },
    { type: 'web_search' }
];

/** Model outputs covering the canonical contract and every foreign dialect. */
export const CORPUS = [
    '<function_calls>{"name":"external__bash","arguments":{"command":"ls"}}</function_calls>',
    '<function_calls>[{"name":"external__bash","arguments":{"command":"a"}},{"name":"external__bash","arguments":{"command":"b"}}]</function_calls>',
    '<function_calls>\n<function_calls>{"name":"external__bash","arguments":{"command":"date"}}</function_calls>\n</function_calls>',
    '<function_calls>{not json}</function_calls>',
    '<function_calls></function_calls>',
    '<function_calls>{"id":"call_abc","name":"external__bash","arguments":{"command":"ls"}}</function_calls>',
    '<function_calls>{"name":"external__nope","arguments":{}}</function_calls>',
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls><\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="external__read"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="file" string="true">123.txt</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="offset">10</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="follow">true</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke></\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>',
    '<tool_calls><invoke name="external__read"><parameter name="file">data.json</parameter><parameter name="options">{"deep":true,"levels":[1,2]}</parameter></invoke></tool_calls>',
    '<invoke name="external__bash"><parameter name="command">ls -la</parameter></invoke>',
    '<invoke name="external__bash"><parameter name="command">\necho one\necho two\n</parameter></invoke>',
    '<invoke name="external__bash"><parameter name="command">ls -la</invoke>',
    '<tool_call>{"name":"external__bash","arguments":{"command":"ls"}}</tool_call>',
    '<tool_call><function=read><parameter=file>a.txt</parameter><parameter=offset>5</parameter></function></tool_call>',
    '<function=bash><parameter=command>date</parameter>',
    '<function=webfetch><parameter=url>https://example.com</parameter></function>',
    '<external__bash arguments=\'{"command":"ls"}\'/>',
    '<external__bash arguments={"command":"ls > out.txt"} />',
    '<external__bash />',
    '<external__bash>{"command":"pwd"}</external__bash>',
    '<external__bash "Run a shell command">\n{"command":"ls"}</external__bash>',
    '<read><file>0123.txt</file><offset>7</offset><follow>false</follow></read>',
    '<read><parameters><file>a.txt</file></parameters></read>',
    '<summary>{"name":"external__bash"}</summary>',
    '<bash arguments={"command":"ls"} />',
    '{"name":"external__bash","arguments":{"command":"ls"}}',
    '```json\n{"name":"external__bash","arguments":{"command":"ls"}}\n```',
    '{"tool_calls":[{"id":"call_1","function":{"name":"external__bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
    '{"type":"function_call","name":"external__read","arguments":"{\\"file\\":\\"a.txt\\"}"}',
    '{"name":"external__bash","arguments":"echo hi"}',
    'Try {"name":"external__bash","arguments":{"command":"ls"}} and tell me what happens',
    '<external__bash>{"command":"ls"}</external__bash>\n<function_calls>{"name":"external__bash","arguments":{"command":"ls"}}</function_calls>',
    'plain prose with <angle brackets> and no calls',
    '',
    'Answer: <function_calls>{"name":"external__read","arguments":{"file":"a.txt"}}</function_calls> done',
    'answer <tool_call>{"name":"external__bash"}</tool_call> after',
    '<function_calls>{"name":"webfetch","arguments":{}}</function_calls>',
    '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>',
    '<function_calls>{"name":"external__bash","arguments":[1,2]}</function_calls>',
    '<function_calls>[{"name":"external__read","arguments":{"file":"x"}},{"name":"external__read","arguments":{"file":"x"}}]</function_calls>'
];

/** Chunk sequences handed to the streaming text filter, in order. */
export const FILTER_CASES = [
    ['answer <function_calls>{"name":"external__bash"}</function_calls>'],
    ['answer ', '<function_calls>{"name":"ext'],
    ['<function_calls>{"name":"external__bash","arguments":{"command":"ls"}}</function_calls>'],
    ['</function_calls>'],
    ['{"name":"external__bash","arguments":{"command":"ls"}}'],
    ['{', 'not a tool call'],
    ['part </function_', 'calls>'],
    ['<invoke name="external__bash">', '<parameter name="command">ls</parameter>', '</invoke>'],
    ['<external__bash arguments={"command":"ls"}'],
    ['<external__bash arguments={"command":"ls"} />'],
    ['plain text ', 'continued'],
    ['<function_calls>', '{"name":"external__bash","arguments":{}}', '</function_calls>'],
    ['no markup at all']
];

/** Chunk sequences handed to the streaming call parser, in order. */
export const STREAM_CASES = [
    ['<function_calls>{"name":"external__bash",', '"arguments":{"command":"ls"}}</function_calls>'],
    ['<external__bash>{"command":"ls"}'],
    ['<external__bash arguments={"command":"ls"} />'],
    ['<tool_call><function=read><parameter=file>a.txt</parameter></function></tool_call>'],
    ['<summary>x</summary>'],
    [
        'text <function_calls>{"name":"external__bash","arguments":{"command":"a"}}</function_calls> ' +
            '<function_calls>{"name":"external__bash","arguments":{"command":"b"}}</function_calls>'
    ],
    ['<function_calls>{"name":"external__nope","arguments":{}}</function_calls>']
];

/** Names looked up in the registry, in order. */
export const LOOKUP_NAMES = [
    'external__bash',
    'bash',
    'external__read',
    'read',
    'webfetch',
    'external__webfetch',
    'BASH',
    'external__bash_2',
    '',
    'nope'
];

/** Calls validated against the registry, in order. */
export const VALIDATOR_CALLS = [
    { id: 'call_1', type: 'function', function: { name: 'external__bash', arguments: '{"command":"ls"}' } },
    { id: 'call_2', type: 'function', function: { name: 'external__bash', arguments: 'not json' } },
    { id: 'call_3', type: 'function', function: { name: 'external__bash', arguments: { command: 7 } } },
    { id: 'call_4', type: 'function', function: { name: 'external__bash', arguments: {} } },
    { id: 'call_5', type: 'function', function: { name: 'external__read', arguments: { file: 5 } } },
    { id: 'call_6', type: 'function', function: { name: 'external__read', arguments: [1, 2] } },
    { id: 'call_7', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
    { id: 'call_8', type: 'function', function: { name: 'unknown', arguments: '{}' } }
];

/** Policy configurations evaluated against every registry entry, in order. */
export const POLICY_CONFIGS = [
    {},
    { config: { EXTERNAL_TOOL_ALLOWLIST: ['bash'] } },
    { config: { EXTERNAL_TOOL_DENYLIST: ['external__bash'] } },
    { config: { EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: ['external__read'] } },
    { config: { EXTERNAL_TOOL_POLICY_MODE: 'report-only' } },
    { config: { EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'medium' } }
];
