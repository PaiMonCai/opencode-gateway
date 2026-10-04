import {
    createConversationRegistry,
    resolveConversationSettings
} from '../../../src/conversation/registry.js';
import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { assertBaseline } from '../../../src/conversation/baseline.js';
import {
    createFakeClock,
    createFakeCloser,
    createFakeLogger,
    createFakeSessionBackend,
    settleAsyncWork
} from './helpers.js';

const RUNTIME_SCOPE = conversationScopeFor({
    providerID: 'opencode',
    modelID: 'kimi-k2.5',
    toolMode: 'disabled',
    toolFingerprint: '-',
    mode: 'runtime'
});

const makeRegistry = (overrides = {}) => {
    const clock = overrides.clock || createFakeClock();
    const closer = createFakeCloser();
    const backend = overrides.sessionBackend || createFakeSessionBackend();
    const logger = createFakeLogger();
    const registry = createConversationRegistry({
        config: {
            SESSION_REUSE_ENABLED: true,
            SESSION_DERIVE_ENABLED: false,
            SESSION_TTL_MS: 60000,
            REQUEST_TIMEOUT_MS: 1000,
            ...overrides.config
        },
        clock,
        logger,
        sessionBackend: backend,
        deleteSession: closer.deleteSession,
        isSessionHeld: closer.isSessionHeld,
        lockTimeoutMs: overrides.lockTimeoutMs ?? null
    });
    return { registry, clock, closer, backend, logger };
};

const userMessage = (content) => ({ role: 'user', content });
const assistantMessage = (content) => ({ role: 'assistant', content });

