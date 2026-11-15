// Smoke test lokal untuk pemilihan format API per key (tanpa API key sungguhan).
// Menyalakan upstream tiruan (Anthropic Messages, Responses, Chat Completions)
// lalu memanggil gateway AgentHub /v1/chat/completions untuk tiap format.
//
//   node tools/smoke-api-formats.mjs            # jalankan semua pemeriksaan
//   node tools/smoke-api-formats.mjs --keep     # simpan folder data sementara
//
// Tidak menyentuh data aplikasi milik user: AGENTHUB_DATA selalu folder sementara.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const GW_PORT = 7910 + Math.floor(Math.random() * 80);
const MOCK_PORT = 8010 + Math.floor(Math.random() * 80);
const TOKEN = 'smoketoken0123456789abcdef';
const MOCK = `http://127.0.0.1:${MOCK_PORT}/v1`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-formats-'));

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  OK   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------- upstream tiruan ----------
const seen = [];
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { /* bukan JSON */ }
      resolve({ raw, json });
    });
  });
}
function sse(res, events, { done = false } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

const mock = createServer(async (req, res) => {
  const { json } = await readBody(req);
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: json });

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    if (!req.headers['x-api-key'] || !req.headers['anthropic-version']) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: 'header Anthropic tidak lengkap' } }));
    }
    if (json?.stream) {
      return sse(res, [
        { type: 'message_start', message: { id: 'msg_stream', model: 'mock-anthropic' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-anthropic',
      content: [{ type: 'text', text: 'halo dari anthropic' }],
      stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 4 },
    }));
  }

  if (req.method === 'POST' && req.url === '/v1/responses') {
    if (json?.model === 'mock-broken') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('bukan json');
    }
    if (json?.stream) {
      return sse(res, [
        { type: 'response.created', response: { id: 'resp_stream', model: 'mock-responses' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'ha' },
        { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
        { type: 'response.completed', response: { id: 'resp_stream', output: [{ type: 'message', content: [{ type: 'output_text', text: 'halo' }] }] } },
      ]);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'resp_mock', object: 'response', model: 'mock-responses', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'halo dari responses' }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }));
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    if (json?.stream) {
      return sse(res, [
        { id: 'chat_stream', object: 'chat.completion.chunk', model: 'mock-chat', choices: [{ index: 0, delta: { content: 'halo' }, finish_reason: null }] },
        { id: 'chat_stream', object: 'chat.completion.chunk', model: 'mock-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ], { done: true });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chat_mock', object: 'chat.completion', model: 'mock-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'halo dari chat' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `rute tiruan tidak dikenal: ${req.method} ${req.url}` }));
});

// ---------- server AgentHub ----------
function writeConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    port: GW_PORT, token: TOKEN, notify: false, refreshHours: 6, agentCheckMinutes: 15,
    keyCheckHours: 12, autoPool: true, baselined: false, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(DATA, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
}

async function waitFor(url, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function apiRoute(p, opts = {}) {
  return fetch(`${GW}${p}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
}

async function addKey(body) {
  const r = await apiRoute('/api/keys', { method: 'POST', body: JSON.stringify(body) });
  const json = await r.json();
  return { status: r.status, ...json };
}
async function removeKey(id) {
  await apiRoute(`/api/keys/${id}`, { method: 'DELETE' });
}

async function chat(body) {
  const r = await apiRoute('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: r.status, headers: r.headers, text, json };
}

function lastPost(pathname) {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (seen[i].method === 'POST' && seen[i].url === pathname) return seen[i];
  }
  return null;
}

// ---------- skenario ----------
async function scenarioAnthropic() {
  console.log('\n[1] Anthropic Messages (/v1/messages)');
  const made = await addKey({ preset: 'custom', name: 'Mock Anthropic', baseUrl: MOCK, key: 'sk-ant-lokal', format: 'anthropic_messages', pool: true, poolModel: 'mock-anthropic' });
  check('key tersimpan dengan format anthropic_messages', made.status === 200 && made.entry?.format === 'anthropic_messages', `status ${made.status}`);
  check('validasi memakai header x-api-key', made.entry?.status === 'valid', `status key: ${made.entry?.status}`);

  const probe = seen.filter((s) => s.method === 'GET').at(-1);
  check('probe menyapa /v1/models tanpa Bearer', probe?.headers['x-api-key'] === 'sk-ant-lokal' && !probe?.headers.authorization);
  check('probe mengirim anthropic-version', probe?.headers['anthropic-version'] === '2023-06-01');

  const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }], max_tokens: 32 });
  const upstream = lastPost('/v1/messages');
  check('request diarahkan ke /v1/messages', !!upstream, r.text.slice(0, 120));
  check('body memakai field messages + max_tokens', Array.isArray(upstream?.body?.messages) && upstream?.body?.max_tokens === 32);
  check('respons dinormalkan ke chat.completion', r.json?.object === 'chat.completion' && r.json?.choices?.[0]?.message?.content === 'halo dari anthropic', r.text.slice(0, 160));
  check('usage dipetakan input/output → prompt/completion', r.json?.usage?.prompt_tokens === 5 && r.json?.usage?.completion_tokens === 4);
  check('header x-served-by diisi nama key', decodeURIComponent(r.headers.get('x-served-by') || '') === 'Mock Anthropic');

  const s = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }], max_tokens: 32, stream: true });
  check('stream SSE berisi delta teks', /"content":"ha"/.test(s.text) && /"content":"lo"/.test(s.text), s.text.slice(0, 200));
  check('stream SSE ditutup [DONE]', /data: \[DONE\]/.test(s.text));
  check('stream SSE memuat finish_reason', /"finish_reason":"stop"/.test(s.text));

  await removeKey(made.entry.id);
}

async function scenarioResponses() {
  console.log('\n[2] Responses (/v1/responses)');
  const made = await addKey({ preset: 'custom', name: 'Mock Responses', baseUrl: MOCK, key: 'sk-resp-lokal', format: 'responses', pool: true, poolModel: 'mock-responses' });
  check('key tersimpan dengan format responses', made.entry?.format === 'responses');
  check('validasi Responses memakai Bearer', seen.filter((s) => s.method === 'GET').at(-1)?.headers.authorization === 'Bearer sk-resp-lokal');

  const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }], max_tokens: 16 });
  const upstream = lastPost('/v1/responses');
  check('request diarahkan ke /v1/responses', !!upstream, r.text.slice(0, 120));
  check('body memakai input + max_output_tokens', upstream?.body?.input?.[0]?.content === 'Halo' && upstream?.body?.max_output_tokens === 16);
  check('respons dinormalkan ke chat.completion', r.json?.choices?.[0]?.message?.content === 'halo dari responses', r.text.slice(0, 160));
  check('usage total_tokens dipakai apa adanya', r.json?.usage?.total_tokens === 5);

  const s = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }], stream: true });
  check('stream Responses diterjemahkan jadi delta', /"content":"ha"/.test(s.text) && /data: \[DONE\]/.test(s.text), s.text.slice(0, 200));

  // respons upstream rusak tidak boleh diteruskan mentah ke agent
  const broken = await chat({ model: 'mock-broken', messages: [{ role: 'user', content: 'Halo' }] });
  check('upstream rusak tidak diteruskan sebagai jawaban palsu', broken.status !== 200 || broken.json?.error, `status ${broken.status}`);

  await removeKey(made.entry.id);
}

async function scenarioChat() {
  console.log('\n[3] Chat Completions (/chat/completions) — perilaku lama');
  const made = await addKey({ preset: 'custom', name: 'Mock Chat', baseUrl: MOCK, key: 'sk-chat-lokal', pool: true, poolModel: 'mock-chat' });
  check('key tanpa format default ke chat_completions', made.entry?.format === 'chat_completions');

  const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }] });
  const upstream = lastPost('/v1/chat/completions');
  check('request tetap ke /chat/completions', !!upstream);
  check('respons diteruskan apa adanya', r.json?.choices?.[0]?.message?.content === 'halo dari chat');

  const s = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Halo' }], stream: true });
  check('stream passthrough berisi [DONE]', /data: \[DONE\]/.test(s.text));

  await removeKey(made.entry.id);
}

async function scenarioValidation() {
  console.log('\n[4] Validasi format & kontrak API');
  const bad = await addKey({ preset: 'custom', key: 'sk-x', baseUrl: MOCK, format: 'bukan_format' });
  check('format tak dikenal ditolak 400', bad.status === 400, `status ${bad.status}`);
  const masked = await addKey({ preset: 'custom', key: 'sk-1234…abcd', baseUrl: MOCK });
  check('mask tampilan ditolak', masked.status === 400);

  const models = await (await apiRoute('/v1/models')).json();
  check('/v1/models tetap tersedia untuk agent', models?.object === 'list' && Array.isArray(models.data));
}

// ---------- jalan ----------
let child;
let exitCode = 0;
try {
  writeConfig();
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: DATA, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  if (!(await waitFor(`${GW}/healthz`))) throw new Error('Server AgentHub tidak siap di port ' + GW_PORT);
  console.log(`Gateway : ${GW}`);
  console.log(`Upstream: ${MOCK}`);
  console.log(`Data    : ${DATA}`);

  await scenarioAnthropic();
  await scenarioResponses();
  await scenarioChat();
  await scenarioValidation();
} catch (error) {
  failures.push(error.message);
  console.error('\nGagal menjalankan smoke test:', error.message);
} finally {
  try { child?.kill(); } catch { /* noop */ }
  await new Promise((resolve) => mock.close(resolve));
  if (!KEEP) { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* noop */ } }
}

console.log(`\n${passed} lulus, ${failures.length} gagal`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  exitCode = 1;
}
process.exit(exitCode);
