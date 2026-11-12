// test/uploads.test.js — lampiran file/gambar di composer.
// Bagian murni menguji sanitasi nama, tipe, dan augmentasi prompt tanpa disk
// pengguna; bagian HTTP menguji route upload, validasi /send, dan metadata yang
// tersimpan di thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  safeName, safeType, saveUpload, augmentPrompt, MAX_ATTACHMENT_BYTES,
} from '../lib/uploads.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8300 + Math.floor(Math.random() * 60);
const TOKEN = 'uploadtoken0123456789abc';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let tmp;
let txtPath;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: {
    authorization: `Bearer ${TOKEN}`,
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
  },
});

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-uploads-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-upload-files-'));
  txtPath = path.join(tmp, 'catatan.txt');
  fs.writeFileSync(txtPath, 'rotasi kunci di gateway', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const dir of [dataDir, tmp]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// ---------- murni ----------
test('nama file selalu basename dan karakter berbahaya diganti', () => {
  assert.equal(safeName('../../evil.txt'), 'evil.txt');
  assert.equal(safeName('C:\\Users\\a\\laporan.md'), 'laporan.md');
  assert.equal(safeName('folder/sub/foto.png'), 'foto.png');
  assert.equal(safeName('a\u0000b\u001fc.txt'), 'a_b_c.txt');
  assert.equal(safeName('<>:"|?*'), '_______');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName(''), 'file');
  assert.ok(safeName('x'.repeat(400)).length <= 120);
});

test('tipe file: valid dipakai, kosong/aneh ditebak dari ekstensi', () => {
  assert.equal(safeType('image/png', 'a.png'), 'image/png');
  assert.equal(safeType('', 'foto.JPEG'), 'image/jpeg');
  assert.equal(safeType('bukan tipe', 'catatan.md'), 'text/markdown');
  assert.equal(safeType('', 'tanpa-ekstensi'), 'application/octet-stream');
});

test('upload kosong, base64 rusak, dan file kebesaran ditolak tanpa menulis', () => {
  assert.throws(() => saveUpload({ name: 'a.txt', data: '' }), (e) => e.code === 'UPLOAD_INVALID');
  assert.throws(() => saveUpload({ name: 'a.txt' }), (e) => e.code === 'UPLOAD_INVALID');
  assert.throws(() => saveUpload({ name: 'a.txt', data: '%%%bukan base64' }), (e) => e.code === 'UPLOAD_INVALID');
  const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64');
  assert.throws(() => saveUpload({ name: 'big.bin', data: huge }), (e) => e.code === 'UPLOAD_TOO_LARGE');
});

test('augmentPrompt: CLI dapat path, pool dapat isi teks tanpa path', async () => {
  const text = fs.readFileSync(txtPath, 'utf8');
  const meta = { name: 'catatan.txt', type: 'text/plain', bytes: Buffer.byteLength(text), path: txtPath };

  const cli = await augmentPrompt('tolong baca', [meta], { includePaths: true, inlineText: false });
  assert.match(cli, /Lampiran:/);
  assert.match(cli, /catatan\.txt/);
  assert.ok(cli.includes(txtPath));
  assert.doesNotMatch(cli, /rotasi kunci di gateway/);

  const pool = await augmentPrompt('', [meta], { includePaths: false, inlineText: true });
  assert.match(pool, /--- catatan\.txt ---/);
  assert.match(pool, /rotasi kunci di gateway/);
  assert.ok(!pool.includes(txtPath), 'path lokal tidak boleh bocor ke gateway');

  assert.equal(await augmentPrompt('saja', []), 'saja');
});

// ---------- HTTP ----------
test('upload: metadata bersih, isi bisa diunduh, hapus idempoten', async () => {
  const up = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: '../../catatan.txt', type: 'text/plain', data: b64('isi rahasia') }),
  });
  assert.equal(up.status, 200);
  const meta = await up.json();
  assert.match(meta.id, /^[a-f0-9]+$/);
  assert.equal(meta.name, 'catatan.txt');
  assert.equal(meta.type, 'text/plain');
  assert.equal(meta.bytes, 11);
  assert.equal('path' in meta, false, 'path server tidak diekspos ke UI');

  const got = await api(`/api/uploads/${meta.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-disposition'), /^attachment/);
  assert.equal(await got.text(), 'isi rahasia');

  const del = await api(`/api/uploads/${meta.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await api(`/api/uploads/${meta.id}`)).status, 404);
  assert.equal((await api(`/api/uploads/${meta.id}`, { method: 'DELETE' })).status, 404);
});

test('/send: id lampiran tak dikenal ditolak sebelum pesan ditulis', async () => {
  const thread = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool' }),
  })).json();
  const res = await api(`/api/threads/${thread.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'halo', attachments: ['deadbeefdeadbeef'] }),
  });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.code, 'ATTACHMENT_INVALID');

  const after = await (await api(`/api/threads/${thread.id}`)).json();
  assert.equal(after.messages.length, 0, 'tidak ada pesan setengah jadi');
  assert.notEqual(after.runState, 'running');
});

test('/send: lebih dari 5 lampiran ditolak tanpa menyentuh disk', async () => {
  const thread = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool' }),
  })).json();
  const res = await api(`/api/threads/${thread.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'x', attachments: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'ATTACHMENT_LIMIT');
});

test('/send: lampiran saja (prompt kosong) tersimpan dengan isi inline', async () => {
  const up = await (await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: 'catatan.txt', type: 'text/plain', data: b64('rotasi kunci di gateway') }),
  })).json();
  const thread = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool' }),
  })).json();

  // Gateway tanpa key → run gagal cepat, tetapi pesan user + lampiran harus
  // sudah tercatat sebelum engine dipanggil.
  const res = await api(`/api/threads/${thread.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: '', attachments: [up.id] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const sse = await res.text(); // habiskan SSE sampai selesai
  assert.ok(sse.startsWith(': connected'), 'header SSE di-flush sebelum engine mulai');

  const after = await (await api(`/api/threads/${thread.id}`)).json();
  const user = after.messages.find((m) => m.role === 'user');
  assert.ok(user, 'pesan user harus ada walau prompt kosong');
  assert.equal(user.content, '');
  assert.equal(user.attachments.length, 1);
  assert.equal(user.attachments[0].id, up.id);
  assert.equal(user.attachments[0].name, 'catatan.txt');
  assert.match(user.modelContent, /--- catatan\.txt ---/);
  assert.match(user.modelContent, /rotasi kunci di gateway/);
  assert.ok(!user.modelContent.includes(dataDir), 'path server tidak boleh masuk konten model');
  assert.equal(after.title, 'catatan.txt', 'judul thread diambil dari nama lampiran');
});
