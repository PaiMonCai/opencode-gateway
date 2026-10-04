/**
 * BEHAVIOUR-SPEC §5 — upstream routing and direct-mode passthrough, verified
 * through the assembled app against a local stub upstream (port 0).
 *
 * Routing table authority: `docs/en/api-reference.md` "Upstream selection".
 */

import { createAssembly, defaultDirectHandler } from './harness.js';

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

const DIRECT_ENV = { OPENCODE_ZEN_API_KEY: 'dummy-key' };
const USER = { role: 'user', content: 'Hello' };

describe('§5 routing matrix', () => {
    test('with no upstream key every model stays on the runtime', async () => {
        const { http, fake, directRequests } = await assembly();
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode-go/glm-5', messages: [USER] });

        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe('Runtime answer');
        expect(fake.calls.prompts).toHaveLength(1);
        expect(directRequests).toHaveLength(0);
    });

    test('opencode-go goes direct to the Go endpoint with the official fingerprint', async () => {
        const { http, fake, directRequests } = await assembly({ env: DIRECT_ENV });
        const headers = { 'x-opencode-session': 'conv-go' };
        const res = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({ model: 'opencode-go/glm-5', messages: [USER] });

        expect(res.status).toBe(200);
        expect(fake.calls.created).toHaveLength(0);
        expect(directRequests).toHaveLength(1);
        const request = directRequests[0];
        expect(request.url).toBe('/zen/go/v1/chat/completions');
        expect(request.headers.authorization).toBe('Bearer dummy-key');
        // A direct conversation carries its own `ses_...` label upstream, and the
        // same label on every turn of that conversation (invariant 1).
        expect(request.headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{24}$/);
        expect(request.headers['x-opencode-request']).toMatch(/^msg_[0-9a-f]+$/);
        expect(request.headers['x-opencode-client']).toBe('cli');
        expect(request.headers['x-opencode-project']).toBe('global');
        expect(request.headers['user-agent']).toMatch(/^opencode\//);
        expect(JSON.parse(request.body).model).toBe('glm-5');
        // The client-facing model name is restored on the way back.
        expect(res.body.model).toBe('opencode-go/glm-5');
        expect(res.body.choices[0].message.content).toBe('Direct answer');

        const second = await http
            .post('/v1/chat/completions')
            .set(headers)
            .send({
                model: 'opencode-go/glm-5',
                messages: [
                    USER,
                    { role: 'assistant', content: 'Direct answer' },
                    { role: 'user', content: 'more' }
                ]
            });
        expect(second.status).toBe(200);
        expect(directRequests[1].headers['x-opencode-session']).toBe(
            directRequests[0].headers['x-opencode-session']
        );
    });

    test('paid opencode goes direct to the Zen endpoint', async () => {
        const { http, directRequests } = await assembly({ env: DIRECT_ENV });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        expect(directRequests[0].url).toBe('/zen/v1/chat/completions');
        expect(JSON.parse(directRequests[0].body).model).toBe('big-pickle');
        expect(res.body.model).toBe('opencode/big-pickle');
    });

    test('a -free model stays on the runtime even with a key configured', async () => {
        const { http, fake, directRequests } = await assembly({ env: DIRECT_ENV });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/mystery-free', messages: [USER] });

        expect(res.status).toBe(200);
        expect(fake.calls.prompts).toHaveLength(1);
        expect(directRequests).toHaveLength(0);
    });

    test('DIRECT_ENABLED=false keeps everything on the runtime', async () => {
        const { http, fake, directRequests } = await assembly({
            env: { ...DIRECT_ENV, OPENCODE_PROXY_DIRECT: 'false' }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(200);
        expect(fake.calls.prompts).toHaveLength(1);
        expect(directRequests).toHaveLength(0);
    });

    test('DIRECT_FREE_VIA_RUNTIME=false lets a -free model go direct', async () => {
        const { http, directRequests } = await assembly({
            env: { ...DIRECT_ENV, OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME: 'false' }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/mystery-free', messages: [USER] });

        expect(res.status).toBe(200);
        expect(directRequests).toHaveLength(1);
        expect(directRequests[0].url).toBe('/zen/v1/chat/completions');
    });

    test('a plain direct 402/429/500 is relayed verbatim, not taxonomy-wrapped', async () => {
        const bodies = {
            402: {
                body: '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance"}}',
                contentType: 'application/json'
            },
            429: {
                body: '{"error":{"message":"rate limit reached for this key"}}',
                contentType: 'application/json'
            },
            500: { body: 'upstream exploded: plain text', contentType: 'text/plain' }
        };

        for (const [status, { body, contentType }] of Object.entries(bodies)) {
            const { http, directRequests } = await assembly({
                env: DIRECT_ENV,
                directHandler: (req, res) => {
                    res.writeHead(Number(status), { 'content-type': contentType });
                    res.end(body);
                }
            });
            const res = await http
                .post('/v1/chat/completions')
                .send({ model: 'opencode/big-pickle', messages: [USER] });

            expect(res.status).toBe(Number(status));
            expect(res.text).toBe(body);
            expect(directRequests).toHaveLength(1);
        }
    });

    test('401/403 are relayed verbatim when DIRECT_FALLBACK_TO_RUNTIME=false', async () => {
        const upstreamBody = '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}';
        const { http, fake } = await assembly({
            env: { ...DIRECT_ENV, OPENCODE_PROXY_DIRECT_FALLBACK: 'false' },
            directHandler: (req, res) => {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(upstreamBody);
            }
        });

        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(401);
        expect(res.text).toBe(upstreamBody);
        expect(fake.calls.prompts).toHaveLength(0); // no runtime attempt
    });

    test('a 403 FreeTierError falls back to the runtime for that turn and is learned', async () => {
        const freeTierBody =
            '{"type":"error","error":{"type":"FreeTierError","message":"free tier can only be used with the official client"}}';
        const { http, fake, directRequests } = await assembly({
            env: DIRECT_ENV,
            directHandler: (req, res) => {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(freeTierBody);
            }
        });

        const first = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });
        expect(first.status).toBe(200); // served by the runtime fallback
        expect(first.body.choices[0].message.content).toBe('Runtime answer');
        expect(directRequests).toHaveLength(1);
        const directCallsAfterFirst = directRequests.length;

        const second = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });
        expect(second.status).toBe(200);
        // Learned: the second turn goes straight to the runtime.
        expect(directRequests).toHaveLength(directCallsAfterFirst);
        expect(fake.calls.prompts.length).toBeGreaterThanOrEqual(2);
    });

    test('a transport failure falls back to the runtime for that turn', async () => {
        const { http, fake } = await assembly({
            env: DIRECT_ENV,
            directHandler: (req, _res) => {
                req.socket.destroy();
            }
        });
        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });
        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe('Runtime answer');
        expect(fake.calls.prompts).toHaveLength(1);
    });
});

