import { resolveLogger, sleep, toMillis } from './support.js';

/**
 * Runtime upstream client.
 *
 * The second upstream shape: drive the local OpenCode runtime through
 * `@opencode-ai/sdk`. It is the only path that can serve the Zen free tier,
 * whose gate is an official-client identity plain HTTP cannot reproduce, and the
 * fallback whenever the direct upstream is unavailable or refused.
 *
 * Responsibilities kept here:
 * - session lifecycle (`createSession` / `deleteSession` / `ensureReady`),
 * - one prompt call with timeout and client-abort handling (`prompt`),
 * - reading an existing session back (`messages`),
 * - the two ways an answer is observed: the SDK event stream
 *   ({@link collectFromEvents}) and polling ({@link pollForAssistantResponse}),
 * - the runtime provider catalog (`listModels`).
 *
 * Both observation paths filter against the turn baseline: a reused session
 * still holds the previous turns, and reporting their content as this turn's
 * answer is the one bug the rebuild must not reintroduce.
 *
 * @typedef {object} TurnBaseline
 * @property {Set<string>} [messageIds] Message ids that existed before the turn.
 * @property {Set<string>} [partIds] Part ids that existed before the turn.
 *
 * @typedef {object} PollResult
 * @property {string} content Assistant text collected so far.
 * @property {string} reasoning Reasoning text collected so far.
 * @property {object|null} error Upstream message error, when the turn failed.
 *
 * @typedef {object} CollectResult
 * @property {string} content Assistant text.
 * @property {string} reasoning Reasoning text.
 * @property {object} [error] Upstream message error.
 * @property {boolean} [noData] No event arrived inside the first-delta window.
 * @property {boolean} [idleTimeout] The stream went idle and was cut.
 * @property {boolean} [receivedDelta] Whether any text/tool progress was seen.
 * @property {boolean} [clientClosed] The caller aborted (client disconnected).
 */

/** Poll interval for the runtime session state. @type {number} */
export const DEFAULT_POLL_INTERVAL_MS = 500;
/** How long a turn may run before it is reported as timed out. @type {number} */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
/** How long to wait for the first streamed delta before falling back. @type {number} */
export const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 30000;
/** How long an event stream may stay idle before it is cut. @type {number} */
export const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 8000;
/** Session title prefix carrying the tool policy enforced by the plugin. @type {string} */
export const SESSION_TITLE_PREFIX = 'opencode-gateway';

/**
 * Session title the tool-lock plugin parses: `opencode-gateway [tools:*]`,
 * `[tools:none]` or `[tools:webfetch,read]`.
 *
 * @param {string} policy Policy payload, e.g. `'none'`, `'*'` or `'read,webfetch'`.
 * @returns {string} Title to pass to `session.create`.
 */
export const sessionTitleForPolicy = (policy) => `${SESSION_TITLE_PREFIX} [tools:${policy}]`;

/**
 * Split an OpenCode message's parts into text, reasoning and tool parts.
 *
 * @param {Array<Record<string, any>>} parts Message parts.
 * @returns {{content: string, reasoning: string, toolParts: Array<Record<string, any>>}} Extracted parts.
 */
export function extractFromParts(parts) {
    if (!Array.isArray(parts)) return { content: '', reasoning: '', toolParts: [] };
    const content = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
    const reasoning = parts
        .filter((p) => p.type === 'reasoning')
        .map((p) => p.text)
        .join('');
    const toolParts = parts.filter((p) => p.type === 'tool');
    return { content, reasoning, toolParts };
}

/**
 * @typedef {object} RuntimeModel
 * @property {string} id Fully qualified `provider/model`.
 * @property {string} name Human readable name.
 * @property {'model'} object Always `model`.
 * @property {number} created Unix seconds.
 * @property {string} owned_by Provider id.
 */

/**
 * Flatten the runtime provider catalog into client-facing model entries.
 *
 * @param {Array<Record<string, any>>} providersList Providers from `config.providers()`.
 * @returns {RuntimeModel[]} Models keyed `provider/model`.
 */
