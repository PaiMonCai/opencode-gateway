/**
 * Configuration loading: resolve environment variables, `config.json` and
 * defaults into one frozen, validated {@link Config}.
 *
 * @module config/load
 */

import fs from 'node:fs';

import { CONFIG_FIELDS, ConfigError, coerceField, isUnset } from './schema.js';

/**
 * Where the file half of the configuration comes from.
 *
 * @typedef {string | Record<string, unknown> | null | undefined} ConfigFileSource
 * A path to a JSON file, an already-parsed object, or nothing.
 */

/**
 * @typedef {object} LoadConfigOptions
 * @property {Record<string, string | undefined>} [env] Environment bag; defaults to `process.env`.
 * @property {ConfigFileSource} [file] `config.json` path or parsed object.
 */

/**
 * Find the first environment variable of a field that carries a value.
 *
 * @param {import('./schema.js').ConfigField} field Field descriptor.
 * @param {Record<string, string | undefined>} env Environment bag.
 * @returns {{name: string, value: unknown} | null} First set entry, or `null`.
 */
function firstEnvEntry(field, env) {
    for (const name of field.env) {
        const value = env[name];
        if (!isUnset(value)) return { name, value };
    }
    return null;
}

/**
 * Read a {@link LoadConfigOptions.file} source into a plain object.
 *
 * A missing file is not an error (the defaults apply). A file that exists but
 * cannot be read or parsed is: silently ignoring a broken config would start the
 * service with settings nobody asked for.
 *
 * @param {ConfigFileSource} file File source.
 * @returns {Record<string, unknown>} Parsed values.
 * @throws {ConfigError} When the file is unreadable or malformed.
 */
function readFileConfig(file) {
    if (isUnset(file)) return {};
    if (Array.isArray(file)) {
        throw new ConfigError('Config file source must contain a JSON object, got an array', {
            source: 'config.json',
            value: file
        });
    }
    if (typeof file === 'object') return /** @type {Record<string, unknown>} */ (file);
    if (typeof file !== 'string') {
        throw new ConfigError(`Invalid config file source: expected a path, got ${typeof file}`, {
            source: 'config.json',
            value: file
        });
    }
    if (!fs.existsSync(file)) return {};

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new ConfigError(
            `Cannot read config file ${file}: ${error instanceof Error ? error.message : String(error)}`,
            { source: file, value: file }
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ConfigError(
            `Cannot parse config file ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`,
            { source: file, value: raw.slice(0, 120) }
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigError(`Config file ${file} must contain a JSON object`, {
            source: file,
            value: parsed
        });
    }
    return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Resolve one field: environment, then file, then default.
 *
 * @param {import('./schema.js').ConfigField} field Field descriptor.
 * @param {Record<string, string | undefined>} env Environment bag.
 * @param {Record<string, unknown>} fileValues Parsed `config.json` values.
 * @param {Record<string, unknown>} partial Fields resolved so far (for derived defaults).
 * @returns {unknown} Resolved value.
 * @throws {ConfigError} When a provided value is invalid.
 */
function resolveField(field, env, fileValues, partial) {
    const fromEnv = firstEnvEntry(field, env);
    if (fromEnv) return coerceField(field, fromEnv.value, `environment variable ${fromEnv.name}`);

    const fileKey = field.fileKey ?? field.key;
    if (Object.prototype.hasOwnProperty.call(fileValues, fileKey) && !isUnset(fileValues[fileKey])) {
        return coerceField(field, fileValues[fileKey], `config.json key ${fileKey}`);
    }

    if (typeof field.derive === 'function') return field.derive(partial);
    return Array.isArray(field.default) ? [...field.default] : field.default;
}

/**
 * Load, validate and freeze the configuration.
 *
 * Precedence is **environment > config.json > default**; an unset value (absent,
 * `null` or blank) falls through. Any present-but-unparseable value throws a
 * {@link ConfigError} naming the offending variable/key.
 *
 * The defaults here are the **effective values**, not the `0`/`undefined`/`''`
 * sentinels the pre-rewrite `index.js` used: `SESSION_TTL_MS` is already 30
 * minutes, `EVENT_IDLE_TIMEOUT_MS` / `EVENT_FIRST_DELTA_TIMEOUT_MS` are already
 * 8000 / 30000, `SESSION_HEADER_NAMES` already holds the documented header list
 * and `DIRECT_*_BASE_URL` already points at the upstream endpoints. Consumers can
 * use these values directly.
 *
 * @param {LoadConfigOptions} [options] Load options.
 * @returns {import('./schema.js').Config} Frozen configuration.
 * @throws {ConfigError} When a value is invalid or the config file is malformed.
 */
export function loadConfig({ env = process.env, file = null } = {}) {
    const fileValues = readFileConfig(file);

    /** @type {Record<string, unknown>} */
    const resolved = {};
    for (const field of CONFIG_FIELDS) {
        resolved[field.key] = resolveField(field, env, fileValues, resolved);
    }

    for (const [key, value] of Object.entries(resolved)) {
        if (Array.isArray(value)) resolved[key] = Object.freeze([...value]);
    }

    return /** @type {import('./schema.js').Config} */ (Object.freeze(resolved));
}
