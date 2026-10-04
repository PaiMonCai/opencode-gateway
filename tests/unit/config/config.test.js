import { describe, expect, test } from '@jest/globals';

import {
    CONFIG_FIELDS,
    ConfigError,
    DEFAULT_SESSION_HEADER_NAMES,
    describeConfig,
    isUnset
} from '../../../src/config/schema.js';
import { loadConfig } from '../../../src/config/load.js';

describe('config defaults', () => {
    test('resolves every documented default when nothing is set', () => {
        const config = loadConfig({ env: {} });

        expect(config.PORT).toBe(10000);
        expect(config.BIND_HOST).toBe('0.0.0.0');
        expect(config.OPENCODE_SERVER_PORT).toBe(10001);
        expect(config.OPENCODE_SERVER_URL).toBe('http://127.0.0.1:10001');
        expect(config.OPENCODE_SERVER_PASSWORD).toBe('');
        expect(config.API_KEY).toBe('');
        expect(config.ZEN_API_KEY).toBe('');
        expect(config.MANAGE_BACKEND).toBe(true);
        expect(config.OPENCODE_PATH).toBe('opencode');
        expect(config.USE_ISOLATED_HOME).toBe(false);
        expect(config.DISABLE_TOOLS).toBe(true);
        expect(config.EXTERNAL_TOOLS_MODE).toBe('proxy-bridge');
        expect(config.EXTERNAL_TOOLS_CONFLICT_POLICY).toBe('namespace');
        expect(config.INTERNAL_WEB_FETCH_ENABLED).toBe(false);
        expect(config.INTERNAL_ALLOWED_TOOLS).toEqual([]);
        expect(config.INTERNAL_TOOL_METRICS_ENABLED).toBe(true);
        expect(config.INTERNAL_TOOL_DISCOVERY_FIXTURE).toEqual([]);
        expect(config.HEALTH_DETAILS_ENABLED).toBe(true);
        expect(config.HEALTH_DETAILS_REQUIRE_AUTH).toBe(true);
        expect(config.METRICS_ENABLED).toBe(false);
        expect(config.METRICS_REQUIRE_AUTH).toBe(true);
        expect(config.PROMPT_MODE).toBe('standard');
        expect(config.OMIT_SYSTEM_PROMPT).toBe(false);
        expect(config.AUTO_CLEANUP_CONVERSATIONS).toBe(false);
        expect(config.CLEANUP_INTERVAL_MS).toBe(43200000);
        expect(config.CLEANUP_MAX_AGE_MS).toBe(86400000);
        expect(config.REQUEST_TIMEOUT_MS).toBe(180000);
        expect(config.EVENT_IDLE_TIMEOUT_MS).toBe(8000);
        expect(config.EVENT_FIRST_DELTA_TIMEOUT_MS).toBe(30000);
        expect(config.SESSION_REUSE_ENABLED).toBe(true);
        expect(config.SESSION_TTL_MS).toBe(1800000);
        expect(config.SESSION_HEADER_NAMES).toEqual(DEFAULT_SESSION_HEADER_NAMES);
        expect(config.SESSION_DERIVE_ENABLED).toBe(false);
        expect(config.DIRECT_ENABLED).toBe(true);
        expect(config.DIRECT_GO_BASE_URL).toBe('https://opencode.ai/zen/go/v1');
        expect(config.DIRECT_ZEN_BASE_URL).toBe('https://opencode.ai/zen/v1');
        expect(config.DIRECT_FREE_VIA_RUNTIME).toBe(true);
        expect(config.DIRECT_FALLBACK_TO_RUNTIME).toBe(true);
        expect(config.DEBUG).toBe(false);
    });

    test('exposes all eleven documented session headers in priority order', () => {
        expect(DEFAULT_SESSION_HEADER_NAMES).toEqual([
            'x-opencode-session',
            'x-session-id',
            'x-thread-id',
            'x-conversation-id',
            'x-deepseek-harness-session-id',
            'session-id',
            'session_id',
            'thread-id',
            'thread_id',
            'conversation-id',
            'conversation_id'
        ]);
    });

    test('freezes the config and its list values', () => {
        const config = loadConfig({ env: {} });

        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.SESSION_HEADER_NAMES)).toBe(true);
        expect(Object.isFrozen(config.INTERNAL_ALLOWED_TOOLS)).toBe(true);
        expect(() => {
            // @ts-expect-error deliberately mutating a frozen object
            config.PORT = 1;
        }).toThrow(TypeError);
    });
});

