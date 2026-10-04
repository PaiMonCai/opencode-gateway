/**
 * Invariant 8 (ARCHITECTURE §2) plus the TTL / LRU / candidate caps:
 * sessions the registry no longer tracks are closed, except direct sessions
 * (nothing upstream to close) and sessions a live `previous_response_id` chain
 * still references.
 */

import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { DEFAULT_CONVERSATION_TTL_MS, createConversationStore } from '../../../src/conversation/store.js';
import {
    assistantText,
    createFakeClock,
    createRegistryHarness,
    scriptedSessionBackend,
    userText
} from './fixtures.js';

const runtimeScope = () =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime'
    });

const directScope = () =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'direct'
    });

const HEADERS = { 'x-opencode-session': 'conv-evict' };

const createCloserSpy = () => {
    const calls = [];
    return {
        calls,
        close: async (sessionId, mode) => {
            calls.push([sessionId, mode]);
        }
    };
};

describe('TTL', () => {
    test('the registry closes an idle runtime session exactly at the TTL boundary', async () => {
        const clock = createFakeClock();
        const closer = createCloserSpy();
        const store = createConversationStore({
            clock,
            ttlMs: 1_000,
            closeSession: closer.close
        });

        store.put('k', { sessionId: 'ses-ttl', mode: 'runtime' });
        clock.advance(999);
        expect(store.get('k')).not.toBeNull(); // still alive one ms before the TTL
        expect(await store.sweep()).toBe(0);

        clock.advance(1);
        expect(await store.sweep()).toBe(1);
        expect(closer.calls).toEqual([['ses-ttl', 'runtime']]);
        expect(store.size()).toBe(0);
    });

    test('an expired conversation is not reused and its session is closed (registry level)', async () => {
        const clock = createFakeClock();
        const { registry, closed } = createRegistryHarness({
            clock,
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 1_000 }
        });
        const scope = runtimeScope();

        const seed = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        seed.release();
        registry.storeTurn({
            key: seed.key,
            sessionId: 'ses-expire',
            mode: 'runtime',
            plan: seed.plan,
            replyText: 'A1'
        });

        clock.advance(999);
        const beforeBoundary = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(beforeBoundary.sessionId).toBe('ses-expire');
        beforeBoundary.release();

        clock.advance(2);
        expect(await registry.sweep()).toBe(1);
        expect(closed).toEqual(['ses-expire']);

        const afterExpiry = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(afterExpiry.entry).toBeNull();
        expect(afterExpiry.sessionId).toBeNull();
        expect(afterExpiry.plan.reuse).toBe(false);
        afterExpiry.release();
    });

    test('the documented default TTL is 30 minutes', () => {
        expect(DEFAULT_CONVERSATION_TTL_MS).toBe(30 * 60 * 1000);
    });
});

describe('closing policy (invariant 8)', () => {
    async function seedConversation(harness, scope, sessionId, mode, headers = HEADERS) {
        const seed = await harness.registry.resolveTurn({
            headers,
            scope,
            deliverable: [userText('Q1')]
        });
        seed.release();
        harness.registry.storeTurn({
            key: seed.key,
            sessionId,
            mode,
            plan: seed.plan,
            replyText: 'A1'
        });
        return seed.key;
    }

    test('sweep closes an expired runtime session but never a direct one', async () => {
        const clock = createFakeClock();
        const { registry, closed } = createRegistryHarness({
            clock,
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 1_000 }
        });

        await seedConversation({ registry }, runtimeScope(), 'ses-runtime', 'runtime', {
            'x-opencode-session': 'conv-runtime'
        });
        await seedConversation({ registry }, directScope(), 'ses-direct', 'direct', {
            'x-opencode-session': 'conv-direct'
        });

        clock.advance(1_000);
        expect(await registry.sweep()).toBe(2);
        expect(closed).toEqual(['ses-runtime']);
    });

    test('a session a live response chain still references is kept', async () => {
        const clock = createFakeClock();
        const held = new Set(['ses-held']);
        const { registry, closed } = createRegistryHarness({
            clock,
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 1_000 },
            held
        });
        await seedConversation({ registry }, runtimeScope(), 'ses-held', 'runtime');

        clock.advance(1_000);
        expect(await registry.sweep()).toBe(1);
        expect(closed).toEqual([]); // entry dropped, upstream session kept for the chain
    });

    test('discard closes a runtime session, but not a direct or a chain-held one', async () => {
        const clock = createFakeClock();
        const held = new Set(['ses-held']);
        const { registry, closed } = createRegistryHarness({
            clock,
            sessionBackend: scriptedSessionBackend([[]]),
            held
        });

        const runtimeKey = await seedConversation({ registry }, runtimeScope(), 'ses-runtime', 'runtime', {
            'x-opencode-session': 'conv-runtime'
        });
        const directKey = await seedConversation({ registry }, directScope(), 'ses-direct', 'direct', {
            'x-opencode-session': 'conv-direct'
        });
        const heldKey = await seedConversation({ registry }, runtimeScope(), 'ses-held', 'runtime', {
            'x-opencode-session': 'conv-held'
        });

        expect((await registry.discard({ key: directKey })).sessionId).toBe('ses-direct');
        expect((await registry.discard({ key: heldKey })).sessionId).toBe('ses-held');
        expect((await registry.discard({ key: runtimeKey })).sessionId).toBe('ses-runtime');

        expect(closed).toEqual(['ses-runtime']);
    });
});

