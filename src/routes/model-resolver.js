/**
 * Model catalog discovery and client model-name resolution.
 *
 * Runtime catalog entries take precedence; when the runtime catalog is
 * unavailable the direct upstream catalog is used. The resolver preserves the
 * gateway's legacy aliases and 404 error shape.
 *
 * @module routes/model-resolver
 */

/**
 * Spell gpt/o-series ids the way the backend catalog does.
 *
 * @param {string|undefined} modelID Model id as requested.
 * @returns {string|undefined} Normalized id.
 */
export function normalizeModelID(modelID) {
    if (!modelID || typeof modelID !== 'string') return modelID;
    return modelID.replace(/^gpt(\d)/i, 'gpt-$1').replace(/^o(\d)/i, 'o$1');
}

/**
 * @param {object} options Resolver dependencies.
 * @param {{listModels: () => Promise<Array<any>>}} options.runtime Runtime upstream.
 * @param {{listModels: () => Promise<Array<any>>}} options.direct Direct upstream.
 * @param {(message: string, details?: Record<string, unknown>) => void} [options.logDebug] Debug logger.
 * @returns {{
 *   listModels: () => Promise<Array<any>>,
 *   resolveRequestedModel: (requestedModel?: string) => Promise<{
 *     providerID: string,
 *     modelID: string,
 *     models: Array<any>,
 *     resolved: string,
 *     aliasFrom?: string
 *   }>
 * }}
 */
export function createModelResolver({ runtime, direct, logDebug = () => {} }) {
    /** Runtime catalog first, upstream catalogs second, empty third. */
    const listModels = async () => {
        try {
            const models = await runtime.listModels();
            if (Array.isArray(models) && models.length) return models;
        } catch (error) {
            logDebug('Runtime model list unavailable', {
                error: error instanceof Error ? error.message : String(error)
            });
        }

        const upstreamModels = await direct.listModels().catch(() => null);
        return Array.isArray(upstreamModels) && upstreamModels.length ? upstreamModels : [];
    };

    /**
     * Resolve the client's model name to a provider/bare-id pair.
     *
     * @param {string} [requestedModel] Model as requested.
     * @returns {Promise<{
     *   providerID: string,
     *   modelID: string,
     *   models: Array<any>,
     *   resolved: string,
     *   aliasFrom?: string
     * }>}
     */
    const resolveRequestedModel = async (requestedModel) => {
        const models = await listModels();
        const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
        let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
        if (!modelID) {
            modelID = providerID;
            providerID = 'opencode';
        }

        const originalModelID = modelID;
        const normalizedModelID = normalizeModelID(modelID);
        const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];

        const exact = models.find((model) =>
            candidateModelIDs.some((candidate) => model.id === `${providerID}/${candidate}`)
        );
        if (exact) {
            const [, resolvedModelID] = exact.id.split('/');
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: exact.id,
                ...(resolvedModelID !== originalModelID && {
                    aliasFrom: `${providerID}/${originalModelID}`
                })
            };
        }

        const sameProvider = models.filter((model) => model.owned_by === providerID);
        const suffixMatch = sameProvider.find((model) =>
            candidateModelIDs.some(
                (candidate) => model.id.endsWith(`/${candidate}-free`) || model.id.endsWith(`/${candidate}`)
            )
        );
        if (suffixMatch) {
            const [, resolvedModelID] = suffixMatch.id.split('/');
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: suffixMatch.id,
                aliasFrom: `${providerID}/${originalModelID}`
            };
        }

        /** @type {Error & {statusCode?: number, code?: string, availableModels?: string[]}} */
        const error = new Error(`Model not found: ${providerID}/${modelID}`);
        error.statusCode = 404;
        error.code = 'model_not_found';
        error.availableModels = models.map((model) => model.id);
        throw error;
    };

    return { listModels, resolveRequestedModel };
}
