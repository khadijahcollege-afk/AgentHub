// test/agent-loop.test.js — loop tool-calling end-to-end terhadap provider
// OpenAI-compatible lokal: model minta tool → server menjalankan → hasil dikirim
// balik → model menjawab. Juga menguji batas putaran dan pembatalan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-loop-'));
process.env.AGENTHUB_DATA = dataDir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-loop-work-'));
fs.writeFileSync(path.join(work, 'catatan.txt'), 'isi asli\n');

// Provider palsu: mengembalikan tool_calls pada permintaan pertama, lalu teks.
let calls = 0;
let lastBody = null;
let mode = 'tool';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    lastBody = JSON.parse(raw || '{}');
    calls++;
    const reply = mode === 'spin'
      ? { tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'catatan.txt' }) } }] }
      : calls === 1
        ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'catatan.txt' }) } }] }
        : { content: 'Berkas berisi: isi asli' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'uji-model',
      choices: [{ index: 0, message: { role: 'assistant', ...reply }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

fs.writeFileSync(path.join(dataDir, 'keys.json'), JSON.stringify([{
  id: 'aaaa1111bbbb2222',
  preset: 'custom',
  name: 'Uji lokal',
  baseUrl: `http://127.0.0.1:${port}`,
  key: 'kunci-uji',
  format: 'chat_completions',
  status: 'valid',
  pool: true,
  priority: 1,
  poolModel: 'uji-model',
  createdAt: Date.now(),
  stats: { req: 0, err: 0, lastUse: 0 },
}]));

const { runAgentLoop } = await import('../lib/agent-loop.js');

test.after(() => {
  server.close();
  for (const d of [dataDir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('loop menjalankan tool lalu menjawab dengan hasilnya', async () => {
  calls = 0; mode = 'tool';
  const events = [];
  const deltas = [];
  const r = await runAgentLoop({
    prompt: 'Baca catatan.txt',
    cwd: work,
    mode: 'yolo',
    onEvent: (e) => events.push(e),
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r.text, 'Berkas berisi: isi asli');
  assert.equal(r.turns, 2);
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, 'read_file');
  assert.equal(r.tools[0].ok, true);
  assert.equal(r.tokens, 30, 'dua putaran × 15 token');
  assert.equal(r.model, 'uji-model');

  // tool dikirim ke model, dan hasil tool dikembalikan sebagai pesan `tool`
  assert.equal(Array.isArray(lastBody.tools), true);
  assert.equal(lastBody.tools.some((t) => t.function.name === 'read_file'), true);
  assert.equal(deltas.join(''), 'Berkas berisi: isi asli');

  const start = events.find((e) => e.type === 'tools');
  assert.deepEqual(start.names, ['read_file catatan.txt']);
  assert.equal(events.some((e) => e.type === 'tool_result' && e.ok === true), true);
});

test('mode plan menyembunyikan tool tulis dari model', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Apa isi folder?', cwd: work, mode: 'plan' });
  const names = lastBody.tools.map((t) => t.function.name);
  assert.deepEqual(names.sort(), ['grep_files', 'list_files', 'read_file']);
  assert.equal(names.includes('write_file'), false);
});

test('tanpa folder kerja, tool bawaan tidak ditawarkan', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Halo', cwd: null, mode: 'yolo' });
  assert.equal(lastBody.tools, undefined, 'tanpa cwd tidak ada tool sama sekali');
});

test('batas putaran menghentikan model yang berputar-putar', async () => {
  calls = 0; mode = 'spin';
  const r = await runAgentLoop({ prompt: 'Ulang terus', cwd: work, mode: 'yolo', maxTurns: 3 });
  assert.equal(r.turns, 3);
  assert.match(r.text, /Berhenti setelah 3 putaran/);
});

test('pembatalan menghentikan loop di tengah', async () => {
  calls = 0; mode = 'spin';
  const ctrl = new AbortController();
  const p = runAgentLoop({ prompt: 'Batal', cwd: work, mode: 'yolo', signal: ctrl.signal, maxTurns: 50 });
  setTimeout(() => ctrl.abort(), 120);
  await assert.rejects(() => p, (e) => e.name === 'AbortError');
});

test('mode build tidak menawarkan tool tulis/perintah', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Ubah berkas', cwd: work, mode: 'build' });
  const names = lastBody.tools.map((t) => t.function.name);
  assert.equal(names.includes('write_file'), false);
  assert.equal(names.includes('run_command'), false);
});

test('mode yolo menawarkan semua tool bawaan', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Kerjakan', cwd: work, mode: 'yolo' });
  const names = lastBody.tools.map((t) => t.function.name);
  for (const n of ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_files', 'run_command']) {
    assert.equal(names.includes(n), true, n);
  }
});
