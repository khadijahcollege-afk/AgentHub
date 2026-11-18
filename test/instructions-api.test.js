// test/instructions-api.test.js — instruksi tetap & UserPromptSubmit lewat
// server nyata: AGENTS.md level user dan aturan proyek benar-benar sampai ke
// engine, dan hook prompt bisa menolak/mengubah sebelum pesan ditulis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(7980, 40);
const TOKEN = 'instrtok0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let repo;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Harness yang memantulkan prompt persis seperti diterima CLI, sebagai JSON.
async function runSink(threadId, prompt, extra = {}) {
  const res = await api(`/api/threads/${threadId}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt, engine: 'sink', ...extra }),
  });
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    for (const block of dec.decode(chunk, { stream: true }).split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'delta') text += evt.text || '';
    }
  }
  const marker = text.indexOf('SINK:');
  const raw = marker >= 0 ? text.slice(marker + 5) : text;
  let seen = raw;
  try { seen = JSON.parse(raw); } catch { /* biarkan apa adanya */ }
  return { status: 200, prompt: seen };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-instr-api-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-instr-api-repo-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  // Harness sink: cetak argv[2] apa adanya.
  const sink = path.join(dataDir, 'sink.cjs');
  fs.writeFileSync(sink, 'process.stdout.write("SINK:" + JSON.stringify(process.argv[2] || ""));\n');
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'sink', label: 'Sink (uji)', cmd: process.execPath, args: [sink, '{prompt}'] },
  ]));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Aturan proyek\n- Jangan pernah ubah berkas lockfile\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1', AGENTHUB_STRICT_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  assert.equal(await waitUp(), true, `server harus hidup\n${bootLog.slice(-600)}`);
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  for (const d of [dataDir, repo]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('rute instruksi: baca kosong, tulis, lalu terbaca', async () => {
  const empty = await (await api('/api/instructions')).json();
  assert.equal(empty.global.present, false);
  assert.equal(empty.summary.userPresent, false);

  const put = await api('/api/instructions/global', {
    method: 'PUT', body: JSON.stringify({ content: '# Preferensi\n- Selalu jawab dalam bahasa Indonesia\n' }),
  });
  assert.equal(put.status, 200);

  const after = await (await api('/api/instructions')).json();
  assert.equal(after.global.present, true);
  assert.match(after.global.text, /Selalu jawab/);
  // ringkasan tidak membocorkan isi
  assert.equal(JSON.stringify(after.summary).includes('Selalu jawab'), false);
});

test('instruksi user dan aturan proyek benar-benar sampai ke engine', async () => {
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'sink', cwd: repo }),
  })).json();
  const r = await runSink(t.id, 'halo');
  assert.equal(r.status, 200);
  assert.equal(typeof r.prompt, 'string', `prompt harus terbaca: ${JSON.stringify(r.prompt).slice(0, 200)}`);
  assert.match(r.prompt, /Selalu jawab dalam bahasa Indonesia/, 'AGENTS.md user ikut terkirim');
  assert.match(r.prompt, /Jangan pernah ubah berkas lockfile/, 'aturan proyek ikut terkirim');
  assert.match(r.prompt, /halo/, 'prompt asli tetap ada');
  // urutan: instruksi user muncul sebelum aturan proyek
  assert.equal(
    r.prompt.indexOf('Selalu jawab') < r.prompt.indexOf('Jangan pernah ubah'),
    true,
    'user sebelum proyek',
  );
});

test('systemPrompt thread ikut terkirim setelah aturan proyek', async () => {
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'sink', cwd: repo }),
  })).json();
  await api(`/api/threads/${t.id}`, {
    method: 'POST', body: JSON.stringify({ systemPrompt: 'Selalu sebut nama berkas yang diubah.' }),
  });
  const r = await runSink(t.id, 'periksa');
  assert.match(r.prompt, /Selalu sebut nama berkas/);
  assert.equal(
    r.prompt.indexOf('Jangan pernah ubah') < r.prompt.indexOf('Selalu sebut nama berkas'),
    true,
    'proyek sebelum instruksi thread',
  );
});

test('UserPromptSubmit yang menolak menghentikan run tanpa menulis pesan', async () => {
  const deny = path.join(dataDir, 'deny.mjs');
  fs.writeFileSync(deny, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const evt = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: evt.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'topik terlarang' } }));
`);
  await api('/api/hooks/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  await api('/api/hooks/events', {
    method: 'POST',
    body: JSON.stringify({ event: 'UserPromptSubmit', declarations: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [deny] }] }] }),
  });

  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'sink', cwd: repo }),
  })).json();
  const res = await api(`/api/threads/${t.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'halo', engine: 'sink' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'PROMPT_BLOCKED');
  assert.match(body.error, /topik terlarang/);

  const after = await (await api(`/api/threads/${t.id}`)).json();
  assert.equal(after.messages.length, 0, 'pesan user tidak ditulis');
  assert.equal(after.runState, 'stopped', 'run tidak tertinggal di status running');
});

test('UserPromptSubmit yang mengubah prompt mengganti teks yang dikirim', async () => {
  const rewrite = path.join(dataDir, 'rewrite.mjs');
  fs.writeFileSync(rewrite, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const evt = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: evt.hook_event_name, updatedInput: { prompt: 'PROMPT DARI HOOK' } } }));
`);
  await api('/api/hooks/events', {
    method: 'POST',
    body: JSON.stringify({ event: 'UserPromptSubmit', declarations: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [rewrite] }] }] }),
  });
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'sink', cwd: repo }),
  })).json();
  const r = await runSink(t.id, 'teks asli');
  assert.match(r.prompt, /PROMPT DARI HOOK/);
  assert.equal(r.prompt.includes('teks asli'), false, 'teks asli sudah diganti');

  // yang dilihat pengguna di chat tetap teks asli
  const after = await (await api(`/api/threads/${t.id}`)).json();
  const userMsg = after.messages.find((m) => m.role === 'user');
  assert.equal(userMsg.content, 'teks asli');
});
