import { describe, expect, test } from '@jest/globals';

import {
    LOG_LEVELS,
    Logger,
    REDACTED,
    createLogger,
    isDebugEnabled,
    redact,
    serializeError
} from '../../../src/logging/logger.js';

/**
 * In-memory sink that records every written line.
 *
 * @returns {{lines: string[], write: (chunk: string) => boolean}} Sink.
 */
function createStream() {
    /** @type {string[]} */
    const lines = [];
    return {
        lines,
        write(chunk) {
            lines.push(chunk);
            return true;
        }
    };
}

describe('isDebugEnabled', () => {
    test.each([
        ['1', true],
        ['true', true],
        ['TRUE', true],
        ['yes', true],
        ['y', true],
        ['on', true],
        ['0', false],
        ['false', false],
        ['', false],
        [undefined, false]
    ])('isDebugEnabled(OPENCODE_PROXY_DEBUG=%p) === %p', (value, expected) => {
        expect(isDebugEnabled({ OPENCODE_PROXY_DEBUG: value })).toBe(expected);
    });
});

describe('level filtering', () => {
    test('emits only records at or above the configured level', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'warn', json: true, stream });

        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');

        expect(stream.lines).toHaveLength(2);
        expect(stream.lines[0]).toContain('"level":"warn"');
        expect(stream.lines[1]).toContain('"level":"error"');
    });

    test('accepts a numeric level', () => {
        const stream = createStream();
        const logger = createLogger({ level: LOG_LEVELS.error, json: true, stream });

        logger.warn('w');
        logger.error('e');

        expect(stream.lines).toHaveLength(1);
    });

    test('unknown level names fall back to info', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'loud', json: true, stream });

        logger.debug('d');
        logger.info('i');

        expect(stream.lines).toHaveLength(1);
    });
});

describe('json output', () => {
    test('writes one parseable JSON line per record', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'debug', json: true, stream });

        logger.info('listening', { port: 10000, nested: { ok: true } });

        expect(stream.lines).toHaveLength(1);
        expect(stream.lines[0].endsWith('\n')).toBe(true);
        expect(stream.lines[0].trimEnd().split('\n')).toHaveLength(1);

        const record = JSON.parse(stream.lines[0]);
        expect(record.level).toBe('info');
        expect(record.msg).toBe('listening');
        expect(record.port).toBe(10000);
        expect(record.nested).toEqual({ ok: true });
        expect(Date.parse(record.ts)).not.toBeNaN();
    });

    test('includes the scope and does not let fields shadow the record keys', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'debug', json: true, stream, scope: 'http' });

        logger.info('hello', { msg: 'spoofed', level: 'fatal' });

        const record = JSON.parse(stream.lines[0]);
        expect(record.scope).toBe('http');
        expect(record.msg).toBe('hello');
        expect(record.level).toBe('info');
    });
});

describe('human-readable output', () => {
    test('is used when json is false', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'debug', json: false, stream, scope: 'http' });

        logger.warn('backend down', { attempt: 2 });

        const line = stream.lines[0];
        expect(line).toContain('WARN');
        expect(line).toContain('[http]');
        expect(line).toContain('backend down');
        expect(line).toContain('"attempt":2');
        expect(line.startsWith('{')).toBe(false);
    });

    test('defaults to human-readable when OPENCODE_PROXY_DEBUG is on', () => {
        const previous = process.env.OPENCODE_PROXY_DEBUG;
        process.env.OPENCODE_PROXY_DEBUG = 'true';
        try {
            expect(createLogger().json).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.OPENCODE_PROXY_DEBUG;
            else process.env.OPENCODE_PROXY_DEBUG = previous;
        }
    });

    test('defaults to JSON lines otherwise', () => {
        const previous = process.env.OPENCODE_PROXY_DEBUG;
        delete process.env.OPENCODE_PROXY_DEBUG;
        try {
            expect(createLogger().json).toBe(true);
        } finally {
            if (previous !== undefined) process.env.OPENCODE_PROXY_DEBUG = previous;
        }
    });
});

describe('child loggers', () => {
    test('join scopes and merge fields, sharing the sink and level', () => {
        const stream = createStream();
        const parent = createLogger({ level: 'debug', json: true, stream, scope: 'http' });
        const child = parent.child('upstream', { provider: 'opencode' });

        child.info('calling', { model: 'big-pickle' });

        expect(child).toBeInstanceOf(Logger);
        expect(child.level).toBe('debug');
        expect(child.json).toBe(true);
        expect(child.stream).toBe(stream);

        const record = JSON.parse(stream.lines[0]);
        expect(record.scope).toBe('http:upstream');
        expect(record.provider).toBe('opencode');
        expect(record.model).toBe('big-pickle');
    });

    test('caller fields override inherited ones', () => {
        const stream = createStream();
        const child = createLogger({ json: true, stream }).child('x', { attempt: 1 });

        child.info('retry', { attempt: 2 });

        expect(JSON.parse(stream.lines[0]).attempt).toBe(2);
    });

    test('a child of a child keeps the full scope', () => {
        const stream = createStream();
        const grandchild = createLogger({ json: true, stream, scope: 'a' }).child('b').child('c');

        grandchild.info('x');

        expect(JSON.parse(stream.lines[0]).scope).toBe('a:b:c');
    });
});

