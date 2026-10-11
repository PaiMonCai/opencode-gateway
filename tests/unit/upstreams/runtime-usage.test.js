import { describe, expect, jest, test } from '@jest/globals';
import {
    aggregateRuntimeTokens,
    formatRuntimeUsage,
    readRuntimeUsage
} from '../../../src/upstreams/runtime-usage.js';

const item = (id, tokens, role = 'assistant') => ({
    info: { id, role, tokens }
});

const step = {
    input: 182,
    output: 80,
    reasoning: 1,
    cache: { read: 136640, write: 0 }
};

const estimated = { promptTokens: 122044, completionTokens: 22, reasoningTokens: 0 };

describe('Runtime authoritative usage', () => {
    test('maps OpenCode exclusive token counters to Chat totals and cache fields', () => {
        const sum = aggregateRuntimeTokens([item('a', step)]);
        expect(formatRuntimeUsage(sum, 'chat', estimated)).toEqual({
            prompt_tokens: 136822,
            completion_tokens: 81,
            total_tokens: 136903,
            prompt_tokens_details: { cached_tokens: 136640 },
            completion_tokens_details: { reasoning_tokens: 1 }
        });
    });

    test('maps cache writes and reasoning to the Responses usage shape', () => {
        const sum = aggregateRuntimeTokens([
            item('a', { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 50 } })
        ]);
        expect(formatRuntimeUsage(sum, 'responses', estimated)).toEqual({
            input_tokens: 350,
            output_tokens: 15,
            total_tokens: 365,
            input_tokens_details: { cached_tokens: 200, cache_creation_tokens: 50 },
            output_tokens_details: { reasoning_tokens: 5 }
        });
    });

    test('sums all new assistant steps, excludes previous turns and de-duplicates snapshots', () => {
        const baseline = { messageIds: new Set(['old']) };
        const tokens = aggregateRuntimeTokens([
            item('old', { input: 5000, output: 2, reasoning: 0, cache: { read: 8000, write: 0 } }),
            item('first', { input: 20, output: 2, reasoning: 1, cache: { read: 30, write: 0 } }),
            item('first', { input: 20, output: 5, reasoning: 1, cache: { read: 30, write: 0 } }),
            item('second', { input: 4, output: 8, reasoning: 0, cache: { read: 40, write: 3 } }),
            item('user', { input: 999, output: 99 }, 'user')
        ], baseline);
        expect(tokens).toEqual({
            input: 24,
            output: 13,
            reasoning: 1,
            cacheRead: 70,
            cacheWrite: 3,
            cacheReported: true
        });
    });

    test('does not claim cache zero when the backend omitted cache metadata', () => {
        const sum = aggregateRuntimeTokens([item('a', { input: 15, output: 2, reasoning: 0 })]);
        expect(formatRuntimeUsage(sum, 'chat', estimated).prompt_tokens_details).toBeUndefined();
        expect(formatRuntimeUsage(null, 'responses', estimated)).toEqual({
            input_tokens: 122044,
            output_tokens: 22,
            total_tokens: 122066,
            output_tokens_details: { reasoning_tokens: 0 }
        });
    });

    test('uses a completed SDK message snapshot and falls back safely if missing', async () => {
        const messages = jest.fn(async () => ({ data: [item('a', step)] }));
        const client = { session: { messages } };
        const input = { client, sessionId: 's1', protocol: 'chat', estimate: estimated };
        const usage = await readRuntimeUsage(input);
        expect(usage.prompt_tokens_details.cached_tokens).toBe(136640);
        expect(messages).toHaveBeenCalledWith({ path: { id: 's1' } });

        messages.mockRejectedValueOnce(new Error('SDK unavailable'));
        const fallback = await readRuntimeUsage(input);
        expect(fallback.prompt_tokens_details).toBeUndefined();
        expect(fallback.prompt_tokens).toBe(122044);
    });

    test('unknown/malformed message shapes do not manufacture cache statistics', () => {
        expect(aggregateRuntimeTokens(null)).toBeNull();
        expect(aggregateRuntimeTokens([{ info: { role: 'assistant' } }])).toBeNull();
        expect(aggregateRuntimeTokens([
            item('bad', { input: -1, output: NaN, reasoning: Infinity, cache: {} })
        ])).toBeNull();
        expect(aggregateRuntimeTokens([item('a', { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })]).cacheReported).toBe(true);
    });
});
