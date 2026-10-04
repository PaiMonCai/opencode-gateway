import {
    FALLBACK_REASON,
    PLAN_REASON,
    createRuntimeOnlyTracker,
    createUpstreamRouter,
    isFreeTierModelId
} from '../../../src/upstreams/router.js';

/**
 * Upstream router: which upstream a model goes to, and what happens when the
 * direct one refuses. The registry and both upstreams are fakes; only routing
 * decisions and the free-tier learning are asserted.
 */
const fakeDirect = (overrides = {}) => ({
    hasCredentials: () => true,
    supports: (providerID) => providerID === 'opencode' || providerID === 'opencode-go',
    ...overrides
});

const fakeRuntime = () => ({ ensureReady: async () => true });

/**
 * Registry stub that records how it was called.
 *
 * Mirrors the real registry's shape: `resolveTurn` is async, returns the
 * session it decided to reuse and may report `busy` when the turn lock could
 * not be taken. A `previousSessionId` pins the turn to that session and forces
 * a baseline snapshot, exactly like the real registry — which is how the direct
 * path is caught if the router forwards the id.
 *
 * @param {object|null} [entry] Conversation entry to return.
 * @param {{busy?: boolean}} [options] Overrides.
 * @returns {{registry: object, calls: object[], discards: object[]}} Handle.
 */
const fakeRegistry = (entry = null, { busy = false } = {}) => {
    const calls = [];
    const discards = [];
    return {
        calls,
        discards,
        registry: {
            async resolveTurn(args) {
                calls.push(args);
                const pinned = Boolean(args.previousSessionId);
                return {
                    key: 'conv-1',
                    entry,
                    plan: pinned ? { pinned: true } : {},
                    sessionId: pinned ? args.previousSessionId : entry?.sessionId || null,
                    // A pinned turn has no entry, so the registry can only snapshot
                    // the runtime session state for the id.
                    baseline: pinned ? { ok: false, messageIds: new Set(), partIds: new Set() } : null,
                    busy,
                    release: () => {}
                };
            },
            async discard(args) {
                discards.push(args);
            }
        }
    };
};

/**
 * Build a router over fakes.
 *
 * @param {object} [options] Overrides.
 * @returns {object} Router plus fakes.
 */
const setup = ({
    config = { ZEN_API_KEY: 'key' },
    entry = null,
    direct = fakeDirect(),
    tracker,
    busy = false
} = {}) => {
    const { registry, calls, discards } = fakeRegistry(entry, { busy });
    const router = createUpstreamRouter({
        config,
        direct,
        runtime: fakeRuntime(),
        registry,
        ...(tracker ? { tracker } : {})
    });
    return { router, calls, discards };
};

describe('isFreeTierModelId', () => {
    test('matches the -free suffix case-insensitively', async () => {
        expect(isFreeTierModelId('big-pickle-free')).toBe(true);
        expect(isFreeTierModelId('Kimi-K2.5-FREE')).toBe(true);
        expect(isFreeTierModelId('big-pickle')).toBe(false);
        expect(isFreeTierModelId(undefined)).toBe(false);
    });
});

