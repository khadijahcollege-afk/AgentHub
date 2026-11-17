// lib/checkpoints.js — snapshot berkas per putaran agent, dan pemulihannya.
//
// Kenapa perlu: begitu agent boleh menulis berkas (mode edit/guarded/yolo), satu
// jawaban buruk bisa mengubah selusin file sekaligus. Tanpa snapshot, satu-satunya
// jalan keluar adalah "git checkout ." — yang juga menghapus pekerjaan pengguna
// yang belum di-commit. Snapshot per putaran membuat pemulihan bisa dilakukan
// sampai ke file tertentu tanpa menyentuh sisanya.
//
// Cara kerjanya meniru Git checkpoint di ZCode:
//   • isi berkas disimpan sebagai objek git lewat index SEMENTARA, sehingga
//     `.git/index` milik pengguna tidak pernah disentuh dan HEAD tidak berpindah
//   • tiap checkpoint punya hidden ref `refs/agenthub/checkpoints/<id>` supaya
//     objeknya tidak dibersihkan GC
//   • restore membandingkan dulu berkas di disk dengan checkpoint asal; bila ada
//     yang sudah berubah di luar dugaan, restore DITOLAK dengan daftar konflik
//     alih-alih menimpa pekerjaan yang tidak ada hubungannya
//
// Batasan yang disengaja: hanya repo git, hanya path di dalam folder kerja,
// berkas yang di-ignore tidak ikut (sama seperti ZCode).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readJson, writeJson } from './store.js';

const FILE = 'checkpoints.json';
const MAX_PER_THREAD = 40;
const MAX_META_BYTES = 512 * 1024;
const GIT_TIMEOUT = 20000;

export class CheckpointError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CheckpointError';
    this.statusCode = statusCode;
  }
}

function git(cwd, args, { env = {}, maxBuffer = 8 * 1024 * 1024, timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', '--no-optional-locks', ...args], {
      cwd, timeout, maxBuffer, encoding: 'utf8', windowsHide: true, shell: false,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      out: stdout || '',
      err: error ? String(stderr || error.message) : '',
    }));
  });
}

function repoRoot(dir) {
  return git(dir, ['rev-parse', '--show-toplevel']).then((r) => {
    if (!r.ok) return null;
    const root = r.out.trim();
    // Windows bisa melaporkan path pendek (8.3, mis. RUNNER~1) sementara folder
    // kerja datang sebagai path panjang. Tanpa disamakan, `path.relative`
    // menghasilkan "../../.." dan setiap perintah git menolaknya sebagai
    // "outside repository". realpath menormalkan keduanya ke bentuk kanonik.
    try { return fs.realpathSync.native(root); } catch { return root; }
  });
}

// Daftar semua checkpoint, dikelompokkan menurut thread. Disimpan di data dir,
// bukan di repo: checkpoint adalah riwayat AgentHub, bukan bagian dari proyek.
function all() {
  const d = readJson(FILE, []);
  return Array.isArray(d) ? d : [];
}
function save(list) { writeJson(FILE, list); }

