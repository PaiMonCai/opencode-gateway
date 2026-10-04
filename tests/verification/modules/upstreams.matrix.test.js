/**
 * Upstream routing matrix and the runtime-only learning cache.
 *
 * Reference: `docs/en/api-reference.md` "Upstream selection" (highest
 * authority), BEHAVIOUR-SPEC §5, ARCHITECTURE §2 (src/upstreams).
 *
 * The direct upstream is pointed at a local stub server bound to port 0, so the
 * routing evidence is real HTTP, not a mocked fetch.
 */

import { createConversationRegistry } from '../../../src/conversation/registry.js';
import { conversationScopeFor } from '../../../src/conversation/identity.js';
import { createDirectUpstream } from '../../../src/upstreams/direct-client.js';
import {
    RUNTIME_ONLY_TTL_MS,
    createRuntimeOnlyTracker,
    createUpstreamRouter
} from '../../../src/upstreams/router.js';
import {
    assistantText,
    createFakeClock,
    scriptedSessionBackend,
    sleep,
    startStubServer,
    userText
} from './fixtures.js';

const HEADERS = { 'x-opencode-session': 'conv-route' };

/** Every stub server started by a test, closed in `afterEach` so Jest exits. */
const openStubs = [];

afterEach(async () => {
    while (openStubs.length) {
        await openStubs.pop().close();
    }
});

/**
 * Build the real three-module stack over a stub direct upstream.
 *
 * @param {object} [options]
 * @param {(req: any, res: any, ctx: any) => unknown} [options.handler]
 * @param {object} [options.config]
 */
async function createStack({ handler = null, config = {} } = {}) {
    const clock = createFakeClock();
    const stub = await startStubServer((req, res, ctx) => {
        if (handler) {
            handler(req, res, ctx);
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stub: true, url: req.url }));
    });

    const effectiveConfig = {
        ZEN_API_KEY: 'verify-zen-key',
        DIRECT_ENABLED: true,
        DIRECT_FREE_VIA_RUNTIME: true,
        DIRECT_FALLBACK_TO_RUNTIME: true,
        DIRECT_GO_BASE_URL: `${stub.url}/zen/go/v1`,
        DIRECT_ZEN_BASE_URL: `${stub.url}/zen/v1`,
        REQUEST_TIMEOUT_MS: 2_000,
        SESSION_TTL_MS: 600_000,
        ...config
    };

    const direct = createDirectUpstream({ config: effectiveConfig, fetch: globalThis.fetch });
    const registry = createConversationRegistry({
        config: effectiveConfig,
        clock,
        sessionBackend: scriptedSessionBackend([[]]),
        deleteSession: async () => {},
        lockTimeoutMs: 60
    });
    const tracker = createRuntimeOnlyTracker({ ttlMs: RUNTIME_ONLY_TTL_MS, clock: () => clock.now() });
    const router = createUpstreamRouter({
        config: effectiveConfig,
        direct,
        runtime: { marker: 'runtime-client' },
        registry,
        tracker
    });

    openStubs.push(stub);
    return { clock, stub, direct, registry, tracker, router, config: effectiveConfig };
}

/** The scope the HTTP edge would build, using the router's own decision. */
const scopeUsingRouter = (router, providerID, modelID) =>
    conversationScopeFor({
        providerID,
        modelID,
        toolMode: 'none',
        toolFingerprint: '-',
        mode: router.shouldUseDirect(providerID, modelID).direct ? 'direct' : 'runtime'
    });

