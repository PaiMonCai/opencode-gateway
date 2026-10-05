import { describe, expect, test } from '@jest/globals';

import {
    normalizeTextContent,
    normalizeToolArguments,
    normalizeToolResultContent
} from '../../../src/routes/input-normalization.js';

describe('route input normalization', () => {
    test('normalizes scalar and structured text content', () => {
        expect(normalizeTextContent('hello')).toBe('hello');
        expect(normalizeTextContent(42)).toBe('42');
        expect(normalizeTextContent(true)).toBe('true');
        expect(normalizeTextContent({ text: 'object text' })).toBe('object text');
        expect(
            normalizeTextContent([
                'a',
                { type: 'input_text', text: 'b' },
                { type: 'output_text', text: 'c' },
                { type: 'image_url', image_url: 'ignored' }
            ])
        ).toBe('abc');
    });

    test('normalizes tool arguments without throwing', () => {
        expect(normalizeToolArguments('{"x":1}')).toBe('{"x":1}');
        expect(normalizeToolArguments(undefined)).toBe('{}');
        expect(normalizeToolArguments({ x: 1 })).toBe('{"x":1}');
        const cyclic = {};
        cyclic.self = cyclic;
        expect(normalizeToolArguments(cyclic)).toBe('{}');
    });

    test('normalizes object tool results as JSON when no text projection exists', () => {
        expect(normalizeToolResultContent({ value: 1 })).toBe('{"value":1}');
        expect(normalizeToolResultContent([{ text: 'done' }])).toBe('done');
        expect(normalizeToolResultContent(null)).toBe('');
    });
});
