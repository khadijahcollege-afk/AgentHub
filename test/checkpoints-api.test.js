// test/checkpoints-api.test.js — rute checkpoint lewat server nyata: snapshot
// manual, daftar, diff, restore, konflik 409, dan pembersihan saat thread dihapus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8900, 40);
const TOKEN = 'cptok0123456789abc';
const API = `http://127.0.0.1:${PORT}`;

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

let child;
let dataDir;
let repo;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});
const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readText = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-api-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-api-repo-'));
  if (GIT) {
    g('init', '-b', 'main');
    g('config', 'user.email', 'uji@contoh.test');
    g('config', 'user.name', 'Uji');
    g('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'catatan.txt'), 'asli\n');
    g('add', '-A');
    g('commit', '-m', 'awal');
  }
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
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1', AGENTHUB_STRICT_PORT: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  for (const d of [dataDir, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

let threadId;

test('snapshot manual lewat API, lalu daftar memuatnya', { skip: !GIT }, async () => {
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool', cwd: repo }),
  })).json();
  threadId = t.id;

  const r = await api(`/api/threads/${threadId}/checkpoints`, { method: 'POST', body: JSON.stringify({ label: 'awal' }) });
  assert.equal(r.status, 200);
  const cp = await r.json();
  assert.equal(cp.label, 'awal');
  assert.equal(cp.files >= 1, true);

  const list = await (await api(`/api/threads/${threadId}/checkpoints`)).json();
  assert.equal(list.checkpoints.length, 1);
  assert.equal(list.checkpoints[0].id, cp.id);
});

test('diff antara dua snapshot, restore berkas yang berubah', { skip: !GIT }, async () => {
  const first = (await (await api(`/api/threads/${threadId}/checkpoints`)).json()).checkpoints[0];
  fs.writeFileSync(path.join(repo, 'catatan.txt'), 'diubah agent\n');
  fs.writeFileSync(path.join(repo, 'baru.txt'), 'baru\n');
  const second = await (await api(`/api/threads/${threadId}/checkpoints`, {
    method: 'POST', body: JSON.stringify({ label: 'sesudah' }),
  })).json();

  const d = await (await api(`/api/threads/${threadId}/checkpoints/${second.id}/diff?from=${first.id}`)).json();
  assert.equal(d.count, 2);

  const res = await api(`/api/threads/${threadId}/checkpoints/${first.id}/restore`, {
    method: 'POST', body: JSON.stringify({ fromId: second.id, paths: ['catatan.txt', 'baru.txt'] }),
  });
  assert.equal(res.status, 200);
  assert.equal(readText('catatan.txt'), 'asli\n');
  assert.equal(fs.existsSync(path.join(repo, 'baru.txt')), false);
});

test('konflik dilaporkan 409 dengan daftar path, bukan ditimpa diam-diam', { skip: !GIT }, async () => {
  const base = await (await api(`/api/threads/${threadId}/checkpoints`, {
    method: 'POST', body: JSON.stringify({ label: 'base' }),
  })).json();
  fs.writeFileSync(path.join(repo, 'catatan.txt'), 'target\n');
  const target = await (await api(`/api/threads/${threadId}/checkpoints`, {
    method: 'POST', body: JSON.stringify({ label: 'target' }),
  })).json();
  // perubahan setelah snapshot target: tidak tercatat di checkpoint mana pun
  fs.writeFileSync(path.join(repo, 'catatan.txt'), 'menyimpang\n');

  const res = await api(`/api/threads/${threadId}/checkpoints/${target.id}/restore`, {
    method: 'POST', body: JSON.stringify({ fromId: base.id, paths: ['catatan.txt'] }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'CHECKPOINT_CONFLICT');
  assert.equal(body.conflicts.length, 1);
  assert.equal(readText('catatan.txt'), 'menyimpang\n', 'penolakan tidak mengubah berkas');

  const forced = await api(`/api/threads/${threadId}/checkpoints/${target.id}/restore`, {
    method: 'POST', body: JSON.stringify({ fromId: base.id, paths: ['catatan.txt'], force: true }),
  });
  assert.equal(forced.status, 200);
  assert.equal(readText('catatan.txt'), 'target\n');
});

test('validasi: checkpoint asing 404, thread tanpa folder 400, diff tanpa from 400', { skip: !GIT }, async () => {
  const r1 = await api(`/api/threads/${threadId}/checkpoints/ffffffffffffffffffffffff/restore`, {
    method: 'POST', body: JSON.stringify({}),
  });
  assert.equal(r1.status, 404);

  const plain = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'pool' }) })).json();
  const r2 = await api(`/api/threads/${plain.id}/checkpoints`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r2.status, 400);

  const cp = (await (await api(`/api/threads/${threadId}/checkpoints`)).json()).checkpoints[0];
  const r3 = await api(`/api/threads/${threadId}/checkpoints/${cp.id}/diff`);
  assert.equal(r3.status, 400);
});

test('folder bukan repo ditolak 409 tanpa membuat entri', { skip: !GIT }, async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-api-plain-'));
  try {
    const t = await (await api('/api/threads', {
      method: 'POST', body: JSON.stringify({ engine: 'pool', cwd: plain }),
    })).json();
    const r = await api(`/api/threads/${t.id}/checkpoints`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(r.status, 409);
    const list = await (await api(`/api/threads/${t.id}/checkpoints`)).json();
    assert.equal(list.checkpoints.length, 0);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('menghapus thread membersihkan checkpoint-nya', { skip: !GIT }, async () => {
  const before = await (await api(`/api/threads/${threadId}/checkpoints`)).json();
  assert.equal(before.checkpoints.length > 0, true);
  assert.equal((await api(`/api/threads/${threadId}`, { method: 'DELETE' })).status, 200);

  // thread baru dengan id berbeda tidak mewarisi checkpoint lama
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool', cwd: repo }),
  })).json();
  const after = await (await api(`/api/threads/${t.id}/checkpoints`)).json();
  assert.equal(after.checkpoints.length, 0);
  const refs = g('for-each-ref', '--format=%(refname)', 'refs/agenthub/').trim();
  const stale = refs.split('\n').filter(Boolean).filter((r) => r.includes(String(threadId)));
  assert.equal(stale.length, 0, 'ref checkpoint thread terhapus ikut dibersihkan');
});
