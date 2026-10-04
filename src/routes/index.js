/**
 * Route table.
 *
 * Mounts every documented endpoint on one router. The HTTP edge (CORS, body
 * parsers, auth, request context) is installed by `src/app.js` around it, and
 * the terminal 404/error handlers come after it.
 *
 * @module routes
 */

import express from 'express';

import { createChatRoute } from './chat.js';
import { createHealthRoute } from './health.js';
import { createModelsRoute } from './models.js';
import { createResponsesRoute } from './responses.js';

/**
 * Build the application router.
 *
 * @typedef {object} TurnEngineSurface
 * @property {(req: import('express').Request, res: import('express').Response) => void} handleHealth Liveness handler.
 * @property {(req: import('express').Request, res: import('express').Response) => void} handleHealthDetails Diagnostics handler.
 * @property {(req: import('express').Request, res: import('express').Response) => void} handleMetrics Prometheus handler.
 * @property {(req: import('express').Request, res: import('express').Response) => Promise<void>} handleChat Chat Completions handler.
 * @property {(req: import('express').Request, res: import('express').Response) => Promise<void>} handleResponses Responses handler.
 * @property {() => Promise<Array<object>>} listModels Catalog reader.
 */

/**
 * @param {object} options Route options.
 * @param {TurnEngineSurface} options.engine Turn engine (`createTurnEngine`).
 * @returns {import('express').Router} Router with all documented endpoints.
 */
export function createRoutes({ engine }) {
    const router = express.Router();
    router.use(createHealthRoute(engine));
    router.use(createModelsRoute(engine));
    router.use(createChatRoute(engine));
    router.use(createResponsesRoute(engine));
    return router;
}