describe('resolveTurn — explicit conversation identity', () => {
    test('one identity keeps one session and sends only the appended turns', async () => {
        const { registry } = makeRegistry();
        const headers = { 'session-id': 'conv-1' };
        const first = [userMessage('first question')];

        const turn1 = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: first });
        expect(turn1.identity).toMatchObject({ source: 'header', header: 'session-id', value: 'conv-1' });
        expect(turn1.key).toHaveLength(64);
        expect(turn1.entry).toBeNull();
        expect(turn1.plan.reuse).toBe(false);
        expect(turn1.plan.delta).toEqual(first);
        expect(turn1.baseline).toBeNull();
        // Nothing is tracked yet, so the caller creates a session.
        expect(turn1.sessionId).toBeNull();
        expect(turn1.busy).toBe(false);
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: turn1.plan,
            replyText: 'first answer'
        });
        turn1.release();

        const second = [...first, assistantMessage('first answer'), userMessage('second question')];
        const turn2 = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: second });
        // Same identity -> same session -> only the appended turn, with the
        // echoed answer not repeated.
        expect(turn2.entry.sessionId).toEqual('session-1');
        expect(turn2.sessionId).toEqual('session-1');
        expect(turn2.plan.reuse).toBe(true);
        expect(turn2.plan.delta).toEqual([userMessage('second question')]);
        expect(turn2.plan.deltaStartIndex).toEqual(2);
        expect(turn2.baseline.ok).toBe(true);
        registry.storeTurn({
            key: turn2.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: turn2.plan,
            replyText: 'second answer'
        });
        turn2.release();

        const turn3 = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [...second, assistantMessage('second answer'), userMessage('third question')]
        });
        expect(turn3.entry.sessionId).toEqual('session-1');
        expect(turn3.plan.delta).toEqual([userMessage('third question')]);
        turn3.release();
    });

    test('a rewritten prefix rotates: full history and no session handed back', async () => {
        const { registry } = makeRegistry();
        const headers = { 'session-id': 'conv-rewrite' };
        const turn1 = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('A')]
        });
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: turn1.plan,
            replyText: 'a'
        });
        turn1.release();

        const edited = [userMessage('EDITED A'), assistantMessage('a'), userMessage('B')];
        const turn2 = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: edited });
        expect(turn2.plan.reuse).toBe(false);
        expect(turn2.plan.rewrite).toBe(true);
        expect(turn2.plan.delta).toEqual(edited);
        expect(turn2.plan.deltaStartIndex).toEqual(0);
        // The caller must create a new session; the stale one is not reused.
        expect(turn2.sessionId).toBeNull();
        expect(turn2.entry.sessionId).toEqual('session-1');
        turn2.release();
    });

    test('a retried turn that rotated re-sends the full history', async () => {
        const { registry, closer } = makeRegistry();
        const headers = { 'session-id': 'conv-retry' };
        const history = [userMessage('remember 41'), assistantMessage('41'), userMessage('what number?')];
        const turn1 = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: history });
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: turn1.plan,
            replyText: '41'
        });
        turn1.release();

        // The turn fails upstream: the entry is discarded and the session closed.
        await registry.discard({ key: turn1.key });
        expect(closer.deleted).toEqual(['session-1']);

        const retry = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: history });
        expect(retry.entry).toBeNull();
        expect(retry.plan.reuse).toBe(false);
        expect(retry.plan.delta).toEqual(history);
        expect(retry.plan.deltaStartIndex).toEqual(0);
        retry.release();
    });

    test('a queued turn never reuses a session that was discarded while it waited', async () => {
        const { registry } = makeRegistry();
        const headers = { 'session-id': 'conv-queued' };
        const first = [userMessage('first question')];
        const held = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: first });
        registry.storeTurn({
            key: held.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: held.plan,
            replyText: 'answer'
        });

        // Takes the queue behind the held turn, then the held turn's entry is
        // discarded (as a failed turn does) before the lock is handed over.
        const queued = registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [...first, assistantMessage('answer'), userMessage('second question')]
        });
        await registry.discard({ key: held.key });
        held.release();

        const turn = await queued;
        expect(turn.entry).toBeNull();
        expect(turn.plan.reuse).toBe(false);
        expect(turn.plan.delta).toHaveLength(3);
        expect(turn.sessionId).toBeNull();
        turn.release();
    });

    test('a fresh conversation gets no baseline read', async () => {
        const backend = createFakeSessionBackend();
        const { registry } = makeRegistry({ sessionBackend: backend });
        const turn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-fresh' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('hello')]
        });
        expect(turn.baseline).toBeNull();
        expect(backend.reads).toEqual([]);
        turn.release();
    });

    test('the upstream mode is part of the scope, so direct and runtime never share', async () => {
        const { registry } = makeRegistry();
        const headers = { 'session-id': 'conv-mode' };
        const directScope = conversationScopeFor({
            providerID: 'opencode',
            modelID: 'kimi-k2.5',
            toolMode: 'disabled',
            toolFingerprint: '-',
            mode: 'direct'
        });
        const direct = await registry.resolveTurn({
            headers,
            scope: directScope,
            deliverable: [userMessage('hello')]
        });
        direct.release();
        const runtime = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('hello')]
        });
        runtime.release();
        expect(direct.key).not.toEqual(runtime.key);
    });

    test('a reused direct session needs no baseline read', async () => {
        const backend = createFakeSessionBackend();
        const { registry } = makeRegistry({ sessionBackend: backend });
        const headers = { 'session-id': 'conv-direct-reuse' };
        const scope = conversationScopeFor({
            providerID: 'opencode',
            modelID: 'kimi-k2.5',
            toolMode: 'disabled',
            toolFingerprint: '-',
            mode: 'direct'
        });
        const first = [userMessage('first question')];
        const turn1 = await registry.resolveTurn({ headers, scope, deliverable: first });
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'direct-label',
            mode: 'direct',
            plan: turn1.plan,
            replyText: 'answer'
        });
        turn1.release();

        const turn2 = await registry.resolveTurn({
            headers,
            scope,
            deliverable: [...first, assistantMessage('answer'), userMessage('second question')]
        });
        expect(turn2.plan.reuse).toBe(true);
        expect(turn2.entry.mode).toEqual('direct');
        expect(turn2.sessionId).toEqual('direct-label');
        // Upstream has no state to read for a direct label, and the direct turn
        // relays the upstream response verbatim.
        expect(turn2.baseline).toBeNull();
        expect(backend.reads).toEqual([]);
        turn2.release();
    });

    test('reuse can be disabled entirely', async () => {
        const { registry } = makeRegistry({ config: { SESSION_REUSE_ENABLED: false } });
        const turn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-off' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('hello')]
        });
        expect(turn.identity.source).toEqual('none');
        expect(turn.key).toBeNull();
        expect(turn.plan.reuse).toBe(false);
        expect(
            registry.storeTurn({
                key: turn.key,
                sessionId: 's',
                mode: 'runtime',
                plan: turn.plan,
                replyText: 'x'
            })
        ).toBeNull();
        turn.release();
    });
});

