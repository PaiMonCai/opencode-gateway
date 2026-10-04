import {
    DEFAULT_CLIENT_VERSION,
    buildDirectHeaders,
    classifyDirectFailure,
    collectSseDeltaText,
    createDirectUpstream,
    extractAssistantText,
    isDirectAuthFailure,
    isFreeTierRefusal,
    newRequestId,
    newSessionId,
    requestUpstream,
    resolveBaseUrlForProvider,
    rewriteModelFields,
    rewriteSseModel
} from '../../../src/upstreams/direct-client.js';
import { collectText, startStub } from './helpers.js';

/**
 * Direct upstream: the outbound request itself (fingerprint headers, path,
 * model mapping, body passthrough) and the inbound relay (verbatim errors, SSE
 * `model` rewriting, free-tier detection). Everything runs against a stub HTTP
 * server on an ephemeral port.
 */
describe('buildDirectHeaders', () => {
    test('sends the official client fingerprint', () => {
        const headers = buildDirectHeaders({});

        expect(headers['user-agent']).toContain(`opencode/${DEFAULT_CLIENT_VERSION}`);
        expect(headers['user-agent']).toContain('ai-sdk/provider-utils');
        expect(headers['x-opencode-client']).toBe('cli');
        expect(headers['x-opencode-project']).toBe('global');
        expect(headers['content-type']).toBe('application/json');
        expect(headers.accept).toBe('application/json, text/event-stream');
    });

    test('adds the identity headers only when present', () => {
        const bare = buildDirectHeaders({ apiKey: '', sessionId: null, requestId: null });
        expect(bare.authorization).toBeUndefined();
        expect(bare['x-opencode-session']).toBeUndefined();
        expect(bare['x-opencode-request']).toBeUndefined();

        const full = buildDirectHeaders({ apiKey: 'k', sessionId: 'ses_1', requestId: 'msg_1' });
        expect(full.authorization).toBe('Bearer k');
        expect(full['x-opencode-session']).toBe('ses_1');
        expect(full['x-opencode-request']).toBe('msg_1');
    });

    test('extra headers can override the fingerprint but never the identity headers', () => {
        const headers = buildDirectHeaders({
            apiKey: 'k',
            sessionId: 'ses_1',
            requestId: 'msg_1',
            extraHeaders: {
                authorization: 'Bearer nope',
                'x-opencode-session': 'nope',
                'x-opencode-request': 'nope',
                'x-opencode-client': 'custom'
            }
        });

        expect(headers['x-opencode-client']).toBe('custom');
        expect(headers.authorization).toBe('Bearer k');
        expect(headers['x-opencode-session']).toBe('ses_1');
        expect(headers['x-opencode-request']).toBe('msg_1');
    });

    test('request and session ids look like the official client sends', () => {
        expect(newRequestId()).toMatch(/^msg_[0-9a-f]{24}$/);
        expect(newSessionId()).toMatch(/^ses_[0-9a-f]{24}$/);
        expect(newRequestId()).not.toBe(newRequestId());
    });
});

describe('resolveBaseUrlForProvider', () => {
    test('maps opencode-go to the Go endpoint and everything else to Zen', () => {
        expect(resolveBaseUrlForProvider('opencode-go')).toBe('https://opencode.ai/zen/go/v1');
        expect(resolveBaseUrlForProvider('opencode')).toBe('https://opencode.ai/zen/v1');
        expect(resolveBaseUrlForProvider('OPENCODE-GO')).toBe('https://opencode.ai/zen/go/v1');
    });

    test('honours configured base URLs', () => {
        expect(
            resolveBaseUrlForProvider('opencode', {
                goBaseUrl: 'http://go.test/v1',
                zenBaseUrl: 'http://zen.test/v1'
            })
        ).toBe('http://zen.test/v1');
    });
});

describe('free-tier detection', () => {
    test('recognises the upstream refusal body', () => {
        expect(isFreeTierRefusal(403, '{"error":{"type":"FreeTierError"}}')).toBe(true);
        expect(isFreeTierRefusal(403, 'free tier can only be used from within OpenCode')).toBe(true);
        expect(isFreeTierRefusal(403, '{"error":"forbidden"}')).toBe(false);
        expect(isFreeTierRefusal(401, 'FreeTierError')).toBe(false);
    });

    test('classifies the fallback reason', () => {
        expect(classifyDirectFailure(403, 'FreeTierError')).toBe('free-tier');
        expect(classifyDirectFailure(401, 'Invalid API key.')).toBe('auth');
        expect(classifyDirectFailure(403, 'plain forbidden')).toBe('auth');
        expect(classifyDirectFailure(429, 'rate limited')).toBeNull();
        expect(isDirectAuthFailure(401)).toBe(true);
        expect(isDirectAuthFailure(403)).toBe(true);
        expect(isDirectAuthFailure(500)).toBe(false);
    });
});

