/**
 * Invariants 3 and 4 (ARCHITECTURE §2):
 *  - reuse requires a full-prefix match; any edit, truncation or reorder
 *    anywhere in the prefix starts a fresh session with the full history;
 *  - a retry that rotates to a new session re-sends the full history.
 *
 * Counterexamples are attempted at every prefix position, not only at the tail.
 */

import {
    deliverableMessages,
    planConversationTurn,
    planRotationTurn,
    prefixDigest
} from '../../../src/conversation/planner.js';
import { conversationScopeFor } from '../../../src/conversation/identity.js';
import {
    assistantText,
    createRegistryHarness,
    scriptedSessionBackend,
    systemText,
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

const HEADERS = { 'x-opencode-session': 'conv-prefix' };

/** Stored transcript: three delivered messages, session `ses-base`. */
const storedPrefix = [userText('U1'), assistantText('A1'), userText('U2')];

async function seedStoredConversation() {
    const { registry, closed } = createRegistryHarness({
        sessionBackend: scriptedSessionBackend([[]]),
        config: { SESSION_TTL_MS: 600_000 }
    });
    const scope = runtimeScope();
    const seedTurn = await registry.resolveTurn({
        headers: HEADERS,
        scope,
        deliverable: storedPrefix
    });
    seedTurn.release();
    registry.storeTurn({
        key: seedTurn.key,
        sessionId: 'ses-base',
        mode: 'runtime',
        plan: seedTurn.plan,
        replyText: 'A2'
    });
    return { registry, closed, scope, key: seedTurn.key };
}

describe('invariant 3 — full-prefix match is required', () => {
    test('control: an untouched prefix plus an appended turn is reused', async () => {
        const { registry, scope } = await seedStoredConversation();
        const turn = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [...storedPrefix, assistantText('A2'), userText('U3')]
        });
        expect(turn.plan.reuse).toBe(true);
        expect(turn.sessionId).toBe('ses-base');
        expect(turn.plan.delta).toEqual([userText('U3')]);
        turn.release();
    });

    const mutations = [
        {
            name: 'edit in the first message',
            deliverable: [userText('U1-EDITED'), assistantText('A1'), userText('U2'), userText('U3')]
        },
        {
            name: 'edit in a middle message',
            deliverable: [userText('U1'), assistantText('A1-EDITED'), userText('U2'), userText('U3')]
        },
        {
            name: 'edit in the last prefix message',
            deliverable: [userText('U1'), assistantText('A1'), userText('U2-EDITED'), userText('U3')]
        },
        {
            name: 'reorder inside the prefix',
            deliverable: [assistantText('A1'), userText('U1'), userText('U2'), userText('U3')]
        },
        {
            name: 'truncate the prefix',
            deliverable: [userText('U1'), assistantText('A1')]
        },
        {
            name: 'replay the same history with no appended turn',
            deliverable: [userText('U1'), assistantText('A1'), userText('U2')]
        }
    ];

    test.each(mutations)(
        '$name rotates: no session handed back and the full history is sent',
        async ({ deliverable }) => {
            const { registry, scope } = await seedStoredConversation();
            const turn = await registry.resolveTurn({ headers: HEADERS, scope, deliverable });

            expect(turn.busy).toBe(false);
            expect(turn.plan.reuse).toBe(false);
            expect(turn.plan.rewrite).toBe(true);
            expect(turn.sessionId).toBeNull();
            expect(turn.plan.deltaStartIndex).toBe(0);
            expect(turn.plan.delta).toEqual(deliverable);
            expect(turn.plan.sentCount).toBe(deliverable.length);
            expect(turn.plan.sentDigest).toBe(prefixDigest(deliverable, deliverable.length));
            turn.release();
        }
    );

    test('system messages are rebuilt every turn and never disturb the stored prefix', () => {
        // The routes layer filters system turns out of the deliverable
        // (`deliverableMessages`); a fresh system prompt on the next turn must
        // therefore not rotate the conversation.
        const entry = { sentCount: 3, sentDigest: prefixDigest(storedPrefix, 3) };
        const deliveredWithSystem = [systemText('fresh prompt'), ...storedPrefix, userText('U3')];
        const plan = planConversationTurn(entry, deliverableMessages(deliveredWithSystem));
        expect(plan.reuse).toBe(true);
        expect(plan.delta).toEqual([userText('U3')]);
    });
});

describe('invariant 4 — a rotation re-sends the full history', () => {
    test('planRotationTurn always carries the whole transcript', () => {
        const history = [userText('U1'), assistantText('A1'), userText('U2'), userText('U3')];
        const plan = planRotationTurn(history);
        expect(plan.reuse).toBe(false);
        expect(plan.rotation).toBe(true);
        expect(plan.delta).toEqual(history);
        expect(plan.deltaStartIndex).toBe(0);
        expect(plan.sentCount).toBe(history.length);
    });

    test('after a retry rotates, the conversation points at the new session and resumes from it', async () => {
        const { registry, scope, key } = await seedStoredConversation();
        const rotatedHistory = [
            userText('U1'),
            assistantText('A1'),
            userText('U2'),
            assistantText('A2'),
            userText('U3')
        ];

        // A failed turn rotates: the caller plans a fresh session and must send
        // the full history rather than the delta the old plan would have sent.
        const rotation = planRotationTurn(rotatedHistory);
        expect(rotation.delta).toEqual(rotatedHistory);
        registry.storeTurn({
            key,
            sessionId: 'ses-rotated',
            mode: 'runtime',
            plan: rotation,
            replyText: 'A3'
        });

        const next = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [...rotatedHistory, assistantText('A3'), userText('U4')]
        });
        expect(next.plan.reuse).toBe(true);
        expect(next.sessionId).toBe('ses-rotated');
        expect(next.plan.delta).toEqual([userText('U4')]);
        next.release();
    });
});
