/**
 * Direct upstream client: request construction, body pass-through and
 * **verbatim** relaying of upstream errors.
 *
 * Reference: `docs/en/api-reference.md` "Upstream selection" ("the upstream's
 * status codes and bodies are relayed verbatim") and BEHAVIOUR-SPEC §5.
 *
 * The point of the error probes: the client must not re-encode, re-shape or
 * taxonomy-wrap an upstream failure. Fallback is a caller decision
 * (`router.allowsFallback()`), never something the client applies on its own.
 */

import { createConversationRegistry } from '../../../src/conversation/registry.js';
import {
    createDirectUpstream,
    buildDirectHeaders,
    joinUrl,
    newRequestId,
    newSessionId,
    requestUpstream
} from '../../../src/upstreams/direct-client.js';
import { createUpstreamRouter } from '../../../src/upstreams/router.js';
import { createFakeClock, readBody, startStubServer, userText } from './fixtures.js';

const openStubs = [];

afterEach(async () => {
    while (openStubs.length) {
        await openStubs.pop().close();
    }
});

async function stub(handler) {
    const server = await startStubServer(handler);
    openStubs.push(server);
    return server;
}

const idleHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
};

describe('buildDirectHeaders', () => {
    test('sends exactly the documented official-client fingerprint', () => {
        const headers = buildDirectHeaders({
            apiKey: 'k',
            sessionId: 'ses-1',
            requestId: 'msg_deadbeef'
        });

        expect(headers['x-opencode-client']).toBe('cli');
        expect(headers['x-opencode-project']).toBe('global');
        expect(headers['x-opencode-session']).toBe('ses-1');
        expect(headers['x-opencode-request']).toBe('msg_deadbeef');
        expect(headers.authorization).toBe('Bearer k');
        expect(headers['user-agent']).toMatch(/^opencode\//);
        expect(headers['content-type']).toBe('application/json');
        expect(headers.accept).toContain('text/event-stream');
    });

    test('omits the identity headers when there is nothing to carry', () => {
        const headers = buildDirectHeaders({});
        expect(headers).not.toHaveProperty('authorization');
        expect(headers).not.toHaveProperty('x-opencode-session');
        expect(headers).not.toHaveProperty('x-opencode-request');
    });

    test('extra headers cannot displace the identity headers', () => {
        const headers = buildDirectHeaders({
            apiKey: 'real',
            sessionId: 'ses-real',
            requestId: 'msg_real',
            extraHeaders: {
                authorization: 'Bearer evil',
                'x-opencode-session': 'ses-evil',
                'x-opencode-request': 'msg_evil'
            }
        });
        expect(headers.authorization).toBe('Bearer real');
        expect(headers['x-opencode-session']).toBe('ses-real');
        expect(headers['x-opencode-request']).toBe('msg_real');
    });

    test('generated ids match the shapes the official client sends', () => {
        expect(newRequestId()).toMatch(/^msg_[0-9a-f]{24}$/);
        expect(newSessionId()).toMatch(/^ses_[0-9a-f]{24}$/);
    });

    test('joinUrl never doubles or drops a slash', () => {
        expect(joinUrl('https://x/zen/v1', '/chat/completions')).toBe('https://x/zen/v1/chat/completions');
        expect(joinUrl('https://x/zen/v1///', '/chat/completions')).toBe('https://x/zen/v1/chat/completions');
    });
});

describe('requestUpstream', () => {
    test('POSTs the JSON body with the bearer key to the joined path', async () => {
        const server = await stub(idleHandler);
        const response = await requestUpstream({
            baseUrl: server.url,
            path: '/chat/completions',
            apiKey: 'secret-key',
            sessionId: 'ses-42',
            requestId: 'msg_42',
            body: { model: 'm', messages: [userText('hi')] }
        });

        expect(response.status).toBe(200);
        await response.text();

        expect(server.requests).toHaveLength(1);
        const request = server.requests[0];
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/chat/completions');
        expect(request.headers.authorization).toBe('Bearer secret-key');
        expect(request.headers['x-opencode-session']).toBe('ses-42');
        expect(JSON.parse(request.body)).toEqual({ model: 'm', messages: [userText('hi')] });
    });

    test('an already-aborted caller signal rejects instead of sending', async () => {
        const server = await stub(idleHandler);
        const controller = new AbortController();
        controller.abort();

        await expect(
            requestUpstream({
                baseUrl: server.url,
                path: '/chat/completions',
                body: {},
                signal: controller.signal
            })
        ).rejects.toThrow();
    });
});

describe('createDirectUpstream', () => {
    const makeDirect = async (config = {}) => {
        const server = await stub(idleHandler);
        const direct = createDirectUpstream({
            config: {
                ZEN_API_KEY: 'verify-key',
                DIRECT_GO_BASE_URL: `${server.url}/zen/go/v1`,
                DIRECT_ZEN_BASE_URL: `${server.url}/zen/v1`,
                ...config
            },
            fetch: globalThis.fetch
        });
        return { server, direct };
    };

    test('passes the client body through, only pinning model and stream', async () => {
        const { server, direct } = await makeDirect();
        const clientBody = {
            messages: [userText('Q1')],
            temperature: 0.7,
            top_p: 0.9,
            tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }],
            tool_choice: 'auto'
        };

        await (
            await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: clientBody,
                stream: true,
                sessionId: 'ses-passthrough'
            })
        ).text();

        const sent = JSON.parse(server.requests[0].body);
        expect(sent.model).toBe('big-pickle');
        expect(sent.stream).toBe(true);
        expect(sent.messages).toEqual(clientBody.messages);
        expect(sent.temperature).toBe(0.7);
        expect(sent.top_p).toBe(0.9);
        expect(sent.tools).toEqual(clientBody.tools);
        expect(sent.tool_choice).toBe('auto');
        // The client-facing provider/model name never leaks upstream.
        expect(JSON.stringify(sent)).not.toContain('opencode/big-pickle');
    });

    test('an omitted stream flag is sent as a boolean, not left undefined', async () => {
        const { server, direct } = await makeDirect();
        await (
            await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: { messages: [userText('Q1')] },
                sessionId: 'ses-stream'
            })
        ).text();
        expect(JSON.parse(server.requests[0].body).stream).toBe(false);
    });

    test('responses() targets /responses on the same base', async () => {
        const { server, direct } = await makeDirect();
        await (
            await direct.responses({
                providerID: 'opencode-go',
                modelID: 'glm-5',
                body: { input: 'hi' },
                sessionId: 'ses-responses'
            })
        ).text();
        expect(server.requests[0].url).toBe('/zen/go/v1/responses');
    });
});