describe('rewriteModelFields', () => {
    test('rewrites both the chat model and the nested response model', () => {
        const payload = { model: 'bare', response: { model: 'bare', id: 'resp_1' } };

        expect(rewriteModelFields(payload, 'opencode/big-pickle')).toBe(true);
        expect(payload.model).toBe('opencode/big-pickle');
        expect(payload.response.model).toBe('opencode/big-pickle');
    });

    test('reports nothing to rewrite when neither field exists', () => {
        expect(rewriteModelFields({ id: 'x' }, 'm')).toBe(false);
        expect(rewriteModelFields(null, 'm')).toBe(false);
    });
});

describe('rewriteSseModel', () => {
    const streamOf = (text) =>
        (async function* stream() {
            yield Buffer.from(text, 'utf8');
        })();

    test('rewrites chat chunk models and leaves everything else alone', async () => {
        const input = [
            'data: {"id":"c1","model":"bare","choices":[{"delta":{"content":"hi"}}]}\n\n',
            'data: [DONE]\n\n'
        ].join('');

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/big-pickle'));

        expect(output).toContain('"model":"opencode/big-pickle"');
        expect(output).toContain('"content":"hi"');
        expect(output).toContain('data: [DONE]\n\n');
    });

    test('rewrites the nested model of Responses events', async () => {
        const input =
            'data: {"type":"response.output_text.delta","delta":"a","response":{"model":"bare","id":"r1"}}\n\n';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/big-pickle'));

        expect(JSON.parse(output.slice(5).trim()).response.model).toBe('opencode/big-pickle');
    });

    test('passes non-JSON records and keepalives through byte-for-byte', async () => {
        const input = ': ping\n\ndata: not-json\n\n';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/x'));

        expect(output).toBe(input);
    });

    test('buffers records split across chunk boundaries', async () => {
        const chunks = ['data: {"model":"ba', 're","choices":[]}', '\n\n'];
        const stream = (async function* split() {
            for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
        })();

        const output = await collectText(rewriteSseModel(stream, 'opencode/x'));

        expect(output).toBe('data: {"model":"opencode/x","choices":[]}\n\n');
    });

    test('flushes a truncated tail record without synthesizing a separator', async () => {
        const input = 'data: {"model":"bare","choices":[]}';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/x'));

        expect(output).toBe('data: {"model":"opencode/x","choices":[]}');
        expect(output.endsWith('\n\n')).toBe(false);
    });

    test('rewrites every record of a CRLF stream and keeps the separator bytes', async () => {
        const input = 'data: {"model":"up-1","id":"a"}\r\n\r\n' + 'data: {"model":"up-2","id":"b"}\r\n\r\n';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/asked'));

        // Both records rewritten, `\r\n\r\n` preserved byte-for-byte.
        expect(output).toBe(
            'data: {"model":"opencode/asked","id":"a"}\r\n\r\n' +
                'data: {"model":"opencode/asked","id":"b"}\r\n\r\n'
        );
        expect(output).not.toContain('"model":"up-');
    });

    test('rewrites a single CRLF record without altering its framing', async () => {
        const input = 'data: {"model":"up-1","id":"a"}\r\n\r\n';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/asked'));

        expect(output).toBe('data: {"model":"opencode/asked","id":"a"}\r\n\r\n');
    });

    test('handles a mixed LF, CRLF and CR stream', async () => {
        const input =
            'data: {"model":"up-1"}\n\n' + 'data: {"model":"up-2"}\r\n\r\n' + 'data: {"model":"up-3"}\r\r';

        const output = await collectText(rewriteSseModel(streamOf(input), 'opencode/asked'));

        expect(output).toBe(
            'data: {"model":"opencode/asked"}\n\n' +
                'data: {"model":"opencode/asked"}\r\n\r\n' +
                'data: {"model":"opencode/asked"}\r\r'
        );
    });

    test('buffers a CRLF separator split across chunk boundaries', async () => {
        const chunks = ['data: {"model":"up-1"}\r\n\r', '\ndata: {"model":"up-2"}\r\n\r\n'];
        const stream = (async function* split() {
            for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
        })();

        const output = await collectText(rewriteSseModel(stream, 'opencode/asked'));

        expect(output).toBe(
            'data: {"model":"opencode/asked"}\r\n\r\n' + 'data: {"model":"opencode/asked"}\r\n\r\n'
        );
    });

    test('preserves the exact trailing bytes of a tail record', async () => {
        const output = await collectText(rewriteSseModel(streamOf('data: {"model":"bare"}\n'), 'opencode/x'));

        expect(output).toBe('data: {"model":"opencode/x"}\n');
    });

    test('keeps the framing of a completed record ending with a single blank line', async () => {
        const output = await collectText(
            rewriteSseModel(streamOf('data: {"model":"bare"}\n\n'), 'opencode/x')
        );

        expect(output).toBe('data: {"model":"opencode/x"}\n\n');
    });
});

