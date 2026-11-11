// test/api.test.js — uji kontrak HTTP yang dipakai UI & agent.
// Menjalankan server sungguhan di port acak dengan data dir sementara,
// supaya tidak menyentuh data/dev milik user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7900 + Math.floor(Math.random() * 90);
const TOKEN = 'testtoken0123456789';
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
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 6,
    agentCheckMinutes: 15, keyCheckHours: 12, baselined: false, createdAt: Date.now(),
  }));
  // snapshot minimal supaya server tidak mencoba refresh jaringan saat boot
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
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

test('tanpa token → 401', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
  assert.equal(r.status, 401);
});

test('/api/machines mengembalikan kontrak lengkap', async () => {
  const r = await api('/api/machines');
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.version, 1);
  assert.deepEqual(m.tasks.transitions.inbox, ['todo']);
  assert.ok(m.run.states.running);
  assert.ok(m.connection.states.offline);
  assert.ok(Array.isArray(m.views) && m.views.includes('tasks'));
  assert.deepEqual(m.sseScopes.tasks, ['tasks']);
});

test('/api/status melaporkan apa yang berjalan', async () => {
  const r = await api('/api/status');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.runningCount, 0);
  assert.deepEqual(s.runningThreads, []);
  assert.ok('tasksByStatus' in s);
});

test('task: transisi linear ditegakkan, 409 untuk lompatan', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'uji mesin', status: 'inbox' }),
  })).json();
  const id = created.id;

  // sah: inbox → todo
  const ok = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'todo' }) });
  assert.equal(ok.status, 200);

  // ilegal: todo → review (lompat satu kolom)
  const bad = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(bad.status, 409);
  const body = await bad.json();
  assert.equal(body.code, 'ILLEGAL_TRANSITION');
  assert.deepEqual(body.allowed, ['running']);
  assert.equal(body.from, 'todo');

  // status tak dikenal juga 409, bukan diam-diam diabaikan
  const bogus = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'selesai' }) });
  assert.equal(bogus.status, 409);

  // rantai penuh sampai done
  for (const st of ['running', 'review', 'done']) {
    const r = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: st }) });
    assert.equal(r.status, 200, `→ ${st}`);
  }
  // done adalah sink
  const out = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(out.status, 409);

  // statusAt tercatat per kolom
  const list = await (await api('/api/tasks')).json();
  const t = list.find((x) => x.id === id);
  assert.ok(t.statusAt.done > 0);
  assert.equal(t.status, 'done');
});

test('task: patch judul saja tidak mengubah status', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'judul awal', status: 'todo' }),
  })).json();
  const r = await api(`/api/tasks/${created.id}`, { method: 'POST', body: JSON.stringify({ title: 'judul baru' }) });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.title, 'judul baru');
  assert.equal(t.status, 'todo');
});

test('task: status sama dengan sekarang tidak dianggap transisi ilegal', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'idempoten', status: 'review' }),
  })).json();
  const r = await api(`/api/tasks/${created.id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(r.status, 200);
});

test('thread: stop pada run yang tidak ada tetap 200 (idempoten)', async () => {
  const r = await api('/api/threads/abcdef0123456789/stop', { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stopped, 0);
});

test('/api/version stabil untuk agent', async () => {
  const v = await (await api('/api/version')).json();
  assert.equal(v.machines, 1);
  assert.deepEqual(v.taskStatuses, ['inbox', 'todo', 'running', 'review', 'done']);
});

test('notes: buat, sematkan, ubah, hapus', async () => {
  // judul/isi kosong ditolak
  const bad = await api('/api/notes', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(bad.status, 400);

  const a = await (await api('/api/notes', {
    method: 'POST', body: JSON.stringify({ title: 'catatan A', body: 'isi A', projectId: 'alpha' }),
  })).json();
  assert.ok(a.id);
  assert.equal(a.pinned, false);
  assert.equal(a.projectId, 'alpha');

  const b = await (await api('/api/notes', {
    method: 'POST', body: JSON.stringify({ title: 'catatan B', body: 'isi B', pinned: true }),
  })).json();

  // yang disematkan tampil lebih dulu
  const list = await (await api('/api/notes')).json();
  assert.equal(list[0].id, b.id);
  assert.equal(list[0].projectId, 'global');

  const patched = await (await api(`/api/notes/${a.id}`, {
    method: 'POST', body: JSON.stringify({ title: 'A baru', pinned: true }),
  })).json();
  assert.equal(patched.title, 'A baru');
  assert.equal(patched.pinned, true);

  // state & status ikut membawa notes
  const st = await (await api('/api/state')).json();
  assert.equal(st.notes.length, 2);
  const status = await (await api('/api/status')).json();
  assert.equal(status.notes, 2);

  const del = await api(`/api/notes/${a.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await (await api('/api/notes')).json();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, b.id);
});

test('key baru otomatis masuk pool gateway (autoPool)', async () => {
  const st = await (await api('/api/state')).json();
  assert.equal(st.config.autoPool, true);

  const r = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-uji-promo', baseUrl: 'http://127.0.0.1:9/v1', poolModel: 'uji/model-gratis' }),
  });
  assert.equal(r.status, 200);
  const { entry } = await r.json();
  assert.equal(entry.pool, true);
  assert.equal(entry.poolModel, 'uji/model-gratis');

  // autoPool dimatikan → key berikutnya tidak masuk pool
  const off = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autoPool: false }) });
  assert.equal(off.status, 200);
  const r2 = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-uji-promo-2', baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  const { entry: e2 } = await r2.json();
  assert.equal(e2.pool, false);

  const st2 = await (await api('/api/state')).json();
  assert.equal(st2.config.autoPool, false);
});
