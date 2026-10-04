import http from 'node:http';

/**
 * Start a stub upstream on an ephemeral port and record every request it sees.
 *
 * The upstream layer is tested against this instead of the network: the tests
 * assert the exact outbound request (path, headers, body) and script the exact
 * response, including SSE and error bodies.
 *
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, entry: object) => void|Promise<void>} handler
 *   Per-request responder.
 * @returns {Promise<{requests: object[], baseUrl: string, close: () => Promise<void>}>}
 *   Stub handle. `requests[i]` has `{method, url, headers, bodyText, body}`.
 */
export async function startStub(handler) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const entry = { method: req.method, url: req.url, headers: req.headers, bodyText };
        try {
            entry.body = bodyText ? JSON.parse(bodyText) : null;
        } catch {
            entry.body = null;
        }
        requests.push(entry);
        await handler(req, res, entry);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

/**
 * Read an async byte/string iterable into one UTF-8 string.
 *
 * @param {AsyncIterable<Uint8Array|string>} iterable Stream.
 * @returns {Promise<string>} Collected text.
 */
export async function collectText(iterable) {
    let out = '';
    for await (const chunk of iterable) out += Buffer.from(chunk).toString('utf8');
    return out;
}

/**
 * Give pending timers/microtasks a chance to run.
 *
 * @param {number} [ms] Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
export const delay = (ms = 0) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
