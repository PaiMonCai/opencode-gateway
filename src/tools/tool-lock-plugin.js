/**
 * Location of the backend plugin that enforces the gateway tool policy.
 *
 * Single source of truth: the plugin lives outside the `src/` tree, so a
 * consumer that resolves it from its own directory depth silently produces a
 * path that does not exist — and that path is what the "plugin not loaded"
 * warning hands to the operator.
 *
 * @module tools/tool-lock-plugin
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** File name of the backend tool-lock plugin. */
export const TOOL_LOCK_PLUGIN_FILE = 'opencode-gateway-tool-lock.js';

/** Absolute path of the backend tool-lock plugin, `<repo>/plugin/<file>`. */
export const TOOL_LOCK_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugin', TOOL_LOCK_PLUGIN_FILE);