export function buildModelsList(providersList) {
    /** @type {RuntimeModel[]} */
    const models = [];
    providersList.forEach((p) => {
        if (p.models) {
            Object.entries(p.models).forEach(([mId, mData]) => {
                models.push({
                    id: `${p.id}/${mId}`,
                    name: typeof mData === 'object' ? mData.name || mData.label || mId : mId,
                    object: 'model',
                    created:
                        mData && mData.release_date
                            ? Math.floor(new Date(mData.release_date).getTime() / 1000)
                            : 1704067200,
                    owned_by: p.id
                });
            });
        }
    });
    return models;
}

/**
 * Run one SDK prompt call with a timeout and an optional client-abort race.
 *
 * Rejections carry the same `statusCode`/`code` markers as before:
 * `504 request_timeout` on timeout, `499 client_closed` when the caller aborts.
 *
 * @param {object} options Prompt options.
 * @param {any} options.client SDK client (or a fake with `session.prompt`).
 * @param {any} options.params Raw `session.prompt` arguments.
 * @param {number} [options.timeoutMs] Timeout in milliseconds; `0` disables it.
 * @param {AbortSignal|null} [options.signal] Caller-owned abort signal.
 * @param {object|Function|null} [options.logger] Logger dependency.
 * @returns {Promise<*>} Whatever the SDK resolves with.
 */
export async function promptWithTimeout({
    client,
    params,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal = null,
    logger = null
}) {
    const log = resolveLogger(logger, 'upstreams/runtime');
    let timer = null;
    let timeoutPromise = null;
    if (timeoutMs > 0) {
        timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    Object.assign(new Error(`Request timeout after ${timeoutMs}ms`), {
                        statusCode: 504,
                        code: 'request_timeout'
                    })
                );
            }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
        });
    }
    let onAbort = null;
    const abortPromise = signal
        ? new Promise((_, reject) => {
              const abort = () => {
                  reject(
                      Object.assign(new Error('Client closed the request'), {
                          statusCode: 499,
                          code: 'client_closed'
                      })
                  );
              };
              onAbort = abort;
              if (signal.aborted) {
                  abort();
                  return;
              }
              signal.addEventListener('abort', abort, { once: true });
          })
        : null;
    const racing = [client.session.prompt(params)];
    if (timeoutPromise) racing.push(timeoutPromise);
    if (abortPromise) racing.push(abortPromise);
    try {
        return await Promise.race(racing);
    } catch (error) {
        log.debug('Runtime prompt failed', {
            message: error instanceof Error ? error.message : String(error)
        });
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Poll a runtime session until its latest assistant message is done.
 *
 * Polling observes partial messages: a reasoning model emits its reasoning part
 * first and the text part only afterwards, so returning on the first non-empty
 * snapshot truncates the answer to the reasoning alone. A partial snapshot is
 * therefore kept only as a timeout fallback; otherwise the loop waits for the
 * message to actually finish.
 *
 * Baseline filtering: messages present before the turn started are skipped, so
 * a reused session never reports the previous turn's answer.
 *
 * @param {object} options Poll options.
 * @param {any} options.client SDK client (or a fake with `session.messages`).
 * @param {string} options.sessionId Runtime session id.
 * @param {number} [options.timeoutMs] Turn timeout.
 * @param {number} [options.intervalMs] Poll interval.
 * @param {TurnBaseline|null} [options.baseline] Pre-turn id snapshot.
 * @param {object|Function|null} [options.logger] Logger dependency.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(ms: number) => Promise<void>} [options.sleepFn] Sleep, injectable for tests.
 * @returns {Promise<PollResult>} The completed (or best-effort partial) answer.
 * @throws {Error} `Request timeout after <n>ms` when nothing usable arrived.
 */
