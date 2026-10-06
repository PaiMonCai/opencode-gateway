/**
 * SSE model rewriting in the direct path.
 *
 * Reference: BEHAVIOUR-SPEC §5 ("`model` is mapped both ways") and the
 * direct-client doc ("including inside Responses events, where it lives on
 * `response.model`"). Records that carry no model must pass through
 * byte-for-byte, and record boundaries/order must survive a stream that is
 * split across TCP reads.
 */

import { rewriteSseModel, rewriteSseRecord } from '../../../src/upstreams/direct-client.js';
import { startStubServer, writeSse } from './fixtures.js';

const openStubs = [];

afterEach(async () => {
    while (openStubs.length) {
        await openStubs.pop().close();
    }
});

const CHAT_CHUNK_1 =
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"upstream-model","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}\n\n';
const CHAT_CHUNK_2 =
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"upstream-model","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n';
const RESPONSES_EVENT =
    'data: {"type":"response.created","model":"upstream-model","response":{"id":"resp_1","model":"upstream-model","status":"in_progress"}}\n\n';
const KEEPALIVE = ': keep-alive\n\n';
const PLAIN_JSON_WITHOUT_MODEL = 'data: {"type":"ping","value":1}\n\n';
const NOT_JSON = 'data: {not json\n\n';
const DONE = 'data: [DONE]\n\n';

describe('rewriteSseRecord', () => {
    test('rewrites the chat chunk model and keeps every other field', () => {
        const rewritten = rewriteSseRecord(CHAT_CHUNK_1, 'opencode/asked');
        expect(rewritten).toMatch(/^data: /);
        expect(rewritten.endsWith('\n\n')).toBe(true);
        const payload = JSON.parse(rewritten.slice(5).trim());
        const original = JSON.parse(CHAT_CHUNK_1.slice(5).trim());
        expect(payload.model).toBe('opencode/asked');
        expect({ ...payload, model: original.model }).toEqual(original);
    });

    test('rewrites both the top-level and the nested response model', () => {
        const rewritten = rewriteSseRecord(RESPONSES_EVENT, 'opencode/asked');
        const payload = JSON.parse(rewritten.slice(5).trim());
        expect(payload.model).toBe('opencode/asked');
        expect(payload.response.model).toBe('opencode/asked');
        expect(payload.response.id).toBe('resp_1');
        expect(payload.type).toBe('response.created');
    });

    test('leaves keepalives, [DONE], JSON without a model and non-JSON untouched', () => {
        for (const record of [KEEPALIVE, DONE, PLAIN_JSON_WITHOUT_MODEL, NOT_JSON]) {
            expect(rewriteSseRecord(record, 'opencode/asked')).toBe(record);
        }
    });
});

describe('rewriteSseModel over a real split stream', () => {
    test('preserves record order and boundaries while rewriting every model field', async () => {
        const records = [
            CHAT_CHUNK_1,
            KEEPALIVE,
            CHAT_CHUNK_2,
            RESPONSES_EVENT,
            PLAIN_JSON_WITHOUT_MODEL,
            NOT_JSON,
            DONE
        ];
        const server = await startStubServer((req, res) => writeSse(res, records, { split: true }));
        openStubs.push(server);

        const upstream = await fetch(`${server.url}/stream`, { headers: { accept: 'text/event-stream' } });
        const chunks = [];
        for await (const chunk of rewriteSseModel(upstream.body, 'opencode/asked')) {
            chunks.push(Buffer.from(chunk).toString('utf8'));
        }
        const output = chunks.join('');
        const outputRecords = output.split('\n\n').filter((record) => record.length > 0);
        const inputRecords = records.map((record) => record.replace(/\n\n$/, ''));

        expect(outputRecords).toHaveLength(inputRecords.length);
        expect(JSON.parse(outputRecords[0].slice(5)).model).toBe('opencode/asked');
        expect(outputRecords[1]).toBe(KEEPALIVE.replace(/\n\n$/, ''));
        expect(JSON.parse(outputRecords[2].slice(5)).model).toBe('opencode/asked');
        expect(JSON.parse(outputRecords[3].slice(5)).response.model).toBe('opencode/asked');
        expect(outputRecords[4]).toBe(PLAIN_JSON_WITHOUT_MODEL.replace(/\n\n$/, ''));
        expect(outputRecords[5]).toBe(NOT_JSON.replace(/\n\n$/, ''));
        expect(outputRecords[6]).toBe('data: [DONE]');
    });

    test('an unterminated trailing record keeps its exact framing', async () => {
        // The rewriter keeps the record's original framing, so a truncated tail
        // gets no synthetic blank-line terminator.
        const server = await startStubServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: {"model":"upstream-model","id":"tail"}');
        });
        openStubs.push(server);

        const upstream = await fetch(`${server.url}/tail`);
        let output = '';
        for await (const chunk of rewriteSseModel(upstream.body, 'opencode/asked')) {
            output += Buffer.from(chunk).toString('utf8');
        }
        expect(output).toBe('data: {"model":"opencode/asked","id":"tail"}');
    });

    test('a rewritten record keeps the exact framing it arrived with', async () => {
        const records = [
            'data:{"model":"upstream-model","id":"no-space"}\n\n',
            'data:   {"model":"upstream-model","id":"extra-space"}\n\n'
        ];
        const server = await startStubServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(records.join(''));
        });
        openStubs.push(server);

        const upstream = await fetch(`${server.url}/framing`);
        let output = '';
        for await (const chunk of rewriteSseModel(upstream.body, 'opencode/asked')) {
            output += Buffer.from(chunk).toString('utf8');
        }
        expect(output).toBe(
            'data:{"model":"opencode/asked","id":"no-space"}\n\n' +
                'data:   {"model":"opencode/asked","id":"extra-space"}\n\n'
        );
    });

    test('a non-JSON stream passes through byte-for-byte', async () => {
        const server = await startStubServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: hello\n\ndata: world\n\n');
        });
        openStubs.push(server);

        const upstream = await fetch(`${server.url}/plain`);
        let output = '';
        for await (const chunk of rewriteSseModel(upstream.body, 'opencode/asked')) {
            output += Buffer.from(chunk).toString('utf8');
        }
        expect(output).toBe('data: hello\n\ndata: world\n\n');
    });

    test('CRLF-framed records keep their framing and every model field is rewritten', async () => {
        // SSE lines may legally end with CRLF (WHATWG event-stream) and upstream
        // framing is a passthrough contract (BEHAVIOUR-SPEC §5), so both
        // properties are asserted here.
        const upstreamRecords =
            'data: {"model":"upstream-model","id":"a"}\r\n\r\n' +
            'data: {"model":"upstream-model","id":"b"}\r\n\r\n';
        const expected =
            'data: {"model":"opencode/asked","id":"a"}\r\n\r\n' +
            'data: {"model":"opencode/asked","id":"b"}\r\n\r\n';

        const server = await startStubServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(upstreamRecords);
        });
        openStubs.push(server);

        const upstream = await fetch(`${server.url}/crlf`);
        let output = '';
        for await (const chunk of rewriteSseModel(upstream.body, 'opencode/asked')) {
            output += Buffer.from(chunk).toString('utf8');
        }
        expect(output).toBe(expected);
    });
});
