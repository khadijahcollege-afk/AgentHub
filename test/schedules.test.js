// test/schedules.test.js — jadwal prompt berulang + cadangan/pulihkan.
// Eksekusi diuji dengan engine echo (cepat & tanpa jaringan); timer otomatis
// 30 detik tidak diuji langsung — logika temponya diuji sebagai fungsi murni.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRunAt } from '../lib/schedules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Band port unik per berkas tes: schedules 8490–8509 (prompts berhenti di 8489).
const PORT = 8490 + Math.floor(Math.random() * 20);
const TOKEN = 'schedtoken0123456789';
let child;
let dataDir;

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-sched-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  // Engine echo khusus uji (tanpa jaringan) — sama seperti run.test.js.
  const isWin = process.platform === 'win32';
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify(isWin
    ? [{ id: 'echo', label: 'Echo', cmd: 'cmd', args: ['/c', 'echo', 'ECHO:{prompt}'] }]
    : [{ id: 'echo', label: 'Echo', cmd: 'sh', args: ['-c', 'echo "ECHO:{prompt}"'] }]));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('schedules: matematika tempo interval & harian', () => {
  const now = new Date(2026, 10, 13, 9, 30).getTime();
  // interval: sekarang + N menit
  assert.equal(nextRunAt({ mode: 'interval', intervalMinutes: 15 }, now), now + 15 * 60000);
  // interval: di bawah minimum → dijepit ke 1 menit
  assert.equal(nextRunAt({ mode: 'interval', intervalMinutes: 0 }, now), now + 60000);
  assert.equal(nextRunAt({ mode: 'interval', intervalMinutes: 999999 }, now), now + 7 * 24 * 60 * 60000, 'maksimum seminggu');
  // harian: 09:00 sudah lewat pada 09:30 → besok 09:00
  const nine = nextRunAt({ mode: 'daily', dailyAt: '09:00' }, now);
  const d = new Date(nine);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 14);
});

test('schedules: CRUD + validasi via HTTP', async () => {
  assert.equal((await api('/api/schedules', { method: 'POST', body: JSON.stringify({ prompt: 'x', engine: 'bogus' }) })).status, 400);
  assert.equal((await api('/api/schedules', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).status, 400, 'prompt wajib');
  assert.equal((await api('/api/schedules', { method: 'POST', body: JSON.stringify({ prompt: 'x', engine: 'echo', mode: 'daily', dailyAt: '25:00' }) })).status, 400);

  const s = await (await api('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cek repo', prompt: 'Ringkas status repo.', engine: 'echo', mode: 'interval', intervalMinutes: 30 }),
  })).json();
  assert.ok(s.id && s.enabled === true && s.nextRunAt > Date.now() - 60000);

  const list = await (await api('/api/schedules')).json();
  assert.ok(list.some((x) => x.id === s.id));

  const off = await (await api(`/api/schedules/${s.id}`, { method: 'POST', body: JSON.stringify({ enabled: false }) })).json();
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, null, 'nonaktif = tanpa tempo');

  const patched = await (await api(`/api/schedules/${s.id}`, { method: 'POST', body: JSON.stringify({ mode: 'daily', dailyAt: '07:15', enabled: true }) })).json();
  assert.equal(patched.mode, 'daily');
  assert.equal(patched.dailyAt, '07:15');
  assert.ok(patched.nextRunAt > Date.now(), 'diaktifkan ulang → tempo dihitung');

  return s;
});

test('schedules: run-now mengeksekusi prompt ke thread jadwal', async () => {
  const s = await (await api('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({ name: 'Uji echo', prompt: 'echo: jadwal jalan', engine: 'echo', mode: 'interval', intervalMinutes: 9999 }),
  })).json();
  assert.equal(s.threadId, null, 'thread dibuat saat eksekusi pertama');
  const run = await (await api(`/api/schedules/${s.id}/run`, { method: 'POST' })).json();
  assert.equal(run.ok, true);

  // poll hingga asisten membalas (echo cepat)
  let thread = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const after = await (await api('/api/schedules')).json();
    const cur = after.find((x) => x.id === s.id);
    if (cur?.threadId && cur.lastStatus === 'ok') {
      thread = await (await api(`/api/threads/${cur.threadId}`)).json();
      break;
    }
  }
  assert.ok(thread, 'jadwal punya thread hasil');
  const user = thread.messages.find((x) => x.role === 'user');
  const assistant = thread.messages.find((x) => x.role === 'assistant');
  assert.equal(user?.scheduledBy, 'Uji echo', 'pesan user ditandai asal jadwal');
  assert.match(assistant?.content || '', /jadwal jalan/, 'prompt dieksekusi engine');

  const gone = await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200);
});

test('backup: ekspor berisi semua store, pulihkan menimpa data', async () => {
  // pastikan ada key & thread nyata sebelum mengekspor
  const kr = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-backup-uji', baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  assert.equal(kr.status, 200);

  const res = await api('/api/backup');
  assert.match(res.headers.get('content-disposition'), /agenthub-backup-/);
  const bundle = await res.json();
  assert.equal(bundle.app, 'agenthub-backup');
  assert.ok(Array.isArray(bundle.stores['threads.json']), 'threads ikut');
  assert.ok(Array.isArray(bundle.stores['keys.json']) && bundle.stores['keys.json'].length >= 1, 'keys ikut');

  // pulihkan bundle yang sama → ok
  const r1 = await api('/api/restore', { method: 'POST', body: JSON.stringify(bundle) });
  assert.equal(r1.status, 200);

  // pulihkan berkas asing → ditolak
  const bad = await api('/api/restore', { method: 'POST', body: JSON.stringify({ app: 'other', stores: {} }) });
  assert.equal(bad.status, 400);
  const sneaky = await api('/api/restore', { method: 'POST', body: JSON.stringify({ app: 'agenthub-backup', stores: { 'config.json': { token: 'hacked' } } }) });
  assert.equal(sneaky.status, 400, 'store di luar daftar ditolak');
  const sneaky2 = await api('/api/restore', { method: 'POST', body: JSON.stringify({ app: 'agenthub-backup', stores: { 'config.json': { token: 'hacked' }, ...bundle.stores } }) });
  assert.equal(sneaky2.status, 400, 'config.json (token/port) tidak boleh ikut dipulihkan');
});
