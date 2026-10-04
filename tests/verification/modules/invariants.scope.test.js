/**
 * The scope half of the conversation contract: the model, the tool policy and
 * the upstream mode all take part in the conversation key, so the same identity
 * header cannot make a direct session and a runtime session look like one
 * conversation.
 *
 * Reference: ARCHITECTURE §2 (`conversationScopeFor`) and identity.js.
 */

import { conversationKeyFor, conversationScopeFor } from '../../../src/conversation/identity.js';
import { assistantText, createRegistryHarness, scriptedSessionBackend, userText } from './fixtures.js';

const HEADERS = { 'x-opencode-session': 'one-identity' };

const scopeFor = (overrides = {}) =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode: 'runtime',
        ...overrides
    });

describe('conversationScopeFor', () => {
    test('the upstream mode is part of the scope', () => {
        expect(scopeFor({ mode: 'direct' })).not.toBe(scopeFor({ mode: 'runtime' }));
        expect(scopeFor({ mode: 'runtime' })).toBe(scopeFor({ mode: 'runtime' }));
    });

    test('model, tool mode and tool fingerprint are part of the scope', () => {
        expect(scopeFor({ modelID: 'other' })).not.toBe(scopeFor());
        expect(scopeFor({ toolMode: 'external_bridge' })).not.toBe(scopeFor());
        expect(scopeFor({ toolFingerprint: 'abc123' })).not.toBe(scopeFor());
    });

    test('identical inputs produce an identical scope, whatever the field order', () => {
        const a = conversationScopeFor({
            providerID: 'opencode',
            modelID: 'm',
            toolMode: 'none',
            toolFingerprint: '-',
            mode: 'runtime'
        });
        const b = conversationScopeFor({
            mode: 'runtime',
            toolFingerprint: '-',
            toolMode: 'none',
            modelID: 'm',
            providerID: 'opencode'
        });
        expect(a).toBe(b);
    });
});

describe('conversationKeyFor', () => {
    const identity = {
        source: 'header',
        header: 'x-opencode-session',
        value: 'one-identity',
        preview: 'one-identity',
        startKey: null,
        entryKey: null
    };

    test('the scope takes part in the key', () => {
        expect(conversationKeyFor(identity, scopeFor({ mode: 'direct' }))).not.toBe(
            conversationKeyFor(identity, scopeFor({ mode: 'runtime' }))
        );
    });

    test('the header name takes part in the key (session-id is not x-session-id)', () => {
        const other = { ...identity, header: 'session-id' };
        expect(conversationKeyFor(identity, scopeFor())).not.toBe(conversationKeyFor(other, scopeFor()));
    });

    test('derived and anonymous identities have no key', () => {
        expect(conversationKeyFor({ ...identity, source: 'derived' }, scopeFor())).toBeNull();
        expect(conversationKeyFor({ source: 'none', header: null, value: null }, scopeFor())).toBeNull();
        expect(conversationKeyFor(null, scopeFor())).toBeNull();
    });
});

describe('scope isolation through the registry', () => {
    test('the same header value in direct and runtime modes owns two sessions', async () => {
        const { registry } = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 600_000 }
        });

        const runtimeTurn = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ mode: 'runtime' }),
            deliverable: [userText('Q1')]
        });
        runtimeTurn.release();
        registry.storeTurn({
            key: runtimeTurn.key,
            sessionId: 'ses-runtime',
            mode: 'runtime',
            plan: runtimeTurn.plan,
            replyText: 'A1'
        });

        const directTurn = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ mode: 'direct' }),
            deliverable: [userText('Q1')]
        });
        expect(directTurn.key).not.toBe(runtimeTurn.key);
        expect(directTurn.entry).toBeNull();
        expect(directTurn.sessionId).toBeNull();
        directTurn.release();
        registry.storeTurn({
            key: directTurn.key,
            sessionId: 'ses_direct',
            mode: 'direct',
            plan: directTurn.plan,
            replyText: 'A1'
        });

        const runtimeAgain = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ mode: 'runtime' }),
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(runtimeAgain.sessionId).toBe('ses-runtime');

        const directAgain = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ mode: 'direct' }),
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(directAgain.sessionId).toBe('ses_direct');

        runtimeAgain.release();
        directAgain.release();
    });

    test('a tool-policy change starts a new conversation for the same identity', async () => {
        const { registry } = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 600_000 }
        });

        const seed = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ toolMode: 'none' }),
            deliverable: [userText('Q1')]
        });
        seed.release();
        registry.storeTurn({
            key: seed.key,
            sessionId: 'ses-no-tools',
            mode: 'runtime',
            plan: seed.plan,
            replyText: 'A1'
        });

        const withTools = await registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor({ toolMode: 'external_bridge' }),
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(withTools.key).not.toBe(seed.key);
        expect(withTools.entry).toBeNull();
        expect(withTools.sessionId).toBeNull();
        withTools.release();
    });
});
