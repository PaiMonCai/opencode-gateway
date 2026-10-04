import { jest } from '@jest/globals';
import net from 'node:net';
import http from 'node:http';

import { loadConfig } from '../../../src/config/load.js';
import { describeConfig } from '../../../src/config/schema.js';
import { resolveUpstreamFetch } from '../../../src/bootstrap.js';
import { createDirectUpstream } from '../../../src/upstreams/direct-client.js';
import { createUpstreamFetch } from '../../../src/upstreams/proxy-fetch.js';

/**
 * The proxy feature end to end at the level users touch it: configuration,
 * fetch selection, and a real direct-upstream call tunnelled through a real
 * SOCKS5 proxy.
 */

/**
 * Map the stand-in upstream host to the local origin (the proxy resolves it).
 *
 * @param {string} host Host name requested by the client.
 * @returns {string} Address to connect to.
 */
function resolveHost(host) {
    return host === 'upstream.internal' ? '127.0.0.1' : host;
}

/**
 * @returns {Promise<{server: net.Server, port: number, targets: string[]}>} Proxy.
 */
async function startSocksProxy() {
    const targets = [];
    const server = net.createServer((socket) => {
        let stage = 'greeting';
        let buffer = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
                if (buffer.length < 2 + buffer[1]) return;
                buffer = buffer.subarray(2 + buffer[1]);
                stage = 'request';
                socket.write(Buffer.from([0x05, 0x00]));
            }
            if (stage === 'request') {
                if (buffer.length < 5) return;
                const length = buffer[4];
                if (buffer.length < 5 + length + 2) return;
                const host = buffer.subarray(5, 5 + length).toString();
                const port = buffer.readUInt16BE(5 + length);
                targets.push(`${host}:${port}`);
                const upstream = net.connect(port, resolveHost(host), () => {
                    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    const rest = buffer.subarray(7 + length);
                    if (rest.length) upstream.write(rest);
                    buffer = Buffer.alloc(0);
                    stage = 'pipe';
                    socket.pipe(upstream);
                    upstream.pipe(socket);
                });
                upstream.on('error', () => socket.end());
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { server, port: server.address().port, targets };
}

describe('upstream proxy configuration', () => {
    test('is off by default and reports it in the banner', () => {
        const config = loadConfig({ env: { API_KEY: 'k' } });
        expect(config.UPSTREAM_PROXY).toBe('');
        const lines = describeConfig(config).map((entry) => entry.line);
        expect(lines.some((line) => line.includes('Upstream Proxy: None'))).toBe(true);
        expect(lines.some((line) => line.includes('Proxy for managed runtime: n/a'))).toBe(true);
    });

    test('accepts every documented scheme and normalises the value', () => {
        for (const url of [
            'socks5h://proxy.test:1080',
            'socks5://proxy.test:1080',
            'socks4a://proxy.test:1080',
            'socks4://proxy.test:1080',
            'http://proxy.test:3128',
            'https://proxy.test:3128'
        ]) {
            const config = loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: url } });
            expect(config.UPSTREAM_PROXY).toBe(url);
        }
        const trailing = loadConfig({
            env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: ' socks5h://proxy.test:1080/ ' }
        });
        expect(trailing.UPSTREAM_PROXY).toBe('socks5h://proxy.test:1080');
    });

    test('rejects an unusable scheme at load time', () => {
        expect(() =>
            loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: 'ftp://proxy.test' } })
        ).toThrow(/OPENCODE_PROXY_UPSTREAM_PROXY/);
        expect(() =>
            loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: 'not a url' } })
        ).toThrow(/proxy URL/);
    });

    test('falls back to the standard proxy variables, in order', () => {
        expect(
            loadConfig({ env: { API_KEY: 'k', HTTPS_PROXY: 'socks5h://from-https.test:1080' } })
                .UPSTREAM_PROXY
        ).toBe('socks5h://from-https.test:1080');
        expect(
            loadConfig({ env: { API_KEY: 'k', ALL_PROXY: 'socks5h://from-all.test:1080' } }).UPSTREAM_PROXY
        ).toBe('socks5h://from-all.test:1080');
        expect(
            loadConfig({
                env: {
                    API_KEY: 'k',
                    ALL_PROXY: 'socks5h://from-all.test:1080',
                    OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5h://explicit.test:1080'
                }
            }).UPSTREAM_PROXY
        ).toBe('socks5h://explicit.test:1080');
    });

    test('the banner never prints proxy credentials', () => {
        const config = loadConfig({
            env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5://bob:hunter2@proxy.test:1080' }
        });
        const lines = describeConfig(config).map((entry) => entry.line);
        const proxyLine = lines.find((line) => line.includes('Upstream Proxy:'));
        expect(proxyLine).toContain('proxy.test:1080');
        expect(proxyLine).not.toContain('hunter2');
        expect(proxyLine).not.toContain('bob');
    });

    test('can be disabled for the managed runtime', () => {
        const config = loadConfig({
            env: {
                API_KEY: 'k',
                OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5h://proxy.test:1080',
                OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME: 'false'
            }
        });
        expect(config.UPSTREAM_PROXY_FOR_RUNTIME).toBe(false);
    });
});

