/**
 * OpenAI-surface turn engine.
 *
 * Owns everything a turn needs after the HTTP edge parsed the request: model
 * resolution, tool policy, prompt assembly, the runtime/direct upstream turn,
 * retries, `previous_response_id` continuation and the streaming writers.
 *
 * @module routes/engine
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTurnLimiter } from '../concurrency/turn-limiter.js';
import { createOperationalSurface } from './operations.js';
import { createChatHandler } from './chat-handler.js';
import { createResponsesHandler } from './responses-handler.js';
import { createResponseChainService } from './response-chain-service.js';
import { createConversationTurnService } from './conversation-service.js';
import { createModelResolver } from './model-resolver.js';
import { createResponseChainIndex } from '../conversation/response-chains.js';
import { createStorageCleanup } from '../conversation/storage-cleanup.js';
import { createDirectTurnRunner } from './direct-turn.js';
import { createRuntimeTurnService } from './runtime-service.js';
import {
    buildDisabledToolOverrides,
    buildExternalToolRegistry,
    buildToolExposure,
    buildForcedToolCallPrompt,
    evaluateToolPolicy,
    normalizeConfiguredToolNames,
    normalizeToolName,
    resolveInternalAllowedToolIds,
    stripFunctionCallMarkup,
    validateToolCalls
} from '../tools/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tool policy a turn runs under; the values mirror {@link TOOL_MODE} below.
 *
 * @typedef {'disabled'|'external-bridge'|'internal-allowlist'} ToolMode
 */

/**
 * An error as the engine sees it: a normal `Error` carrying the optional
 * provider-shaped fields an upstream throw may set.
 *
 * @typedef {Error & {statusCode?: number, code?: string, type?: string, availableModels?: string[]}} UpstreamErrorLike
 */

/**
 * The turn the upstream router records when a direct request fails and the
 * runtime takes over.
 *
 * @typedef {object} FallbackTurn
 * @property {string} providerID Resolved provider id.
 * @property {string} modelID Resolved bare model id.
 * @property {string|null} key Conversation key the turn belongs to.
 * @property {'direct'|'runtime'} mode Upstream the turn was to run on.
 */

/**
 * One Responses-API item as a client sends it: a message, a function call, a
 * function-call output or a tool result. Every field is optional because the
 * engine narrows on `type` before reading them.
 *
 * @typedef {object} ResponsesItem
 * @property {string} [type] Item kind.
 * @property {string} [role] Message role.
 * @property {unknown} [content] Message or tool-result content.
 * @property {unknown} [output] Tool output.
 * @property {unknown} [result] Tool result.
 * @property {string} [text] Flat text.
 * @property {string} [name] Tool name.
 * @property {string} [call_id] Call id.
 * @property {string} [tool_call_id] Call id in the chat shape.
 * @property {string} [id] Item id.
 * @property {ResponsesItem[]} [tool_calls] Calls an assistant item carries.
 * @property {string|Record<string, unknown>} [arguments] Flat arguments.
 * @property {{name?: string, arguments?: string}} [function] Function payload.
 */

/**
 * The assistant message the chat surface returns.
 *
 * @typedef {object} AssistantMessageOut
 * @property {string} role Role, always `assistant`.
 * @property {string|null|undefined} content Answer text.
 * @property {string} [reasoning_content] Reasoning text.
 * @property {import('../tools/contract.js').WireToolCall[]} [tool_calls] Calls the model asked for.
 */

/**
 * The runtime's prompt result as the responses path reads it.
 *
 * @typedef {object} PromptResultLike
 * @property {{parts?: Array<{type?: string, text?: string}>, message?: string}} [data] SDK payload.
 */

/**
 * What `buildPromptParts` renders one client transcript into.
 *
 * @typedef {object} PromptParts
 * @property {Array<Record<string, unknown>>} parts Parts to send as the prompt.
 * @property {string} system System prompt rebuilt from the whole history.
 * @property {string} fullPromptText History rendered as plain text, for digests.
 * @property {string} lastUserMsg Last user message, for logging.
 */

/**
 * {@link import('../tools/parser.js').ToolCallFilter} with the `flush()` the
 * factory always attaches; the published typedef omits it.
 *
 * @typedef {import('../tools/parser.js').ToolCallFilter & {flush: () => string}} ToolCallFilterWithFlush
 */

/**
 * {@link import('../tools/parser.js').ExternalToolCallStreamParser} with the
 * `flush()` the factory always attaches; the published typedef omits it.
 *
 * @typedef {import('../tools/parser.js').ExternalToolCallStreamParser & {flush: () => import('../tools/contract.js').WireToolCall[]}} ExternalToolCallParserWithFlush
 */

