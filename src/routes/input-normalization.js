/**
 * Shared normalization for OpenAI-compatible chat/responses inputs.
 *
 * These helpers are intentionally boring so the surface-specific builders cannot
 * drift apart in how they coerce client content.
 *
 * @module routes/input-normalization
 */

/**
 * Flatten any content shape a client may send into plain text.
 *
 * @param {unknown} content Message content.
 * @returns {string} Text content.
 */
export function normalizeTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
                    return part?.text || '';
                }
                return '';
            })
            .join('');
    }
    if (content && typeof (/** @type {{text?: unknown}} */ (content).text) === 'string') {
        return /** @type {{text: string}} */ (content).text;
    }
    if (content === null || content === undefined) return '';
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    return '';
}

/**
 * Normalize tool arguments to JSON text.
 *
 * @param {unknown} args Tool arguments as emitted by the model/client.
 * @returns {string} JSON text.
 */
export function normalizeToolArguments(args) {
    if (typeof args === 'string') return args;
    if (args === undefined) return '{}';
    try {
        return JSON.stringify(args);
    } catch {
        return '{}';
    }
}

/**
 * Normalize tool-result content.
 *
 * @param {unknown} content Tool result content.
 * @returns {string} Text content.
 */
export function normalizeToolResultContent(content) {
    const text = normalizeTextContent(content);
    if (text) return text;
    if (content === null || content === undefined) return '';
    if (typeof content === 'object') {
        try {
            return JSON.stringify(content);
        } catch {
            return '';
        }
    }
    return String(content);
}
