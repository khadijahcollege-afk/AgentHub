// test/compact-api.test.js — ringkasan konteks lewat server nyata, dengan
// upstream OpenAI-compatible palsu. Yang diuji adalah janji yang tidak bisa
// diuji fungsi murni: ringkasan benar-benar tersimpan ke thread, muncul di
// state, bisa dibuang, dan tidak jalan di tengah run.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8420, 40);
const TOKEN = 'cmptok0123456789ab';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let upstream;
let upstreamCalls = 0;
let lastRequest = null;
let upstreamReply = 'Pengguna memakai pnpm; berkas src/a.ts sudah diubah; sisa pekerjaan: uji unit.';
let upstreamDelay = 0;

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

// Engine sink: menulis pesan ke thread tanpa memanggil provider. Pesan thread
// diisi lewat jalur yang dipakai pengguna sungguhan (/send), bukan rute tes.
async function runSink(threadId, prompt) {
  const res = await api(`/api/threads/${threadId}/send`, {
    method: 'POST', body: JSON.stringify({ prompt, engine: 'sink' }),
  });
  if (res.status !== 200) throw new Error(`send ${res.status}: ${await res.text()}`);
  for await (const _ of res.body) { /* habiskan stream */ }
}

async function newThread() {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'sink' }) })).json();
  return t.id;
}

// Percakapan cukup panjang agar melewati ambang MIN_FOLD_CHARS.
async function seedConversation(threadId, turns = 5) {
  for (let i = 0; i < turns; i++) {
    await runSink(threadId, `giliran ${i}: ` + 'pertanyaan panjang '.repeat(30));
  }
}

const upstreamHandler = (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    upstreamCalls += 1;
    // Permintaan terakhir disimpan supaya tes bisa memeriksa isi yang benar-benar
    // dikirim ke model — bukan hanya bahwa ringkasan tersimpan di thread.
    try { lastRequest = JSON.parse(body); } catch { lastRequest = null; }
    if (upstreamDelay) await new Promise((r) => setTimeout(r, upstreamDelay));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: 'uji',
      choices: [{ index: 0, message: { role: 'assistant', content: upstreamReply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-compact-api-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
    // Fallback publik mati di sini: tes ini menguji kontrak gagal-502 pool
    // (deterministik, tanpa menyentuh endpoint publik internet).
    publicFallback: false,
    // Mulai mati: tes pertama menguji ringkasan manual. Menyalakannya di tengah
    // juga membuktikan setelan itu benar-benar berpengaruh pada run berikutnya.
    compactAuto: false,
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));

  const sink = path.join(dataDir, 'sink.cjs');
  fs.writeFileSync(sink, 'process.stdout.write("SINK:" + JSON.stringify(process.argv[2] || ""));\n');
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'sink', label: 'Sink (uji)', cmd: process.execPath, args: [sink, '{prompt}'] },
  ]));

  upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, '0.0.0.0', r));
  const upPort = upstream.address().port;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1', AGENTHUB_STRICT_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  assert.equal(await waitUp(), true, `server harus hidup\n${bootLog.slice(-600)}`);

  const r = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({
      preset: 'custom', name: 'Uji', baseUrl: `http://127.0.0.1:${upPort}/v1`,
      key: 'uji-1234567890', pool: true, poolModel: 'uji',
    }),
  });
  assert.equal(r.status, 200, await r.text());
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  try { upstream?.close(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

let threadId;

test('thread baru: belum ada ringkasan, dan belum ada yang perlu diringkas', async () => {
  threadId = await newThread();
  const s = await (await api(`/api/threads/${threadId}/compact`)).json();
  assert.equal(s.compact, null);
  assert.equal(s.canCompact, false);
});

test('percakapan pendek ditolak 400, bukan diringkas paksa', async () => {
  await runSink(threadId, 'halo');
  const r = await api(`/api/threads/${threadId}/compact`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'NOTHING_TO_COMPACT');
});

test('ringkasan tersimpan ke thread dan terbaca setelahnya', async () => {
  await seedConversation(threadId, 5);
  const before = upstreamCalls;
  const r = await api(`/api/threads/${threadId}/compact`, {
    method: 'POST', body: JSON.stringify({ model: 'auto' }),
  });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const body = JSON.parse(raw);
  assert.ok(body.compact?.summary, 'ringkasan harus ada');
  assert.ok(body.compact.throughMessageId, 'cursor harus menunjuk pesan');
  assert.equal(body.compact.generations, 1);
  assert.ok(upstreamCalls > before, 'upstream palsu harus dipanggil');

  // Tersimpan: thread GET memuatnya, dan bentuk publik di rute compact sama.
  const t = await (await api(`/api/threads/${threadId}`)).json();
  assert.equal(t.compact.summary, body.compact.summary);
  const s = await (await api(`/api/threads/${threadId}/compact`)).json();
  assert.equal(s.compact.summary, body.compact.summary);
});

test('daftar thread hanya membawa penanda, bukan isi ringkasan', async () => {
  const list = await (await api('/api/threads')).json();
  const row = list.find((t) => t.id === threadId);
  assert.ok(row, 'thread harus ada di daftar');
  assert.equal(row.compacted, true);
  assert.ok(row.compactMessages > 0);
  // Sidebar tidak boleh menerima teks ringkasan: itu payload yang dibayar
  // setiap render tanpa pernah ditampilkan di daftar.
  assert.equal('compact' in row, false);
});

test('run berikutnya benar-benar menerima ringkasan, bukan pesan yang sudah dilipat', async () => {
  // Inilah janji utamanya: ringkasan bukan hiasan di panel. Tanpa tes ini,
  // seluruh fitur bisa "tersimpan" tetapi tidak pernah sampai ke model.
  lastRequest = null;
  const send = await api(`/api/threads/${threadId}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'lanjutkan pekerjaan tadi', engine: 'pool', model: 'uji' }),
  });
  if (send.status !== 200) assert.fail(`send ${send.status}: ${await send.text()}`);
  for await (const _ of send.body) { /* habiskan stream */ }

  assert.ok(lastRequest, 'upstream harus menerima permintaan');
  const msgs = lastRequest.messages || [];
  const firstUser = msgs.find((m) => m.role === 'user');
  assert.ok(firstUser, 'harus ada giliran user');
  assert.match(firstUser.content, /Ringkasan percakapan sebelumnya/, 'ringkasan dikirim sebagai konteks');
  assert.match(firstUser.content, /pnpm/, 'isi ringkasan ikut terkirim');
  assert.match(firstUser.content, /bukan instruksi baru/, 'ringkasan diberi pagar');

  // Pesan yang sudah diwakili ringkasan tidak dikirim ulang (bayar dua kali).
  const joined = msgs.map((m) => m.content).join('\n');
  assert.equal(joined.includes('giliran 0:'), false, 'pesan yang sudah diringkas tidak boleh ikut');
  // Pesan terbaru + prompt baru tetap ada di ekor (prompt bisa diikuti blok
  // skill yang disuntikkan, jadi dibandingkan sebagai awalan, bukan persamaan).
  assert.equal(msgs.at(-1).content.startsWith('lanjutkan pekerjaan tadi'), true);
});

test('ringkasan bisa dibuang dan riwayat utuh kembali', async () => {
  const before = await (await api(`/api/threads/${threadId}`)).json();
  assert.ok(before.compact, 'prasyarat: ringkasan ada');
  const r = await api(`/api/threads/${threadId}/compact`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const after = await (await api(`/api/threads/${threadId}`)).json();
  assert.equal(after.compact, null);
  // Pesan tidak ikut terhapus: ringkasan hanya jendela, bukan penghapusan.
  assert.equal(after.messages.length, before.messages.length);
});

test('ringkasan tidak dijalankan di tengah run yang aktif', async () => {
  // Upstream dibuat lambat supaya run pertama masih berjalan saat kita menembak.
  upstreamDelay = 1500;
  const other = await newThread();
  const send = api(`/api/threads/${other}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'halo dari pool', engine: 'pool', model: 'uji' }),
  });
  await new Promise((r) => setTimeout(r, 400));
  const r = await api(`/api/threads/${other}/compact`, { method: 'POST', body: JSON.stringify({}) });
  upstreamDelay = 0;
  assert.equal(r.status, 409, 'run aktif harus menolak peringkasan');
  assert.equal((await r.json()).code, 'RUN_IN_PROGRESS');
  try { await (await send).text(); } catch { /* run mungkin dibatalkan */ }
});

