/**
 * Startup exposure safety checks.
 *
 * Parsing configuration and deciding whether it is safe to expose are separate:
 * tests and library consumers can still resolve the documented defaults, while
 * the executable refuses to listen publicly without client authentication unless
 * the operator explicitly opts into that risk.
 *
 * @module config/exposure
 */

import { ConfigError } from './schema.js';

/**
 * Return whether a bind host is explicitly loopback-only.
 *
 * Hostnames other than localhost are deliberately treated as public/unknown:
 * resolving DNS during startup would make the safety decision environment-
 * dependent and could change after the process starts.
 *
 * @param {string} host Configured bind host.
 * @returns {boolean} True when the host is unambiguously loopback-only.
 */
export function isLoopbackBindHost(host) {
    const normalized = String(host || '')
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1');

    if (normalized === 'localhost' || normalized === 'localhost.' || normalized === '::1') {
        return true;
    }

    const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((value) => value < 0 || value > 255)) return false;
    return octets[0] === 127;
}

/**
 * Refuse an unauthenticated non-loopback listener unless the operator explicitly
 * opts in with OPENCODE_PROXY_ALLOW_PUBLIC_NO_AUTH=true.
 *
 * @param {import('./schema.js').Config} config Resolved configuration.
 * @returns {void}
 * @throws {ConfigError} When startup would expose an unauthenticated public listener.
 */
export function assertSafePublicExposure(config) {
    if (config.API_KEY) return;
    if (isLoopbackBindHost(config.BIND_HOST)) return;
    if (config.ALLOW_PUBLIC_NO_AUTH) return;

    throw new ConfigError(
        [
            `Refusing to start without API_KEY on non-loopback BIND_HOST=${config.BIND_HOST}.`,
            'Set API_KEY, bind to 127.0.0.1/::1/localhost, or explicitly acknowledge the risk with',
            'OPENCODE_PROXY_ALLOW_PUBLIC_NO_AUTH=true.'
        ].join(' '),
        {
            source: 'startup exposure policy',
            key: 'API_KEY'
        }
    );
}
