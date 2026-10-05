import { describe, expect, test } from '@jest/globals';

import { assertSafePublicExposure, isLoopbackBindHost } from '../../../src/config/exposure.js';
import { loadConfig } from '../../../src/config/index.js';
import { ConfigError } from '../../../src/config/schema.js';

describe('public exposure safety', () => {
    test.each(['127.0.0.1', '127.0.0.2', 'localhost', 'LOCALHOST.', '::1', '[::1]'])(
        'recognises %s as loopback-only',
        (host) => {
            expect(isLoopbackBindHost(host)).toBe(true);
        }
    );

    test.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'gateway.internal', 'example.com'])(
        'treats %s as public or unknown',
        (host) => {
            expect(isLoopbackBindHost(host)).toBe(false);
        }
    );

    test('allows a public bind when API_KEY is configured', () => {
        const config = loadConfig({
            env: { BIND_HOST: '0.0.0.0', API_KEY: 'client-secret' }
        });
        expect(() => assertSafePublicExposure(config)).not.toThrow();
    });

    test('allows an unauthenticated loopback-only listener', () => {
        const config = loadConfig({
            env: { BIND_HOST: '127.0.0.1' }
        });
        expect(() => assertSafePublicExposure(config)).not.toThrow();
    });

    test('fails fast on an unauthenticated public listener by default', () => {
        const config = loadConfig({ env: {} });
        expect(() => assertSafePublicExposure(config)).toThrow(ConfigError);
        expect(() => assertSafePublicExposure(config)).toThrow(/Refusing to start without API_KEY/);
    });

    test('requires an explicit opt-in to allow public no-auth mode', () => {
        const config = loadConfig({
            env: {
                BIND_HOST: '0.0.0.0',
                OPENCODE_PROXY_ALLOW_PUBLIC_NO_AUTH: 'true'
            }
        });
        expect(() => assertSafePublicExposure(config)).not.toThrow();
    });
});
