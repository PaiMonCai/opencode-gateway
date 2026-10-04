/**
 * Conversation-identity header contract.
 *
 * Reference: `docs/en/api-reference.md` "Request headers" — the 11 documented
 * spellings, first non-empty wins, `x-opencode-session` deliberately first — and
 * BEHAVIOUR-SPEC §1.
 */

import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { createRegistryHarness, scriptedSessionBackend, userText } from './fixtures.js';

const scope = () =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime'
    });

const DOCUMENTED_ORDER = [
    'x-opencode-session',
    'x-session-id',
    'x-thread-id',
    'x-conversation-id',
    'x-deepseek-harness-session-id',
    'session-id',
    'session_id',
    'thread-id',
    'thread_id',
    'conversation-id',
    'conversation_id'
];

const makeRegistry = (config = {}) =>
    createRegistryHarness({
        sessionBackend: scriptedSessionBackend([[]]),
        config
    }).registry;

describe('documented header order', () => {
    test('every documented spelling is accepted', async () => {
        for (const name of DOCUMENTED_ORDER) {
            const registry = makeRegistry();
            const turn = await registry.resolveTurn({
                headers: { [name]: `value-for-${name}` },
                scope: scope(),
                deliverable: [userText('Q1')]
            });
            expect(turn.identity.source).toBe('header');
            expect(turn.identity.header).toBe(name);
            expect(turn.key).toEqual(expect.any(String));
            turn.release();
        }
    });

    test('the first non-empty header in the documented order wins', async () => {
        for (let index = 0; index < DOCUMENTED_ORDER.length; index += 1) {
            const headers = {};
            for (const name of DOCUMENTED_ORDER) headers[name] = `value-for-${name}`;
            // blank out every header before the one under test
            for (const name of DOCUMENTED_ORDER.slice(0, index)) headers[name] = '   ';
            const turn = await makeRegistry().resolveTurn({
                headers,
                scope: scope(),
                deliverable: [userText('Q1')]
            });
            expect(turn.identity.header).toBe(DOCUMENTED_ORDER[index]);
            turn.release();
        }
    });

    test('a client-supplied session-id cannot displace x-opencode-session', async () => {
        const registry = makeRegistry();
        const both = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'operator-value', 'session-id': 'client-value' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        const operatorOnly = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'operator-value' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        const clientOnly = await registry.resolveTurn({
            headers: { 'session-id': 'client-value' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });

        expect(both.identity.header).toBe('x-opencode-session');
        expect(both.key).toBe(operatorOnly.key);
        expect(both.key).not.toBe(clientOnly.key);
        both.release();
        operatorOnly.release();
        clientOnly.release();
    });

    test('the value is trimmed, so padded and bare spellings share one conversation', async () => {
        const registry = makeRegistry();
        const padded = await registry.resolveTurn({
            headers: { 'x-opencode-session': '  conv-x  ' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        const bare = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'conv-x' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        expect(padded.identity.value).toBe('conv-x');
        expect(padded.key).toBe(bare.key);
        padded.release();
        bare.release();
    });

    test('repeated headers use their first value', async () => {
        const registry = makeRegistry();
        const repeated = await registry.resolveTurn({
            headers: { 'x-opencode-session': ['conv-first', 'conv-second'] },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        const first = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'conv-first' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        expect(repeated.identity.value).toBe('conv-first');
        expect(repeated.key).toBe(first.key);
        repeated.release();
        first.release();
    });

    test('the configured list narrows and reorders the lookup', async () => {
        const narrowed = makeRegistry({ SESSION_HEADER_NAMES: 'session-id, x-opencode-session' });
        const turn = await narrowed.resolveTurn({
            headers: { 'x-opencode-session': 'gateway', 'session-id': 'client' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        expect(turn.identity.header).toBe('session-id');
        turn.release();

        const cased = makeRegistry({ SESSION_HEADER_NAMES: 'X-Opencode-Session' });
        const casedTurn = await cased.resolveTurn({
            headers: { 'x-opencode-session': 'cased' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        expect(casedTurn.identity.header).toBe('x-opencode-session');
        casedTurn.release();
    });

    test('with reuse disabled there is no identity and no conversation key', async () => {
        const registry = makeRegistry({ SESSION_REUSE_ENABLED: false });
        const turn = await registry.resolveTurn({
            headers: { 'x-opencode-session': 'ignored' },
            scope: scope(),
            deliverable: [userText('Q1')]
        });
        expect(turn.identity.source).toBe('none');
        expect(turn.key).toBeNull();
        expect(turn.sessionId).toBeNull();
        expect(turn.plan.reuse).toBe(false);
        turn.release();
    });
});
