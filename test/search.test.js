// test/search.test.js — pencarian global lintas thread, tugas, catatan, proyek.
// Data ditulis langsung ke data dir sebelum server hidup supaya tes tidak
// bergantung pada engine/CLI yang terpasang di mesin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Band port unik per file tes: promo 8240–8299, uploads 8300–8359.
const PORT = 8360 + Math.floor(Math.random() * 60);
const TOKEN = 'searchtoken0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let deployDir;

const api = (p) => fetch(API + p, { headers: { authorization: `Bearer ${TOKEN}` } });

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-search-'));
  deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-deploy-'));
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: now,
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: now,
  }));
  fs.writeFileSync(path.join(dataDir, 'threads.json'), JSON.stringify([
    {
      id: 'a1b2c3d4', title: 'Perbaiki login OAuth', projectId: 'default', engine: 'echo',
      messages: [
        { id: 'm1', role: 'user', content: 'Token kedaluwarsa di halaman login', ts: now - 5000 },
        { id: 'm2', role: 'assistant', content: 'Cek refresh token dan rotasi kunci', ts: now - 4000 },
      ],
      runState: 'done', createdAt: now - 9000, updatedAt: now - 4000,
    },
    {
      id: 'b2c3d4e5', title: 'Login gagal di produksi', projectId: 'default', engine: 'echo',
      messages: [{ id: 'm3', role: 'user', content: 'Error 500 saat login', ts: now - 8000 }],
      runState: 'done', createdAt: now - 10000, updatedAt: now - 8000,
    },
    {
      id: 'c3d4e5f6', title: 'Catatan rilis', projectId: 'default', engine: 'echo',
      messages: [{ id: 'm4', role: 'user', content: 'Tidak ada kata kunci di sini', ts: now - 7000 }],
      runState: 'done', createdAt: now - 11000, updatedAt: now - 7000,
    },
  ]));
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify([
    { id: 'aaaa1111', title: 'Deploy ulang layanan login', status: 'todo', projectId: 'default', statusAt: { todo: now }, createdAt: now, updatedAt: now },
    { id: 'bbbb2222', title: 'Tulis dokumentasi', status: 'todo', projectId: 'default', statusAt: { todo: now }, createdAt: now, updatedAt: now },
  ]));
  fs.writeFileSync(path.join(dataDir, 'notes.json'), JSON.stringify([
    { id: 'cccc3333', title: 'Insight login', body: 'Refresh token harus dirotasi setiap 30 hari', projectId: 'global', pinned: false, createdAt: now, updatedAt: now },
    { id: 'dddd4444', title: 'Ide lain', body: 'Tidak relevan', projectId: 'global', pinned: false, createdAt: now, updatedAt: now },
  ]));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([
    { id: 'eeee5555', name: 'Deploy API', folders: [deployDir], primaryFolder: deployDir, createdAt: now, updatedAt: now },
  ]));

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const dir of [dataDir, deployDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

async function search(q, extra = '') {
  const r = await api(`/api/search?q=${encodeURIComponent(q)}${extra}`);
  assert.equal(r.status, 200);
  return r.json();
}

test('search: judul thread, isi pesan, dan case-insensitive', async () => {
  const byTitle = await search('oauth');
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.groups.threads[0].id, 'a1b2c3d4');
  assert.equal(byTitle.groups.threads[0].where, 'judul');
  assert.match(byTitle.groups.threads[0].snippet, /OAuth/);

  const byMessage = await search('rotasi');
  const thread = byMessage.groups.threads.find((t) => t.id === 'a1b2c3d4');
  assert.equal(thread.where, 'jawaban agent');
  assert.match(thread.snippet, /rotasi kunci/);

  const upper = await search('LOGIN');
  assert.equal(upper.groups.threads.length, 2, 'harus menemukan dua judul/pesan login');
});

test('search: tugas, catatan, dan proyek ikut ditemukan', async () => {
  const deploy = await search('deploy');
  assert.equal(deploy.groups.tasks.length, 1);
  assert.equal(deploy.groups.tasks[0].title, 'Deploy ulang layanan login');
  assert.equal(deploy.groups.projects.length, 1);
  assert.equal(deploy.groups.projects[0].name, 'Deploy API');

  const note = await search('dirotasi');
  assert.equal(note.groups.notes.length, 1);
  assert.equal(note.groups.notes[0].where, 'isi catatan');
  assert.match(note.groups.notes[0].snippet, /dirotasi/);
});

test('search: batas per grup, kueri pendek, dan karakter regex aman', async () => {
  const limited = await search('login', '&limit=1');
  assert.equal(limited.groups.threads.length, 1);
  assert.equal(limited.groups.tasks.length, 1);
  assert.equal(limited.groups.notes.length, 1);
  assert.equal(limited.truncated, true, 'harus melaporkan hasil yang dipotong');

  const short = await search('a');
  assert.equal(short.total, 0, 'satu huruf tidak boleh membanjiri hasil');
  assert.equal(short.q, 'a');

  const bracket = await search('[');
  assert.equal(bracket.total, 0, 'kueri bukan RegExp — tidak boleh error');

  const empty = await search('   ');
  assert.equal(empty.total, 0);
  assert.equal(empty.q, '');
});

test('search: normalisasi spasi dan batas panjang kueri', async () => {
  const spaced = await search('  refresh   token  ');
  assert.equal(spaced.q, 'refresh token');
  assert.ok(spaced.groups.threads.some((t) => t.id === 'a1b2c3d4'));

  const long = await search('x'.repeat(300));
  assert.equal(long.q.length, 120);
});
