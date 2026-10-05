/**
 * Chat Completions turn orchestrator.
 *
 * Owns only the /v1/chat/completions request state machine. Pure helpers and
 * runtime mechanics are imported directly; shared engine state/services are
 * injected by createTurnEngine.
 *
 * @module routes/chat-handler
 */

import crypto from 'node:crypto';

import {
    deliverableMessages as conversationDeliverableMessages,
    hasDeliverablePromptContent,
    toolsFingerprintFor
} from '../conversation/index.js';
import { transformUpstreamError } from '../errors/index.js';
import { newSessionId } from '../upstreams/direct-client.js';
import {
    createExternalToolCallStreamParser,
    createToolCallFilter,
    parseExternalToolCallsFromText,
    reconcileStreamedToolCalls,
    stripFunctionCallMarkup
} from '../tools/index.js';
import { createChatPromptBuilder } from './chat-prompt.js';
import { collectRuntimePromptAttempt, runPolledRuntimeAttempt } from './runtime-attempt.js';
import { reconcileChatRuntimeStream } from './runtime-reconciliation.js';
import {
    DEFAULT_RUNTIME_RETRY_BACKOFF_BASE_MS,
    DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS,
    rotateRuntimeSession,
    runtimeRetryDetail,
    shouldRetryRuntimeAttempt
} from './runtime-retry.js';
import { createChatStreamWriter } from './streaming/chat-writer.js';

const DEFAULT_POLL_INTERVAL_MS = 500;

/** @typedef {Record<string, any>} ChatMessage */
/**
 * @typedef {object} AssistantMessageOut
 * @property {string} role
 * @property {string|null|undefined} content
 * @property {string} [reasoning_content]
 * @property {import('../tools/contract.js').WireToolCall[]} [tool_calls]
 */
/** @typedef {Error & {statusCode?: number, code?: string, type?: string, availableModels?: string[]}} UpstreamErrorLike */
/**
 * @typedef {object} TurnError
 * @property {string} [name]
 * @property {string} [message]
 * @property {{message?: string}} [data]
 */
/**
 * @typedef {object} CollectedTurn
 * @property {string} [content]
 * @property {string} [reasoning]
 * @property {TurnError} [error]
 * @property {TurnError} [__error]
 * @property {boolean} [noData]
 * @property {boolean} [idleTimeout]
 * @property {boolean} [receivedDelta]
 * @property {boolean} [clientClosed]
 */
/**
 * @typedef {object} PollResultLike
 * @property {string} content
 * @property {string} reasoning
 * @property {TurnError|null} error
 */
/**
 * @typedef {object} PromptParams
 * @property {{id: string}} path
 * @property {Record<string, any>} body
 */
/** @typedef {import('../tools/parser.js').ToolCallFilter & {flush: () => string}} ToolCallFilterWithFlush */
/** @typedef {import('../tools/parser.js').ExternalToolCallStreamParser & {flush: () => import('../tools/contract.js').WireToolCall[]}} ExternalToolCallParserWithFlush */

/**
 * Create the Chat Completions handler.
 *
 * @param {Record<string, any>} deps Engine collaborators and runtime settings.
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>} Chat handler.
 */