export function listCheckpoints(threadId) {
  return all()
    .filter((c) => c.threadId === threadId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getCheckpoint(id) {
  return all().find((c) => c.id === id) || null;
}

function refName(id) { return `refs/agenthub/checkpoints/${id}`; }

// Path kanonik: Windows melaporkan bentuk 8.3 (RUNNER~1) untuk satu sisi dan
// bentuk panjang untuk sisi lain. Dua bentuk itu menunjuk folder yang sama,
// tetapi perbandingan string dan `path.relative` menganggapnya berbeda.
function canonical(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

// Path relatif ke root repo, bukan ke folder kerja: git selalu melaporkan
// path relatif root, dan agent bisa saja bekerja di subfolder.
async function relScope(root, dir) {
  const rel = path.relative(canonical(root), canonical(dir)).split(path.sep).join('/');
  return rel && rel !== '.' ? rel : '';
}

// Snapshot bekerja di index sementara di folder temp. Ini bagian terpenting:
// memakai index asli berarti mengacak staging area pengguna, dan `git add -A`
// biasa juga akan mengubah apa yang terlihat di `git status`.
async function withTempIndex(root, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-'));
  const index = path.join(tmp, 'index');
  try {
    // File index sengaja TIDAK dibuat lebih dulu: git membuatnya sendiri saat
    // path belum ada. File kosong justru ditolak ("index file smaller than
    // expected") sehingga snapshot gagal pada percobaan kedua dan seterusnya.
    return await fn({ GIT_INDEX_FILE: index, tmp });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

// Buat checkpoint: tulis seluruh isi folder kerja ke object database, lalu
// tandai dengan hidden ref. Mengembalikan metadata ringkas untuk daftar UI.
export async function createCheckpoint(threadId, dir, { label = '', turn = null } = {}) {
  if (!threadId) throw new CheckpointError('Thread wajib diketahui', 400);
  if (!dir) throw new CheckpointError('Folder kerja belum dipilih', 409);
  const root = await repoRoot(dir);
  if (!root) throw new CheckpointError('Folder kerja bukan repo git', 409);
  const scope = await relScope(root, dir);
  const stageArgs = scope ? ['add', '-A', '--', scope] : ['add', '-A', '--', '.'];

  const created = await withTempIndex(root, async (env) => {
    const add = await git(root, stageArgs, { env, timeout: 60000 });
    if (!add.ok) throw new CheckpointError(`Gagal menyiapkan snapshot: ${add.err.slice(0, 300)}`, 500);
    const tree = await git(root, ['write-tree'], { env });
    if (!tree.ok || !tree.out.trim()) throw new CheckpointError('Gagal menulis tree snapshot', 500);
    // commit-tree butuh identitas; bila git pengguna belum dikonfigurasi, pakai
    // identitas AgentHub supaya snapshot tidak gagal hanya karena itu.
    const commit = await git(root, ['commit-tree', tree.out.trim(), '-m', label || 'checkpoint'], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'AgentHub', GIT_AUTHOR_EMAIL: 'checkpoint@agenthub.local',
        GIT_COMMITTER_NAME: 'AgentHub', GIT_COMMITTER_EMAIL: 'checkpoint@agenthub.local',
      },
    });
    if (!commit.ok) throw new CheckpointError(`Gagal membuat commit snapshot: ${commit.err.slice(0, 300)}`, 500);
    return commit.out.trim();
  });

  const id = crypto.randomBytes(12).toString('hex');
  const ref = refName(id);
  const upd = await git(root, ['update-ref', ref, created]);
  if (!upd.ok) throw new CheckpointError(`Gagal menandai checkpoint: ${upd.err.slice(0, 300)}`, 500);

  const entry = {
    id, threadId, root, scope, commit: created, ref,
    label: String(label || '').slice(0, 160),
    turn: Number.isFinite(turn) ? turn : null,
    createdAt: Date.now(),
    files: 0,
  };
  // jumlah berkas dihitung dari tree: dipakai UI untuk memberi tahu besarnya
  // snapshot tanpa perlu membuka isinya.
  const count = await git(root, ['ls-tree', '-r', '--name-only', created, ...(scope ? ['--', scope] : [])]);
  entry.files = count.ok ? count.out.split('\n').filter(Boolean).length : 0;

  const list = all();
  list.push(entry);
  // riwayat per thread dipangkas: checkpoint adalah alat pemulihan jangka pendek,
  // bukan arsip. Ref lama ikut dihapus agar objeknya bisa dibersihkan git.
  const extra = list.filter((c) => c.threadId === threadId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(MAX_PER_THREAD);
  for (const old of extra) {
    await git(old.root, ['update-ref', '-d', old.ref]).catch(() => {});
  }
  const drop = new Set(extra.map((c) => c.id));
  save(list.filter((c) => !drop.has(c.id)));
  return entry;
}

async function treeEntries(root, commit, scope) {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commit];
  if (scope) args.push('--', scope);
  const r = await git(root, args);
  const map = new Map();
  if (!r.ok) return map;
  for (const rec of r.out.split('\0')) {
    if (!rec) continue;
    const [meta, file] = rec.split('\t');
    if (!file) continue;
    const [mode, type, hash] = meta.split(' ');
    if (type !== 'blob') continue;
    map.set(file, { mode, hash });
  }
  return map;
}

function hashBlob(root, file) {
  return new Promise((resolve) => {
    execFile('git', ['hash-object', '--', file], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false },
      (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

// Konflik hanya diperiksa pada path yang akan disentuh restore. Memeriksa
// seluruh repo akan menolak restore hanya karena ada file lain yang kotor —
// padahal file itu tidak ada hubungannya dengan checkpoint ini.
async function collectConflicts(root, fromCommit, affected, scope) {
  const expected = await treeEntries(root, fromCommit, scope);
  const conflicts = [];
  for (const file of affected) {
    const full = path.join(root, file);
    const entry = expected.get(file);
    let stat = null;
    try { stat = fs.statSync(full); } catch { stat = null; }
    if (!entry) {
      if (stat) conflicts.push({ path: file, reason: 'unexpected-file-in-worktree' });
      continue;
    }
    if (!stat) { conflicts.push({ path: file, reason: 'missing-in-worktree' }); continue; }
    // treeEntries hanya memuat blob, jadi yang tersisa cuma regular file atau
    // symlink. Symlink tidak bisa di-hash lewat jalur biasa — lewati saja.
    if (entry.mode === '120000') continue;
    if (!stat.isFile()) { conflicts.push({ path: file, reason: 'type-mismatch' }); continue; }
    if (stat.size > MAX_META_BYTES) { continue; }
    const hash = await hashBlob(root, full);
    if (hash && hash !== entry.hash) conflicts.push({ path: file, reason: 'content-mismatch' });
  }
  return conflicts;
}

// Daftar path yang berbeda antara dua commit, dibatasi ke scope folder kerja.
async function changedPaths(root, from, to, scope) {
  const args = ['diff', '--name-status', '-z', '--find-renames', from, to];
  if (scope) args.push('--', scope);
  const r = await git(root, args);
  if (!r.ok) throw new CheckpointError(`Gagal membandingkan checkpoint: ${r.err.slice(0, 300)}`, 500);
  const parts = r.out.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const fromPath = parts[i++];
      const toPath = parts[i++];
      out.push({ path: toPath, from: fromPath, status: code === 'R' ? 'renamed' : 'copied' });
    } else {
      const file = parts[i++];
      out.push({ path: file, status: { A: 'added', D: 'deleted', M: 'modified', T: 'modified' }[code] || 'modified' });
    }
  }
  return out;
}

export async function diffCheckpoints(fromId, toId) {
  const a = getCheckpoint(fromId);
  const b = getCheckpoint(toId);
  if (!a || !b) throw new CheckpointError('Checkpoint tidak ditemukan', 404);
  if (a.root !== b.root) throw new CheckpointError('Checkpoint berasal dari repo berbeda', 400);
  const files = await changedPaths(a.root, a.commit, b.commit, a.scope);
  return { from: fromId, to: toId, files, count: files.length };
}

// Pulihkan berkas dari `toId` ke keadaan saat `fromId`, untuk path terpilih.
// `fromId` adalah checkpoint yang diyakini mewakili isi disk sekarang, jadi
// konflik dihitung terhadapnya — bukan terhadap HEAD.
export async function restoreCheckpoint(threadId, { fromId, toId, paths = null, force = false } = {}) {
  const target = getCheckpoint(toId);
  if (!target || target.threadId !== threadId) throw new CheckpointError('Checkpoint tujuan tidak ditemukan', 404);

  // Base = keadaan yang diyakini ada di disk sekarang. Urutannya: checkpoint
  // yang disebut pemanggil → checkpoint terbaru thread ini → potret baru dari
  // disk. Memakai checkpoint terbaru penting: kalau pengguna mengedit berkas
  // setelah checkpoint itu, konflik terdeteksi dan restore berhenti, bukan
  // menimpa editan tersebut diam-diam.
  let base = fromId ? getCheckpoint(fromId) : null;
  if (fromId && (!base || base.threadId !== threadId)) throw new CheckpointError('Checkpoint asal tidak ditemukan', 404);
  if (!base) {
    const latest = listCheckpoints(threadId).find((c) => c.root === target.root && c.id !== target.id);
    base = latest || await createCheckpoint(threadId, target.root, { label: 'sebelum pemulihan' });
  }
  if (base.root !== target.root) throw new CheckpointError('Checkpoint berasal dari repo berbeda', 400);

  const root = target.root;
  const diff = await changedPaths(root, base.commit, target.commit, target.scope);
  let wanted;
  if (Array.isArray(paths) && paths.length) {
    // hanya path yang memang berbeda antara dua checkpoint — kalau tidak,
    // route ini menjadi "tulis file apa pun dari snapshot" untuk token bocor.
    const allowed = new Set(diff.flatMap((f) => [f.path, f.from].filter(Boolean)));
    wanted = paths.filter((p) => allowed.has(p));
    if (!wanted.length) throw new CheckpointError('Tidak ada path yang berubah antara kedua checkpoint', 409);
  } else {
    wanted = [...new Set(diff.flatMap((f) => [f.path, f.from].filter(Boolean)))];
    if (!wanted.length) return { ok: true, restored: [], conflicts: [] };
  }

  const conflicts = await collectConflicts(root, base.commit, wanted, target.scope);
  if (conflicts.length && !force) {
    return { ok: false, restored: [], conflicts };
  }

  // restore dari commit tujuan, hanya untuk path yang ada di sana
  const present = await treeEntries(root, target.commit, target.scope);
  const toRestore = wanted.filter((p) => present.has(p));
  const toDelete = wanted.filter((p) => !present.has(p));

  if (toRestore.length) {
    const r = await git(root, ['restore', `--source=${target.commit}`, '--worktree', '--', ...toRestore], { timeout: 60000 });
    if (!r.ok) throw new CheckpointError(`Gagal memulihkan berkas: ${r.err.slice(0, 300)}`, 500);
  }
  const removed = [];
  for (const rel of toDelete) {
    const full = path.resolve(root, rel);
    const check = path.relative(root, full);
    // pengaman terakhir: jangan pernah menghapus di luar repo
    if (check.startsWith('..') || path.isAbsolute(check)) continue;
    try { fs.rmSync(full, { force: true }); removed.push(rel); } catch { /* biarkan */ }
  }

  const after = await collectConflicts(root, target.commit, wanted, target.scope);
  return {
    ok: after.length === 0,
    restored: [...toRestore, ...removed],
    conflicts: after,
    baseId: base.id,
  };
}

export async function deleteCheckpoint(id) {
  const cp = getCheckpoint(id);
  if (!cp) return false;
  await git(cp.root, ['update-ref', '-d', cp.ref]).catch(() => {});
  save(all().filter((c) => c.id !== id));
  return true;
}

// Checkpoint yatim (thread dihapus / folder hilang) dibersihkan saat dibaca,
// supaya daftar tidak menumpuk entri yang tidak bisa dipulihkan lagi.
export async function pruneCheckpoints(validThreadIds) {
  const keep = new Set(validThreadIds || []);
  const list = all();
  const stale = list.filter((c) => !keep.has(c.threadId));
  if (!stale.length) return 0;
  for (const cp of stale) await git(cp.root, ['update-ref', '-d', cp.ref]).catch(() => {});
  save(list.filter((c) => keep.has(c.threadId)));
  return stale.length;
}

// Ringkasan untuk UI: tanpa membuka isi berkas apa pun.
export function summary(threadId) {
  const list = listCheckpoints(threadId);
  return {
    count: list.length,
    latest: list[0] ? { id: list[0].id, label: list[0].label, createdAt: list[0].createdAt, files: list[0].files } : null,
  };
}
