/**
 * Tool-call validation against the declared schema.
 *
 * Validation gates execution: a failing call is never handed to the client, and a call whose
 * arguments do not decode is reported as repairable so callers can retry instead of dropping
 * it.
 *
 * @module tools/validator
 */

import { VALIDATION_STATUSES, createValidationError } from './contract.js';
import { findExternalToolByName } from './registry.js';

/**
 * Result of checking that a call's arguments decode to a JSON object.
 *
 * @typedef {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }} ArgsParseResult
 */

/**
 * Result of validating one tool call.
 *
 * @typedef {object} ToolCallValidation
 * @property {string} status One of {@link VALIDATION_STATUSES}.
 * @property {import('./contract.js').ValidationErrorInfo[]} [errors] Problems found.
 * @property {Record<string, unknown>} [normalizedArguments] Decoded arguments when valid.
 * @property {import('./registry.js').ExternalTool|null} [tool] Resolved registry entry.
 */

/**
 * Validated call, annotated with the entry and normalization that produced it.
 *
 * @typedef {object} ValidatedToolCall
 * @property {string} id Call id.
 * @property {'function'} type Always `function`.
 * @property {{ name: string, arguments: string }} function Normalized function payload.
 * @property {Record<string, unknown>} validatedArguments Decoded arguments.
 * @property {import('./registry.js').ExternalTool} tool Registry entry.
 * @property {ToolCallValidation} validation Validation result.
 */

/**
 * Invalid call with the reason it was rejected.
 *
 * @typedef {object} InvalidToolCall
 * @property {unknown} call The call as parsed.
 * @property {ToolCallValidation} validation Validation result.
 */

/**
 * Decode a call's arguments into a plain object.
 *
 * @param {unknown} raw Arguments as emitted (string, object, or absent).
 * @returns {ArgsParseResult} Decoded object or a reason.
 */
function safeParseJsonObject(raw) {
    if (raw === undefined || raw === null || raw === '') {
        return { ok: true, value: {} };
    }
    if (typeof raw === 'object') {
        return Array.isArray(raw)
            ? { ok: false, error: 'arguments must be a JSON object' }
            : { ok: true, value: /** @type {Record<string, unknown>} */ (raw) };
    }
    if (typeof raw !== 'string') {
        return { ok: false, error: 'arguments must be a JSON string or object' };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: 'arguments must decode to a JSON object' };
        }
        return { ok: true, value: parsed };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Check decoded arguments against the schema's `required`, primitive types and enums.
 *
 * @param {Record<string, unknown>} args Decoded arguments.
 * @param {unknown} [schema] Declared JSON schema.
 * @returns {import('./contract.js').ValidationErrorInfo[]} Problems found.
 */
function validateAgainstSchema(args, schema = {}) {
    /** @type {import('./contract.js').ValidationErrorInfo[]} */
    const errors = [];
    const normalizedSchema =
        schema && typeof schema === 'object' ? /** @type {Record<string, unknown>} */ (schema) : {};
    const properties =
        normalizedSchema.properties && typeof normalizedSchema.properties === 'object'
            ? /** @type {Record<string, Record<string, unknown>>} */ (normalizedSchema.properties)
            : {};
    const required = Array.isArray(normalizedSchema.required)
        ? /** @type {unknown[]} */ (normalizedSchema.required)
        : [];

    required.forEach((key) => {
        const name = String(key);
        if (!(name in args) || args[name] === undefined || args[name] === null || args[name] === '') {
            errors.push(
                createValidationError('missing_required_field', `Missing required field: ${name}`, [name])
            );
        }
    });

    Object.entries(properties).forEach(([key, definition]) => {
        if (!(key in args) || args[key] === undefined || args[key] === null) return;
        const value = args[key];
        const expectedType = definition?.type;
        if (expectedType === 'string' && typeof value !== 'string') {
            errors.push(createValidationError('invalid_type', `Field ${key} must be a string`, [key]));
        }
        if (expectedType === 'number' && typeof value !== 'number') {
            errors.push(createValidationError('invalid_type', `Field ${key} must be a number`, [key]));
        }
        if (expectedType === 'integer' && !Number.isInteger(value)) {
            errors.push(createValidationError('invalid_type', `Field ${key} must be an integer`, [key]));
        }
        if (expectedType === 'boolean' && typeof value !== 'boolean') {
            errors.push(createValidationError('invalid_type', `Field ${key} must be a boolean`, [key]));
        }
        if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
            errors.push(createValidationError('invalid_type', `Field ${key} must be an object`, [key]));
        }
        if (Array.isArray(definition?.enum) && !definition.enum.includes(value)) {
            errors.push(
                createValidationError(
                    'invalid_enum',
                    `Field ${key} must be one of: ${definition.enum.join(', ')}`,
                    [key]
                )
            );
        }
    });

    return errors;
}

