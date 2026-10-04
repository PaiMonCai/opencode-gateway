/**
 * Invariant 6 (ARCHITECTURE §2): a failed baseline snapshot fails the turn
 * (`503 session_state_unavailable`) instead of falling back to unfiltered
 * polling — a reused session must never report the previous turn's answer.
 *
 * Also: a turn that never reads a snapshot (fresh session) must not pay for one.
 */

import {
    BaselineUnavailableError,
    SESSION_STATE_UNAVAILABLE,
    assertBaseline,
    isBaselineUnavailable,
    snapshotSessionState
} from '../../../src/conversation/baseline.js';
import { conversationScopeFor } from '../../../src/conversation/identity.js';
import {
    assistantText,
    createRegistryHarness,
    scriptedSessionBackend,
    sessionMessage,
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

const HEADERS = { 'x-opencode-session': 'conv-baseline' };

describe('snapshotSessionState', () => {
    test('collects every pre-existing message and part id, in both wire shapes', async () => {
        const entries = [
            sessionMessage('msg-1', 'user', [{ id: 'part-1' }, { id: 'part-2' }]),
            sessionMessage('msg-2', 'assistant', [{ id: 'part-3', type: 'text' }], { finish: 'stop' }),
            { info: { role: 'user' }, parts: [{ id: 'part-4' }] }, // no message id
            sessionMessage('msg-4', 'assistant', [{ type: 'text' }]) // no part id
        ];
        const backend = scriptedSessionBackend([{ data: entries }, entries]);

        const wrapped = await snapshotSessionState({ sessionId: 'ses-1', sessionBackend: backend });
        expect(wrapped.ok).toBe(true);
        expect([...wrapped.messageIds].sort()).toEqual(['msg-1', 'msg-2', 'msg-4']);
        expect([...wrapped.partIds].sort()).toEqual(['part-1', 'part-2', 'part-3', 'part-4']);

        const direct = await snapshotSessionState({ sessionId: 'ses-1', sessionBackend: backend });
        expect([...direct.messageIds].sort()).toEqual(['msg-1', 'msg-2', 'msg-4']);
        expect(backend.calls).toEqual(['ses-1', 'ses-1']);
    });

    test('a transient failure is retried and the successful read wins, never a partial one', async () => {
        const backend = scriptedSessionBackend([
            new Error('runtime hiccup'),
            [sessionMessage('msg-only-from-second-read', 'assistant', [{ id: 'part-second' }])]
        ]);

        const baseline = await snapshotSessionState({ sessionId: 'ses-2', sessionBackend: backend });
        expect(baseline.ok).toBe(true);
        expect([...baseline.messageIds]).toEqual(['msg-only-from-second-read']);
        expect([...baseline.partIds]).toEqual(['part-second']);
        expect(backend.calls).toEqual(['ses-2', 'ses-2']);
    });

    test('when both attempts fail the result is ok:false with NO ids (never "nothing pre-existed")', async () => {
        const backend = scriptedSessionBackend([new Error('down')]);

        const baseline = await snapshotSessionState({ sessionId: 'ses-3', sessionBackend: backend });
        expect(baseline.ok).toBe(false);
        expect(baseline.messageIds.size).toBe(0);
        expect(baseline.partIds.size).toBe(0);
        expect(backend.calls).toEqual(['ses-3', 'ses-3']);
        expect(isBaselineUnavailable(baseline)).toBe(true);
    });

    test('a missing backend, a broken backend and a non-array payload all fail closed', async () => {
        const noBackend = await snapshotSessionState({ sessionId: 'ses-4', sessionBackend: null });
        expect(noBackend.ok).toBe(false);

        const broken = await snapshotSessionState({
            sessionId: 'ses-4',
            sessionBackend: { messages: 'not-a-function' }
        });
        expect(broken.ok).toBe(false);

        const weird = await snapshotSessionState({
            sessionId: 'ses-4',
            sessionBackend: scriptedSessionBackend([{ data: { not: 'a list' } }, { data: null }])
        });
        expect(weird.ok).toBe(false);
    });

    test('a session that does not exist yet needs no read at all', async () => {
        const backend = scriptedSessionBackend([[]]);
        const baseline = await snapshotSessionState({ sessionId: null, sessionBackend: backend });
        expect(baseline.ok).toBe(true);
        expect(baseline.messageIds.size).toBe(0);
        expect(backend.calls).toEqual([]);
    });

    test('maxAttempts is honoured', async () => {
        const backend = scriptedSessionBackend([
            new Error('one'),
            new Error('two'),
            [sessionMessage('msg-third', 'assistant', [])]
        ]);
        const baseline = await snapshotSessionState({
            sessionId: 'ses-5',
            sessionBackend: backend,
            maxAttempts: 3
        });
        expect(baseline.ok).toBe(true);
        expect([...baseline.messageIds]).toEqual(['msg-third']);
        expect(backend.calls).toHaveLength(3);
    });
});

describe('assertBaseline', () => {
    test('passes a usable baseline through unchanged', () => {
        const baseline = { ok: true, messageIds: new Set(['m']), partIds: new Set(['p']) };
        expect(assertBaseline(baseline)).toBe(baseline);
    });

    test('throws the documented 503 session_state_unavailable for a failed or missing baseline', () => {
        for (const value of [null, undefined, { ok: false, messageIds: new Set(), partIds: new Set() }]) {
            let thrown = null;
            try {
                assertBaseline(value);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(BaselineUnavailableError);
            expect(thrown.statusCode).toBe(503);
            expect(thrown.code).toBe(SESSION_STATE_UNAVAILABLE);
            expect(thrown.code).toBe('session_state_unavailable');
            expect(thrown.type).toBe('session_state_unavailable');
            expect(thrown.message).toBe(
                'Could not read the session state for this conversation; retry the request'
            );
        }
    });

    test('isBaselineUnavailable only reports a positive failed snapshot', () => {
        expect(isBaselineUnavailable({ ok: false })).toBe(true);
        expect(isBaselineUnavailable({ ok: true })).toBe(false);
        expect(isBaselineUnavailable(null)).toBe(false);
        expect(isBaselineUnavailable(undefined)).toBe(false);
    });
});

describe('invariant 6 at the registry boundary', () => {
    async function seedRuntimeConversation() {
        const harness = createRegistryHarness({
            sessionBackend: null,
            config: { SESSION_TTL_MS: 600_000 }
        });
        const scope = runtimeScope();
        const seed = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        seed.release();
        harness.registry.storeTurn({
            key: seed.key,
            sessionId: 'ses-reuse',
            mode: 'runtime',
            plan: seed.plan,
            replyText: 'A1'
        });
        return { ...harness, scope, key: seed.key };
    }

    test('a reused runtime session reports ok:false instead of a null/unfiltered baseline', async () => {
        const { registry, scope } = await seedRuntimeConversation();

        const turn = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(turn.plan.reuse).toBe(true);
        expect(turn.sessionId).toBe('ses-reuse');
        // No backend was wired, so the snapshot must fail closed — not return
        // an empty "nothing to filter" baseline.
        expect(turn.baseline).not.toBeNull();
        expect(turn.baseline.ok).toBe(false);
        expect(turn.baseline.messageIds.size).toBe(0);
        expect(turn.baseline.partIds.size).toBe(0);
        expect(() => assertBaseline(turn.baseline)).toThrow(BaselineUnavailableError);
        turn.release();
    });

    test('a reused runtime session with a failing reader fails closed, a fresh one never reads', async () => {
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([new Error('runtime down')]),
            config: { SESSION_TTL_MS: 600_000 }
        });
        const scope = runtimeScope();

        const fresh = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        expect(fresh.plan.reuse).toBe(false);
        expect(fresh.baseline).toBeNull();
        fresh.release();

        harness.registry.storeTurn({
            key: fresh.key,
            sessionId: 'ses-fail',
            mode: 'runtime',
            plan: fresh.plan,
            replyText: 'A1'
        });

        const reused = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(reused.plan.reuse).toBe(true);
        expect(reused.baseline.ok).toBe(false);
        expect(() => assertBaseline(reused.baseline)).toThrow(/session state/i);
        reused.release();
    });

    test('a pinned turn (previous_response_id) requires a baseline too', async () => {
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([new Error('nope')])
        });
        const turn = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope: runtimeScope(),
            deliverable: [userText('continue')],
            previousSessionId: 'ses-pinned'
        });
        expect(turn.plan.pinned).toBe(true);
        expect(turn.sessionId).toBe('ses-pinned');
        expect(turn.baseline.ok).toBe(false);
        expect(() => assertBaseline(turn.baseline)).toThrow(BaselineUnavailableError);
        turn.release();
    });

    test('a reused direct session needs no baseline (nothing upstream to filter)', async () => {
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([new Error('the runtime has no such session')]),
            config: { SESSION_TTL_MS: 600_000 }
        });
        const scope = conversationScopeFor({
            providerID: 'opencode',
            modelID: 'verify-model',
            toolMode: 'none',
            toolFingerprint: '-',
            mode: 'direct'
        });

        const seed = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        seed.release();
        harness.registry.storeTurn({
            key: seed.key,
            sessionId: 'ses_direct_label',
            mode: 'direct',
            plan: seed.plan,
            replyText: 'A1'
        });

        const reused = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(reused.plan.reuse).toBe(true);
        expect(reused.sessionId).toBe('ses_direct_label');
        expect(reused.baseline).toBeNull();
        reused.release();
    });
});