describe('upstream routing matrix (api-reference "Upstream selection")', () => {
    const cases = [
        ['opencode-go', 'glm-5', 'direct', 'direct'],
        ['opencode', 'big-pickle', 'direct', 'direct'],
        ['opencode', 'mystery-free', 'runtime', 'free-tier-model'],
        ['opencode', 'MYSTERY-FREE', 'runtime', 'free-tier-model'],
        ['anthropic', 'claude-sonnet', 'runtime', 'provider-not-direct']
    ];

    test.each(cases)('%s/%s -> %s (%s)', async (providerID, modelID, expectedMode, expectedReason) => {
        const { router, stub } = await createStack();
        const result = await router.plan({
            providerID,
            modelID,
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope: scopeUsingRouter(router, providerID, modelID),
            toolMode: 'none',
            toolsFingerprint: '-'
        });

        expect(result.mode).toBe(expectedMode);
        expect(result.reason).toBe(expectedReason);
        expect(result.busy).toBe(false);
        result.turn.release();
        if (expectedMode === 'runtime') expect(stub.requests).toHaveLength(0);
    });

    test('no upstream key sends everything to the runtime', async () => {
        const { router, stub } = await createStack({ config: { ZEN_API_KEY: '' } });
        const result = await router.plan({
            providerID: 'opencode-go',
            modelID: 'glm-5',
            headers: HEADERS,
            deliverable: [userText('Q1')]
        });
        expect(result.mode).toBe('runtime');
        expect(result.reason).toBe('no-upstream-key');
        expect(result.sessionId).toBeNull();
        expect(stub.requests).toHaveLength(0);
        result.turn.release();
    });

    test('DIRECT_ENABLED=false disables the direct path entirely', async () => {
        const { router, stub } = await createStack({ config: { DIRECT_ENABLED: false } });
        const result = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: HEADERS,
            deliverable: [userText('Q1')]
        });
        expect(result.mode).toBe('runtime');
        expect(result.reason).toBe('direct-disabled');
        expect(stub.requests).toHaveLength(0);
        result.turn.release();
    });

    test('DIRECT_FREE_VIA_RUNTIME=false lets a -free model go direct', async () => {
        const { router } = await createStack({ config: { DIRECT_FREE_VIA_RUNTIME: false } });
        const result = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-free',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope: scopeUsingRouter(router, 'opencode', 'mystery-free')
        });
        expect(result.mode).toBe('direct');
        result.turn.release();
    });

    test('fallback availability follows DIRECT_FALLBACK_TO_RUNTIME', async () => {
        const allowed = await createStack();
        expect(allowed.router.allowsFallback()).toBe(true);
        const denied = await createStack({ config: { DIRECT_FALLBACK_TO_RUNTIME: 'false' } });
        expect(denied.router.allowsFallback()).toBe(false);
    });
});

describe('direct turns on the wire', () => {
    test('the base URL follows the provider and the bare model id is sent upstream', async () => {
        const { router, direct, stub } = await createStack();

        const goTurn = await router.plan({
            providerID: 'opencode-go',
            modelID: 'glm-5',
            headers: HEADERS,
            deliverable: [userText('Q1')]
        });
        await (
            await direct.chatCompletion({
                providerID: 'opencode-go',
                modelID: 'glm-5',
                body: { messages: [userText('Q1')] },
                stream: false,
                sessionId: goTurn.sessionId
            })
        ).text();
        expect(stub.requests.at(-1).url).toBe('/zen/go/v1/chat/completions');
        expect(JSON.parse(stub.requests.at(-1).body).model).toBe('glm-5');
        goTurn.turn.release();

        const zenTurn = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: HEADERS,
            deliverable: [userText('Q1')]
        });
        await (
            await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: { messages: [userText('Q1')] },
                stream: false,
                sessionId: zenTurn.sessionId
            })
        ).text();
        expect(stub.requests.at(-1).url).toBe('/zen/v1/chat/completions');
        expect(JSON.parse(stub.requests.at(-1).body).model).toBe('big-pickle');
        zenTurn.turn.release();
    });

    test('invariant 1 on the wire: every turn of one conversation carries the same x-opencode-session', async () => {
        const { router, direct, registry, stub } = await createStack();
        const scope = scopeUsingRouter(router, 'opencode', 'big-pickle');

        const first = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope
        });
        expect(first.mode).toBe('direct');
        expect(first.sessionId).toMatch(/^ses_[0-9a-f]{24}$/);

        const firstResponse = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'big-pickle',
            body: { messages: [userText('Q1')] },
            stream: false,
            sessionId: first.sessionId
        });
        await firstResponse.text();
        expect(stub.requests.at(-1).headers['x-opencode-session']).toBe(first.sessionId);
        first.turn.release();
        registry.storeTurn({
            key: first.turn.key,
            sessionId: first.sessionId,
            mode: 'direct',
            plan: first.turn.plan,
            replyText: 'A1'
        });

        const second = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: HEADERS,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')],
            scope
        });
        expect(second.mode).toBe('direct');
        expect(second.sessionId).toBe(first.sessionId);

        const secondResponse = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'big-pickle',
            body: { messages: [userText('Q2')] },
            stream: false,
            sessionId: second.sessionId
        });
        await secondResponse.text();
        expect(stub.requests.at(-1).headers['x-opencode-session']).toBe(first.sessionId);
        expect(stub.requests.at(-1).headers['x-opencode-request']).toMatch(/^msg_[0-9a-f]+$/);
        second.turn.release();
    });

    test('a busy conversation is reported instead of a usable turn', async () => {
        const { router, registry } = await createStack();
        const scope = scopeUsingRouter(router, 'opencode', 'mystery-free');

        const holder = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1')]
        });
        expect(holder.busy).toBe(false);

        const busy = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-free',
            headers: HEADERS,
            deliverable: [userText('Q1'), userText('Q2')],
            scope
        });
        expect(busy.busy).toBe(true);
        expect(busy.turn.busy).toBe(true);
        expect(busy.sessionId).toBeNull();
        expect(() => busy.turn.release()).not.toThrow();

        holder.release();
    });
});

