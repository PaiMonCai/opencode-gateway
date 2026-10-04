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
const logger = createLogger({
    level: config.LOG_LEVEL,
    json: config.LOG_JSON,
    debug: config.DEBUG
});

// Settings a merged knob replaced stay honoured, but the operator should know:
// one line per deprecated name, with the name to use instead.
for (const deprecation of config.DEPRECATIONS) {
    logger.warn(
        `[Proxy] Deprecated setting ${deprecation.name} (${deprecation.source}) — ${deprecation.message}`
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
