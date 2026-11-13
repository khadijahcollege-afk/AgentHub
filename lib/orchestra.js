// lib/orchestra.js — Orchestrator: beberapa agent AI bekerja paralel di
// cabang git sendiri, lalu hasilnya ditinjau dan digabung dengan tertib.
//
// Model yang dijaga: pekerjaan berjalan di MIRROR repo pengguna (kloning
// lokal, berbagi objek) — cabang, review, dan CI tidak pernah menyentuh repo
// asli. Output tiap agent disajikan sebagai diff; mode "merge" menerapkan
// diff ke cabang team yang juga ada di mirror, dan hasilnya bisa diekspor
// sebagai patch untuk diterapkan user.
import { spawnSync } from 'node:child_process';
import { readJson, writeJson, newId } from './store.js';

const FILE = 'orchestrations.json';
const MAX = 30;

function all() { const d = readJson(FILE, []); return Array.isArray(d) ? d : []; }
function save(list) { writeJson(FILE, list.slice(0, MAX)); }

export const ORCH_STATES = ['idle', 'running', 'reviewing', 'merging', 'done', 'error'];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 60000, ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function git(dir, args, opts) { return sh('git', args, { cwd: dir, ...opts }); }
function gitRepo(dir) { return git(dir, ['rev-parse', '--is-inside-work-tree']).ok; }
function currentBranch(dir) {
  const r = git(dir, ['symbolic-ref', '--short', 'HEAD']);
  return r.ok ? r.out : 'main';
}

// Jalankan perintah tes jika dikonfigurasi; fallback: jika ada package.json
// dengan "test", jalankan npm test (opsional, hanya bila perintah diisi).
function runCi(dir, testCommand) {
  if (!testCommand) return { ok: true, out: '(tidak ada perintah CI)', code: 0 };
  const parts = testCommand.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  return sh(cmd, args, { cwd: dir, timeout: 120000 });
}

