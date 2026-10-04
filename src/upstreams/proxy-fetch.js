/**
 * Outbound transport for upstream calls, optionally through a proxy.
 *
 * The direct upstream reaches `opencode.ai` with `fetch`. When that egress has to
 * go through a SOCKS or HTTP(S) proxy, this module builds a `fetch`-compatible
 * function that dials the proxy instead: the same signature, the same abort
 * semantics, and a real `Response` back, so callers cannot tell the difference.
 *
 * Two properties matter for a gateway:
 *
 * - **loopback is never proxied.** The managed runtime, its health check and the
 *   SDK all live on `127.0.0.1`; sending those through an external proxy would
 *   take the deployment down. `localhost`, `127.0.0.0/8` and `::1` always bypass.
 * - **with no proxy configured the built-in `fetch` is returned untouched**, so
 *   the default behaviour (and its tests) are exactly as before.
 *
 * @module upstreams/proxy-fetch
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { describeProxyUrl, parseProxyUrl } from '../config/proxy-url.js';

/** Headers a proxied response must not carry a body for. */
const BODYLESS_STATUSES = new Set([204, 304]);

/**
 * Normalise a `NO_PROXY` style value into a list of entries.
 *
 * @param {string|string[]|null|undefined} value Raw value.
 * @returns {string[]} Trimmed, lower-case entries (including the port when given).
 */
export function normalizeNoProxy(value) {
    if (!value) return [];
    const entries = Array.isArray(value) ? value : String(value).split(',');
    return entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether a host is loopback (and therefore must never be proxied).
 *
 * @param {string} hostname Host name or address, without brackets.
 * @returns {boolean} True for localhost, 127.0.0.0/8 and ::1.
 */
export function isLoopbackHost(hostname) {
    const host = String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    return /^127\./.test(host);
}

/**
 * Whether a URL must skip the proxy.
 *
 * Loopback always wins; otherwise `NO_PROXY` entries match a host exactly, a
 * `*.suffix` / `.suffix` domain suffix, or `host:port` for one port only.
 * A single `*` entry bypasses everything.
 *
 * @param {string} url Target URL.
 * @param {string[]} entries Normalised `NO_PROXY` entries.
 * @returns {boolean} True when the request should not be proxied.
 */
export function shouldBypassProxy(url, entries = []) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (isLoopbackHost(parsed.hostname)) return true;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const hostWithPort = parsed.port ? `${host}:${parsed.port}` : host;
    for (const entry of entries) {
        if (entry === '*') return true;
        const [entryHost, entryPort] = splitHostPort(entry);
        if (entryPort && entryPort !== parsed.port) continue;
        if (entryHost === host || entryHost === hostWithPort) return true;
        const bare = entryHost.replace(/^\./, '');
        if (bare && host.endsWith(`.${bare}`)) return true;
    }
    return false;
}

/**
 * Split a `NO_PROXY` entry into host and optional port (IPv6 aware).
 *
 * @param {string} entry Entry such as `example.com`, `example.com:8443` or `[::1]`.
 * @returns {[string, string]} Host and port (`''` when absent).
 */
function splitHostPort(entry) {
    const value = String(entry).trim();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        const host = value.slice(1, end === -1 ? value.length : end);
        const rest = end === -1 ? '' : value.slice(end + 1);
        return [host, rest.startsWith(':') ? rest.slice(1) : ''];
    }
    const separator = value.lastIndexOf(':');
    if (separator === -1) return [value, ''];
    const host = value.slice(0, separator);
    const port = value.slice(separator + 1);
    // A bare `host:` or a value with several colons (IPv6 without brackets) is a host.
    if (!port || host.includes(':')) return [value, ''];
    return [host, port];
}

/**
 * Build the agent a proxy URL selects.
 *
 * @param {import('../config/proxy-url.js').ParsedProxy} proxy Parsed proxy.
 * @returns {import('node:http').Agent} Node agent dialling the proxy.
 */
export function createProxyAgent(proxy) {
    return proxy.family === 'socks' ? new SocksProxyAgent(proxy.url) : new HttpsProxyAgent(proxy.url);
}

/**
 * Convert a Node response into a `Response` without altering the payload.
 *
 * `rawHeaders` is used instead of the joined `headers` object so repeated headers
 * survive, and the body is piped as bytes: an upstream `content-encoding` is
 * relayed exactly as it arrived.
 *
 * @param {import('node:http').IncomingMessage} res Node response.
 * @returns {Response} Fetch-shaped response.
 */
function toResponse(res) {
    /** @type {Array<[string, string]>} */
    const pairs = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
        pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
    }
    const init = {
        status: res.statusCode || 502,
        statusText: res.statusMessage || '',
        headers: pairs
    };
    if (BODYLESS_STATUSES.has(res.statusCode || 0)) {
        res.resume();
        return new Response(null, init);
    }
    return new Response(/** @type {ConstructorParameters<typeof Response>[0]} */ (Readable.toWeb(res)), init);
}