describe('collectSseDeltaText / extractAssistantText', () => {
    test('fingerprints chat and Responses deltas', () => {
        expect(collectSseDeltaText(Buffer.from('data: {"choices":[{"delta":{"content":"ab"}}]}\n\n'))).toBe(
            'ab'
        );
        expect(
            collectSseDeltaText(Buffer.from('data: {"type":"response.output_text.delta","delta":"cd"}\n\n'))
        ).toBe('cd');
        expect(collectSseDeltaText(Buffer.from('data: [DONE]\n\n'))).toBe('');
        expect(collectSseDeltaText('event: x\n')).toBe('');
    });

    test('reads both non-streaming dialects', () => {
        expect(extractAssistantText({ choices: [{ message: { content: 'chat' } }] })).toBe('chat');
        expect(extractAssistantText({ output: [{ content: [{ text: 'res' }, { text: 'ponses' }] }] })).toBe(
            'responses'
        );
        expect(extractAssistantText({ id: 'x' })).toBeNull();
    });
});

describe('requestUpstream', () => {
    test('posts the body to the joined path with a bearer key', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
        try {
            const response = await requestUpstream({
                baseUrl: `${stub.baseUrl}/zen/v1/`,
                path: '/chat/completions',
                apiKey: 'secret',
                sessionId: 'ses_1',
                requestId: 'msg_1',
                body: { model: 'bare', messages: [] }
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true });
            expect(stub.requests).toHaveLength(1);
            const [request] = stub.requests;
            expect(request.method).toBe('POST');
            expect(request.url).toBe('/zen/v1/chat/completions');
            expect(request.headers.authorization).toBe('Bearer secret');
            expect(request.headers['x-opencode-session']).toBe('ses_1');
            expect(request.headers['x-opencode-request']).toBe('msg_1');
            expect(request.headers['user-agent']).toContain('opencode/');
            expect(request.body).toEqual({ model: 'bare', messages: [] });
        } finally {
            await stub.close();
        }
    });

    test('aborts the fetch when the caller signal fires', async () => {
        const stub = await startStub(() => {
            // Never respond: the abort has to end the request.
        });
        try {
            const controller = new AbortController();
            const pending = requestUpstream({
                baseUrl: stub.baseUrl,
                path: '/chat/completions',
                body: {},
                signal: controller.signal
            });
            controller.abort();

            await expect(pending).rejects.toThrow();
        } finally {
            await stub.close();
        }
    });
});