export function createOrchestration({ name, prompt, agents, baseDir, testCommand } = {}) {
  if (!prompt?.trim()) { const e = new Error('isi prompt wajib'); e.statusCode = 400; throw e; }
  if (!Array.isArray(agents) || !agents.length) { const e = new Error('pilih minimal satu agent'); e.statusCode = 400; throw e; }
  if (!baseDir?.trim()) { const e = new Error('folder dasar wajib'); e.statusCode = 400; throw e; }
  if (!gitRepo(String(baseDir).trim())) {
    const e = new Error('Folder dasar bukan repo git — Orchestrator butuh repo agar bisa membuat cabang');
    e.statusCode = 400; throw e;
  }
  const entry = {
    id: newId(),
    name: String(name || 'Tim agent').slice(0, 80),
    prompt: prompt.trim().slice(0, 16000),
    agents: agents.map((a) => ({ engineId: a, branch: null, status: 'pending', diff: '', ci: null, error: null })),
    baseDir: String(baseDir).trim(),
    testCommand: typeof testCommand === 'string' ? testCommand : '',
    state: 'idle',
    mirror: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const list = all(); list.unshift(entry); save(list); return entry;
}

export function listOrchestrations() { return all(); }
export function getOrchestration(id) { return all().find((o) => o.id === id) || null; }
export function deleteOrchestration(id) { save(all().filter((o) => o.id !== id)); }
export function patchOrchestration(id, patch) {
  const list = all(); const o = list.find((x) => x.id === id);
  if (!o) { const e = new Error('Orkestrasi tidak ditemukan'); e.statusCode = 404; throw e; }
  const allowed = ['name', 'state', 'updatedAt', 'mirror'];
  for (const k of allowed) if (k in patch) o[k] = patch[k];
  if (Array.isArray(patch.agents)) o.agents = patch.agents;
  save(list); return o;
}

// Perbarui satu agent secara atomik (aman untuk callback paralel yang
// selesai di waktu berbeda — tidak saling menimpa status agent lain).
export function updateAgent(id, index, patch) {
  const list = all(); const o = list.find((x) => x.id === id);
  if (!o || !o.agents?.[index]) return null;
  Object.assign(o.agents[index], patch);
  save(list); return o.agents[index];
}

// Siapkan mirror + worktree per agent. Tiap agent dapat cabang sendiri.
// Mengembalikan { ok, mirror, branches } atau melempar Error dengan statusCode.
export function prepareOrchestration(id) {
  const o = getOrchestration(id);
  if (!o) { const e = new Error('Orkestrasi tidak ditemukan'); e.statusCode = 404; throw e; }
  if (!gitRepo(o.baseDir)) {
    const e = new Error('Folder dasar bukan repo git — Orchestrator butuh repo agar bisa membuat cabang');
    e.statusCode = 400; throw e;
  }
  const prefix = o.id.slice(0, 6);
  const mirror = `${o.baseDir}.orchestra-${prefix}`;
  // mirror belum ada → kloning.
  if (!gitRepo(mirror)) {
    const r = git(o.baseDir, ['clone', '--no-checkout', o.baseDir, mirror]);
    if (!r.ok) { const e = new Error('Gagal menyiapkan mirror: ' + r.err); e.statusCode = 500; throw e; }
  }
  const base = currentBranch(o.baseDir);
  const r = git(mirror, ['checkout', '-B', 'base-' + prefix, `origin/${base}`]);
  if (!r.ok) {
    // fallback: checkout default lokal
    git(mirror, ['checkout', '-B', 'base-' + prefix]);
  }
  const branches = o.agents.map((a, i) => {
    const name = `${o.branchBase || 'team'}-${prefix}-${a.engineId}-${i}`;
    git(mirror, ['checkout', '-B', name, 'base-' + prefix]);
    a.branch = name;
    return name;
  });
  o.mirror = mirror;
  patchOrchestration(id, { mirror, agents: o.agents });
  return { ok: true, mirror, branches };
}

// Buat worktree per agent: direktori kerja terpisah yang berbagi objek git
// dengan mirror. Tiap agent bekerja di direktori sendiri pada cabangnya.
export function prepareWorktrees(id) {
  const o = getOrchestration(id);
  if (!o?.mirror) { const e = new Error('Jalankan prepare dulu'); e.statusCode = 409; throw e; }
  const dirs = [];
  o.agents.forEach((a, i) => {
    const dir = `${o.mirror}-wt-${a.engineId}-${i}`;
    // hapus worktree lama bila ada (dari run sebelumnya)
    git(o.mirror, ['worktree', 'remove', '--force', dir]);
    const r = git(o.mirror, ['worktree', 'add', '--force', dir, a.branch]);
    if (!r.ok) { const e = new Error('Gagal membuat worktree ' + a.branch + ': ' + r.err); e.statusCode = 500; throw e; }
    a.worktree = dir;
    dirs.push(dir);
  });
  patchOrchestration(id, { agents: o.agents });
  return dirs;
}

// Direktori kerja satu agent (untuk runEngine cwd).
export function agentWorktree(id, agentIndex) {
  const o = getOrchestration(id);
  return o?.agents?.[agentIndex]?.worktree || null;
}

// Commit semua perubahan di worktree agent ke cabangnya.
export function commitAgent(id, agentIndex, message) {
  const o = getOrchestration(id);
  const a = o?.agents?.[agentIndex];
  if (!a?.worktree) return { ok: false, out: 'tidak ada worktree' };
  git(a.worktree, ['add', '-A']);
  // commit hanya bila ada perubahan (else commit kosong gagal — itu ok)
  const st = git(a.worktree, ['status', '--porcelain']);
  if (!st.out) return { ok: true, out: '(tidak ada perubahan)' };
  const r = git(a.worktree, ['commit', '-m', message || `orchestra: ${o.name} — ${a.engineId}`]);
  return r;
}

// Jalankan CI (perintah tes) di worktree agent.
export function runAgentCi(id, agentIndex) {
  const o = getOrchestration(id);
  const a = o?.agents?.[agentIndex];
  if (!a?.worktree) return { ok: false, out: 'tidak ada worktree', code: 1 };
  return runCi(a.worktree, o.testCommand);
}

// Diff cabang agent relatif ke base. Mengembalikan string unified diff.
export function branchDiff(id, agentIndex) {
  const o = getOrchestration(id);
  const a = o?.agents?.[agentIndex];
  if (!o || !a?.branch) return '';
  const r = git(o.mirror, ['diff', `base-${o.id.slice(0, 6)}...${a.branch}`]);
  return r.ok ? r.out : '';
}

// Gabung: terapkan diff semua agent yang lulus ke cabang team, lalu adakan
// satu branch "team" sebagai hasil akhir.
export function mergeOrchestration(id) {
  const o = getOrchestration(id);
  if (!o) { const e = new Error('Orkestrasi tidak ditemukan'); e.statusCode = 404; throw e; }
  const prefix = o.id.slice(0, 6);
  const team = `team-${prefix}`;
  git(o.mirror, ['checkout', '-B', team, `base-${prefix}`]);
  let merged = [];
  o.agents.forEach((a, i) => {
    if (a.status !== 'ok') return;
    const r = git(o.mirror, ['merge', '--no-ff', '--no-edit', a.branch]);
    if (r.ok) merged.push(a.engineId);
    else { a.status = 'conflict'; a.error = r.err.slice(0, 300); }
  });
  patchOrchestration(id, { agents: o.agents, state: 'done', updatedAt: Date.now() });
  return { ok: true, team, merged, agents: o.agents };
}

// Ekspor patch hasil (untuk diterapkan user ke repo asli).
export function exportPatch(id) {
  const o = getOrchestration(id);
  if (!o) { const e = new Error('Orkestrasi tidak ditemukan'); e.statusCode = 404; throw e; }
  const prefix = o.id.slice(0, 6);
  const team = `team-${prefix}`;
  const r = git(o.mirror, ['diff', `base-${prefix}...${team}`]);
  return r.ok ? r.out : '';
}
