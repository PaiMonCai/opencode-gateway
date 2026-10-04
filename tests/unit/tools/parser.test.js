import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../../../src/tools/registry.js';
import {
    createExternalToolCallStreamParser,
    createToolCallFilter,
    parseExternalToolCallsFromText,
    parseToolCallsFromText,
    stripFunctionCallMarkup
} from '../../../src/tools/parser.js';

/**
 * Model-output parsing.
 *
 * Free-tier models ignore the instructed `<function_calls>` contract and emit their own
 * native or invented markup. Every dialect must collapse to the same call, and anything
 * ambiguous must be left alone.
 */

const registry = buildExternalToolRegistry([
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
        function: {
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
        }
    }
]);

const names = (calls) => calls.map((call) => call.function.name);
const argsOf = (call) => JSON.parse(call.function.arguments);

describe('canonical <function_calls> blocks', () => {
    test('parses a single object', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>{"name":"external__bash","arguments":{"command":"ls"}}</function_calls>'
        );
        expect(names(calls)).toEqual(['bash']);
        expect(argsOf(calls[0])).toEqual({ command: 'ls' });
        expect(calls[0].id).toBe('call_external__bash_1');
    });

    test('parses an array of calls', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>[{"name":"external__bash","arguments":{"command":"ls"}},' +
                '{"name":"external__read","arguments":{"file":"a.txt"}}]</function_calls>'
        );
        expect(names(calls)).toEqual(['bash', 'read']);
        expect(calls.map((call) => call.id)).toEqual(['call_external__bash_1', 'call_external__read_1']);
    });

    test('tolerates stray nested markup inside the block', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>\n<function_calls>{"name":"external__bash","arguments":{"command":"date"}}' +
                '</function_calls>\n</function_calls>'
        );
        expect(names(calls)).toEqual(['bash']);
        expect(argsOf(calls[0])).toEqual({ command: 'date' });
    });

    test('drops malformed JSON instead of guessing', () => {
        expect(
            parseExternalToolCallsFromText(registry, '<function_calls>{not json}</function_calls>')
        ).toEqual([]);
        expect(parseExternalToolCallsFromText(registry, '<function_calls></function_calls>')).toEqual([]);
    });

    test('keeps the id the model echoed', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>{"id":"call_abc","name":"external__bash","arguments":{"command":"ls"}}</function_calls>'
        );
        expect(calls[0].id).toBe('call_abc');
    });

    test('numbers repeated calls of the same tool per name', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>[{"name":"external__bash","arguments":{"command":"a"}},' +
                '{"name":"external__bash","arguments":{"command":"b"}}]</function_calls>'
        );
        expect(calls.map((call) => call.id)).toEqual(['call_external__bash_1', 'call_external__bash_2']);
    });

    test('drops tools that are not declared for the request', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>{"name":"external__unknown","arguments":{}}</function_calls>'
        );
        expect(calls).toEqual([]);
    });

    test('does nothing without a registry', () => {
        expect(
            parseExternalToolCallsFromText(
                [],
                '<function_calls>{"name":"external__bash","arguments":{}}</function_calls>'
            )
        ).toEqual([]);
    });
});

describe('DSML / invoke markup', () => {
    test('parses fullwidth DSML markers and coerces parameter types', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>\n' +
                '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="external__read">\n' +
                '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="file" string="true">123.txt</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>\n' +
                '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="offset">10</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>\n' +
                '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="follow">true</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>\n' +
                '</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>\n' +
                '</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>'
        );
        expect(names(calls)).toEqual(['read']);
        // string="true" keeps the leading digits as text; the other two decode.
        expect(argsOf(calls[0])).toEqual({ file: '123.txt', offset: 10, follow: true });
    });

    test('parses plain invoke/parameter markup and nested JSON values', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<invoke name="external__read">' +
                '<parameter name="file">data.json</parameter>' +
                '<parameter name="options">{"deep":true,"levels":[1,2]}</parameter>' +
                '</invoke>'
        );
        expect(argsOf(calls[0])).toEqual({ file: 'data.json', options: { deep: true, levels: [1, 2] } });
    });

    test('keeps interior newlines of multi-line parameter values', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<invoke name="external__bash"><parameter name="command">\necho one\necho two\n</parameter></invoke>'
        );
        expect(argsOf(calls[0]).command).toBe('echo one\necho two');
    });

    test('ignores malformed parameter markup without losing the invoke', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<invoke name="external__bash"><parameter name="command">ls -la</invoke>'
        );
        expect(names(calls)).toEqual(['bash']);
    });
});

