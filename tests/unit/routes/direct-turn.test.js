import { describe, expect, test } from '@jest/globals';

import { createDirectTurnRunner } from '../../../src/routes/direct-turn.js';

const makeRes = () => ({
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    headers: new Map(),
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    type(value) {
        this.headers.set('content-type', value);
        return this;
    },
    send(value) {
        this.body = value;
        this.headersSent = true;
        return this;
    },
    json(value) {
        this.body = value;
        this.headersSent = true;
        return this;
    },
    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    },
    write() {
        return true;
    },
    end() {
        this.writableEnded = true;
    },
    flushHeaders() {}
});

const signal = new AbortController().signal;

describe('direct turn runner', () => {
    test('relays successful JSON while restoring the client-visible model', async () => {
        const direct = {
            chatCompletion: async () =>
                new Response(
                    JSON.stringify({
                        model: 'bare-model',
                        choices: [{ message: { content: 'hello' } }]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
        };
        const router = { allowsFallback: () => true, fallback: () => {} };
        const run = createDirectTurnRunner({ direct, router });
        const res = makeRes();
        let answer = null;

        const result = await run({
            path: '/chat/completions',
            res: /** @type {any} */ (res),
            providerID: 'opencode',
            modelID: 'bare-model',
            sessionId: 'direct-1',
            body: {},
            stream: false,
            clientModelName: 'opencode/bare-model',
            signal,
            onSuccess: (text) => {
                answer = text;
            }
        });

        expect(result).toEqual({ handled: true });
        expect(answer).toBe('hello');
        expect(res.body.model).toBe('opencode/bare-model');
    });

    test('classifies direct authentication rejection as fallback when allowed', async () => {
        const direct = {
            chatCompletion: async () =>
                new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' }
                })
        };
        const fallbacks = [];
        const router = {
            allowsFallback: () => true,
            fallback: (turn, reason) => fallbacks.push({ turn, reason })
        };
        const run = createDirectTurnRunner({ direct, router });
        const res = makeRes();
        const fallbackTurn = { key: 'conversation' };

        const result = await run({
            path: '/chat/completions',
            res: /** @type {any} */ (res),
            providerID: 'opencode',
            modelID: 'paid-model',
            sessionId: 'direct-2',
            body: {},
            stream: false,
            clientModelName: 'opencode/paid-model',
            signal,
            fallbackTurn
        });

        expect(result).toEqual({ handled: false, reason: 'auth' });
        expect(fallbacks).toEqual([{ turn: fallbackTurn, reason: 'auth' }]);
        expect(res.headersSent).toBe(false);
    });

    test('relays upstream errors verbatim when fallback is disabled', async () => {
        const direct = {
            responses: async () =>
                new Response('rate limited', {
                    status: 429,
                    headers: { 'content-type': 'text/plain' }
                })
        };
        const router = { allowsFallback: () => false, fallback: () => {} };
        const run = createDirectTurnRunner({ direct, router });
        const res = makeRes();

        const result = await run({
            path: '/responses',
            res: /** @type {any} */ (res),
            providerID: 'opencode',
            modelID: 'paid-model',
            sessionId: 'direct-3',
            body: {},
            stream: false,
            clientModelName: 'opencode/paid-model',
            signal
        });

        expect(result).toEqual({ handled: true });
        expect(res.statusCode).toBe(429);
        expect(res.body).toBe('rate limited');
        expect(res.headers.get('content-type')).toBe('text/plain');
    });
});
