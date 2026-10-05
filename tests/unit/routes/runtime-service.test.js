import { describe, expect, test } from '@jest/globals';

import { createRuntimeTurnService } from '../../../src/routes/runtime-service.js';

describe('runtime turn service', () => {
    test('forwards prompt timeout and abort signal', async () => {
        const calls = [];
        const runtime = {
            prompt: async (...args) => {
                calls.push(args);
                return { data: { ok: true } };
            },
            pollForAssistantResponse: async () => ({}),
            collectFromEvents: async () => ({})
        };
        const service = createRuntimeTurnService(runtime);
        const controller = new AbortController();
        const promptParams = { path: { id: 'sess' }, body: { parts: [] } };

        await expect(service.promptWithTimeout(promptParams, 1234, controller.signal)).resolves.toEqual({
            data: { ok: true }
        });
        expect(calls).toEqual([[promptParams, { timeoutMs: 1234, signal: controller.signal }]]);
    });

    test('forwards polling options', async () => {
        const calls = [];
        const runtime = {
            prompt: async () => ({}),
            pollForAssistantResponse: async (options) => {
                calls.push(options);
                return { content: 'ok' };
            },
            collectFromEvents: async () => ({})
        };
        const service = createRuntimeTurnService(runtime);
        const baseline = { ok: true };

        await service.pollForAssistantResponse('sess', 1000, 250, baseline);
        expect(calls).toEqual([{ sessionId: 'sess', timeoutMs: 1000, intervalMs: 250, baseline }]);
    });

    test('forwards event collection options and signal', async () => {
        const calls = [];
        const runtime = {
            prompt: async () => ({}),
            pollForAssistantResponse: async () => ({}),
            collectFromEvents: async (options) => {
                calls.push(options);
                return { content: 'ok' };
            }
        };
        const service = createRuntimeTurnService(runtime);
        const controller = new AbortController();
        const onDelta = () => {};
        const baseline = { ok: true };

        await service.collectFromEvents('sess', 1000, onDelta, 300, 800, baseline, controller.signal);
        expect(calls).toEqual([
            {
                sessionId: 'sess',
                timeoutMs: 1000,
                onDelta,
                firstDeltaTimeoutMs: 300,
                idleTimeoutMs: 800,
                baseline,
                signal: controller.signal
            }
        ]);
    });

    test('requires a runtime upstream', () => {
        expect(() => createRuntimeTurnService(null)).toThrow(
            'createRuntimeTurnService requires a runtime upstream'
        );
    });
});