describe('routing rules', () => {
    test('opencode-go goes direct and reuses the conversation session id', async () => {
        const { router } = setup({ entry: { sessionId: 'ses_reused', mode: 'direct' } });

        const plan = await router.plan({ providerID: 'opencode-go', modelID: 'kimi-k3' });

        expect(plan.mode).toBe('direct');
        expect(plan.reason).toBe(PLAN_REASON.DIRECT);
        expect(plan.sessionId).toBe('ses_reused');
    });

    test('paid opencode goes direct and mints a conversation id when there is none', async () => {
        const { router } = setup();

        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        expect(plan.mode).toBe('direct');
        expect(plan.sessionId).toMatch(/^ses_[0-9a-f]{24}$/);
    });

    test('an *-free model stays on the runtime', async () => {
        const { router } = setup();

        const plan = await router.plan({ providerID: 'opencode', modelID: 'kimi-k2.5-free' });

        expect(plan.mode).toBe('runtime');
        expect(plan.reason).toBe(PLAN_REASON.FREE_TIER_MODEL);
        expect(plan.sessionId).toBeNull();
    });

    test('a missing upstream key sends everything to the runtime', async () => {
        const { router } = setup({ config: {}, direct: fakeDirect({ hasCredentials: () => false }) });

        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        expect(plan.mode).toBe('runtime');
        expect(plan.reason).toBe(PLAN_REASON.NO_UPSTREAM_KEY);
    });

    test('DIRECT_ENABLED=false disables the direct upstream', async () => {
        const { router } = setup({ config: { ZEN_API_KEY: 'key', DIRECT_ENABLED: false } });

        expect(await router.plan({ providerID: 'opencode', modelID: 'big-pickle' })).toMatchObject({
            mode: 'runtime',
            reason: PLAN_REASON.DIRECT_DISABLED
        });
    });

    test('providers without a direct endpoint go to the runtime', async () => {
        const { router } = setup();

        expect(await router.plan({ providerID: 'anthropic', modelID: 'claude' })).toMatchObject({
            mode: 'runtime',
            reason: PLAN_REASON.PROVIDER_NOT_DIRECT
        });
    });

    test('DIRECT_FREE_VIA_RUNTIME=false allows a -free model to go direct', async () => {
        const { router } = setup({ config: { ZEN_API_KEY: 'key', DIRECT_FREE_VIA_RUNTIME: false } });

        expect((await router.plan({ providerID: 'opencode', modelID: 'kimi-k2.5-free' })).mode).toBe(
            'direct'
        );
    });

    test('passes the conversation descriptor through to the registry', async () => {
        const { router, calls } = setup();
        const deliverable = { messages: [] };

        await router.plan({
            // A runtime model: `previousSessionId` is a runtime pin, so it must
            // reach the registry on this path.
            providerID: 'opencode',
            modelID: 'kimi-k2.5-free',
            headers: { 'session-id': 'c1' },
            deliverable,
            toolMode: 'external-bridge',
            toolsFingerprint: 'fp',
            scope: { ip: '1.2.3.4' },
            previousSessionId: 'ses_prev',
            clientAddress: '127.0.0.1'
        });

        expect(calls).toEqual([
            {
                headers: { 'session-id': 'c1' },
                scope: { ip: '1.2.3.4' },
                deliverable,
                previousSessionId: 'ses_prev',
                clientAddress: '127.0.0.1',
                toolMode: 'external-bridge',
                toolsFingerprint: 'fp'
            }
        ]);
    });

    test('a direct turn never pins the previous response id or reads session state', async () => {
        const { router, calls } = setup();

        const plan = await router.plan({
            providerID: 'opencode',
            modelID: 'big-pickle',
            headers: { 'session-id': 'c1' },
            deliverable: { messages: [] },
            previousSessionId: 'resp_abc123'
        });

        // The id belongs to the direct upstream and is relayed as-is by the
        // assembly layer; pinning it here would force a baseline read the direct
        // path does not have and fail the turn before the upstream is called.
        expect(plan.mode).toBe('direct');
        expect(calls[0].previousSessionId).toBeUndefined();
        expect(plan.turn.plan.pinned).toBeUndefined();
        expect(plan.turn.baseline).toBeNull();
        expect(plan.sessionId).toMatch(/^ses_[0-9a-f]{24}$/);
        expect(plan.sessionId).not.toBe('resp_abc123');
    });

    test('a runtime turn still pins the previous response id', async () => {
        const { router, calls } = setup();

        const plan = await router.plan({
            providerID: 'opencode',
            modelID: 'kimi-k2.5-free',
            headers: { 'session-id': 'c1' },
            deliverable: { messages: [] },
            previousSessionId: 'ses_prev'
        });

        expect(plan.mode).toBe('runtime');
        expect(calls[0].previousSessionId).toBe('ses_prev');
        expect(plan.turn.plan.pinned).toBe(true);
        expect(plan.sessionId).toBe('ses_prev');
    });

    test('reports a busy conversation instead of a usable turn', async () => {
        const { router } = setup({ busy: true });

        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        expect(plan.busy).toBe(true);
        expect(plan.turn.busy).toBe(true);
    });

    test('a runtime turn reuses the registry-decided session', async () => {
        const { router } = setup({ entry: { sessionId: 'ses_runtime', mode: 'runtime' } });

        const plan = await router.plan({ providerID: 'opencode', modelID: 'kimi-k2.5-free' });

        expect(plan.mode).toBe('runtime');
        expect(plan.sessionId).toBe('ses_runtime');
    });

    test('annotates the turn with mode and model for fallback', async () => {
        const { router } = setup();

        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        expect(plan.turn.mode).toBe('direct');
        expect(plan.turn.providerID).toBe('opencode');
        expect(plan.turn.modelID).toBe('big-pickle');
    });

    test('requires a registry with resolveTurn', async () => {
        expect(() =>
            createUpstreamRouter({ config: {}, direct: fakeDirect(), runtime: fakeRuntime(), registry: {} })
        ).toThrow('requires a conversation registry');
    });

    test('reports whether direct mode and fallback are available', async () => {
        expect(setup().router.allowsFallback()).toBe(true);
        expect(
            setup({
                config: { ZEN_API_KEY: 'key', DIRECT_FALLBACK_TO_RUNTIME: false }
            }).router.allowsFallback()
        ).toBe(false);
        // The direct client owns credential detection; the router just asks it.
        expect(setup().router.isDirectEnabled()).toBe(true);
        expect(setup({ direct: fakeDirect({ hasCredentials: () => false }) }).router.isDirectEnabled()).toBe(
            false
        );
    });
});