describe('secret redaction', () => {
    test('masks secret-looking field names at any depth', () => {
        const record = /** @type {Record<string, any>} */ (
            redact({
                apiKey: 'sk-super-secret',
                API_KEY: 'sk-super-secret',
                password: 'hunter2',
                authorization: 'Bearer abcdefgh',
                access_token: 'tok',
                nested: { clientSecret: 'nope' },
                list: [{ token: 'nope' }]
            })
        );

        expect(record.apiKey).toBe(REDACTED);
        expect(record.API_KEY).toBe(REDACTED);
        expect(record.password).toBe(REDACTED);
        expect(record.authorization).toBe(REDACTED);
        expect(record.access_token).toBe(REDACTED);
        expect(record.nested.clientSecret).toBe(REDACTED);
        expect(record.list[0].token).toBe(REDACTED);
    });

    test('scrubs inline credentials from strings', () => {
        expect(redact('Bearer abcdefghij')).toBe(REDACTED);
        expect(redact('key sk-abcdef123456 here')).toContain(REDACTED);
        expect(redact('nothing to see')).toBe('nothing to see');
    });

    test('flattens errors including their cause', () => {
        const error = Object.assign(new Error('boom'), { statusCode: 503 });
        const wrapped = new Error('outer', { cause: error });

        const view = /** @type {Record<string, any>} */ (serializeError(wrapped));

        expect(view.name).toBe('Error');
        expect(view.message).toBe('outer');
        expect(view.cause.message).toBe('boom');
        expect(view.cause.statusCode).toBe(503);
        expect(typeof view.stack).toBe('string');
    });

    test('survives cycles and deep structures', () => {
        /** @type {Record<string, any>} */
        const cyclic = { name: 'loop' };
        cyclic.self = cyclic;

        expect(redact(cyclic)).toEqual({ name: 'loop', self: '[circular]' });

        let deep = /** @type {any} */ ({ end: true });
        for (let i = 0; i < 10; i += 1) deep = { deep };
        expect(JSON.stringify(redact(deep))).toContain('[truncated]');
    });

    test('never writes a secret to the stream', () => {
        const stream = createStream();
        const logger = createLogger({
            level: 'debug',
            json: true,
            stream,
            fields: { apiKey: 'sk-top-secret', authorization: 'Bearer topsecret' }
        });

        logger.info('calling upstream', {
            password: 'hunter2',
            headers: { Authorization: 'Bearer topsecret' },
            err: new Error('failed with Bearer topsecret'),
            nested: [{ token: 'sk-top-secret' }]
        });

        const output = stream.lines.join('\n');
        expect(output).not.toContain('sk-top-secret');
        expect(output).not.toContain('topsecret');
        expect(output).not.toContain('hunter2');
        expect(output).toContain(REDACTED);
    });

    test('keeps non-secret diagnostics intact', () => {
        const stream = createStream();
        const logger = createLogger({ level: 'debug', json: true, stream });

        logger.info('turn rejected', { code: 'session_state_unavailable', statusCode: 503 });

        const record = JSON.parse(stream.lines[0]);
        expect(record.code).toBe('session_state_unavailable');
        expect(record.statusCode).toBe(503);
    });
});

describe('field argument shapes', () => {
    test('keeps a string detail readable instead of splitting it into characters', () => {
        const stream = createStream();
        const log = createLogger({ level: 'error', json: true, stream });
        log.error('[Proxy] API Error:', 'Request timeout after 180000ms');
        const record = JSON.parse(stream.lines[0]);
        expect(record.detail).toBe('Request timeout after 180000ms');
        expect(record['0']).toBeUndefined();
        expect(record.msg).toBe('[Proxy] API Error:');
    });

    test('serialises an Error passed as the fields argument', () => {
        const stream = createStream();
        const log = createLogger({ level: 'error', json: true, stream });
        log.error('[Proxy] Error details:', new Error('boom'));
        const record = JSON.parse(stream.lines[0]);
        expect(record.error.message).toBe('boom');
        expect(record.error.name).toBe('Error');
        expect(typeof record.error.stack).toBe('string');
    });

    test('normalises numbers, booleans and arrays', () => {
        const stream = createStream();
        const log = createLogger({ level: 'info', json: true, stream });
        log.info('count', 3);
        log.info('flag', true);
        log.info('list', ['a', 'b']);
        expect(JSON.parse(stream.lines[0]).detail).toBe(3);
        expect(JSON.parse(stream.lines[1]).detail).toBe(true);
        expect(JSON.parse(stream.lines[2]).detail).toEqual(['a', 'b']);
    });

    test('tolerates a missing fields argument and keeps child fields intact', () => {
        const stream = createStream();
        const log = createLogger({ level: 'info', json: true, stream, fields: { scopeKey: 'x' } });
        log.info('no fields');
        log.child('sub', 'plain string').info('child');
        const first = JSON.parse(stream.lines[0]);
        expect(first.scopeKey).toBe('x');
        expect(first.detail).toBeUndefined();
        const second = JSON.parse(stream.lines[1]);
        expect(second.scopeKey).toBe('x');
        expect(second.detail).toBe('plain string');
        expect(second.scope).toBe('sub');
    });
});