export async function pollForAssistantResponse({
    client,
    sessionId,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    baseline = null,
    logger = null,
    now = Date.now,
    sleepFn = sleep
}) {
    const log = resolveLogger(logger, 'upstreams/runtime');
    const pollStart = now();
    const startedAt = pollStart;
    let lastPartial = null;
    while (now() - startedAt < timeoutMs) {
        const messagesRes = await client.session.messages({ path: { id: sessionId } });
        const messages = messagesRes?.data || messagesRes || [];
        if (Array.isArray(messages) && messages.length) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const entry = messages[i];
                const info = entry?.info;
                if (info?.role !== 'assistant') continue;
                // A reused session still holds the previous turns. They are finished
                // and non-empty, so without this filter the previous answer would be
                // reported as this turn's result.
                if (baseline?.messageIds?.size && info.id && baseline.messageIds.has(info.id)) continue;
                const { content, reasoning, toolParts } = extractFromParts(entry?.parts || []);
                const error = info?.error || null;
                // finish === 'tool' marks an intermediate turn that pauses for a tool
                // result; the assistant is not done producing output yet.
                const finished = info.finish && info.finish !== 'tool';
                const done = Boolean(finished || info.time?.completed || error);
                if (toolParts.length > 0) {
                    log.debug('Polling found tool parts', {
                        sessionId,
                        count: toolParts.length,
                        parts: toolParts.map((p) => ({
                            id: p.id,
                            tool: p.tool,
                            status: p.state?.status
                        }))
                    });
                }
                if (done) {
                    if (error) {
                        log.error('OpenCode assistant error', {
                            sessionId,
                            error: error.name || 'UnknownError'
                        });
                    }
                    log.debug('Polling completed', {
                        sessionId,
                        ms: now() - pollStart,
                        contentLen: content.length,
                        reasoningLen: reasoning.length,
                        error: error ? error.name : null
                    });
                    return { content, reasoning, error };
                }
                if (content || reasoning) {
                    lastPartial = { content, reasoning, error: null };
                }
                break;
            }
        }
        await sleepFn(intervalMs);
    }
    if (lastPartial) {
        log.debug('Polling timeout with partial response', {
            sessionId,
            ms: now() - pollStart,
            contentLen: lastPartial.content.length,
            reasoningLen: lastPartial.reasoning.length
        });
        return lastPartial;
    }
    log.debug('Polling timeout', { sessionId, ms: now() - pollStart });
    throw new Error(`Request timeout after ${timeoutMs}ms`);
}

/**
 * Collect one turn's answer from the SDK event stream.
 *
 * Contract preserved from the monolith:
 * - text/reasoning deltas for the session are accumulated, older
 *   `message.part.updated` deltas and newer `message.part.delta` events both work,
 * - the first-delta window resolves `{noData: true}` when no event arrives,
 * - the idle window is extended while an internal tool call is pending/running,
 *   so a tool-using turn is not cut short,
 * - `message.updated` with `error` resolves immediately with that error,
 * - `finish === 'stop'` resolves only when no tool call is still active,
 * - baseline message/part ids from a reused session are ignored,
 * - `signal` aborts resolve `{clientClosed: true}` instead of running to timeout,
 * - the overall timeout rejects `Request timeout after <n>ms`.
 *
 * @param {object} options Collection options.
 * @param {any} options.client SDK client (or a fake with `event.subscribe`).
 * @param {string} options.sessionId Runtime session id.
 * @param {number} [options.timeoutMs] Overall turn timeout.
 * @param {((delta: string, isReasoning: boolean) => void)|null} [options.onDelta] Delta sink.
 * @param {number} [options.firstDeltaTimeoutMs] First-delta window.
 * @param {number} [options.idleTimeoutMs] Idle window.
 * @param {TurnBaseline|null} [options.baseline] Pre-turn id snapshot.
 * @param {AbortSignal|null} [options.signal] Caller-owned abort signal.
 * @param {object|Function|null} [options.logger] Logger dependency.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @returns {Promise<CollectResult>} Collected answer or the reason collection stopped.
 */
