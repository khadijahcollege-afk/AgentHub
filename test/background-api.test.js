// test/background-api.test.js — perintah latar lewat HTTP, termasuk pemulihan
// setelah server dimulai ulang.
//
// Dua hal yang hanya bisa dibuktikan di sini:
//   1. Rute benar-benar melayani daftar, keluaran, dan penolakan yang jelas.
//   2. Tugas dari proses SEBELUMNYA tetap terlihat setelah server boot ulang,
//      dengan status `error` (prosesnya sudah tidak ada) dan berkas keluaran
//      yang masih utuh. Itu janji utama fitur ini: keluarannya berkas, bukan
//      memori.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8740, 40);
const TOKEN = 'bgtok0123456789';
const BASE = `http://127.0.0.1:${PORT}`;

// Folder kerja "pengguna" yang dipakai tugas lama. Server membaca berkasnya
// dengan path absolut, jadi folder ini hanya perlu ada saat tes berjalan.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bg-api-work-'));
const SEED_ID = 'seedtask001';
const SEED_LOG = path.join(WORK, '.agenthub', 'tasks', `${SEED_ID}.log`);

let child;
let dataDir;

const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bg-api-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 999,
    agentCheckMinutes: 99999, keyCheckHours: 99999, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));

  // Jejak dari "server sebelumnya": satu tugas tercatat masih berjalan, lengkap
  // dengan berkas keluarannya.
  fs.mkdirSync(path.dirname(SEED_LOG), { recursive: true });
  fs.writeFileSync(SEED_LOG, 'added 32 packages in 4s\nkode error: EACCES\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'background-tasks.json'), JSON.stringify([{
    id: SEED_ID,
    threadId: 'thread-lama',
    command: 'npm install',
    label: 'install',
    cwd: WORK,
    status: 'running',
    exitCode: null,
    startedAt: Date.now() - 120000,
    endedAt: null,
    outputPath: `.agenthub/tasks/${SEED_ID}.log`,
    outputFile: SEED_LOG,
    bytes: 41,
    truncated: false,
    recovered: false,
  }]));

  // Boot lewat helper: bila gagal, pesannya membawa keluaran server
  // (port terpakai, config rusak, import gagal) alih-alih "server harus hidup".
  const boot = await startTestServer({ root: ROOT, port: PORT, dataDir });
  child = boot.child;
  assert.equal(boot.alive, true, boot.failure());
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const d of [dataDir, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

async function newThread() {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).json();
  return t.id;
}

test('daftar tugas butuh parameter thread', async () => {
  const r = await api('/api/background');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /thread/);
});

test('tugas dari server sebelumnya tetap terlihat, ditandai gagal tetapi berkasnya utuh', async () => {
  const list = await (await api('/api/background?thread=thread-lama')).json();
  assert.equal(list.tasks.length, 1);
  const t = list.tasks[0];
  assert.equal(t.id, SEED_ID);
  assert.equal(t.command, 'npm install');
  assert.equal(t.label, 'install');
  // Statusnya TIDAK boleh tetap "running": tidak ada proses yang bisa ditunggu,
  // dan agent yang membacanya akan menunggu selamanya.
  assert.equal(t.status, 'error');
  assert.equal(t.recovered, true);
  assert.equal(t.outputPath, `.agenthub/tasks/${SEED_ID}.log`);
  assert.equal(list.limits.perThread > 0, true);
  assert.equal(list.limits.maxWaitMs > 0, true);
});

test('keluaran tugas lama bisa dibaca, termasuk penanda terputus', async () => {
  const r = await (await api(`/api/background/${SEED_ID}?output=1`)).json();
  assert.equal(r.id, SEED_ID);
  assert.match(r.output, /added 32 packages/);
  assert.match(r.output, /EACCES/);
  // Pemulihan menambahkan penanda ke berkas: itulah satu-satunya jejak mengapa
  // perintah ini berhenti.
  assert.match(r.output, /terputus/);
  assert.equal(r.outputTruncated, false);
});

test('tanpa output=1, rute satu tugas tidak mengirim isi keluaran', async () => {
  const r = await (await api(`/api/background/${SEED_ID}`)).json();
  assert.equal('output' in r, false, 'daftar tugas tidak boleh memuat keluaran panjang');
  assert.equal(r.bytes > 0, true);
});

test('thread lain tidak melihat tugas ini', async () => {
  const id = await newThread();
  const list = await (await api(`/api/background?thread=${id}`)).json();
  assert.deepEqual(list.tasks, []);
});

test('id yang tidak dikenal: baca 404, hentikan 404', async () => {
  const one = await api('/api/background/tidakada');
  assert.equal(one.status, 404);
  const del = await api('/api/background/tidakada', { method: 'DELETE' });
  assert.equal(del.status, 404);
});

test('menghapus tugas yang sudah berhenti bukan galat', async () => {
  const del = await api(`/api/background/${SEED_ID}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.ok, true);
  // Tugasnya sudah `error` (dipulihkan), jadi "hentikan" berarti "tidak ada yang
  // perlu dihentikan" — bukan kegagalan yang membingungkan.
  assert.equal(body.already, true);
});
