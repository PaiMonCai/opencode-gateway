/**
 * Public surface of the configuration module.
 *
 * @module config
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
