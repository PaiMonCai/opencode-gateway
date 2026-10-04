/**
 * Invariant 7 (ARCHITECTURE §2): turns of one conversation are serialized, a
 * waiter gives up with `503 conversation_busy` after the lock wait, and the
 * `release` handed back for a busy turn is a safe no-op.
 */

import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { assistantText, createRegistryHarness, sleep, userText } from './fixtures.js';

const runtimeScope = (modelID = 'verify-model') =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID,
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime'
    });

const HEADERS_A = { 'x-opencode-session': 'conv-lock-a' };
const HEADERS_B = { 'x-opencode-session': 'conv-lock-b' };

describe('invariant 7 — one turn at a time per conversation', () => {
    test('a queued turn times out busy, its release is a no-op, and the queue still drains', async () => {
        const { registry } = createRegistryHarness({ lockTimeoutMs: 60 });
        const scope = runtimeScope();

        const holder = await registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1')]
        });
        expect(holder.busy).toBe(false);

        const startedAt = Date.now();
        const waiter = await registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1'), userText('Q2')]
        });
        const waited = Date.now() - startedAt;

        expect(waiter.busy).toBe(true);
        expect(waiter.plan).toBeNull();
        expect(waiter.sessionId).toBeNull();
        expect(waiter.entry).toBeNull();
        expect(waited).toBeGreaterThanOrEqual(40); // it really waited for the lock
        expect(waiter.key).toBe(holder.key);
        // The documented no-op release: callable, idempotent, must not unlock
        // (or lock) anything.
        expect(() => waiter.release()).not.toThrow();
        expect(waiter.release()).toBeUndefined();
        expect(() => waiter.release()).not.toThrow();

        // The conversation is not wedged: once the holder releases, the stored
        // session is usable again.
        registry.storeTurn({
            key: holder.key,
            sessionId: 'ses-lock',
            mode: 'runtime',
            plan: holder.plan,
            replyText: 'A1'
        });
        holder.release();

        const resumed = await registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(resumed.busy).toBe(false);
        expect(resumed.sessionId).toBe('ses-lock');
        resumed.release();
    });

    test('queued turns are served FIFO', async () => {
        const { registry } = createRegistryHarness({ lockTimeoutMs: 2_000 });
        const scope = runtimeScope();

        const holder = await registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1')]
        });

        const order = [];
        const second = registry
            .resolveTurn({ headers: HEADERS_A, scope, deliverable: [userText('Q1'), userText('Q2')] })
            .then((turn) => {
                order.push('second');
                return turn;
            });
        await sleep(10);
        const third = registry
            .resolveTurn({ headers: HEADERS_A, scope, deliverable: [userText('Q1'), userText('Q3')] })
            .then((turn) => {
                order.push('third');
                return turn;
            });
        await sleep(10);

        holder.release();
        const secondTurn = await second;
        expect(secondTurn.busy).toBe(false);
        secondTurn.release();

        const thirdTurn = await third;
        expect(thirdTurn.busy).toBe(false);
        thirdTurn.release();

        expect(order).toEqual(['second', 'third']);
    });

    test('different conversations are never blocked by one another', async () => {
        const { registry } = createRegistryHarness({ lockTimeoutMs: 60 });

        const holder = await registry.resolveTurn({
            headers: HEADERS_A,
            scope: runtimeScope(),
            deliverable: [userText('Q1')]
        });

        const other = await registry.resolveTurn({
            headers: HEADERS_B,
            scope: runtimeScope(),
            deliverable: [userText('Q1')]
        });
        expect(other.busy).toBe(false);
        expect(other.key).not.toBe(holder.key);
        other.release();
        holder.release();
    });

    test('a holder that fails without storing still releases the queue', async () => {
        const { registry } = createRegistryHarness({ lockTimeoutMs: 1_000 });
        const scope = runtimeScope();

        const failed = await registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1')]
        });

        const queued = registry.resolveTurn({
            headers: HEADERS_A,
            scope,
            deliverable: [userText('Q1'), userText('Q2')]
        });
        await sleep(10);
        failed.release(); // the turn failed: nothing was stored

        const next = await queued;
        expect(next.busy).toBe(false);
        expect(next.entry).toBeNull();
        expect(next.sessionId).toBeNull();
        expect(next.plan.rewrite).toBe(false);
        next.release();
    });
});
