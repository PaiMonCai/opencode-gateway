import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../../../src/tools/registry.js';
import { createPolicyContext, evaluateToolPolicy } from '../../../src/tools/policy.js';

/**
 * Policy decisions: allowlist wins, denylist denies, destructive tools need
 * confirmation, and `report-only` records the requirement without blocking.
 */

const registry = () =>
    buildExternalToolRegistry([
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: 'create_ticket' } },
        { type: 'function', function: { name: 'delete_file' } }
    ]);

const byName = (tools, name) => tools.find((tool) => tool.namespacedName === name);

describe('createPolicyContext', () => {
    test('applies documented defaults', () => {
        const context = createPolicyContext();
        expect(context.mode).toBe('enforce');
        expect(context.defaultRiskLevel).toBe('low');
        expect(context.allowlist.size).toBe(0);
        expect(context.denylist.size).toBe(0);
        expect(context.confirmationRequired.size).toBe(0);
    });

    test('trims and drops empty entries', () => {
        const context = createPolicyContext({
            EXTERNAL_TOOL_ALLOWLIST: [' bash ', '', '   ', 'read'],
            EXTERNAL_TOOL_DENYLIST: ['nope'],
            EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: ['delete_file']
        });
        expect([...context.allowlist]).toEqual(['bash', 'read']);
        expect([...context.denylist]).toEqual(['nope']);
        expect([...context.confirmationRequired]).toEqual(['delete_file']);
    });
});

describe('evaluateToolPolicy', () => {
    test('denies an unregistered tool', () => {
        expect(evaluateToolPolicy(null, {}, {})).toEqual({
            status: 'deny',
            code: 'unknown_tool',
            reason: 'Tool is not registered for this request.'
        });
    });

    test('allows a low-risk read tool by default', () => {
        const decision = evaluateToolPolicy(byName(registry(), 'external__read'), {}, {});
        expect(decision).toEqual({ status: 'allow', effectiveRisk: 'low' });
    });

    test('an allowlist entry allows a tool that would otherwise need confirmation', () => {
        const decision = evaluateToolPolicy(
            byName(registry(), 'external__delete_file'),
            {},
            {
                config: { EXTERNAL_TOOL_ALLOWLIST: ['delete_file'] }
            }
        );
        expect(decision.status).toBe('allow');
        expect(decision.effectiveRisk).toBe('critical');
    });

    test('allowlist matches the namespaced name too', () => {
        expect(
            evaluateToolPolicy(
                byName(registry(), 'external__delete_file'),
                {},
                {
                    config: { EXTERNAL_TOOL_ALLOWLIST: ['external__delete_file'] }
                }
            ).status
        ).toBe('allow');
    });

    test('a denylist entry denies a read tool', () => {
        const decision = evaluateToolPolicy(
            byName(registry(), 'external__read'),
            {},
            {
                config: { EXTERNAL_TOOL_DENYLIST: ['read'] }
            }
        );
        expect(decision).toEqual({
            status: 'deny',
            code: 'tool_denied_by_policy',
            reason: 'Tool read is denied by policy.'
        });
    });

    test('the allowlist wins over the denylist', () => {
        expect(
            evaluateToolPolicy(
                byName(registry(), 'external__read'),
                {},
                {
                    config: { EXTERNAL_TOOL_ALLOWLIST: ['read'], EXTERNAL_TOOL_DENYLIST: ['read'] }
                }
            ).status
        ).toBe('allow');
    });

    test('a destructive tool requires confirmation even without configuration', () => {
        const decision = evaluateToolPolicy(byName(registry(), 'external__delete_file'), { file: 'a' }, {});
        expect(decision.status).toBe('require_confirmation');
        expect(decision.reason).toBe('Tool delete_file is high risk and requires confirmation.');
        expect(decision.confirmationPayload).toEqual({
            toolName: 'delete_file',
            namespacedName: 'external__delete_file',
            argumentsPreview: { file: 'a' },
            risk: 'critical'
        });
    });

    test('a declared confirmation requirement is honoured', () => {
        const decision = evaluateToolPolicy(byName(registry(), 'external__create_ticket'), {}, {});
        expect(decision.status).toBe('require_confirmation');
        expect(decision.reason).toBe('Tool create_ticket requires confirmation before execution.');
    });

    test('an explicit confirmation list forces confirmation for a safe tool', () => {
        expect(
            evaluateToolPolicy(
                byName(registry(), 'external__read'),
                {},
                {
                    config: { EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: ['read'] }
                }
            ).status
        ).toBe('require_confirmation');
    });

    test('report-only mode records the requirement as an allow', () => {
        const decision = evaluateToolPolicy(
            byName(registry(), 'external__create_ticket'),
            {},
            {
                config: { EXTERNAL_TOOL_POLICY_MODE: 'report-only' }
            }
        );
        expect(decision).toEqual({ status: 'allow', effectiveRisk: 'medium' });
    });

    test('report-only mode does not mask an explicit denylist', () => {
        expect(
            evaluateToolPolicy(
                byName(registry(), 'external__create_ticket'),
                {},
                {
                    config: {
                        EXTERNAL_TOOL_POLICY_MODE: 'report-only',
                        EXTERNAL_TOOL_DENYLIST: ['create_ticket']
                    }
                }
            ).status
        ).toBe('deny');
    });

    test('falls back to the configured default risk level', () => {
        const decision = evaluateToolPolicy(
            byName(registry(), 'external__read'),
            {},
            {
                config: { EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'medium' }
            }
        );
        expect(decision.effectiveRisk).toBe('low');
    });
});
