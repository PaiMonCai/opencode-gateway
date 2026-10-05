import { describe, expect, test } from '@jest/globals';

import {
    buildDisabledToolOverrides,
    matchesAllowedToolName,
    normalizeBackendToolIds,
    normalizeConfiguredToolNames,
    normalizeToolName,
    resolveInternalAllowedToolIds
} from '../../../src/tools/internal-resolution.js';

describe('internal tool allowlist resolution', () => {
    test('normalizes configured names and backend ids', () => {
        expect(normalizeToolName('Web_Fetch')).toBe('webfetch');
        expect(normalizeConfiguredToolNames([' web_fetch ', '', 'web_fetch', 'read'])).toEqual([
            'web_fetch',
            'read'
        ]);
        expect(normalizeBackendToolIds(['webfetch', '', null, 'read'])).toEqual(['webfetch', 'read']);
    });

    test('matches built-in ids across separators and namespaces', () => {
        expect(matchesAllowedToolName('webfetch', 'web_fetch')).toBe(true);
        expect(matchesAllowedToolName('builtin.webfetch', 'web_fetch')).toBe(true);
        expect(matchesAllowedToolName('builtin/webfetch', 'web_fetch')).toBe(true);
        expect(matchesAllowedToolName('read', 'web_fetch')).toBe(false);
    });

    test('resolves matches and reports unmatched configured tools', () => {
        expect(
            resolveInternalAllowedToolIds(
                ['webfetch', 'builtin.read', 'bash'],
                ['web_fetch', 'read', 'missing']
            )
        ).toEqual({
            normalizedIds: ['webfetch', 'builtin.read', 'bash'],
            normalizedAllowedNames: ['web_fetch', 'read', 'missing'],
            matchedToolIds: ['webfetch', 'builtin.read'],
            unmatchedAllowedNames: ['missing']
        });
    });

    test('builds an all-disabled override map', () => {
        expect(buildDisabledToolOverrides(['webfetch', 'read'])).toEqual({
            webfetch: false,
            read: false
        });
    });
});
