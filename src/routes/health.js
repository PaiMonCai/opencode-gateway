/**
 * Operational route surface: `/health`, `/health/details`, `/metrics`.
 *
 * Each endpoint decides its own auth policy (the global middleware bypasses
 * these paths) and then delegates to the turn engine for the payload, which
 * keeps this module free of business logic.
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