describe('free-tier learning (403 FreeTierError -> runtime-only)', () => {
    const freeTierHandler = (req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: 'refused' } }));
    };

    test('the refusal is learned, the model then routes to the runtime, and the learning expires', async () => {
        const { router, clock, direct } = await createStack({ handler: freeTierHandler });
        const scope = scopeUsingRouter(router, 'opencode', 'mystery-model');

        const planned = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-model',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope
        });
        expect(planned.mode).toBe('direct');

        const response = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'mystery-model',
            body: { messages: [userText('Q1')] },
            stream: false,
            sessionId: planned.sessionId
        });
        expect(response.status).toBe(403);
        const bodyText = await response.text();
        expect(direct.classify(response, bodyText)).toBe('free-tier');

        router.fallback(planned.turn, 'free-tier');
        planned.turn.release();
        await sleep(0); // let the fire-and-forget discard settle

        expect(router.isRuntimeOnly('opencode', 'mystery-model')).toBe(true);
        const learned = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-model',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope: scopeUsingRouter(router, 'opencode', 'mystery-model')
        });
        expect(learned.mode).toBe('runtime');
        expect(learned.reason).toBe('free-tier-learned');
        learned.turn.release();

        // TTL boundary (docs: one hour of memory for the learned model).
        clock.advance(RUNTIME_ONLY_TTL_MS - 1);
        expect(router.isRuntimeOnly('opencode', 'mystery-model')).toBe(true);

        clock.advance(1);
        expect(router.isRuntimeOnly('opencode', 'mystery-model')).toBe(false);
        const expired = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-model',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope: scopeUsingRouter(router, 'opencode', 'mystery-model')
        });
        expect(expired.mode).toBe('direct');
        expired.turn.release();
    });

    test('a transport failure falls back without learning, but drops the direct conversation state', async () => {
        const { router, registry } = await createStack();
        const scope = scopeUsingRouter(router, 'opencode', 'paid-model');

        const planned = await router.plan({
            providerID: 'opencode',
            modelID: 'paid-model',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope
        });
        registry.storeTurn({
            key: planned.turn.key,
            sessionId: planned.sessionId,
            mode: 'direct',
            plan: planned.turn.plan,
            replyText: 'A1'
        });
        planned.turn.release();

        router.fallback(planned.turn, 'transport');
        await sleep(0);

        expect(router.isRuntimeOnly('opencode', 'paid-model')).toBe(false);
        const next = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(next.entry).toBeNull();
        expect(next.sessionId).toBeNull();
        next.release();
    });

    test('falling back from a runtime turn keeps the conversation state', async () => {
        const { router, registry } = await createStack();
        const scope = scopeUsingRouter(router, 'opencode', 'mystery-free');

        const planned = await router.plan({
            providerID: 'opencode',
            modelID: 'mystery-free',
            headers: HEADERS,
            deliverable: [userText('Q1')],
            scope
        });
        expect(planned.mode).toBe('runtime');
        registry.storeTurn({
            key: planned.turn.key,
            sessionId: 'ses-runtime-kept',
            mode: 'runtime',
            plan: planned.turn.plan,
            replyText: 'A1'
        });
        planned.turn.release();

        router.fallback(planned.turn, 'auth');
        await sleep(0);

        const next = await registry.resolveTurn({
            headers: HEADERS,
            scope,
            deliverable: [userText('Q1'), assistantText('A1'), userText('Q2')]
        });
        expect(next.sessionId).toBe('ses-runtime-kept');
        next.release();
    });
});