describe('upstream errors are relayed verbatim', () => {
    const rawBodies = {
        403: '{\n  "type": "error",\n  "error": { "type": "FreeTierError", "message": "free tier can only be used with the official client" }\n}\n',
        401: '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}',
        500: 'upstream exploded: not even JSON'
    };

    const cases = Object.entries(rawBodies);

    test.each(cases)('a %s failure is byte-identical on the client side', async (status, rawBody) => {
        const server = await stub((req, res) => {
            res.writeHead(Number(status), {
                'content-type': 'application/json',
                'x-upstream-trace': 'trace-abc'
            });
            res.end(rawBody);
        });
        const direct = createDirectUpstream({
            config: {
                ZEN_API_KEY: 'verify-key',
                DIRECT_ZEN_BASE_URL: `${server.url}/zen/v1`
            },
            fetch: globalThis.fetch
        });

        const response = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'big-pickle',
            body: { messages: [userText('Q1')] },
            stream: false,
            sessionId: 'ses-error'
        });

        expect(response.status).toBe(Number(status));
        expect(response.headers.get('x-upstream-trace')).toBe('trace-abc');
        expect(await readBody(response)).toBe(rawBody);
    });

    test('a 403 FreeTierError classifies as free-tier without altering the body', async () => {
        const rawBody = rawBodies[403];
        const server = await stub((req, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(rawBody);
        });
        const direct = createDirectUpstream({
            config: { ZEN_API_KEY: 'verify-key', DIRECT_ZEN_BASE_URL: `${server.url}/zen/v1` },
            fetch: globalThis.fetch
        });

        const response = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'm',
            body: {},
            sessionId: 'ses-free'
        });
        const bodyText = await readBody(response);
        expect(direct.classify(response, bodyText)).toBe('free-tier');
        expect(bodyText).toBe(rawBody);
    });

    test('with DIRECT_FALLBACK_TO_RUNTIME=false the client still relays the raw error', async () => {
        const rawBody = rawBodies[403];
        const server = await stub((req, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(rawBody);
        });
        const config = {
            ZEN_API_KEY: 'verify-key',
            DIRECT_ZEN_BASE_URL: `${server.url}/zen/v1`,
            DIRECT_FALLBACK_TO_RUNTIME: false,
            REQUEST_TIMEOUT_MS: 2_000
        };
        const direct = createDirectUpstream({ config, fetch: globalThis.fetch });
        const registry = createConversationRegistry({
            config,
            clock: createFakeClock(),
            sessionBackend: null,
            deleteSession: async () => {},
            lockTimeoutMs: 50
        });
        const router = createUpstreamRouter({ config, direct, runtime: {}, registry });

        expect(router.allowsFallback()).toBe(false);

        const response = await direct.chatCompletion({
            providerID: 'opencode',
            modelID: 'm',
            body: {},
            sessionId: 'ses-nofallback'
        });
        expect(response.status).toBe(403);
        expect(await readBody(response)).toBe(rawBody);
    });
});
