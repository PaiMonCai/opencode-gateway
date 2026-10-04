/**
 * BEHAVIOUR-SPEC §7 (operational surfaces: the startup banner) and §8
 * (configuration hardenings), plus the `/v1/models` fallback documented in §1.
 *
 * The banner is verified through `printBanner`, the same function `index.js`
 * calls, with the line sink injected.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../../src/config/index.js';
import { printBanner } from '../../../src/server.js';
import { createAssembly } from './harness.js';

/** @type {Array<{close: () => Promise<void>}>} */
const open = [];

afterEach(async () => {
    while (open.length) await open.pop().close();
});

const assembly = async (options) => {
    const instance = await createAssembly(options);
    open.push(instance);
    return instance;
};

const bannerFor = (env) => {
    const lines = [];
    printBanner(loadConfig({ env }), (line) => lines.push(line));
    return lines;
};

describe('§7 startup banner', () => {
    test('reports the documented fields, one line per setting', () => {
        const lines = bannerFor({
            OPENCODE_PROXY_PORT: '10123',
            BIND_HOST: '0.0.0.0',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
            OPENCODE_SERVER_PASSWORD: 'sup3r-secret',
            API_KEY: 'client-secret',
            OPENCODE_ZEN_API_KEY: 'zen-secret',
            OPENCODE_PATH: '/usr/local/bin/opencode',
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '45000'
        });
        const text = lines.join('\n');

        for (const expected of ['10123', '0.0.0.0', '4096', '/usr/local/bin/opencode', '45000']) {
            expect(text).toContain(expected);
        }
        expect(text).toMatch(/password[^:\n]*:\s*Configured/i);
        expect(text).toMatch(/session reuse/i);
        expect(text).toMatch(/ttl 1800s/);
        expect(text).toMatch(/x-opencode-session/);
        expect(text).toMatch(/direct upstream/i);
        expect(text).toMatch(/zen\/go\/v1/);
        expect(text).toMatch(/zen\/v1/);
    });

    test('never prints a secret, only whether it is configured', () => {
        const lines = bannerFor({
            API_KEY: 'client-secret-value',
            OPENCODE_SERVER_PASSWORD: 'backend-secret-value',
            OPENCODE_ZEN_API_KEY: 'zen-secret-value'
        });
        const text = lines.join('\n');

        expect(text).not.toContain('client-secret-value');
        expect(text).not.toContain('backend-secret-value');
        expect(text).not.toContain('zen-secret-value');
        expect(text).toMatch(/Configured|Not configured/i);
    });

    test('reports the effective event-timeout defaults, not the word "default"', () => {
        const text = bannerFor({}).join('\n');
        expect(text).toContain('8000ms');
        expect(text).toContain('30000ms');
    });
});

describe('§8 configuration hardenings', () => {
    test('a malformed config.json fails fast instead of warning', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-')), 'config.json');
        fs.writeFileSync(file, '{ this is not json');
        try {
            expect(() => loadConfig({ env: {}, file })).toThrow(/config|json/i);
        } finally {
            fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
    });

    test('a missing config.json path is not an error', () => {
        const config = loadConfig({ env: {}, file: '/nonexistent/definitely/not/here.json' });
        expect(config.PORT).toBe(10000);
    });

    test('a non-numeric or zero PORT is rejected', () => {
        for (const value of ['abc', '0', '-1']) {
            expect(() => loadConfig({ env: { OPENCODE_PROXY_PORT: value } })).toThrow(/PORT/i);
        }
        expect(loadConfig({ env: { OPENCODE_PROXY_PORT: '10000' } }).PORT).toBe(10000);
    });

    test('an empty environment variable means "unset" (defaults apply)', () => {
        const config = loadConfig({
            env: {
                OPENCODE_PROXY_SESSION_REUSE: '',
                OPENCODE_PROXY_DIRECT: '',
                OPENCODE_PROXY_SESSION_TTL_MS: ''
            }
        });
        // Empty is unset, so the documented defaults are used — not `false`.
        expect(config.SESSION_REUSE_ENABLED).toBe(true);
        expect(config.DIRECT_ENABLED).toBe(true);
        expect(config.SESSION_TTL_MS).toBe(1_800_000);
    });

    test('environment beats config.json beats the built-in default', () => {
        const config = loadConfig({
            env: { OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '12345' },
            file: { REQUEST_TIMEOUT_MS: 111, API_KEY: 'from-file' }
        });
        expect(config.REQUEST_TIMEOUT_MS).toBe(12345);
        expect(config.API_KEY).toBe('from-file');
    });
});

describe('§1 /v1/models fallback', () => {
    test('a single fallback model keeps the endpoint alive when no catalog is reachable', async () => {
        const { http, fake } = await assembly({
            env: { OPENCODE_ZEN_API_KEY: 'dummy-key' },
            directHandler: (req, res) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{"error":"catalog down"}');
            }
        });
        fake.client.config.providers = async () => {
            throw new Error('runtime catalog unavailable');
        };

        const res = await http.get('/v1/models');
        expect(res.status).toBe(200);
        expect(res.body.object).toBe('list');
        expect(res.body.data).toEqual([{ id: 'opencode/kimi-k2.5-free', object: 'model' }]);
    });

    test('the upstream catalog is used when only the runtime catalog is gone', async () => {
        const { http, fake } = await assembly({
            env: { OPENCODE_ZEN_API_KEY: 'dummy-key' },
            directHandler: (req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        data: [{ id: 'glm-5', name: 'GLM-5', created: 1_700_000_000 }]
                    })
                );
            }
        });
        fake.client.config.providers = async () => {
            throw new Error('runtime catalog unavailable');
        };

        const res = await http.get('/v1/models');
        expect(res.status).toBe(200);
        const ids = res.body.data.map((model) => model.id);
        expect(ids).toContain('opencode-go/glm-5');
        expect(ids).not.toContain('opencode/kimi-k2.5-free');
    });
});
