import { describe, expect, test } from '@jest/globals';
import { transcodeSse } from '../../../src/protocol/stream.js';

const stream = (...parts) =>
    (async function* () {
        for (const part of parts) yield Buffer.from(part);
    })();

const chunk = (value) => 'data: ' + JSON.stringify(value) + '\n\n';

async function records(...parts) {
    let output = '';
    for await (const part of transcodeSse(
        stream(...parts),
        'chat',
        'responses',
        'opencode-go/step-5-preview-free'
    ))
        output += part.toString();
    return output
        .split('\n\n')
        .filter(Boolean)
        .map((record) =>
            JSON.parse(
                record
                    .split('\n')
                    .find((line) => line.startsWith('data:'))
                    .slice(5)
            )
        );
}

const toolDelta = (index, call, name, args) =>
    chunk({
        id: 'upstream',
        choices: [
            {
                index: 0,
                delta: {
                    tool_calls: [
                        {
                            index,
                            ...(call && { id: call }),
                            ...(name && { function: { name, arguments: args } }),
                            ...(!name && args !== undefined && { function: { arguments: args } })
                        }
                    ]
                },
                finish_reason: null
            }
        ]
    });

describe('DSH/pi-ai Responses function-call lifecycle', () => {
    test('bash tool finishes arguments AND output item before response.completed', async () => {
        const args = '{"command":"git clone https://github.com/ANRCM0/TunexPay.git"}';
        const events = await records(
            toolDelta(0, 'call_abc', 'bash', args.slice(0, 16)),
            toolDelta(0, null, null, args.slice(16)),
            chunk({ id: 'upstream', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]\n\n'
        );

        const added = events.find(
            (e) => e.type === 'response.output_item.added' && e.item.type === 'function_call'
        );
        const argDelta = events.find((e) => e.type === 'response.function_call_arguments.delta');
        const argDone = events.find((e) => e.type === 'response.function_call_arguments.done');
        const itemDone = events.find((e) => e.type === 'response.output_item.done');
        const completed = events.find((e) => e.type === 'response.completed');
        expect(added.item).toMatchObject({
            type: 'function_call',
            call_id: 'call_abc',
            name: 'bash',
            status: 'in_progress'
        });
        expect(argDelta.item_id).toBe(added.item.id);
        expect(argDone).toMatchObject({
            item_id: added.item.id,
            output_index: added.output_index,
            arguments: args
        });
        expect(itemDone).toMatchObject({
            output_index: added.output_index,
            item: {
                id: added.item.id,
                call_id: 'call_abc',
                name: 'bash',
                arguments: args,
                status: 'completed'
            }
        });
        expect(completed.response.output).toContainEqual(itemDone.item);
        expect(completed.response.status).toBe('completed');
        const idx = (type) => events.findIndex((e) => e.type === type);
        expect(idx('response.output_item.added')).toBeLessThan(idx('response.function_call_arguments.done'));
        expect(idx('response.function_call_arguments.done')).toBeLessThan(idx('response.output_item.done'));
        expect(idx('response.output_item.done')).toBeLessThan(idx('response.completed'));
        expect(events.filter((e) => e.type === 'response.output_item.done')).toHaveLength(1);
    });

    test('interleaved tools retain independent call IDs, output indexes and arguments', async () => {
        const events = await records(
            toolDelta(0, 'call_a', 'bash', '{"command":'),
            toolDelta(1, 'call_b', 'read_file', '{"path":"'),
            toolDelta(0, null, null, '"ls"}'),
            toolDelta(1, null, null, 'a.txt"}'),
            chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]\n\n'
        );
        const added = events.filter((e) => e.type === 'response.output_item.added');
        const done = events.filter((e) => e.type === 'response.output_item.done');
        const completed = events.find((e) => e.type === 'response.completed');
        expect(added).toHaveLength(2);
        expect(done).toHaveLength(2);
        expect(done.map((e) => e.item.call_id)).toEqual(['call_a', 'call_b']);
        expect(done.map((e) => e.item.arguments)).toEqual(['{"command":"ls"}', '{"path":"a.txt"}']);
        expect(completed.response.output).toEqual(done.map((e) => e.item));
        for (let index = 0; index < 2; index++) {
            expect(done[index].item.id).toBe(added[index].item.id);
            expect(done[index].output_index).toBe(added[index].output_index);
        }
    });

    test('text and function call both complete with matching output IDs', async () => {
        const events = await records(
            chunk({ choices: [{ delta: { content: 'Running...' }, finish_reason: null }] }),
            toolDelta(0, 'call_bash', 'bash', '{}'),
            chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]\n\n'
        );
        expect(events.some((e) => e.type === 'response.content_part.added')).toBe(true);
        expect(events.some((e) => e.type === 'response.content_part.done')).toBe(true);
        const done = events.filter((e) => e.type === 'response.output_item.done');
        const completed = events.find((e) => e.type === 'response.completed');
        expect(done.map((e) => e.item.type)).toEqual(['message', 'function_call']);
        expect(completed.response.output).toEqual(done.map((e) => e.item));
    });

    test('malformed or truncated tool JSON must not announce success', async () => {
        await expect(
            records(toolDelta(0, 'call_bad', 'bash', '{"command":'), 'data: [DONE]\n\n')
        ).rejects.toThrow(/incomplete or invalid JSON/);
    });

    test('length-limited text is marked incomplete rather than completed', async () => {
        const events = await records(
            chunk({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
            'data: [DONE]\n\n'
        );
        expect(events.some((e) => e.type === 'response.completed')).toBe(false);
        expect(events.at(-1)).toMatchObject({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
        });
    });

    test('upstream crash after tool start never produces a completed item', async () => {
        await expect(records(toolDelta(0, 'call_a', 'bash', '{"command":"ls"}'))).rejects.toThrow(
            /without success/
        );
    });
});
