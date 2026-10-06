/**
 * Regression coverage for turn planning under the conversation lock, the echo
 * skip, and the direct-mode `previous_response_id` path (ARCHITECTURE §2).
 *
 * Every case asserts the specified behaviour, never the absence of a past bug.
 */

import { BaselineUnavailableError, assertBaseline } from '../../../src/conversation/baseline.js';
import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { createUpstreamRouter } from '../../../src/upstreams/router.js';
import { assistantText, createRegistryHarness, scriptedSessionBackend, sleep, userText } from './fixtures.js';

const scopeFor = (mode) =>
    conversationScopeFor({
        providerID: 'opencode',
        modelID: 'verify-model',
        toolMode: 'none',
        toolFingerprint: '-',
        mode
    });

const HEADERS = { 'x-opencode-session': 'conv-probe' };

describe('a queued turn plans from the state the lock holder left', () => {
    test('a queued duplicate submit rotates instead of re-sending a turn the session already holds', async () => {
        // A queued turn re-reads the full entry after the lock, so the refreshed
        // sentCount makes the replay rotate with the full history instead of
        // re-sending a turn the session already holds (invariant 2).
        const { registry } = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            config: { SESSION_TTL_MS: 600_000 },
            lockTimeoutMs: 1_000
        });
        const scope = scopeFor('runtime');

        // Turn 1: the session holds Q1, client transcript is [Q1].
        const first = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        first.release();
        registry.storeTurn({
            key: first.key,
            sessionId: 'ses-dup',
            mode: 'runtime',
            plan: first.plan,
            replyText: 'A1'
        });

        // Turn B appends Q2 to the same session and holds the lock.
        const concurrent = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(concurrent.plan.delta).toEqual([userText('Q2')]);

        // A second request with the same payload queues behind it, capturing the
        // pre-lock snapshot (sentCount 1).
        const queuedPromise = registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        await sleep(20);

        // The holder completes: the session now holds Q1 and Q2.
        registry.storeTurn({
            key: concurrent.key,
            sessionId: 'ses-dup',
            mode: 'runtime',
            plan: concurrent.plan,
            replyText: 'A2'
        });
        concurrent.release();

        const queued = await queuedPromise;
        expect(queued.busy).toBe(false);
        expect(queued.entry.sentCount).toBe(3);
        // The client history did not move past the refreshed session state, so
        // the turn rotates rather than re-sending Q2.
        expect(queued.plan.reuse).toBe(false);
        expect(queued.plan.rewrite).toBe(true);
        expect(queued.sessionId).toBeNull();
        expect(queued.plan.delta).toEqual([userText('Q1'), assistantText('A1'), userText('Q2')]);
        queued.release();
    });
});

describe('the echo skip, with a mismatch reported at debug level', () => {
    const seedConversation = async (harness, replyText) => {
        const scope = scopeFor('runtime');
        const seed = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        seed.release();
        harness.registry.storeTurn({
            key: seed.key,
            sessionId: 'ses-probe',
            mode: 'runtime',
            plan: seed.plan,
            replyText
        });
        return scope;
    };

    test('an appended assistant message that is not the stored answer is still skipped', async () => {
        const harness = createRegistryHarness({ sessionBackend: scriptedSessionBackend([[]]) });
        const scope = await seedConversation(harness, 'THE REAL ANSWER');
        const prefilled = assistantText('A PREFILL THE MODEL NEVER PRODUCED');

        const turn = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), prefilled, userText('carry on')]
        });

        expect(turn.plan.reuse).toBe(true);
        expect(turn.plan.delta).toEqual([userText('carry on')]);
        expect(turn.plan.delta).not.toContainEqual(prefilled);
        turn.release();
    });

    test('a mismatching echo is reported at debug level, so the silent drop is observable', async () => {
        const debugCalls = [];
        const logger = {
            debug: (message, fields) => debugCalls.push({ message, fields }),
            info: () => {},
            warn: () => {},
            error: () => {}
        };
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            logger
        });
        const scope = await seedConversation(harness, 'THE REAL ANSWER');
        debugCalls.length = 0;

        const turn = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [
                userText('Q1'),
                assistantText('A PREFILL THE MODEL NEVER PRODUCED'),
                userText('carry on')
            ]
        });

        const mismatch = debugCalls.find((call) =>
            /does not match the session answer/i.test(String(call.message))
        );
        expect(mismatch).toBeTruthy();
        expect(mismatch.fields).toMatchObject({ matches: false, messageIndex: 1 });
        expect(mismatch.fields.observed).toEqual(expect.any(String));
        expect(mismatch.fields.observed).not.toBe(mismatch.fields.expected);
        turn.release();
    });

    test('a genuine echo is skipped without a mismatch report', async () => {
        const debugCalls = [];
        const logger = {
            debug: (message, fields) => debugCalls.push({ message, fields }),
            info: () => {},
            warn: () => {},
            error: () => {}
        };
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([[]]),
            logger
        });
        const scope = await seedConversation(harness, 'THE REAL ANSWER');
        debugCalls.length = 0;

        const turn = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('THE REAL ANSWER'), userText('carry on')]
        });

        expect(turn.plan.delta).toEqual([userText('carry on')]);
        expect(
            debugCalls.some((call) => /does not match the session answer/i.test(String(call.message)))
        ).toBe(false);
        turn.release();
    });
});

