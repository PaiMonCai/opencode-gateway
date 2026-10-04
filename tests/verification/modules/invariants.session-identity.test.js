/**
 * Invariants 1 and 2 (ARCHITECTURE §2):
 *  - one conversation identity maps to one upstream session, and the same
 *    session id is handed back on every turn of that conversation;
 *  - only the appended turns are sent to a runtime session, and an echoed
 *    assistant answer is not sent twice.
 *
 * These tests use the frozen registry interface (`resolveTurn` / `storeTurn` /
 * `release`) and independent fixtures only.
 */

import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { assistantText, createRegistryHarness, scriptedSessionBackend, userText } from './fixtures.js';

const runtimeScope = (modelID = 'verify-model') =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID,
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime'
    });

const HEADERS = { 'x-opencode-session': 'conv-alpha' };

describe('invariant 1 — one identity, one upstream session', () => {
    test('three turns of one conversation reuse exactly one session id', async () => {
        const backend = scriptedSessionBackend([[]]);
        const { registry } = createRegistryHarness({
            sessionBackend: backend,
            config: { SESSION_TTL_MS: 600_000 }
        });
        const scope = runtimeScope();

        const t1 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        expect(t1.busy).toBe(false);
        expect(t1.key).toEqual(expect.any(String));
        expect(t1.entry).toBeNull();
        expect(t1.plan.reuse).toBe(false);
        expect(t1.plan.delta).toEqual([userText('Q1')]);
        expect(t1.sessionId).toBeNull();
        t1.release();
        registry.storeTurn({
            key: t1.key,
            sessionId: 'ses-upstream-1',
            mode: 'runtime',
            plan: t1.plan,
            replyText: 'A1'
        });

        const t2 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(t2.busy).toBe(false);
        expect(t2.key).toBe(t1.key);
        expect(t2.plan.reuse).toBe(true);
        expect(t2.sessionId).toBe('ses-upstream-1');
        t2.release();
        registry.storeTurn({
            key: t2.key,
            sessionId: 'ses-upstream-1',
            mode: 'runtime',
            plan: t2.plan,
            replyText: 'A2'
        });

        const t3 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [
                userText('Q1'),
                assistantText('A1'),
                userText('Q2'),
                assistantText('A2'),
                userText('Q3')
            ]
        });
        expect(t3.busy).toBe(false);
        expect(t3.plan.reuse).toBe(true);
        expect(t3.sessionId).toBe('ses-upstream-1');
        t3.release();

        // The reused runtime session is read back for its baseline on each
        // reusing turn, always under the same session id.
        expect(backend.calls).toEqual(['ses-upstream-1', 'ses-upstream-1']);
    });

    test('two different identity values never share a conversation key or session', async () => {
        const { registry } = createRegistryHarness({ sessionBackend: scriptedSessionBackend([[]]) });
        const scope = runtimeScope();

        const first = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'conv-a' },
            scope,
            deliverable: [userText('Q1')]
        });
        registry.storeTurn({
            key: first.key,
            sessionId: 'ses-a',
            mode: 'runtime',
            plan: first.plan,
            replyText: 'A'
        });
        first.release();

        const second = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'conv-b' },
            scope,
            deliverable: [userText('Q1')]
        });
        second.release();

        expect(second.key).not.toBe(first.key);
        expect(second.entry).toBeNull();
        expect(second.sessionId).toBeNull();
        expect(second.plan.reuse).toBe(false);
    });
});

describe('invariant 2 — only the appended turns are sent', () => {
    test('an echoed assistant answer is not re-sent, the appended user turn is', async () => {
        const { registry } = createRegistryHarness({ sessionBackend: scriptedSessionBackend([[]]) });
        const scope = runtimeScope();

        const t1 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        t1.release();
        registry.storeTurn({
            key: t1.key,
            sessionId: 'ses-echo',
            mode: 'runtime',
            plan: t1.plan,
            replyText: 'A1'
        });

        const t2 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(t2.plan.reuse).toBe(true);
        expect(t2.plan.delta).toEqual([userText('Q2')]);
        expect(t2.plan.delta).not.toContainEqual(assistantText('A1'));
        expect(t2.plan.deltaStartIndex).toBe(2);
        t2.release();
    });

    test('an echo plus several appended turns keeps every appended turn after the echo', async () => {
        const { registry } = createRegistryHarness({ sessionBackend: scriptedSessionBackend([[]]) });
        const scope = runtimeScope();

        const t1 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        t1.release();
        registry.storeTurn({
            key: t1.key,
            sessionId: 'ses-echo-2',
            mode: 'runtime',
            plan: t1.plan,
            replyText: 'A1'
        });

        const t2 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [
                userText('Q1'),
                assistantText('A1'),
                userText('Q2'),
                userText('Q3-extra'),
                assistantText('A-partial')
            ]
        });
        expect(t2.plan.reuse).toBe(true);
        // Only the leading echo is dropped; everything appended after it is sent.
        expect(t2.plan.delta).toEqual([userText('Q2'), userText('Q3-extra'), assistantText('A-partial')]);
        expect(t2.plan.sentCount).toBe(5);
        t2.release();
    });

    test('a conversation that never echoes the answer still sends only the appended turn', async () => {
        const { registry } = createRegistryHarness({ sessionBackend: scriptedSessionBackend([[]]) });
        const scope = runtimeScope();

        const t1 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        t1.release();
        registry.storeTurn({
            key: t1.key,
            sessionId: 'ses-plain',
            mode: 'runtime',
            plan: t1.plan,
            replyText: 'A1'
        });

        const t2 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), userText('Q2')]
        });
        expect(t2.plan.delta).toEqual([userText('Q2')]);
        expect(t2.plan.deltaStartIndex).toBe(1);
        t2.release();
        registry.storeTurn({
            key: t2.key,
            sessionId: 'ses-plain',
            mode: 'runtime',
            plan: t2.plan,
            replyText: 'A2'
        });

        const t3 = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), userText('Q2'), userText('Q3')]
        });
        expect(t3.plan.delta).toEqual([userText('Q3')]);
        expect(t3.sessionId).toBe('ses-plain');
        t3.release();
    });
});
