// test/orchestra.test.js — Orchestrator: tim agent paralel di cabang git,
// CI per agent, merge ke cabang team, dan ekspor patch. Menggunakan harness
// uji yang MENULIS berkas (bukan cuma echo) agar diff & merge terukur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8540 + Math.floor(Math.random() * 20);
const TOKEN = 'orchestratok0123456';
let child;
let dataDir;
let repoDir;

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

function git(dir, args) {
  return execFileSync('git', ['-c', 'user.name=uji', '-c', 'user.email=uji@test', ...args], { cwd: dir, encoding: 'utf8' });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-orch-'));
  repoDir = path.join(dataDir, 'repo');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    // harness yang MENULIS berkas — agent benar-benar mengubah worktree
    { id: 'writer', label: 'Writer', type: 'cli', cmd: 'cmd', args: ['/c', 'echo', 'dari-agent>agent-output.txt'] },
  ]));
  // repo dasar dengan satu commit awal
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'dasar\n');
  git(repoDir, ['init']);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', 'initial']);
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

test('orchestra: buat → jalankan tim → review → merge → patch', async () => {
  // buat orkestrasi
  const created = await (await api('/api/orchestra', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Tim uji',
      prompt: 'Tulis hasil kerja ke agent-output.txt',
      agents: ['writer'],
      baseDir: repoDir,
    }),
  })).json();
  assert.ok(created.id, 'id orkestrasi');
  assert.equal(created.state, 'idle');
  assert.equal((await api('/api/orchestra', { method: 'POST', body: JSON.stringify({ prompt: '', agents: ['writer'], baseDir: repoDir }) })).status, 400, 'prompt wajib');
  assert.equal((await api('/api/orchestra', { method: 'POST', body: JSON.stringify({ prompt: 'x', agents: [], baseDir: repoDir }) })).status, 400, 'agent wajib');
  assert.equal((await api('/api/orchestra', { method: 'POST', body: JSON.stringify({ prompt: 'x', agents: ['writer'], baseDir: 'C:/bukan/repo' }) })).status >= 400, true, 'baseDir bukan repo ditolak saat run');

  // jalankan
  const run = await (await api(`/api/orchestra/${created.id}/run`, { method: 'POST' })).json();
  assert.equal(run.ok, true, 'run resp: ' + JSON.stringify(run));
  console.log('RUN RESP:', JSON.stringify(run));

  // poll sampai state reviewing (agent selesai) — maks 20 detik
  let o = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    o = await (await api(`/api/orchestra/${created.id}`)).json();
    if (o.state === 'reviewing' || o.state === 'error') break;
  }
  assert.equal(o.state, 'reviewing', `state harus reviewing, dapat: ${o.state}`);
  const agent = o.agents[0];
  assert.equal(agent.status, 'ok', `agent harus ok: ${agent.status} ${agent.error || ''}`);
  assert.ok(agent.branch, 'cabang agent ada');
  assert.ok(agent.diff.includes('agent-output.txt'), 'diff memuat berkas baru, dapat: ' + JSON.stringify(agent.diff.slice(0, 200)));

  // merge
  const merged = await (await api(`/api/orchestra/${created.id}/merge`, { method: 'POST' })).json();
  assert.equal(merged.ok, true);
  assert.ok(merged.merged.includes('writer'), 'writer digabung');

  // patch berisi perubahan
  const patchRes = await api(`/api/orchestra/${created.id}/patch`);
  assert.match(patchRes.headers.get('content-type'), /diff/);
  const patch = await patchRes.text();
  assert.match(patch, /agent-output\.txt/, 'patch memuat berkas agent');

  // hapus
  assert.equal((await api(`/api/orchestra/${created.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/orchestra/${created.id}`)).status, 404);
});

test('orchestra: 401 tanpa token', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/orchestra`);
  assert.equal(r.status, 401);
});
