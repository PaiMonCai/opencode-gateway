/**
 * Invariant 6 (ARCHITECTURE §2) on the two observation paths:
 * "polling and event collection ignore message/part ids that existed before the
 * turn started", so a reused session never reports the previous answer.
 *
 * The control cases run the same fixtures WITHOUT a baseline: they must expose
 * the stale answer, which proves these probes can actually detect a regression.
 */

import { collectFromEvents, pollForAssistantResponse } from '../../../src/upstreams/runtime-client.js';
import { createFakeClock, fakeSdkClient, sessionMessage } from './fixtures.js';

const SESSION = 'ses-observe';
const STALE_MESSAGE_ID = 'm-prev';
const STALE_PART_ID = 'p-prev';
const BASELINE = {
    messageIds: new Set([STALE_MESSAGE_ID]),
    partIds: new Set([STALE_PART_ID])
};

const staleAssistant = sessionMessage(
    STALE_MESSAGE_ID,
    'assistant',
    [{ id: STALE_PART_ID, type: 'text', text: 'OLD ANSWER' }],
    { finish: 'stop', time: { completed: 1 } }
);

describe('pollForAssistantResponse — baseline filtering', () => {
    const runPoll = (messages, baseline, { timeoutMs = 100, intervalMs = 10 } = {}) => {
        const clock = createFakeClock();
        const client = fakeSdkClient({ messages: () => ({ data: messages() }) });
        return pollForAssistantResponse({
            client,
            sessionId: SESSION,
            baseline,
            timeoutMs,
            intervalMs,
            now: () => clock.now(),
            sleepFn: async () => {
                clock.advance(intervalMs);
            }
        });
    };

    test('control: without a baseline the previous answer is returned (fixture can detect the bug)', async () => {
        const result = await runPoll(() => [staleAssistant], null);
        expect(result.content).toBe('OLD ANSWER');
    });

    test('a pre-existing answer alone never becomes this turn result', async () => {
        await expect(runPoll(() => [staleAssistant], BASELINE)).rejects.toThrow(
            /Request timeout after 100ms/
        );
    });

    test('the previous answer is skipped and the fresh one is returned', async () => {
        const fresh = sessionMessage(
            'm-new',
            'assistant',
            [{ id: 'p-new', type: 'text', text: 'NEW ANSWER' }],
            { finish: 'stop' }
        );
        const result = await runPoll(() => [staleAssistant, fresh], BASELINE);
        expect(result.content).toBe('NEW ANSWER');
        expect(result.content).not.toContain('OLD');
    });

    test('a fresh partial answer is reported when the turn is cut short, never the old one', async () => {
        const partial = sessionMessage(
            'm-new',
            'assistant',
            [{ id: 'p-new', type: 'text', text: 'PART' }],
            {}
        );
        const result = await runPoll(() => [staleAssistant, partial], BASELINE);
        expect(result.content).toBe('PART');
    });

    test('a finish=tool message is not treated as a completed answer', async () => {
        let call = 0;
        const toolTurn = sessionMessage(
            'm-tool',
            'assistant',
            [{ id: 'p-tool', type: 'text', text: 'working' }],
            { finish: 'tool' }
        );
        const completed = sessionMessage(
            'm-done',
            'assistant',
            [{ id: 'p-done', type: 'text', text: 'FINAL' }],
            { finish: 'stop' }
        );
        const result = await runPoll(() => {
            call += 1;
            return call === 1 ? [staleAssistant, toolTurn] : [staleAssistant, completed];
        }, BASELINE);

        expect(result.content).toBe('FINAL');
        expect(call).toBeGreaterThan(1);
    });
});

describe('collectFromEvents — baseline filtering', () => {
    const runCollect = (events, baseline, { timeoutMs = 50 } = {}) =>
        collectFromEvents({
            client: fakeSdkClient({ events }),
            sessionId: SESSION,
            baseline,
            timeoutMs,
            firstDeltaTimeoutMs: 0,
            idleTimeoutMs: 0
        });

    const staleEvents = () => [
        {
            type: 'message.part.updated',
            properties: {
                part: { id: STALE_PART_ID, sessionID: SESSION, type: 'text' },
                delta: 'OLD ANSWER'
            }
        },
        {
            type: 'message.updated',
            properties: {
                info: { id: STALE_MESSAGE_ID, sessionID: SESSION, finish: 'stop' }
            }
        }
    ];

    const freshEvents = (text) => [
        {
            type: 'message.part.updated',
            properties: {
                part: { id: 'p-new', sessionID: SESSION, type: 'text' },
                delta: text
            }
        },
        {
            type: 'message.updated',
            properties: { info: { id: 'm-new', sessionID: SESSION, finish: 'stop' } }
        }
    ];

    const streamOf = (events) =>
        (async function* stream() {
            for (const event of events) yield event;
        })();

    test('control: without a baseline a stale stop completes the turn with the old answer', async () => {
        const result = await runCollect(() => streamOf(staleEvents()), null);
        expect(result.content).toBe('OLD ANSWER');
    });

    test('a stale part delta and a stale finish are both ignored', async () => {
        const result = await runCollect(
            () => streamOf([...staleEvents(), ...freshEvents('NEW ANSWER')]),
            BASELINE
        );
        expect(result.content).toBe('NEW ANSWER');
        expect(result.content).not.toContain('OLD');
    });

    test('stale events alone never complete the turn: it runs out the timeout', async () => {
        const events = () =>
            (async function* stream() {
                for (const event of staleEvents()) yield event;
                await new Promise(() => {});
            })();
        await expect(runCollect(events, BASELINE, { timeoutMs: 40 })).rejects.toThrow(
            /Request timeout after 40ms/
        );
    });

    test('reasoning from a pre-existing part is not mixed into this turn', async () => {
        const staleReasoning = {
            type: 'message.part.updated',
            properties: {
                part: { id: STALE_PART_ID, sessionID: SESSION, type: 'reasoning' },
                delta: 'OLD THOUGHTS'
            }
        };
        const freshReasoning = {
            type: 'message.part.updated',
            properties: {
                part: { id: 'p-reason', sessionID: SESSION, type: 'reasoning' },
                delta: 'NEW THOUGHTS'
            }
        };
        const result = await runCollect(
            () => streamOf([staleReasoning, freshReasoning, ...freshEvents('NEW ANSWER')]),
            BASELINE
        );
        expect(result.reasoning).toBe('NEW THOUGHTS');
        expect(result.content).toBe('NEW ANSWER');
    });
});
