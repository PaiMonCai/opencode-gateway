import { describe, expect, test } from '@jest/globals';
import { transcodeSse } from '../../../src/protocol/stream.js';

const sse = (data) => 'data: ' + JSON.stringify(data) + '\\n\\n';
const done = 'data: [DONE]\\n\\n';

async function transcode(source, target, chunks) {
    const input = (async function* () {
        for (const chunk of chunks) yield Buffer.from(chunk.replaceAll('\\n', '\n'));
    })();
    let text = '';
    for await (const bytes of transcodeSse(input, source, target, 'opencode-go/step-5-preview-free'))
        text += Buffer.from(bytes).toString('utf8');
    return text
        .split('\\n\\n'.replaceAll('\\n', '\n'))
        .filter(Boolean)
        .filter((record) => record.split('\n').some((line) => line.startsWith('data: {')))
        .map((record) =>
            JSON.parse(
                record
                    .split('\n')
                    .find((line) => line.startsWith('data: '))
                    .slice(6)
            )
        );
}

describe('direct cross-protocol streaming usage', () => {
    test('Chat → Responses maps all cache, token and reasoning counters', async () => {
        const events = await transcode('chat', 'responses', [
            sse({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }),
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: {
                    prompt_tokens: 8023,
                    completion_tokens: 64,
                    total_tokens: 8087,
                    prompt_tokens_details: {
                        audio_tokens: 0,
                        cached_tokens: 8000,
                        cache_write_tokens: 4
                    },
                    completion_tokens_details: { reasoning_tokens: 61, audio_tokens: 0 }
                }
            }),
            done
        ]);
        const response = events.find((e) => e.type === 'response.completed').response;
        expect(response.usage).toEqual({
            input_tokens: 8023,
            output_tokens: 64,
            total_tokens: 8087,
            input_tokens_details: {
                audio_tokens: 0,
                cached_tokens: 8000,
                cache_write_tokens: 4
            },
            output_tokens_details: { reasoning_tokens: 61, audio_tokens: 0 }
        });
        expect(response.usage.prompt_tokens).toBeUndefined();
        expect(response.usage.prompt_tokens_details).toBeUndefined();
    });

    test('Responses → Chat maps cache tokens and output details into Chat usage', async () => {
        const events = await transcode('responses', 'chat', [
            sse({
                type: 'response.completed',
                response: {
                    id: 'resp_upstream',
                    model: 'step-5-preview-free',
                    usage: {
                        input_tokens: 8024,
                        output_tokens: 32,
                        total_tokens: 8056,
                        input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 30 }
                    }
                }
            })
        ]);
        const usage = events.find((e) => e.usage)?.usage;
        expect(usage).toEqual({
            prompt_tokens: 8024,
            completion_tokens: 32,
            total_tokens: 8056,
            prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 30 }
        });
        expect(usage.input_tokens).toBeUndefined();
    });

    test('Chat → Responses keeps missing cache details absent and preserves incomplete status', async () => {
        const events = await transcode('chat', 'responses', [
            sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
            sse({ choices: [], usage: { prompt_tokens: 16, completion_tokens: 8 } }),
            done
        ]);
        const response = events.find((e) => e.type === 'response.incomplete').response;
        expect(response.usage).toEqual({
            input_tokens: 16,
            output_tokens: 8,
            total_tokens: 24
        });
        expect(response.usage.input_tokens_details).toBeUndefined();
    });
});
