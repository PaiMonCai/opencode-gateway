/**
 * Operational route surface: `/health`, `/health/details`, `/metrics`.
 *
 * Payloads and their auth policy come from the turn engine; this module only
 * binds the documented paths.
 *
 * @module routes/health
 */

import express from 'express';

/**
 * Build the router for the operational endpoints.
 *
 * @param {object} engine Turn engine (`createTurnEngine`).
 * @param {(req: import('express').Request, res: import('express').Response) => void} engine.handleHealth
 *   Liveness handler.
 * @param {(req: import('express').Request, res: import('express').Response) => void} engine.handleHealthDetails
 *   Diagnostics handler.
 * @param {(req: import('express').Request, res: import('express').Response) => void} engine.handleMetrics
 *   Prometheus handler.
 * @returns {import('express').Router} Express router.
 */
export function createHealthRoute(engine) {
    const router = express.Router();
    router.get('/health', (req, res) => engine.handleHealth(req, res));
    router.get('/health/details', (req, res) => engine.handleHealthDetails(req, res));
    router.get('/metrics', (req, res) => engine.handleMetrics(req, res));
    return router;
}
