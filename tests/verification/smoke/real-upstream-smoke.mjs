/**
 * Real-upstream smoke (NOT part of CI: it needs the network).
 *
 * Drives the assembled app's direct path against the real OpenCode Zen
 * endpoints with a deliberately invalid key, to confirm that the upstream's
 * native error surface reaches the client byte-for-byte and bypasses the
 * gateway's taxonomy.
 *
 * Usage: `node tests/verification/smoke/real-upstream-smoke.mjs`
 * Exits non-zero on failure and prints one evidence line per observation.
 */

import assert from 'node:assert/strict';

import { createAssembly } from '../contract/harness.js';

const DUMMY_KEY = 'dummy-invalid-key-for-verification';
const GO_URL = 'https://opencode.ai/zen/go/v1';
const ZEN_URL = 'https://opencode.ai/zen/v1';

const lines = [];
const log = (message) => {
    lines.push(message);
    console.log(message);
};

const assembly = await createAssembly({
    env: {
        OPENCODE_ZEN_API_KEY: DUMMY_KEY,
        OPENCODE_PROXY_DIRECT_GO_URL: GO_URL,
        OPENCODE_PROXY_DIRECT_ZEN_URL: ZEN_URL,
        // No runtime exists in this sandbox: a fallback would mask the relay.
        OPENCODE_PROXY_DIRECT_FALLBACK: 'false'
    },
    runtime: {
        models: {
            'opencode-go': { 'glm-5': { name: 'GLM-5' } },
            opencode: { 'big-pickle': { name: 'Big Pickle' } }
        }
    }
});

try {
    // Fetch the upstream body independently, for a byte-level comparison.
    const upstream = await fetch(`${GO_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
        body: JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'ping' }] })
    });
    const upstreamText = await upstream.text();
    log(`[evidence] direct upstream ${GO_URL}/chat/completions -> ${upstream.status}`);
    log(`[evidence] upstream body bytes: ${JSON.stringify(upstreamText)}`);

    const res = await assembly.http
        .post('/v1/chat/completions')
        .send({ model: 'opencode-go/glm-5', messages: [{ role: 'user', content: 'ping' }] });

    log(`[evidence] gateway -> ${res.status}, content-type=${res.headers['content-type']}`);
    log(`[evidence] gateway body bytes: ${JSON.stringify(res.text)}`);

    assert.equal(res.status, upstream.status, 'status must be relayed verbatim');
    assert.equal(res.text, upstreamText, 'body must be relayed byte-for-byte');
    assert.match(res.text, /"type":"AuthError"/, 'the upstream error type must survive');

    const requests = assembly.directRequests;
    assert.equal(requests.length, 0, 'the real upstream is not the local stub');
    log('[pass] real direct upstream: status and body relayed byte-for-byte, no taxonomy rewrite');
} finally {
    await assembly.close();
}