describe('config precedence', () => {
    test('environment beats config.json beats defaults', () => {
        const config = loadConfig({
            env: { OPENCODE_PROXY_PORT: '12345', OPENCODE_PATH: '/usr/bin/opencode' },
            file: { PORT: 2222, OPENCODE_PATH: '/from/file', BIND_HOST: '127.0.0.1' }
        });

        expect(config.PORT).toBe(12345);
        expect(config.OPENCODE_PATH).toBe('/usr/bin/opencode');
        expect(config.BIND_HOST).toBe('127.0.0.1');
    });

    test('falls back to file values when the env var is absent', () => {
        const config = loadConfig({ env: {}, file: { PORT: 2222, DEBUG: true } });

        expect(config.PORT).toBe(2222);
        expect(config.DEBUG).toBe(true);
    });

    test('an empty env var counts as unset and falls through to the file', () => {
        const config = loadConfig({ env: { API_KEY: '', DEBUG: '' }, file: { API_KEY: 'from-file' } });

        expect(config.API_KEY).toBe('from-file');
        expect(config.DEBUG).toBe(false);
    });

    test('accepts the legacy PORT env var after OPENCODE_PROXY_PORT', () => {
        expect(loadConfig({ env: { PORT: '4321' } }).PORT).toBe(4321);
        expect(loadConfig({ env: { PORT: '4321', OPENCODE_PROXY_PORT: '5555' } }).PORT).toBe(5555);
    });

    test('derives OPENCODE_SERVER_URL from OPENCODE_SERVER_PORT', () => {
        expect(loadConfig({ env: { OPENCODE_SERVER_PORT: '12000' } }).OPENCODE_SERVER_URL).toBe(
            'http://127.0.0.1:12000'
        );
    });

    test('accepts an explicit OPENCODE_SERVER_URL and trims a trailing slash', () => {
        expect(loadConfig({ env: { OPENCODE_SERVER_URL: 'http://backend:9999/' } }).OPENCODE_SERVER_URL).toBe(
            'http://backend:9999'
        );
    });

    test('parses booleans with every documented spelling', () => {
        for (const value of ['1', 'true', 'TRUE', 'yes', 'y', 'on']) {
            expect(loadConfig({ env: { OPENCODE_PROXY_DEBUG: value } }).DEBUG).toBe(true);
        }
        for (const value of ['0', 'false', 'no', 'n', 'off']) {
            expect(loadConfig({ env: { OPENCODE_PROXY_DEBUG: value } }).DEBUG).toBe(false);
        }
    });

    test('parses and deduplicates comma-separated lists, preserving order', () => {
        const config = loadConfig({
            env: { OPENCODE_INTERNAL_ALLOWED_TOOLS: 'web_fetch, bash,web_fetch' }
        });

        expect(config.INTERNAL_ALLOWED_TOOLS).toEqual(['web_fetch', 'bash']);
    });

    test('accepts lists from config.json as arrays', () => {
        const config = loadConfig({ env: {}, file: { INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'bash'] } });

        expect(config.INTERNAL_ALLOWED_TOOLS).toEqual(['web_fetch', 'bash']);
    });

    test('an empty session header list falls back to the documented default', () => {
        expect(loadConfig({ env: {}, file: { SESSION_HEADER_NAMES: [] } }).SESSION_HEADER_NAMES).toEqual(
            DEFAULT_SESSION_HEADER_NAMES
        );
        expect(loadConfig({ env: { OPENCODE_PROXY_SESSION_HEADERS: '' } }).SESSION_HEADER_NAMES).toEqual(
            DEFAULT_SESSION_HEADER_NAMES
        );
    });

    test('a narrowed session header list replaces the default', () => {
        const config = loadConfig({
            env: { OPENCODE_PROXY_SESSION_HEADERS: 'x-deepseek-harness-session-id' }
        });

        expect(config.SESSION_HEADER_NAMES).toEqual(['x-deepseek-harness-session-id']);
    });

    test('zero means "use the default" for duration fields', () => {
        const config = loadConfig({
            env: {
                OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '0',
                OPENCODE_PROXY_SESSION_TTL_MS: '0',
                OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS: '0',
                OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS: '0'
            }
        });

        expect(config.REQUEST_TIMEOUT_MS).toBe(180000);
        expect(config.SESSION_TTL_MS).toBe(1800000);
        expect(config.EVENT_IDLE_TIMEOUT_MS).toBe(8000);
        expect(config.EVENT_FIRST_DELTA_TIMEOUT_MS).toBe(30000);
    });
});

