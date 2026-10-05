import { PROXY_SCHEME_LIST, describeProxyUrl, parseProxyUrl } from './proxy-url.js';
/**
 * The configuration schema: every environment variable / `config.json` key the
 * gateway understands, its default and how it is validated.
 *
 * `Config` keeps today's environment-variable names and values — they are the
 * public interface (`docs/zh/configuration.md`). Precedence is
 * **environment > config.json > default**, and an unset value (absent, `null` or
 * an empty string) falls through to the next source. A value that is present but
 * cannot be parsed fails fast with a readable {@link ConfigError}.
 *
 * Defaults are stored as **effective values**: where the pre-rewrite code used a
 * `0` / `undefined` / `''` sentinel meaning "fall back to the library default",
 * the schema carries the resolved value instead (30-minute session TTL, 8000 /
 * 30000 ms event timeouts, the documented session-header list, the upstream base
 * URLs). Consumers never have to re-apply a default.
 *
 * @module config/schema
 */

/**
 * Session identity headers recognised by default, in priority order (first
 * non-empty wins). Kept in sync with `docs/zh/api-reference.md` §请求头.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_SESSION_HEADER_NAMES = Object.freeze([
    'x-opencode-session',
    'x-session-id',
    'x-thread-id',
    'x-conversation-id',
    'x-deepseek-harness-session-id',
    'session-id',
    'session_id',
    'thread-id',
    'thread_id',
    'conversation-id',
    'conversation_id'
]);

/** Default Go-subscription upstream base URL. */
export const DEFAULT_DIRECT_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** Default pay-as-you-go Zen upstream base URL. */
export const DEFAULT_DIRECT_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

/**
 * Startup/configuration failure. Thrown by {@link loadConfig} so an invalid
 * deployment stops immediately with a precise message instead of misbehaving
 * half-configured.
 *
 * @extends Error
 */
export class ConfigError extends Error {
    /**
     * @param {string} message Human-readable description.
     * @param {{source?: string, key?: string, value?: unknown}} [details] Where the bad value came from.
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'ConfigError';
        /** @type {string | undefined} Environment variable or config.json key. */
        this.source = details.source;
        /** @type {string | undefined} Config field name. */
        this.key = details.key;
        /** @type {unknown} The rejected raw value. */
        this.value = details.value;
    }
}

/**
 * @typedef {'boolean' | 'integer' | 'string' | 'url' | 'proxy-url' | 'enum' | 'list'} ConfigFieldType
 */

/**
 * A single configurable field.
 *
 * @typedef {object} ConfigField
 * @property {string} key {@link Config} field name (also the banner label source).
 * @property {string[]} env Environment-variable names, highest priority first.
 * @property {string} [fileKey] `config.json` key when it differs from `key`.
 * @property {ConfigFieldType} type How the raw value is coerced.
 * @property {unknown} [default] Default when neither env nor file sets it.
 * @property {(config: Record<string, any>) => unknown} [derive] Derived default computed
 *   from the fields resolved so far (used by `OPENCODE_SERVER_URL`).
 * @property {string} [description] One-line human description.
 * @property {boolean} [secret] Never print the value; print Configured/Not configured.
 * @property {string[]} [values] Allowed values for `enum` fields.
 * @property {number} [min] Minimum for `integer` fields.
 * @property {number} [max] Maximum for `integer` fields.
 * @property {boolean} [zeroMeansDefault] `0` is a sentinel meaning "use the default".
 * @property {boolean} [emptyListMeansDefault] An empty list means "use the default list".
 * @property {(value: any, config: Record<string, any>) => string} [banner] Startup banner line formatter.
 * @property {{replacement?: string}} [deprecated] Setting still honoured, with what to use instead.
 * @property {string} [removed] Reason a setting no longer does anything.
 */

/**
 * True for values that carry no configuration signal: absent, `null` or blank.
 *
 * @param {unknown} value Raw value.
 * @returns {boolean} Whether the value counts as unset.
 */