export async function collectFromEvents({
    client,
    sessionId,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onDelta = null,
    firstDeltaTimeoutMs = DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
    baseline = null,
    signal: externalSignal = null,
    logger = null,
    now = Date.now
}) {
    const log = resolveLogger(logger, 'upstreams/runtime');
    const controller = new AbortController();
    const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
    const eventStream = eventStreamResult?.stream;
    if (!eventStream) throw new Error('OpenCode event stream unavailable');
    // A reused session holds the previous turns' parts. Any event for one of
    // them belongs to an earlier answer, so it must not feed this turn.
    /**
     * @param {string|{id?: string}} partOrId Part id or part.
     * @returns {boolean} True when the id predates the turn.
     */
    const isStaleEvent = (partOrId) => {
        if (!baseline?.partIds?.size) return false;
        const id = typeof partOrId === 'string' ? partOrId : partOrId?.id;
        return Boolean(id && baseline.partIds.has(id));
    };
    /**
     * @param {any} info Message info.
     * @returns {boolean} True when the message predates the turn.
     */
    const isStaleMessage = (info) =>
        Boolean(baseline?.messageIds?.size && info?.id && baseline.messageIds.has(info.id));
    let finished = false;
    let content = '';
    let reasoning = '';
    let receivedDelta = false;
    let deltaChars = 0;
    /** @type {number|null} */
    let firstDeltaAt = null;
    // Tracks internal OpenCode tool calls that are still pending/running. While any
    // tool call is active, the stream must stay open even if no text deltas arrive
    // (the backend is executing the tool). Resolving early here is what previously
    // truncated streaming responses that relied on internal tool execution.
    const activeToolCallIds = new Set();
    const startedAt = now();

    const finishPromise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (finished) return;
            finished = true;
            controller.abort();
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const firstDeltaTimer = firstDeltaTimeoutMs
            ? setTimeout(() => {
                  if (finished || receivedDelta) return;
                  finished = true;
                  controller.abort();
                  log.debug('No event data received', { sessionId, ms: now() - startedAt });
                  resolve({ content: '', reasoning: '', noData: true });
              }, firstDeltaTimeoutMs)
            : null;

        /** @type {ReturnType<typeof setTimeout>|null} */
        let idleTimer = null;
        const scheduleIdleTimer = () => {
            if (!idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (finished) return;
                // A tool call is still executing on the backend. Keep the stream open
                // and wait instead of cutting the response short; the follow-up text
                // (or the final completion) will arrive once the tool finishes.
                if (activeToolCallIds.size > 0) {
                    log.debug('Event idle while internal tool call is active, continuing to wait', {
                        sessionId,
                        ms: now() - startedAt,
                        activeTools: activeToolCallIds.size
                    });
                    scheduleIdleTimer();
                    return;
                }
                finished = true;
                controller.abort();
                log.debug('Event idle timeout', {
                    sessionId,
                    ms: now() - startedAt,
                    deltaChars
                });
                resolve({
                    content,
                    reasoning,
                    idleTimeout: true,
                    receivedDelta
                });
            }, idleTimeoutMs);
        };

        /** @param {any} part Message part. */
        const trackToolActivity = (part) => {
            if (!part || part.type !== 'tool') return;
            const status = part.state?.status;
            if (status === 'pending' || status === 'running') {
                if (part.id) activeToolCallIds.add(part.id);
            } else if (status === 'completed' || status === 'error') {
                if (part.id) activeToolCallIds.delete(part.id);
            }
            // Tool activity means the session is still working; treat it as progress
            // so the idle timer does not terminate the stream mid-execution.
            receivedDelta = true;
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
            scheduleIdleTimer();
        };

        // Newer OpenCode servers stream deltas as `message.part.delta` events that
        // carry only a `partID` (no `part.type`). The part type is announced by the
        // preceding `message.part.updated` event, so we key partID -> type here and
        // resolve each delta against it. Without this, reasoning and answer text can
        // never be told apart and the answer is mis-routed (or dropped) entirely.
        const partTypeById = new Map();
        /** @param {any} part Message part. */
        const rememberPartType = (part) => {
            if (part && part.id && typeof part.type === 'string') {
                partTypeById.set(part.id, part.type);
            }
        };
        /**
         * @param {string} partType `text` or `reasoning`.
         * @param {string} delta Streamed text.
         */
        const applyTextDelta = (partType, delta) => {
            receivedDelta = true;
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
            scheduleIdleTimer();
            if (!firstDeltaAt) {
                firstDeltaAt = now();
                log.debug('SSE first delta', {
                    sessionId,
                    ms: firstDeltaAt - startedAt,
                    type: partType
                });
            }
            if (partType === 'reasoning') {
                reasoning += delta;
                if (onDelta) onDelta(delta, true);
            } else {
                content += delta;
                if (onDelta) onDelta(delta, false);
            }
            deltaChars += delta.length;
        };

        // A client that walks away must not keep the turn (and its session lock)
        // alive until the idle or request timeout fires.
        if (externalSignal) {
            const onExternalAbort = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutId);
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                if (idleTimer) clearTimeout(idleTimer);
                controller.abort();
                log.debug('Client closed the stream, ending collection', { sessionId });
                resolve({ content, reasoning, clientClosed: true });
            };
            if (externalSignal.aborted) onExternalAbort();
            else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        (async () => {
            try {
                for await (const event of eventStream) {
                    if (
                        event.type === 'message.part.updated' &&
                        event.properties.part?.sessionID === sessionId
                    ) {
                        const { part, delta } = event.properties;
                        if (isStaleEvent(part)) continue;
                        rememberPartType(part);
                        trackToolActivity(part);
                        // Older OpenCode servers carried the streaming delta directly on
                        // message.part.updated; newer servers emit message.part.delta.
                        if (delta) applyTextDelta(part.type, delta);
                        continue;
                    }
                    if (event.type === 'message.part.delta' && event.properties?.sessionID === sessionId) {
                        const { partID, delta, field } = event.properties;
                        if (isStaleEvent(partID)) continue;
                        // Text and reasoning deltas both stream through field === 'text'.
                        // Tool-input deltas surface via message.part.updated tool state.
                        if (typeof delta === 'string' && field === 'text') {
                            const partType = partTypeById.get(partID);
                            if (partType === 'reasoning' || partType === 'text') {
                                applyTextDelta(partType, delta);
                            }
                        }
                        continue;
                    }
                    if (event.type === 'message.updated' && event.properties.info?.sessionID === sessionId) {
                        const info = event.properties.info;
                        if (isStaleMessage(info)) continue;
                        const finish = info.finish;
                        // An aborted or failed message never produces another delta. Without
                        // this, the collector waits out the whole first-delta window before
                        // polling rediscovers the same error.
                        if (info.error && !finished) {
                            finished = true;
                            clearTimeout(timeoutId);
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            if (idleTimer) clearTimeout(idleTimer);
                            log.debug('SSE upstream message error', {
                                sessionId,
                                ms: now() - startedAt,
                                error: info.error.name || 'UnknownError'
                            });
                            resolve({ content, reasoning, error: info.error });
                            break;
                        }
                        // Reconcile active tool calls from the full message snapshot so we
                        // detect pending tools even when only message.updated fires.
                        if (Array.isArray(info.parts)) {
                            for (const part of info.parts) {
                                rememberPartType(part);
                                if (part && part.type === 'tool') {
                                    const status = part.state?.status;
                                    if (status === 'pending' || status === 'running') {
                                        if (part.id) activeToolCallIds.add(part.id);
                                    } else if (status === 'completed' || status === 'error') {
                                        if (part.id) activeToolCallIds.delete(part.id);
                                    }
                                }
                            }
                        }
                        if (finish === 'tool') {
                            // Assistant turn ended pending a tool call; keep waiting for the result.
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            scheduleIdleTimer();
                            continue;
                        }
                        if (finish === 'stop') {
                            // Only treat the stream as completed when no tool call is still
                            // pending. OpenCode may emit an intermediate 'stop' snapshot while a
                            // tool call is in flight; resolving on it would drop the final answer.
                            if (activeToolCallIds.size > 0) {
                                log.debug('Ignoring intermediate stop while tools are active', {
                                    sessionId,
                                    activeTools: activeToolCallIds.size
                                });
                                continue;
                            }
                            if (!finished) {
                                finished = true;
                                clearTimeout(timeoutId);
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                if (idleTimer) clearTimeout(idleTimer);
                                log.debug('SSE completed', {
                                    sessionId,
                                    ms: now() - startedAt,
                                    deltaChars
                                });
                                resolve({ content, reasoning });
                            }
                            break;
                        }
                    }
                }
            } catch (e) {
                if (!finished) {
                    finished = true;
                    clearTimeout(timeoutId);
                    if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                    if (idleTimer) clearTimeout(idleTimer);
                    reject(e);
                }
            }
        })();
    });

    try {
        return await finishPromise;
    } finally {
        controller.abort();
    }
}

