/**
 * Loss-aware Chat / Responses / Anthropic Messages protocol bridge.
 * Wire formats are decoded into a shared representation, not converted by
 * renaming fields. Unknown semantic payloads fail instead of being discarded.
 */
import crypto from 'node:crypto';

export const PROTOCOL = Object.freeze({ chat: 'chat', responses: 'responses', messages: 'messages' });
export const protocolPath = (p) =>
    p === 'responses' ? '/responses' : p === 'messages' ? '/messages' : '/chat/completions';

const error = (message) => {
    const e = new Error(message);
    e.code = 'protocol_conversion_error';
    e.statusCode = 422;
    return e;
};
const str = (value) => (typeof value === 'string' ? value : '');
const json = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? {}));
const textBlocks = (content) => {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (content == null) return [];
    if (!Array.isArray(content)) throw error('Unsupported message content');
    return content.map((part) => {
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')
            return { type: 'text', text: str(part.text) };
        if (part.type === 'thinking') return { type: 'thinking', text: str(part.thinking || part.text), signature: str(part.signature) };
        if (part.type === 'image_url') return { type: 'image', url: str(part.image_url?.url || part.image_url) };
        if (part.type === 'input_image') return { type: 'image', url: str(part.image_url || part.url) };
        if (part.type === 'image' && part.source?.type === 'base64')
            return { type: 'image', url: 'data:' + part.source.media_type + ';base64,' + part.source.data };
        throw error('Unsupported content block: ' + part.type);
    });
};
const text = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
const reasoning = (parts) => parts.filter((p) => p.type === 'thinking').map((p) => p.text).join('');
const images = (parts, format) => parts.filter((p) => p.type === 'image').map((p) => {
    if (format === 'chat') return { type: 'image_url', image_url: { url: p.url } };
    if (format === 'responses') return { type: 'input_image', image_url: p.url };
    const m = /^data:([^;]+);base64,(.+)$/.exec(p.url);
    if (!m) throw error('Anthropic Messages requires base64 image data');
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
});
const normalizeChoice = (choice) => {
    if (typeof choice === 'string') return choice;
    if (choice?.type === 'function' || choice?.type === 'tool') return { type: 'tool', name: choice.name || choice.function?.name };
    return choice?.type || 'auto';
};
const encodeChoice = (choice, target) => {
    if (typeof choice === 'object') {
        const name = choice.name;
        return target === 'chat' ? { type: 'function', function: { name } } : { type: 'tool', name };
    }
    if (choice === 'required') return target === 'messages' ? 'any' : 'required';
    if (choice === 'none') return target === 'messages' ? { type: 'none' } : 'none';
    if (target === 'messages') return { type: 'auto' };
    return choice === 'any' ? 'required' : 'auto';
};
const openAITools = (tools) => tools.map((t) => ({
    type: 'function',
    name: t.name || t.function?.name,
    description: t.description || t.function?.description || '',
    parameters: t.parameters || t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    strict: t.strict ?? t.function?.strict
}));
const validTools = (tools) => tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.parameters
}));
const toChatMessage = (m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.callId, content: text(m.parts) };
    const parts = [...m.parts.filter((x) => x.type === 'text').map((x) => ({ type: 'text', text: x.text })), ...images(m.parts, 'chat')];
    const message = { role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts.length ? parts : null };
    if (m.calls?.length) message.tool_calls = m.calls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: json(c.arguments) }
    }));
    if (reasoning(m.parts)) message.reasoning_content = reasoning(m.parts);
    return message;
};
const decodeChat = (input) => ({
    model: input.model,
    stream: !!input.stream,
    system: [],
    messages: (input.messages || []).map((m) => ({
        role: m.role,
        parts: [...textBlocks(m.content), ...(m.reasoning_content ? [{ type: 'thinking', text: str(m.reasoning_content) }] : [])],
        callId: m.tool_call_id,
        calls: (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments }))
    })),
    tools: validTools(openAITools(input.tools || [])),
    choice: normalizeChoice(input.tool_choice),
    maxTokens: input.max_completion_tokens ?? input.max_tokens,
    temperature: input.temperature,
    topP: input.top_p,
    effort: input.reasoning_effort ?? input.reasoning?.effort,
    parallelToolCalls: input.parallel_tool_calls
});
const decodeResponses = (input) => {
    if (input.previous_response_id)
        throw error('previous_response_id cannot be translated without complete conversation history');
    const items = typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : input.input || [];
    const messages = [];
    for (const item of items) {
        if (item.type === 'function_call') {
            messages.push({ role: 'assistant', parts: [], calls: [{ id: item.call_id || item.id, name: item.name, arguments: item.arguments }] });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', parts: textBlocks(item.output), callId: item.call_id, calls: [] });
        } else if (item.type === 'reasoning') {
            messages.push({ role: 'assistant', parts: [{ type: 'thinking', text: (item.summary || []).map((s) => s.text).join('') }], calls: [] });
        } else if (item.role || item.type === 'message') {
            messages.push({ role: item.role || 'user', parts: textBlocks(item.content), calls: [] });
        } else throw error('Unsupported Responses input item: ' + item.type);
    }
    return {
        model: input.model, stream: !!input.stream,
        system: textBlocks(input.instructions), messages,
        tools: validTools(openAITools(input.tools || [])),
        choice: normalizeChoice(input.tool_choice),
        maxTokens: input.max_output_tokens, temperature: input.temperature,
        topP: input.top_p, effort: input.reasoning?.effort,
        parallelToolCalls: input.parallel_tool_calls
    };
};
const decodeMessages = (input) => {
    const messages = [];
    for (const m of input.messages || []) {
        const parts = [];
        const calls = [];
        for (const part of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []) {
            if (part.type === 'tool_use') calls.push({ id: part.id, name: part.name, arguments: part.input });
            else if (part.type === 'tool_result') messages.push({
                role: 'tool', parts: textBlocks(part.content), callId: part.tool_use_id, calls: []
            });
            else parts.push(...textBlocks([part]));
        }
        if (parts.length || calls.length) messages.push({ role: m.role, parts, calls });
    }
    return {
        model: input.model, stream: !!input.stream, system: textBlocks(input.system),
        messages, tools: validTools(openAITools(input.tools || [])),
        choice: normalizeChoice(input.tool_choice), maxTokens: input.max_tokens,
        temperature: input.temperature, topP: input.top_p,
        effort: input.thinking?.type === 'enabled' ? 'high' : undefined
    };
};
export function decodeRequest(protocol, body) {
    if (!body || typeof body !== 'object') throw error('Request must be a JSON object');
    if (protocol === 'chat') return decodeChat(body);
    if (protocol === 'responses') return decodeResponses(body);
    if (protocol === 'messages') return decodeMessages(body);
    throw error('Unsupported source protocol: ' + protocol);
}
export function encodeRequest(protocol, ir) {
    const common = { model: ir.model, stream: ir.stream };
    if (ir.temperature !== undefined) common.temperature = ir.temperature;
    if (ir.topP !== undefined) common.top_p = ir.topP;
    if (protocol === 'chat') {
        const messages = [];
        if (ir.system.length) messages.push(toChatMessage({ role: 'system', parts: ir.system }));
        messages.push(...ir.messages.map(toChatMessage));
        const value = { ...common, messages };
        if (ir.tools.length) value.tools = ir.tools.map((t) => ({
            type: 'function', function: { name: t.name, description: t.description, parameters: t.schema }
        }));
        if (ir.tools.length) value.tool_choice = encodeChoice(ir.choice, protocol);
        if (ir.maxTokens != null) value.max_tokens = ir.maxTokens;
        if (ir.effort) value.reasoning_effort = ir.effort;
        if (ir.parallelToolCalls !== undefined) value.parallel_tool_calls = ir.parallelToolCalls;
        if (ir.stream) value.stream_options = { include_usage: true };
        return value;
    }
    if (protocol === 'responses') {
        const input = [];
        for (const m of ir.messages) {
            if (m.role === 'tool') {
                input.push({ type: 'function_call_output', call_id: m.callId, output: text(m.parts) });
                continue;
            }
            const content = [
                ...m.parts.filter((p) => p.type === 'text').map((p) => ({
                    type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text
                })),
                ...images(m.parts, 'responses')
            ];
            if (content.length) input.push({ type: 'message', role: m.role, content });
            for (const call of m.calls || [])
                input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: json(call.arguments) });
        }
        const value = { ...common, input };
        if (ir.system.length) value.instructions = text(ir.system);
        if (ir.tools.length) value.tools = ir.tools.map((t) => ({
            type: 'function', name: t.name, description: t.description, parameters: t.schema
        }));
        if (ir.tools.length) value.tool_choice = encodeChoice(ir.choice, protocol);
        if (ir.maxTokens != null) value.max_output_tokens = ir.maxTokens;
        if (ir.effort) value.reasoning = { effort: ir.effort };
        if (ir.parallelToolCalls !== undefined) value.parallel_tool_calls = ir.parallelToolCalls;
        return value;
    }
    if (protocol === 'messages') {
        const messages = [];
        for (const m of ir.messages) {
            if (m.role === 'tool') {
                const previous = messages[messages.length - 1];
                const item = { type: 'tool_result', tool_use_id: m.callId, content: text(m.parts) };
                if (previous?.role === 'user') previous.content.push(item);
                else messages.push({ role: 'user', content: [item] });
                continue;
            }
            if (m.role === 'system' || m.role === 'developer') {
                throw error('System/developer messages must be top-level in Anthropic Messages');
            }
            const blocks = [
                ...m.parts.filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: p.text })),
                ...images(m.parts, 'messages')
            ];
            for (const call of m.calls || []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments });
            if (blocks.length) messages.push({ role: m.role, content: blocks });
        }
        const value = { ...common, messages, max_tokens: ir.maxTokens || 4096 };
        if (ir.system.length) value.system = text(ir.system);
        if (ir.tools.length) value.tools = ir.tools.map((t) => ({
            name: t.name, description: t.description, input_schema: t.schema
        }));
        if (ir.tools.length) value.tool_choice = encodeChoice(ir.choice, protocol);
        if (ir.effort && ir.effort !== 'none') value.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.min(8192, Math.floor((ir.maxTokens || 4096) / 2))) };
        return value;
    }
    throw error('Unsupported target protocol: ' + protocol);
}
export function convertRequest(source, target, body) {
    if (source === target) return body;
    return encodeRequest(target, decodeRequest(source, body));
}
const normUsage = (u, source) => ({
    input: u?.input_tokens ?? u?.prompt_tokens ?? 0,
    output: u?.output_tokens ?? u?.completion_tokens ?? 0,
    cache: u?.input_tokens_details?.cached_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0,
    reasoning: u?.output_tokens_details?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? 0,
    source
});
export function decodeResponse(protocol, data) {
    let id = data.id || 'resp_' + crypto.randomUUID().replaceAll('-', '');
    let model = data.model;
    let parts = [];
    let calls = [];
    let finish = 'stop';
    if (protocol === 'chat') {
        const choice = data.choices?.[0];
        if (!choice) throw error('Missing Chat completion choice');
        parts = textBlocks(choice.message?.content);
        if (choice.message?.reasoning_content) parts.push({ type: 'thinking', text: choice.message.reasoning_content });
        calls = (choice.message?.tool_calls || []).map((t) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments }));
        finish = choice.finish_reason || 'stop';
    } else if (protocol === 'responses') {
        model = data.model;
        for (const item of data.output || []) {
            if (item.type === 'message') parts.push(...textBlocks(item.content));
            else if (item.type === 'reasoning') parts.push({ type: 'thinking', text: (item.summary || []).map((s) => s.text).join('') });
            else if (item.type === 'function_call') calls.push({ id: item.call_id || item.id, name: item.name, arguments: item.arguments });
            else throw error('Unsupported Responses output: ' + item.type);
        }
        if (data.status === 'failed') throw error(data.error?.message || 'Upstream Responses failed');
        finish = data.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop';
    } else if (protocol === 'messages') {
        for (const part of data.content || []) {
            if (part.type === 'tool_use') calls.push({ id: part.id, name: part.name, arguments: part.input });
            else parts.push(...textBlocks([part]));
        }
        finish = data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop';
    } else throw error('Unsupported response protocol');
    return { id, model, parts, calls, finish, usage: normUsage(data.usage, protocol) };
}
export function encodeResponse(protocol, ir) {
    const content = text(ir.parts);
    const think = reasoning(ir.parts);
    const calls = ir.calls || [];
    const u = ir.usage || {};
    if (protocol === 'chat') {
        const message = { role: 'assistant', content: content || null };
        if (think) message.reasoning_content = think;
        if (calls.length) message.tool_calls = calls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: json(c.arguments) }
        }));
        return {
            id: ir.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: ir.model,
            choices: [{ index: 0, message, finish_reason: ir.finish }],
            usage: { prompt_tokens: u.input || 0, completion_tokens: u.output || 0, total_tokens: (u.input || 0) + (u.output || 0),
                prompt_tokens_details: { cached_tokens: u.cache || 0 }, completion_tokens_details: { reasoning_tokens: u.reasoning || 0 } }
        };
    }
    if (protocol === 'responses') {
        const output = [];
        if (think) output.push({ id: 'rs_' + crypto.randomUUID(), type: 'reasoning', summary: [{ type: 'summary_text', text: think }] });
        if (content) output.push({ id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: content, annotations: [] }] });
        for (const c of calls) output.push({ id: 'fc_' + crypto.randomUUID(), type: 'function_call',
            status: 'completed', call_id: c.id, name: c.name, arguments: json(c.arguments) });
        return { id: ir.id, object: 'response', model: ir.model, status: ir.finish === 'length' ? 'incomplete' : 'completed',
            output, usage: { input_tokens: u.input || 0, output_tokens: u.output || 0,
                total_tokens: (u.input || 0) + (u.output || 0),
                input_tokens_details: { cached_tokens: u.cache || 0 }, output_tokens_details: { reasoning_tokens: u.reasoning || 0 } } };
    }
    if (protocol === 'messages') {
        const blocks = [];
        if (think) blocks.push({ type: 'thinking', thinking: think, signature: '' });
        if (content) blocks.push({ type: 'text', text: content });
        for (const c of calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name,
            input: typeof c.arguments === 'string' ? JSON.parse(c.arguments) : c.arguments });
        return { id: ir.id, type: 'message', role: 'assistant', model: ir.model, content: blocks,
            stop_reason: ir.finish === 'tool_calls' ? 'tool_use' : ir.finish === 'length' ? 'max_tokens' : 'end_turn',
            stop_sequence: null, usage: { input_tokens: u.input || 0, output_tokens: u.output || 0,
                cache_read_input_tokens: u.cache || 0 } };
    }
    throw error('Unsupported target response protocol');
}
export function convertResponse(source, target, body) {
    if (source === target) return body;
    return encodeResponse(target, decodeResponse(source, body));
}