describe('function-equals markup', () => {
    test('parses <function=name> with <parameter=key> children', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<tool_call>\n<function=webfetch_variant>\n<parameter=url>https://example.com</parameter>\n</function>\n</tool_call>',
            ''
        );
        // The declared name is `read`, so an unknown name is dropped; map a known one below.
        expect(calls).toEqual([]);

        const known = parseExternalToolCallsFromText(
            registry,
            '<tool_call>\n<function=read>\n<parameter=file>a.txt</parameter>\n<parameter=offset>5</parameter>\n</function>\n</tool_call>'
        );
        expect(names(known)).toEqual(['read']);
        expect(argsOf(known[0])).toEqual({ file: 'a.txt', offset: '5' });
    });

    test('parses an unclosed <function=...> body', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function=bash><parameter=command>date</parameter>'
        );
        expect(argsOf(calls[0])).toEqual({ command: 'date' });
    });
});

describe('registry-gated tag formats', () => {
    test('parses arguments from a quoted attribute', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            `<external__bash arguments='{"command":"ls"}'/>`
        );
        expect(argsOf(calls[0])).toEqual({ command: 'ls' });
    });

    test('parses a bare JSON attribute containing ">"', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<external__bash arguments={"command":"ls > out.txt"} />'
        );
        expect(argsOf(calls[0])).toEqual({ command: 'ls > out.txt' });
    });

    test('parses a tag body carrying JSON', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<external__bash>{"command":"pwd"}</external__bash>'
        );
        expect(argsOf(calls[0])).toEqual({ command: 'pwd' });
    });

    test('parses a self-closing tag with no arguments', () => {
        const calls = parseExternalToolCallsFromText(registry, '<external__bash />');
        expect(argsOf(calls[0])).toEqual({});
    });

    test('parses XML child elements using the declared schema types', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<read><file>0123.txt</file><offset>7</offset><follow>false</follow></read>'
        );
        expect(argsOf(calls[0])).toEqual({ file: '0123.txt', offset: 7, follow: false });
    });

    test('ignores look-alike tags that are not declared tools', () => {
        expect(
            parseExternalToolCallsFromText(registry, '<summary>{"name":"external__bash"}</summary>')
        ).toEqual([]);
    });

    test('resolves a tag named after the client tool, not the namespace', () => {
        const calls = parseExternalToolCallsFromText(registry, '<bash arguments={"command":"ls"} />');
        expect(calls[0].function.name).toBe('bash');
    });
});

describe('bare JSON payloads', () => {
    test('parses a whole-body JSON call', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '{"name":"external__bash","arguments":{"command":"ls"}}'
        );
        expect(names(calls)).toEqual(['bash']);
    });

    test('parses a whole-body JSON call inside one code fence', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '```json\n{"name":"external__bash","arguments":{"command":"ls"}}\n```'
        );
        expect(names(calls)).toEqual(['bash']);
    });

    test('parses the tool_calls wrapper shape', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '{"tool_calls":[{"id":"call_1","function":{"name":"external__bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}'
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].id).toBe('call_1');
        expect(argsOf(calls[0])).toEqual({ command: 'ls' });
    });

    test('parses the function_call shape', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '{"type":"function_call","name":"external__read","arguments":"{\\"file\\":\\"a.txt\\"}"}'
        );
        expect(argsOf(calls[0])).toEqual({ file: 'a.txt' });
    });

    test('ignores JSON quoted mid-sentence', () => {
        expect(
            parseExternalToolCallsFromText(
                registry,
                'Try {"name":"external__bash","arguments":{"command":"ls"}} and tell me what happens'
            )
        ).toEqual([]);
    });

    test('keeps arguments verbatim when they are not valid JSON', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '{"name":"external__bash","arguments":"echo hi"}'
        );
        expect(calls[0].function.arguments).toBe('echo hi');
    });
});

describe('deduplication', () => {
    test('one call described twice by different formats is emitted once', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<external__bash>{"command":"ls"}</external__bash>\n<function_calls>{"name":"external__bash","arguments":{"command":"ls"}}</function_calls>'
        );
        expect(calls).toHaveLength(1);
    });
});

describe('canonical-only parsing', () => {
    test('parseToolCallsFromText ignores every foreign format', () => {
        expect(
            parseToolCallsFromText(
                '<invoke name="external__bash"><parameter name="command">ls</parameter></invoke>'
            )
        ).toEqual([]);
        const calls = parseToolCallsFromText(
            '<function_calls>{"name":"external__bash","arguments":{}}</function_calls>'
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].type).toBe('function');
    });
});