describe('fallback and free-tier learning', () => {
    test('a free-tier refusal makes the model runtime-only and drops direct state', async () => {
        const { router, discards } = setup();
        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });
        expect(plan.mode).toBe('direct');

        router.fallback(plan.turn, FALLBACK_REASON.FREE_TIER);

        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(true);
        expect(discards).toEqual([{ key: 'conv-1' }]);

        const next = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });
        expect(next.mode).toBe('runtime');
        expect(next.reason).toBe(PLAN_REASON.FREE_TIER_LEARNED);
    });

    test('accepts the classifier reason returned by the direct upstream', async () => {
        const { router } = setup();
        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        router.fallback(plan.turn, 'free-tier');

        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(true);
    });

    test('a transport failure falls back without learning the model', async () => {
        const { router, discards } = setup();
        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        router.fallback(plan.turn, FALLBACK_REASON.TRANSPORT);

        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(false);
        expect(discards).toEqual([{ key: 'conv-1' }]);
        expect((await router.plan({ providerID: 'opencode', modelID: 'big-pickle' })).mode).toBe('direct');
    });

    test('an auth failure is not treated as free-tier', async () => {
        const { router } = setup();
        const plan = await router.plan({ providerID: 'opencode', modelID: 'big-pickle' });

        router.fallback(plan.turn, FALLBACK_REASON.AUTH);

        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(false);
    });

    test('a runtime turn is not discarded on fallback', async () => {
        const { router, discards } = setup();
        const plan = await router.plan({ providerID: 'opencode', modelID: 'kimi-k2.5-free' });
        plan.turn.mode = 'runtime';

        router.fallback(plan.turn, FALLBACK_REASON.TRANSPORT);

        expect(discards).toEqual([]);
    });

    test('the tracker expires a learned model after its TTL', async () => {
        let clock = 0;
        const tracker = createRuntimeOnlyTracker({ ttlMs: 1000, clock: () => clock });
        const { router } = setup({ tracker });

        router.rememberRuntimeOnly('opencode', 'big-pickle');
        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(true);

        clock = 1001;
        expect(router.isRuntimeOnly('opencode', 'big-pickle')).toBe(false);
    });

    test('learning is per model', async () => {
        const { router } = setup();

        router.rememberRuntimeOnly('opencode', 'big-pickle');

        expect(router.isRuntimeOnly('opencode', 'other')).toBe(false);
        expect(router.isRuntimeOnly('opencode-go', 'big-pickle')).toBe(false);
    });
});
