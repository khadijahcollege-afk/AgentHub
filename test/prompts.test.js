// test/prompts.test.js — prompt library: simpan, pakai ulang, pin, hapus.
// Voice input tidak bisa diuji headless (butuh mikrofon); yang diuji adalah
// kontrak UI-nya (tombol & pengaman feature-detect) di akhir berkas ini.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8460 + Math.floor(Math.random() * 30);
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-prompts-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 6,
    agentCheckMinutes: 15, keyCheckHours: 12, baselined: false, createdAt: Date.now(),
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

test('prompts: buat, list terbaru dulu, patch, hapus', async () => {
  const a = await (await api('/api/prompts', {
    method: 'POST',
    body: JSON.stringify({ body: 'Review kode folder ini dan ringkas risikonya.' }),
  })).json();
  assert.ok(a.id, 'id dibuat');
  assert.equal(a.title, 'Review kode folder ini dan ringkas risikonya.', 'judul default dari baris pertama');

  const b = await (await api('/api/prompts', {
    method: 'POST',
    body: JSON.stringify({ title: 'Rutin commit', body: 'Commit dengan pesan konvensional.' }),
  })).json();

  let list = await (await api('/api/prompts')).json();
  assert.deepEqual(list.map((p) => p.id), [b.id, a.id], 'terbaru dulu');

  // body kosong ditolak
  assert.equal((await api('/api/prompts', { method: 'POST', body: JSON.stringify({ body: '   ' }) })).status, 400);

  const patched = await (await api(`/api/prompts/${b.id}`, {
    method: 'POST',
    body: JSON.stringify({ pinned: true }),
  })).json();
  assert.equal(patched.pinned, true);
  list = await (await api('/api/prompts')).json();
  assert.equal(list[0].id, b.id, 'pin naik ke atas');

  assert.equal((await api(`/api/prompts/tidakada0000`, { method: 'POST', body: JSON.stringify({ pinned: true }) })).status, 404);

  await api(`/api/prompts/${a.id}`, { method: 'DELETE' });
  list = await (await api('/api/prompts')).json();
  assert.deepEqual(list.map((p) => p.id), [b.id]);
  assert.equal((await api(`/api/prompts/${a.id}`, { method: 'DELETE' })).status, 200, 'hapus dua kali tetap ok');
});

test('prompts: 401 tanpa token dan tanpa kebocoran ke static', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/prompts`);
  assert.equal(r.status, 401);
});

test('UI: tombol prompt & voice tersedia, voice tersembunyi bila tak didukung', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  for (const id of ['btn-prompts', 'btn-voice', 'prompts-pop', 'prompts-rows', 'prompt-save-title', 'btn-prompt-save']) {
    assert.ok(html.includes(`id="${id}"`), `${id} wajib ada di composer/HTML`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /SpeechRecognition \|\| window\.webkitSpeechRecognition/, 'feature-detect dikte');
  assert.match(app, /lang = 'id-ID'/, 'dikte default Bahasa Indonesia');
  assert.match(app, /case 'prompt'/, 'slash /prompt membuka library');
  assert.match(app, /case 'save'/, 'slash /save menyimpan prompt');
  // layer prompts wajib bagian mesin UI
  const machines = fs.readFileSync(path.join(ROOT, 'lib/machines.js'), 'utf8');
  assert.match(machines, /'prompts'/, 'layer prompts bagian dari UI_LAYERS');
});
