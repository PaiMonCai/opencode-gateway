import { describe, expect, test } from '@jest/globals';

import { collectRuntimePromptAttempt, runPolledRuntimeAttempt } from '../../../src/routes/runtime-attempt.js';

describe('runtime attempt execution', () => {
    test('subscribes before dispatching the prompt', async () => {
        const order = [];
        const result = await collectRuntimePromptAttempt({
            collect: async () => {
                order.push('collect');
                return { content: 'ok' };
            },
            prompt: async () => {
                order.push('prompt');
            }
        });

        expect(order).toEqual(['collect', 'prompt']);
        expect(result).toEqual({ content: 'ok' });
    });

    test('normalizes asynchronous collector rejection', async () => {
        const error = new Error('stream failed');
        const result = await collectRuntimePromptAttempt({
            collect: () => Promise.reject(error),
            prompt: async () => {}
        });

        expect(result).toEqual({ __error: error });
    });

    test('reports asynchronous prompt rejection without failing collection', async () => {
        const errors = [];
        const result = await collectRuntimePromptAttempt({
            collect: async () => ({ content: 'answer' }),
            prompt: async () => {
                throw new Error('prompt failed');
            },
            onPromptError: (error) => errors.push(error.message)
        });

        await Promise.resolve();
        expect(result).toEqual({ content: 'answer' });
        expect(errors).toEqual(['prompt failed']);
    });

    test('runs prompt before polling and records prompt latency', async () => {
        const order = [];
        const logs = [];
        const times = [100, 135];
        const result = await runPolledRuntimeAttempt({
            prompt: async () => {
                order.push('prompt');
            },
            poll: async () => {
                order.push('poll');
                return { content: 'done', reasoning: '', error: null };
            },
            sessionId: 'sess-1',
            attempt: 2,
            logDebug: (message, fields) => logs.push({ message, fields }),
            now: () => times.shift()
        });

        expect(order).toEqual(['prompt', 'poll']);
        expect(result).toEqual({ content: 'done', reasoning: '', error: null });
        expect(logs).toEqual([
            { message: 'Prompt sent', fields: { sessionId: 'sess-1', ms: 35, attempt: 2 } }
        ]);
    });
});