test('ringkasan otomatis menyala lewat setelan dan berjalan setelah run', async () => {
  const r = await api('/api/settings', {
    method: 'POST', body: JSON.stringify({ compactAuto: true }),
  });
  assert.equal(r.status, 200);
  const st = await (await api('/api/state')).json();
  assert.equal(st.config.compactAuto, true);

  const target = await newThread();
  await seedConversation(target, 5);
  const before = upstreamCalls;
  await runSink(target, 'giliran terakhir: ' + 'pertanyaan panjang '.repeat(30));

  // Ringkasan berjalan di latar belakang: tunggu sampai muncul.
  let compact = null;
  for (let i = 0; i < 100 && !compact; i++) {
    const t = await (await api(`/api/threads/${target}`)).json();
    compact = t.compact || null;
    if (!compact) await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.ok(compact, 'ringkasan otomatis harus muncul');
  assert.ok(upstreamCalls > before, 'peringkasan otomatis memanggil model');
  assert.ok(compact.summary.length > 0);

  await api('/api/settings', { method: 'POST', body: JSON.stringify({ compactAuto: false }) });
});

test('rute compact menolak thread yang tidak ada', async () => {
  const r = await api('/api/threads/abcdef123456/compact');
  assert.equal(r.status, 404);
  const w = await api('/api/threads/abcdef123456/compact', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(w.status, 404);
  const d = await api('/api/threads/abcdef123456/compact', { method: 'DELETE' });
  assert.equal(d.status, 404);
});

test('ringkasan gagal dari pool dilaporkan 502 dan tidak menyimpan apa pun', async () => {
  const target = await newThread();
  await seedConversation(target, 5);
  // Upstream dipaksa gagal: key dihapus supaya pool tidak punya tujuan.
  // (Tidak ada GET /api/keys — daftar key ada di /api/state.)
  const st = await (await api('/api/state')).json();
  for (const k of (st.keys || [])) await api(`/api/keys/${k.id}`, { method: 'DELETE' });
  const r = await api(`/api/threads/${target}/compact`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'COMPACT_FAILED');
  const t = await (await api(`/api/threads/${target}`)).json();
  assert.ok(!t.compact, 'gagal meringkas tidak boleh menyimpan ringkasan setengah jadi');
});
