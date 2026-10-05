import { describe, expect, test } from '@jest/globals';

import {
    reconcileChatRuntimeStream,
    reconcileResponsesRuntimeStream
} from '../../../src/routes/runtime-reconciliation.js';

const createStateSink = () => {
    const state = {
        streamedContent: '',
        streamedReasoning: '',
        rawStreamedContent: '',
        rawStreamedReasoning: ''
    };
    const deltas = [];
    const sendDelta = (delta, isReasoning = false) => {
        deltas.push({ delta, isReasoning });
        if (isReasoning) {
            state.rawStreamedReasoning += delta;
            state.streamedReasoning += delta;
        } else {
            state.rawStreamedContent += delta;
            state.streamedContent += delta;
        }
    };
    return { state, deltas, sendDelta };
};

describe('runtime stream reconciliation', () => {
    test('Chat polling after idle emits only the remaining suffix', async () => {
        const { state, deltas, sendDelta } = createStateSink();
        state.streamedReasoning = 'thinking';
        state.rawStreamedReasoning = 'thinking';
        state.streamedContent = 'hel';
        state.rawStreamedContent = 'hel';

        await reconcileChatRuntimeStream({
            collected: { idleTimeout: true },
            poll: async () => ({ reasoning: 'thinking', content: 'hello', error: null }),
            sendDelta,
            getState: () => state
        });

        expect(deltas).toEqual([{ delta: 'lo', isReasoning: false }]);
    });

    test('Chat collector failure falls back to polling and formats an error-only snapshot', async () => {
        const { state, deltas, sendDelta } = createStateSink();

        await reconcileChatRuntimeStream({
            collected: { __error: { message: 'stream down' } },
            poll: async () => ({
                content: '',
                reasoning: '',
                error: { name: 'CreditsError', data: { message: 'quota' } }
            }),
            sendDelta,
            getState: () => state
        });

        expect(deltas[0]).toEqual({
            delta: '[Proxy Error] CreditsError: quota',
            isReasoning: false
        });
    });

    test('Chat reasoning-only stream recovers missing answer text from polling', async () => {
        const { state, deltas, sendDelta } = createStateSink();
        state.streamedReasoning = 'why';
        state.rawStreamedReasoning = 'why';

        await reconcileChatRuntimeStream({
            collected: { reasoning: 'why' },
            poll: async () => ({ reasoning: 'why', content: 'answer', error: null }),
            sendDelta,
            getState: () => state
        });

        expect(deltas).toEqual([{ delta: 'answer', isReasoning: false }]);
    });

    test('Responses empty stream polls and forwards both channels', async () => {
        let content = '';
        let reasoning = '';
        let rawContent = '';
        let rawReasoning = '';
        const deltas = [];
        const sendDelta = (delta, isReasoning = false) => {
            deltas.push({ delta, isReasoning });
            if (isReasoning) {
                reasoning += delta;
                rawReasoning += delta;
            } else {
                content += delta;
                rawContent += delta;
            }
        };

        await reconcileResponsesRuntimeStream({
            collected: { noData: true },
            poll: async () => ({ reasoning: 'think', content: 'answer', error: null }),
            sendDelta,
            getState: () => ({ content, reasoning, rawContent, rawReasoning })
        });

        expect(deltas).toEqual([
            { delta: 'think', isReasoning: true },
            { delta: 'answer', isReasoning: false }
        ]);
    });

    test('Responses client disconnect returns without polling', async () => {
        let polls = 0;
        const result = await reconcileResponsesRuntimeStream({
            collected: { clientClosed: true },
            poll: async () => {
                polls += 1;
                return { content: '', reasoning: '', error: null };
            },
            sendDelta: () => {},
            getState: () => ({ content: '', reasoning: '', rawContent: '', rawReasoning: '' })
        });

        expect(result).toEqual({ clientClosed: true });
        expect(polls).toBe(0);
    });
});