/**
 * @typedef {object} RuntimeUpstream
 * @property {() => Promise<boolean>} ensureReady Health-check the runtime (cached).
 * @property {(toolControl?: {title?: string}) => Promise<string>} createSession Create a session.
 * @property {(id: string) => Promise<object[]>} messages Read a session's messages.
 * @property {(id: string) => Promise<void>} deleteSession Best-effort session delete.
 * @property {(signal?: AbortSignal) => Promise<AsyncIterable<object>>} subscribe Event stream.
 * @property {() => Promise<object[]>} listModels Runtime provider catalog.
 * @property {(params: object, options?: object) => Promise<* >} prompt One SDK prompt call.
 * @property {(options: object) => Promise<PollResult>} pollForAssistantResponse Poll for the answer.
 * @property {(options: object) => Promise<CollectResult>} collectFromEvents Collect from the event stream.
 * @property {object} client The underlying SDK client.
 */

/**
 * Create the runtime upstream.
 *
 * `sdk` may be either a ready SDK client (anything with `session`/`event`) or an
 * SDK module exposing `createOpencodeClient`, in which case one is built from
 * `config.OPENCODE_SERVER_URL` / `config.OPENCODE_SERVER_PASSWORD`.
 *
 * @param {object} options Factory options.
 * @param {Record<string, any>} [options.config] Config with environment-style keys
 *   (`OPENCODE_SERVER_URL`, `OPENCODE_SERVER_PASSWORD`, `REQUEST_TIMEOUT_MS`,
 *   `EVENT_FIRST_DELTA_TIMEOUT_MS`, `EVENT_IDLE_TIMEOUT_MS`, `RUNTIME_READY_TTL_MS`).
 * @param {any} [options.logger] Logger dependency.
 * @param {any} [options.sdk] SDK client or SDK module.
 * @param {typeof fetch} [options.fetch] Fetch implementation for the health check.
 * @returns {RuntimeUpstream} The runtime upstream.
 */
