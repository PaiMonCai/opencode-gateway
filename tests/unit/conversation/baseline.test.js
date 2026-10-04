import {
    BaselineUnavailableError,
    SESSION_STATE_UNAVAILABLE,
    assertBaseline,
    isBaselineUnavailable,
    snapshotSessionState
} from '../../../src/conversation/baseline.js';
import { createFakeLogger, createFakeSessionBackend } from './helpers.js';

const sessionState = {
    'session-1': [
        { info: { id: 'msg-1', role: 'user' }, parts: [{ id: 'part-1', text: 'hello' }] },
        { info: { id: 'msg-2', role: 'assistant' }, parts: [{ id: 'part-2', text: 'hi' }, { id: 'part-3' }] }
    ]
};

describe('snapshotSessionState', () => {
    test('needs no read for a session that does not exist yet', async () => {
        const backend = createFakeSessionBackend();
        const baseline = await snapshotSessionState({ sessionId: null, sessionBackend: backend });
        expect(baseline.ok).toBe(true);
        expect(baseline.messageIds.size).toEqual(0);
        expect(baseline.partIds.size).toEqual(0);
        expect(backend.reads).toEqual([]);
    });

    test('collects the message and part ids that already exist', async () => {
        const backend = createFakeSessionBackend(sessionState);
        const baseline = await snapshotSessionState({ sessionId: 'session-1', sessionBackend: backend });
        expect(baseline.ok).toBe(true);
        expect([...baseline.messageIds]).toEqual(['msg-1', 'msg-2']);
        expect([...baseline.partIds]).toEqual(['part-1', 'part-2', 'part-3']);
        expect(backend.reads).toEqual(['session-1']);
    });

    test('survives a single transient read failure', async () => {
        const backend = createFakeSessionBackend(sessionState);
        backend.failNextReads = 1;
        const logger = createFakeLogger();
        const baseline = await snapshotSessionState({
            sessionId: 'session-1',
            sessionBackend: backend,
            logger
        });
        expect(baseline.ok).toBe(true);
        expect([...baseline.messageIds]).toEqual(['msg-1', 'msg-2']);
        expect(backend.reads).toEqual(['session-1', 'session-1']);
        expect(logger.records).toHaveLength(1);
        expect(logger.records[0].fields).toMatchObject({ sessionId: 'session-1', attempt: 1 });
    });

    test('fails closed when both attempts fail', async () => {
        const backend = createFakeSessionBackend(sessionState);
        backend.failNextReads = 2;
        const baseline = await snapshotSessionState({ sessionId: 'session-1', sessionBackend: backend });
        expect(baseline.ok).toBe(false);
        // No partial state may leak through as a usable baseline.
        expect(baseline.messageIds.size).toEqual(0);
        expect(baseline.partIds.size).toEqual(0);
        expect(isBaselineUnavailable(baseline)).toBe(true);
        expect(() => assertBaseline(baseline)).toThrow(BaselineUnavailableError);
    });

    test('fails closed without a backend or with a broken one', async () => {
        const missing = await snapshotSessionState({ sessionId: 'session-1' });
        expect(missing.ok).toBe(false);

        const broken = await snapshotSessionState({
            sessionId: 'session-1',
            sessionBackend: { messages: async () => ({ not: 'an array' }) }
        });
        expect(broken.ok).toBe(false);
    });

    test('accepts the wrapped { data } shape of the SDK', async () => {
        const baseline = await snapshotSessionState({
            sessionId: 'session-1',
            sessionBackend: { messages: async () => ({ data: sessionState['session-1'] }) }
        });
        expect(baseline.ok).toBe(true);
        expect(baseline.messageIds.has('msg-1')).toBe(true);
    });

    test('defaults to two attempts', async () => {
        const backend = createFakeSessionBackend(sessionState);
        backend.failNextReads = 1;
        await snapshotSessionState({ sessionId: 'session-1', sessionBackend: backend });
        expect(backend.reads).toHaveLength(2);
    });
});

describe('assertBaseline', () => {
    test('passes a usable baseline through', async () => {
        const backend = createFakeSessionBackend(sessionState);
        const baseline = await snapshotSessionState({ sessionId: 'session-1', sessionBackend: backend });
        expect(assertBaseline(baseline)).toBe(baseline);
    });

    test('throws a 503 session_state_unavailable for a failed baseline', () => {
        const error = (() => {
            try {
                assertBaseline({ ok: false, messageIds: new Set(), partIds: new Set() });
            } catch (thrown) {
                return thrown;
            }
            return null;
        })();
        expect(error).toBeInstanceOf(BaselineUnavailableError);
        expect(error.statusCode).toEqual(503);
        expect(error.code).toEqual(SESSION_STATE_UNAVAILABLE);
        expect(error.message).toMatch(/session state/iu);
    });

    test('treats a missing baseline as unavailable', () => {
        expect(() => assertBaseline(null)).toThrow(BaselineUnavailableError);
        expect(isBaselineUnavailable(null)).toBe(false);
    });
});
