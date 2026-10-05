import { describe, expect, test } from '@jest/globals';

import { buildExternalToolRegistry } from '../../../src/tools/registry.js';
import { reconcileStreamedToolCalls } from '../../../src/tools/stream-reconciliation.js';

const flushable = (flushValue) => {
    const fn = () => '';
    fn.flush = () => flushValue;
    return fn;
};

const parser = (flushValue = []) => {
    const fn = () => [];
    fn.flush = () => flushValue;
    return fn;
};

const registry = buildExternalToolRegistry([
    {
        type: 'function',
        function: {
            name: 'lookup',
            description: 'lookup',
            parameters: { type: 'object', properties: {} }
        }
    }
]);

describe('streamed tool-call reconciliation', () => {
    test('keeps tool calls that were already emitted live', () => {
        const live = [
            {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' }
            }
        ];

        const result = reconcileStreamedToolCalls({
            registry,
            streamedToolCalls: /** @type {any} */ (live),
            reasoningParser: /** @type {any} */ (parser()),
            contentParser: /** @type {any} */ (parser()),
            reasoningFilter: /** @type {any} */ (flushable('')),
            contentFilter: /** @type {any} */ (flushable('')),
            rawReasoning: '',
            rawContent: ''
        });

        expect(result.parsedToolCalls).toEqual(live);
    });

    test('combines parser flush output with final channel parsing', () => {
        const flushed = {
            id: 'call_flush',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' }
        };

        const result = reconcileStreamedToolCalls({
            registry,
            streamedToolCalls: [],
            reasoningParser: /** @type {any} */ (parser([flushed])),
            contentParser: /** @type {any} */ (parser()),
            reasoningFilter: /** @type {any} */ (flushable('')),
            contentFilter: /** @type {any} */ (flushable('')),
            rawReasoning: '',
            rawContent: ''
        });

        expect(result.parsedToolCalls).toContainEqual(flushed);
    });

    test('joined-channel retry recovers markup split across reasoning and content', () => {
        const result = reconcileStreamedToolCalls({
            registry,
            streamedToolCalls: [],
            reasoningParser: /** @type {any} */ (parser()),
            contentParser: /** @type {any} */ (parser()),
            reasoningFilter: /** @type {any} */ (flushable('')),
            contentFilter: /** @type {any} */ (flushable('')),
            rawReasoning: '<function_calls>[{"name":"lookup",',
            rawContent: '"arguments":{}}]</function_calls>'
        });

        expect(result.parsedToolCalls).toHaveLength(1);
        expect(result.parsedToolCalls[0].function.name).toBe('lookup');
    });

    test('authoritative snapshots replace non-empty raw channels before final parsing', () => {
        const result = reconcileStreamedToolCalls({
            registry: [],
            streamedToolCalls: [],
            reasoningParser: /** @type {any} */ (parser()),
            contentParser: /** @type {any} */ (parser()),
            reasoningFilter: /** @type {any} */ (flushable('!')),
            contentFilter: /** @type {any} */ (flushable('?')),
            rawReasoning: 'raw-r',
            rawContent: 'raw-c',
            snapshotReasoning: 'snap-r',
            snapshotContent: 'snap-c'
        });

        expect(result.finalReasoningText).toBe('snap-r!');
        expect(result.finalContentText).toBe('snap-c?');
    });
});
