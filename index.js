#!/usr/bin/env node
/**
 * Entry point: configuration, assembly, banner and listening socket.
 *
 * Everything interesting lives in the modules this file wires together:
 * `src/config` (env + config.json), `src/logging`, `src/bootstrap` (the runtime
 * graph) and `src/server` (listening socket, managed backend, shutdown).
 *
 * @module index
 */

import * as sdk from '@opencode-ai/sdk';

import { loadConfig } from './src/config/index.js';
import { createLogger } from './src/logging/index.js';
import { buildRuntime } from './src/bootstrap.js';
import { createBackendManager, printBanner, startServer } from './src/server.js';

const config = loadConfig({});
// `OPENCODE_PROXY_DEBUG` selects debug level *and* the human-readable format;
// there is no separate level/format setting.
const logger = createLogger({ debug: config.DEBUG });

// Settings that no longer exist are ignored, but never silently: one line per
    // name the operator still sets, with what to use instead.
for (const removed of config.REMOVED_SETTINGS) {
    logger.warn(
        `[Proxy] Removed setting ${removed.name} (${removed.source}) is ignored — ${removed.message}`
    );
}

const backend = createBackendManager({ config, logger });
const { app } = buildRuntime({
    config,
    logger,
    sdk,
    ensureBackend: () => backend.ensureBackend()
});

printBanner(config);
startServer({ app, config, logger, ensureBackend: () => backend.ensureBackend() });