describe('createDirectUpstream', () => {
    const respondingStub = (body = '{}', status = 200, contentType = 'application/json') =>
        startStub((_req, res) => {
            res.writeHead(status, { 'content-type': contentType });
            res.end(body);
        });

    test('sends chat completions to Zen with the bare model and boolean stream', async () => {
        const stub = await respondingStub('{"model":"bare"}');
        try {
            const direct = createDirectUpstream({
                config: {
                    ZEN_API_KEY: 'key',
                    DIRECT_ZEN_BASE_URL: stub.baseUrl,
                    DIRECT_GO_BASE_URL: stub.baseUrl
                }
            });

            const response = await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 },
                stream: undefined,
                sessionId: 'ses_abc'
            });

            expect(response.status).toBe(200);
            const [request] = stub.requests;
            expect(request.url).toBe('/chat/completions');
            expect(request.headers['x-opencode-session']).toBe('ses_abc');
            expect(request.headers.authorization).toBe('Bearer key');
            // The body passes through untouched except for model/stream.
            expect(request.body).toEqual({
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.3,
                model: 'big-pickle',
                stream: false
            });
        } finally {
            await stub.close();
        }
    });

    test('routes opencode-go to the Go base URL', async () => {
        const stub = await respondingStub();
        try {
            const direct = createDirectUpstream({
                config: {
                    ZEN_API_KEY: 'key',
                    DIRECT_GO_BASE_URL: `${stub.baseUrl}/go`,
                    DIRECT_ZEN_BASE_URL: `${stub.baseUrl}/zen`
                }
            });

            await direct.responses({
                providerID: 'opencode-go',
                modelID: 'kimi-k3',
                body: { input: 'x' },
                sessionId: 'ses_g'
            });

            expect(stub.requests[0].url).toBe('/go/responses');
            expect(stub.requests[0].body.input).toBe('x');
        } finally {
            await stub.close();
        }
    });

    test('relays upstream errors verbatim', async () => {
        const upstreamError = '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}';
        const stub = await respondingStub(upstreamError, 401);
        try {
            const direct = createDirectUpstream({
                config: { ZEN_API_KEY: 'bad', DIRECT_ZEN_BASE_URL: stub.baseUrl }
            });

            const response = await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: {},
                sessionId: 'ses_1'
            });

            expect(response.status).toBe(401);
            expect(await response.text()).toBe(upstreamError);
            expect(direct.classify(response, upstreamError)).toBe('auth');
        } finally {
            await stub.close();
        }
    });

    test('detects a free-tier refusal from the response body', async () => {
        const stub = await respondingStub('{"error":{"type":"FreeTierError"}}', 403);
        try {
            const direct = createDirectUpstream({
                config: { ZEN_API_KEY: 'key', DIRECT_ZEN_BASE_URL: stub.baseUrl }
            });

            const response = await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: {},
                sessionId: 'ses_1'
            });

            expect(direct.classify(response, await response.text())).toBe('free-tier');
        } finally {
            await stub.close();
        }
    });

    test('reports credentials and provider support', () => {
        const withKey = createDirectUpstream({ config: { ZEN_API_KEY: 'key' } });
        const withoutKey = createDirectUpstream({ config: {} });

        expect(withKey.hasCredentials()).toBe(true);
        expect(withoutKey.hasCredentials()).toBe(false);
        expect(
            createDirectUpstream({ config: { ZEN_API_KEY: 'k', DIRECT_ENABLED: 'false' } }).hasCredentials()
        ).toBe(false);
        expect(withKey.supports('opencode')).toBe(true);
        expect(withKey.supports('opencode-go')).toBe(true);
        expect(withKey.supports('anthropic')).toBe(false);
    });

    test('rewrites the SSE model of a streamed answer', async () => {
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"model":"bare","choices":[{"delta":{"content":"hel"}}]}\n\n');
            res.write('data: {"model":"bare","choices":[{"delta":{"content":"lo"}}]}\n\n');
            res.end('data: [DONE]\n\n');
        });
        try {
            const direct = createDirectUpstream({
                config: { ZEN_API_KEY: 'key', DIRECT_ZEN_BASE_URL: stub.baseUrl }
            });

            const response = await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: { messages: [] },
                stream: true,
                sessionId: 'ses_1'
            });
            const relayed = await collectText(rewriteSseModel(response.body, 'opencode/big-pickle'));

            expect(relayed).toContain('"model":"opencode/big-pickle"');
            expect(relayed).not.toContain('"model":"bare"');
            expect(relayed).toContain('data: [DONE]\n\n');
        } finally {
            await stub.close();
        }
    });

    test('relays an upstream stream that ends without a blank line byte-for-byte', async () => {
        const upstreamBytes =
            'data: {"model":"bare","choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: {"model":"bare","choices":[],"usage":{"total_tokens":1}}';
        const stub = await startStub((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(upstreamBytes);
        });
        try {
            const direct = createDirectUpstream({
                config: { ZEN_API_KEY: 'key', DIRECT_ZEN_BASE_URL: stub.baseUrl }
            });

            const response = await direct.chatCompletion({
                providerID: 'opencode',
                modelID: 'big-pickle',
                body: { messages: [] },
                stream: true,
                sessionId: 'ses_1'
            });
            const relayed = await collectText(rewriteSseModel(response.body, 'opencode/big-pickle'));

            // Only the model names change; the missing blank line is not filled in.
            expect(relayed).toBe(upstreamBytes.replaceAll('"model":"bare"', '"model":"opencode/big-pickle"'));
            expect(relayed.endsWith('"usage":{"total_tokens":1}}')).toBe(true);
        } finally {
            await stub.close();
        }
    });
});
