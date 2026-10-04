/**
 * Invariant 5 (ARCHITECTURE §2): two conversations that content alone cannot
 * tell apart are never merged — the lookup refuses instead; when the client
 * echoes an answer, the matching candidate must be selected exactly.
 *
 * Derived identity is the only path where this ambiguity exists, so the tests
 * drive `SESSION_DERIVE_ENABLED=true` through the real registry.
 */

import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { assistantText, createRegistryHarness, scriptedSessionBackend, userText } from './fixtures.js';

const runtimeScope = () =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime'
    });

const OPENER = userText('the same opening message');

/**
 * Seed two derived candidates that share an anchor (same scope, same first
 * message) and the same stored prefix.
 *
 * @param {{replyA?: string, replyB?: string}} [replies]
 */
async function seedLookAlikes({ replyA = 'ANSWER-A', replyB = 'ANSWER-B' } = {}) {
    const harness = createRegistryHarness({
        sessionBackend: scriptedSessionBackend([[]]),
        config: { SESSION_DERIVE_ENABLED: true, SESSION_TTL_MS: 600_000 }
    });
    const scope = runtimeScope();

    const first = await harness.registry.resolveTurn({
        headers: {},
        scope,
        deliverable: [OPENER]
    });
    expect(first.identity.source).toBe('derived');
    expect(first.identity.startKey).toEqual(expect.any(String));
    first.release();

    harness.registry.storeTurn({
        key: first.key,
        sessionId: 'ses-A',
        mode: 'runtime',
        plan: first.plan,
        replyText: replyA,
        startKey: first.identity.startKey
    });
    harness.registry.storeTurn({
        key: 'derived:candidate-b',
        sessionId: 'ses-B',
        mode: 'runtime',
        plan: first.plan,
        replyText: replyB,
        startKey: first.identity.startKey
    });

    return { ...harness, scope, keyA: first.key };
}

describe('invariant 5 — look-alike conversations are never merged', () => {
    test('identical prefixes and identical echoed answers are refused, not merged', async () => {
        const { registry, scope, keyA } = await seedLookAlikes({
            replyA: 'IDENTICAL',
            replyB: 'IDENTICAL'
        });

        const turn = await registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('IDENTICAL'), userText('next turn')]
        });

        expect(turn.busy).toBe(false);
        expect(turn.entry).toBeNull();
        expect(turn.sessionId).toBeNull();
        expect(turn.plan.reuse).toBe(false);
        expect(turn.key).not.toBe(keyA);
        expect(turn.key).not.toBe('derived:candidate-b');
        expect(turn.plan.delta).toEqual([OPENER, assistantText('IDENTICAL'), userText('next turn')]);
        turn.release();
    });

    test('identical prefixes with contradicting echoes (neither matches) are refused', async () => {
        const { registry, scope } = await seedLookAlikes();

        const turn = await registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-C'), userText('next turn')]
        });

        expect(turn.entry).toBeNull();
        expect(turn.sessionId).toBeNull();
        expect(turn.plan.reuse).toBe(false);
        turn.release();
    });

    test('the echoed answer selects exactly one candidate when it matches', async () => {
        const { registry, scope } = await seedLookAlikes();

        const turn = await registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-B'), userText('next turn')]
        });

        expect(turn.plan.reuse).toBe(true);
        expect(turn.entry?.sessionId).toBe('ses-B');
        expect(turn.sessionId).toBe('ses-B');
        expect(turn.plan.delta).toEqual([userText('next turn')]);
        turn.release();
    });

    test('the other candidate is selected when the other answer is echoed', async () => {
        const { registry, scope } = await seedLookAlikes();

        const turn = await registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-A'), userText('next turn')]
        });

        expect(turn.sessionId).toBe('ses-A');
        turn.release();
    });

    test('a single matching candidate is reused even without a matching echo', async () => {
        // With one candidate the prefix alone identifies the conversation, so
        // there is nothing to disambiguate.
        const { registry, scope } = await seedLookAlikes();
        await registry.discard({ key: 'derived:candidate-b' });

        const turn = await registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-A'), userText('next turn')]
        });

        expect(turn.plan.reuse).toBe(true);
        expect(turn.sessionId).toBe('ses-A');
        turn.release();
    });

    test('a candidate is never matched by a transcript that is not longer than its stored history', async () => {
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_DERIVE_ENABLED: true, SESSION_TTL_MS: 600_000 }
        });
        const scope = runtimeScope();
        const seed = await harness.registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-A')]
        });
        seed.release();
        harness.registry.storeTurn({
            key: seed.key,
            sessionId: 'ses-long',
            mode: 'runtime',
            plan: seed.plan,
            replyText: 'ANSWER-A',
            startKey: seed.identity.startKey
        });

        // Replaying exactly the stored history carries no appended turn: the
        // lookup refuses and a fresh session starts.
        const replay = await harness.registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-A')]
        });
        expect(replay.entry).toBeNull();
        expect(replay.sessionId).toBeNull();
        expect(replay.plan.reuse).toBe(false);
        replay.release();

        // The same candidate is recognised as soon as a turn is appended.
        const appended = await harness.registry.resolveTurn({
            headers: {},
            scope,
            deliverable: [OPENER, assistantText('ANSWER-A'), userText('next turn')]
        });
        expect(appended.plan.reuse).toBe(true);
        expect(appended.sessionId).toBe('ses-long');
        appended.release();
    });
});