/**
 * One content part of a {@link ChatMessage}.
 *
 * @typedef {object} ChatMessagePart
 * @property {string} [type] Part kind (`text`, `image_url`, `input_text`, ...).
 * @property {string} [text] Text payload, for text parts.
 * @property {string|{url?: string}} [image_url] Image URL or its OpenAI wrapper.
 */

/**
 * A tool call in the OpenAI wire shape, as clients and models emit it.
 *
 * @typedef {object} ToolCall
 * @property {string} [id] Call id.
 * @property {string} [type] Always `function`.
 * @property {{name?: string, arguments?: string}} [function] Function payload.
 * @property {string} [name] Flat name, as some clients emit it.
 * @property {string|Record<string, unknown>} [arguments] Flat arguments.
 */

/**
 * One message of a client transcript, in the OpenAI chat shape.
 *
 * @typedef {object} ChatMessage
 * @property {string} [role] Message role.
 * @property {string|ChatMessagePart[]|null} [content] Message content.
 * @property {string} [name] Author name (tool results).
 * @property {string} [tool_call_id] Call this tool result answers.
 * @property {ToolCall[]} [tool_calls] Calls the assistant asked for.
 * @property {string} [reasoning_content] Reasoning text some upstreams echo back.
 * @property {boolean} [isToolCalls] Internal marker: the content is a replayed tool call.
 */

/**
 * One error object as the engine reads it off a failed upstream turn: the SDK's
 * `Error` plus the payload it sometimes carries.
 *
 * @typedef {object} TurnError
 * @property {string} [name] Error name.
 * @property {string} [message] Human-readable message.
 * @property {{message?: string}} [data] SDK error payload.
 */

/**
 * What {@link pollForAssistantResponse} returns for one turn.
 *
 * @typedef {object} PollResultLike
 * @property {string} content Assistant text collected so far.
 * @property {string} reasoning Reasoning text collected so far.
 * @property {TurnError|null} error Upstream message error, when the turn failed.
 */

/**
 * What {@link collectFromEvents} returns for one turn. Every field is optional
 * because the two shapes it merges (a cut stream and a rejected collection) fill
 * different ones.
 *
 * @typedef {object} CollectedTurn
 * @property {string} [content] Assistant text.
 * @property {string} [reasoning] Reasoning text.
 * @property {TurnError} [error] Upstream message error.
 * @property {TurnError} [__error] The collection itself rejected.
 * @property {boolean} [noData] No event arrived inside the first-delta window.
 * @property {boolean} [idleTimeout] The stream went idle and was cut.
 * @property {boolean} [receivedDelta] Whether any text/tool progress was seen.
 * @property {boolean} [clientClosed] The caller aborted (client disconnected).
 */

/**
 * One `session.prompt` call the engine assembles by hand.
 *
 * @typedef {object} PromptParams
 * @property {{id: string}} path Session route.
 * @property {{model: {providerID: string, modelID: string}, system?: string, parts: Array<Record<string, unknown>>, tools?: Record<string, unknown>, max_tokens?: number|null, temperature?: number, top_p?: number, stop?: string[]|null}} body
 *   Prompt body.
 */

/**
 * The external tool contract of one turn, as `createExternalToolContext` builds
 * it: the registry, the full exposure and the two prompt fragments.
 *
 * @typedef {object} ExternalToolContext
 * @property {import('../tools/registry.js').ExternalTool[]} registry Request registry.
 * @property {{tools: import('../tools/registry.js').ExternalTool[], toolChoice: import('../tools/contract.js').NormalizedToolChoice, prompt: string, reminder?: string}} exposure
 *   Exposure the prompt fragments were built from; the tools-off branch builds none.
 * @property {import('../tools/contract.js').NormalizedToolChoice} toolChoice Normalized choice.
 * @property {string} prompt Contract prompt section.
 * @property {string} [reminder] Short contract reminder appended as the last part.
 */

/**
 * Tool policy of one request plus the pieces that enforce it.
 *
 * @typedef {object} RequestToolContext
 * @property {ToolMode} mode Policy the turn runs under.
 * @property {ExternalToolContext} external External contract (`external-bridge` only).
 * @property {{allowedToolNames: string[], requestedAllowlist: string[]|null, deniedRequestedTools: string[], resolutionPath: string, resultingMode: ToolMode, metricsEnabled: boolean}} internal
 *   How the internal allowlist was resolved.
 */

/**
 * One entry of the `previous_response_id` chain index.
 *
 * @typedef {object} ResponseChainEntry
 * @property {string} sessionId Session the response was produced from.
 * @property {string|undefined} model Model name the client asked for.
 * @property {number} expiresAt Epoch milliseconds the entry stops being usable.
 */

