/**
 * Models route surface: `GET /v1/models`.
 *
 * The engine answers with the runtime catalog first and the upstream catalogs
 * second; when neither is reachable the documented single fallback model keeps
 * gateways that probe the endpoint alive.
 *
 * @module routes/models
 */

import express from 'express';

/** Model advertised when no catalog can be reached. */
const FALLBACK_MODEL = { id: 'opencode/kimi-k2.5-free', object: 'model' };

/**
 * Build the router for `GET /v1/models`.
 *
 * @param {object} engine Turn engine (`createTurnEngine`).
 * @param {() => Promise<Array<object>>} engine.listModels Catalog reader.
 * @param {any} [engine.logger] Logger with a `warn` method, when available.
 * @returns {import('express').Router} Express router.
 */
export function createModelsRoute(engine) {
    const router = express.Router();
    router.get('/v1/models', async (_req, res) => {
        try {
            const models = await engine.listModels();
            if (Array.isArray(models) && models.length) {
                res.json({ object: 'list', data: models });
                return;
            }
            res.json({ object: 'list', data: [FALLBACK_MODEL] });
        } catch (error) {
            res.json({ object: 'list', data: [FALLBACK_MODEL] });
            void error;
        }
    });
    return router;
}
