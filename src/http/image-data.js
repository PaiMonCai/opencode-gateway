/**
 * Remote image loading for OpenAI-compatible multimodal inputs.
 *
 * @module http/image-data
 */

import http from 'node:http';
import https from 'node:https';

/**
 * Read an image and inline it as a `data:` URI.
 *
 * @param {string} url Absolute `http(s)` URL or an already-inlined `data:` URI.
 * @param {number} [timeoutMs] Network timeout.
 * @returns {Promise<string>} The `data:` URI.
 */
export async function getImageDataUri(url, timeoutMs = 10000) {
    if (url.startsWith('data:')) return url;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid URL scheme: ${url}`);
    }

    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
                return;
            }

            const contentType = res.headers['content-type'] || 'image/jpeg';
            /** @type {Buffer[]} */
            const chunks = [];

            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    resolve(`data:${contentType};base64,${buffer.toString('base64')}`);
                } catch (error) {
                    reject(
                        new Error(
                            `Failed to encode image: ${error instanceof Error ? error.message : String(error)}`
                        )
                    );
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image fetch timeout'));
        });
    });
}
