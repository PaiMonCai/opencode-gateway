import { describe, expect, test } from '@jest/globals';

import { createModelResolver, normalizeModelID } from '../../../src/routes/model-resolver.js';

describe('model resolver', () => {
    test('normalizes compact GPT model ids', () => {
        expect(normalizeModelID('gpt4.1')).toBe('gpt-4.1');
        expect(normalizeModelID('GPT4o')).toBe('gpt-4o');
        expect(normalizeModelID('kimi-k2.5-free')).toBe('kimi-k2.5-free');
    });

    test('prefers the runtime catalog when it is available', async () => {
        const resolver = createModelResolver({
            runtime: {
                listModels: async () => [{ id: 'opencode/runtime-model', owned_by: 'opencode' }]
            },
            direct: {
                listModels: async () => [{ id: 'opencode-go/direct-model', owned_by: 'opencode-go' }]
            }
        });

        await expect(resolver.listModels()).resolves.toEqual([
            { id: 'opencode/runtime-model', owned_by: 'opencode' }
        ]);
    });

    test('falls back to the direct catalog when runtime discovery fails', async () => {
        const logs = [];
        const resolver = createModelResolver({
            runtime: {
                listModels: async () => {
                    throw new Error('runtime down');
                }
            },
            direct: {
                listModels: async () => [{ id: 'opencode-go/glm-5', owned_by: 'opencode-go' }]
            },
            logDebug: (message, details) => logs.push({ message, details })
        });

        await expect(resolver.listModels()).resolves.toEqual([
            { id: 'opencode-go/glm-5', owned_by: 'opencode-go' }
        ]);
        expect(logs[0]).toMatchObject({
            message: 'Runtime model list unavailable',
            details: { error: 'runtime down' }
        });
    });

    test('resolves compact aliases against exact catalog ids', async () => {
        const resolver = createModelResolver({
            runtime: {
                listModels: async () => [{ id: 'opencode/gpt-4.1', owned_by: 'opencode' }]
            },
            direct: { listModels: async () => [] }
        });

        await expect(resolver.resolveRequestedModel('opencode/gpt4.1')).resolves.toMatchObject({
            providerID: 'opencode',
            modelID: 'gpt-4.1',
            resolved: 'opencode/gpt-4.1',
            aliasFrom: 'opencode/gpt4.1'
        });
    });

    test('resolves provider suffix matches such as free-tier variants', async () => {
        const resolver = createModelResolver({
            runtime: {
                listModels: async () => [{ id: 'opencode/kimi-k2.5-free', owned_by: 'opencode' }]
            },
            direct: { listModels: async () => [] }
        });

        await expect(resolver.resolveRequestedModel('kimi-k2.5')).resolves.toMatchObject({
            providerID: 'opencode',
            modelID: 'kimi-k2.5-free',
            resolved: 'opencode/kimi-k2.5-free',
            aliasFrom: 'opencode/kimi-k2.5'
        });
    });

    test('throws the documented model_not_found shape with the available catalog', async () => {
        const resolver = createModelResolver({
            runtime: {
                listModels: async () => [{ id: 'opencode/known', owned_by: 'opencode' }]
            },
            direct: { listModels: async () => [] }
        });

        try {
            await resolver.resolveRequestedModel('opencode/missing');
            throw new Error('expected resolution to fail');
        } catch (error) {
            expect(error).toMatchObject({
                message: 'Model not found: opencode/missing',
                statusCode: 404,
                code: 'model_not_found',
                availableModels: ['opencode/known']
            });
        }
    });
});