/**
 * Validate one parsed call against the registry and its declared schema.
 *
 * @param {unknown} parsedCall Call in the OpenAI wire shape.
 * @param {import('./registry.js').ExternalTool[]} registry Registry for this request.
 * @returns {ToolCallValidation} Validation result.
 */
export function validateToolCall(parsedCall, registry) {
    const call = /** @type {{ function?: { name?: string, arguments?: unknown } }|null|undefined} */ (
        parsedCall
    );
    const name = call?.function?.name;
    const tool = findExternalToolByName(registry, name);
    if (!tool) {
        return {
            status: VALIDATION_STATUSES.REJECTED,
            errors: [createValidationError('unknown_tool', `Unknown external tool: ${name || 'unknown'}`)],
            tool: null
        };
    }

    const parsedArgs = safeParseJsonObject(call?.function?.arguments);
    if (!parsedArgs.ok) {
        return {
            status: VALIDATION_STATUSES.REPAIRABLE,
            errors: [
                createValidationError(
                    'invalid_arguments_json',
                    `Invalid JSON arguments for ${tool.originalName}: ${parsedArgs.error}`
                )
            ],
            tool
        };
    }

    const schemaErrors = validateAgainstSchema(parsedArgs.value, tool.parameters);
    if (schemaErrors.length > 0) {
        return {
            status: VALIDATION_STATUSES.REJECTED,
            errors: schemaErrors,
            tool
        };
    }

    return {
        status: VALIDATION_STATUSES.VALID,
        normalizedArguments: parsedArgs.value,
        tool
    };
}

/**
 * Split parsed calls into executable ones and rejects.
 *
 * A valid call keeps the wire shape but carries the JSON-encoded, schema-normalized
 * arguments and the registry entry it resolved to.
 *
 * @param {unknown} parsedCalls Calls to validate.
 * @param {import('./registry.js').ExternalTool[]} registry Registry for this request.
 * @returns {{ validCalls: ValidatedToolCall[], invalidCalls: InvalidToolCall[] }} Split.
 */
export function validateToolCalls(parsedCalls, registry) {
    if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
        return { validCalls: [], invalidCalls: [] };
    }

    /** @type {ValidatedToolCall[]} */
    const validCalls = [];
    /** @type {InvalidToolCall[]} */
    const invalidCalls = [];
    parsedCalls.forEach((call) => {
        const validation = validateToolCall(call, registry);
        if (validation.status === VALIDATION_STATUSES.VALID) {
            const normalizedArguments = validation.normalizedArguments || {};
            validCalls.push({
                .../** @type {ValidatedToolCall} */ (call),
                validatedArguments: normalizedArguments,
                function: {
                    .../** @type {{ name: string, arguments: string }} */ (call.function),
                    arguments: JSON.stringify(normalizedArguments)
                },
                tool: /** @type {import('./registry.js').ExternalTool} */ (validation.tool),
                validation
            });
            return;
        }
        invalidCalls.push({
            call,
            validation
        });
    });

    return { validCalls, invalidCalls };
}
