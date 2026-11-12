// test/workspace.test.js — folder kerja per thread, laporan perubahan, revert,
// dan aturan proyek. Semua menyentuh file nyata di folder sementara, jadi tes
// ini memakai repo git sungguhan (bukan mock) dan melewati dirinya sendiri bila
// git tidak tersedia di mesin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8180 + Math.floor(Math.random() * 60);
const TOKEN = 'workspacetoken0123456789';
const API = `http://127.0.0.1:${PORT}`;

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

let child;
let dataDir;
let repo;
let plain;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function git(args) {
  return execFileSync('git', ['-c', 'user.name=AgentHub Test', '-c', 'user.email=test@agenthub.local', ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-workspace-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-repo-'));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plain-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  if (GIT) {
    git(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'satu\n');
    git(['add', 'app.txt']);
    git(['commit', '-qm', 'awal']);
  }
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const dir of [dataDir, repo, plain]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

async function newThread(cwd) {
  const r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo', cwd }) });
  assert.equal(r.status, 200);
  return r.json();
}

test('thread: folder kerja tervalidasi, dipersistensi, dan bisa diubah', async () => {
  const t = await newThread(repo);
  assert.equal(t.cwd, repo);

  const got = await (await api(`/api/threads/${t.id}`)).json();
  assert.equal(got.cwd, repo);

  // folder yang tidak ada ditolak sebelum thread dibuat
  const bad = await api('/api/threads', { method: 'POST', body: JSON.stringify({ cwd: path.join(repo, 'tidak-ada') }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'WORKSPACE_INVALID');

  // patch cwd juga divalidasi
  const patched = await (await api(`/api/threads/${t.id}`, { method: 'POST', body: JSON.stringify({ cwd: plain }) })).json();
  assert.equal(patched.cwd, plain);
});

test('workspace: cek folder bebas tanpa membuat thread', async () => {
  const before = await (await api('/api/threads')).json();
  const ok = await api(`/api/workspace/check?cwd=${encodeURIComponent(plain)}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, cwd: plain });

  // path relatif, folder hilang, dan parameter kosong ditolak dengan kode mesin
  const relative = await api('/api/workspace/check?cwd=relatif');
  assert.equal(relative.status, 400);
  const missing = await api(`/api/workspace/check?cwd=${encodeURIComponent(path.join(plain, 'tidak-ada'))}`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'WORKSPACE_INVALID');
  const empty = await api('/api/workspace/check');
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, 'WORKSPACE_MISSING');

  // cek tidak boleh membuat thread atau menyentuh state
  const after = await (await api('/api/threads')).json();
  assert.equal(after.length, before.length);
});

test('workspace: ringkasan repo, branch, dan aturan proyek', { skip: !GIT }, async () => {
  const t = await newThread(repo);
  const w = await (await api(`/api/threads/${t.id}/workspace`)).json();
  assert.equal(w.repo, true);
  assert.equal(w.cwd, repo);
  assert.ok(['master', 'main'].includes(w.branch), `branch tak terduga: ${w.branch}`);  assert.equal(w.changes, 0);
  assert.deepEqual(w.rules, []);

  const plainThread = await newThread(plain);
  const w2 = await (await api(`/api/threads/${plainThread.id}/workspace`)).json();
  assert.equal(w2.repo, false);
  assert.equal(w2.changes, 0);
});

test('diff: file berubah dan file baru terlihat, patch memuat isi', { skip: !GIT }, async () => {
  const t = await newThread(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'satu\ndua\n');
  fs.writeFileSync(path.join(repo, 'baru.txt'), 'baris baru\n');

  const d = await (await api(`/api/threads/${t.id}/diff`)).json();
  assert.equal(d.repo, true);
  assert.equal(d.truncated, false);

  const modified = d.files.find((f) => f.path === 'app.txt');
  assert.equal(modified.status, 'modified');
  assert.equal(modified.added, 1);
  assert.equal(modified.removed, 0);
  assert.match(d.patch, /\+dua/);

  const untracked = d.files.find((f) => f.path === 'baru.txt');
  assert.equal(untracked.status, 'untracked');
  assert.equal(untracked.added, 1);
  assert.equal(untracked.revertable, true);
});

test('revert: file terlacak kembali ke HEAD, file baru hanya dengan izin', { skip: !GIT }, async () => {
  const t = await newThread(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'satu\ndua\n');
  fs.writeFileSync(path.join(repo, 'baru.txt'), 'baris baru\n');

  // tanpa deleteUntracked, file baru dilaporkan dilewati dan tetap ada
  const r1 = await (await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: ['app.txt', 'baru.txt'] }),
  })).json();
  assert.deepEqual(r1.reverted, ['app.txt']);
  assert.ok(r1.skipped.some((s) => s.path === 'baru.txt'));
  // git di Windows dapat mengembalikan CRLF (autocrlf) — bandingkan isi logis.
  assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8').replace(/\r\n/g, '\n'), 'satu\n');
  assert.equal(fs.existsSync(path.join(repo, 'baru.txt')), true);

  // path di luar repo tidak pernah disentuh
  const outside = path.join(os.tmpdir(), `agenthub-outside-${PORT}.txt`);
  fs.writeFileSync(outside, 'aman\n');
  const r2 = await (await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: [`../agenthub-outside-${PORT}.txt`] }),
  })).json();
  assert.equal(r2.reverted.length, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'aman\n');

  // dengan izin eksplisit, file baru dihapus
  const r3 = await (await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: ['baru.txt'], deleteUntracked: true }),
  })).json();
  assert.deepEqual(r3.deleted, ['baru.txt']);
  assert.equal(fs.existsSync(path.join(repo, 'baru.txt')), false);

  fs.rmSync(outside, { force: true });
});

test('workspace subfolder: status/diff/revert memakai path root-relative', { skip: !GIT }, async () => {
  // Workspace thread boleh berupa subfolder repo. git selalu melaporkan path
  // relatif ke root, jadi modul harus resolve ke root — bukan ke folder thread.
  const sub = path.join(repo, 'packages', 'api');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'server.txt'), 'v1\n');
  git(['add', 'packages/api/server.txt']);
  git(['commit', '-qm', 'tambah paket api']);

  const t = await newThread(sub);
  assert.equal(t.cwd, sub);

  fs.writeFileSync(path.join(sub, 'server.txt'), 'v1\nv2\n');

  const w = await (await api(`/api/threads/${t.id}/workspace`)).json();
  assert.equal(w.repo, true);
  assert.equal(w.cwd, sub);
  assert.equal(w.changes, 1);
  assert.equal(w.files[0].path, 'packages/api/server.txt');

  const d = await (await api(`/api/threads/${t.id}/diff`)).json();
  assert.match(d.patch, /\+v2/);
  const changed = d.files.find((f) => f.path === 'packages/api/server.txt');
  assert.equal(changed.status, 'modified');
  assert.equal(changed.added, 1);

  // path relatif ke subfolder bukan path git — tidak boleh menebak atau menghapus.
  const wrong = await (await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: ['server.txt'] }),
  })).json();
  assert.equal(wrong.reverted.length, 0);
  assert.equal(fs.readFileSync(path.join(sub, 'server.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v1\nv2\n');

  const r = await (await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: ['packages/api/server.txt'] }),
  })).json();
  assert.deepEqual(r.reverted, ['packages/api/server.txt']);
  assert.equal(fs.readFileSync(path.join(sub, 'server.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v1\n');
});

test('revert: folder bukan repo ditolak 409, bukan menghapus apa pun', async () => {
  const t = await newThread(plain);
  const r = await api(`/api/threads/${t.id}/revert`, {
    method: 'POST', body: JSON.stringify({ paths: ['x.txt'], deleteUntracked: true }),
  });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'NOT_A_REPO');
});

test('aturan proyek: hanya nama file yang dikenal, isi tersimpan', { skip: !GIT }, async () => {
  const t = await newThread(repo);
  const bad = await api(`/api/threads/${t.id}/rules`, {
    method: 'POST', body: JSON.stringify({ file: '../evil.md', content: 'x' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'RULE_FILE_INVALID');

  const ok = await api(`/api/threads/${t.id}/rules`, {
    method: 'POST', body: JSON.stringify({ file: 'AGENTS.md', content: '# Aturan\n- jangan ubah lockfile\n' }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].file, 'AGENTS.md');
  assert.match(body.rules[0].content, /lockfile/);
  assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8').includes('lockfile'), true);
});

test('workspace: perubahan berkas mendorong SSE scope workspace (fs.watch)', async () => {
  // folder kerja khusus (bukan repo aplikasi) agar watcher tidak bereaksi
  // terhadap sinkronisasi OneDrive/berkas tes lain yang berjalan paralel.
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-watch-'));
  const th = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'echo', cwd: watchDir }),
  })).json();
  await api(`/api/threads/${th.id}/diff`);

  const events = [];
  const ctrl = new AbortController();
  const res = await api('/api/events');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          const m = line.match(/^data: (.+)$/);
          if (m) { try { events.push(JSON.parse(m[1])); } catch { /* baris parsial */ } }
          if (events.some((e) => e.scope === 'workspace')) return;
        }
      }
    } catch { /* stream dibatalkan */ }
  })();

  // ubah berkas di folder kerja → watcher harus bereaksi dalam 4 detik
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(watchDir, 'probe.txt'), String(Date.now()));
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !events.some((e) => e.scope === 'workspace')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  ctrl.abort();
  fs.rmSync(watchDir, { recursive: true, force: true });
  await api(`/api/threads/${th.id}`, { method: 'DELETE' });
  assert.ok(events.some((e) => e.scope === 'workspace'), 'event workspace harus tiba setelah berkas berubah');
});
