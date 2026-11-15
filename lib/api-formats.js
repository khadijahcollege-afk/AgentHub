export const API_FORMATS = ['chat_completions', 'anthropic_messages', 'responses'];

export function normalizeFormat(format) {
  return API_FORMATS.includes(format) ? format : 'chat_completions';
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' || part?.type === 'input_text')
    .map((part) => part.text || '').join('');
}

function anthropicContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type === 'text' || part?.type === 'input_text') return [{ type: 'text', text: part.text || '' }];
    const imageUrl = part?.image_url?.url || part?.image_url;
    if (part?.type === 'image_url' && typeof imageUrl === 'string') {
      const data = imageUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      return [{ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: imageUrl } }];
    }
    return [];
  });
}

function responsesContent(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (part?.type === 'text' || part?.type === 'input_text') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' }];
    const imageUrl = part?.image_url?.url || part?.image_url;
    if (part?.type === 'image_url' && typeof imageUrl === 'string') return [{ type: 'input_image', image_url: imageUrl, ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}) }];
    return [];
  });
}

function parseToolArguments(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function anthropicMessages(messages = []) {
  const result = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    let role = message.role === 'assistant' ? 'assistant' : 'user';
    let content = [];
    if (message.role === 'tool') {
      content.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: messageText(message.content) });
    } else {
      content.push(...anthropicContent(message.content));
      if (role === 'assistant') for (const call of message.tool_calls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name || '', input: parseToolArguments(call.function?.arguments) });
      }
    }
    if (!content.length) content = [{ type: 'text', text: '' }];
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

function anthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  }));
}

function anthropicRequest(payload, model) {
  const messages = anthropicMessages(payload.messages);
  const system = (payload.messages || []).filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => messageText(m.content)).filter(Boolean).join('\n\n');
  const body = { model, messages, max_tokens: payload.max_tokens || payload.max_completion_tokens || 1024, stream: payload.stream === true };
  if (system) body.system = system;
  for (const key of ['temperature', 'top_p']) if (payload[key] !== undefined) body[key] = payload[key];
  if (payload.stop !== undefined) body.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  if (Array.isArray(payload.tools)) body.tools = anthropicTools(payload.tools);
  if (payload.tool_choice?.type === 'function') body.tool_choice = { type: 'tool', name: payload.tool_choice.function?.name };
  else if (payload.tool_choice === 'none') body.tool_choice = { type: 'none' };
  else if (payload.tool_choice === 'required') body.tool_choice = { type: 'any' };
  else if (payload.tool_choice === 'auto' || payload.tool_choice?.type === 'auto') body.tool_choice = { type: 'auto' };
  return body;
}

function responsesInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: messageText(message.content) });
    } else {
      if (message.content) input.push({ role: message.role, content: responsesContent(message.content, message.role) });
      if (message.role === 'assistant') for (const call of message.tool_calls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name || '', arguments: call.function?.arguments || '{}' });
      }
    }
  }
  return input;
}

function responsesTools(tools) {
  return tools.map((tool) => ({
    type: 'function', name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    parameters: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
    ...(tool.function?.strict !== undefined ? { strict: tool.function.strict } : {}),
  }));
}

function responsesRequest(payload, model) {
  const input = responsesInput(payload.messages);
  const body = { model, input, stream: payload.stream === true };
  for (const key of ['temperature', 'top_p', 'metadata']) if (payload[key] !== undefined) body[key] = payload[key];
  if (payload.tool_choice?.type === 'function') body.tool_choice = { type: 'function', name: payload.tool_choice.function?.name };
  else if (payload.tool_choice !== undefined) body.tool_choice = payload.tool_choice;
  if (Array.isArray(payload.tools)) body.tools = responsesTools(payload.tools);
  if (payload.max_completion_tokens !== undefined || payload.max_tokens !== undefined) body.max_output_tokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (payload.stop !== undefined) body.stop = payload.stop;
  return body;
}

export function upstreamRequest(format, payload, model) {
  if (format === 'anthropic_messages') return { path: '/messages', body: anthropicRequest(payload, model) };
  if (format === 'responses') return { path: '/responses', body: responsesRequest(payload, model) };
  return { path: '/chat/completions', body: { ...payload, model } };
}

export function upstreamUrl(format, baseUrl, endpoint) {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  if (format !== 'chat_completions' && !/\/v1(?:beta)?$/i.test(base)) base += '/v1';
  return base + endpoint;
}

export function upstreamHeaders(format, entry) {
  const headers = { 'content-type': 'application/json' };
  if (format === 'anthropic_messages') {
    headers['x-api-key'] = entry.key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${entry.key}`;
  }
  if (entry.preset === 'openrouter') {
    headers['http-referer'] = 'http://localhost:7788';
    headers['x-title'] = 'AgentHub';
  }
  return headers;
}

export function normalizeResponse(format, data, fallbackModel) {
  if (format === 'anthropic_messages') {
    const text = (data.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('');
    const toolCalls = (data.content || []).filter((part) => part.type === 'tool_use').map((part, index) => ({
      index, id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
    }));
    return { id: data.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: data.model || fallbackModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
      usage: data.usage ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0, total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) } : undefined };
  }
  if (format === 'responses') {
    const output = data.output || [];
    const text = output.flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text || '').join('') || data.output_text || '';
    const toolCalls = output.filter((item) => item.type === 'function_call').map((item, index) => ({
      index, id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' },
    }));
    const usage = data.usage;
    return { id: data.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: data.model || fallbackModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : data.status === 'incomplete' ? 'length' : 'stop' }],
      usage: usage ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0) } : undefined };
  }
  return data;
}

function chatChunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch { /* ignore malformed SSE event */ } }
      }
      if (done) {
        const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch { /* ignore malformed SSE event */ } }
        break;
      }
    }
  } finally { reader.releaseLock(); }
}

export function adaptEventStream(format, stream, model) {
  const id = `chatcmpl-${Date.now()}`;
  const body = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (text) => controller.enqueue(encoder.encode(text));
      try {
        send(chatChunk(id, model, { role: 'assistant' }));
        if (format === 'anthropic_messages') {
          for await (const event of parseSse(stream)) {
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              send(chatChunk(id, model, { tool_calls: [{ index: event.index || 0, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] }));
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') send(chatChunk(id, model, { content: event.delta.text }));
            if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') send(chatChunk(id, model, { tool_calls: [{ index: event.index || 0, function: { arguments: event.delta.partial_json || '' } }] }));
            if (event.type === 'message_delta') send(chatChunk(id, model, {}, event.delta?.stop_reason === 'max_tokens' ? 'length' : event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'));
          }
        } else if (format === 'responses') {
          for await (const event of parseSse(stream)) {
            if (event.type === 'response.output_text.delta') send(chatChunk(event.response_id || id, model, { content: event.delta || '' }));
            if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
              send(chatChunk(event.response_id || id, model, { tool_calls: [{ index: event.output_index || 0, id: event.item.call_id || event.item.id, type: 'function', function: { name: event.item.name, arguments: '' } }] }));
            }
            if (event.type === 'response.function_call_arguments.delta') send(chatChunk(event.response_id || id, model, { tool_calls: [{ index: event.output_index || 0, function: { arguments: event.delta || '' } }] }));
            if (event.type === 'response.completed') send(chatChunk(event.response?.id || id, model, {}, (event.response?.output || []).some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop'));
          }
        } else {
          for await (const event of parseSse(stream)) {
            if (event.choices) send(`data: ${JSON.stringify(event)}\n\n`);
          }
        }
        send('data: [DONE]\n\n');
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  return body;
}
