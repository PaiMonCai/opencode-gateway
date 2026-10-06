/**
 * OpenCode conversation-storage cleanup: the `cleanup()` hook the turn engine
 * needs, plus the filesystem traversal and optional periodic schedule, kept apart
 * from Chat/Responses orchestration.
 *
 * @module conversation/storage-cleanup
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} StorageCleanupOptions
 * @property {boolean} enabled Whether cleanup is enabled.
 * @property {number} intervalMs Periodic cleanup interval.
 * @property {number} maxAgeMs Minimum file age before removal.
 * @property {string|null|undefined} [homeBase] Optional OpenCode home base.
 * @property {(message: string, fields?: Record<string, unknown>) => void} [logDebug] Debug logger.
 * @property {boolean} [schedule] Whether to start periodic timers.
 */

/**
 * Create the storage cleanup worker.
 *
 * @param {StorageCleanupOptions} options Cleanup configuration.
 * @returns {{
 *   cleanup: () => Promise<{removed: number, scanned: number}>,
 *   roots: readonly string[],
 *   close: () => void
 * }}
 */
export function createStorageCleanup({
    enabled,
    intervalMs,
    maxAgeMs,
    homeBase = null,
    logDebug = () => {},
    schedule = true
}) {
    /** @type {string[]} */
    const roots = [];
    /** @param {string|null} dir Storage root candidate. @returns {void} */
    const addRoot = (dir) => {
        if (!dir || roots.includes(dir)) return;
        roots.push(dir);
    };

    addRoot(homeBase ? path.join(homeBase, '.local', 'share', 'opencode', 'storage') : null);
    addRoot('/home/node/.local/share/opencode/storage');

    const cleanup = async () => {
        if (!enabled) return { removed: 0, scanned: 0 };

        const now = Date.now();
        let removed = 0;
        let scanned = 0;

        for (const storageRoot of roots) {
            for (const sub of ['message', 'session']) {
                const dir = path.join(storageRoot, sub);
                if (!fs.existsSync(dir)) continue;

                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    continue;
                }

                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch {
                        continue;
                    }

                    scanned += 1;
                    const mtime = stat.mtimeMs || stat.ctimeMs || now;
                    if (now - mtime < maxAgeMs) continue;

                    try {
                        fs.rmSync(full, { recursive: true, force: true });
                        removed += 1;
                    } catch (error) {
                        logDebug('Cleanup remove failed', {
                            full,
                            error: /** @type {Error} */ (error).message
                        });
                    }
                }
            }
        }

        if (removed > 0) {
            logDebug('Conversation cleanup completed', { removed, scanned, maxAgeMs });
        }
        return { removed, scanned };
    };

    /** @type {ReturnType<typeof setTimeout>|null} */
    let initialTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let intervalTimer = null;

    if (enabled && schedule) {
        initialTimer = setTimeout(() => {
            cleanup().catch((error) =>
                logDebug('Cleanup run failed', { error: /** @type {Error} */ (error).message })
            );
        }, 3000);
        if (typeof initialTimer.unref === 'function') initialTimer.unref();

        intervalTimer = setInterval(() => {
            cleanup().catch((error) =>
                logDebug('Cleanup run failed', { error: /** @type {Error} */ (error).message })
            );
        }, intervalMs);
        if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
    }

    return {
        cleanup,
        roots: Object.freeze([...roots]),
        close() {
            if (initialTimer) clearTimeout(initialTimer);
            if (intervalTimer) clearInterval(intervalTimer);
            initialTimer = null;
            intervalTimer = null;
        }
    };
}