/**
 * What a finished turn hands to {@link storeConversationEntry} so the next turn
 * of the same conversation can reuse the session it used.
 *
 * @typedef {object} StoredTurnEntry
 * @property {string|null} sessionId Session the turn used.
 * @property {'runtime'|'direct'} [mode] Upstream that served it.
 * @property {number|undefined} [sentCount] Delivered messages the session holds.
 * @property {string|null|undefined} [sentDigest] Rolling digest over those messages.
 * @property {string|null} [replyText] Answer text, for echo disambiguation.
 * @property {string|null} [startKey] Derived-identity anchor.
 */

const DEFAULT_POLL_INTERVAL_MS = 500;
// Reasoning models can idle well over 10s before the first token; a shorter window
// would make every request fall back to polling and lose true streaming.
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS =
    Number(process.env.OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS) || 30000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS) || 8000;

const TOOL_LOCK_PLUGIN_FILE = 'opencode-gateway-tool-lock.js';
const TOOL_LOCK_PLUGIN_PATH = path.join(__dirname, '..', 'plugin', TOOL_LOCK_PLUGIN_FILE);

/**
 * Create the turn engine.
 *
 * @param {object} options Engine options.
 * @param {Record<string, any>} options.config Resolved gateway config (env-shaped keys).
 * @param {any} options.logger Logger dependency.
 * @param {any} options.registry Conversation registry (`createConversationRegistry`).
 * @param {any} options.router Upstream router (`createUpstreamRouter`).
 * @param {any} [options.tools] Tool contract module, injectable for tests.
 * @param {any} [options.responseChains] `previous_response_id` chain index.
 * @param {any} [options.turnLimiter] Process-wide bounded turn limiter, injectable for tests.
 * @param {() => Promise<void>} [options.ensureBackend] Starts/awaits the managed backend.
 * @returns {object} Engine with the two handlers and the ops surfaces.
 */
