/**
 * Public surface of the configuration module.
 *
 * @module config
 */

/**
 * The resolved, frozen configuration object, re-exported for consumers.
 *
 * @typedef {import('./schema.js').Config} Config
 */

export { loadConfig } from './load.js';
export {
    ConfigError,
    CONFIG_FIELDS,
    DEFAULT_DIRECT_GO_BASE_URL,
    DEFAULT_DIRECT_ZEN_BASE_URL,
    DEFAULT_SESSION_HEADER_NAMES,
    describeConfig,
    isUnset
} from './schema.js';