describe('caps', () => {
    test('the entry cap evicts the least recently used conversation and closes it', () => {
        const clock = createFakeClock();
        const closer = createCloserSpy();
        const store = createConversationStore({ clock, maxEntries: 3, closeSession: closer.close });

        store.put('k1', { sessionId: 's1', mode: 'runtime' });
        clock.advance(10);
        store.put('k2', { sessionId: 's2', mode: 'runtime' });
        clock.advance(10);
        store.put('k3', { sessionId: 's3', mode: 'runtime' });
        clock.advance(10);
        store.put('k4', { sessionId: 's4', mode: 'runtime' });

        expect(store.size()).toBe(3);
        expect(store.get('k1')).toBeNull();
        expect(closer.calls).toEqual([['s1', 'runtime']]);

        // `touch` moves a conversation out of the eviction order.
        clock.advance(10);
        store.touch('k3');
        clock.advance(10);
        store.put('k5', { sessionId: 's5', mode: 'runtime' });

        expect(store.get('k2')).toBeNull();
        expect(store.get('k3')).not.toBeNull();
        expect(closer.calls).toEqual([
            ['s1', 'runtime'],
            ['s2', 'runtime']
        ]);
    });

    test('the candidate cap bounds look-alikes sharing one anchor and closes the dropped session', () => {
        const clock = createFakeClock();
        const closer = createCloserSpy();
        const store = createConversationStore({ clock, maxCandidates: 2, closeSession: closer.close });

        store.put('c1', { sessionId: 's1', mode: 'runtime', startKey: 'anchor' });
        store.put('c2', { sessionId: 's2', mode: 'runtime', startKey: 'anchor' });
        store.put('c3', { sessionId: 's3', mode: 'runtime', startKey: 'anchor' });

        expect(store.candidatesFor('anchor').map((candidate) => candidate.key)).toEqual(['c2', 'c3']);
        expect(store.get('c1')).toBeNull();
        expect(closer.calls).toEqual([['s1', 'runtime']]);
    });

    test('sweep never touches a conversation that holds its turn lock', async () => {
        const clock = createFakeClock();
        const closer = createCloserSpy();
        const store = createConversationStore({ clock, ttlMs: 1_000, closeSession: closer.close });

        store.put('locked', { sessionId: 'ses-locked', mode: 'runtime' });
        const release = await store.acquireLock('locked', 1_000);
        expect(typeof release).toBe('function');

        clock.advance(5_000);
        expect(await store.sweep()).toBe(0);
        expect(store.get('locked')).not.toBeNull();
        expect(closer.calls).toEqual([]);

        release();
        expect(await store.sweep()).toBe(1);
        expect(closer.calls).toEqual([['ses-locked', 'runtime']]);
    });

    test('reading an expired entry drops and closes it', () => {
        const clock = createFakeClock();
        const closer = createCloserSpy();
        const store = createConversationStore({ clock, ttlMs: 1_000, closeSession: closer.close });

        store.put('e', { sessionId: 'ses-read', mode: 'runtime' });
        clock.advance(1_000);
        expect(store.get('e')).toBeNull();
        expect(closer.calls).toEqual([['ses-read', 'runtime']]);
        expect(store.size()).toBe(0);
    });
});
