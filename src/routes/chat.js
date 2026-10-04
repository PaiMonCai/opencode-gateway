/**
 * Chat Completions route surface.
 *
 * Parsing, upstream orchestration and response shaping all live in the turn
 * engine; this module only binds the documented endpoint path to it.
 *
 * @module routes/chat
 */

import express from 'express';

/**
 * Build the router for `POST /v1/chat/completions`.
 *
 * @param {object} engine Turn engine (`createTurnEngine`).
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} engine.handleChat
 *   Handler.
 * @returns {import('express').Router} Express router.
 */
export function createChatRoute(engine) {
    const router = express.Router();
    router.post('/v1/chat/completions', (req, res) => engine.handleChat(req, res));
    return router;
}
