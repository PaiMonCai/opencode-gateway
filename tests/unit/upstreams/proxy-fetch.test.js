import net from 'node:net';
import http from 'node:http';
import { jest } from '@jest/globals';

import {
    createProxyAgent,
    createUpstreamFetch,
    isLoopbackHost,
    normalizeNoProxy,
    proxyEnvForRuntime,
    runtimeCanUseProxy,
    shouldBypassProxy
} from '../../../src/upstreams/proxy-fetch.js';

/**
 * These tests prove the transport with real servers rather than mocks: a real
 * SOCKS5 proxy (handshake implemented here) and a real HTTP CONNECT proxy, each
 * forwarding to a real HTTP origin. A mocked agent would only prove that the
 * agent was passed around.
 */

/**
 * Start an HTTP origin that answers JSON describing the request.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>, requests: string[]}>} Origin handle.
 */
async function startOrigin() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const payload = JSON.stringify({ path: req.url, body, authorization: req.headers.authorization });
            res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'yes' });
            res.end(payload);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
    };
}

/**
 * Resolve a test destination. `localtest.internal` stands in for a public
 * upstream host: the proxy resolves it (that is what `socks5h` means), which is
 * how these tests keep the target non-loopback while still running locally.
 *
 * @param {string} host Host name the client asked for.
 * @returns {string} Address to connect to.
 */
function resolveTestHost(host) {
    return host === 'localtest.internal' ? '127.0.0.1' : host;
}

/**
 * Start a SOCKS5 proxy, optionally requiring username/password.
 *
 * @param {object} [options] Proxy options.
 * @param {{user: string, password: string}} [options.auth] Required credentials.
 * @returns {Promise<{url: string, close: () => Promise<void>, targets: string[]}>} Proxy handle.
 */
