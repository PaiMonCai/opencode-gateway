/**
 * Responses API turn orchestrator.
 *
 * Owns only the /v1/responses request state machine. Cross-surface helpers and
 * wire renderers are imported directly; session/conversation collaborators are
 * injected by the turn engine.
 *
 * @module routes/responses-handler
 */

import {
    deliverableMessages as conversationDeliverableMessages,
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
import { normalizeTextContent } from './input-normalization.js';
import { createResponsesInputNormalizer } from './responses-input.js';
import { collectRuntimePromptAttempt } from './runtime-attempt.js';
import { reconcileResponsesRuntimeStream } from './runtime-reconciliation.js';
import {
    buildResponsesFunctionCallOutputItem,
    buildResponsesMessageOutputItem,
    createResponsesStreamWriter
} from './streaming/responses-writer.js';
import { writeResponsesFailure } from './streaming/sse.js';

const DEFAULT_POLL_INTERVAL_MS = 500;

/** @typedef {Record<string, any>} ChatMessage */
/**
 * @typedef {object} ChatMessagePart
 * @property {string} [type]
 * @property {string} [text]
 * @property {string|{url?: string}} [image_url]
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
/** @typedef {import('../tools/parser.js').ToolCallFilter & {flush: () => string}} ToolCallFilterWithFlush */
/** @typedef {import('../tools/parser.js').ExternalToolCallStreamParser & {flush: () => import('../tools/contract.js').WireToolCall[]}} ExternalToolCallParserWithFlush */

/**
 * Create the Responses API handler.
 *
 * @param {Record<string, any>} deps Engine collaborators and runtime settings.
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} Responses handler.
 */
export function createResponsesHandler(deps) {
    const {
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
    } = deps;

    /** @type {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
    const handleResponses = async (req, res) => {
        /** @type {string|null} */
        let conversationKey = null;
        let turnPlan = null;
        /** @type {import('../conversation/baseline.js').SessionBaseline|null} */
        let turnBaseline = null;
        /** @type {(() => void)|null} */
        let releaseConversationLock = null;
        /** @type {(() => void)|null} */
        let releaseTurnCapacity = null;
        // Aborted on client disconnect so a streaming turn does not hold its lock
        // until the idle or request timeout fires.
        const turnAbort = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) turnAbort.abort();
        });
        try {
            const {
                model,
                input,
                reasoning_effort,
                reasoning: requestReasoning,
                max_output_tokens,
                tools = [],
                tool_choice,
                instructions,
                temperature,
                top_p,
                stream = false,
                messages: chatMessages,
                prompt,
                previous_response_id: previousResponseId,
                opencode: requestOpencodeConfig
            } = req.body;

            // Stateful continuation: reuse the session behind a previous response so the
            // client only needs to send the new turn (OpenAI Responses API semantics).
            const previousState = previousResponseId ? getResponseState(previousResponseId) : null;

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                null
            );

            const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
            const toolMode = requestToolContext.mode;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/responses'
            });
            logDebug('Responses API request', {
                model,
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                toolMode,
                internalAllowedTools: internalToolContext.allowedToolNames,
                requestedInternalTools: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode
            });
            const externalToolContext = requestToolContext.external;
            const externalToolRegistry = externalToolContext.registry;
            const externalToolChoice = externalToolContext.toolChoice;
            const buildResponsesInputMessages = createResponsesInputNormalizer(externalToolRegistry);

            /** @type {ChatMessage[]} */
            let messages = [];
            if (Array.isArray(chatMessages) && chatMessages.length) {
                messages = buildResponsesInputMessages(chatMessages);
            } else if (typeof prompt === 'string' && prompt.trim()) {
                messages = [{ role: 'user', content: prompt }];
            } else if (typeof input === 'string' && input.trim()) {
                messages = [{ role: 'user', content: input }];
            } else if (Array.isArray(input)) {
                messages = buildResponsesInputMessages(input);
            } else if (input && typeof input === 'object') {
                if (
                    input.type === 'message' ||
                    input.type === 'function_call' ||
                    input.type === 'function_call_output' ||
                    input.type === 'tool_result'
                ) {
                    messages = buildResponsesInputMessages([input]);
                } else {
                    const content = normalizeTextContent(input.content || input.text);
                    if (content) {
                        messages = [{ role: input.role || 'user', content }];
                    }
                }
            }

            if (!messages.length) {
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            const resolvedModel = await resolveRequestedModel(model || previousState?.model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;

            // A direct turn never consults our own response store: the upstream
            // hands out the response ids the client chains with.
            const servingMode = router.shouldUseDirect(pID, mID).direct ? 'direct' : 'runtime';
            if (previousResponseId && !previousState && servingMode === 'runtime') {
                return res
                    .status(400)
                    .json({ error: { message: 'Invalid or expired previous_response_id' } });
            }

            if (servingMode === 'direct') {
                const deliverableMessages = conversationDeliverableMessages(messages);
                const conversationScope = conversationScopeForTurn(
                    pID,
                    mID,
                    toolMode,
                    toolsFingerprintFor(tools, tool_choice),
                    'direct'
                );
                const resolvedDirectTurn = await resolveConversationTurn({
                    req,
                    deliverable: deliverableMessages,
                    scope: conversationScope
                });
                conversationKey = resolvedDirectTurn.key;
                releaseConversationLock = resolvedDirectTurn.release;
                if (resolvedDirectTurn.busy) {
                    return res.status(503).json(conversationBusyBody());
                }
                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;
                const sessionId =
                    resolvedDirectTurn.entry?.mode === 'direct' && resolvedDirectTurn.entry.sessionId
                        ? resolvedDirectTurn.entry.sessionId
                        : newSessionId();
                const turnPlanForDirect = resolvedDirectTurn.plan;
                const directIdentity = resolvedDirectTurn.identity;
                const { opencode: _omitProxyExtension, ...upstreamBody } = req.body || {};

                const directResult = await runDirectTurn({
                    path: '/responses',
                    res,
                    providerID: pID,
                    modelID: mID,
                    sessionId,
                    body: { ...upstreamBody, model: mID },
                    stream,
                    clientModelName: `${pID}/${mID}`,
                    signal: turnAbort.signal,
                    fallbackTurn: { providerID: pID, modelID: mID, key: conversationKey, mode: 'direct' },
                    onSuccess: (/** @type {string|null} */ answerText) =>
                        storeConversationEntry(conversationKey, {
                            sessionId,
                            mode: 'direct',
                            sentCount: turnPlanForDirect?.sentCount,
                            sentDigest: turnPlanForDirect?.sentDigest,
                            replyText: typeof answerText === 'string' ? answerText : null,
                            startKey: directIdentity?.startKey || null
                        })
                });
                if (directResult.handled) return;
                // Falling back to the runtime: hand the conversation lock back first,
                // because the runtime path resolves the same conversation and takes it.
                if (typeof releaseConversationLock === 'function') releaseConversationLock();
                releaseConversationLock = null;
                logWarn(
                    `[Proxy] Serving ${pID}/${mID} through the local runtime after the direct upstream refused it`
                );
            }

            await ensureBackend();

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch {
                // Best effort: a failed model switch must not fail the turn.
            }

            // Continue the stored session when chaining from previous_response_id, else
            // reuse the header-bound session or start fresh. A chained session keeps the
            // tool policy it was created with, so toolControl.title only matters for new ones.
            const toolControl = await resolveToolControl(toolMode, internalToolContext);
            const deliverableMessages = conversationDeliverableMessages(messages);
            const conversationScope = conversationScopeForTurn(
                pID,
                mID,
                toolMode,
                toolsFingerprintFor(tools, tool_choice),
                'runtime'
            );
            const resolvedTurn = await resolveConversationTurn({
                req,
                deliverable: deliverableMessages,
                scope: conversationScope,
                previousSessionId: previousState?.sessionId || null
            });
            conversationKey = resolvedTurn.key;
            releaseConversationLock = resolvedTurn.release;
            if (resolvedTurn.busy) {
                return res.status(503).json(conversationBusyBody());
            }
            if (!releaseTurnCapacity) {
                releaseTurnCapacity = await acquireTurnCapacity(res, turnAbort.signal);
                if (!releaseTurnCapacity) return;
            }
            turnPlan = resolvedTurn.plan;
            const derivedIdentity =
                resolvedTurn.identity?.source === 'derived' ? resolvedTurn.identity : null;

            let sessionId = resolvedTurn.sessionId;
            if (!sessionId) {
                if (resolvedTurn.entry?.sessionId) {
                    await registry.discard({ key: conversationKey });
                }
                sessionId = await createSession(toolControl);
                logDebug('Session created', {
                    sessionId,
                    historyRewritten: turnPlan?.rewrite,
                    derived: Boolean(derivedIdentity)
                });
            }

            if (turnPlan?.reuse || previousState?.sessionId) {
                turnBaseline = resolvedTurn.baseline;
                if (!turnBaseline || !turnBaseline.ok) {
                    // Answer here instead of throwing: the upstream error mapper rewrites
                    // any 5xx into 502 server_error and loses the documented code.
                    return res.status(503).json(sessionStateUnavailableBody());
                }
            }

            const parts = [];
            const systemChunks = [];
            let fullPromptText = '';
            let deliveredCount = -1;
            const includeFromIndex = turnPlan?.reuse ? turnPlan.deltaStartIndex : 0;
            /**
             * @param {string|undefined} role Message role.
             * @param {ChatMessagePart[]|string|null|undefined} text Rendered text.
             * @returns {string} `ROLE: text` line.
             */
            const formatResponsesRoleLine = (role, text) =>
                `${String(role || 'user').toUpperCase()}: ${text}`;
            for (const msg of messages) {
                if (msg.role === 'system') {
                    if (msg.content) systemChunks.push(msg.content);
                    continue;
                }
                deliveredCount += 1;
                if (!msg.content) continue;
                const text =
                    msg.role === 'tool' ||
                    String(msg.content).startsWith('ASSISTANT: ') ||
                    String(msg.content).startsWith('TOOL_RESULT: ')
                        ? msg.content
                        : msg.role === 'user'
                          ? msg.content
                          : formatResponsesRoleLine(msg.role, msg.content);
                // Token accounting covers the whole conversation; only the appended
                // turns are actually sent when the session already holds the rest.
                fullPromptText += `${text}\n\n`;
                if (deliveredCount < includeFromIndex) continue;
                parts.push({ type: 'text', text });
            }

            const systemWithGuard = buildSystemPrompt(
                [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                reasoningLevel,
                toolMode,
                internalToolContext.allowedToolNames
            );

            const requestForcedResponsesToolCall = createForcedToolCallRequester({
                mode: externalToolChoice.mode,
                sessionId,
                systemWithGuard,
                requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                providerID: pID,
                modelID: mID,
                toolOverrides: toolControl.toolOverrides,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                baselineProvider: () => snapshotSessionState(sessionId),
                signal: turnAbort.signal,
                forbidThinkBlock: false
            });

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts: externalToolContext.reminder
                        ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                        : parts,
                    ...(max_output_tokens && { max_tokens: max_output_tokens }),
                    ...(temperature !== undefined && { temperature }),
                    ...(top_p !== undefined && { top_p })
                }
            };
            const { toolOverrides } = toolControl;
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                promptParams.body.tools = toolOverrides;
            }

            let content = '';
            let reasoning = '';
            if (stream) {
                const responsesStreamWriter = createResponsesStreamWriter({
                    res,
                    model: `${pID}/${mID}`
                });
                const { responseId, streamedToolCalls } = responsesStreamWriter;
                responsesStreamWriter.start();

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
                let rawContent = '';
                let rawReasoning = '';
                /**
                 * @param {string} delta Text delta.
                 * @param {boolean} [isReasoning] Whether the delta is reasoning text.
                 * @returns {void}
                 */
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    if (isReasoning) rawReasoning += delta;
                    else rawContent += delta;
                    const parsedDeltaToolCalls = isReasoning
                        ? parseReasoningToolCalls(delta)
                        : parseContentToolCalls(delta);
                    if (parsedDeltaToolCalls.length > 0) {
                        const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(
                            parsedDeltaToolCalls,
                            externalToolRegistry
                        );
                        allowedDeltaToolCalls.forEach(
                            (/** @type {import('../tools/contract.js').WireToolCall} */ toolCall) =>
                                responsesStreamWriter.functionCall(toolCall)
                        );
                    }
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        reasoning += filtered;
                        responsesStreamWriter.reasoningDelta(filtered);
                    } else {
                        if (!filtered.trim()) {
                            content += filtered;
                            return;
                        }
                        content += filtered;
                        responsesStreamWriter.textDelta(filtered);
                    }
                };

                let collected = null;
                try {
                    collected = /** @type {CollectedTurn} */ (
                        await collectRuntimePromptAttempt({
                            collect: () =>
                                collectFromEvents(
                                    sessionId,
                                    REQUEST_TIMEOUT_MS,
                                    sendResponsesDelta,
                                    EVENT_FIRST_DELTA_TIMEOUT_MS,
                                    EVENT_IDLE_TIMEOUT_MS,
                                    turnBaseline,
                                    turnAbort.signal
                                ),
                            prompt: () => client.session.prompt(promptParams),
                            onPromptError: (error) => logDebug('Responses prompt error:', error.message)
                        })
                    );
                } catch (e) {
                    collected = { __error: /** @type {TurnError} */ (e) };
                }

                const responsesReconciliation = await reconcileResponsesRuntimeStream({
                    collected,
                    poll: () =>
                        pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        ),
                    sendDelta: sendResponsesDelta,
                    getState: () => ({ content, reasoning, rawContent, rawReasoning }),
                    logDebug,
                    sessionId
                });
                if (responsesReconciliation.clientClosed) return res.end();

                responsesStreamWriter.finishReasoning(reasoning);
                responsesStreamWriter.finishText(content);

                let polledForToolCalls = null;
                if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
                    try {
                        polledForToolCalls = await pollForAssistantResponse(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            DEFAULT_POLL_INTERVAL_MS,
                            turnBaseline
                        );
                    } catch {
                        // Best effort: polling is optional once the stream produced calls.
                    }
                }

                let { parsedToolCalls } = reconcileStreamedToolCalls({
                    registry: externalToolRegistry,
                    streamedToolCalls,
                    reasoningParser: parseReasoningToolCalls,
                    contentParser: parseContentToolCalls,
                    reasoningFilter: filterReasoningDelta,
                    contentFilter: filterContentDelta,
                    rawReasoning,
                    rawContent,
                    snapshotReasoning: polledForToolCalls?.reasoning,
                    snapshotContent: polledForToolCalls?.content
                });
                if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                    const forcedResponse = await requestForcedResponsesToolCall();
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
                const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));
                if (streamedToolCalls.length === 0) {
                    validatedStreamedToolCalls.forEach(
                        (/** @type {import('../tools/contract.js').WireToolCall} */ toolCall) => {
                            responsesStreamWriter.functionCall(toolCall);
                        }
                    );
                }
                const streamOutput = [];
                const streamMessageOutputItem = buildResponsesMessageOutputItem(
                    safeContent && safeContent.trim() ? safeContent : ''
                );
                if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
                validatedStreamedToolCalls.forEach(
                    (/** @type {import('../tools/contract.js').WireToolCall} */ toolCall) => {
                        streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall));
                    }
                );
                const promptTokens = Math.ceil(fullPromptText.length / 4);
                const completionTokens = Math.ceil(content.length / 4);
                const reasoningTokens = Math.ceil(reasoning.length / 4);
                const response = {
                    id: responseId,
                    object: 'response',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    reasoning: safeReasoning
                        ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) }
                        : undefined,
                    output: streamOutput,
                    usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens + reasoningTokens,
                        total_tokens: promptTokens + completionTokens + reasoningTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: reasoningTokens }
                    }
                };
                responsesStreamWriter.complete(response);
                responsesStreamWriter.done();
                storeResponseState(responseId, sessionId, `${pID}/${mID}`);
                // Only planned turns may be registered: recording a `previous_response_id`
                // session with no delivered-turn count would let the next header-only request
                // evict a session the response chain still uses.
                if (turnPlan) {
                    storeConversationEntry(conversationKey, {
                        sessionId,
                        sentCount: turnPlan.sentCount,
                        sentDigest: turnPlan.sentDigest,
                        replyText: content || null,
                        startKey: derivedIdentity?.startKey || null
                    });
                }
                return res.end();
            }

            const responseRes = await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS, turnAbort.signal);
            const responseParts = responseRes.data?.parts || [];
            const promptContent = responseParts
                .filter((/** @type {{type?: string, text?: string}} */ p) => p.type === 'text')
                .map((/** @type {{type?: string, text?: string}} */ p) => p.text)
                .join('\n');
            const promptReasoning = responseParts
                .filter((/** @type {{type?: string, text?: string}} */ p) => p.type === 'reasoning')
                .map((/** @type {{type?: string, text?: string}} */ p) => p.text)
                .join('\n');
            const promptParsedToolCalls =
                externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent)
                    : [];

            content = promptParsedToolCalls.length > 0 ? '' : promptContent;
            reasoning = promptReasoning;

            let promptBasedToolCalls = promptParsedToolCalls;
            const shouldPollForResponses = !promptContent && !promptReasoning;
            if (shouldPollForResponses) {
                const polledResponse = await pollForAssistantResponse(
                    sessionId,
                    REQUEST_TIMEOUT_MS,
                    DEFAULT_POLL_INTERVAL_MS,
                    turnBaseline
                );
                if (polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
                    throw polledResponse.error;
                }
                content = polledResponse.content || content;
                reasoning = polledResponse.reasoning || reasoning;
                promptBasedToolCalls =
                    externalToolRegistry.length > 0
                        ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                        : [];
            }

            if (!content && !reasoning && responseRes.data && promptBasedToolCalls.length === 0) {
                // Nothing streamed or polled: the runtime's flat `message` is the fallback.
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || '';
            }

            let parsedToolCalls =
                promptBasedToolCalls.length > 0
                    ? promptBasedToolCalls
                    : externalToolRegistry.length > 0
                      ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                      : [];
            if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                const forcedResponse = await requestForcedResponsesToolCall();
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

            const promptTokens = Math.ceil(fullPromptText.length / 4);
            const completionTokens = Math.ceil(content.length / 4);
            const reasoningTokens = Math.ceil(reasoning.length / 4);
            const output = [];
            const messageOutputItem = buildResponsesMessageOutputItem(safeContent);
            if (messageOutputItem) output.push(messageOutputItem);
            validatedToolCalls.forEach(
                (/** @type {import('../tools/contract.js').WireToolCall} */ toolCall) => {
                    output.push(buildResponsesFunctionCallOutputItem(toolCall));
                }
            );

            const responseId = `resp_${crypto.randomUUID()}`;
            const response = {
                id: responseId,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                reasoning: safeReasoning
                    ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) }
                    : undefined,
                output,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            storeResponseState(responseId, sessionId, `${pID}/${mID}`);
            // See the streaming branch: a `previous_response_id` turn must not
            // register a session the conversation map did not plan for.
            if (turnPlan) {
                storeConversationEntry(conversationKey, {
                    sessionId,
                    sentCount: turnPlan.sentCount,
                    sentDigest: turnPlan.sentDigest,
                    replyText: safeContent || '',
                    startKey: derivedIdentity?.startKey || null
                });
            }

            return res.json(response);
        } catch (error) {
            logError(
                '[Proxy] Responses API Error:',
                /** @type {TurnError} */ (error).message ||
                    /** @type {TurnError} */ (error).data?.message ||
                    /** @type {TurnError} */ (error).name ||
                    error
            );
            // The session is left holding a failed turn: close it when this turn
            // owned it (a previous_response_id chain keeps its own session).
            if (turnPlan) {
                await discardConversationEntry(conversationKey);
            } else {
                await discardTurnState(conversationKey, null);
            }
            const transformed = transformUpstreamError(/** @type {UpstreamErrorLike} */ (error));
            // Once the SSE headers are out, res.json() throws ERR_HTTP_HEADERS_SENT. That throw
            // escapes this async handler as an unhandled rejection, which terminates the whole
            // process under Node's default --unhandled-rejections=throw. Report the failure on
            // the already-open stream instead.
            if (res.headersSent) {
                try {
                    writeResponsesFailure(res, transformed.error);
                } catch (writeError) {
                    logDebug('Failed to report error on open response stream', {
                        error: /** @type {Error} */ (writeError).message
                    });
                }
                return res.end();
            }
            return res.status(transformed.statusCode).json({ error: transformed.error });
        } finally {
            if (typeof releaseConversationLock === 'function') releaseConversationLock();
            if (typeof releaseTurnCapacity === 'function') releaseTurnCapacity();
        }
    };

    return handleResponses;
}