/**
 * Perform one request through the proxy agent.
 *
 * @param {string} url Target URL.
 * @param {RequestInit} init Fetch init (method, headers, body, signal).
 * @param {import('node:http').Agent} agent Proxy agent.
 * @returns {Promise<Response>} Fetch-shaped response.
 */
function requestThroughProxy(url, init, agent) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === 'https:' ? https : http;
        /** @type {Record<string, string>} */
        const headers = {};
        const source = init.headers;
        if (source instanceof Headers) {
            source.forEach((value, name) => {
                headers[name] = value;
            });
        } else if (Array.isArray(source)) {
            for (const [name, value] of source) headers[String(name)] = String(value);
        } else if (source) {
            for (const [name, value] of Object.entries(source)) {
                if (value !== undefined && value !== null) headers[name] = String(value);
            }
        }

        let body = init.body;
        if (typeof body === 'string') body = Buffer.from(body);
        else if (body instanceof URLSearchParams) body = Buffer.from(body.toString());
        else if (body === null) body = undefined;
        if (
            body &&
            typeof (/** @type {Uint8Array} */ (body).length) === 'number' &&
            !headers['content-length'] &&
            !headers['Content-Length']
        ) {
            headers['content-length'] = String(/** @type {Uint8Array} */ (body).length);
        }

        const request = transport.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: init.method || 'GET',
                headers,
                agent,
                signal: init.signal || undefined
            },
            (res) => {
                try {
                    resolve(toResponse(res));
                } catch (error) {
                    res.resume();
                    reject(error);
                }
            }
        );

        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

/**
 * Build the fetch implementation the upstream clients should use.
 *
 * @param {object} [options] Transport options.
 * @param {string} [options.proxyUrl] Proxy URL; empty means "no proxy".
 * @param {string|string[]} [options.noProxy] `NO_PROXY` entries.
 * @param {import('../logging/index.js').Logger|null} [options.logger] Logger dependency.
 * @param {typeof fetch} [options.baseFetch] Fetch used for unproxied requests.
 * @returns {typeof fetch} Fetch-compatible function.
 * @throws {Error} When the proxy URL is unusable.
 */
export function createUpstreamFetch({
    proxyUrl = '',
    noProxy = '',
    logger = null,
    baseFetch = globalThis.fetch
} = {}) {
    const proxy = parseProxyUrl(proxyUrl);
    if (!proxy) return baseFetch;
    const agent = createProxyAgent(proxy);
    const bypass = normalizeNoProxy(noProxy);
    logger?.info?.('[Proxy] Upstream calls egress through a proxy', {
        proxy: describeProxyUrl(proxyUrl),
        bypassEntries: bypass.length
    });

    /**
     * @param {Parameters<typeof fetch>[0]} input Request target.
     * @param {Parameters<typeof fetch>[1]} [init] Fetch init.
     * @returns {Promise<Response>} Response.
     */
    const proxiedFetch = async (input, init = {}) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : /** @type {Request} */ (input).url;
        if (shouldBypassProxy(url, bypass)) return baseFetch(input, init);
        return requestThroughProxy(url, init, agent);
    };
    return /** @type {typeof fetch} */ (proxiedFetch);
}

/**
 * Whether the managed OpenCode runtime can be told to use this proxy.
 *
 * The runtime is a Bun binary and only honours `HTTP_PROXY`/`HTTPS_PROXY`, which
 * it parses as **http(s) proxy** URLs: exporting a `socks5h://` URL there makes
 * every turn fail inside the runtime (observed on opencode 1.18.34: the turn
 * answers `UnknownError` although the process is healthy). A SOCKS egress
 * therefore applies to the direct upstream only.
 *
 * @param {string} proxyUrl Configured proxy URL.
 * @returns {boolean} True when the runtime can be handed this proxy.
 */
export function runtimeCanUseProxy(proxyUrl) {
    const proxy = parseProxyUrl(proxyUrl);
    if (!proxy) return false;
    return proxy.family === 'http';
}

/**
 * Environment variables a managed runtime needs to route its own egress through
 * the same proxy.
 *
 * Returns an empty patch for a SOCKS proxy: the runtime cannot use one, and
 * exporting the URL anyway is what broke every turn before this check existed
 * (see {@link runtimeCanUseProxy}). `NO_PROXY` always keeps the runtime's own
 * loopback calls local.
 *
 * @param {string} proxyUrl Proxy URL to export (credentials included).
 * @param {string|string[]} [noProxy] Operator `NO_PROXY` entries.
 * @returns {Record<string, string>} Environment patch for the child process.
 */
export function proxyEnvForRuntime(proxyUrl, noProxy = '') {
    if (!runtimeCanUseProxy(proxyUrl)) return {};
    const entries = [...normalizeNoProxy(noProxy), 'localhost', '127.0.0.1', '::1'];
    const unique = [...new Set(entries)].join(',');
    return {
        ALL_PROXY: proxyUrl,
        all_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: unique,
        no_proxy: unique,
        // Node's own tooling only honours the proxy variables when asked to.
        NODE_USE_ENV_PROXY: '1'
    };
}
