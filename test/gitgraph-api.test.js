// test/gitgraph-api.test.js — grafik git dan pindah cabang lewat HTTP.
//
// Yang diuji di sini adalah kontrak rute: bentuk balasan, kode status untuk
// keadaan yang berbeda (bukan repo, tanpa folder kerja, worktree kotor), dan
// bahwa pindah cabang benar-benar menyegarkan klien lain lewat SSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickFreePort } from './helpers/port.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = 'tokengitgraph123456';
const PORT = await pickFreePort(8200);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-api-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-repo-'));
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-plain-'));
let child = null;

const gitOk = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(message, file = 'a.txt', content = message) {
  fs.writeFileSync(path.join(repo, file), content + '\n');
  git('add', '.');
  git('-c', 'user.name=uji', '-c', 'user.email=uji@contoh.test', 'commit', '-m', message);
}

const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

test.before(async () => {
  if (gitOk) {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'uji');
    git('config', 'user.email', 'uji@contoh.test');
    commit('pertama');
    commit('kedua');
    git('checkout', '-q', '-b', 'fitur');
    commit('di fitur', 'b.txt');
    commit('a.txt versi fitur', 'a.txt', 'versi fitur');
    git('checkout', '-q', 'main');
  }

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'threads.json'), JSON.stringify([
    { id: 'aaaa11112222', title: 'Repo', engine: 'pool', cwd: repo, messages: [], createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'bbbb33334444', title: 'Folder biasa', engine: 'pool', cwd: plain, messages: [], createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'cccc55556666', title: 'Tanpa folder', engine: 'pool', messages: [], createdAt: Date.now(), updatedAt: Date.now() },
  ]));

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, AGENTHUB_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const d of [dataDir, repo, plain]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('grafik: bentuk balasan memuat commit, edge, rail, dan lebar pita', { skip: !gitOk }, async () => {
  const r = await api('/api/threads/aaaa11112222/git/graph');
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.equal(g.repo, true);
  assert.ok(Array.isArray(g.commits) && g.commits.length >= 4);
  assert.ok(Array.isArray(g.edges));
  assert.ok(Array.isArray(g.rails));
  assert.equal(typeof g.lanes, 'number');
  // Setiap commit membawa lane yang sudah dihitung server: UI tidak menghitung.
  for (const c of g.commits) {
    assert.equal(typeof c.lane, 'number');
    assert.ok(c.sha && c.subject);
    assert.ok(Array.isArray(c.refs));
    assert.ok(Array.isArray(c.parents));
  }
  assert.ok(g.commits.flatMap((c) => c.refs).includes('main'), 'ref main terbaca');
});

test('grafik: bukan repo dijawab repo:false, bukan error', async () => {
  const r = await api('/api/threads/bbbb33334444/git/graph');
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.equal(g.repo, false);
  assert.deepEqual(g.commits, []);
});

test('grafik: thread tanpa folder kerja dijawab 400 WORKSPACE_MISSING', async () => {
  const r = await api('/api/threads/cccc55556666/git/graph');
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.code, 'WORKSPACE_MISSING');
});

test('grafik: maxCount dari klien dibatasi, bukan dipercaya', { skip: !gitOk }, async () => {
  const r = await api('/api/threads/aaaa11112222/git/graph?maxCount=100000');
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.ok(g.commits.length <= 200, 'batas 200 commit ditegakkan di server');
});

test('cabang: daftar memuat cabang aktif dan cabang lain', { skip: !gitOk }, async () => {
  const r = await api('/api/threads/aaaa11112222/git/branches');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.repo, true);
  assert.equal(b.current, 'main');
  const names = b.branches.map((x) => x.name);
  assert.ok(names.includes('main') && names.includes('fitur'));
});

test('cabang: pindah berhasil, dan perubahan terlihat oleh thread itu', { skip: !gitOk }, async () => {
  const r = await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'fitur' }) });
  assert.equal(r.status, 200, await r.clone().text());
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.branch, 'fitur');
  // Workspace summary membaca cabang yang sama: satu sumber kebenaran.
  const w = await (await api('/api/threads/aaaa11112222/workspace')).json();
  assert.equal(w.branch, 'fitur');
  // b.txt hanya ada di cabang ini, jadi harus muncul sebagai file terlacak bersih.
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
});

test('cabang: nama tidak dikenal dijawab 400, bukan 500', { skip: !gitOk }, async () => {
  const r = await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'tidak-ada' }) });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.code, 'BRANCH_UNKNOWN');
});

test('cabang: worktree kotor dijawab 409 dan perubahannya tidak dibuang', { skip: !gitOk }, async () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'belum di-commit\n');
  const r = await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'fitur' }) });
  assert.equal(r.status, 409, await r.clone().text());
  const b = await r.json();
  assert.equal(b.code, 'WORKTREE_DIRTY');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').trim(), 'belum di-commit', 'perubahan pengguna utuh');
  git('checkout', '--', 'a.txt');
});

test('cabang: checkout pada thread tanpa folder kerja ditolak 400', async () => {
  const r = await api('/api/threads/cccc55556666/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
  assert.equal(r.status, 400);
});

test('pindah cabang mendorong SSE workspace agar klien lain ikut menyegarkan', { skip: !gitOk }, async () => {
  // Berlangganan SSE, lalu pindah cabang: klien lain tidak boleh tertinggal
  // menampilkan cabang lama.
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/events?token=${TOKEN}`, { signal: ctrl.signal });
  assert.equal(sse.status, 200);
  const seen = [];
  const reader = sse.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (line.startsWith('data: ')) {
            try { seen.push(JSON.parse(line.slice(6)).scope); } catch { /* bukan JSON */ }
          }
        }
      }
    } catch { /* dibatalkan */ }
  })();

  await new Promise((r) => setTimeout(r, 300));
  const r = await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'fitur' }) });
  assert.equal(r.status, 200);
  for (let i = 0; i < 40 && !seen.includes('workspace'); i++) await new Promise((res) => setTimeout(res, 100));
  ctrl.abort();
  await pump.catch(() => {});
  assert.ok(seen.includes('workspace'), `scope workspace harus terkirim, dapat ${JSON.stringify(seen)}`);
  await api('/api/threads/aaaa11112222/git/checkout', { method: 'POST', body: JSON.stringify({ branch: 'main' }) });
});