export function createTurnEngine({
    config,
    logger = null,
    registry,
    router,
    tools: _tools = null,
    responseChains = createResponseChainIndex(),
    turnLimiter = null,
    ensureBackend = async () => {}
}) {
    if (!registry || typeof registry.resolveTurn !== 'function') {
        throw new Error('createTurnEngine requires a conversation registry');
    }
    if (!router || typeof router.plan !== 'function') {
        throw new Error('createTurnEngine requires an upstream router');
    }
    /** @type {any} */
    const log = logger && typeof logger.child === 'function' ? logger : null;
    const debugEnabled = Boolean(config.DEBUG);
    /** @param {...unknown} args Message and structured detail to log. */
    const logDebug = (...args) => {
        if (debugEnabled) log ? log.debug(...args) : console.log('[Proxy][Debug]', ...args);
    };
    /** @param {...unknown} args Message and structured detail to log. */
    const logWarn = (...args) => {
        if (log) log.warn(...args);
        else if (debugEnabled) console.warn('[Proxy]', ...args);
    };
    /**
     * @param {unknown} message Message to log.
     * @param {unknown} [details] Structured detail to log.
     */
    const logError = (message, details) => {
        if (log) log.error(message, details);
        else console.error(message, details);
    };

    const client = router.runtime.client;
    const runtime = router.runtime;
    const direct = router.direct;

    const { listModels: getKnownModels, resolveRequestedModel } = createModelResolver({
        runtime,
        direct,
        logDebug
    });

    const {
        snapshotSessionState,
        conversationScopeForTurn,
        storeConversationEntry,
        discardConversationEntry,
        discardTurnState,
        resolveConversationTurn,
        conversationBusyBody,
        sessionStateUnavailableBody
    } = createConversationTurnService({
        registry,
        runtime,
        logger: log
    });

    /** 503 body for process-wide capacity exhaustion. */
    const gatewayOverloadedBody = () => ({
        error: { message: 'Gateway is at capacity; retry shortly', type: 'gateway_overloaded' }
    });

    /**
     * Acquire one process-wide turn slot after the conversation lock is held, so
     * duplicate requests for one conversation cannot hold global permits while waiting.
     *
     * @param {import('express').Response} res Response to write on overload.
     * @param {AbortSignal} signal Client-disconnect signal.
     * @returns {Promise<(() => void)|null>} Permit release function, or null.
     */
    const acquireTurnCapacity = async (res, signal) => {
        const release = await capacityLimiter.acquire({ signal });
        if (release) return release;
        if (signal.aborted || res.headersSent || res.writableEnded) return null;

        const snapshot = capacityLimiter.snapshot();
        logWarn('[Proxy] Gateway turn capacity exhausted', snapshot);
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(CONCURRENCY_WAIT_MS / 1000))));
        res.status(503).json(gatewayOverloadedBody());
        return null;
    };

    const responseChainService = createResponseChainService({
        responseChains,
        registry
    });
    const { getResponseState, storeResponseState } = responseChainService;

    const {
        OPENCODE_SERVER_URL,
        REQUEST_TIMEOUT_MS,
        MAX_CONCURRENT_TURNS = 20,
        MAX_PENDING_TURNS = 100,
        CONCURRENCY_WAIT_MS = 2000,
        DEBUG,
        DISABLE_TOOLS,
        INTERNAL_WEB_FETCH_ENABLED,
        INTERNAL_ALLOWED_TOOLS = [],
        INTERNAL_TOOL_METRICS_ENABLED = true,
        INTERNAL_TOOL_DISCOVERY_FIXTURE = [],
        PROMPT_MODE,
        OMIT_SYSTEM_PROMPT,
        AUTO_CLEANUP_CONVERSATIONS,
        CLEANUP_INTERVAL_MS,
        CLEANUP_MAX_AGE_MS,
        OPENCODE_HOME_BASE,
        EVENT_IDLE_TIMEOUT_MS = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS = DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS
    } = config;

    const capacityLimiter =
        turnLimiter ||
        createTurnLimiter({
            maxConcurrent: MAX_CONCURRENT_TURNS,
            maxPending: MAX_PENDING_TURNS,
            waitTimeoutMs: CONCURRENCY_WAIT_MS
        });

    const TOOL_MODE = Object.freeze({
        DISABLED: 'disabled',
        EXTERNAL_BRIDGE: 'external-bridge',
        INTERNAL_ALLOWLIST: 'internal-allowlist'
    });

    const TOOL_GUARD_MESSAGE =
        'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const EXTERNAL_TOOL_GUARD_MESSAGE =
        'OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools.';

    /** @returns {string[]} Internal tool names this deployment allows. */
    const getEffectiveInternalAllowedTools = () => {
        const configuredTools = normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS);
        if (configuredTools.length > 0) return configuredTools;
        if (INTERNAL_WEB_FETCH_ENABLED) return ['web_fetch'];
        return [];
    };

    const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();

    /**
     * @param {string[]} [allowedToolNames] Names the turn may use.
     * @returns {string} Prompt section announcing the allowlist.
     */
    const buildInternalAllowlistPrompt = (allowedToolNames = []) => {
        if (allowedToolNames.length > 0) {
            return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${allowedToolNames.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`;
        }
        return 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';
    };

    /**
     * @param {string|null|undefined} systemMsg Client system message.
     * @param {string|null} [reasoningEffort] Normalized reasoning effort.
     * @param {ToolMode} [toolMode] Tool policy of the turn.
     * @param {string[]} [internalAllowedTools] Internal tools the turn may use.
     * @returns {string|undefined} System prompt, or undefined when it stays empty.
     */
    const buildSystemPrompt = (
        systemMsg,
        reasoningEffort = null,
        toolMode = TOOL_MODE.DISABLED,
        internalAllowedTools = []
    ) => {
        const parts = [];
        if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) {
            parts.push(systemMsg.trim());
        }
        if (reasoningEffort && reasoningEffort !== 'none') {
            parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
        }
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            parts.push(buildInternalAllowlistPrompt(internalAllowedTools));
        } else if (DISABLE_TOOLS && PROMPT_MODE !== 'plugin-inject') {
            parts.push(
                toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE
            );
        }
        const finalPrompt = parts.join('\n\n').trim();
        return finalPrompt || undefined;
    };

    /**
     * @param {unknown} [value] Requested reasoning effort.
     * @param {string|null} [fallback] Effort used when the request carries none.
     * @returns {string|null} Normalized effort.
     */
    const normalizeReasoningEffort = (value, fallback = null) => {
        if (!value || typeof value !== 'string') return fallback;
        /** @type {Record<string, string>} */
        const effortMap = {
            none: 'none',
            minimal: 'none',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'high'
        };
        return effortMap[value.toLowerCase()] || fallback;
    };

    /**
     * @param {string|undefined|null} text Model output.
     * @param {boolean} [trim] Whether the surviving text is trimmed.
     * @returns {string|undefined|null} Text without function-call markup.
     */
    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        return stripFunctionCallMarkup(text, trim);
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {unknown} [toolChoice] Raw `tool_choice`.
     * @returns {ExternalToolContext} Registry, exposure and prompt fragments.
     */
    const createExternalToolContext = (tools, toolChoice) => {
        const registry = buildExternalToolRegistry(tools);
        const exposure = buildToolExposure(registry, toolChoice);
        return {
            registry,
            exposure,
            toolChoice: exposure.toolChoice,
            prompt: exposure.prompt,
            // Appended as the last prompt part: it sits right before generation, where
            // models actually follow it.
            reminder: exposure.reminder
        };
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {string[]} [effectiveInternalAllowlist] Internal tools that survived the
     *   request/server intersection.
     * @returns {ToolMode} Policy the turn runs under.
     */
    const resolveToolMode = (tools = [], effectiveInternalAllowlist = []) => {
        if (Array.isArray(tools) && tools.length > 0) {
            return TOOL_MODE.EXTERNAL_BRIDGE;
        }
        if (effectiveInternalAllowlist.length > 0) {
            return TOOL_MODE.INTERNAL_ALLOWLIST;
        }
        return TOOL_MODE.DISABLED;
    };

    /**
     * @param {unknown} tools Declared tools of the request.
     * @param {unknown} [toolChoice] Raw `tool_choice`.
     * @param {{internal_allowed_tools?: unknown}|null} [requestOpencodeConfig] Per-request
     *   `opencode` config object.
     * @returns {RequestToolContext} Tool policy plus the contract it implies.
     */
    const createRequestToolContext = (tools, toolChoice, requestOpencodeConfig = undefined) => {
        let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
        let requestInternalAllowlist = null;

        if (requestOpencodeConfig && typeof requestOpencodeConfig === 'object') {
            if (Array.isArray(requestOpencodeConfig.internal_allowed_tools)) {
                requestInternalAllowlist = requestOpencodeConfig.internal_allowed_tools
                    .map((name) => String(name || '').trim())
                    .filter(Boolean);
            }
        }

        if (requestInternalAllowlist !== null) {
            effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter((name) =>
                requestInternalAllowlist.includes(name)
            );
        }

        const deniedRequestedTools = requestInternalAllowlist
            ? requestInternalAllowlist.filter((name) => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
            : [];

        const mode = resolveToolMode(tools, effectiveInternalAllowlist);
        /** @type {ExternalToolContext} */
        const external =
            mode === TOOL_MODE.EXTERNAL_BRIDGE
                ? createExternalToolContext(tools, toolChoice)
                : {
                      registry: [],
                      exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '' },
                      toolChoice: { mode: 'auto', requiredTool: null },
                      prompt: ''
                  };

        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode,
                metricsEnabled: INTERNAL_TOOL_METRICS_ENABLED
            }
        };
    };

    /**
     * Validate the model's calls against the request registry and drop the ones
     * the tool policy blocks.
     *
     * @param {unknown} parsedToolCalls Calls recovered from model output.
     * @param {import('../tools/registry.js').ExternalTool[]} registry Registry of the request.
     * @returns {{validCalls: import('../tools/validator.js').ValidatedToolCall[], invalidCalls: import('../tools/validator.js').InvalidToolCall[]}}
     *   Executable calls and rejects.
     */
    const finalizeValidatedToolCalls = (parsedToolCalls, registry) => {
        const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
        invalidCalls.forEach(({ call, validation }) => {
            logDebug('Rejected external tool call', {
                tool: /** @type {{function?: {name?: string}}|null} */ (call)?.function?.name,
                errors: validation?.errors?.map((error) => error.message)
            });
        });
        /** @type {import('../tools/validator.js').ValidatedToolCall[]} */
        const allowedCalls = [];
        validCalls.forEach((toolCall) => {
            const policyDecision = evaluateToolPolicy(toolCall.tool, toolCall.validatedArguments, { config });
            if (policyDecision.status === 'allow') {
                allowedCalls.push(toolCall);
                return;
            }
            logDebug('Blocked external tool call', {
                tool: toolCall.function.name,
                status: policyDecision.status,
                reason: policyDecision.reason
            });
        });
        return { validCalls: allowedCalls, invalidCalls };
    };

    /**
     * @param {import('../tools/validator.js').ValidatedToolCall[]} toolCalls Validated calls.
     * @returns {import('../tools/contract.js').WireToolCall[]} Calls in the OpenAI wire shape.
     */
    const toPublicToolCalls = (toolCalls) => {
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
        return toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            }
        }));
    };

    /**
     * Build the "call the tool again, properly" follow-up used when
     * `tool_choice: required` was answered with prose.
     *
     * @param {object} params Requester input.
     * @param {'auto'|'none'|'required'} params.mode Normalized `tool_choice` mode.
     * @param {string} params.sessionId Session the retry lands in.
     * @param {string|undefined} params.systemWithGuard System prompt to repeat.
     * @param {string|null} params.requiredTool Namespaced name to force.
     * @param {string} params.providerID Resolved provider id.
     * @param {string} params.modelID Resolved bare model id.
     * @param {Record<string, boolean>|null} params.toolOverrides Per-request tool map.
     * @param {number} params.requestTimeoutMs Turn timeout in milliseconds.
     * @param {(() => Promise<import('../conversation/baseline.js').SessionBaseline>)|null} [params.baselineProvider]
     *   Reader for the turns the session already holds.
     * @param {AbortSignal|null} [params.signal] Aborts with the client request.
     * @param {boolean} [params.forbidThinkBlock] Guard models with a think channel.
     * @returns {() => Promise<import('../upstreams/runtime-client.js').PollResult|null>} The requester.
     */
    const createForcedToolCallRequester =
        ({
            mode,
            sessionId,
            systemWithGuard,
            requiredTool,
            providerID,
            modelID,
            toolOverrides,
            requestTimeoutMs,
            baselineProvider = null,
            signal = null,
            forbidThinkBlock = false
        }) =>
        async () => {
            if (mode !== 'required') return null;
            if (!requiredTool) return null;
            /** @type {PromptParams} */
            const forcedPromptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID, modelID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts: [
                        {
                            type: 'text',
                            text: buildForcedToolCallPrompt(requiredTool, { forbidThinkBlock })
                        }
                    ]
                }
            };
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                forcedPromptParams.body.tools = toolOverrides;
            }
            // The retry lands in the same session: exclude the turns already there when polling.
            const baseline = baselineProvider ? await baselineProvider() : null;
            await promptWithTimeout(forcedPromptParams, requestTimeoutMs, signal);
            return pollForAssistantResponse(sessionId, requestTimeoutMs, DEFAULT_POLL_INTERVAL_MS, baseline);
        };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    /** @type {string[]|null} */
    let cachedToolIds = null;
    let cachedToolIdsAt = 0;
    /** @type {Record<string, boolean>|null} */
    let cachedDisabledToolOverrides = null;
    let cachedDisabledToolOverridesAt = 0;
    const internalToolMetrics = {
        externalBridgeRequests: 0,
        internalAllowlistRequests: 0,
        disabledRequests: 0,
        discoveryFailures: 0,
        fallbackToDisabled: 0
    };

    const operationalSurface = createOperationalSurface({
        config,
        capacityLimiter,
        allowedToolNames: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
        discoveryFixture: normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE),
        internalToolMetrics,
        getToolCacheSnapshot: () => ({ ids: cachedToolIds, updatedAt: cachedToolIdsAt })
    });
    const { handleHealth, handleHealthDetails, handleMetrics, getInternalToolDashboard, renderMetrics } =
        operationalSurface;

    /**
     * @param {string} event Event name.
     * @param {Record<string, unknown>} [details] Event payload.
     * @returns {void}
     */
    const logInternalToolEvent = (event, details = {}) => {
        if (!DEBUG && !INTERNAL_TOOL_METRICS_ENABLED) return;
        /** @type {Record<string, unknown>} */
        const payload = {
            event,
            ...details
        };
        if (INTERNAL_TOOL_METRICS_ENABLED) {
            payload.metrics = { ...internalToolMetrics };
        }
        logDebug('Internal tool event', payload);
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {Record<string, unknown>} [details] Extra fields to log.
     * @returns {void}
     */
    const trackToolMode = (toolMode, details = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
            internalToolMetrics.externalBridgeRequests += 1;
        } else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            internalToolMetrics.internalAllowlistRequests += 1;
        } else {
            internalToolMetrics.disabledRequests += 1;
        }
        logInternalToolEvent('tool-mode-selected', {
            toolMode,
            ...details
        });
    };

    /** @returns {Promise<string[]|null>} Backend tool ids, or null when undiscoverable. */
    const getBackendToolIds = async () => {
        if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) {
            return cachedToolIds;
        }
        const fixtureIds = normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE);
        if (fixtureIds.length > 0) {
            cachedToolIds = fixtureIds;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-fixture-loaded', { count: fixtureIds.length, fixtureIds });
            return fixtureIds;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data) ? idsRes.data : Array.isArray(idsRes) ? idsRes : [];
            cachedToolIds = ids;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-loaded', { count: ids.length });
            return ids;
        } catch (e) {
            internalToolMetrics.discoveryFailures += 1;
            logInternalToolEvent('backend-tool-ids-failed', { error: /** @type {Error} */ (e).message });
            return null;
        }
    };

    /** @returns {Promise<Record<string, boolean>|null>} Tool map that disables every tool. */
    const getDisabledToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
            return cachedDisabledToolOverrides;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids)) return null;
        const overrides = buildDisabledToolOverrides(ids);
        cachedDisabledToolOverrides = overrides;
        cachedDisabledToolOverridesAt = Date.now();
        logInternalToolEvent('disabled-tool-overrides-loaded', { count: ids.length });
        return overrides;
    };

    // OpenCode Zen's free tier rejects any request whose tool list differs from the
    // official client's, and a per-request `tools` map strips tools from that list.
    // With the tool-lock plugin the list stays intact and the policy travels in the
    // session title instead; backends without the plugin fall back to the `tools` map.
    const TOOL_LOCK_CHECK_MS = 60 * 1000;
    let toolLockState = { loaded: false, checkedAt: 0, warned: false };

    /** @returns {Promise<boolean>} True when the backend loads the tool-lock plugin. */
    const isToolLockLoaded = async () => {
        if (toolLockState.checkedAt && Date.now() - toolLockState.checkedAt < TOOL_LOCK_CHECK_MS) {
            return toolLockState.loaded;
        }
        /** @type {Array<unknown>} */
        let plugins;
        try {
            const res = await client.config.get();
            plugins = Array.isArray(res?.data?.plugin) ? res.data.plugin : [];
        } catch (e) {
            // Backend unreachable: do not cache, the request will surface the error.
            return toolLockState.loaded;
        }
        const loaded = plugins.some(
            (spec) =>
                typeof spec === 'string' && spec.replace(/\\/g, '/').endsWith(`/${TOOL_LOCK_PLUGIN_FILE}`)
        );
        if (!loaded && !toolLockState.warned) {
            console.warn(
                `[Proxy] Backend at ${OPENCODE_SERVER_URL} does not load ${TOOL_LOCK_PLUGIN_FILE}; falling back to per-request tool overrides. OpenCode Zen free models reject those requests. Let the proxy start the backend (MANAGE_BACKEND=true) or add "${TOOL_LOCK_PLUGIN_PATH}" to the backend's "plugin" config.`
            );
            toolLockState.warned = true;
        }
        toolLockState = { ...toolLockState, loaded, checkedAt: Date.now() };
        return loaded;
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {string} Policy payload the tool-lock plugin parses.
     */
    const buildToolPolicy = (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            const names = normalizeConfiguredToolNames(
                internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
            )
                .map(normalizeToolName)
                .filter(Boolean);
            return names.length ? [...new Set(names)].join(',') : 'none';
        }
        return DISABLE_TOOLS ? 'none' : '*';
    };

    /**
     * @param {string} policy Policy payload.
     * @returns {string} Session title carrying it.
     */
    const sessionTitleForPolicy = (policy) => `opencode-gateway [tools:${policy}]`;

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {Promise<{title: string|undefined, toolOverrides: Record<string, boolean>|null}>}
     *   How the policy reaches the backend.
     */
    const resolveToolControl = async (toolMode, internalContext = {}) => {
        const policy = buildToolPolicy(toolMode, internalContext);
        if (await isToolLockLoaded()) {
            logInternalToolEvent('tool-policy-plugin', { toolMode, policy });
            return { title: sessionTitleForPolicy(policy), toolOverrides: null };
        }
        return { title: undefined, toolOverrides: await getToolOverridesForMode(toolMode, internalContext) };
    };

    /**
     * @param {{title?: string}|null} [toolControl] Tool control of the request.
     * @returns {Promise<string>} Id of the created session.
     */
    const createSession = async (toolControl) => {
        const sessionRes = await client.session.create(
            toolControl?.title ? { body: { title: toolControl.title } } : undefined
        );
        const sessionId = sessionRes?.data?.id;
        if (!sessionId) throw new Error('Failed to create OpenCode session');
        return sessionId;
    };

    /**
     * @param {ToolMode} toolMode Policy the turn runs under.
     * @param {{allowedToolNames?: string[]}} [internalContext] Resolved internal allowlist.
     * @returns {Promise<Record<string, boolean>|null>} Per-request `tools` map, or null.
     */
    const getToolOverridesForMode = async (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
            if (toolMode === TOOL_MODE.DISABLED) {
                logInternalToolEvent('internal-tools-disabled', {
                    configuredAllowlist:
                        internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
                });
            }
            return getDisabledToolOverrides();
        }
        if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
            return null;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const resolution = resolveInternalAllowedToolIds(
            ids,
            internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
        );
        const { normalizedIds, normalizedAllowedNames, matchedToolIds, unmatchedAllowedNames } = resolution;
        if (matchedToolIds.length === 0) {
            internalToolMetrics.fallbackToDisabled += 1;
            logInternalToolEvent('internal-allowlist-unavailable', {
                configuredAllowlist: normalizedAllowedNames,
                availableToolIds: normalizedIds,
                unmatchedAllowlist: unmatchedAllowedNames,
                fallback: 'disabled'
            });
            return buildDisabledToolOverrides(normalizedIds);
        }
        /** @type {Record<string, boolean>} */
        const overrides = {};
        normalizedIds.forEach((id) => {
            overrides[id] = matchedToolIds.includes(id);
        });
        logInternalToolEvent('internal-allowlist-overrides-loaded', {
            configuredAllowlist: normalizedAllowedNames,
            matchedToolIds,
            unmatchedAllowlist: unmatchedAllowedNames,
            availableToolIdsCount: normalizedIds.length
        });
        return overrides;
    };

    const { promptWithTimeout, pollForAssistantResponse, collectFromEvents } =
        createRuntimeTurnService(runtime);

    const storageCleanup = createStorageCleanup({
        enabled: AUTO_CLEANUP_CONVERSATIONS,
        intervalMs: CLEANUP_INTERVAL_MS,
        maxAgeMs: CLEANUP_MAX_AGE_MS,
        homeBase: OPENCODE_HOME_BASE,
        logDebug
    });
    const cleanupConversationFiles = storageCleanup.cleanup;

    const runDirectTurn = createDirectTurnRunner({
        direct,
        router,
        logWarn
    });

    /**
     * `POST /v1/chat/completions`.
     *
     * @param {import('express').Request} req Incoming request.
     * @param {import('express').Response} res Response to write.
     * @returns {Promise<void>}
     */
    const handleChat = createChatHandler({
        normalizeReasoningEffort,
        logDebug,
        resolveRequestedModel,
        createRequestToolContext,
        trackToolMode,
        router,
        conversationScopeForTurn,
        resolveConversationTurn,
        conversationBusyBody,
        acquireTurnCapacity,
        runDirectTurn,
        storeConversationEntry,
        ensureBackend,
        client,
        resolveToolControl,
        registry,
        createSession,
        buildSystemPrompt,
        sessionStateUnavailableBody,
        discardConversationEntry,
        snapshotSessionState,
        createForcedToolCallRequester,
        finalizeValidatedToolCalls,
        collectFromEvents,
        pollForAssistantResponse,
        promptWithTimeout,
        discardTurnState,
        stripFunctionCalls,
        toPublicToolCalls,
        logWarn,
        logError,
        REQUEST_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS,
        EVENT_IDLE_TIMEOUT_MS,
        DISABLE_TOOLS
    });

    /**
     * `POST /v1/responses`.
     *
     * @param {import('express').Request} req Incoming request.
     * @param {import('express').Response} res Response to write.
     * @returns {Promise<unknown>} The response, or undefined when already sent.
     */
    const handleResponses = createResponsesHandler({
        getResponseState,
        normalizeReasoningEffort,
        createRequestToolContext,
        trackToolMode,
        logDebug,
        resolveRequestedModel,
        router,
        conversationScopeForTurn,
        resolveConversationTurn,
        conversationBusyBody,
        acquireTurnCapacity,
        runDirectTurn,
        storeConversationEntry,
        logWarn,
        ensureBackend,
        client,
        resolveToolControl,
        registry,
        createSession,
        sessionStateUnavailableBody,
        snapshotSessionState,
        buildSystemPrompt,
        createForcedToolCallRequester,
        finalizeValidatedToolCalls,
        collectFromEvents,
        stripFunctionCalls,
        storeResponseState,
        promptWithTimeout,
        pollForAssistantResponse,
        discardConversationEntry,
        discardTurnState,
        logError,
        REQUEST_TIMEOUT_MS,
        EVENT_FIRST_DELTA_TIMEOUT_MS,
        EVENT_IDLE_TIMEOUT_MS,
        DISABLE_TOOLS
    });

    return {
        handleChat,
        handleResponses,
        handleHealth,
        handleHealthDetails,
        handleMetrics,
        listModels: getKnownModels,
        resolveRequestedModel,
        getInternalToolDashboard,
        renderMetrics,
        cleanup: cleanupConversationFiles,
        responseChains,
        settings: registry.settings,

        /** Stops the periodic sweep this engine started. @returns {void} */
        close() {
            responseChainService.close();
            storageCleanup.close();
        }
    };
}

export { createResponseChainIndex } from '../conversation/response-chains.js';
