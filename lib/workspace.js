// lib/workspace.js — folder kerja nyata untuk sebuah thread.
//
// Sebelumnya `cwd` hanya hidup di localStorage dan dikirim ulang di setiap
// request. Akibatnya thread tidak tahu di folder mana ia bekerja, agent lain
// tidak bisa membacanya, dan tidak ada cara meninjau apa yang diubah sebuah run.
//
// Modul ini memberi tiga hal yang dimiliki app agent teratas:
//   1. workspace yang tervalidasi & bisa dipersistensi per thread
//   2. laporan perubahan (status + patch) dari git, read-only
//   3. revert eksplisit per file — termasuk file baru, tetapi hanya bila
//      pemanggil menyatakan `deleteUntracked: true`
//
// Semua git dipanggil dengan execFile + shell:false + timeout; tidak ada hook,
// fetch, atau perintah destruktif di luar daftar path yang diminta.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RULE_FILES } from './machines.js';

const MAX_DIFF_BYTES = 200 * 1024;
const MAX_FILES = 500;
const MAX_RULE_BYTES = 64 * 1024;

// Nama file aturan yang dikenal agent populer. Hanya nama ini yang boleh ditulis;
// membiarkan path bebas berarti memberi agent izin menulis ke seluruh repo.
export { RULE_FILES };

export class WorkspaceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Path absolut, ada, dan berupa folder. Dipakai sebelum run dimulai supaya
// kegagalan muncul sebagai 400 yang jelas, bukan run yang mati di tengah.
export function resolveWorkspace(input, { label = 'Folder kerja' } = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new WorkspaceError('WORKSPACE_MISSING', `${label} belum dipilih`);
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new WorkspaceError('WORKSPACE_INVALID', `${label} tidak ditemukan: ${dir}`);
  }
  return dir;
}

// Jalankan git tanpa shell. resolve selalu { ok, out, err } agar pemanggil bisa
// membedakan "bukan repo" dari "git tidak terpasang".
function git(cwd, args, { maxBuffer = 2 * 1024 * 1024, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', '--no-optional-locks', ...args], {
      cwd, timeout, maxBuffer, encoding: 'utf8', windowsHide: true, shell: false,
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      out: stdout || '',
      err: error ? String(stderr || error.message) : '',
    }));
  });
}

const STATUS_LABEL = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
  T: 'modified',
};

function normalizeCode(xy) {
  if (xy.includes('?')) return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  // Kolom kedua = worktree, pertama = index. Worktree lebih relevan untuk UI.
  const ch = xy[1] !== ' ' ? xy[1] : xy[0];
  return STATUS_LABEL[ch] || 'modified';
}

// git status --porcelain=v1 -uall: satu baris per file, termasuk untracked.
// Rename ditulis "lama -> baru"; kita catat keduanya agar revert tidak menebak.
export async function listChanges(dir) {
  const r = await git(dir, ['status', '--porcelain=v1', '-uall']);
  if (!r.ok) return { repo: false, files: [] };

  const files = [];
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    let file = line.slice(3).trim();
    let orig = null;
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) {
      orig = file.slice(0, arrow);
      file = file.slice(arrow + 4);
    }
    const status = normalizeCode(xy);
    files.push({
      path: file,
      orig,
      status,
      index: xy[0],
      worktree: xy[1],
      // File baru tidak bisa di-"checkout"; hanya bisa dihapus dengan izin eksplisit.
      revertable: status !== 'conflict' && status !== 'copied' && status !== 'renamed',
    });
    if (files.length >= MAX_FILES) break;
  }
  return { repo: true, files };
}

// Root repo untuk sebuah folder. Null bila folder bukan bagian dari repo git.
// Semua path git bersifat root-relative, jadi subfolder workspace tetap harus
// memakai root ini untuk status, diff, dan revert.
async function repoRoot(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  return top.ok ? (top.out.trim() || dir) : null;
}

// Ringkasan murah untuk chip/drawer. Tidak membaca isi file.
// Catatan: `git status` selalu memberi path relatif ke root repo, bukan ke cwd.
// Karena itu semua operasi memakai `root`, bukan folder thread yang mungkin subfolder.
export async function workspaceSummary(dir) {
  if (!dir) return { cwd: null, repo: false, branch: null, changes: 0, files: [] };
  const root = await repoRoot(dir);
  if (!root) return { cwd: dir, repo: false, branch: null, changes: 0, files: [] };
  const [branchOut, changes] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    listChanges(root),
  ]);
  return {
    cwd: dir,
    root,
    repo: true,
    branch: branchOut.ok ? (branchOut.out.trim() || null) : null,
    changes: changes.files.length,
    files: changes.files,
  };
}

// numstat memberi +/- per file tanpa perlu parsing patch.
async function numstat(dir) {
  const r = await git(dir, ['diff', '--numstat', '--']);
  if (!r.ok) return new Map();
  const map = new Map();
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const [add, del, ...rest] = line.split('\t');
    const file = rest.join('\t').replace(/^"|"$/g, '');
    map.set(file, {
      added: add === '-' ? null : Number(add),
      removed: del === '-' ? null : Number(del),
    });
  }
  return map;
}

