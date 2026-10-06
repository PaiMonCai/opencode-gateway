import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import {
    buildExternalToolRegistry,
    createExternalToolCallStreamParser,
    createToolCallFilter,
    evaluateToolPolicy,
    findExternalToolByName,
    parseExternalToolCallsFromText,
    parseToolCallsFromText,
    stripFunctionCallMarkup,
    validateToolCall,
    validateToolCalls
} from '../../../src/tools/index.js';
import {
    CORPUS,
    FILTER_CASES,
    LOOKUP_NAMES,
    POLICY_CONFIGS,
    STREAM_CASES,
    TOOLS,
    VALIDATOR_CALLS
} from './fixtures/model-outputs.js';

/**
 * Golden parity for the text tool contract (BEHAVIOUR-SPEC §4).
 *
 * `fixtures/golden-outputs.json` records the observable results of the tool
 * runtime that `src/tools/**` replaced (archived at commit
 * c68e10369b815e991d1c56277f28e98080d10ef8). This test loads only
 * `src/tools/**` and replays the same inputs, so the recorded behaviour stays pinned.
 *
 * The recording stores parallel arrays in the iteration order used below; the length
 * guards in the first test fail loudly if a fixture list is edited without regenerating.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'golden-outputs.json'), 'utf8'));

const registry = buildExternalToolRegistry(TOOLS);

/** Golden entries never carry the source declaration object. */
const withoutSource = ({ sourceTool: _sourceTool, ...rest }) => rest;

/** `toFinalCalls()` seeds ids with Date.now(), so the recording stores a stable marker. */
const normalizeId = (id) => (typeof id === 'string' ? id.replace(/^call_\d{10,}_/, 'call_TS_') : id);
const normalizeCalls = (calls) =>
    JSON.parse(JSON.stringify(calls)).map((call) => ({ ...call, id: normalizeId(call.id) }));
const normalizeValidation = (result) => {
    const value = JSON.parse(JSON.stringify(result));
    value.validCalls = value.validCalls.map((call) => ({ ...call, id: normalizeId(call.id) }));
    value.invalidCalls = value.invalidCalls.map((entry) => ({
        ...entry,
        call: { ...entry.call, id: normalizeId(entry.call?.id) }
    }));
    return value;
};

describe('golden parity with the recorded tool runtime', () => {
    test('the recording describes exactly this corpus', () => {
        expect(registry.map(withoutSource)).toHaveLength(golden.registryEntries.length);
        expect(CORPUS).toHaveLength(golden.parseExternal.length);
        expect(CORPUS).toHaveLength(golden.parseCanonical.length);
        expect(CORPUS).toHaveLength(golden.validateParsed.length);
        expect(CORPUS.length * 4).toBe(golden.strip.length);
        expect(FILTER_CASES.length * 2).toBe(golden.filter.length);
        expect(STREAM_CASES).toHaveLength(golden.stream.length);
        expect(LOOKUP_NAMES).toHaveLength(golden.lookupNamespaced.length);
        expect(VALIDATOR_CALLS).toHaveLength(golden.validator.length);
        expect(POLICY_CONFIGS.length * registry.length).toBe(golden.policy.length);
    });

    test('registry entries match', () => {
        expect(registry.map(withoutSource)).toEqual(golden.registryEntries);
    });

    test('name lookup matches, including ambiguous and unknown names', () => {
        LOOKUP_NAMES.forEach((name, index) => {
            expect(findExternalToolByName(registry, name)?.namespacedName ?? null).toBe(
                golden.lookupNamespaced[index]
            );
        });
    });

    test('parseExternalToolCallsFromText matches over the corpus', () => {
        CORPUS.forEach((input, index) => {
            expect(normalizeCalls(parseExternalToolCallsFromText(registry, input))).toEqual(
                golden.parseExternal[index]
            );
        });
    });

    test('parseToolCallsFromText matches over the corpus', () => {
        CORPUS.forEach((input, index) => {
            expect(normalizeCalls(parseToolCallsFromText(input))).toEqual(golden.parseCanonical[index]);
        });
    });

    test('stripFunctionCallMarkup matches over the corpus (registry and trim variants)', () => {
        let cursor = 0;
        CORPUS.forEach((input) => {
            const variants = [
                stripFunctionCallMarkup(input, true, { registry }),
                stripFunctionCallMarkup(input, false, { registry }),
                stripFunctionCallMarkup(input, true),
                stripFunctionCallMarkup(input, false)
            ];
            variants.forEach((output) => {
                expect(output).toEqual(golden.strip[cursor]);
                cursor += 1;
            });
        });
        expect(cursor).toBe(golden.strip.length);
    });

    test('streaming text filter matches over chunk sequences', () => {
        let cursor = 0;
        FILTER_CASES.forEach((chunks) => {
            [true, false].forEach((withRegistry) => {
                const filter = createToolCallFilter({
                    disableTools: true,
                    registry: withRegistry ? registry : null
                });
                const outputs = chunks.map((chunk) => filter(chunk));
                const recorded = golden.filter[cursor];
                expect(outputs).toEqual(recorded.outputs);
                expect(filter.flush()).toEqual(recorded.flush);
                cursor += 1;
            });
        });
        expect(cursor).toBe(golden.filter.length);
    });

    test('streaming filter passthrough modes match', () => {
        [{ disableTools: false }, { disableTools: true, forceStrip: false }, {}].forEach((options, index) => {
            const filter = createToolCallFilter(options);
            const recorded = golden.filterPassthrough[index];
            expect(filter('x<function_calls>y')).toEqual(recorded.outputs[0]);
            expect(filter.flush()).toEqual(recorded.flush);
        });
    });

    test('streaming call parser matches over chunk sequences', () => {
        STREAM_CASES.forEach((chunks, index) => {
            const parser = createExternalToolCallStreamParser(registry);
            const outputs = chunks.map((chunk) => normalizeCalls(parser(chunk)));
            const recorded = golden.stream[index];
            expect(outputs).toEqual(recorded.outputs);
            expect(normalizeCalls(parser.flush())).toEqual(recorded.flush);
        });
    });

    test('an empty registry makes the stream parser a no-op', () => {
        expect(normalizeCalls(createExternalToolCallStreamParser([])('x'))).toEqual(
            golden.emptyRegistryCalls
        );
    });

    test('validateToolCall matches', () => {
        VALIDATOR_CALLS.forEach((call, index) => {
            expect(JSON.parse(JSON.stringify(validateToolCall(call, registry)))).toEqual(
                golden.validator[index]
            );
        });
    });

    test('validateToolCalls over the parsed corpus matches', () => {
        CORPUS.forEach((input, index) => {
            const calls = normalizeCalls(parseExternalToolCallsFromText(registry, input));
            expect(normalizeValidation(validateToolCalls(calls, registry))).toEqual(
                golden.validateParsed[index]
            );
        });
    });

    test('policy decisions match across configurations', () => {
        let cursor = 0;
        POLICY_CONFIGS.forEach((context) => {
            registry.forEach((tool, index) => {
                expect(evaluateToolPolicy(tool, { sample: index }, context)).toEqual(golden.policy[cursor]);
                cursor += 1;
            });
        });
        expect(cursor).toBe(golden.policy.length);
    });
});
