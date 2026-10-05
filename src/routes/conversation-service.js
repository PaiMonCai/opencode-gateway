/**
 * Conversation lifecycle service shared by Chat and Responses handlers.
 *
 * Owns conversation scoping, registry resolution/storage/discard and runtime
 * session snapshots. HTTP handlers receive this as a collaborator instead of
 * reaching into the registry directly.
 *
 * @module routes/conversation-service
 */

import {
    conversationScopeFor as scopedConversationKey,
    snapshotSessionState as conversationBaseline
} from '../conversation/index.js';

/**
 * @typedef {object} StoredTurnEntry
 * @property {string|null} sessionId
 * @property {'runtime'|'direct'} [mode]
 * @property {number|undefined} [sentCount]
 * @property {string|null|undefined} [sentDigest]
 * @property {string|null} [replyText]
 * @property {string|null} [startKey]
 */

/**
 * @param {object} options Service dependencies.
 * @param {any} options.registry Conversation registry.
 * @param {any} options.runtime Runtime upstream adapter.
 * @param {any} [options.logger] Logger used by baseline snapshots.
 * @returns {{
 *   snapshotSessionState: (sessionId: string) => Promise<any>,
 *   conversationScopeForTurn: (providerID: string, modelID: string, toolMode: string, toolFingerprint: string|null, mode: 'runtime'|'direct') => string,
 *   storeConversationEntry: (key: string|null, entry: StoredTurnEntry) => void,
 *   discardConversationEntry: (key: string|null) => Promise<any>,
 *   discardTurnState: (key?: string|null, sessionId?: string|null) => Promise<void>,
 *   resolveConversationTurn: (params: {req: import('express').Request, deliverable: Array<object>, scope: string, previousSessionId?: string|null}) => Promise<any>,
 *   conversationBusyBody: () => {error: {message: string, type: string}},
 *   sessionStateUnavailableBody: () => {error: {message: string, type: string}}
 * }}
 */
export function createConversationTurnService({ registry, runtime, logger = null }) {
    if (!registry || typeof registry.resolveTurn !== 'function') {
        throw new Error('createConversationTurnService requires a conversation registry');
    }
    if (!runtime) throw new Error('createConversationTurnService requires a runtime upstream');

    /** @type {(sessionId: string) => Promise<any>} */
    const snapshotSessionState = (sessionId) =>
        conversationBaseline({ sessionId, sessionBackend: runtime, logger });

    /** @type {(providerID: string, modelID: string, toolMode: string, toolFingerprint: string|null, mode: 'runtime'|'direct') => string} */
    const conversationScopeForTurn = (providerID, modelID, toolMode, toolFingerprint, mode) =>
        scopedConversationKey({ providerID, modelID, toolMode, toolFingerprint, mode });

    /** @type {(key: string|null, entry: StoredTurnEntry) => void} */
    const storeConversationEntry = (key, entry) => {
        if (!key || !entry) return;
        registry.storeTurn({
            key,
            sessionId: entry.sessionId,
            mode: entry.mode || 'runtime',
            plan: { sentCount: entry.sentCount, sentDigest: entry.sentDigest },
            replyText: typeof entry.replyText === 'string' ? entry.replyText : null,
            startKey: entry.startKey || null
        });
    };

    /** @type {(key: string|null) => Promise<any>} */
    const discardConversationEntry = (key) => (key ? registry.discard({ key }) : Promise.resolve(null));

    /** @type {(key?: string|null, sessionId?: string|null) => Promise<void>} */
    const discardTurnState = async (key = null, sessionId = null) => {
        if (key) {
            await registry.discard({ key });
            return;
        }
        if (sessionId) await runtime.deleteSession(sessionId);
    };

    /** @type {(params: {req: import('express').Request, deliverable: Array<object>, scope: string, previousSessionId?: string|null}) => Promise<any>} */
    const resolveConversationTurn = ({ req, deliverable, scope, previousSessionId = null }) =>
        Promise.resolve(
            registry.resolveTurn({
                headers: req.headers,
                scope,
                deliverable,
                previousSessionId,
                clientAddress: req.socket?.remoteAddress || null
            })
        );

    const conversationBusyBody = () => ({
        error: { message: 'Conversation is busy with another request', type: 'conversation_busy' }
    });

    const sessionStateUnavailableBody = () => ({
        error: {
            message: 'Could not read the session state for this conversation; retry the request',
            type: 'session_state_unavailable'
        }
    });

    return {
        snapshotSessionState,
        conversationScopeForTurn,
        storeConversationEntry,
        discardConversationEntry,
        discardTurnState,
        resolveConversationTurn,
        conversationBusyBody,
        sessionStateUnavailableBody
    };
}