export function isUnset(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Accepted truthy/falsy boolean spellings, matching the pre-rewrite parser. */
const TRUE_VALUES = Object.freeze(['1', 'true', 'yes', 'y', 'on']);
const FALSE_VALUES = Object.freeze(['0', 'false', 'no', 'n', 'off']);

/**
 * Coerce one raw value to the field's type, or throw {@link ConfigError}.
 *
 * @param {ConfigField} field Field being resolved.
 * @param {unknown} value Raw value (already known not to be unset).
 * @param {string} source Where the value came from, for error messages.
 * @returns {unknown} Coerced value.
 * @throws {ConfigError} When the value cannot be coerced.
 */
export function coerceField(field, value, source) {
    /**
     * Throw a {@link ConfigError} naming the expected shape.
     *
     * @param {string} expected Human description of the expected value.
     * @returns {never} Always throws.
     */
    const fail = (expected) => {
        throw new ConfigError(
            `Invalid value for ${source} (${field.key}): expected ${expected}, got ${JSON.stringify(value)}`,
            { source, key: field.key, value }
        );
    };

    switch (field.type) {
        case 'boolean': {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') {
                if (value === 1) return true;
                if (value === 0) return false;
                return fail('a boolean (true/false)');
            }
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (TRUE_VALUES.includes(normalized)) return true;
                if (FALSE_VALUES.includes(normalized)) return false;
                return fail(`a boolean (${TRUE_VALUES.join('/')} or ${FALSE_VALUES.join('/')})`);
            }
            return fail('a boolean (true/false)');
        }
        case 'integer': {
            let parsed;
            if (typeof value === 'number') {
                parsed = value;
            } else if (typeof value === 'string' && value.trim() !== '') {
                parsed = Number(value.trim());
            } else {
                return fail('an integer');
            }
            if (!Number.isInteger(parsed)) return fail('an integer');
            if (parsed === 0 && field.zeroMeansDefault) return field.default;
            if (typeof field.min === 'number' && parsed < field.min) {
                return fail(`an integer >= ${field.min}`);
            }
            if (typeof field.max === 'number' && parsed > field.max) {
                return fail(`an integer <= ${field.max}`);
            }
            return parsed;
        }
        case 'string': {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed === '') return fail('a non-empty string');
                return trimmed;
            }
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            return fail('a string');
        }
        case 'url': {
            if (typeof value !== 'string') return fail('an http(s) URL');
            let parsed;
            try {
                parsed = new URL(value.trim());
            } catch {
                return fail('an http(s) URL');
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return fail('an http(s) URL');
            }
            return value.trim().replace(/\/+$/, '');
        }
        case 'proxy-url': {
            if (value === '' || value === null || value === undefined) return '';
            let parsed;
            try {
                parsed = parseProxyUrl(value);
            } catch (error) {
                return fail(error instanceof Error ? error.message : `a proxy URL (${PROXY_SCHEME_LIST})`);
            }
            return parsed ? parsed.url : '';
        }
        case 'enum': {
            if (typeof value !== 'string') return fail(`one of ${(field.values ?? []).join(', ')}`);
            const normalized = value.trim();
            if (!(field.values ?? []).includes(normalized)) {
                return fail(`one of ${(field.values ?? []).join(', ')}`);
            }
            return normalized;
        }
        case 'list': {
            let entries;
            if (Array.isArray(value)) {
                entries = value;
            } else if (typeof value === 'string') {
                entries = value.split(',');
            } else {
                return fail('a comma-separated list');
            }
            const normalized = [
                ...new Set(
                    entries
                        .map((entry) =>
                            typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()
                        )
                        .filter(Boolean)
                )
            ];
            if (normalized.length === 0 && field.emptyListMeansDefault) return field.default;
            return normalized;
        }
        default:
            return fail('a supported value');
    }
}