async function startSocksProxy({ auth = null } = {}) {
    const targets = [];
    const server = net.createServer((socket) => {
        let stage = 'greeting';
        let buffer = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
                if (buffer.length < 2 + buffer[1]) return;
                const offered = [...buffer.subarray(2, 2 + buffer[1])];
                const method = auth ? 0x02 : 0x00;
                buffer = buffer.subarray(2 + buffer[1]);
                if (!offered.includes(method)) {
                    socket.end(Buffer.from([0x05, 0xff]));
                    return;
                }
                stage = auth ? 'auth' : 'request';
                socket.write(Buffer.from([0x05, method]));
                if (stage === 'request') return;
            }
            if (stage === 'auth') {
                if (buffer.length < 2) return;
                const userLength = buffer[1];
                if (buffer.length < 2 + userLength + 1) return;
                const user = buffer.subarray(2, 2 + userLength).toString();
                const passwordLength = buffer[2 + userLength];
                if (buffer.length < 2 + userLength + 1 + passwordLength) return;
                const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
                buffer = buffer.subarray(3 + userLength + passwordLength);
                const ok = user === auth.user && password === auth.password;
                socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
                if (!ok) {
                    socket.end();
                    return;
                }
                stage = 'request';
            }
            if (stage === 'request') {
                if (buffer.length < 4) return;
                const addressType = buffer[3];
                let host;
                let offset;
                if (addressType === 0x01) {
                    if (buffer.length < 10) return;
                    host = [...buffer.subarray(4, 8)].join('.');
                    offset = 8;
                } else if (addressType === 0x03) {
                    const length = buffer[4];
                    if (buffer.length < 5 + length + 2) return;
                    host = buffer.subarray(5, 5 + length).toString();
                    offset = 5 + length;
                } else {
                    socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                const port = buffer.readUInt16BE(offset);
                targets.push(`${host}:${port}`);
                const upstream = net.connect(port, resolveTestHost(host), () => {
                    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    const rest = buffer.subarray(offset + 2);
                    if (rest.length) upstream.write(rest);
                    buffer = Buffer.alloc(0);
                    stage = 'pipe';
                    socket.pipe(upstream);
                    upstream.pipe(socket);
                });
                upstream.on('error', () => {
                    socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                });
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = server.address().port;
    const credentials = auth ? `${auth.user}:${auth.password}@` : '';
    return {
        url: `socks5h://${credentials}127.0.0.1:${port}`,
        targets,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
    };
}

/**
 * Start an HTTP CONNECT proxy.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>, targets: string[]}>} Proxy handle.
 */
async function startConnectProxy() {
    const targets = [];
    const server = http.createServer((req, res) => {
        // Plain forwarding for http:// targets.
        const target = new URL(req.url);
        targets.push(`${target.hostname}:${target.port}`);
        const upstream = http.request(
            {
                hostname: resolveTestHost(target.hostname),
                port: target.port,
                path: target.pathname,
                method: req.method,
                headers: req.headers
            },
            (proxied) => {
                res.writeHead(proxied.statusCode || 502, proxied.headers);
                proxied.pipe(res);
            }
        );
        req.pipe(upstream);
    });
    server.on('connect', (req, clientSocket, head) => {
        const [host, port] = req.url.split(':');
        targets.push(`${host}:${port}`);
        const upstream = net.connect(Number(port), resolveTestHost(host), () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.end());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        targets,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
    };
}

describe('proxy URL handling', () => {
    test('normalises NO_PROXY entries', () => {
        expect(normalizeNoProxy(' Example.com ,10.0.0.1:8080,')).toEqual(['example.com', '10.0.0.1:8080']);
        expect(normalizeNoProxy(['a.test', ' b.test '])).toEqual(['a.test', 'b.test']);
        expect(normalizeNoProxy(undefined)).toEqual([]);
    });

    test('treats loopback addresses as local', () => {
        expect(isLoopbackHost('localhost')).toBe(true);
        expect(isLoopbackHost('api.localhost')).toBe(true);
        expect(isLoopbackHost('127.0.0.1')).toBe(true);
        expect(isLoopbackHost('127.9.9.9')).toBe(true);
        expect(isLoopbackHost('::1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
        expect(isLoopbackHost('example.com')).toBe(false);
        expect(isLoopbackHost('10.0.0.1')).toBe(false);
    });

    test('bypasses loopback and NO_PROXY matches, and only those', () => {
        expect(shouldBypassProxy('http://127.0.0.1:8080/x', [])).toBe(true);
        expect(shouldBypassProxy('http://localhost/x', [])).toBe(true);
        expect(shouldBypassProxy('https://api.example.com/x', [])).toBe(false);
        expect(shouldBypassProxy('https://api.example.com/x', ['example.com'])).toBe(true);
        expect(shouldBypassProxy('https://api.example.com/x', ['.example.com'])).toBe(true);
        expect(shouldBypassProxy('https://api.example.com/x', ['other.test'])).toBe(false);
        expect(shouldBypassProxy('https://api.example.com:8443/x', ['api.example.com:8443'])).toBe(true);
        expect(shouldBypassProxy('https://api.example.com:8443/x', ['api.example.com:9999'])).toBe(false);
        expect(shouldBypassProxy('https://anything.test/x', ['*'])).toBe(true);
    });

    test('picks the agent family the scheme names', () => {
        for (const scheme of ['socks5h://p:1080', 'socks5://p:1080', 'socks4a://p:1080', 'socks4://p:1080']) {
            const agent = createProxyAgent(
                /** @type {any} */ ({
                    url: scheme,
                    family: 'socks',
                    protocol: scheme.slice(0, scheme.indexOf('://') + 1)
                })
            );
            expect(agent.constructor.name).toBe('SocksProxyAgent');
        }
        for (const scheme of ['http://p:3128', 'https://p:3128']) {
            const agent = createProxyAgent(
                /** @type {any} */ ({
                    url: scheme,
                    family: 'http',
                    protocol: scheme.slice(0, scheme.indexOf('://') + 1)
                })
            );
            expect(agent.constructor.name).toBe('HttpsProxyAgent');
        }
    });

    test('returns the built-in fetch untouched when no proxy is configured', () => {
        const baseFetch = jest.fn();
        expect(createUpstreamFetch({ proxyUrl: '', baseFetch: /** @type {any} */ (baseFetch) })).toBe(
            baseFetch
        );
    });

    test('exports an http(s) proxy to a managed runtime with loopback protected', () => {
        const env = proxyEnvForRuntime('http://user:pw@proxy.test:3128', 'internal.test');
        expect(env.ALL_PROXY).toBe('http://user:pw@proxy.test:3128');
        expect(env.HTTPS_PROXY).toBe('http://user:pw@proxy.test:3128');
        expect(env.HTTP_PROXY).toBe(env.ALL_PROXY);
        expect(env.NODE_USE_ENV_PROXY).toBe('1');
        for (const host of ['internal.test', 'localhost', '127.0.0.1', '::1']) {
            expect(env.NO_PROXY.split(',')).toContain(host);
        }
        expect(runtimeCanUseProxy('http://proxy.test:3128')).toBe(true);
    });

    test('never hands a SOCKS proxy to the runtime', () => {
        // The runtime is a Bun binary: it parses HTTP(S)_PROXY as an http(s)
        // proxy, and a SOCKS URL there makes every turn fail inside it with
        // `UnknownError` (observed on opencode 1.18.34). So nothing is exported.
        for (const scheme of ['socks5h://p:1080', 'socks5://p:1080', 'socks4a://p:1080', 'socks4://p:1080']) {
            expect(runtimeCanUseProxy(scheme)).toBe(false);
            expect(proxyEnvForRuntime(scheme, 'internal.test')).toEqual({});
        }
        expect(runtimeCanUseProxy('')).toBe(false);
    });
});

describe('proxied fetch over a real SOCKS5 proxy', () => {
    let origin;
    let proxy;

    beforeAll(async () => {
        origin = await startOrigin();
        proxy = await startSocksProxy();
    });

    afterAll(async () => {
        await proxy.close();
        await origin.close();
    });

    test('reaches the origin through the proxy and reports the target', async () => {
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: proxy.url });
        // The origin is loopback, so point the bypass list at nothing and use a
        // hostname that is not loopback by construction: the SOCKS server resolves it.
        const targetUrl = `${origin.url.replace('127.0.0.1', 'localtest.internal')}/v1/models`;
        const response = await fetchThroughProxy(targetUrl);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-origin')).toBe('yes');
        const payload = await response.json();
        expect(payload.path).toBe('/v1/models');
        expect(proxy.targets.at(-1)).toBe(`localtest.internal:${new URL(origin.url).port}`);
    });

    test('streams the body without re-encoding it', async () => {
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: proxy.url });
        const url = `${origin.url.replace('127.0.0.1', 'localtest.internal')}/stream`;
        const response = await fetchThroughProxy(url, { method: 'POST', body: JSON.stringify({ a: 1 }) });
        expect(response.body).toBeTruthy();
        const text = await new Response(response.body).text();
        expect(JSON.parse(text).body).toBe(JSON.stringify({ a: 1 }));
        expect(response.headers.get('content-type')).toBe('application/json');
    });

    test('keeps loopback requests off the proxy', async () => {
        // A proxy that cannot work: any request through it would fail.
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: 'socks5h://127.0.0.1:1' });
        const response = await fetchThroughProxy(`${origin.url}/direct`);
        expect(response.status).toBe(200);
        expect((await response.json()).path).toBe('/direct');
    });
});