describe('fetch selection', () => {
    test('returns nothing when no proxy is configured, so the client keeps its default', () => {
        const config = loadConfig({ env: { API_KEY: 'k' } });
        expect(resolveUpstreamFetch({ config })).toBeUndefined();
    });

    test('builds a proxied fetch when one is configured', () => {
        const config = loadConfig({
            env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5h://proxy.test:1080' }
        });
        const selected = resolveUpstreamFetch({ config });
        expect(typeof selected).toBe('function');
        expect(selected).not.toBe(globalThis.fetch);
    });

    test('an injected fetch always wins (tests and callers stay in control)', () => {
        const config = loadConfig({
            env: { API_KEY: 'k', OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5h://proxy.test:1080' }
        });
        const injected = jest.fn();
        expect(resolveUpstreamFetch({ config, fetch: /** @type {any} */ (injected) })).toBe(injected);
    });
});

describe('direct upstream through a real SOCKS5 proxy', () => {
    let proxy;
    let origin;
    let originPort;

    beforeAll(async () => {
        proxy = await startSocksProxy();
        origin = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ model: req.headers['x-opencode-session'] ? 'seen' : 'missing' }));
        });
        await new Promise((resolve) => origin.listen(0, '127.0.0.1', () => resolve(undefined)));
        originPort = origin.address().port;
    });

    afterAll(async () => {
        await new Promise((resolve) => origin.close(() => resolve(undefined)));
        await new Promise((resolve) => proxy.server.close(() => resolve(undefined)));
    });

    test('sends a direct turn through the proxy', async () => {
        const config = loadConfig({
            env: {
                API_KEY: 'k',
                ZEN_API_KEY: 'zen-key',
                OPENCODE_PROXY_UPSTREAM_PROXY: `socks5h://127.0.0.1:${proxy.port}`,
                OPENCODE_PROXY_DIRECT_GO_URL: `http://upstream.internal:${originPort}`
            }
        });
        const proxyFetch = createUpstreamFetch({ proxyUrl: config.UPSTREAM_PROXY });
        const direct = createDirectUpstream({ config, fetch: proxyFetch });

        const response = await direct.chatCompletion({
            providerID: 'opencode-go',
            modelID: 'minimax-m3',
            body: { model: 'minimax-m3', messages: [{ role: 'user', content: 'hi' }] },
            stream: false,
            sessionId: 'sess-1',
            requestId: 'req-1'
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ model: 'seen' });
        expect(proxy.targets).toContain(`upstream.internal:${originPort}`);
    });

    test('keeps a loopback upstream off the proxy', async () => {
        const config = loadConfig({
            env: {
                API_KEY: 'k',
                ZEN_API_KEY: 'zen-key',
                // A proxy nothing can reach: any proxied call would fail.
                OPENCODE_PROXY_UPSTREAM_PROXY: 'socks5h://127.0.0.1:1',
                OPENCODE_PROXY_DIRECT_GO_URL: `http://127.0.0.1:${originPort}`
            }
        });
        const proxyFetch = createUpstreamFetch({ proxyUrl: config.UPSTREAM_PROXY });
        const direct = createDirectUpstream({ config, fetch: proxyFetch });

        const response = await direct.chatCompletion({
            providerID: 'opencode-go',
            modelID: 'minimax-m3',
            body: { model: 'minimax-m3', messages: [{ role: 'user', content: 'hi' }] },
            stream: false
        });
        expect(response.status).toBe(200);
    });
});
