import { describe, expect, test } from '@jest/globals';

import { createTurnLimiter } from '../../../src/concurrency/turn-limiter.js';

describe('turn limiter', () => {
    test('queues fairly until an active turn releases its permit', async () => {
        const limiter = createTurnLimiter({ maxConcurrent: 1, maxPending: 2, waitTimeoutMs: 1000 });
        const releaseFirst = await limiter.acquire();
        const secondPromise = limiter.acquire();

        expect(limiter.snapshot()).toMatchObject({ active: 1, pending: 1 });
        releaseFirst();

        const releaseSecond = await secondPromise;
        expect(typeof releaseSecond).toBe('function');
        expect(limiter.snapshot()).toMatchObject({ active: 1, pending: 0 });

        releaseSecond();
        await Promise.resolve();
        expect(limiter.snapshot()).toMatchObject({ active: 0, pending: 0 });
    });

    test('rejects immediately when the bounded pending queue is full', async () => {
        const limiter = createTurnLimiter({ maxConcurrent: 1, maxPending: 1, waitTimeoutMs: 1000 });
        const releaseFirst = await limiter.acquire();
        const secondPromise = limiter.acquire();

        const third = await limiter.acquire();
        expect(third).toBeNull();
        expect(limiter.snapshot()).toMatchObject({
            active: 1,
            pending: 1,
            rejectedTotal: 1
        });

        releaseFirst();
        const releaseSecond = await secondPromise;
        releaseSecond();
    });

    test('times out queued turns instead of waiting indefinitely', async () => {
        const limiter = createTurnLimiter({ maxConcurrent: 1, maxPending: 1, waitTimeoutMs: 20 });
        const releaseFirst = await limiter.acquire();

        const second = await limiter.acquire();
        expect(second).toBeNull();
        expect(limiter.snapshot()).toMatchObject({
            active: 1,
            pending: 0,
            timedOutTotal: 1
        });

        releaseFirst();
    });

    test('removes a queued turn when its client aborts', async () => {
        const limiter = createTurnLimiter({ maxConcurrent: 1, maxPending: 1, waitTimeoutMs: 1000 });
        const releaseFirst = await limiter.acquire();
        const controller = new AbortController();
        const secondPromise = limiter.acquire({ signal: controller.signal });

        expect(limiter.snapshot().pending).toBe(1);
        controller.abort();

        expect(await secondPromise).toBeNull();
        expect(limiter.snapshot()).toMatchObject({
            active: 1,
            pending: 0,
            abortedTotal: 1
        });

        releaseFirst();
    });

    test('release functions are idempotent', async () => {
        const limiter = createTurnLimiter({ maxConcurrent: 1, maxPending: 0, waitTimeoutMs: 0 });
        const release = await limiter.acquire();

        release();
        release();
        await Promise.resolve();

        expect(limiter.snapshot().active).toBe(0);
    });
});