// Laporan lengkap: status + patch (dipotong) + statistik baris.
// Read-only: tidak pernah menulis index, worktree, atau stash.
export async function diffReport(dir) {
  const summary = await workspaceSummary(dir);
  if (!summary.repo) return { ...summary, patch: '', truncated: false };

  // root, bukan dir: `git diff --numstat` juga melaporkan path root-relative.
  const root = summary.root || dir;
  const [untrackedStat, stat] = await Promise.all([numstat(root), git(root, ['diff', '--no-color', '--no-ext-diff', '--unified=3', '--'])]);
  const patchRaw = stat.ok ? stat.out : '';
  const truncated = patchRaw.length > MAX_DIFF_BYTES;

  const files = summary.files.map((f) => {
    const counts = untrackedStat.get(f.path) || null;
    let size = null;
    let lines = null;
    if (f.status === 'untracked') {
      try {
        const full = safeJoin(root, f.path);
        const st = fs.statSync(full);
        size = st.size;
        if (st.size <= 512 * 1024) {
          const content = fs.readFileSync(full, 'utf8');
          lines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
        }
      } catch { /* file hilang di antara status & baca */ }
    }
    return {
      ...f,
      added: counts?.added ?? (f.status === 'untracked' ? lines : null),
      removed: counts?.removed ?? (f.status === 'untracked' ? 0 : null),
      bytes: size,
    };
  });

  return {
    ...summary,
    files,
    patch: truncated ? patchRaw.slice(0, MAX_DIFF_BYTES) : patchRaw,
    truncated,
  };
}

// Gabungkan path relatif dengan root repo tanpa bisa keluar darinya.
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const check = path.relative(root, full);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new WorkspaceError('PATH_OUTSIDE_WORKSPACE', `Path di luar folder kerja: ${rel}`, 400);
  }
  return full;
}

// Revert hanya untuk path yang benar-benar muncul di status. Ini mencegah
// route menjadi "hapus/restore path apa pun" bila token bocor.
export async function revertPaths(dir, paths, { deleteUntracked = false } = {}) {
  const root = await repoRoot(dir);
  if (!root) throw new WorkspaceError('NOT_A_REPO', 'Folder kerja bukan repo git', 409);
  const { files } = await listChanges(root);

  const wanted = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (!wanted.length) throw new WorkspaceError('NO_PATHS', 'Tidak ada file yang diminta', 400);

  const known = new Map();
  for (const f of files) {
    known.set(f.path, f);
    if (f.orig) known.set(f.orig, f);
  }

  const reverted = [];
  const deleted = [];
  const skipped = [];
  for (const rel of [...new Set(wanted)]) {
    const entry = known.get(rel);
    if (!entry) { skipped.push({ path: rel, reason: 'Tidak ada perubahan pada file ini' }); continue; }
    const full = safeJoin(root, entry.path);
    if (entry.status === 'untracked') {
      if (!deleteUntracked) {
        skipped.push({ path: rel, reason: 'File baru: kirim deleteUntracked=true untuk menghapus' });
        continue;
      }
      try { fs.rmSync(full, { force: true }); deleted.push(entry.path); } catch (e) {
        skipped.push({ path: rel, reason: e.message });
      }
      continue;
    }
    if (!entry.revertable) {
      skipped.push({ path: rel, reason: `Status ${entry.status} tidak bisa dikembalikan otomatis` });
      continue;
    }
    // restore = worktree saja; index pengguna tidak disentuh.
    let r = await git(root, ['restore', '--worktree', '--', entry.path]);
    if (!r.ok) r = await git(root, ['checkout', '--', entry.path]);
    if (r.ok) reverted.push(entry.path);
    else skipped.push({ path: rel, reason: 'git menolak mengembalikan file ini' });
  }

  const after = await workspaceSummary(dir);
  return { reverted, deleted, skipped, repo: true, branch: after.branch, changes: after.changes };
}

// ---------- aturan proyek (memory) ----------
// Agent populer membaca file aturan dari root repo. Kita baca yang ada saja;
// tidak membuat file baru saat membaca.
export function listRules(dir) {
  if (!dir) return [];
  return RULE_FILES.map((name) => {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return null;
      const content = fs.readFileSync(full, 'utf8');
      return { file: name, bytes: st.size, content: content.slice(0, MAX_RULE_BYTES), truncated: st.size > MAX_RULE_BYTES };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function writeRule(dir, file, content) {
  if (!dir) throw new WorkspaceError('WORKSPACE_MISSING', 'Folder kerja belum dipilih');
  if (!RULE_FILES.includes(file)) {
    throw new WorkspaceError('RULE_FILE_INVALID', `Hanya ${RULE_FILES.join(', ')} yang boleh ditulis`);
  }
  const body = typeof content === 'string' ? content : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_RULE_BYTES) {
    throw new WorkspaceError('RULE_TOO_LARGE', `Aturan maksimal ${MAX_RULE_BYTES} byte`);
  }
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return { file, bytes: Buffer.byteLength(body, 'utf8') };
}