describe('resolveTurn — response-chain pinning', () => {
    test('pins the session, requires a baseline and is not registered as a conversation', async () => {
        const backend = createFakeSessionBackend({
            'pinned-1': [{ info: { id: 'msg-old', role: 'user' }, parts: [{ id: 'part-old' }] }]
        });
        const { registry } = makeRegistry({ sessionBackend: backend });
        const headers = { 'session-id': 'conv-pinned' };
        const turn = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('second question')],
            previousSessionId: 'pinned-1'
        });
        expect(turn.plan.pinned).toBe(true);
        expect(turn.plan.reuse).toBe(true);
        expect(turn.plan.delta).toEqual([userMessage('second question')]);
        expect(turn.plan.deltaStartIndex).toEqual(0);
        expect(turn.sessionId).toEqual('pinned-1');
        expect(turn.baseline.ok).toBe(true);
        expect(turn.baseline.messageIds.has('msg-old')).toBe(true);
        expect(assertBaseline(turn.baseline)).toBe(turn.baseline);

        // The pinned session belongs to the response chain, not to this map.
        expect(
            registry.storeTurn({
                key: turn.key,
                sessionId: 'pinned-1',
                mode: 'runtime',
                plan: turn.plan,
                replyText: 'answer'
            })
        ).toBeNull();
        turn.release();

        const next = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('third')]
        });
        expect(next.entry).toBeNull();
        expect(next.plan.reuse).toBe(false);
        next.release();
    });
});

describe('resolveTurn — derived conversation identity', () => {
    const derivedRegistry = (overrides = {}) =>
        makeRegistry({
            ...overrides,
            config: { SESSION_DERIVE_ENABLED: true, ...(overrides.config || {}) }
        });

    const storeDerived = (registry, turn, sessionId, replyText) =>
        registry.storeTurn({
            key: turn.key,
            sessionId,
            mode: 'runtime',
            plan: turn.plan,
            replyText,
            startKey: turn.identity.startKey
        });

    test('recognises a conversation from its content and reuses the session', async () => {
        const { registry } = derivedRegistry();
        const first = [userMessage('remember the codeword ZEBRA')];
        const turn1 = await registry.resolveTurn({ headers: {}, scope: RUNTIME_SCOPE, deliverable: first });
        expect(turn1.identity.source).toEqual('derived');
        storeDerived(registry, turn1, 'session-1', 'the codeword is ZEBRA');
        turn1.release();

        const turn2 = await registry.resolveTurn({
            headers: {},
            scope: RUNTIME_SCOPE,
            deliverable: [...first, assistantMessage('the codeword is ZEBRA'), userMessage('what was it?')]
        });
        expect(turn2.key).toEqual(turn1.key);
        expect(turn2.entry.sessionId).toEqual('session-1');
        expect(turn2.plan.reuse).toBe(true);
        expect(turn2.plan.delta).toEqual([userMessage('what was it?')]);
        turn2.release();
    });

    test('refuses to merge look-alikes it cannot tell apart', async () => {
        const { registry } = derivedRegistry();
        const opening = [userMessage('hello')];
        const turn1 = await registry.resolveTurn({ headers: {}, scope: RUNTIME_SCOPE, deliverable: opening });
        storeDerived(registry, turn1, 'session-1', 'hi there');
        turn1.release();
        const turn2 = await registry.resolveTurn({ headers: {}, scope: RUNTIME_SCOPE, deliverable: opening });
        expect(turn2.key).not.toEqual(turn1.key);
        storeDerived(registry, turn2, 'session-2', 'hi there');
        turn2.release();

        const followUp = await registry.resolveTurn({
            headers: {},
            scope: RUNTIME_SCOPE,
            deliverable: [...opening, assistantMessage('hi there'), userMessage('first follow-up')]
        });
        // Identical prefix and identical answer: guessing would merge two
        // clients' histories, so a fresh conversation starts instead.
        expect(followUp.key).not.toEqual(turn1.key);
        expect(followUp.key).not.toEqual(turn2.key);
        expect(followUp.entry).toBeNull();
        expect(followUp.plan.reuse).toBe(false);
        expect(followUp.plan.delta).toHaveLength(3);
        followUp.release();
    });

    test('uses the echoed answer to pick the right look-alike', async () => {
        const { registry } = derivedRegistry();
        const opening = [userMessage('hello')];
        const turn1 = await registry.resolveTurn({ headers: {}, scope: RUNTIME_SCOPE, deliverable: opening });
        storeDerived(registry, turn1, 'session-1', 'hi there');
        turn1.release();
        const turn2 = await registry.resolveTurn({ headers: {}, scope: RUNTIME_SCOPE, deliverable: opening });
        storeDerived(registry, turn2, 'session-2', 'a different answer');
        turn2.release();

        const resumed = await registry.resolveTurn({
            headers: {},
            scope: RUNTIME_SCOPE,
            deliverable: [...opening, assistantMessage('hi there'), userMessage('continuing A')]
        });
        expect(resumed.key).toEqual(turn1.key);
        expect(resumed.entry.sessionId).toEqual('session-1');
        expect(resumed.plan.reuse).toBe(true);
        resumed.release();
    });

    test('is off by default', async () => {
        const { registry } = makeRegistry();
        const turn = await registry.resolveTurn({
            headers: {},
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('hello')]
        });
        expect(turn.identity.source).toEqual('none');
        expect(turn.key).toBeNull();
        turn.release();
    });
});