describe('direct mode + previous_response_id', () => {
    const directRouter = (registry) =>
        createUpstreamRouter({
            config: {
                ZEN_API_KEY: 'verify-key',
                REQUEST_TIMEOUT_MS: 2_000,
                DIRECT_FALLBACK_TO_RUNTIME: true
            },
            direct: {
                hasCredentials: () => true,
                supports: (providerID) =>
                    ['opencode', 'opencode-go'].includes(String(providerID).toLowerCase())
            },
            runtime: {},
            registry
        });

    test('a direct pinned turn never touches the runtime session state', async () => {
        // `previousSessionId` is only forwarded to the registry for runtime
        // turns: the id a direct upstream issued belongs to the upstream, and
        // ARCHITECTURE §2 says `baseline` is `null` in direct mode.
        //
        // `baseline === null` means "nothing to filter" (direct mode), while
        // `baseline.ok === false` means "filtering was required and could not be
        // done" — `assertBaseline` must only be called on the latter.
        const backend = scriptedSessionBackend([new Error('Session not found: resp_abc123')]);
        const harness = createRegistryHarness({ sessionBackend: backend });
        const router = directRouter(harness.registry);

        const result = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: HEADERS,
            deliverable: [userText('continue the topic')],
            scope: scopeFor('direct'),
            previousSessionId: 'resp_abc123'
        });

        expect(result.mode).toBe('direct');
        expect(result.busy).toBe(false);
        expect(result.turn.plan.pinned).toBe(false);
        expect(result.turn.baseline).toBeNull();
        expect(result.sessionId).toEqual(expect.any(String));
        expect(backend.calls).toEqual([]);
        result.turn.release();
    });

    test('a pinned turn whose runtime baseline cannot be read still fails closed', async () => {
        // The fail-closed guarantee must hold on the runtime path.
        const runtimeRejectsUnknownId = scriptedSessionBackend([new Error('Session not found')]);
        const harness = createRegistryHarness({ sessionBackend: runtimeRejectsUnknownId });
        const router = directRouter(harness.registry);

        const result = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-free',
            headers: HEADERS,
            deliverable: [userText('continue')],
            scope: scopeFor('runtime'),
            previousSessionId: 'ses-unknown'
        });

        expect(result.mode).toBe('runtime');
        expect(result.turn.plan.pinned).toBe(true);
        expect(result.turn.baseline.ok).toBe(false);
        expect(() => assertBaseline(result.turn.baseline)).toThrow(BaselineUnavailableError);
        result.turn.release();
    });

    test('a pinned turn with a readable runtime session proceeds with its baseline', async () => {
        const harness = createRegistryHarness({
            sessionBackend: scriptedSessionBackend([
                {
                    data: [
                        {
                            info: { id: 'm-old', role: 'assistant' },
                            parts: [{ id: 'p-old', type: 'text', text: 'earlier' }]
                        }
                    ]
                }
            ])
        });
        const turn = await harness.registry.resolveTurn({
            headers: HEADERS,
            scope: scopeFor('runtime'),
            deliverable: [userText('continue')],
            previousSessionId: 'ses-known'
        });
        expect(turn.baseline.ok).toBe(true);
        expect(turn.baseline.messageIds.has('m-old')).toBe(true);
        expect(() => assertBaseline(turn.baseline)).not.toThrow();
        turn.release();
    });
});
