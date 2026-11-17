// lib/gitgraph.js — grafik commit: data mentah dari git, tata letak murni.
//
// Dipisah dari git-nya sengaja. Tata letak lane adalah bagian yang sulit dan
// paling mudah salah (garis menyeberang, lane bertumpuk, merge yang hilang),
// jadi ia fungsi murni atas daftar commit yang sudah terurut: input yang sama
// selalu menghasilkan gambar yang sama, dan bisa diuji tanpa repo.
//
// Kontrak dengan UI: kiriman hanya { commits, edges, rails, lanes, truncated }.
// UI tidak pernah menghitung ulang posisi; ia menggambar apa yang diberikan.
import { execFile } from 'node:child_process';

const MAX_COUNT = 200;
const DEFAULT_COUNT = 50;
// Pemisah field memakai escape git sendiri (%x1f = unit separator), bukan byte
// NUL: Node menolak NUL di argumen proses. %x1e memisahkan record.
const FIELD = '\x1f';
const RECORD = '\x1e';

function git(cwd, args, { maxBuffer = 8 * 1024 * 1024, timeout = 8000 } = {}) {
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

// Dekorasi ref dari git: "HEAD -> main, origin/main, tag: v1" menjadi
// ["main", "origin/main", "v1"]. HEAD dibuang karena ia posisi, bukan label.
function cleanRefs(decoration) {
  return String(decoration || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .map((r) => r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '').replace(/^refs\/tags\//, ''))
    .filter((r) => r && r !== 'HEAD');
}

// `git log --all --topo-order --date-order`: urutan topologis dulu, tanggal
// sebagai pemecah seri. Urutan tanggal murni membuat garis merge melompat
// bolak-balik; topologis menjaga orang tua selalu di bawah anaknya.
export async function readGraph(dir, { maxCount = DEFAULT_COUNT, skip = 0, all = true } = {}) {
  const count = Math.max(1, Math.min(MAX_COUNT, Number(maxCount) || DEFAULT_COUNT));
  const from = Math.max(0, Number(skip) || 0);
  // %x1f dan %x1e adalah escape git untuk unit/record separator. Ditulis sebagai
  // escape, bukan byte mentah, karena argumen proses tidak boleh memuat NUL.
  const format = '%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s%x1e';
  const args = ['log', `--pretty=format:${format}`,
    '--topo-order', '--date-order', `--max-count=${count}`, `--skip=${from}`];
  if (all) args.splice(1, 0, '--all');
  const r = await git(dir, args);
  if (!r.ok) {
    // Bukan repo, atau repo tanpa commit sama sekali: dua hal berbeda, dan UI
    // perlu membedakannya supaya tidak menampilkan "kosong" untuk folder biasa.
    if (/not a git repository/i.test(r.err)) return { repo: false, commits: [], edges: [], rails: [], lanes: 0, truncated: false };
    return { repo: true, empty: true, commits: [], edges: [], rails: [], lanes: 0, truncated: false };
  }
  const commits = r.out.split(RECORD)
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [sha, parents, refs, author, date, ...rest] = chunk.split(FIELD);
      return {
        sha,
        parents: String(parents || '').split(' ').filter(Boolean),
        refs: cleanRefs(refs),
        author: author || '',
        date: date || '',
        subject: rest.join(FIELD).trim(),
      };
    });
  return { repo: true, ...layoutGitGraph(commits), truncated: commits.length === count };
}

// Tata letak. Satu lane adalah satu "rel" vertikal. Commit mengambil rel yang
// sudah menunggu sha-nya; orang tuanya mewarisi rel itu, dan orang tua yang
// sudah ditunggu rel lain diarahkan ke rel itu — bukan dibuatkan rel kedua.
// Tanpa aturan terakhir, setiap merge menambah satu rel permanen dan grafik
// melebar tanpa isi.
//
// Murni: commit masukan tidak diubah, hasilnya salinan yang membawa `lane`.
//
// Semantik keluaran:
//   commits[i].lane   rel tempat commit digambar
//   edges[]           { row, lane, toRow, toLane, kind } — parent | merge | truncated
//   rails[]           { row, lane } — segmen tegak dari baris ini ke baris berikutnya
//   lanes             jumlah rel yang dibutuhkan (lebar pita)
export function layoutGitGraph(commits) {
  const input = Array.isArray(commits) ? commits : [];
  const bySha = new Map(input.map((c, i) => [c.sha, i]));
  const out = input.map((c) => ({ ...c, lane: 0 }));
  const rowOf = new Map(out.map((c, i) => [c.sha, i]));
  // expected[k] = sha yang ditunggu rel k pada commit berikutnya.
  const expected = [];
  const after = [];   // salinan `expected` setelah setiap baris diproses

  const openRail = () => {
    const i = expected.indexOf(null);
    if (i >= 0) return i;
    expected.push(null);
    return expected.length - 1;
  };

  for (let row = 0; row < out.length; row++) {
    const c = out[row];
    let lane = expected.indexOf(c.sha);
    if (lane < 0) lane = openRail();
    expected[lane] = c.sha;
    c.lane = lane;

    // Rel lain yang juga menunggu commit ini bertemu di sini: rel itu ditutup,
    // dan garisnya diarahkan ke rel tempat commit ini digambar.
    for (let k = 0; k < expected.length; k++) {
      if (k !== lane && expected[k] === c.sha) expected[k] = null;
    }

    const parents = Array.isArray(c.parents) ? c.parents : [];
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i];
      const existing = expected.indexOf(p);
      if (existing >= 0) continue;          // sudah ada rel yang menunggunya
      if (!bySha.has(p)) {
        // Orang tua di luar halaman: tidak butuh rel, tetapi garisnya tetap
        // digambar putus-putus. Menyembunyikannya membuat commit terlihat
        // seperti akar repo.
        if (i === 0) expected[lane] = null;
        continue;
      }
      if (i === 0) expected[lane] = p;
      else expected[openRail()] = p;
    }
    if (!parents.length) expected[lane] = null;

    after.push(expected.slice());
    while (expected.length && expected[expected.length - 1] === null) expected.pop();
  }

  // Garis: setiap commit ke setiap orang tuanya. toRow adalah baris orang tua
  // yang sebenarnya, jadi garis merge melompati baris di antaranya.
  const edges = [];
  for (let row = 0; row < out.length; row++) {
    const c = out[row];
    const parents = Array.isArray(c.parents) ? c.parents : [];
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i];
      if (rowOf.has(p)) {
        edges.push({ row, lane: c.lane, toRow: rowOf.get(p), toLane: out[rowOf.get(p)].lane, kind: i === 0 ? 'parent' : 'merge' });
      } else {
        edges.push({ row, lane: c.lane, toRow: out.length, toLane: c.lane, kind: 'truncated' });
      }
    }
  }

  // Segmen tegak untuk rel yang masih menunggu sesuatu melewati baris berikutnya.
  const rails = [];
  for (let row = 0; row < after.length; row++) {
    for (let k = 0; k < after[row].length; k++) {
      if (after[row][k]) rails.push({ row, lane: k });
    }
  }

  const width = out.reduce((w, c) => Math.max(w, c.lane + 1), 0);
  // `lanes` adalah JUMLAH rel, bukan array — itulah yang dipakai UI untuk
  // menentukan lebar pita tanpa membaca setiap baris.
  return { commits: out, edges, rails, lanes: width };
}

