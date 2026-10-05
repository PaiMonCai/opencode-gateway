import http from 'node:http';

import { afterEach, describe, expect, test } from '@jest/globals';

import { getImageDataUri } from '../../../src/http/image-data.js';

const servers = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise((resolve) => {
                    server.close(resolve);
                })
        )
    );
});

const listen = (handler) =>
    new Promise((resolve) => {
        const server = http.createServer(handler);
        servers.push(server);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: address.port });
        });
    });

describe('getImageDataUri', () => {
    test('passes through existing data URIs', async () => {
        await expect(getImageDataUri('data:image/png;base64,AAAA')).resolves.toBe(
            'data:image/png;base64,AAAA'
        );
    });

    test('rejects unsupported URL schemes', async () => {
        await expect(getImageDataUri('file:///tmp/example.png')).rejects.toThrow('Invalid URL scheme');
    });

    test('downloads an HTTP image and encodes it', async () => {
        const { port } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(Buffer.from([0, 1, 2, 3]));
        });

        await expect(getImageDataUri(`http://127.0.0.1:${port}/image.png`)).resolves.toBe(
            'data:image/png;base64,AAECAw=='
        );
    });

    test('rejects non-200 image responses', async () => {
        const { port } = await listen((_req, res) => {
            res.writeHead(404);
            res.end('missing');
        });

        await expect(getImageDataUri(`http://127.0.0.1:${port}/missing.png`)).rejects.toThrow(
            'Failed to fetch image: HTTP 404'
        );
    });
});
