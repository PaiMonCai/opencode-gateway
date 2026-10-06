import { describe, expect, test } from '@jest/globals';
import {
    ASSISTANT_ROLE_PREFIX,
    EXTERNAL_TOOL_PREFIX,
    FUNCTION_CALLS_CLOSE_TAG,
    FUNCTION_CALLS_OPEN_TAG,
    TOOL_POLICY_DECISIONS,
    TOOL_RESULT_ROLE_PREFIX,
    TOOL_RISK_LEVELS,
    TOOL_SIDE_EFFECTS,
    VALIDATION_STATUSES,
    buildCallId,
    buildForcedToolCallPrompt,
    createValidationError,
    fallbackCallId,
    formatAssistantToolCallsLine,
    formatToolResultLine,
    normalizeRiskLevel,
    normalizeSideEffect,
    sanitizeToolNameForId,
    serializeToolArguments
} from '../../../src/tools/contract.js';

/**
 * Contract primitives: the vocabulary of the text tool bridge (BEHAVIOUR-SPEC §4).
 * These values are wire-visible (call ids, replay lines, the forced prompt), so the
 * tests pin the exact strings a client or the backend plugin observes.
 */

describe('text-contract vocabulary', () => {
    test('namespaces client tools under the external__ prefix', () => {
        expect(EXTERNAL_TOOL_PREFIX).toBe('external__');
        expect(FUNCTION_CALLS_OPEN_TAG).toBe('<function_calls>');
        expect(FUNCTION_CALLS_CLOSE_TAG).toBe('</function_calls>');
        expect(ASSISTANT_ROLE_PREFIX).toBe('ASSISTANT: ');
        expect(TOOL_RESULT_ROLE_PREFIX).toBe('TOOL_RESULT: ');
    });

    test('exposes the documented enums', () => {
        expect(Object.values(TOOL_RISK_LEVELS)).toEqual(['low', 'medium', 'high', 'critical']);
        expect(Object.values(TOOL_SIDE_EFFECTS)).toEqual([
            'none',
            'read',
            'write',
            'delete',
            'external_notification',
            'payment'
        ]);
        expect(Object.values(TOOL_POLICY_DECISIONS)).toEqual(['allow', 'deny', 'require_confirmation']);
        expect(Object.values(VALIDATION_STATUSES)).toEqual(['valid', 'repairable', 'rejected']);
    });
});

describe('enum normalization', () => {
    test('accepts known values regardless of case and surrounding space', () => {
        expect(normalizeRiskLevel(' HIGH ')).toBe('high');
        expect(normalizeSideEffect('Write')).toBe('write');
    });

    test('falls back for unknown, empty and non-string input', () => {
        expect(normalizeRiskLevel('extreme')).toBe('low');
        expect(normalizeRiskLevel(undefined)).toBe('low');
        expect(normalizeRiskLevel('')).toBe('low');
        expect(normalizeRiskLevel(null, 'medium')).toBe('medium');
        expect(normalizeSideEffect('payment')).toBe('payment');
        expect(normalizeSideEffect('teleport', 'read')).toBe('read');
        expect(normalizeSideEffect(42)).toBe('none');
    });
});

describe('call ids', () => {
    test('bridged calls read call_external__<tool>_<n>', () => {
        expect(buildCallId('external__bash', 1)).toBe('call_external__bash_1');
        expect(buildCallId('external__web_fetch', 3)).toBe('call_external__web_fetch_3');
    });

    test('non-alphanumeric characters are sanitized to underscores', () => {
        expect(sanitizeToolNameForId('web-fetch')).toBe('web_fetch');
        expect(sanitizeToolNameForId('a.b c/d')).toBe('a_b_c_d');
        expect(buildCallId('web-fetch', 2)).toBe('call_web_fetch_2');
    });

    test('id-less tool results fall back to call_<sanitized name>', () => {
        expect(fallbackCallId('external__bash')).toBe('call_external__bash');
        expect(fallbackCallId('web-fetch')).toBe('call_web_fetch');
    });
});

describe('argument serialization', () => {
    test('strings pass through verbatim', () => {
        expect(serializeToolArguments('{"a":1}')).toBe('{"a":1}');
        expect(serializeToolArguments('not json')).toBe('not json');
    });

    test('absent arguments become an empty object', () => {
        expect(serializeToolArguments(undefined)).toBe('{}');
    });

    test('objects are encoded', () => {
        expect(serializeToolArguments({ a: 1, nested: { b: [2, 3] } })).toBe('{"a":1,"nested":{"b":[2,3]}}');
    });

    test('unencodable values degrade to an empty object instead of throwing', () => {
        const circular = {};
        circular.self = circular;
        expect(serializeToolArguments(circular)).toBe('{}');
    });
});

describe('replay lines', () => {
    test('assistant tool calls replay as one canonical block', () => {
        const line = formatAssistantToolCallsLine([
            { id: 'call_external__bash_1', name: 'external__bash', arguments: '{"command":"ls"}' }
        ]);
        expect(line).toBe(
            'ASSISTANT: <function_calls>[{"id":"call_external__bash_1","name":"external__bash","arguments":"{\\"command\\":\\"ls\\"}"}]</function_calls>'
        );
    });

    test('an empty call list produces no line', () => {
        expect(formatAssistantToolCallsLine([])).toBeNull();
        expect(formatAssistantToolCallsLine(undefined)).toBeNull();
    });

    test('tool results replay with call id, name and content', () => {
        const line = formatToolResultLine({
            toolCallId: 'call_external__bash_1',
            name: 'external__bash',
            content: 'a.txt'
        });
        expect(line).toBe(
            'TOOL_RESULT: {"tool_call_id":"call_external__bash_1","name":"external__bash","content":"a.txt"}'
        );
    });

    test('an empty tool result produces no line', () => {
        expect(
            formatToolResultLine({ toolCallId: 'call_1', name: 'external__bash', content: '' })
        ).toBeNull();
        expect(formatToolResultLine(undefined)).toBeNull();
    });
});

describe('forced follow-up prompt', () => {
    test('matches the documented wire wording', () => {
        expect(buildForcedToolCallPrompt('external__bash')).toBe(
            'SYSTEM: Your previous reply did not emit the required external tool call. ' +
                'Reply now with ONLY <function_calls>{"name":"external__bash","arguments":{}}</function_calls> ' +
                'or an array inside <function_calls>...</function_calls>. Do not output any prose, reasoning, ' +
                'markdown. Infer the correct arguments from the conversation so far.'
        );
    });

    test('adds the think-block guard when asked', () => {
        expect(buildForcedToolCallPrompt('external__bash', { forbidThinkBlock: true })).toContain(
            'reasoning, markdown, or <think> block.'
        );
    });
});

describe('validation errors', () => {
    test('carry code, message and path', () => {
        expect(
            createValidationError('missing_required_field', 'Missing required field: url', ['url'])
        ).toEqual({
            code: 'missing_required_field',
            message: 'Missing required field: url',
            path: ['url']
        });
    });

    test('default to an empty path', () => {
        expect(createValidationError('unknown_tool', 'nope').path).toEqual([]);
    });
});
