/**
 * Authoritative per-turn token usage from OpenCode Runtime message snapshots.
 *
 * Runtime message tokens are exclusive counters:
 *   input = uncached input; cache.read/write are separate; output excludes reasoning.
 * OpenAI-compatible usage includes cache tokens in prompt/input totals and reasoning
 * in completion/output totals. Never guess that an unreported cache is zero.
 */

/** @param {unknown} value */
const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Aggregate the final assistant messages generated since the pre-turn baseline.
 * Message ids are unique; repeated snapshots of the same id count only once.
 *
 * @param {unknown} messages Complete runtime session message list.
 * @param {{messageIds?: Set<string>}|null} [baseline]
 * @returns {{input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number, cacheReported: boolean}|null}
 */
export function aggregateRuntimeTokens(messages, baseline = null) {
    if (!Array.isArray(messages)) return null;
    const byId = new Map();
    for (let index = 0; index < messages.length; index++) {
        const info = messages[index]?.info;
        if (info?.role !== 'assistant') continue;
        if (info.id && baseline?.messageIds?.has(info.id)) continue;
        const tokens = info.tokens;
        if (!tokens || ![tokens.input, tokens.output, tokens.reasoning].some(valid)) continue;
        // Last occurrence wins if a backend returns several snapshots of one message.
        byId.set(info.id || 'index:' + index, tokens);
    }
    if (!byId.size) return null;

    const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheReported: true };
    for (const tokens of byId.values()) {
        sum.input += valid(tokens.input) ? tokens.input : 0;
        sum.output += valid(tokens.output) ? tokens.output : 0;
        sum.reasoning += valid(tokens.reasoning) ? tokens.reasoning : 0;
        if (valid(tokens.cache?.read)) sum.cacheRead += tokens.cache.read;
        else sum.cacheReported = false;
        if (valid(tokens.cache?.write)) sum.cacheWrite += tokens.cache.write;
        else sum.cacheReported = false;
    }
    return sum;
}

/**
 * Translate exclusive OpenCode counters to OpenAI wire usage. For fallback
 * estimates, omit cache fields rather than silently reporting cache misses.
 *
 * @param {{input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number, cacheReported: boolean}|null} tokens
 * @param {'chat'|'responses'} protocol
 * @param {{promptTokens: number, completionTokens: number, reasoningTokens: number}} estimate
 * @returns {Record<string, any>}
 */
export function formatRuntimeUsage(tokens, protocol, estimate) {
    const prompt = tokens
        ? tokens.input + tokens.cacheRead + tokens.cacheWrite
        : Math.max(0, estimate.promptTokens);
    const reasoning = tokens ? tokens.reasoning : Math.max(0, estimate.reasoningTokens);
    const completion = tokens
        ? tokens.output + tokens.reasoning
        : Math.max(0, estimate.completionTokens) + reasoning;
    if (protocol === 'responses') {
        return {
            input_tokens: prompt,
            output_tokens: completion,
            total_tokens: prompt + completion,
            ...(tokens?.cacheReported
                ? {
                      input_tokens_details: {
                          cached_tokens: tokens.cacheRead,
                          ...(tokens.cacheWrite > 0 ? { cache_creation_tokens: tokens.cacheWrite } : {})
                      }
                  }
                : {}),
            output_tokens_details: { reasoning_tokens: reasoning }
        };
    }
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        ...(tokens?.cacheReported
            ? {
                  prompt_tokens_details: {
                      cached_tokens: tokens.cacheRead,
                      ...(tokens.cacheWrite > 0 ? { cache_creation_tokens: tokens.cacheWrite } : {})
                  }
              }
            : {}),
        completion_tokens_details: { reasoning_tokens: reasoning }
    };
}

/**
 * Read the final Runtime message snapshot after the turn finishes. A failure to
 * read usage must not turn a successful model response into a failed request.
 *
 * @param {object} params
 * @param {any} params.client OpenCode SDK client.
 * @param {string} params.sessionId
 * @param {{messageIds?: Set<string>}|null} [params.baseline]
 * @param {'chat'|'responses'} params.protocol
 * @param {{promptTokens: number, completionTokens: number, reasoningTokens: number}} params.estimate
 * @param {(message: string, detail?: unknown) => void} [params.logDebug]
 */
export async function readRuntimeUsage({ client, sessionId, baseline = null, protocol, estimate, logDebug }) {
    try {
        const response = await client.session.messages({ path: { id: sessionId } });
        const messages = response?.data ?? response;
        const tokens = aggregateRuntimeTokens(messages, baseline);
        if (tokens) return formatRuntimeUsage(tokens, protocol, estimate);
        logDebug?.('Runtime usage unavailable; returning estimated tokens without cache attribution');
    } catch (error) {
        logDebug?.(
            'Runtime usage snapshot failed; returning estimated tokens without cache attribution',
            error instanceof Error ? error.message : String(error)
        );
    }
    return formatRuntimeUsage(null, protocol, estimate);
}