// Daftar cabang lokal + remote, untuk pemilih cabang.
export async function listBranches(dir) {
  const r = await git(dir, ['for-each-ref', '--format=%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(HEAD)', 'refs/heads', 'refs/remotes']);
  if (!r.ok) return { repo: false, branches: [], current: null };
  const branches = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, sha, upstream, head] = line.split(FIELD);
    if (!name || name.endsWith('/HEAD')) continue;
    branches.push({
      name,
      sha: sha || null,
      upstream: upstream || null,
      current: head === '*',
      remote: name.includes('/'),
    });
  }
  const cur = branches.find((b) => b.current) || null;
  return { repo: true, branches, current: cur?.name || null };
}

// Pindah cabang tanpa pernah membuang pekerjaan: git sendiri yang menolak bila
// ada perubahan yang akan tertimpa, dan penolakan itu diteruskan apa adanya.
// Tidak ada `--force` dan tidak ada stash otomatis — keduanya berarti membuang
// sesuatu yang tidak diminta pengguna.
export async function checkoutBranch(dir, name) {
  const target = String(name || '').trim();
  if (!target) return { ok: false, code: 'BRANCH_REQUIRED', message: 'Nama cabang wajib diisi' };
  // Karakter yang memang tidak mungkin ada di nama ref. Diperiksa sebelum git
  // dipanggil supaya pesannya jelas, bukan "invalid reference" dari git.
  if (/[\s~^:?*[\]\\]/.test(target) || target.includes('..') || target.startsWith('-')) {
    return { ok: false, code: 'BRANCH_INVALID', message: `Nama cabang tidak valid: ${target}` };
  }
  const { branches } = await listBranches(dir);
  const known = branches.find((b) => b.name === target);
  if (!known) return { ok: false, code: 'BRANCH_UNKNOWN', message: `Cabang tidak dikenal: ${target}` };

  const r = await git(dir, ['checkout', target]);
  if (!r.ok) {
    const err = r.err.trim();
    // Pesan git tentang perubahan yang belum disimpan adalah jawaban yang benar;
    // UI menampilkannya supaya pengguna tahu apa yang harus dibereskan dulu.
    const dirty = /would be overwritten|Please commit your changes|Your local changes|Aborting/i.test(err);
    return {
      ok: false,
      code: dirty ? 'WORKTREE_DIRTY' : 'CHECKOUT_FAILED',
      message: dirty
        ? `Ada perubahan yang belum disimpan dan akan tertimpa. Commit atau kembalikan dulu. (${err.split('\n')[0]})`
        : (err.split('\n')[0] || 'git menolak pindah cabang'),
    };
  }
  const after = await listBranches(dir);
  return { ok: true, branch: after.current };
}

export const GRAPH_LIMITS = { MAX_COUNT, DEFAULT_COUNT };
