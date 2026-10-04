import { createModelCatalog } from '../../../src/upstreams/direct-client.js';
import { startStub } from './helpers.js';

/**
 * Direct `/models` catalog: both providers are merged, the result is cached for
 * ten minutes, and a failed refresh keeps the last good list so a runtime-less
 * deployment keeps publishing models through a temporary upstream outage.
 */
describe('createModelCatalog', () => {
    const catalogBody = (ids) =>
        JSON.stringify({
            data: ids.map((id) => ({ id, name: `Name ${id}`, created: 1704067200 }))
        });

    /**
     * Stub both `/models` endpoints.
     *
     * @param {{go?: () => [number, string], zen?: () => [number, string]}} script Response script.
     * @returns {Promise<{stub: object, catalog: object}>} Stub and catalog.
     */
    const setup = async (script) => {
        const stub = await startStub((req, res) => {
            const [status, body] = (req.url.startsWith('/go/') ? script.go : script.zen)();
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(body);
        });
        const catalog = createModelCatalog({
            fetchImpl: globalThis.fetch,
            ttlMs: 1000,
            logger: () => {}
        });
        return { stub, catalog };
    };

    const options = (stub) => ({
        apiKey: 'key',
        goBaseUrl: `${stub.baseUrl}/go`,
        zenBaseUrl: `${stub.baseUrl}/zen`
    });

    test('merges both provider catalogs with their provider ids', async () => {
        const { stub, catalog } = await setup({
            go: () => [200, catalogBody(['kimi-k3'])],
            zen: () => [200, catalogBody(['big-pickle'])]
        });
        try {
            const models = await catalog.getModels(options(stub));

            expect(models.map((m) => m.id)).toEqual(['opencode-go/kimi-k3', 'opencode/big-pickle']);
            expect(models[0].owned_by).toBe('opencode-go');
            expect(models[1].owned_by).toBe('opencode');
            expect(models[1].object).toBe('model');
            expect(stub.requests).toHaveLength(2);
            expect(stub.requests.map((r) => r.url).sort()).toEqual(['/go/models', '/zen/models']);
            expect(stub.requests[0].headers.authorization).toBe('Bearer key');
        } finally {
            await stub.close();
        }
    });

    test('serves the cached list without refetching inside the TTL', async () => {
        const { stub, catalog } = await setup({
            go: () => [200, catalogBody(['kimi-k3'])],
            zen: () => [200, catalogBody(['big-pickle'])]
        });
        try {
            await catalog.getModels(options(stub));
            await catalog.getModels(options(stub));

            expect(stub.requests).toHaveLength(2);
        } finally {
            await stub.close();
        }
    });

    test('keeps the last good list when the refresh fails', async () => {
        let failing = false;
        const stub = await startStub((_req, res) => {
            if (failing) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{"error":"boom"}');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(catalogBody(['big-pickle']));
        });
        const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, ttlMs: 1, logger: () => {} });
        try {
            const first = await catalog.getModels(options(stub));
            expect(first.map((m) => m.id)).toEqual(['opencode-go/big-pickle', 'opencode/big-pickle']);

            failing = true;
            const afterFailure = await catalog.getModels(options(stub));

            expect(afterFailure).toEqual(first);
        } finally {
            await stub.close();
        }
    });

    test('keeps the last good list when both endpoints are unreachable', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(catalogBody(['big-pickle']));
        });
        const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, ttlMs: 1, logger: () => {} });
        let closed = false;
        try {
            const first = await catalog.getModels(options(stub));
            expect(first).toHaveLength(2);

            await stub.close();
            closed = true;
            const afterFailure = await catalog.getModels(options(stub));

            expect(afterFailure).toEqual(first);
        } finally {
            if (!closed) await stub.close();
        }
    });

    test('returns an empty list when the first fetch fails and never throws', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(500);
            res.end('nope');
        });
        const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, logger: () => {} });
        try {
            await expect(catalog.getModels(options(stub))).resolves.toEqual([]);
        } finally {
            await stub.close();
        }
    });

    test('invalidate() forces the next call to refetch', async () => {
        const { stub, catalog } = await setup({
            go: () => [200, catalogBody(['kimi-k3'])],
            zen: () => [200, catalogBody(['big-pickle'])]
        });
        try {
            await catalog.getModels(options(stub));
            catalog.invalidate();
            await catalog.getModels(options(stub));

            expect(stub.requests).toHaveLength(4);
        } finally {
            await stub.close();
        }
    });

    test('drops entries without an id', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'ok' }, { name: 'no id' }, null] }));
        });
        const catalog = createModelCatalog({ fetchImpl: globalThis.fetch, logger: () => {} });
        try {
            const models = await catalog.getModels(options(stub));

            expect(models.map((m) => m.id)).toEqual(['opencode-go/ok', 'opencode/ok']);
        } finally {
            await stub.close();
        }
    });
});