describe('resolveTurn — baseline failure is fail-closed', () => {
    test('a reused turn reports an unusable baseline instead of guessing', async () => {
        const backend = createFakeSessionBackend();
        const { registry } = makeRegistry({ sessionBackend: backend });
        const headers = { 'session-id': 'conv-snapshot' };
        const first = [userMessage('first question')];
        const turn1 = await registry.resolveTurn({ headers, scope: RUNTIME_SCOPE, deliverable: first });
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'session-1',
            mode: 'runtime',
            plan: turn1.plan,
            replyText: 'reply-1'
        });
        turn1.release();

        // Both snapshot attempts fail.
        backend.failNextReads = 2;
        const turn2 = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [...first, assistantMessage('reply-1'), userMessage('second question')]
        });
        expect(turn2.plan.reuse).toBe(true);
        expect(turn2.baseline.ok).toBe(false);
        expect(turn2.baseline.messageIds.size).toEqual(0);
        expect(() => assertBaseline(turn2.baseline)).toThrow(/session state/iu);
        // No fallback path exists: the caller has to fail the turn with 503.
        expect(turn2.baseline.partIds.size).toEqual(0);
        turn2.release();
    });

    test('a pinned turn also fails closed when its baseline cannot be read', async () => {
        const backend = createFakeSessionBackend();
        backend.failNextReads = 2;
        const { registry } = makeRegistry({ sessionBackend: backend });
        const turn = await registry.resolveTurn({
            headers: {},
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('next')],
            previousSessionId: 'pinned-1'
        });
        expect(turn.plan.pinned).toBe(true);
        expect(turn.baseline.ok).toBe(false);
        expect(() => assertBaseline(turn.baseline)).toThrow();
        turn.release();
    });
});

