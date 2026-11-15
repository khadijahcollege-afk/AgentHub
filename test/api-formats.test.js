import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptEventStream, normalizeFormat, normalizeResponse, upstreamHeaders, upstreamRequest, upstreamUrl } from '../lib/api-formats.js';
import { probeKey } from '../lib/keys.js';

test('format defaults and endpoint resolution preserve existing OpenAI URLs', () => {
  assert.equal(normalizeFormat(), 'chat_completions');
  assert.equal(upstreamUrl('chat_completions', 'https://api.example/v1', '/chat/completions'), 'https://api.example/v1/chat/completions');
  assert.equal(upstreamUrl('anthropic_messages', 'https://api.anthropic.com', '/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(upstreamUrl('responses', 'https://api.example/v1', '/responses'), 'https://api.example/v1/responses');
});

test('Anthropic key probe uses the selected endpoint and authentication headers', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 }); };
  try {
    const result = await probeKey('https://api.example/v1', 'secret', 1000, 'anthropic_messages');
    assert.equal(result.status, 'valid');
    assert.equal(request.url, 'https://api.example/v1/models');
    assert.equal(request.options.headers['x-api-key'], 'secret');
    assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.options.headers.authorization, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic request maps system, messages, tools, and auth', () => {
  const request = upstreamRequest('anthropic_messages', {
    messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Find', parameters: { type: 'object' } } }], max_tokens: 40,
  }, 'claude-test');
  assert.equal(request.path, '/messages');
  assert.equal(request.body.system, 'Be concise');
  assert.deepEqual(request.body.messages[0].content, [{ type: 'text', text: 'Hi' }]);
  assert.equal(request.body.tools[0].name, 'lookup');
  assert.deepEqual(upstreamHeaders('anthropic_messages', { key: 'secret' }), { 'content-type': 'application/json', 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
});

test('Responses request and response normalize to Chat Completions', () => {
  const request = upstreamRequest('responses', { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 42, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'lookup' } } }, 'gpt-test');
  assert.equal(request.path, '/responses');
  assert.equal(request.body.max_output_tokens, 42);
  assert.equal(request.body.input[0].content, 'Hi');
  assert.deepEqual(request.body.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(request.body.tools[0].name, 'lookup');
  const response = normalizeResponse('responses', { id: 'resp_1', output_text: 'Hello', usage: { input_tokens: 2, output_tokens: 3 } }, 'gpt-test');
  assert.equal(response.choices[0].message.content, 'Hello');
  assert.equal(response.usage.total_tokens, 5);
});

test('Responses keeps image inputs and tool outputs in request history', () => {
  const request = upstreamRequest('responses', { messages: [
    { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'low' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ] }, 'gpt-test');
  assert.deepEqual(request.body.input[0].content, [
    { type: 'input_text', text: 'Describe' },
    { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' },
  ]);
  assert.deepEqual(request.body.input[1], { type: 'function_call_output', call_id: 'call_1', output: 'result' });
});

test('Anthropic response normalizes text and tool calls', () => {
  const response = normalizeResponse('anthropic_messages', {
    id: 'msg_1', model: 'claude-test', stop_reason: 'tool_use',
    content: [{ type: 'text', text: 'Searching' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
  }, 'fallback');
  assert.equal(response.choices[0].message.content, 'Searching');
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"q":"x"}');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
});

test('Anthropic SSE text events adapt to OpenAI-compatible chunks', async () => {
  const source = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'));
    controller.enqueue(new TextEncoder().encode('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
    controller.close();
  } });
  const reader = adaptEventStream('anthropic_messages', source, 'claude-test').getReader();
  let text = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  assert.match(text, /"content":"Hi"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test('Responses SSE accepts CRLF framing and adapts function calls', async () => {
  const source = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"lookup"}}\r\n\r\n'));
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}\r\n\r\n'));
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"output":[{"type":"function_call"}]}}\r\n\r\n'));
    controller.close();
  } });
  const reader = adaptEventStream('responses', source, 'gpt-test').getReader();
  let text = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  assert.match(text, /\"name\":\"lookup\"/);
  assert.match(text, /\"arguments\":\"\{\}\"/);
  assert.match(text, /\"finish_reason\":\"tool_calls\"/);
});