/** @type {ConfigField[]} */
const FIELDS = [
    {
        key: 'PORT',
        env: ['OPENCODE_PROXY_PORT', 'PORT'],
        fileKey: 'PORT',
        type: 'integer',
        min: 1,
        max: 65535,
        default: 10000,
        description: 'Proxy listen port',
        banner: (value) => `  - Port: ${value}`
    },
    {
        key: 'BIND_HOST',
        env: ['BIND_HOST'],
        fileKey: 'BIND_HOST',
        type: 'string',
        default: '0.0.0.0',
        description: 'Listen address',
        banner: (value) => `  - Bind Host: ${value}`
    },
    {
        key: 'OPENCODE_SERVER_PORT',
        env: ['OPENCODE_SERVER_PORT'],
        type: 'integer',
        min: 1,
        max: 65535,
        default: 10001,
        description: 'Backend port, used to derive the default OPENCODE_SERVER_URL'
    },
    {
        key: 'OPENCODE_SERVER_URL',
        env: ['OPENCODE_SERVER_URL'],
        fileKey: 'OPENCODE_SERVER_URL',
        type: 'url',
        derive: (config) => `http://127.0.0.1:${config.OPENCODE_SERVER_PORT}`,
        description: 'OpenCode backend base URL',
        banner: (value) => `  - Backend: ${value}`
    },
    {
        key: 'OPENCODE_SERVER_PASSWORD',
        env: ['OPENCODE_SERVER_PASSWORD'],
        fileKey: 'OPENCODE_SERVER_PASSWORD',
        type: 'string',
        default: '',
        description: 'Backend basic-auth password',
        secret: true,
        banner: (value) => `  - Backend Password: ${value ? 'Configured' : 'Not configured'}`
    },
    {
        key: 'API_KEY',
        env: ['API_KEY'],
        fileKey: 'API_KEY',
        type: 'string',
        default: '',
        description: 'Bearer key clients must present; empty disables auth',
        secret: true,
        banner: (value) => `  - API Key: ${value ? 'Configured' : 'Not configured (no auth)'}`
    },
    {
        key: 'ALLOW_PUBLIC_NO_AUTH',
        env: ['OPENCODE_PROXY_ALLOW_PUBLIC_NO_AUTH'],
        fileKey: 'ALLOW_PUBLIC_NO_AUTH',
        type: 'boolean',
        default: false,
        description: 'Explicitly allow an unauthenticated non-loopback listener',
        banner: (value) => `  - Public No-Auth Override: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'ZEN_API_KEY',
        env: ['OPENCODE_ZEN_API_KEY'],
        fileKey: 'ZEN_API_KEY',
        type: 'string',
        default: '',
        description: 'Zen API key for the direct upstream and the managed backend',
        secret: true,
        banner: (value) => `  - Zen API Key: ${value ? 'Configured' : 'Not configured'}`
    },
    {
        key: 'MANAGE_BACKEND',
        env: ['OPENCODE_PROXY_MANAGE_BACKEND'],
        fileKey: 'MANAGE_BACKEND',
        type: 'boolean',
        default: true,
        description: 'Let the proxy spawn and manage the OpenCode backend',
        banner: (value) => `  - Manage Backend: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'OPENCODE_PATH',
        env: ['OPENCODE_PATH'],
        fileKey: 'OPENCODE_PATH',
        type: 'string',
        default: 'opencode',
        description: 'OpenCode executable path',
        banner: (value) => `  - OpenCode Path: ${value}`
    },
    {
        key: 'USE_ISOLATED_HOME',
        env: ['OPENCODE_USE_ISOLATED_HOME'],
        fileKey: 'USE_ISOLATED_HOME',
        type: 'boolean',
        default: false,
        description: 'Run the backend with an isolated OpenCode home',
        banner: (value) => `  - Use Isolated Home: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'DISABLE_TOOLS',
        env: ['OPENCODE_DISABLE_TOOLS'],
        fileKey: 'DISABLE_TOOLS',
        type: 'boolean',
        default: true,
        description: 'Disable built-in OpenCode tools',
        banner: (value) => `  - Disable Tools: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'EXTERNAL_TOOLS_MODE',
        env: ['OPENCODE_EXTERNAL_TOOLS_MODE'],
        fileKey: 'EXTERNAL_TOOLS_MODE',
        type: 'enum',
        values: ['proxy-bridge'],
        default: 'proxy-bridge',
        description: 'External tool bridging mode',
        banner: (value) => `  - External Tools Mode: ${value}`
    },
    {
        key: 'EXTERNAL_TOOLS_CONFLICT_POLICY',
        env: [],
        fileKey: 'EXTERNAL_TOOLS_CONFLICT_POLICY',
        type: 'enum',
        values: ['namespace'],
        default: 'namespace',
        removed: 'There is only one policy: same-name tools are namespaced.',
        description: 'Same-name tool conflict policy'
    },
    {
        key: 'INTERNAL_WEB_FETCH_ENABLED',
        env: ['OPENCODE_INTERNAL_WEB_FETCH_ENABLED'],
        fileKey: 'INTERNAL_WEB_FETCH_ENABLED',
        type: 'boolean',
        default: false,
        description: 'Legacy shortcut: allow web_fetch when no allowlist is set',
        banner: (value) => `  - Internal web_fetch Enabled: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'INTERNAL_ALLOWED_TOOLS',
        env: ['OPENCODE_INTERNAL_ALLOWED_TOOLS'],
        fileKey: 'INTERNAL_ALLOWED_TOOLS',
        type: 'list',
        default: [],
        description: 'Built-in tools allowed when the request sends no tools',
        banner: (value) =>
            `  - Internal Allowed Tools: ${value.length ? /** @type {string[]} */ (value).join(', ') : '(none)'}`
    },
    {
        key: 'INTERNAL_TOOL_METRICS_ENABLED',
        env: [],
        fileKey: 'INTERNAL_TOOL_METRICS_ENABLED',
        type: 'boolean',
        default: true,
        removed: 'Internal tool metrics are always collected; expose them with OPENCODE_PROXY_OPS=full.',
        description: 'Emit allowlist-mode debug/metrics logs'
    },
    {
        key: 'INTERNAL_TOOL_DISCOVERY_FIXTURE',
        env: [],
        fileKey: 'INTERNAL_TOOL_DISCOVERY_FIXTURE',
        type: 'list',
        default: [],
        removed: 'Test-only knob; inject the tool list when constructing the engine instead.',
        description: 'Fixed backend tool id list for tests/debugging'
    },
    {
        key: 'OPS',
        env: ['OPENCODE_PROXY_OPS'],
        fileKey: 'OPS',
        type: 'enum',
        values: ['off', 'health', 'full'],
        default: 'health',
        description:
            'Operational endpoints: off, health (`/health/details`, auth required) or full (adds `/metrics`)',
        banner: (value) => `  - Ops endpoints: ${value}`
    },
    // The four switches below are derived from OPS. Their environment names still
    // work (an explicit value wins) but they are no longer part of the documented
    // surface: OPENCODE_PROXY_OPS is the knob to use.
    {
        key: 'HEALTH_DETAILS_ENABLED',
        env: [],
        fileKey: 'HEALTH_DETAILS_ENABLED',
        type: 'boolean',
        derive: (config) => config.OPS !== 'off',
        removed: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
        description: 'Expose GET /health/details (derived from OPS)'
    },
    {
        key: 'HEALTH_DETAILS_REQUIRE_AUTH',
        env: [],
        fileKey: 'HEALTH_DETAILS_REQUIRE_AUTH',
        type: 'boolean',
        derive: () => true,
        removed: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
        description: 'Require bearer auth on /health/details (always on)'
    },
    {
        key: 'METRICS_ENABLED',
        env: [],
        fileKey: 'METRICS_ENABLED',
        type: 'boolean',
        derive: (config) => config.OPS === 'full',
        removed: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
        description: 'Expose GET /metrics (derived from OPS)'
    },
    {
        key: 'METRICS_REQUIRE_AUTH',
        env: [],
        fileKey: 'METRICS_REQUIRE_AUTH',
        type: 'boolean',
        derive: () => true,
        removed: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
        description: 'Require bearer auth on /metrics (always on)'
    },
    {
        key: 'PROMPT_MODE',
        env: ['OPENCODE_PROXY_PROMPT_MODE'],
        fileKey: 'PROMPT_MODE',
        type: 'enum',
        values: ['standard', 'plugin-inject'],
        default: 'standard',
        description: 'Prompt handling mode',
        banner: (value) => `  - Prompt Mode: ${value}`
    },
    {
        key: 'OMIT_SYSTEM_PROMPT',
        env: ['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT'],
        fileKey: 'OMIT_SYSTEM_PROMPT',
        type: 'boolean',
        default: false,
        description: 'Ignore the incoming system prompt',
        banner: (value) => `  - Omit System Prompt: ${value ? 'Yes' : 'No'}`
    },
    {
        key: 'STORAGE_CLEANUP',
        env: ['OPENCODE_PROXY_STORAGE_CLEANUP'],
        fileKey: 'STORAGE_CLEANUP',
        type: 'enum',
        values: ['off', 'hourly', 'daily'],
        default: 'off',
        description: 'Sweep stored conversations on a schedule: off, hourly or daily',
        banner: (value) => `  - Conversation storage cleanup: ${value}`
    },
    // Derived from STORAGE_CLEANUP; the environment names still work and win when
    // set explicitly, but the enum is the documented knob.
    {
        key: 'AUTO_CLEANUP_CONVERSATIONS',
        env: [],
        fileKey: 'AUTO_CLEANUP_CONVERSATIONS',
        type: 'boolean',
        derive: (config) => config.STORAGE_CLEANUP !== 'off',
        removed: 'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
        description: 'Periodically sweep stored conversations (derived from STORAGE_CLEANUP)'
    },
    {
        key: 'CLEANUP_INTERVAL_MS',
        env: [],
        fileKey: 'CLEANUP_INTERVAL_MS',
        type: 'integer',
        min: 0,
        default: 43200000,
        zeroMeansDefault: true,
        derive: (config) =>
            config.STORAGE_CLEANUP === 'hourly'
                ? 3600000
                : config.STORAGE_CLEANUP === 'daily'
                  ? 86400000
                  : 43200000,
        removed: 'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
        description: 'Cleanup sweep interval in ms (derived from STORAGE_CLEANUP)'
    },
    {
        key: 'CLEANUP_MAX_AGE_MS',
        env: [],
        fileKey: 'CLEANUP_MAX_AGE_MS',
        type: 'integer',
        min: 0,
        default: 86400000,
        zeroMeansDefault: true,
        removed: 'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
        description: 'Conversation max age in ms'
    },
    {
        key: 'REQUEST_TIMEOUT_MS',
        env: ['OPENCODE_PROXY_REQUEST_TIMEOUT_MS'],
        fileKey: 'REQUEST_TIMEOUT_MS',
        type: 'integer',
        min: 0,
        default: 180000,
        zeroMeansDefault: true,
        description: 'Upstream request timeout in ms',
        banner: (value) => `  - Request Timeout: ${value}ms`
    },
    {
        key: 'MAX_CONCURRENT_TURNS',
        env: ['OPENCODE_PROXY_MAX_CONCURRENT_TURNS'],
        fileKey: 'MAX_CONCURRENT_TURNS',
        type: 'integer',
        min: 1,
        max: 10000,
        default: 20,
        description: 'Maximum number of turns allowed to execute concurrently',
        banner: (value) => `  - Max Concurrent Turns: ${value}`
    },
    {
        key: 'MAX_PENDING_TURNS',
        env: ['OPENCODE_PROXY_MAX_PENDING_TURNS'],
        fileKey: 'MAX_PENDING_TURNS',
        type: 'integer',
        min: 0,
        max: 100000,
        default: 100,
        description: 'Maximum number of turns allowed to wait for global capacity',
        banner: (value) => `  - Max Pending Turns: ${value}`
    },
    {
        key: 'CONCURRENCY_WAIT_MS',
        env: ['OPENCODE_PROXY_CONCURRENCY_WAIT_MS'],
        fileKey: 'CONCURRENCY_WAIT_MS',
        type: 'integer',
        min: 0,
        default: 2000,
        description: 'Maximum wait for global turn capacity; zero fails fast',
        banner: (value) => `  - Concurrency Wait: ${value}ms`
    },
    {
        key: 'EVENT_IDLE_TIMEOUT_MS',
        env: ['OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS'],
        fileKey: 'EVENT_IDLE_TIMEOUT_MS',
        type: 'integer',
        min: 0,
        default: 8000,
        zeroMeansDefault: true,
        description: 'Streaming idle timeout in ms',
        banner: (value) => `  - Event Idle Timeout: ${value}ms`
    },
    {
        key: 'EVENT_FIRST_DELTA_TIMEOUT_MS',
        env: ['OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS'],
        fileKey: 'EVENT_FIRST_DELTA_TIMEOUT_MS',
        type: 'integer',
        min: 0,
        default: 30000,
        zeroMeansDefault: true,
        description: 'Streaming first-delta timeout in ms',
        banner: (value) => `  - Event First Delta Timeout: ${value}ms`
    },
    {
        key: 'SESSION_REUSE_ENABLED',
        env: ['OPENCODE_PROXY_SESSION_REUSE'],
        fileKey: 'SESSION_REUSE_ENABLED',
        type: 'boolean',
        default: true,
        description: 'Reuse one backend session per conversation identity',
        banner: (value, config) =>
            `  - Session Reuse: ${value ? 'Yes' : 'No'}${
                value
                    ? ` (ttl ${Math.round(Number(config.SESSION_TTL_MS) / 1000)}s, headers: ${
                          /** @type {string[]} */ (config.SESSION_HEADER_NAMES).length
                              ? /** @type {string[]} */ (config.SESSION_HEADER_NAMES).join(', ')
                              : '(proxy default)'
                      })`
                    : ''
            }`
    },
    {
        key: 'SESSION_TTL_MS',
        env: ['OPENCODE_PROXY_SESSION_TTL_MS'],
        fileKey: 'SESSION_TTL_MS',
        type: 'integer',
        min: 0,
        default: 1800000,
        zeroMeansDefault: true,
        description: 'Idle time before a conversation session is closed'
    },
    {
        key: 'SESSION_HEADER_NAMES',
        env: ['OPENCODE_PROXY_SESSION_HEADERS'],
        fileKey: 'SESSION_HEADER_NAMES',
        type: 'list',
        default: DEFAULT_SESSION_HEADER_NAMES,
        emptyListMeansDefault: true,
        description: 'Request headers carrying the conversation identity'
    },
    {
        key: 'SESSION_DERIVE_ENABLED',
        env: ['OPENCODE_PROXY_SESSION_DERIVE'],
        fileKey: 'SESSION_DERIVE_ENABLED',
        type: 'boolean',
        default: false,
        description: 'Derive the conversation identity when no header is sent',
        banner: (value) => `  - Session Identity Derivation: ${value ? 'Yes (no header required)' : 'No'}`
    },
    {
        key: 'DIRECT_ENABLED',
        env: ['OPENCODE_PROXY_DIRECT'],
        fileKey: 'DIRECT_ENABLED',
        type: 'boolean',
        default: true,
        description: 'Send OpenAI-format requests straight to the upstream',
        banner: (value, config) =>
            `  - Direct Upstream: ${
                value
                    ? `Yes (go: ${config.DIRECT_GO_BASE_URL || 'default'}, zen: ${
                          config.DIRECT_ZEN_BASE_URL || 'default'
                      }${config.ZEN_API_KEY ? '' : ', no key configured yet'})`
                    : 'No'
            }`
    },
    {
        key: 'DIRECT_GO_BASE_URL',
        env: ['OPENCODE_PROXY_DIRECT_GO_URL'],
        fileKey: 'DIRECT_GO_BASE_URL',
        type: 'url',
        default: DEFAULT_DIRECT_GO_BASE_URL,
        description: 'Go-subscription endpoint base URL'
    },
    {
        key: 'DIRECT_ZEN_BASE_URL',
        env: ['OPENCODE_PROXY_DIRECT_ZEN_URL'],
        fileKey: 'DIRECT_ZEN_BASE_URL',
        type: 'url',
        default: DEFAULT_DIRECT_ZEN_BASE_URL,
        description: 'Paid Zen endpoint base URL'
    },
    {
        key: 'DIRECT_FREE_VIA_RUNTIME',
        env: [],
        fileKey: 'DIRECT_FREE_VIA_RUNTIME',
        type: 'boolean',
        default: true,
        removed: 'The free tier is always served by the runtime; there is no other way to reach it.',
        description: 'Keep free-tier models on the runtime'
    },
    {
        key: 'DIRECT_FALLBACK_TO_RUNTIME',
        env: ['OPENCODE_PROXY_DIRECT_FALLBACK'],
        fileKey: 'DIRECT_FALLBACK_TO_RUNTIME',
        type: 'boolean',
        default: true,
        description: 'Fall back to the runtime when the direct upstream refuses'
    },
    {
        key: 'UPSTREAM_PROXY',
        env: [
            'OPENCODE_PROXY_UPSTREAM_PROXY',
            'ALL_PROXY',
            'all_proxy',
            'HTTPS_PROXY',
            'https_proxy',
            'HTTP_PROXY',
            'http_proxy'
        ],
        fileKey: 'UPSTREAM_PROXY',
        type: 'proxy-url',
        default: '',
        description:
            'SOCKS or HTTP(S) proxy for upstream calls (socks5h://, socks5://, socks4a://, socks4://, http://, https://)',
        banner: (value) => `  - Upstream Proxy: ${describeProxyUrl(value)}`
    },
    {
        key: 'UPSTREAM_PROXY_FOR_RUNTIME',
        env: ['OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME'],
        fileKey: 'UPSTREAM_PROXY_FOR_RUNTIME',
        type: 'boolean',
        default: true,
        description: 'Also export the upstream proxy to the managed runtime so its own egress uses it',
        banner: (value, config) => {
            if (!config.UPSTREAM_PROXY) return '  - Proxy for managed runtime: n/a (no proxy configured)';
            if (!value) return '  - Proxy for managed runtime: No';
            // A SOCKS proxy cannot be handed to the runtime at all: it only
            // honours http(s) proxy URLs, and exporting a SOCKS one breaks every
            // turn inside it.
            return `  - Proxy for managed runtime: ${
                parseProxyUrl(config.UPSTREAM_PROXY)?.family === 'http'
                    ? 'Yes'
                    : 'No (the runtime only supports http(s) proxies)'
            }`;
        }
    },
    {
        key: 'DEBUG',
        env: ['OPENCODE_PROXY_DEBUG'],
        fileKey: 'DEBUG',
        type: 'boolean',
        default: false,
        description: 'Verbose, human-readable logging',
        banner: (value) => `  - Debug: ${value ? 'Yes' : 'No'}`
    }
];

/**
 * Frozen schema: every field, in banner order.
 *
 * @type {readonly ConfigField[]}
 */
export const CONFIG_FIELDS = Object.freeze(FIELDS);

/**
 * Environment names that no longer do anything at all, with the reason they
 * disappeared. Setting one is reported at startup and otherwise ignored.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REMOVED_ENV_NAMES = Object.freeze({
    OPENCODE_HEALTH_DETAILS_ENABLED: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
    OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
    OPENCODE_METRICS_ENABLED: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
    OPENCODE_METRICS_REQUIRE_AUTH: 'Removed; use OPENCODE_PROXY_OPS=off|health|full instead.',
    OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS:
        'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
    OPENCODE_PROXY_CLEANUP_INTERVAL_MS:
        'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
    OPENCODE_PROXY_CLEANUP_MAX_AGE_MS:
        'Removed; use OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily instead.',
    OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY: 'There is only one policy: same-name tools are namespaced.',
    OPENCODE_INTERNAL_TOOL_METRICS_ENABLED:
        'Internal tool metrics are always collected; expose them with OPENCODE_PROXY_OPS=full.',
    OPENCODE_TOOL_DISCOVERY_FIXTURE:
        'It was a test-only knob; inject the tool list when constructing the engine instead.',
    OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME:
        'The free tier is always served by the runtime; it is not reachable any other way.'
});

/**
 * @typedef {object} Deprecation
 * @property {string} name Setting that was set.
 * @property {string} source Where it was set (`env` or `config.json`).
 * @property {string} message What to do instead.
 */

/**
 * Report the settings an operator still uses that are no longer documented.
 *
 * @param {Record<string, string | undefined>} env Environment bag.
 * @param {Record<string, unknown>} fileValues Parsed `config.json` values.
 * @returns {Deprecation[]} One entry per deprecated setting that is present.
 */
export function collectRemovedSettings(env, fileValues = {}) {
    /** @type {Deprecation[]} */
    const found = [];

    for (const [key, value] of Object.entries(fileValues)) {
        if (isUnset(value)) continue;
        const removed = REMOVED_FILE_KEY_NOTES[key];
        if (removed) {
            found.push({ name: `config.json key ${key}`, source: 'config.json', message: removed });
        }
    }

    for (const [name, value] of Object.entries(env)) {
        if (isUnset(value)) continue;
        const removed = REMOVED_ENV_NAMES[name];
        if (removed) {
            found.push({ name, source: 'env', message: removed });
        }
    }

    return found;
}

/** `config.json` keys of settings that no longer do anything. */
const REMOVED_FILE_KEY_NOTES = Object.freeze(
    Object.fromEntries(FIELDS.filter((field) => field.removed).map((field) => [field.key, field.removed]))
);

/**
 * Fully resolved, frozen configuration.
 *
 * @typedef {object} Config
 * @property {number} PORT
 * @property {string} BIND_HOST
 * @property {number} OPENCODE_SERVER_PORT
 * @property {string} OPENCODE_SERVER_URL
 * @property {string} OPENCODE_SERVER_PASSWORD
 * @property {string} API_KEY
 * @property {boolean} ALLOW_PUBLIC_NO_AUTH
 * @property {string} ZEN_API_KEY
 * @property {boolean} MANAGE_BACKEND
 * @property {string} OPENCODE_PATH
 * @property {boolean} USE_ISOLATED_HOME
 * @property {boolean} DISABLE_TOOLS
 * @property {'proxy-bridge'} EXTERNAL_TOOLS_MODE
 * @property {'namespace'} EXTERNAL_TOOLS_CONFLICT_POLICY
 * @property {boolean} INTERNAL_WEB_FETCH_ENABLED
 * @property {string[]} INTERNAL_ALLOWED_TOOLS
 * @property {boolean} INTERNAL_TOOL_METRICS_ENABLED
 * @property {string[]} INTERNAL_TOOL_DISCOVERY_FIXTURE
 * @property {boolean} HEALTH_DETAILS_ENABLED
 * @property {boolean} HEALTH_DETAILS_REQUIRE_AUTH
 * @property {boolean} METRICS_ENABLED
 * @property {boolean} METRICS_REQUIRE_AUTH
 * @property {'standard' | 'plugin-inject'} PROMPT_MODE
 * @property {boolean} OMIT_SYSTEM_PROMPT
 * @property {boolean} AUTO_CLEANUP_CONVERSATIONS
 * @property {number} CLEANUP_INTERVAL_MS
 * @property {number} CLEANUP_MAX_AGE_MS
 * @property {number} REQUEST_TIMEOUT_MS
 * @property {number} MAX_CONCURRENT_TURNS
 * @property {number} MAX_PENDING_TURNS
 * @property {number} CONCURRENCY_WAIT_MS
 * @property {number} EVENT_IDLE_TIMEOUT_MS
 * @property {number} EVENT_FIRST_DELTA_TIMEOUT_MS
 * @property {boolean} SESSION_REUSE_ENABLED
 * @property {number} SESSION_TTL_MS
 * @property {string[]} SESSION_HEADER_NAMES
 * @property {boolean} SESSION_DERIVE_ENABLED
 * @property {boolean} DIRECT_ENABLED
 * @property {string} DIRECT_GO_BASE_URL
 * @property {string} DIRECT_ZEN_BASE_URL
 * @property {boolean} DIRECT_FREE_VIA_RUNTIME
 * @property {boolean} DIRECT_FALLBACK_TO_RUNTIME
 * @property {string} UPSTREAM_PROXY
 * @property {boolean} UPSTREAM_PROXY_FOR_RUNTIME
 * @property {Array<{name: string, source: string, message: string}>} REMOVED_SETTINGS
 * @property {string} UPSTREAM_PROXY
 * @property {boolean} UPSTREAM_PROXY_FOR_RUNTIME
 * @property {boolean} DEBUG
 */

/**
 * Startup banner: one line per configured value, with secrets redacted.
 *
 * @param {Config | Record<string, unknown>} config Resolved configuration.
 * @returns {{line: string}[]} Banner lines, in schema order.
 */
export function describeConfig(config) {
    /** @type {{line: string}[]} */
    const lines = [];
    for (const field of CONFIG_FIELDS) {
        if (typeof field.banner !== 'function') continue;
        const value = /** @type {Record<string, unknown>} */ (config)[field.key];
        lines.push({ line: field.banner(value, /** @type {Record<string, unknown>} */ (config)) });
    }
    return lines;
}