export function createChatHandler(deps) {
    const {
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
    } = deps;

    const buildPromptParts = createChatPromptBuilder({ logWarn });

    /**
     * @param {import('express').Request} req Incoming request.
     * @param {import('express').Response} res Response to write.
     * @returns {Promise<void>}
     */
    return async function handleChat(req, res) {
        try {
            /** @type {string|null} */
            let sessionId = null;
            /** @type {string|null} */
            let conversationKey = null;
            let turnPlan;
            /** @type {import('../conversation/baseline.js').SessionBaseline|null} */
            let turnBaseline = null;
            /** @type {(() => void)|null} */
            let releaseConversationLock = null;
            /** @type {(() => void)|null} */
            let releaseTurnCapacity = null;
            const turnAbort = new AbortController();
            res.on('close', () => {
                if (!res.writableEnded) turnAbort.abort();
            });
            /** @type {{close: () => void}|null} */
            const eventStream = /** @type {{close: () => void}|null} */ (null);
            let stream;
            let pID = 'opencode';
            let mID = 'kimi-k2.5-free';
            let id = `chatcmpl-${crypto.randomUUID()}`;
            /** @type {ReturnType<typeof setInterval>|null} */
            let keepaliveInterval = null;

            try {
                const {
                    messages,
                    model,
                    tools = [],
                    tool_choice,
                    stream: requestStream,
                    temperature,
                    max_tokens,
                    top_p,
                    frequency_penalty,
                    presence_penalty,
                    stop,
                    reasoning_effort,
                    reasoning,
                    opencode: requestOpencodeConfig
                } = req.body;
                stream = Boolean(requestStream);
                if (!messages || !Array.isArray(messages) || messages.length === 0) {
                    res.status(400).json({ error: { message: 'messages array is required' } });
                    return;
                }

                const reasoningLevel = normalizeReasoningEffort(reasoning_effort || reasoning?.effort, null);

                const requestParams = {
                    temperature: typeof temperature === 'number' ? temperature : 0.7,
                    max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                    top_p: typeof top_p === 'number' ? top_p : 1.0,
                    frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
                    presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
                    stop: Array.isArray(stop) ? stop : stop ? [stop] : null,
                    reasoning_effort: reasoningLevel
                };

                logDebug('Request params', {
                    temperature: requestParams.temperature,
                    max_tokens: requestParams.max_tokens,
                    top_p: requestParams.top_p,
                    reasoning_effort: reasoningLevel
                });

                const resolvedModel = await resolveRequestedModel(model);
                pID = resolvedModel.providerID;
                mID = resolvedModel.modelID;
                if (resolvedModel.aliasFrom) {
                    logDebug('Resolved model alias', {
                        from: resolvedModel.aliasFrom,
                        to: resolvedModel.resolved
                    });
                }

                const requestToolContext = createRequestToolContext(
                    tools,
                    tool_choice,
                    requestOpencodeConfig
                );
                const toolMode = requestToolContext.mode;
                const externalToolContext = requestToolContext.external;
                const externalToolRegistry = externalToolContext.registry;
                const externalToolChoice = externalToolContext.toolChoice;
                const internalToolContext = requestToolContext.internal;
                trackToolMode(toolMode, {
                    configuredAllowlist: internalToolContext.allowedToolNames,
                    requestedAllowlist: internalToolContext.requestedAllowlist,
                    deniedRequestedTools: internalToolContext.deniedRequestedTools,
                    resolutionPath: internalToolContext.resolutionPath,
                    resultingMode: internalToolContext.resultingMode,
                    route: '/v1/chat/completions'
                });

                const servingMode = router.shouldUseDirect(pID, mID).direct ? 'direct' : 'runtime';
                const deliverableMessages = conversationDeliverableMessages(messages);
                const conversationScope = conversationScopeForTurn(
                    pID,
                    mID,
                    toolMode,
                    toolsFingerprintFor(tools, tool_choice),
                    servingMode
                );
                const resolvedTurn = await resolveConversationTurn({
                    req,
                    deliverable: deliverableMessages,
                    scope: conversationScope
                });
                conversationKey = resolvedTurn.key;
                const conversationEntry = resolvedTurn.entry;
                releaseConversationLock = resolvedTurn.release;
                const conversationIdentity = resolvedTurn.identity;
                const derivedIdentity =
                    resolvedTurn.identity?.source === 'derived' ? resolvedTurn.identity : null;
                if (resolvedTurn.busy) {
                    res.status(503).json(conversationBusyBody());
                    return;
                }

                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;

                if (servingMode === 'direct') {
                    const directSessionId =
                        conversationEntry?.mode === 'direct' && conversationEntry.sessionId
                            ? conversationEntry.sessionId
                            : newSessionId();
                    const turnPlanForDirect = resolvedTurn.plan;
                    const { opencode: _omitProxyExtension, ...upstreamBody } = req.body || {};
                    const directResult = await runDirectTurn({
                        path: '/chat/completions',
                        res,
                        providerID: pID,
                        modelID: mID,
                        sessionId: directSessionId,
                        body: upstreamBody,
                        stream,
                        clientModelName: `${pID}/${mID}`,
                        signal: turnAbort.signal,
                        fallbackTurn: {
                            providerID: pID,
                            modelID: mID,
                            key: conversationKey,
                            mode: 'direct'
                        },
                        onSuccess: (/** @type {string|null} */ answerText) =>
                            storeConversationEntry(conversationKey, {
                                sessionId: directSessionId,
                                mode: 'direct',
                                sentCount: turnPlanForDirect.sentCount,
                                sentDigest: turnPlanForDirect.sentDigest,
                                replyText: typeof answerText === 'string' ? answerText : null,
                                startKey: derivedIdentity?.startKey || null
                            })
                    });
                    if (directResult.handled) return;
                }

                await ensureBackend();

                try {
                    await client.config.update({
                        body: {
                            activeModel: { providerID: pID, modelID: mID }
                        }
                    });
                } catch (confError) {
                    logDebug('Failed to set active model:', /** @type {Error} */ (confError).message);
                }

                const toolControl = await resolveToolControl(toolMode, internalToolContext);
                turnPlan = resolvedTurn.plan;

                if (!hasDeliverablePromptContent(messages, turnPlan.deltaStartIndex)) {
                    res.status(400).json({
                        error: {
                            message: 'messages must include at least one non-system text message'
                        }
                    });
                    return;
                }

                if (turnPlan.reuse) {
                    sessionId = /** @type {string} */ (resolvedTurn.sessionId);
                    logDebug('Reusing conversation session', {
                        sessionId,
                        header: conversationIdentity?.header || 'derived',
                        deliveredTurns: resolvedTurn.entry?.sentCount,
                        appendedTurns: turnPlan.delta.length
                    });
                } else {
                    if (resolvedTurn.entry?.sessionId) {
                        await registry.discard({ key: conversationKey });
                    }
                    sessionId = await createSession(toolControl);
                    logDebug('Session created', {
                        sessionId,
                        historyRewritten: turnPlan.rewrite,
                        derived: Boolean(derivedIdentity)
                    });
                }

                const {
                    parts,
                    system: systemMsg,
                    fullPromptText,
                    lastUserMsg
                } = await buildPromptParts(messages, externalToolRegistry, {
                    includeFromIndex: turnPlan.deltaStartIndex
                });
                const systemWithGuard = buildSystemPrompt(
                    [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                    requestParams.reasoning_effort,
                    toolMode,
                    internalToolContext.allowedToolNames
                );
                if (!parts.length) {
                    res.status(400).json({
                        error: {
                            message: 'messages must include at least one non-system text message'
                        }
                    });
                    return;
                }
                logDebug('Request start', {
                    model: `${pID}/${mID}`,
                    stream: Boolean(stream),
                    userMessages: messages.length,
                    system: Boolean(systemMsg),
                    lastUserLength: lastUserMsg?.length || 0,
                    parts: parts.length,
                    disableTools: DISABLE_TOOLS,
                    toolMode,
                    internalAllowedTools: internalToolContext.allowedToolNames,
                    requestedInternalTools: internalToolContext.requestedAllowlist,
                    deniedRequestedTools: internalToolContext.deniedRequestedTools,
                    resolutionPath: internalToolContext.resolutionPath,
                    resultingMode: internalToolContext.resultingMode
                });

                id = `chatcmpl-${crypto.randomUUID()}`;
                keepaliveInterval = null;
                let completionTokens = 0;
                let reasoningTokens = 0;

                if (turnPlan.reuse) {
                    turnBaseline = resolvedTurn.baseline;
                    if (!turnBaseline || !turnBaseline.ok) {
                        await discardConversationEntry(conversationKey);
                        res.status(503).json(sessionStateUnavailableBody());
                        return;
                    }
                }

                /**
                 * @param {Array<Record<string, unknown>>} builtParts Prompt parts.
                 * @returns {Array<Record<string, unknown>>} Parts with the contract reminder.
                 */
                /**
                 * @param {Array<Record<string, unknown>>} builtParts Prompt parts.
                 * @returns {Array<Record<string, unknown>>} Parts with the contract reminder.
                 */
                const withToolReminder = (builtParts) =>
                    externalToolContext.reminder
                        ? [...builtParts, { type: 'text', text: externalToolContext.reminder }]
                        : builtParts;

                const rebuildPromptPartsForNewSession = async () => {
                    const rebuilt = await buildPromptParts(messages, externalToolRegistry, {
                        includeFromIndex: 0
                    });
                    if (rebuilt.parts.length) {
                        promptParams.body.parts = withToolReminder(rebuilt.parts);
                    }
                };

                /** @type {PromptParams} */
                const promptParams = {
                    path: { id: /** @type {string} */ (sessionId) },
                    body: {
                        model: { providerID: pID, modelID: mID },
                        system: systemWithGuard,
                        parts: withToolReminder(parts),
                        ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                        ...(requestParams.temperature !== undefined && {
                            temperature: requestParams.temperature
                        }),
                        ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                        ...(requestParams.stop && { stop: requestParams.stop })
                    }
                };
                const { toolOverrides } = toolControl;
                if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                    promptParams.body.tools = toolOverrides;
                }

                const makeForcedChatToolCallRequester = () =>
                    createForcedToolCallRequester({
                        mode: externalToolChoice.mode,
                        sessionId: /** @type {string} */ (sessionId),
                        systemWithGuard,
                        requiredTool:
                            externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                        providerID: pID,
                        modelID: mID,
                        baselineProvider: () => snapshotSessionState(/** @type {string} */ (sessionId)),
                        toolOverrides,
                        requestTimeoutMs: REQUEST_TIMEOUT_MS,
                        signal: turnAbort.signal,
                        forbidThinkBlock: true
                    });
                let requestForcedChatToolCall = makeForcedChatToolCallRequester();

                res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                if (stream) {
                    const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                    /** @type {ToolCallFilterWithFlush} */
                    const filterContentDelta = /** @type {ToolCallFilterWithFlush} */ (
                        createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup
                        })
                    );
                    /** @type {ToolCallFilterWithFlush} */
                    const filterReasoningDelta = /** @type {ToolCallFilterWithFlush} */ (
                        createToolCallFilter({
                            disableTools: DISABLE_TOOLS,
                            forceStrip: shouldStripStreamingToolMarkup
                        })
                    );
                    /** @type {ExternalToolCallParserWithFlush} */
                    const parseContentToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                        createExternalToolCallStreamParser(externalToolRegistry)
                    );
                    /** @type {ExternalToolCallParserWithFlush} */
                    const parseReasoningToolCalls = /** @type {ExternalToolCallParserWithFlush} */ (
                        createExternalToolCallStreamParser(externalToolRegistry)
                    );
                    let streamedContent = '';
                    let streamedReasoning = '';
                    let rawStreamedContent = '';
                    let rawStreamedReasoning = '';
                    /** @type {import('../tools/contract.js').WireToolCall[]} */
                    const streamedToolCalls = [];
                    keepaliveInterval = null;
                    completionTokens = 0;
                    reasoningTokens = 0;
                    const chatStreamWriter = createChatStreamWriter({
                        res,
                        id,
                        model: `${pID}/${mID}`
                    });

                    const ensureKeepalive = () => {
                        if (!keepaliveInterval) {
                            keepaliveInterval = setInterval(() => {
                                if (!res.destroyed) {
                                    res.write(': keepalive\n\n');
                                }
                            }, 15000);
                        }
                    };
                    ensureKeepalive();

                    /**
                     * @param {string} delta Text delta.
                     * @param {boolean} [isReasoning] Whether this is reasoning text.
                     * @returns {void}
                     */
                    /**
                     * @param {string} delta Streamed text.
                     * @param {boolean} [isReasoning] Whether this is reasoning text.
                     * @returns {void}
                     */
                    const sendDelta = (delta, isReasoning = false) => {
                        if (!delta) return;
                        if (isReasoning) rawStreamedReasoning += delta;
                        else rawStreamedContent += delta;
                        const parsedDeltaToolCalls = isReasoning
                            ? parseReasoningToolCalls(delta)
                            : parseContentToolCalls(delta);
                        parsedDeltaToolCalls.forEach((toolCall) => {
                            streamedToolCalls.push(toolCall);
                            chatStreamWriter.toolCall(toolCall, streamedToolCalls.length - 1);
                        });
                        const filtered = isReasoning
                            ? filterReasoningDelta(delta)
                            : filterContentDelta(delta);
                        if (!filtered) return;
                        if (isReasoning) {
                            streamedReasoning += filtered;
                            reasoningTokens += Math.ceil(filtered.length / 4);
                        } else {
                            streamedContent += filtered;
                            completionTokens += Math.ceil(filtered.length / 4);
                        }
                        chatStreamWriter.delta(filtered, isReasoning);
                    };

                    let collected = null;
                    for (let attempt = 1; attempt <= DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS; attempt += 1) {
                        if (attempt > 1) {
                            sessionId = await rotateRuntimeSession({
                                sessionId: /** @type {string} */ (sessionId),
                                deleteSession: (id) => client.session.delete({ path: { id } }),
                                createSession: () => createSession(toolControl),
                                attempt,
                                backoffBaseMs: DEFAULT_RUNTIME_RETRY_BACKOFF_BASE_MS,
                                sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                                logDebug
                            });
                            promptParams.path.id = sessionId;
                            turnBaseline = null;
                            await rebuildPromptPartsForNewSession();
                            requestForcedChatToolCall = makeForcedChatToolCallRequester();
                            streamedContent = '';
                            streamedReasoning = '';
                            rawStreamedContent = '';
                            rawStreamedReasoning = '';
                            streamedToolCalls.length = 0;
                            completionTokens = 0;
                            reasoningTokens = 0;
                        }
                        try {
                            collected = /** @type {CollectedTurn} */ (
                                await collectRuntimePromptAttempt({
                                    collect: () =>
                                        collectFromEvents(
                                            /** @type {string} */ (sessionId),
                                            REQUEST_TIMEOUT_MS,
                                            sendDelta,
                                            EVENT_FIRST_DELTA_TIMEOUT_MS,
                                            EVENT_IDLE_TIMEOUT_MS,
                                            turnBaseline,
                                            turnAbort.signal
                                        ),
                                    prompt: () => client.session.prompt(promptParams),
                                    onPromptError: (error) => logDebug('Prompt error:', error.message)
                                })
                            );
                        } catch (e) {
                            logDebug('Stream error:', /** @type {Error} */ (e).message);
                        }

                        const attemptError = collected?.error || collected?.__error || null;
                        const nothingStreamed =
                            !rawStreamedContent && !rawStreamedReasoning && streamedToolCalls.length === 0;
                        if (
                            shouldRetryRuntimeAttempt({
                                error: attemptError,
                                hasOutput: !nothingStreamed,
                                attempt
                            })
                        ) {
                            logWarn(
                                `[Proxy] Transient upstream error (attempt ${attempt}/${DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS}), retrying:`,
                                runtimeRetryDetail(attemptError)
                            );
                            continue;
                        }
                        break;
                    }

                    const chatReconciliation = await reconcileChatRuntimeStream({
                        collected,
                        poll: () =>
                            pollForAssistantResponse(
                                /** @type {string} */ (sessionId),
                                REQUEST_TIMEOUT_MS,
                                DEFAULT_POLL_INTERVAL_MS,
                                turnBaseline
                            ),
                        sendDelta,
                        getState: () => ({
                            streamedContent,
                            streamedReasoning,
                            rawStreamedContent,
                            rawStreamedReasoning
                        }),
                        logDebug,
                        sessionId: /** @type {string} */ (sessionId)
                    });
                    if (chatReconciliation.clientClosed) return;

                    let { parsedToolCalls } = reconcileStreamedToolCalls({
                        registry: externalToolRegistry,
                        streamedToolCalls,
                        reasoningParser: parseReasoningToolCalls,
                        contentParser: parseContentToolCalls,
                        reasoningFilter: filterReasoningDelta,
                        contentFilter: filterContentDelta,
                        rawReasoning: rawStreamedReasoning,
                        rawContent: rawStreamedContent
                    });
                    if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                        const forcedResponse = await requestForcedChatToolCall();
                        if (forcedResponse) {
                            parsedToolCalls = parseExternalToolCallsFromText(
                                externalToolRegistry,
                                forcedResponse.reasoning,
                                forcedResponse.content
                            );
                        }
                    }
                    const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(
                        parsedToolCalls,
                        externalToolRegistry
                    );
                    const finalStreamedToolCalls = validatedStreamedToolCalls;
                    if (finalStreamedToolCalls.length > 0 && streamedToolCalls.length === 0) {
                        chatStreamWriter.toolCalls(finalStreamedToolCalls);
                    }

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                    chatStreamWriter.finish(
                        { promptTokens, completionTokens, reasoningTokens },
                        finalStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                    );
                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan?.sentCount,
                        sentDigest: turnPlan?.sentDigest,
                        replyText: streamedContent || null,
                        startKey: derivedIdentity?.startKey || null
                    });
                    chatStreamWriter.done();
                    res.end();
                } else {
                    let content = '';
                    let reasoning = '';
                    let error = null;
                    for (let attempt = 1; attempt <= DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS; attempt += 1) {
                        if (attempt > 1) {
                            sessionId = await rotateRuntimeSession({
                                sessionId: /** @type {string} */ (sessionId),
                                deleteSession: (id) => client.session.delete({ path: { id } }),
                                createSession: () => createSession(toolControl),
                                attempt,
                                backoffBaseMs: DEFAULT_RUNTIME_RETRY_BACKOFF_BASE_MS,
                                sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                                logDebug
                            });
                            promptParams.path.id = sessionId;
                            turnBaseline = null;
                            await rebuildPromptPartsForNewSession();
                            requestForcedChatToolCall = makeForcedChatToolCallRequester();
                        }
                        const collected = /** @type {PollResultLike} */ (
                            await runPolledRuntimeAttempt({
                                prompt: () =>
                                    promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS, turnAbort.signal),
                                poll: () =>
                                    pollForAssistantResponse(
                                        /** @type {string} */ (sessionId),
                                        REQUEST_TIMEOUT_MS,
                                        DEFAULT_POLL_INTERVAL_MS,
                                        turnBaseline
                                    ),
                                sessionId: /** @type {string} */ (sessionId),
                                attempt,
                                logDebug
                            })
                        );
                        content = collected.content || '';
                        reasoning = collected.reasoning || '';
                        error = collected.error || null;
                        if (
                            shouldRetryRuntimeAttempt({
                                error,
                                hasOutput: Boolean(content || reasoning),
                                attempt
                            })
                        ) {
                            logWarn(
                                `[Proxy] Transient upstream error (attempt ${attempt}/${DEFAULT_RUNTIME_RETRY_MAX_ATTEMPTS}), retrying:`,
                                runtimeRetryDetail(error)
                            );
                            continue;
                        }
                        break;
                    }
                    if (error && !content && !reasoning) {
                        await discardTurnState(conversationKey, sessionId);
                        res.status(502).json({
                            error: {
                                message: error.data?.message || error.message || 'OpenCode provider error',
                                type: error.name || 'OpenCodeError'
                            }
                        });
                        return;
                    }
                    let parsedToolCalls =
                        externalToolRegistry.length > 0
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                    if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                        const forcedResponse = await requestForcedChatToolCall();
                        if (forcedResponse) {
                            content = forcedResponse.content || content;
                            reasoning = forcedResponse.reasoning || reasoning;
                            parsedToolCalls = parseExternalToolCallsFromText(
                                externalToolRegistry,
                                reasoning,
                                content
                            );
                        }
                    }
                    const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(
                        parsedToolCalls,
                        externalToolRegistry
                    );
                    const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                    const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

                    const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                    const completionTokensCalc = Math.ceil((content || '').length / 4);
                    const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
                    const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

                    const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
                    /** @type {AssistantMessageOut} */
                    const assistantMessage = {
                        role: 'assistant',
                        content: publicValidatedToolCalls.length > 0 ? safeContent || null : safeContent,
                        ...(safeReasoning ? { reasoning_content: safeReasoning } : {})
                    };
                    if (publicValidatedToolCalls.length > 0) {
                        assistantMessage.tool_calls = publicValidatedToolCalls;
                    }

                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan?.sentCount,
                        sentDigest: turnPlan?.sentDigest,
                        replyText: safeContent || '',
                        startKey: derivedIdentity?.startKey || null
                    });

                    res.json({
                        id: `chatcmpl-${crypto.randomUUID()}`,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: `${pID}/${mID}`,
                        choices: [
                            {
                                index: 0,
                                message: assistantMessage,
                                finish_reason: publicValidatedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                            }
                        ],
                        usage: {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokensCalc + reasoningTokensCalc,
                            total_tokens: totalTokens,
                            completion_tokens_details: {
                                reasoning_tokens: reasoningTokensCalc
                            }
                        }
                    });
                }
            } catch (error) {
                logError('[Proxy] API Error:', /** @type {UpstreamErrorLike} */ (error).message);
                logError('[Proxy] Error details:', error);

                if (keepaliveInterval) clearInterval(keepaliveInterval);

                if (res.writableEnded || res.destroyed) {
                    // The client is gone; there is nobody to report to.
                } else if (!res.headersSent) {
                    const transformed = transformUpstreamError(/** @type {UpstreamErrorLike} */ (error));
                    res.status(transformed.statusCode).json({ error: transformed.error });
                } else {
                    res.write(
                        `data: ${JSON.stringify({ error: { message: /** @type {UpstreamErrorLike} */ (error).message } })}\n\n`
                    );
                    res.end();
                }
                await discardTurnState(conversationKey, sessionId);
            } finally {
                if (typeof releaseConversationLock === 'function') releaseConversationLock();
                if (typeof releaseTurnCapacity === 'function') releaseTurnCapacity();
                if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval)
                    clearInterval(keepaliveInterval);
                if (eventStream && eventStream.close) {
                    eventStream.close();
                }
            }
        } catch (error) {
            logError('[Proxy] Request Handler Error:', /** @type {UpstreamErrorLike} */ (error).message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: /** @type {UpstreamErrorLike} */ (error).message,
                        type: /** @type {UpstreamErrorLike} */ (error).constructor.name
                    }
                });
            }
        }
    };
}
