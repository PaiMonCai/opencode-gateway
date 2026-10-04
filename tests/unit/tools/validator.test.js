import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../../../src/tools/registry.js';
import { validateToolCall, validateToolCalls } from '../../../src/tools/validator.js';

/**
 * Schema validation of parsed calls: unknown tools are rejected, undecodable arguments
 * are repairable, and schema violations are rejected with a path.
 */

const registry = () =>
    buildExternalToolRegistry([
        {
            type: 'function',
            function: {
                name: 'bash',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' },
                        timeout: { type: 'integer' },
                        ratio: { type: 'number' },
                        background: { type: 'boolean' },
                        env: { type: 'object' },
                        mode: { enum: ['fast', 'safe'] }
                    },
                    required: ['command']
                }
            }
        }
    ]);

const call = (name, args) => ({ id: 'call_1', type: 'function', function: { name, arguments: args } });

describe('validateToolCall', () => {
    test('accepts a call with valid arguments', () => {
        const result = validateToolCall(call('external__bash', '{"command":"ls"}'), registry());
        expect(result.status).toBe('valid');
        expect(result.normalizedArguments).toEqual({ command: 'ls' });
        expect(result.tool.originalName).toBe('bash');
    });

    test('accepts an arguments object instead of a string', () => {
        expect(validateToolCall(call('external__bash', { command: 'ls' }), registry()).status).toBe('valid');
    });

    test('treats absent arguments as an empty object (and then reports the missing field)', () => {
        const result = validateToolCall(call('external__bash', undefined), registry());
        expect(result.status).toBe('rejected');
        expect(result.errors.map((error) => error.code)).toEqual(['missing_required_field']);
    });

    test('rejects an unknown tool', () => {
        const result = validateToolCall(call('external__nope', '{}'), registry());
        expect(result.status).toBe('rejected');
        expect(result.errors[0].code).toBe('unknown_tool');
        expect(result.tool).toBeNull();
    });

    test('reports undecodable arguments as repairable', () => {
        const result = validateToolCall(call('external__bash', 'not json'), registry());
        expect(result.status).toBe('repairable');
        expect(result.errors[0].code).toBe('invalid_arguments_json');
        expect(result.errors[0].message).toContain('bash');
    });

    test('rejects arguments that decode to a non-object', () => {
        expect(validateToolCall(call('external__bash', '[1,2]'), registry()).status).toBe('repairable');
        expect(validateToolCall(call('external__bash', '"text"'), registry()).status).toBe('repairable');
        expect(validateToolCall(call('external__bash', 12), registry()).status).toBe('repairable');
    });

    test('flags missing required fields with a path', () => {
        const result = validateToolCall(call('external__bash', '{"timeout":1}'), registry());
        expect(result.status).toBe('rejected');
        expect(result.errors[0]).toMatchObject({
            code: 'missing_required_field',
            message: 'Missing required field: command',
            path: ['command']
        });
    });

    test('treats empty string and null as missing', () => {
        expect(validateToolCall(call('external__bash', '{"command":""}'), registry()).errors[0].code).toBe(
            'missing_required_field'
        );
        expect(validateToolCall(call('external__bash', '{"command":null}'), registry()).errors[0].code).toBe(
            'missing_required_field'
        );
    });

    test('flags wrong primitive types', () => {
        const cases = [
            ['{"command":5}', 'Field command must be a string'],
            ['{"command":"ls","timeout":"5"}', 'Field timeout must be an integer'],
            ['{"command":"ls","timeout":1.5}', 'Field timeout must be an integer'],
            ['{"command":"ls","ratio":"x"}', 'Field ratio must be a number'],
            ['{"command":"ls","background":"yes"}', 'Field background must be a boolean'],
            ['{"command":"ls","env":["A=1"]}', 'Field env must be an object']
        ];
        cases.forEach(([args, message]) => {
            const result = validateToolCall(call('external__bash', args), registry());
            expect(result.status).toBe('rejected');
            expect(result.errors.map((error) => error.message)).toContain(message);
        });
    });

    test('flags enum violations', () => {
        const result = validateToolCall(
            call('external__bash', '{"command":"ls","mode":"turbo"}'),
            registry()
        );
        expect(result.errors[0]).toMatchObject({
            code: 'invalid_enum',
            message: 'Field mode must be one of: fast, safe'
        });
    });

    test('accepts a passing enum value', () => {
        expect(
            validateToolCall(call('external__bash', '{"command":"ls","mode":"safe"}'), registry()).status
        ).toBe('valid');
    });
});

describe('validateToolCalls', () => {
    test('splits valid from invalid calls', () => {
        const result = validateToolCalls(
            [
                call('external__bash', '{"command":"ls"}'),
                call('external__bash', '{"timeout":1}'),
                call('external__nope', '{}')
            ],
            registry()
        );
        expect(result.validCalls).toHaveLength(1);
        expect(result.invalidCalls).toHaveLength(2);
        expect(result.invalidCalls.map((entry) => entry.validation.status)).toEqual(['rejected', 'rejected']);
    });

    test('valid calls carry schema-normalized arguments as JSON text', () => {
        const result = validateToolCalls([call('external__bash', { command: 'ls', timeout: 5 })], registry());
        expect(result.validCalls[0].function.arguments).toBe('{"command":"ls","timeout":5}');
        expect(result.validCalls[0].validatedArguments).toEqual({ command: 'ls', timeout: 5 });
        expect(result.validCalls[0].tool.originalName).toBe('bash');
    });

    test('handles empty and non-array input', () => {
        expect(validateToolCalls([], registry())).toEqual({ validCalls: [], invalidCalls: [] });
        expect(validateToolCalls(undefined, registry())).toEqual({ validCalls: [], invalidCalls: [] });
    });
});