describe('stripFunctionCallMarkup', () => {
    test('removes canonical blocks and stray tags', () => {
        expect(
            stripFunctionCallMarkup(
                'Here you go <function_calls>{"name":"external__bash","arguments":{}}</function_calls> </function_calls>'
            )
        ).toBe('Here you go');
    });

    test('removes registry-gated markup only when the registry is supplied', () => {
        const text = '<external__bash arguments={"command":"ls"} />';
        expect(stripFunctionCallMarkup(text)).toBe(text);
        expect(stripFunctionCallMarkup(text, true, { registry })).toBe('');
    });

    test('leaves ordinary prose untouched', () => {
        expect(stripFunctionCallMarkup('  plain answer  ')).toBe('plain answer');
        expect(stripFunctionCallMarkup('  plain answer  ', false)).toBe('  plain answer  ');
    });

    test('passes falsy input through', () => {
        expect(stripFunctionCallMarkup('')).toBe('');
        expect(stripFunctionCallMarkup(undefined)).toBeUndefined();
    });

    test('removes markup from the middle of a sentence', () => {
        expect(stripFunctionCallMarkup('before <tool_call>{"name":"external__bash"}</tool_call> after')).toBe(
            'before  after'
        );
    });
});

describe('createToolCallFilter', () => {
    test('is a passthrough when tools are enabled and not force-stripped', () => {
        const filter = createToolCallFilter({ disableTools: false, registry });
        expect(filter('<function_calls>{"a":1}</function_calls>')).toBe(
            '<function_calls>{"a":1}</function_calls>'
        );
        expect(filter.flush()).toBe('');
    });

    test('drops a complete canonical block inline', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('answer <function_calls>{"name":"external__bash"}</function_calls>').trim()).toBe(
            'answer'
        );
        expect(filter.flush()).toBe('');
    });

    test('withholds a block that is still open, and drops its orphaned opener at flush', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('answer <function_calls>{"name":"ext')).toBe('answer ');
        // Legacy parity: flush strips the stray `<function_calls>` opener, but a payload
        // whose closing tag never arrived cannot be attributed to a block, so the
        // fragment is released rather than silently swallowed.
        expect(filter.flush()).toBe('{"name":"ext');
    });

    test('releases ordinary buffered text at flush', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('plain ')).toBe('plain ');
        expect(filter.flush()).toBe('');
    });

    test('drops an orphaned close tag arriving on the other channel', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('</function_calls>')).toBe('');
    });

    test('holds a leading JSON body until flush decides', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('{"name":"external__bash","arguments":{"command":"ls"}}')).toBe('');
        expect(filter.flush()).toBe('');
    });

    test('releases a leading JSON body that is not a declared tool', () => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        expect(filter('{')).toBe('');
        expect(filter.flush()).toBe('{');
    });
});

describe('createExternalToolCallStreamParser', () => {
    test('emits a call as soon as its block closes', () => {
        const parser = createExternalToolCallStreamParser(registry);
        expect(parser('<function_calls>{"name":"external__bash",')).toEqual([]);
        const calls = parser('"arguments":{"command":"ls"}}</function_calls>');
        expect(names(calls)).toEqual(['bash']);
        expect(parser.flush()).toEqual([]);
    });

    test('flushes registry-gated markup at end of stream', () => {
        const parser = createExternalToolCallStreamParser(registry);
        expect(parser('<external__bash>{"command":"ls"}')).toEqual([]);
        const calls = parser.flush();
        expect(names(calls)).toEqual(['bash']);
        expect(argsOf(calls[0])).toEqual({ command: 'ls' });
    });

    test('suffixes generated ids so repeated calls stay distinct', () => {
        const parser = createExternalToolCallStreamParser(registry);
        const first = parser(
            '<function_calls>{"name":"external__bash","arguments":{"command":"a"}}</function_calls>'
        );
        const second = parser(
            '<function_calls>{"name":"external__bash","arguments":{"command":"b"}}</function_calls>'
        );
        expect(first[0].id).not.toBe(second[0].id);
    });

    test('is a no-op without a registry', () => {
        const parser = createExternalToolCallStreamParser([]);
        expect(parser('<function_calls>{"name":"external__bash","arguments":{}}</function_calls>')).toEqual(
            []
        );
        expect(parser.flush()).toEqual([]);
    });
});
