import { describe, expect, test } from '@jest/globals';

import { createConversationTurnService } from '../../../src/routes/conversation-service.js';

describe('conversation turn service', () => {
    test('stores finished turns in registry shape', () => {
        const stored = [];
        const registry = {
            resolveTurn: async () => ({}),
            storeTurn: (entry) => stored.push(entry),
            discard: async () => null
        };
        const runtime = { deleteSession: async () => {} };
        const service = createConversationTurnService({ registry, runtime });

        service.storeConversationEntry('key', {
            sessionId: 'sess',
            mode: 'direct',
            sentCount: 2,
            sentDigest: 'digest',
            replyText: 'answer',
            startKey: 'start'
        });

        expect(stored).toEqual([
            {
                key: 'key',
                sessionId: 'sess',
                mode: 'direct',
                plan: { sentCount: 2, sentDigest: 'digest' },
                replyText: 'answer',
                startKey: 'start'
            }
        ]);
    });

    test('resolves request metadata through the registry', async () => {
        const calls = [];
        const registry = {
            resolveTurn: async (input) => {
                calls.push(input);
                return { key: 'resolved' };
            },
            storeTurn: () => {},
            discard: async () => null
        };
        const runtime = { deleteSession: async () => {} };
        const service = createConversationTurnService({ registry, runtime });
        const req = {
            headers: { 'x-opencode-session': 'abc' },
            socket: { remoteAddress: '127.0.0.1' }
        };

        await expect(
            service.resolveConversationTurn({
                req: /** @type {any} */ (req),
                deliverable: [{ role: 'user', content: 'hi' }],
                scope: 'scope',
                previousSessionId: 'prev'
            })
        ).resolves.toEqual({ key: 'resolved' });

        expect(calls).toEqual([
            {
                headers: req.headers,
                scope: 'scope',
                deliverable: [{ role: 'user', content: 'hi' }],
                previousSessionId: 'prev',
                clientAddress: '127.0.0.1'
            }
        ]);
    });

    test('discards registry state before falling back to bare session deletion', async () => {
        const discarded = [];
        const deleted = [];
        const registry = {
            resolveTurn: async () => ({}),
            storeTurn: () => {},
            discard: async ({ key }) => {
                discarded.push(key);
                return null;
            }
        };
        const runtime = { deleteSession: async (id) => deleted.push(id) };
        const service = createConversationTurnService({ registry, runtime });

        await service.discardTurnState('key', 'sess');
        await service.discardTurnState(null, 'bare');

        expect(discarded).toEqual(['key']);
        expect(deleted).toEqual(['bare']);
    });

    test('returns stable conversation error bodies', () => {
        const registry = {
            resolveTurn: async () => ({}),
            storeTurn: () => {},
            discard: async () => null
        };
        const runtime = { deleteSession: async () => {} };
        const service = createConversationTurnService({ registry, runtime });

        expect(service.conversationBusyBody()).toEqual({
            error: {
                message: 'Conversation is busy with another request',
                type: 'conversation_busy'
            }
        });
        expect(service.sessionStateUnavailableBody().error.type).toBe('session_state_unavailable');
    });
});
