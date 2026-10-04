/**
 * Responses API route surface.
 *
 * Parsing, `previous_response_id` chaining and the SSE event sequence live in the
 * turn engine; this module only binds the documented endpoint path to it.
 *
 * @module routes/responses
 */

import express from 'express';

/**
 * Build the router for `POST /v1/responses`.
 *
 * @param {object} engine Turn engine (`createTurnEngine`).
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} engine.handleResponses
 *   Handler.
 * @returns {import('express').Router} Express router.
 */
export function createResponsesRoute(engine) {
    const router = express.Router();
    router.post('/v1/responses', (req, res) => engine.handleResponses(req, res));
    return router;
}
