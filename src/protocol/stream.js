/**
 * Incremental cross-protocol SSE transcoder.
 *
 * Parses complete SSE records across chunk boundaries and emits target-native
 * events immediately. Never buffers a full model answer. A failed upstream
 * stream never receives a success terminal event.
 */
import crypto from 'node:crypto';

const uid = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '');
const wire = (payload, event) =>
    (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(payload) + '\n\n';

async function* frames(source) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of source) {
        buffer += decoder.decode(bytes, { stream: true });
        let boundary = /(\r\n\r\n|\n\n|\r\r)/.exec(buffer);
        while (boundary) {
            const record = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = record
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            const event = record
                .split(/\r?\n/)
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim();
            if (data) yield { data, event };
            boundary = /(\r\n\r\n|\n\n|\r\r)/.exec(buffer);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error('Truncated upstream SSE event');
}
function normalizeFrame(source, frame, state) {
    if (frame.data === '[DONE]') return [{ kind: 'done' }];
    let value;
    try {
        value = JSON.parse(frame.data);
    } catch {
        throw new Error('Malformed upstream SSE JSON');
    }
    if (value.type === 'error' || frame.event === 'error' || value.type === 'response.failed')
        return [{ kind: 'error', message: value.error?.message || value.message || 'Upstream stream error' }];
    const result = [];
    if (source === 'chat') {
        if (value.id) state.id = value.id;
        if (value.model) state.model = value.model;
        for (const choice of value.choices || []) {
            const d = choice.delta || {};
            if (typeof d.content === 'string' && d.content) result.push({ kind: 'text', value: d.content });
            if (typeof d.reasoning_content === 'string' && d.reasoning_content)
                result.push({ kind: 'reasoning', value: d.reasoning_content });
            for (const t of d.tool_calls || []) {
                const idx = t.index ?? 0;
                if (t.id || t.function?.name)
                    result.push({ kind: 'toolStart', idx, id: t.id, name: t.function?.name });
                if (t.function?.arguments)
                    result.push({ kind: 'toolDelta', idx, value: t.function.arguments });
            }
            if (choice.finish_reason) result.push({ kind: 'finish', reason: choice.finish_reason });
        }
        if (value.usage) result.push({ kind: 'usage', value: value.usage });
    } else if (source === 'responses') {
        const kind = value.type || frame.event;
        if (value.response?.id) state.id = value.response.id;
        if (value.response?.model) state.model = value.response.model;
        const item = value.item;
        if (kind === 'response.output_item.added' && item?.type === 'function_call') {
            const idx = value.output_index ?? 0;
            result.push({ kind: 'toolStart', idx, id: item.call_id || item.id, name: item.name });
        }
        if (kind === 'response.output_text.delta') result.push({ kind: 'text', value: value.delta || '' });
        if (kind === 'response.reasoning_summary_text.delta' || kind === 'response.reasoning_text.delta')
            result.push({ kind: 'reasoning', value: value.delta || '' });
        if (kind === 'response.function_call_arguments.delta')
            result.push({ kind: 'toolDelta', idx: value.output_index ?? 0, value: value.delta || '' });
        if (kind === 'response.completed' || kind === 'response.incomplete') {
            if (value.response?.usage) result.push({ kind: 'usage', value: value.response.usage });
            result.push({ kind: 'finish', reason: kind === 'response.incomplete' ? 'length' : 'stop' });
            result.push({ kind: 'done' });
        }
    } else if (source === 'messages') {
        const kind = value.type || frame.event;
        if (kind === 'message_start') {
            state.id = value.message?.id || state.id;
            state.model = value.message?.model || state.model;
        } else if (kind === 'content_block_start' && value.content_block?.type === 'tool_use') {
            result.push({
                kind: 'toolStart',
                idx: value.index ?? 0,
                id: value.content_block.id,
                name: value.content_block.name
            });
        } else if (kind === 'content_block_delta') {
            const d = value.delta || {};
            if (d.type === 'text_delta') result.push({ kind: 'text', value: d.text || '' });
            if (d.type === 'thinking_delta') result.push({ kind: 'reasoning', value: d.thinking || '' });
            if (d.type === 'input_json_delta')
                result.push({ kind: 'toolDelta', idx: value.index ?? 0, value: d.partial_json || '' });
        } else if (kind === 'message_delta') {
            if (value.delta?.stop_reason) result.push({ kind: 'finish', reason: value.delta.stop_reason });
            if (value.usage) result.push({ kind: 'usage', value: value.usage });
        } else if (kind === 'message_stop') result.push({ kind: 'done' });
    }
    return result;
}
function makeEmitter(target, clientModel, state) {
    const id = state;
    const tools = new Map();
    let started = false;
    let finished = false;
    let textIndex = null;
    let reasoningIndex = null;
    let blockIndex = -1;
    let blockKind = null;
    let finalReason = 'stop';
    let usage = null;
    let content = '';
    let hasTools = false;
    const messageId = uid('msg_');
    const responseId = uid('resp_');
    const ensureStart = () => {
        if (started) return [];
        started = true;
        if (target === 'chat')
            return [
                wire({
                    id: id.id || uid('chatcmpl_'),
                    object: 'chat.completion.chunk',
                    model: clientModel,
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
                })
            ];
        if (target === 'responses')
            return [
                wire(
                    {
                        type: 'response.created',
                        response: {
                            id: responseId,
                            object: 'response',
                            model: clientModel,
                            status: 'in_progress',
                            output: []
                        }
                    },
                    'response.created'
                )
            ];
        return [
            wire(
                {
                    type: 'message_start',
                    message: {
                        id: id.id || uid('msg_'),
                        type: 'message',
                        role: 'assistant',
                        model: clientModel,
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 }
                    }
                },
                'message_start'
            )
        ];
    };
    const chat = (delta, finishReason = null) =>
        wire({
            id: id.id || 'chatcmpl_stream',
            object: 'chat.completion.chunk',
            model: clientModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }]
        });
    const closeBlock = () => {
        if (target !== 'messages' || blockKind === null) return [];
        const frames = [wire({ type: 'content_block_stop', index: blockIndex }, 'content_block_stop')];
        blockKind = null;
        return frames;
    };
    const openBlock = (kind, meta = {}) => {
        if (target !== 'messages') return [];
        const out = closeBlock();
        blockIndex++;
        blockKind = kind;
        const block =
            kind === 'tool'
                ? { type: 'tool_use', id: meta.id, name: meta.name, input: {} }
                : kind === 'reasoning'
                  ? { type: 'thinking', thinking: '', signature: '' }
                  : { type: 'text', text: '' };
        out.push(
            wire(
                { type: 'content_block_start', index: blockIndex, content_block: block },
                'content_block_start'
            )
        );
        return out;
    };
    const startResponseItem = (kind, item, key) => {
        if (target !== 'responses') return [];
        const index = id.nextIndex++;
        if (key === 'text') textIndex = index;
        else if (key === 'reasoning') reasoningIndex = index;
        return [
            wire(
                { type: 'response.output_item.added', output_index: index, item },
                'response.output_item.added'
            )
        ];
    };
    return {
        emit(e) {
            if (finished) return [];
            if (e.kind === 'usage') {
                usage = e.value;
                return [];
            }
            if (e.kind === 'finish') {
                finalReason = e.reason || finalReason;
                return [];
            }
            if (e.kind === 'done') return this.end();
            if (e.kind === 'error') {
                finished = true;
                return target === 'responses'
                    ? [
                          wire(
                              {
                                  type: 'response.failed',
                                  response: { id: responseId, error: { message: e.message } }
                              },
                              'response.failed'
                          )
                      ]
                    : target === 'messages'
                      ? [wire({ type: 'error', error: { type: 'api_error', message: e.message } }, 'error')]
                      : [wire({ error: { message: e.message, type: 'upstream_error' } })];
            }
            const out = ensureStart();
            if (e.kind === 'text' && e.value) {
                content += e.value;
                if (target === 'chat') out.push(chat({ content: e.value }));
                else if (target === 'responses') {
                    if (textIndex === null)
                        out.push(
                            ...startResponseItem(
                                'text',
                                {
                                    id: messageId,
                                    type: 'message',
                                    role: 'assistant',
                                    content: [],
                                    status: 'in_progress'
                                },
                                'text'
                            )
                        );
                    out.push(
                        wire(
                            {
                                type: 'response.output_text.delta',
                                output_index: textIndex,
                                content_index: 0,
                                delta: e.value,
                                item_id: messageId
                            },
                            'response.output_text.delta'
                        )
                    );
                } else {
                    if (blockKind !== 'text') out.push(...openBlock('text'));
                    out.push(
                        wire(
                            {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'text_delta', text: e.value }
                            },
                            'content_block_delta'
                        )
                    );
                }
            }
            if (e.kind === 'reasoning' && e.value) {
                if (target === 'chat') out.push(chat({ reasoning_content: e.value }));
                else if (target === 'responses') {
                    if (reasoningIndex === null)
                        out.push(
                            ...startResponseItem(
                                'reasoning',
                                { id: uid('rs_'), type: 'reasoning', summary: [] },
                                'reasoning'
                            )
                        );
                    out.push(
                        wire(
                            {
                                type: 'response.reasoning_summary_text.delta',
                                output_index: reasoningIndex,
                                summary_index: 0,
                                delta: e.value
                            },
                            'response.reasoning_summary_text.delta'
                        )
                    );
                } else {
                    if (blockKind !== 'reasoning') out.push(...openBlock('reasoning'));
                    out.push(
                        wire(
                            {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'thinking_delta', thinking: e.value }
                            },
                            'content_block_delta'
                        )
                    );
                }
            }
            if (e.kind === 'toolStart' || e.kind === 'toolDelta') {
                hasTools = true;
                let tool = tools.get(e.idx);
                if (!tool) {
                    tool = {
                        index: tools.size,
                        id: e.id || uid('call_'),
                        name: e.name || '',
                        args: '',
                        outputIndex: id.nextIndex++,
                        messageBlock: -1
                    };
                    tools.set(e.idx, tool);
                    if (target === 'responses')
                        out.push(
                            wire(
                                {
                                    type: 'response.output_item.added',
                                    output_index: tool.outputIndex,
                                    item: {
                                        id: uid('fc_'),
                                        type: 'function_call',
                                        status: 'in_progress',
                                        call_id: tool.id,
                                        name: tool.name,
                                        arguments: ''
                                    }
                                },
                                'response.output_item.added'
                            )
                        );
                    if (target === 'messages') {
                        out.push(...openBlock('tool', tool));
                        tool.messageBlock = blockIndex;
                    }
                    if (target === 'chat')
                        out.push(
                            chat({
                                tool_calls: [
                                    {
                                        index: tool.index,
                                        id: tool.id,
                                        type: 'function',
                                        function: { name: tool.name, arguments: '' }
                                    }
                                ]
                            })
                        );
                }
                if (e.kind === 'toolDelta' && e.value) {
                    tool.args += e.value;
                    if (target === 'chat')
                        out.push(
                            chat({ tool_calls: [{ index: tool.index, function: { arguments: e.value } }] })
                        );
                    else if (target === 'responses')
                        out.push(
                            wire(
                                {
                                    type: 'response.function_call_arguments.delta',
                                    output_index: tool.outputIndex,
                                    delta: e.value
                                },
                                'response.function_call_arguments.delta'
                            )
                        );
                    else {
                        if (tool.messageBlock !== blockIndex || blockKind !== 'tool') {
                            out.push(...openBlock('tool', tool));
                            tool.messageBlock = blockIndex;
                        }
                        out.push(
                            wire(
                                {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'input_json_delta', partial_json: e.value }
                                },
                                'content_block_delta'
                            )
                        );
                    }
                }
            }
            return out;
        },
        end() {
            if (finished) return [];
            finished = true;
            const out = ensureStart();
            if (target === 'chat') {
                out.push(
                    chat(
                        {},
                        hasTools
                            ? 'tool_calls'
                            : finalReason === 'max_tokens'
                              ? 'length'
                              : finalReason === 'length'
                                ? 'length'
                                : 'stop'
                    )
                );
                if (usage)
                    out.push(
                        wire({ id: id.id || 'chatcmpl_stream', model: clientModel, choices: [], usage })
                    );
                out.push('data: [DONE]\n\n');
            } else if (target === 'messages') {
                out.push(...closeBlock());
                out.push(
                    wire(
                        {
                            type: 'message_delta',
                            delta: {
                                stop_reason: hasTools
                                    ? 'tool_use'
                                    : finalReason === 'length'
                                      ? 'max_tokens'
                                      : 'end_turn'
                            },
                            usage: { output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0 }
                        },
                        'message_delta'
                    )
                );
                out.push(wire({ type: 'message_stop' }, 'message_stop'));
            } else {
                if (textIndex !== null)
                    out.push(
                        wire(
                            {
                                type: 'response.output_item.done',
                                output_index: textIndex,
                                item: {
                                    id: messageId,
                                    type: 'message',
                                    role: 'assistant',
                                    status: 'completed',
                                    content: [{ type: 'output_text', text: content, annotations: [] }]
                                }
                            },
                            'response.output_item.done'
                        )
                    );
                for (const tool of tools.values())
                    out.push(
                        wire(
                            {
                                type: 'response.function_call_arguments.done',
                                output_index: tool.outputIndex,
                                arguments: tool.args
                            },
                            'response.function_call_arguments.done'
                        )
                    );
                out.push(
                    wire(
                        {
                            type: 'response.completed',
                            response: {
                                id: responseId,
                                model: clientModel,
                                status: 'completed',
                                output: [],
                                usage: usage || { input_tokens: 0, output_tokens: 0 }
                            }
                        },
                        'response.completed'
                    )
                );
            }
            return out;
        }
    };
}
export async function* transcodeSse(body, source, target, clientModel) {
    const state = { id: null, model: clientModel, nextIndex: 0 };
    const emitter = makeEmitter(target, clientModel, state);
    let ended = false;
    for await (const frame of frames(body)) {
        const events = normalizeFrame(source, frame, state);
        for (const event of events) {
            if (event.kind === 'error') {
                for (const chunk of emitter.emit(event)) yield Buffer.from(chunk);
                throw new Error(event.message);
            }
            if (event.kind === 'done') ended = true;
            for (const chunk of emitter.emit(event)) yield Buffer.from(chunk);
        }
    }
    if (!ended) throw new Error('Upstream SSE terminated without success event');
}
