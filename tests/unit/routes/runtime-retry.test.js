import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS,
    rotateRuntimeSession,
    runtimeRetryDetail,
    shouldRetryRuntimeAttempt
} from '../../../src/routes/runtime-retry.js';

describe('runtime retry policy', () => {
    test('retries transient failures only before the attempt limit and before output', () => {
        const transient = {
            name: 'CreditsError',
            statusCode: 401,
            data: { message: 'temporarily throttled' }
        };

        expect(
            shouldRetryRuntimeAttempt({
                error: transient,
                hasOutput: false,
                attempt: 1
            })
        ).toBe(true);

        expect(
            shouldRetryRuntimeAttempt({
                error: transient,
                hasOutput: true,
                attempt: 1
            })
        ).toBe(false);

        expect(
            shouldRetryRuntimeAttempt({
                error: transient,
                hasOutput: false,
                attempt: DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS
            })
        ).toBe(false);
    });

    test('does not retry ordinary provider failures', () => {
        expect(
            shouldRetryRuntimeAttempt({
                error: { name: 'ValidationError', message: 'bad request' },
                hasOutput: false,
                attempt: 1
            })
        ).toBe(false);
    });

    test('formats the most useful retry detail', () => {
        expect(runtimeRetryDetail({ name: 'CreditsError', data: { message: 'quota' } })).toBe('quota');
        expect(runtimeRetryDetail({ name: 'Boom', message: 'failed' })).toBe('failed');
        expect(runtimeRetryDetail({ name: 'Boom' })).toBe('Boom');
        expect(runtimeRetryDetail(null)).toBe('unknown');
    });

    test('rotates sessions and applies attempt-scaled backoff', async () => {
        const calls = [];
        const next = await rotateRuntimeSession({
            sessionId: 'old',
            deleteSession: async (id) => calls.push(['delete', id]),
            createSession: async () => {
                calls.push(['create']);
                return 'new';
            },
            attempt: 2,
            backoffBaseMs: 100,
            sleepFn: async (ms) => calls.push(['sleep', ms])
        });

        expect(next).toBe('new');
        expect(calls).toEqual([['delete', 'old'], ['create'], ['sleep', 200]]);
    });

    test('continues rotation when deleting the failed session errors', async () => {
        const debug = [];
        const next = await rotateRuntimeSession({
            sessionId: 'old',
            deleteSession: async () => {
                throw new Error('delete failed');
            },
            createSession: async () => 'new',
            attempt: 2,
            sleepFn: async () => {},
            logDebug: (message, fields) => debug.push({ message, fields })
        });

        expect(next).toBe('new');
        expect(debug).toEqual([
            {
                message: 'Failed to delete retried session',
                fields: { sessionId: 'old', error: 'delete failed' }
            }
        ]);
    });
});