describe('config validation', () => {
    test.each([
        ['OPENCODE_PROXY_PORT', 'abc'],
        ['OPENCODE_PROXY_PORT', '70000'],
        ['OPENCODE_PROXY_PORT', '0'],
        ['OPENCODE_PROXY_REQUEST_TIMEOUT_MS', '-5'],
        ['OPENCODE_PROXY_REQUEST_TIMEOUT_MS', '1.5'],
        ['OPENCODE_PROXY_DEBUG', 'maybe'],
        ['OPENCODE_PROXY_PROMPT_MODE', 'fancy'],
        ['OPENCODE_EXTERNAL_TOOLS_MODE', 'native'],
        ['OPENCODE_SERVER_URL', 'not-a-url'],
        ['OPENCODE_SERVER_URL', 'ftp://example.com']
    ])('fails fast on %s=%s', (name, value) => {
        expect(() => loadConfig({ env: { [name]: value } })).toThrow(ConfigError);
    });

    test('names the offending variable in the error', () => {
        expect(() => loadConfig({ env: { OPENCODE_PROXY_PORT: 'abc' } })).toThrow(
            /environment variable OPENCODE_PROXY_PORT/
        );
        expect(() => loadConfig({ env: {}, file: { DEBUG: 'maybe' } })).toThrow(/config.json key DEBUG/);
    });

    test('fails fast when the config file is not valid JSON', async () => {
        const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const path = await import('node:path');

        const dir = await mkdtemp(path.join(tmpdir(), 'opencode-config-bad-'));
        const file = path.join(dir, 'config.json');
        try {
            await writeFile(file, '{ not json', 'utf8');
            expect(() => loadConfig({ env: {}, file })).toThrow(ConfigError);
            expect(() => loadConfig({ env: {}, file })).toThrow(/Cannot parse config file/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('fails fast when the config file does not hold a JSON object', () => {
        expect(() => loadConfig({ env: {}, file: [] })).toThrow(/must contain a JSON object/);
    });

    test('reports the source and key on the thrown error', () => {
        try {
            loadConfig({ env: { OPENCODE_PROXY_DEBUG: 'nope' } });
            throw new Error('expected loadConfig to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect(/** @type {ConfigError} */ (error).source).toBe(
                'environment variable OPENCODE_PROXY_DEBUG'
            );
            expect(/** @type {ConfigError} */ (error).key).toBe('DEBUG');
            expect(/** @type {ConfigError} */ (error).value).toBe('nope');
        }
    });
});

describe('describeConfig', () => {
    test('returns the startup banner as one line per reportable field', () => {
        const config = loadConfig({ env: {} });
        const lines = describeConfig(config).map((entry) => entry.line);

        expect(Array.isArray(lines)).toBe(true);
        expect(lines.length).toBeGreaterThan(20);
        expect(lines[0]).toBe('  - Port: 10000');
        expect(lines).toContain('  - Backend: http://127.0.0.1:10001');
        expect(lines).toContain('  - Session Identity Derivation: No');
        expect(lines.some((line) => line.startsWith('  - Session Reuse: Yes (ttl 1800s'))).toBe(true);
        expect(lines.at(-1)).toBe('  - Debug: No');
    });

    test('never prints secret values', () => {
        const config = loadConfig({
            env: {
                API_KEY: 'super-secret-key',
                OPENCODE_SERVER_PASSWORD: 'super-secret-password',
                OPENCODE_ZEN_API_KEY: 'super-secret-zen'
            }
        });
        const banner = describeConfig(config)
            .map((entry) => entry.line)
            .join('\n');

        expect(banner).not.toContain('super-secret-key');
        expect(banner).not.toContain('super-secret-password');
        expect(banner).not.toContain('super-secret-zen');
        expect(banner).toContain('  - API Key: Configured');
        expect(banner).toContain('  - Backend Password: Configured');
        expect(banner).toContain('  - Zen API Key: Configured');
    });

    test('every field declares a key and a type, and reads env names or says why not', () => {
        for (const field of CONFIG_FIELDS) {
            expect(typeof field.key).toBe('string');
            expect(typeof field.type).toBe('string');
            // A field either reads environment names or records why it no longer
            // does (a merged or dropped setting), so nothing disappears silently.
            if (field.env.length === 0) expect(typeof field.removed).toBe('string');
        }
    });
});

describe('isUnset', () => {
    test.each([
        [undefined, true],
        [null, true],
        ['', true],
        ['   ', true],
        [0, false],
        [false, false],
        [[], false],
        ['x', false]
    ])('isUnset(%p) === %p', (value, expected) => {
        expect(isUnset(value)).toBe(expected);
    });
});

describe('config.json files', () => {
    test('reads a real JSON file from disk', async () => {
        const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const path = await import('node:path');

        const dir = await mkdtemp(path.join(tmpdir(), 'opencode-config-'));
        const file = path.join(dir, 'config.json');
        try {
            await writeFile(file, JSON.stringify({ PORT: 31337, DEBUG: true }), 'utf8');
            const config = loadConfig({ env: {}, file });

            expect(config.PORT).toBe(31337);
            expect(config.DEBUG).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('a missing file is not an error', () => {
        const config = loadConfig({ env: {}, file: '/nonexistent/definitely/not/here.json' });

        expect(config.PORT).toBe(10000);
    });
});

describe('deprecated and removed settings', () => {
    test('a removed setting is reported, ignored, and does not break startup', () => {
        const config = loadConfig({
            env: { API_KEY: 'k', OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME: 'false' }
        });
        expect(config.DIRECT_FREE_VIA_RUNTIME).toBe(true);
        expect(config.DEPRECATIONS.map((entry) => entry.name)).toContain(
            'OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME'
        );
    });

    test('a merged setting still works but points at its replacement', () => {
        const config = loadConfig({ env: { API_KEY: 'k', OPENCODE_METRICS_ENABLED: 'true' } });
        expect(config.METRICS_ENABLED).toBe(true);
        const entry = config.DEPRECATIONS.find((item) => item.name === 'OPENCODE_METRICS_ENABLED');
        expect(entry?.message).toContain('OPENCODE_PROXY_OPS');
    });

    test('the merged enums drive the legacy keys when nothing overrides them', () => {
        expect(loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_OPS: 'off' } }).METRICS_ENABLED).toBe(false);
        expect(loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_OPS: 'full' } }).METRICS_ENABLED).toBe(true);
        const hourly = loadConfig({ env: { API_KEY: 'k', OPENCODE_PROXY_STORAGE_CLEANUP: 'hourly' } });
        expect(hourly.AUTO_CLEANUP_CONVERSATIONS).toBe(true);
        expect(hourly.CLEANUP_INTERVAL_MS).toBe(3600000);
        expect(loadConfig({ env: { API_KEY: 'k' } }).DEPRECATIONS).toEqual([]);
    });

    test('a config.json key of a merged setting is reported too', () => {
        const config = loadConfig({
            env: { API_KEY: 'k' },
            file: { OPS: 'full', METRICS_REQUIRE_AUTH: true }
        });
        expect(config.OPS).toBe('full');
        expect(config.DEPRECATIONS.map((entry) => entry.source)).toContain('config.json');
    });
});