export function createRuntimeUpstream(
    { config = {}, logger = null, sdk = null, fetch: fetchImpl = globalThis.fetch } = /** @type {any} */ ({})
) {
    const log = resolveLogger(logger, 'upstreams/runtime');
    const baseUrl = String(config.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096');
    const password = String(config.OPENCODE_SERVER_PASSWORD || '');
    const requestTimeoutMs = toMillis(config.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
    const firstDeltaTimeoutMs = toMillis(
        config.EVENT_FIRST_DELTA_TIMEOUT_MS,
        DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS
    );
    const idleTimeoutMs = toMillis(config.EVENT_IDLE_TIMEOUT_MS, DEFAULT_EVENT_IDLE_TIMEOUT_MS);
    const readinessTtlMs = toMillis(config.RUNTIME_READY_TTL_MS, 5000);

    /**
     * Accept either an SDK client or the SDK module itself.
     *
     * @returns {any} SDK client.
     */
    const resolveClient = () => {
        if (sdk && typeof sdk === 'object' && sdk.session) return sdk;
        if (sdk && typeof sdk.createOpencodeClient === 'function') {
            const headers = password
                ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
                : undefined;
            return sdk.createOpencodeClient({ baseUrl, headers });
        }
        throw new Error('createRuntimeUpstream requires an SDK client or an SDK module');
    };
    const client = resolveClient();

    let readyAt = 0;
    let ready = false;

    return {
        client,

        /**
         * Verify the runtime answers on `/global/health`, caching success for a
         * few seconds so a burst of turns does not hammer it.
         *
         * @returns {Promise<boolean>} True when healthy.
         * @throws {Error} When the health endpoint is missing, unhealthy or unreachable.
         */
        async ensureReady() {
            if (ready && Date.now() - readyAt < readinessTtlMs) return true;
            if (typeof fetchImpl !== 'function')
                throw new Error('No fetch implementation available for the runtime health check');
            let response;
            try {
                response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/global/health`);
            } catch (error) {
                ready = false;
                throw new Error(
                    `OpenCode runtime unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
            if (!response.ok) {
                ready = false;
                throw new Error(`OpenCode runtime unhealthy at ${baseUrl} (status ${response.status})`);
            }
            const payload = /** @type {{healthy?: boolean}|null} */ (await response.json().catch(() => null));
            if (!payload?.healthy) {
                ready = false;
                throw new Error(`OpenCode runtime unhealthy at ${baseUrl}`);
            }
            ready = true;
            readyAt = Date.now();
            return true;
        },

        /**
         * @param {{title?: string}} [toolControl] Tool policy carrier.
         * @returns {Promise<string>} Created session id.
         */
        async createSession(toolControl) {
            const sessionRes = await client.session.create(
                toolControl?.title ? { body: { title: toolControl.title } } : undefined
            );
            const sessionId = sessionRes?.data?.id;
            if (!sessionId) throw new Error('Failed to create OpenCode session');
            return sessionId;
        },

        /**
         * @param {string} id Session id.
         * @returns {Promise<object[]>} Message entries.
         */
        async messages(id) {
            const res = await client.session.messages({ path: { id } });
            const messages = res?.data || res || [];
            return Array.isArray(messages) ? messages : [];
        },

        /**
         * Delete a session, ignoring failures: the conversation is being dropped
         * either way and a missing session is not an error.
         *
         * @param {string} id Session id.
         * @returns {Promise<void>} Resolves once the delete was attempted.
         */
        async deleteSession(id) {
            if (!id) return;
            try {
                await client.session.delete({ path: { id } });
            } catch (error) {
                log.debug('Failed to delete OpenCode session', {
                    id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        },

        /**
         * @param {AbortSignal} [signal] Abort signal for the subscription.
         * @returns {Promise<AsyncIterable<object>>} Event stream.
         */
        async subscribe(signal) {
            const result = await client.event.subscribe(signal ? { signal } : undefined);
            if (!result?.stream) throw new Error('OpenCode event stream unavailable');
            return result.stream;
        },

        /** @returns {Promise<object[]>} Models from the runtime provider catalog. */
        async listModels() {
            const providersRes = await client.config.providers();
            const providersRaw = providersRes?.data?.providers || [];
            const providersList = Array.isArray(providersRaw)
                ? providersRaw
                : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
            return buildModelsList(providersList);
        },

        /**
         * @param {any} params Raw `session.prompt` arguments.
         * @param {{timeoutMs?: number, signal?: AbortSignal|null}} [options] Timeout/abort.
         * @returns {Promise<*>} SDK prompt result.
         */
        prompt(params, options) {
            const { timeoutMs = requestTimeoutMs, signal = null } = options || {};
            return promptWithTimeout({ client, params, timeoutMs, signal, logger: log });
        },

        /**
         * @param {any} [options] As {@link pollForAssistantResponse}, minus `client`.
         * @returns {Promise<PollResult>} Poll result.
         */
        pollForAssistantResponse(options) {
            const { timeoutMs = requestTimeoutMs, ...rest } = options || {};
            return pollForAssistantResponse(/** @type {any} */ ({ client, logger: log, timeoutMs, ...rest }));
        },

        /**
         * @param {any} [options] As {@link collectFromEvents}, minus `client`.
         * @returns {Promise<CollectResult>} Collection result.
         */
        collectFromEvents(options) {
            const { timeoutMs = requestTimeoutMs, ...rest } = options || {};
            return collectFromEvents(
                /** @type {any} */ ({
                    client,
                    logger: log,
                    timeoutMs,
                    firstDeltaTimeoutMs,
                    idleTimeoutMs,
                    ...rest
                })
            );
        }
    };
}
