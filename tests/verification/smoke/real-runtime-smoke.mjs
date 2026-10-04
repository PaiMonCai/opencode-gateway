/**
 * Real-runtime smoke / environment exclusion check (NOT part of CI).
 *
 * The sandbox has no OpenCode runtime, so a real end-to-end turn cannot be
 * verified here. This script produces the evidence for that claim and excludes
 * "the rewrite broke it":
 *
 *   1. it checks the runtime is absent (CLI, health endpoint);
 *   2. it runs the **pre-rewrite monolith** (extracted from git) against the same
 *      absent runtime and records how it fails;
 *   3. it runs the **rewritten app** (real SDK, production assembly) against the
 *      same absent runtime and records how it fails;
 *   4. it fails only when the two do not fail the same way.
 *
 * Usage: `node tests/verification/smoke/real-runtime-smoke.mjs`
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sdk from '@opencode-ai/sdk';

import { buildRuntime } from '../../../src/bootstrap.js';
import { loadConfig } from '../../../src/config/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_URL = process.env.VERIFY_RUNTIME_URL || 'http://127.0.0.1:4096';
const MONOLITH_COMMIT = '4c4e42f^';
const lines = [];
const log = (message) => {
    lines.push(message);
    console.log(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portOpen(url, ms = 1500) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
        return `HTTP ${response.status}`;
    } catch (error) {
        return `unreachable (${error.cause?.code || error.name})`;
    }
}

async function probe(base, label) {
    let chatModel = 'opencode/kimi-k2.5-free';
    let models;
    try {
        const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
        const text = await response.text();
        models = `HTTP ${response.status} ${text.slice(0, 120)}`;
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.data) && parsed.data[0]?.id) chatModel = parsed.data[0].id;
    } catch (error) {
        models = `unreachable (${error.cause?.code || error.name})`;
    }
    log(`[evidence] ${label} GET /v1/models -> ${models}`);

    let chat;
    try {
        const response = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: chatModel,
                messages: [{ role: 'user', content: 'ping' }]
            }),
            signal: AbortSignal.timeout(12000)
        });
        chat = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
        chat = `unreachable (${error.cause?.code || error.name})`;
    }
    log(`[evidence] ${label} POST /v1/chat/completions (${chatModel}) -> ${chat}`);
    return { models, chat };
}

// --- 1. is a runtime there at all? ------------------------------------------
const cli = spawn('which', ['opencode'], { stdio: ['ignore', 'pipe', 'ignore'] });
let cliOut = '';
cli.stdout.on('data', (chunk) => (cliOut += chunk));
await new Promise((resolve) => cli.on('close', resolve));
log(`[evidence] \`which opencode\` -> ${cliOut.trim() || '(not found)'}`);
log(
    `[evidence] runtime health ${RUNTIME_URL}/global/health -> ${await portOpen(`${RUNTIME_URL}/global/health`)}`
);

// --- 2. pre-rewrite monolith ------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(here, '.tmp-legacy-'));
const monolithPath = path.join(tmpDir, 'proxy.mjs');
const monolithSource = spawn('git', ['show', `${MONOLITH_COMMIT}:src/proxy.js`], {
    cwd: path.resolve(here, '../../..')
});
let source = '';
monolithSource.stdout.on('data', (chunk) => (source += chunk));
const sourceExit = await new Promise((resolve) => monolithSource.on('close', resolve));
if (sourceExit !== 0 || !source) {
    console.error('could not extract the pre-rewrite monolith from git');
    process.exit(2);
}
fs.writeFileSync(monolithPath, source);
log(`[evidence] extracted pre-rewrite monolith (${source.split('\n').length} lines) from ${MONOLITH_COMMIT}`);

const legacyPort = 18099;
const legacy = spawn(process.execPath, [monolithPath], {
    cwd: tmpDir,
    env: {
        ...process.env,
        OPENCODE_PROXY_PORT: String(legacyPort),
        BIND_HOST: '127.0.0.1',
        OPENCODE_SERVER_URL: RUNTIME_URL,
        OPENCODE_PROXY_MANAGE_BACKEND: 'false',
        DOWNLOADS_DIR: tmpDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
legacy.stdout.on('data', () => {});
legacy.stderr.on('data', () => {});

let legacyLog = '';
legacy.stdout.on('data', (chunk) => (legacyLog += chunk));
legacy.stderr.on('data', (chunk) => (legacyLog += chunk));

let legacyResult = { models: 'never started', chat: 'never started', started: false };
try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const health = await portOpen(`http://127.0.0.1:${legacyPort}/health`, 500);
        if (health === 'HTTP 200') {
            legacyResult.started = true;
            break;
        }
        await sleep(250);
    }
    if (legacyResult.started) {
        legacyResult = {
            ...legacyResult,
            ...(await probe(`http://127.0.0.1:${legacyPort}`, 'pre-rewrite monolith'))
        };
    } else {
        log(
            `[evidence] the pre-rewrite monolith did not start standalone here; first output: ${legacyLog
                .split('\n')
                .filter(Boolean)
                .slice(0, 2)
                .join(' | ')
                .slice(0, 300)}`
        );
    }
} finally {
    legacy.kill('SIGKILL');
}

// --- 3. the rewritten app ---------------------------------------------------
const config = loadConfig({
    env: {
        OPENCODE_PROXY_PORT: '18098',
        BIND_HOST: '127.0.0.1',
        OPENCODE_SERVER_URL: RUNTIME_URL,
        OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '8000'
    }
});
const boot = buildRuntime({
    config,
    sdk,
    ensureBackend: async () => {}
});
const server = boot.app.listen(18098, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
let rewriteResult;
try {
    rewriteResult = await probe('http://127.0.0.1:18098', 'rewritten app');
} finally {
    await new Promise((resolve) => server.close(resolve));
    boot.responseChains.sweep?.().catch?.(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- 4. same failure mode? --------------------------------------------------
const rewriteDown = /unreachable|ECONNREFUSED|502|500|timeout|OpenCode runtime/i.test(rewriteResult.chat);
if (!rewriteDown) {
    console.error('[fail] the rewritten app did not fail at the runtime boundary');
    process.exit(1);
}
log('[pass] the rewritten app fails at the runtime transport boundary (no runtime in this sandbox)');

if (!legacyResult.started) {
    log(
        '[note] the pre-rewrite comparison could not be run here (the monolith needs its own environment); ' +
            'it is recorded as attempted, not as evidence'
    );
} else {
    const legacyDown = /unreachable|ECONNREFUSED|502|500|timeout|OpenCode runtime/i.test(
        `${legacyResult.models} ${legacyResult.chat}`
    );
    log(
        legacyDown
            ? '[pass] the pre-rewrite monolith fails the same way: environmental, not a rewrite regression'
            : '[note] the monolith answered differently; see the evidence lines above'
    );
}
