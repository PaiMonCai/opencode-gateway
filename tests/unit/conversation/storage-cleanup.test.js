import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { createStorageCleanup } from '../../../src/conversation/storage-cleanup.js';

const temporaryRoots = [];

afterEach(() => {
    while (temporaryRoots.length) {
        fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
    }
});

describe('conversation storage cleanup', () => {
    test('removes old message/session entries and preserves recent ones', async () => {
        const homeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cleanup-'));
        temporaryRoots.push(homeBase);
        const storage = path.join(homeBase, '.local', 'share', 'opencode', 'storage');
        const messageDir = path.join(storage, 'message');
        const sessionDir = path.join(storage, 'session');
        fs.mkdirSync(messageDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        const oldEntry = path.join(messageDir, 'old');
        const recentEntry = path.join(sessionDir, 'recent');
        fs.writeFileSync(oldEntry, 'old');
        fs.writeFileSync(recentEntry, 'recent');

        const oldTime = new Date(Date.now() - 60_000);
        fs.utimesSync(oldEntry, oldTime, oldTime);

        const worker = createStorageCleanup({
            enabled: true,
            intervalMs: 60_000,
            maxAgeMs: 30_000,
            homeBase,
            schedule: false
        });

        const result = await worker.cleanup();

        expect(result.scanned).toBeGreaterThanOrEqual(2);
        expect(result.removed).toBe(1);
        expect(fs.existsSync(oldEntry)).toBe(false);
        expect(fs.existsSync(recentEntry)).toBe(true);
        worker.close();
    });

    test('is a no-op when disabled', async () => {
        const worker = createStorageCleanup({
            enabled: false,
            intervalMs: 60_000,
            maxAgeMs: 30_000,
            schedule: false
        });

        await expect(worker.cleanup()).resolves.toEqual({ removed: 0, scanned: 0 });
        worker.close();
    });
});
