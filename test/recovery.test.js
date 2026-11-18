// test/recovery.test.js — run yang tertinggal "running" setelah server mati
// tidak boleh tampil sebagai pekerjaan aktif. Server harus memulihkannya
// menjadi state terminal yang jujur (error) sekali saat mulai.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8060, 40);
const TOKEN = 'recoverytoken0123456789';
let child;
let dataDir;
const THREAD_ID = 'abcdef0123456789';

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-recovery-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  // Kondisi setelah crash: thread masih running, prosesnya sudah tidak ada.
  fs.writeFileSync(path.join(dataDir, 'threads.json'), JSON.stringify([{
    id: THREAD_ID,
    title: 'Run yang terputus',
    engine: 'echo',
    messages: [{ id: 'm1', role: 'user', content: 'halo', ts: Date.now() }],
    running: true,
    runStartedAt: Date.now() - 60000,
    createdAt: Date.now() - 120000,
    updatedAt: Date.now() - 60000,
  }]));
  // Boot lewat helper: bila gagal, pesannya membawa keluaran server
  // (port terpakai, config rusak, import gagal) alih-alih "server harus hidup".
  const boot = await startTestServer({ root: ROOT, port: PORT, dataDir });
  child = boot.child;
  assert.equal(boot.alive, true, boot.failure());
});

test.after(async () => {
  // Menunggu `exit`, bukan sekadar mengirim sinyal: proses yang masih hidup
  // memegang port-nya, dan tes berikutnya bisa memilih port itu.
  await stopTestServer(child);
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* noop */ }
});

test('startup: run yatim dipulihkan, status tidak melaporkan pekerjaan palsu', async () => {
  const status = await (await api('/api/status')).json();
  assert.equal(status.runningCount, 0);
  assert.deepEqual(status.runningThreads, []);
  assert.equal(status.recoveredRuns, 1);

  const t = await (await api(`/api/threads/${THREAD_ID}`)).json();
  assert.equal(t.running, false);
  assert.equal(t.runState, 'error');
  assert.match(t.runError, /server berhenti/i);
  assert.ok(t.runEndedAt > 0);
  // riwayat user tidak diubah / tidak dihapus
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].content, 'halo');
});

test('startup: thread yang dipulihkan bisa dipakai run baru', async () => {
  const res = await api(`/api/threads/${THREAD_ID}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'lanjut', engine: 'echo' }),
  });
  // engine echo tidak tersedia di data uji ini → run gagal cepat, tetapi
  // transisi error → running → error harus sah dan tidak tertahan.
  assert.equal(res.status, 200);
  await res.text();
  const t = await (await api(`/api/threads/${THREAD_ID}`)).json();
  assert.equal(t.running, false);
  assert.ok(['done', 'error', 'stopped'].includes(t.runState));
});
