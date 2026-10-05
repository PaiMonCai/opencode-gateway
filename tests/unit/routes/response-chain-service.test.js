import { describe, expect, test } from '@jest/globals';

import { createResponseChainService } from '../../../src/routes/response-chain-service.js';

describe('response chain service', () => {
    test('delegates get and store operations', () => {
        const stored = [];
        const responseChains = {
            get: (id) => ({ id }),
            store: (...args) => stored.push(args),
            sweep: async () => {}
        };
        const registry = { sweep: async () => {} };
        const service = createResponseChainService({
            responseChains,
            registry,
            schedule: false
        });

        expect(service.getResponseState('resp_1')).toEqual({ id: 'resp_1' });
        service.storeResponseState('resp_1', 'sess_1', 'opencode/model');
        expect(stored).toEqual([['resp_1', 'sess_1', 'opencode/model']]);
        service.close();
    });

    test('sweeps both response chains and conversations', async () => {
        const calls = [];
        const responseChains = {
            get: () => null,
            store: () => {},
            sweep: async () => calls.push('responses')
        };
        const registry = { sweep: async () => calls.push('conversations') };
        const service = createResponseChainService({
            responseChains,
            registry,
            schedule: false
        });

        await service.sweep();
        expect(calls.sort()).toEqual(['conversations', 'responses']);
        service.close();
    });

    test('ignores individual sweep failures', async () => {
        const responseChains = {
            get: () => null,
            store: () => {},
            sweep: async () => {
                throw new Error('response sweep failed');
            }
        };
        const registry = {
            sweep: async () => {
                throw new Error('registry sweep failed');
            }
        };
        const service = createResponseChainService({
            responseChains,
            registry,
            schedule: false
        });

        await expect(service.sweep()).resolves.toBeUndefined();
        service.close();
    });
});
