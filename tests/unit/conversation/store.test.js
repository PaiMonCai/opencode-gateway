import { createFakeClock } from './helpers.js';
import { DEFAULT_CONVERSATION_TTL_MS, createConversationStore } from '../../../src/conversation/store.js';

const patch = (sessionId, overrides = {}) => ({
    sessionId,
    mode: 'runtime',
    sentCount: 1,
    sentDigest: 'digest-1',
    replyDigest: null,
    startKey: null,
    ...overrides
});

const makeStore = (overrides = {}) => {
    const clock = overrides.clock || createFakeClock();
    const closed = [];
    const store = createConversationStore({
        clock,
        ttlMs: 1000,
        closeSession: async (sessionId, mode) => {
            closed.push({ sessionId, mode });
        },
        ...overrides
    });
    return { store, clock, closed };
};

/** Let fire-and-forget closes run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('conversation store entries', () => {
    test('stores, reads and refreshes an entry', () => {
        const { store, clock } = makeStore();
        const stored = store.put('k', patch('session-1'));
        expect(stored.sessionId).toEqual('session-1');
        expect(stored.createdAt).toEqual(clock.now());
        expect(stored.expiresAt).toEqual(clock.now() + 1000);
        expect(store.get('k')).toBe(stored);
        expect(store.size()).toEqual(1);

        clock.advance(900);
        store.touch('k');
        clock.advance(500);
        expect(store.get('k')).not.toBeNull();
    });

    test('expires an idle entry and closes its runtime session', async () => {
        const { store, clock, closed } = makeStore();
        store.put('k', patch('session-1'));
        clock.advance(1001);
        expect(store.get('k')).toBeNull();
        expect(store.size()).toEqual(0);
        await settle();
        expect(closed).toEqual([{ sessionId: 'session-1', mode: 'runtime' }]);
    });

    test('keeps direct sessions tracked but still hands them to the closer policy', async () => {
        const { store, closed } = makeStore();
        store.put('k', patch('direct-label', { mode: 'direct' }));
        await store.discard('k');
        // The registry decides that a direct session has nothing to close; the
        // store reports the mode faithfully.
        expect(closed).toEqual([{ sessionId: 'direct-label', mode: 'direct' }]);
    });

    test('drop forgets an entry without closing its session', async () => {
        const { store, closed } = makeStore();
        store.put('k', patch('session-1'));
        expect(store.drop('k')?.sessionId).toEqual('session-1');
        expect(store.get('k')).toBeNull();
        await settle();
        expect(closed).toEqual([]);
    });

    test('evict closes the session it owned', async () => {
        const { store, closed } = makeStore();
        store.put('k', patch('session-1'));
        await store.evict('k');
        expect(closed).toEqual([{ sessionId: 'session-1', mode: 'runtime' }]);
        expect(store.size()).toEqual(0);
    });

    test('evict closes an entry handed over explicitly after it left the map', async () => {
        const { store, closed } = makeStore();
        const stale = store.put('k', patch('session-1'));
        store.drop('k');
        await store.evict('k', stale);
        expect(closed).toEqual([{ sessionId: 'session-1', mode: 'runtime' }]);
    });

    test('melds an update over the previous entry', () => {
        const { store } = makeStore();
        store.put('k', patch('session-1', { startKey: 'anchor', sentCount: 2 }));
        const updated = store.put('k', { sessionId: 'session-2', mode: 'direct' });
        expect(updated.sessionId).toEqual('session-2');
        expect(updated.mode).toEqual('direct');
        expect(updated.sentCount).toEqual(2);
        expect(updated.startKey).toEqual('anchor');
        expect(store.candidatesFor('anchor')).toHaveLength(1);
    });
});

describe('conversation store caps', () => {
    test('expires idle conversations on sweep and reports the count', async () => {
        const { store, clock, closed } = makeStore();
        store.put('a', patch('session-a'));
        clock.advance(600);
        store.put('b', patch('session-b'));
        clock.advance(500);
        expect(await store.sweep()).toEqual(1);
        expect(store.size()).toEqual(1);
        expect(store.get('b')).not.toBeNull();
        expect(closed).toEqual([{ sessionId: 'session-a', mode: 'runtime' }]);
    });

    test('never sweeps a conversation that currently holds its turn lock', async () => {
        const { store, clock, closed } = makeStore();
        store.put('a', patch('session-a'));
        const release = await store.acquireLock('a');
        clock.advance(5000);
        expect(await store.sweep()).toEqual(0);
        expect(store.get('a')).not.toBeNull();

        release();
        expect(await store.sweep()).toEqual(1);
        await settle();
        expect(closed).toEqual([{ sessionId: 'session-a', mode: 'runtime' }]);
    });

    test('caps tracked conversations and drops the least recently used', async () => {
        const { store, clock, closed } = makeStore({ maxEntries: 2 });
        store.put('oldest', patch('session-oldest'));
        clock.advance(10);
        store.put('middle', patch('session-middle'));
        clock.advance(10);
        store.put('newest', patch('session-newest'));
        expect(store.size()).toEqual(2);
        expect(store.get('oldest')).toBeNull();
        expect(store.get('middle')).not.toBeNull();
        expect(store.get('newest')).not.toBeNull();
        await settle();
        expect(closed).toEqual([{ sessionId: 'session-oldest', mode: 'runtime' }]);
    });

    test('the hard cap wins over a locked conversation, oldest first', async () => {
        const { store, closed } = makeStore({ maxEntries: 2 });
        store.put('a', patch('session-a'));
        const releaseA = await store.acquireLock('a');
        store.put('b', patch('session-b'));
        store.put('c', patch('session-c'));

        // 'a' is both the oldest and locked: the cap is a hard bound, so it is
        // still the victim, and its session is closed.
        expect(store.size()).toEqual(2);
        expect(store.get('b')).not.toBeNull();
        expect(store.get('c')).not.toBeNull();
        await settle();
        expect(closed.map(({ sessionId }) => sessionId)).toContain('session-a');
        releaseA();
    });

    test('caps the candidates sharing one anchor', async () => {
        const { store, clock, closed } = makeStore({ maxCandidates: 2 });
        store.put('a', patch('session-a', { startKey: 'anchor' }));
        clock.advance(10);
        store.put('b', patch('session-b', { startKey: 'anchor' }));
        clock.advance(10);
        store.put('c', patch('session-c', { startKey: 'anchor' }));
        expect(store.candidatesFor('anchor').map(({ key }) => key)).toEqual(['b', 'c']);
        expect(store.get('a')).toBeNull();
        await settle();
        expect(closed).toEqual([{ sessionId: 'session-a', mode: 'runtime' }]);
    });

    test('prunes expired candidates and drops them from the anchor', async () => {
        const { store, clock, closed } = makeStore();
        store.put('a', patch('session-a', { startKey: 'anchor', sentCount: 2 }));
        clock.advance(1001);
        expect(store.candidatesFor('anchor')).toEqual([]);
        await settle();
        expect(closed).toEqual([{ sessionId: 'session-a', mode: 'runtime' }]);
    });
});

describe('per-conversation turn lock', () => {
    test('serializes turns of one conversation, FIFO', async () => {
        const { store } = makeStore();
        const order = [];
        const releaseFirst = await store.acquireLock('k');
        expect(store.isLocked('k')).toBe(true);

        const second = store.acquireLock('k').then((release) => {
            order.push('second');
            release();
        });
        const third = store.acquireLock('k').then((release) => {
            order.push('third');
            release();
        });
        expect(order).toEqual([]);

        releaseFirst();
        await Promise.all([second, third]);
        expect(order).toEqual(['second', 'third']);
        expect(store.isLocked('k')).toBe(false);
    });

    test('does not serialize different conversations', async () => {
        const { store } = makeStore();
        const releaseA = await store.acquireLock('a');
        const releaseB = await store.acquireLock('b');
        expect(typeof releaseA).toBe('function');
        expect(typeof releaseB).toBe('function');
        releaseA();
        releaseB();
    });

    test('is a no-op without a conversation key', async () => {
        const { store } = makeStore();
        const release = await store.acquireLock(null);
        expect(typeof release).toBe('function');
        expect(() => release()).not.toThrow();
        expect(() => release()).not.toThrow();
    });

    test('a waiter gives up after the timeout with null, but the queue still drains', async () => {
        const { store } = makeStore();
        const releaseHolder = await store.acquireLock('k');
        const timedOut = await store.acquireLock('k', 20);
        expect(timedOut).toBeNull();

        // The abandoned slot is released when its turn comes, so a later waiter
        // is not stuck behind it.
        const late = store.acquireLock('k', 500);
        releaseHolder();
        const releaseLate = await late;
        expect(typeof releaseLate).toBe('function');
        expect(store.isLocked('k')).toBe(true);
        releaseLate();
        expect(store.isLocked('k')).toBe(false);
    });

    test('release is idempotent', async () => {
        const { store } = makeStore();
        const release = await store.acquireLock('k');
        release();
        release();
        expect(store.isLocked('k')).toBe(false);
        const again = await store.acquireLock('k', 20);
        expect(typeof again).toBe('function');
    });
});

describe('store defaults', () => {
    test('falls back to the documented TTL', () => {
        const clock = createFakeClock();
        const store = createConversationStore({ clock, ttlMs: 0 });
        const stored = store.put('k', patch('session-1'));
        expect(stored.expiresAt).toEqual(clock.now() + DEFAULT_CONVERSATION_TTL_MS);
    });

    test('works without a closer or a logger', async () => {
        const clock = createFakeClock();
        const store = createConversationStore({ clock });
        store.put('k', patch('session-1'));
        expect(clock.now()).toBeGreaterThan(0);
        await expect(store.discard('k')).resolves.toMatchObject({ sessionId: 'session-1' });
    });
});
