import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

import { TOOL_LOCK_PLUGIN_FILE, TOOL_LOCK_PLUGIN_PATH } from '../../../src/tools/tool-lock-plugin.js';

/**
 * The tool-lock plugin lives outside `src/`. `src/routes/engine.js` used to
 * resolve it with `path.join(__dirname, '..', 'plugin', ...)`, which pointed at
 * the non-existent `<repo>/src/plugin/...`; its warning then sent operators to a
 * path that `docs/**` never mentions. These tests pin the single, correct
 * resolution so that class of bug cannot come back quietly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..', '..');

/** The path the old `src/routes/engine.js` duplicate computed. */
const LEGACY_ENGINE_RESOLUTION = path.join(REPO_ROOT, 'src', 'plugin', TOOL_LOCK_PLUGIN_FILE);

describe('tool-lock plugin location', () => {
    test('exports an absolute path to a file that exists', () => {
        expect(path.isAbsolute(TOOL_LOCK_PLUGIN_PATH)).toBe(true);
        expect(fs.existsSync(TOOL_LOCK_PLUGIN_PATH)).toBe(true);
        expect(fs.statSync(TOOL_LOCK_PLUGIN_PATH).isFile()).toBe(true);
    });

    test('resolves <repo>/plugin/<file>', () => {
        expect(path.basename(TOOL_LOCK_PLUGIN_PATH)).toBe(TOOL_LOCK_PLUGIN_FILE);
        expect(path.basename(path.dirname(TOOL_LOCK_PLUGIN_PATH))).toBe('plugin');
        expect(TOOL_LOCK_PLUGIN_PATH).toBe(path.join(REPO_ROOT, 'plugin', TOOL_LOCK_PLUGIN_FILE));
    });

    test('is not the non-existent <repo>/src/plugin path the engine once printed', () => {
        expect(LEGACY_ENGINE_RESOLUTION).not.toBe(TOOL_LOCK_PLUGIN_PATH);
        expect(fs.existsSync(LEGACY_ENGINE_RESOLUTION)).toBe(false);
    });

    test('is the only resolution: consumers import it instead of redefining it', () => {
        for (const relative of ['src/server.js', 'src/routes/engine.js']) {
            const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
            expect(source).not.toContain(`path.join(__dirname, '..', 'plugin'`);
            expect(source).toMatch(
                /import \{[^}]*TOOL_LOCK_PLUGIN_(FILE|PATH)[^}]*\} from ['"][^'"]*tools\/tool-lock-plugin\.js['"]/
            );
        }
    });
});