describe('proxied fetch over a SOCKS5 proxy with credentials', () => {
    let origin;
    let proxy;

    beforeAll(async () => {
        origin = await startOrigin();
        proxy = await startSocksProxy({ auth: { user: 'bob', password: 's3cret' } });
    });

    afterAll(async () => {
        await proxy.close();
        await origin.close();
    });

    test('authenticates with the credentials in the proxy URL', async () => {
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: proxy.url });
        const url = `${origin.url.replace('127.0.0.1', 'localtest.internal')}/auth`;
        const response = await fetchThroughProxy(url);
        expect(response.status).toBe(200);
    });

    test('fails when the proxy rejects the handshake', async () => {
        const wrong = proxy.url.replace('bob:s3cret@', '');
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: wrong });
        const url = `${origin.url.replace('127.0.0.1', 'localtest.internal')}/auth`;
        await expect(fetchThroughProxy(url)).rejects.toThrow();
    });
});

describe('proxied fetch over a real HTTP CONNECT proxy', () => {
    let origin;
    let proxy;

    beforeAll(async () => {
        origin = await startOrigin();
        proxy = await startConnectProxy();
    });

    afterAll(async () => {
        await proxy.close();
        await origin.close();
    });

    test('tunnels through CONNECT', async () => {
        const fetchThroughProxy = createUpstreamFetch({ proxyUrl: proxy.url });
        const url = `${origin.url.replace('127.0.0.1', 'localtest.internal')}/tunnelled`;
        const response = await fetchThroughProxy(url);
        expect(response.status).toBe(200);
        expect(proxy.targets.at(-1)).toBe(`localtest.internal:${new URL(origin.url).port}`);
    });
});