describe('resolveTurn — busy conversations', () => {
    test('a second turn on the same conversation reports busy and hands back a no-op release', async () => {
        const { registry } = makeRegistry({ lockTimeoutMs: 20 });
        const headers = { 'session-id': 'conv-busy' };
        const held = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });

        const busy = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('two')]
        });
        expect(busy.busy).toBe(true);
        expect(busy.plan).toBeNull();
        expect(busy.baseline).toBeNull();
        expect(busy.key).toEqual(held.key);
        expect(typeof busy.release).toBe('function');
        expect(() => busy.release()).not.toThrow();

        held.release();
        const after = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('three')]
        });
        expect(after.busy).toBe(false);
        after.release();
    });

    test('different conversations are not blocked by one another', async () => {
        const { registry } = makeRegistry({ lockTimeoutMs: 20 });
        const held = await registry.resolveTurn({
            headers: { 'session-id': 'conv-a' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        const other = await registry.resolveTurn({
            headers: { 'session-id': 'conv-b' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        expect(other.busy).toBe(false);
        held.release();
        other.release();
    });
});

describe('sweep and session closing', () => {
    test('closes an expired runtime session but never a direct one', async () => {
        const { registry, clock, closer } = makeRegistry();
        const runtimeTurn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-runtime' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        registry.storeTurn({
            key: runtimeTurn.key,
            sessionId: 'session-runtime',
            mode: 'runtime',
            plan: runtimeTurn.plan,
            replyText: 'a'
        });
        runtimeTurn.release();

        const directScope = conversationScopeFor({
            providerID: 'opencode',
            modelID: 'kimi-k2.5',
            toolMode: 'disabled',
            toolFingerprint: '-',
            mode: 'direct'
        });
        const directTurn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-direct' },
            scope: directScope,
            deliverable: [userMessage('one')]
        });
        registry.storeTurn({
            key: directTurn.key,
            sessionId: 'direct-label',
            mode: 'direct',
            plan: directTurn.plan,
            replyText: 'a'
        });
        directTurn.release();

        clock.advance(60001);
        expect(await registry.sweep()).toEqual(2);
        expect(closer.deleted).toEqual(['session-runtime']);
    });

    test('keeps a session a live response chain still references', async () => {
        const { registry, clock, closer } = makeRegistry();
        const turn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-chain' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        registry.storeTurn({
            key: turn.key,
            sessionId: 'session-chain',
            mode: 'runtime',
            plan: turn.plan,
            replyText: 'a'
        });
        turn.release();

        closer.held.add('session-chain');
        clock.advance(60001);
        expect(await registry.sweep()).toEqual(1);
        expect(closer.deleted).toEqual([]);
    });

    test('an expired conversation is not reused and its session is closed', async () => {
        const { registry, clock, closer } = makeRegistry();
        const headers = { 'session-id': 'conv-ttl' };
        const turn1 = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        registry.storeTurn({
            key: turn1.key,
            sessionId: 'session-ttl',
            mode: 'runtime',
            plan: turn1.plan,
            replyText: 'a'
        });
        turn1.release();

        clock.advance(60001);
        const turn2 = await registry.resolveTurn({
            headers,
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one'), assistantMessage('a'), userMessage('two')]
        });
        expect(turn2.entry).toBeNull();
        expect(turn2.plan.reuse).toBe(false);
        expect(turn2.plan.delta).toHaveLength(3);
        turn2.release();
        await settleAsyncWork();
        expect(closer.deleted).toContain('session-ttl');
    });

    test('discard drops the conversation and closes a runtime session', async () => {
        const { registry, closer } = makeRegistry();
        const turn = await registry.resolveTurn({
            headers: { 'session-id': 'conv-discard' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        registry.storeTurn({
            key: turn.key,
            sessionId: 'session-d',
            mode: 'runtime',
            plan: turn.plan,
            replyText: 'a'
        });
        turn.release();
        await registry.discard({ key: turn.key });
        expect(closer.deleted).toEqual(['session-d']);

        const again = await registry.resolveTurn({
            headers: { 'session-id': 'conv-discard' },
            scope: RUNTIME_SCOPE,
            deliverable: [userMessage('one')]
        });
        expect(again.entry).toBeNull();
        again.release();
    });
});

describe('resolveConversationSettings', () => {
    test('keeps the documented defaults', () => {
        const settings = resolveConversationSettings({});
        expect(settings.reuseEnabled).toBe(true);
        expect(settings.deriveEnabled).toBe(false);
        expect(settings.ttlMs).toEqual(30 * 60 * 1000);
        expect(settings.headerNames).toHaveLength(11);
        expect(settings.lockTimeoutMs).toEqual(5 * 60 * 1000);
    });

    test('allows the request timeout plus margin for a queued turn', () => {
        expect(resolveConversationSettings({ REQUEST_TIMEOUT_MS: 30000 }).lockTimeoutMs).toEqual(90000);
    });

    test('derivation is opt-in and needs reuse', () => {
        expect(resolveConversationSettings({ SESSION_DERIVE_ENABLED: 'true' }).deriveEnabled).toBe(true);
        expect(
            resolveConversationSettings({ SESSION_DERIVE_ENABLED: 'on', SESSION_REUSE_ENABLED: 'false' })
                .deriveEnabled
        ).toBe(false);
    });

    test('accepts a narrowed, comma-separated header list and a TTL', () => {
        const settings = resolveConversationSettings({
            SESSION_HEADER_NAMES: 'x-mine, x-other',
            SESSION_TTL_MS: '1500'
        });
        expect(settings.headerNames).toEqual(['x-mine', 'x-other']);
        expect(settings.ttlMs).toEqual(1500);
    });

    test('falls back for nonsense values', () => {
        const settings = resolveConversationSettings({
            SESSION_TTL_MS: 'nope',
            SESSION_REUSE_ENABLED: 'maybe'
        });
        expect(settings.ttlMs).toEqual(30 * 60 * 1000);
        expect(settings.reuseEnabled).toBe(true);
    });
});