describe('§5 direct-mode body and stream passthrough', () => {
    test('the request body passes through except for the model and the opencode extension', async () => {
        const { http, directRequests } = await assembly({
            env: DIRECT_ENV,
            directHandler: defaultDirectHandler
        });
        const clientBody = {
            model: 'opencode/big-pickle',
            messages: [USER],
            temperature: 0.25,
            top_p: 0.5,
            max_tokens: 11,
            stop: ['END'],
            tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }],
            tool_choice: 'auto',
            opencode: { marker: 'ZZ_STRIP_ME' }
        };
        const res = await http.post('/v1/chat/completions').send(clientBody);
        expect(res.status).toBe(200);

        const sent = JSON.parse(directRequests[0].body);
        expect(sent.model).toBe('big-pickle');
        expect(sent.messages).toEqual([USER]);
        expect(sent.temperature).toBe(0.25);
        expect(sent.top_p).toBe(0.5);
        expect(sent.max_tokens).toBe(11);
        expect(sent.stop).toEqual(['END']);
        expect(sent.tools).toEqual(clientBody.tools);
        expect(sent.tool_choice).toBe('auto');
        expect(sent).not.toHaveProperty('opencode');
        expect(directRequests[0].body).not.toContain('ZZ_STRIP_ME');
    });

    test('a relayed SSE stream keeps the framing and restores the client model name', async () => {
        const records =
            'data: {"id":"c1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"Di"},"finish_reason":null}]}\n\n' +
            ': keep-alive\n\n' +
            'data: {"id":"c1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"rect"},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n';
        const { http } = await assembly({
            env: DIRECT_ENV,
            directHandler: (req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(records);
            }
        });

        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER], stream: true });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        const chunks = res.text
            .split('\n\n')
            .filter((record) => record.startsWith('data: {'))
            .map((record) => JSON.parse(record.slice(5)));
        expect(chunks).toHaveLength(2);
        expect(chunks.map((chunk) => chunk.model)).toEqual(['opencode/big-pickle', 'opencode/big-pickle']);
        expect(chunks.map((chunk) => chunk.choices[0].delta.content).join('')).toBe('Direct');
        expect(res.text).toContain(': keep-alive\n\n');
        expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    test('a direct Responses error body is relayed byte-for-byte', async () => {
        const upstreamBody = '{\n  "type": "error",\n  "error": { "type": "RateLimitError" }\n}\n';
        const { http } = await assembly({
            env: DIRECT_ENV,
            directHandler: (req, res) => {
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(upstreamBody);
            }
        });
        const res = await http.post('/v1/responses').send({ model: 'opencode/big-pickle', input: 'hi' });
        expect(res.status).toBe(429);
        expect(res.text).toBe(upstreamBody);
    });
});
