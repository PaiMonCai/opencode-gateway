/**
 * Error-surface coverage over the assembled app: a failure of *ours* answers the
 * documented api-reference 500 body with nothing leaked, while a failure the
 * *runtime reported* keeps its own message and code.
 *
 * Both properties are asserted here through HTTP, independently of the one
 * assertion that pins the error mapping itself.
 */

import { createAssembly } from './harness.js';

/** @type {Array<{close: () => Promise<void>}>} */
const open = [];

afterEach(async () => {
    while (open.length) await open.pop().close();
});

const USER = { role: 'user', content: 'ping' };

const assembly = async (options) => {
    const instance = await createAssembly(options);
    open.push(instance);
    return instance;
};

const DOCUMENTED_500 = {
    error: {
        message: 'Internal server error',
        type: 'server_error',
        code: 'internal_error'
    }
};

const failureCase = (label, make) => [label, make];

describe('our own failures answer the documented 500 body', () => {
    const cases = [
        failureCase('Error', () => new Error('boom')),
        failureCase('TypeError', () => new TypeError('fetch failed')),
        failureCase('RangeError', () => new RangeError('out of range')),
        failureCase('ReferenceError', () => new ReferenceError('not defined')),
        failureCase('SyntaxError', () => new SyntaxError('bad json')),
        failureCase('URIError', () => new URIError('bad uri')),
        failureCase('EvalError', () => new EvalError('bad eval')),
        failureCase('AggregateError', () => new AggregateError([new Error('a')], 'all failed')),
        failureCase('an error renamed Object', () => Object.assign(new Error('weird'), { name: 'Object' })),
        failureCase('a nameless object', () => ({ no: 'name' })),
        failureCase('a bare string', () => 'plain string failure')
    ];

    test.each(cases)('%s thrown by the runtime is reported as the internal error', async (_label, make) => {
        const { http } = await assembly({ runtime: { promptError: make } });
        const res = await http.post('/v1/chat/completions').send({
            model: 'opencode/big-pickle',
            messages: [USER]
        });

        expect(res.status).toBe(500);
        expect(res.body).toEqual(DOCUMENTED_500);
        // Nothing of the original failure may survive in the body.
        const raw = JSON.stringify(res.body);
        expect(raw).not.toMatch(/boom|fetch failed|out of range|plain string/);
        expect(raw).not.toMatch(
            /TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AggregateError/
        );
    });
});

describe('runtime-reported failures stay diagnosable', () => {
    test('an error the runtime named keeps its message and takes its name as the code', async () => {
        const runtimeError = Object.assign(new Error('Aborted'), { name: 'MessageAbortedError' });
        const { http } = await assembly({ runtime: { promptError: () => runtimeError } });

        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: {
                message: 'Aborted',
                type: 'server_error',
                code: 'MessageAbortedError'
            }
        });
    });

    test('an explicit runtime code wins over the class name', async () => {
        const runtimeError = Object.assign(new Error('runtime blew up'), {
            name: 'OpenCodeError',
            code: 'OPENCODE_BOOM'
        });
        const { http } = await assembly({ runtime: { promptError: () => runtimeError } });

        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            error: {
                message: 'runtime blew up',
                type: 'server_error',
                code: 'OPENCODE_BOOM'
            }
        });
    });

    test('a streamed response.failed event keeps the runtime message and code', async () => {
        const abortError = { name: 'MessageAbortedError', message: 'Aborted' };
        const { http, fake } = await assembly({
            runtime: {
                reply: '',
                eventStream: ({ calls }) =>
                    (async function* stream() {
                        const sessionId = calls.created.at(-1)?.id;
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'm-err',
                                    sessionID: sessionId,
                                    finish: 'stop',
                                    error: abortError
                                }
                            }
                        };
                    })()
            }
        });
        fake.client.session.messages = async () => [
            { info: { id: 'm-err', role: 'assistant', finish: 'stop', error: abortError }, parts: [] }
        ];

        const res = await http
            .post('/v1/responses')
            .send({ model: 'opencode/big-pickle', input: 'hi', stream: true });

        expect(res.status).toBe(200);
        const payloads = res.text
            .split('\n\n')
            .filter((block) => block.startsWith('data: {'))
            .map((block) => JSON.parse(block.slice(5)));
        const failed = payloads.find((payload) => payload.type === 'response.failed');
        expect(failed.response.error).toEqual({
            message: 'Aborted',
            type: 'server_error',
            code: 'MessageAbortedError'
        });
        // The error code must never be the leaked constructor name "Object".
        expect(JSON.stringify(failed)).not.toContain('"code":"Object"');
        expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    test('a runtime error with no content on the non-streaming path is the documented 502', async () => {
        const abortError = { name: 'MessageAbortedError', message: 'Aborted' };
        const { http, fake } = await assembly({ runtime: { reply: '' } });
        fake.client.session.messages = async () => [
            { info: { id: 'm-err', role: 'assistant', finish: 'stop', error: abortError }, parts: [] }
        ];

        const res = await http
            .post('/v1/chat/completions')
            .send({ model: 'opencode/big-pickle', messages: [USER] });

        expect(res.status).toBe(502);
        expect(res.body).toEqual({
            error: { message: 'Aborted', type: 'MessageAbortedError' }
        });
    });
});
