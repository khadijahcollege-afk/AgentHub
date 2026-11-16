// test/threads-export.test.js — ekspor thread (md/json) dan fork/cabang:
// kontrak HTTP + isi berkas. Server sungguhan dengan data dir sementara.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8760, 20);
const TOKEN = 'exporttok0123456789';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-exp-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
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

test('ekspor thread: markdown & JSON, header unduhan benar', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Riset kopi', engine: 'claude', tags: ['uji', 'ekspor'] }) })).json();
  threadsAppend(t.id, 'user', 'Apa beda arabika dan robusta?');
  threadsAppend(t.id, 'assistant', 'Arabika lebih asam & aromatik; robusta lebih pahit & kafein.', 'claude');

  const mdRes = await api(`/api/threads/${t.id}/export`);
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get('content-type'), /markdown/);
  assert.match(mdRes.headers.get('content-disposition'), /\.md"/);
  const md = await mdRes.text();
  assert.match(md, /^# Riset kopi/m, 'judul di header');
  assert.match(md, /## Pengguna/m, 'pesan user');
  assert.match(md, /## Assistant \(claude\)/m, 'pesan assistant dengan engine');
  assert.match(md, /arabika dan robusta/m, 'isi pesan ada');
  assert.match(md, /Tag: uji, ekspor/m, 'tag ikut diekspor');

  const jsonRes = await api(`/api/threads/${t.id}/export?format=json`);
  assert.match(jsonRes.headers.get('content-type'), /json/);
  const json = JSON.parse(await jsonRes.text());
  assert.equal(json.app, 'AgentHub');
  assert.equal(json.thread.title, 'Riset kopi');
  assert.equal(json.thread.messages.length, 2);

  // thread tak dikenal → 404, bukan ekspor kosong palsu
  assert.equal((await api('/api/threads/ffffffffffffffffffffffffffffffff/export')).status, 404);
  // tanpa token → 401
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/threads/${t.id}/export`)).status, 401);
});

test('fork thread: salin sampai pesan acuan, mode edit tidak membawa pesan itu', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Asal fork', engine: 'pool' }) })).json();
  const m1 = threadsAppend(t.id, 'user', 'pertanyaan pertama');
  threadsAppend(t.id, 'assistant', 'jawaban pertama');
  const m3 = threadsAppend(t.id, 'user', 'pertanyaan kedua (salah tulis)');
  threadsAppend(t.id, 'assistant', 'jawaban kedua');

  // fork TERMASUK pesan acuan (branching biasa)
  const inc = await (await api(`/api/threads/${t.id}/fork`, { method: 'POST', body: JSON.stringify({ until: m1.id, include: true }) })).json();
  assert.equal(inc.messages, 1, 'fork include: satu pesan');
  const incThread = await (await api(`/api/threads/${inc.id}`)).json();
  assert.match(incThread.title, /\(cabang\)/, 'judul membawa tanda cabang');

  // fork TANPA pesan acuan (alur edit pesan)
  const edit = await (await api(`/api/threads/${t.id}/fork`, { method: 'POST', body: JSON.stringify({ until: m3.id, include: false }) })).json();
  assert.equal(edit.messages, 2, 'fork exclude: dua pesan sebelum acuan');

  // pesan acuan tidak ada → 400 jelas
  const bad = await api(`/api/threads/${t.id}/fork`, { method: 'POST', body: JSON.stringify({ until: 'ffffffffffffffffffffffffffffffff' }) });
  assert.equal(bad.status, 400);
  // thread asal tidak tersentuh
  const orig = await (await api(`/api/threads/${t.id}`)).json();
  assert.equal(orig.messages.length, 4, 'thread asal utuh');
});

// helper tulis pesan langsung via API pasangan (user) / balasan echo palsu
// tidak perlu run sungguhan — cukup appendMessage lewat modul di server:
// test pakai endpoint internal yang sama dengan UI? Tidak ada endpoint append
// publik, jadi tulis berkas threads.json lewat API fork-aman berikut.
function threadsAppend(threadId, role, content, engine) {
  // tulis langsung ke data dir: bentuk sama seperti appendMessage()
  const file = path.join(dataDir, 'threads.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = all.find((x) => x.id === threadId);
  t.messages = [...(t.messages || []), { id: crypto.randomUUID().replaceAll('-', ''), role, content, ...(engine ? { engine } : {}), ts: Date.now() }];
  t.updatedAt = Date.now();
  if (role === 'user' && (t.title === 'Chat baru' || !t.title)) t.title = content.slice(0, 60);
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
  return t.messages[t.messages.length - 1];
}
