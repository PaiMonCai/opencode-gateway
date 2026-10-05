/**
 * Operational HTTP surfaces for liveness, diagnostics and Prometheus metrics.
 *
 * Kept outside the turn engine so protocol execution remains focused on Chat and
 * Responses while operational policy/state rendering can evolve independently.
 *
 * @module routes/operations
 */

import { shouldAllowOperationalEndpoint } from '../http/auth.js';

/**
 * @typedef {object} InternalToolMetrics
 * @property {number} externalBridgeRequests
 * @property {number} internalAllowlistRequests
 * @property {number} disabledRequests
 * @property {number} discoveryFailures
 * @property {number} fallbackToDisabled
 */

/**
 * @typedef {object} ToolCacheSnapshot
 * @property {string[]|null} ids
 * @property {number} updatedAt
 */

/**
 * @typedef {object} OperationalSurfaceOptions
 * @property {Record<string, any>} config Resolved gateway config (tests may inject a partial object).
 * @property {{snapshot: () => any}} capacityLimiter Global turn limiter.
 * @property {string[]} allowedToolNames Effective server-side internal tool allowlist.
 * @property {string[]} discoveryFixture Normalized configured discovery fixture.
 * @property {InternalToolMetrics} internalToolMetrics Mutable metrics object.
 * @property {() => ToolCacheSnapshot} getToolCacheSnapshot Current backend-tool cache state.
 * @property {() => number} [clock] Clock used for cache age.
 */

/**
 * Build liveness, diagnostics and metrics handlers.
 *
 * @param {OperationalSurfaceOptions} options Operational dependencies.
 * @returns {{
 *   handleHealth: import('express').RequestHandler,
 *   handleHealthDetails: import('express').RequestHandler,
 *   handleMetrics: import('express').RequestHandler,
 *   getInternalToolDashboard: () => object,
 *   renderMetrics: () => string
 * }}
 */
