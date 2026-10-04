import { describe, expect, test } from '@jest/globals';
import {
    buildExternalToolRegistry,
    createRegistryIndex,
    findExternalToolByName,
    normalizeToolDefinition
} from '../../../src/tools/registry.js';

/**
 * Registry normalization: the two function-tool shapes a request can carry, the
 * `external__` namespace, and the metadata inference that drives policy.
 */

const chatTool = (name, extra = {}) => ({
    type: 'function',
    function: {
        name,
        description: `  ${name} description  `,
        parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        ...extra
    }
});

const responsesTool = (name, extra = {}) => ({
    type: 'function',
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    ...extra
});

describe('normalizeToolDefinition', () => {
    test('accepts the nested Chat Completions shape', () => {
        expect(normalizeToolDefinition(chatTool('bash'))).toMatchObject({
            name: 'bash',
            description: '  bash description  '
        });
    });

    test('accepts the flat Responses shape', () => {
        expect(normalizeToolDefinition(responsesTool('read'))).toMatchObject({
            name: 'read',
            description: 'read description'
        });
    });

    test('reads x_proxy_* metadata from either level', () => {
        const nested = normalizeToolDefinition(chatTool('bash', { x_proxy_risk_level: 'critical' }));
        expect(nested.x_proxy_risk_level).toBe('critical');

        const outer = normalizeToolDefinition({
            type: 'function',
            name: 'bash',
            x_proxy_requires_confirmation: true,
            function: { name: 'bash' }
        });
        expect(outer.x_proxy_requires_confirmation).toBe(true);
    });

    test('rejects non-function tools and nameless definitions', () => {
        expect(normalizeToolDefinition({ type: 'web_search' })).toBeNull();
        expect(normalizeToolDefinition({ type: 'function', function: { name: '   ' } })).toBeNull();
        expect(normalizeToolDefinition(null)).toBeNull();
        expect(normalizeToolDefinition('bash')).toBeNull();
    });
});

describe('buildExternalToolRegistry', () => {
    test('returns an empty registry for absent or empty tool lists', () => {
        expect(buildExternalToolRegistry(undefined)).toEqual([]);
        expect(buildExternalToolRegistry([])).toEqual([]);
        expect(buildExternalToolRegistry('bash')).toEqual([]);
    });

    test('namespaces every declared tool', () => {
        const registry = buildExternalToolRegistry([chatTool('bash'), responsesTool('read')]);
        expect(registry.map((tool) => tool.namespacedName)).toEqual(['external__bash', 'external__read']);
        expect(registry.map((tool) => tool.originalName)).toEqual(['bash', 'read']);
        expect(registry.map((tool) => tool.id)).toEqual(['external_tool_1', 'external_tool_2']);
    });

    test('keeps duplicate client names apart', () => {
        const registry = buildExternalToolRegistry([chatTool('bash'), chatTool('bash'), chatTool('bash')]);
        expect(registry.map((tool) => tool.namespacedName)).toEqual([
            'external__bash',
            'external__bash_2',
            'external__bash_3'
        ]);
    });

    test('honours a custom prefix', () => {
        const registry = buildExternalToolRegistry([chatTool('bash')], { prefix: 'tool__' });
        expect(registry[0].namespacedName).toBe('tool__bash');
    });

    test('trims descriptions and guarantees a usable schema', () => {
        const registry = buildExternalToolRegistry([
            chatTool('bash'),
            { type: 'function', function: { name: 'bare' } },
            { type: 'function', function: { name: 'odd', parameters: ['not', 'a', 'schema'] } }
        ]);
        expect(registry[0].description).toBe('bash description');
        expect(registry[1].parameters).toEqual({ type: 'object', properties: {} });
        expect(registry[2].parameters).toEqual({ type: 'object', properties: {} });
    });

    describe('risk and side-effect inference', () => {
        test('read-like names are read/low', () => {
            const registry = buildExternalToolRegistry([chatTool('get_weather'), chatTool('search')]);
            expect(registry[0]).toMatchObject({ sideEffect: 'read', riskLevel: 'low' });
            expect(registry[1]).toMatchObject({ sideEffect: 'read', riskLevel: 'low' });
        });

        test('write-like names need confirmation', () => {
            const registry = buildExternalToolRegistry([chatTool('create_ticket')]);
            expect(registry[0]).toMatchObject({
                sideEffect: 'write',
                riskLevel: 'medium',
                requiresConfirmation: true
            });
        });

        test('delete-like names are critical', () => {
            const registry = buildExternalToolRegistry([chatTool('delete_file')]);
            expect(registry[0]).toMatchObject({
                sideEffect: 'delete',
                riskLevel: 'critical',
                requiresConfirmation: true
            });
        });

        test('explicit metadata wins over inference', () => {
            const registry = buildExternalToolRegistry([
                chatTool('delete_file', {
                    x_proxy_side_effect: 'read',
                    x_proxy_risk_level: 'low',
                    x_proxy_requires_confirmation: false
                })
            ]);
            expect(registry[0]).toMatchObject({
                sideEffect: 'read',
                riskLevel: 'low',
                requiresConfirmation: false
            });
        });

        test('enabled:false is carried through', () => {
            const registry = buildExternalToolRegistry([chatTool('bash', { enabled: false })]);
            expect(registry[0].enabled).toBe(false);
        });

        test('keeps the source declaration on the entry', () => {
            const source = chatTool('bash');
            expect(buildExternalToolRegistry([source])[0].sourceTool).toBe(source);
        });
    });
});

describe('findExternalToolByName', () => {
    const registry = () =>
        buildExternalToolRegistry([chatTool('bash'), chatTool('web_fetch'), chatTool('read')]);

    test('resolves exact namespaced names', () => {
        expect(findExternalToolByName(registry(), 'external__bash').originalName).toBe('bash');
    });

    test('resolves exact client names', () => {
        expect(findExternalToolByName(registry(), 'web_fetch').namespacedName).toBe('external__web_fetch');
    });

    test('falls back to a separator/case-insensitive match', () => {
        expect(findExternalToolByName(registry(), 'webfetch').namespacedName).toBe('external__web_fetch');
        expect(findExternalToolByName(registry(), 'Web-Fetch').namespacedName).toBe('external__web_fetch');
    });

    test('refuses an ambiguous fuzzy match', () => {
        const ambiguous = buildExternalToolRegistry([chatTool('web_fetch'), chatTool('webfetch')]);
        expect(findExternalToolByName(ambiguous, 'web fetch')).toBeNull();
    });

    test('returns null for unknown names and unusable registries', () => {
        expect(findExternalToolByName(registry(), 'nope')).toBeNull();
        expect(findExternalToolByName(registry(), '')).toBeNull();
        expect(findExternalToolByName(null, 'bash')).toBeNull();
    });
});

describe('createRegistryIndex', () => {
    test('indexes both accepted names', () => {
        const registry = buildExternalToolRegistry([chatTool('bash')]);
        const index = createRegistryIndex(registry);
        expect(index.byOriginalName.get('bash')).toBe(registry[0]);
        expect(index.byNamespacedName.get('external__bash')).toBe(registry[0]);
    });

    test('tolerates an absent registry', () => {
        const index = createRegistryIndex(undefined);
        expect(index.byOriginalName.size).toBe(0);
        expect(index.byNamespacedName.size).toBe(0);
    });
});
