/**
 * Proxy URLs for outbound upstream calls: parsing and banner description, kept
 * free of anything that opens sockets so the config layer and the banner never
 * have to know how a proxy is parsed.
 *
 * @module config/proxy-url
 */

/**
 * Schemes accepted by `OPENCODE_PROXY_UPSTREAM_PROXY`. The `socks5h` / `socks4a`
 * variants resolve the target host at the proxy, which a SOCKS-only egress needs.
 */
export const PROXY_PROTOCOLS = Object.freeze([
    'socks5h:',
    'socks5:',
    'socks4a:',
    'socks4:',
    'http:',
    'https:'
]);

/** Human-readable list of the accepted schemes, for error messages. */
export const PROXY_SCHEME_LIST = PROXY_PROTOCOLS.map((protocol) => protocol.replace(':', '://')).join(', ');

/**
 * @typedef {object} ParsedProxy
 * @property {string} url Normalised proxy URL (no trailing slash).
 * @property {string} protocol Scheme, e.g. `socks5h:`.
 * @property {'socks'|'http'} family Transport family the scheme belongs to.
 * @property {string} host Host name or address.
 * @property {string} port Port, when one was given.
 * @property {boolean} authenticated Whether user info is present.
 */

/**
 * Parse a proxy URL.
 *
 * @param {unknown} value Raw configuration value.
 * @returns {ParsedProxy|null} Parsed proxy, or null when unset.
 * @throws {Error} When the value is not a usable proxy URL.
 */
export function parseProxyUrl(value) {
    if (value === '' || value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('a proxy URL must be a string');
    const trimmed = value.trim();
    if (!trimmed) return null;
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`a proxy URL (${PROXY_SCHEME_LIST})`);
    }
    if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
        throw new Error(`a proxy URL using ${PROXY_SCHEME_LIST}`);
    }
    if (!parsed.hostname) throw new Error('a proxy URL with a host');
    return {
        url: trimmed.replace(/\/+$/, ''),
        protocol: parsed.protocol,
        family: parsed.protocol.startsWith('socks') ? 'socks' : 'http',
        host: parsed.hostname,
        port: parsed.port,
        authenticated: Boolean(parsed.username || parsed.password)
    };
}

/**
 * Describe a proxy for the startup banner.
 *
 * Credentials are never printed: the user info is replaced with `***`, so a
 * password cannot end up in container logs.
 *
 * @param {unknown} value Raw configuration value.
 * @returns {string} `None` when unset, otherwise scheme + host + port.
 */
export function describeProxyUrl(value) {
    let parsed;
    try {
        parsed = parseProxyUrl(value);
    } catch {
        return 'invalid';
    }
    if (!parsed) return 'None';
    const credentials = parsed.authenticated ? '***@' : '';
    return `${parsed.protocol}//${credentials}${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`;
}