export function createOperationalSurface({
    config,
    capacityLimiter,
    allowedToolNames,
    discoveryFixture,
    internalToolMetrics,
    getToolCacheSnapshot,
    clock = () => Date.now()
}) {
    const {
        API_KEY,
        INTERNAL_TOOL_METRICS_ENABLED = true,
        HEALTH_DETAILS_ENABLED = true,
        HEALTH_DETAILS_REQUIRE_AUTH = true,
        METRICS_ENABLED = false,
        METRICS_REQUIRE_AUTH = true
    } = config;

    const auditFields = Object.freeze([
        'requestedAllowlist',
        'allowedToolNames',
        'deniedRequestedTools',
        'resolutionPath',
        'resultingMode'
    ]);

    /** @returns {{tool_ids_cached: boolean, tool_id_count: number, age_ms: number|null}} */
    const getCacheDashboard = () => {
        const cache = getToolCacheSnapshot();
        return {
            tool_ids_cached: !!cache.ids,
            tool_id_count: cache.ids ? cache.ids.length : 0,
            age_ms: cache.updatedAt ? clock() - cache.updatedAt : null
        };
    };

    /** @returns {object} Payload behind `/health/details`. */
    const getInternalToolDashboard = () => ({
        status: 'ok',
        proxy: true,
        concurrency: capacityLimiter.snapshot(),
        internal_tools: {
            config: {
                allowed_tools: allowedToolNames,
                metrics_enabled: INTERNAL_TOOL_METRICS_ENABLED,
                discovery_fixture: discoveryFixture
            },
            metrics: INTERNAL_TOOL_METRICS_ENABLED ? { ...internalToolMetrics } : null,
            cache: getCacheDashboard(),
            audit: {
                available: true,
                fields: [...auditFields]
            }
        }
    });

    /** @returns {string[]} Prometheus lines for global turn capacity. */
    const concurrencyMetricLines = () => {
        const snapshot = capacityLimiter.snapshot();
        return [
            '# HELP opencode_gateway_turns_active Turns currently holding global capacity.',
            '# TYPE opencode_gateway_turns_active gauge',
            `opencode_gateway_turns_active ${snapshot.active}`,
            '# HELP opencode_gateway_turns_pending Turns waiting for global capacity.',
            '# TYPE opencode_gateway_turns_pending gauge',
            `opencode_gateway_turns_pending ${snapshot.pending}`,
            '# HELP opencode_gateway_turn_limit Configured global turn concurrency limit.',
            '# TYPE opencode_gateway_turn_limit gauge',
            `opencode_gateway_turn_limit ${snapshot.maxConcurrent}`,
            '# HELP opencode_gateway_turn_pending_limit Configured global pending-turn limit.',
            '# TYPE opencode_gateway_turn_pending_limit gauge',
            `opencode_gateway_turn_pending_limit ${snapshot.maxPending}`,
            '# HELP opencode_gateway_turn_rejections_total Turns rejected because the pending queue was full or fail-fast mode was enabled.',
            '# TYPE opencode_gateway_turn_rejections_total counter',
            `opencode_gateway_turn_rejections_total ${snapshot.rejectedTotal}`,
            '# HELP opencode_gateway_turn_wait_timeouts_total Turns rejected after waiting too long for capacity.',
            '# TYPE opencode_gateway_turn_wait_timeouts_total counter',
            `opencode_gateway_turn_wait_timeouts_total ${snapshot.timedOutTotal}`,
            '# HELP opencode_gateway_turn_aborts_total Queued turns removed because the client disconnected.',
            '# TYPE opencode_gateway_turn_aborts_total counter',
            `opencode_gateway_turn_aborts_total ${snapshot.abortedTotal}`
        ];
    };

    /** @returns {string} Prometheus text for `/metrics`. */
    const renderMetrics = () => {
        const cache = getToolCacheSnapshot();
        const metricsLines = [
            '# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.',
            '# TYPE opencode_internal_tool_mode_requests_total counter',
            `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
            '# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.',
            '# TYPE opencode_internal_tool_discovery_failures_total counter',
            `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
            '# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.',
            '# TYPE opencode_internal_tool_fallback_disabled_total counter',
            `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
            '# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.',
            '# TYPE opencode_internal_tool_cache_ids gauge',
            `opencode_internal_tool_cache_ids ${cache.ids ? cache.ids.length : 0}`,
            ...concurrencyMetricLines()
        ];
        return `${metricsLines.join('\n')}\n`;
    };

    /** @type {import('express').RequestHandler} */
    const handleHealth = (_req, res) => {
        res.json({ status: 'ok', proxy: true });
    };

    /** @type {import('express').RequestHandler} */
    const handleHealthDetails = (req, res) => {
        if (
            !shouldAllowOperationalEndpoint(
                req,
                {
                    enabled: HEALTH_DETAILS_ENABLED,
                    requireAuth: HEALTH_DETAILS_REQUIRE_AUTH
                },
                API_KEY
            )
        ) {
            res.status(HEALTH_DETAILS_ENABLED ? 401 : 404).send(
                HEALTH_DETAILS_ENABLED ? 'Unauthorized' : 'Not found'
            );
            return;
        }

        res.json(getInternalToolDashboard());
    };

    /** @type {import('express').RequestHandler} */
    const handleMetrics = (req, res) => {
        if (
            !shouldAllowOperationalEndpoint(
                req,
                {
                    enabled: METRICS_ENABLED,
                    requireAuth: METRICS_REQUIRE_AUTH
                },
                API_KEY
            )
        ) {
            res.status(METRICS_ENABLED ? 401 : 404).send(METRICS_ENABLED ? 'Unauthorized' : 'Not found');
            return;
        }

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(renderMetrics());
    };

    return {
        handleHealth,
        handleHealthDetails,
        handleMetrics,
        getInternalToolDashboard,
        renderMetrics
    };
}
