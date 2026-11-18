// test/share.test.js — tautan baca-saja (REA ZCode conversationShare):
// buat → publik 200 berisi isi → kedaluwarsa/cabut → 404; manage butuh token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShare, getShare, revokeShare } from '../lib/share.js';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8980, 40);
const TOKEN = 'sharetok01234567890';
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

test('share unit: cabut & kedaluwarsa membuat tautan mati', () => {
  const savedData = process.env.AGENTHUB_DATA;
  // lib/share membaca AGENTHUB_DATA saat import — set dulu ke folder uji
  process.env.AGENTHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-share-unit-'));
  try {
    const s = createShare('thread-x', { days: 1, title: 'uji' });
    assert.ok(getShare(s.id), 'tautan aktif terbaca');
    assert.equal(revokeShare(s.id), true);
    assert.equal(getShare(s.id), null, 'dicabut = mati');
    // masa berlaku invalid ditolak
    assert.throws(() => createShare('thread-x', { days: 3 }), /Masa berlaku/);
    // satu tautan aktif per thread: buat lagi → id sama, diperpanjang
    const a = createShare('thread-y', { days: 1 });
    const b = createShare('thread-y', { days: 1 });
    assert.equal(a.id, b.id, 'idempoten per thread');
  } finally {
    fs.rmSync(process.env.AGENTHUB_DATA, { recursive: true, force: true });
    if (savedData === undefined) delete process.env.AGENTHUB_DATA; else process.env.AGENTHUB_DATA = savedData;
  }
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-share-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1', AGENTHUB_STRICT_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Simpan keluaran server: kalau boot gagal, pesan aslinya (port terpakai,
  // config rusak, import gagal) jauh lebih berguna daripada "server harus hidup".
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  const up = await waitUp();
  assert.equal(up, true, `server harus hidup (port ${PORT}, keluar: ${exited ? JSON.stringify(exited) : 'tidak'})\n${bootLog.slice(-800)}`);
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('share: buat tautan → halaman publik berisi isi tanpa token', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Rencana rilis', engine: 'pool' }) })).json();
  // isi thread: tulis lewat /send tanpa engine? pool kosong → gagal run.
  // Tulis pesan lewat berkas data (pola sama dengan tes ekspor).
  const file = path.join(dataDir, 'threads.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const th = all.find((x) => x.id === t.id);
  th.messages = [
    { id: 'a'.repeat(32), role: 'user', content: 'Kirim **ringkasan** rilis', ts: Date.now() },
    { id: 'b'.repeat(32), role: 'assistant', engine: 'glm-5.3-flash', content: 'Rilis berisi:\n- fitur baru\n```js\nconsole.log("hai")\n```', ts: Date.now() },
  ];
  fs.writeFileSync(file, JSON.stringify(all, null, 1));

  const r = await api(`/api/threads/${t.id}/share`, { method: 'POST', body: JSON.stringify({ days: 7 }) });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(s.url.includes(`/share/${s.id}`), 'url tautan benar');

  // tanpa token → halaman publik tetap terbuka (itu intinya)
  const pub = await fetch(`http://127.0.0.1:${PORT}/share/${s.id}`);
  assert.equal(pub.status, 200);
  const html = await pub.text();
  assert.match(html, /Rencana rilis/, 'judul ada');
  assert.match(html, /Kirim <b>ringkasan<\/b>/, 'markdown dipakai');
  assert.match(html, /fitur baru/, 'isi pesan ada');
  assert.match(html, /noindex/, 'noindex untuk mesin pencari');
  assert.ok(!html.includes(TOKEN), 'token akses tidak pernah bocor');

  // kelola: daftar + cabut
  const list = await (await api('/api/shares')).json();
  assert.ok(list.some((x) => x.id === s.id), 'tautan terdaftar');
  assert.equal((await api(`/api/shares/${s.id}/revoke`, { method: 'POST' })).status, 200);
  const dead = await fetch(`http://127.0.0.1:${PORT}/share/${s.id}`);
  assert.equal(dead.status, 404, 'dicabut → halaman mati');

  // kelola tanpa token → 401
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/shares`)).status, 401);
  // days invalid → 400
  assert.equal((await api(`/api/threads/${t.id}/share`, { method: 'POST', body: JSON.stringify({ days: 5 }) })).status, 400);
});
