/**
 * Direct model catalog (`GET /v1/models` fallback).
 *
 * Reference: `docs/en/api-reference.md` ("falls back to the public upstream
 * catalogs when the runtime is unavailable") and the direct-client contract
 * ("a failed or empty refresh keeps the last good list ... `getModels()` never
 * throws").
 *
 * The catalog is driven against a local stub whose availability can be toggled,
 * so the "keeps the last result" claim is exercised over real HTTP.
 */

import { createModelCatalog } from '../../../src/upstreams/direct-client.js';
import { startStubServer } from './fixtures.js';

const openStubs = [];

afterEach(async () => {
    while (openStubs.length) {
        await openStubs.pop().close();
    }
});

/** Mutable stub catalog state. */
function createCatalogStub() {
    const state = { go: 'ok', zen: 'ok', goModels: ['go-a', 'go-b'], zenModels: ['zen-a'], requests: 0 };
    let server = null;

    const handler = (req, res, ctx) => {
        state.requests += 1;
        const isGo = req.url.startsWith('/zen/go');
        const health = isGo ? state.go : state.zen;
        const models = isGo ? state.goModels : state.zenModels;
        if (health === 'fail') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'catalog down' }));
            return;
        }
        if (health === 'hang') {
            // never respond: connection-level failure for the client
            req.socket.destroy();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                data: models.map((id) => ({ id, name: id.toUpperCase(), created: 1_700_000_000 }))
            })
        );
        void ctx;
    };

    return {
        state,
        async start() {
            server = await startStubServer(handler);
            openStubs.push(server);
            return server;
        }
    };
}

/**
 * One catalog instance per test (the cache lives in the instance), returned as
 * a `getModels()` accessor.
 */
const catalogFor = (server, ttlMs = 60_000) => {
    const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, ttlMs, logger: null });
    return () =>
        catalog.getModels({
            apiKey: 'verify-key',
            goBaseUrl: `${server.url}/zen/go/v1`,
            zenBaseUrl: `${server.url}/zen/v1`
        });
};

describe('createModelCatalog', () => {
    test('merges both provider catalogs with the provider ids', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server);
        const models = await getModels();

        expect(models.map((model) => model.id)).toEqual([
            'opencode-go/go-a',
            'opencode-go/go-b',
            'opencode/zen-a'
        ]);
        expect(models.every((model) => model.object === 'model')).toBe(true);
        expect(models.map((model) => model.owned_by)).toEqual(['opencode-go', 'opencode-go', 'opencode']);
        expect(models[0].created).toBe(1_700_000_000);
    });

    test('serves the cached list inside the TTL without refetching', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server);
        const first = await getModels();
        const requestsAfterFirst = fixture.state.requests;
        const second = await getModels();

        expect(second).toEqual(first);
        expect(fixture.state.requests).toBe(requestsAfterFirst);
    });

    test('ttlMs=0 refetches every time', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        await getModels();
        const requestsAfterFirst = fixture.state.requests;
        await getModels();
        expect(fixture.state.requests).toBeGreaterThan(requestsAfterFirst);
    });

    test('a failed refresh keeps the last good list', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        const good = await getModels();
        fixture.state.go = 'fail';
        fixture.state.zen = 'fail';
        const afterFailure = await getModels();

        expect(afterFailure).toEqual(good);
        expect(fixture.state.requests).toBeGreaterThan(2);
    });

    test('an unreachable endpoint keeps the last good list too, and never throws', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        const good = await getModels();
        fixture.state.go = 'hang';
        fixture.state.zen = 'fail';

        await expect(getModels()).resolves.toEqual(good);
    });

    test('with no good list yet a total failure resolves to an empty list, then recovers', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        fixture.state.go = 'fail';
        fixture.state.zen = 'fail';
        await expect(getModels()).resolves.toEqual([]);

        fixture.state.go = 'ok';
        fixture.state.zen = 'ok';
        const recovered = await getModels();
        expect(recovered).toHaveLength(3);
    });

    test('[FINDING-3 fixed] a failing provider keeps its own last good models', async () => {
        // Defect fixed (T3): each provider keeps its own last good list, so a
        // transient Go-endpoint outage no longer removes the models the zen
        // catalog still serves.
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        const complete = await getModels();
        expect(complete.map((model) => model.id)).toEqual([
            'opencode-go/go-a',
            'opencode-go/go-b',
            'opencode/zen-a'
        ]);

        fixture.state.go = 'fail';
        const degraded = await getModels();

        expect(degraded.map((model) => model.id)).toEqual([
            'opencode-go/go-a',
            'opencode-go/go-b',
            'opencode/zen-a'
        ]);
    });

    test('[FINDING-3 fixed] the healthy provider still refreshes when the other one fails', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();

        const getModels = catalogFor(server, 0);
        await getModels();

        fixture.state.go = 'fail';
        fixture.state.zenModels = ['zen-a', 'zen-b'];
        const degraded = await getModels();

        expect(degraded.map((model) => model.id)).toEqual([
            'opencode-go/go-a',
            'opencode-go/go-b',
            'opencode/zen-a',
            'opencode/zen-b'
        ]);
    });

    test('invalidate() forces the next call to refetch', async () => {
        const fixture = createCatalogStub();
        const server = await fixture.start();
        const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, ttlMs: 60_000, logger: null });
        const options = {
            apiKey: 'k',
            goBaseUrl: `${server.url}/zen/go/v1`,
            zenBaseUrl: `${server.url}/zen/v1`
        };

        await catalog.getModels(options);
        const afterFirst = fixture.state.requests;
        await catalog.getModels(options);
        expect(fixture.state.requests).toBe(afterFirst);

        catalog.invalidate();
        await catalog.getModels(options);
        expect(fixture.state.requests).toBeGreaterThan(afterFirst);
    });
});
