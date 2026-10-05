import { describe, expect, test } from '@jest/globals';

import {
    prepareSse,
    writeResponsesFailure,
    writeSseDone,
    writeSseEvent
} from '../../../../src/routes/streaming/sse.js';
import { createResponse } from './helpers.js';

describe('SSE transport helpers', () => {
    test('applies the shared SSE headers', () => {
        const res = createResponse();
        prepareSse(/** @type {any} */ (res));

        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(res.headers.get('connection')).toBe('keep-alive');
    });

    test('writes JSON data records and the OpenAI terminator', () => {
        const res = createResponse();
        writeSseEvent(/** @type {any} */ (res), { type: 'demo', value: 1 });
        writeSseDone(/** @type {any} */ (res));

        expect(res.writes).toEqual(['data: {"type":"demo","value":1}\n\n', 'data: [DONE]\n\n']);
    });

    test('writes Responses failures using the same SSE framing', () => {
        const res = createResponse();
        writeResponsesFailure(/** @type {any} */ (res), { message: 'boom', type: 'internal_error' });

        expect(res.writes[0]).toBe(
            'data: {"type":"response.failed","response":{"error":{"message":"boom","type":"internal_error"}}}\n\n'
        );
        expect(res.writes[1]).toBe('data: [DONE]\n\n');
    });
});
