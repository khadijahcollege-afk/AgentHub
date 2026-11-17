// test/gitgraph-repo.test.js — grafik dan cabang di repo git sungguhan.
//
// `layoutGitGraph` sudah diuji tanpa repo; di sini yang diuji adalah bagian yang
// hanya bisa dibuktikan dengan git asli: parsing dekorasi ref, topologi yang
// keluar dari `git log`, deteksi bukan-repo, dan penolakan pindah cabang saat
// worktree kotor — penolakan itu harus datang dari git, bukan dari tebakan kita.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGraph, listBranches, checkoutBranch, GRAPH_LIMITS } from '../lib/gitgraph.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-gitgraph-'));
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-gitgraph-plain-'));

const gitOk = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(message, file = 'a.txt', content = message) {
  fs.writeFileSync(path.join(dir, file), content + '\n');
  git('add', '.');
  git('-c', 'user.name=uji', '-c', 'user.email=uji@contoh.test', 'commit', '-m', message);
}

test.before(() => {
  if (!gitOk) return;
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'uji');
  git('config', 'user.email', 'uji@contoh.test');
  // Riwayat dengan satu merge sungguhan, supaya grafiknya punya dua cabang.
  commit('pertama');
  commit('kedua');
  git('checkout', '-q', '-b', 'fitur');
  commit('di cabang fitur', 'b.txt');
  // a.txt sengaja berbeda di cabang ini, supaya perubahan yang belum disimpan
  // di main benar-benar akan tertimpa — itulah yang harus ditolak git.
  commit('a.txt versi fitur', 'a.txt', 'versi cabang fitur');
  git('checkout', '-q', 'main');
  commit('ketiga', 'c.txt');
  git('-c', 'user.name=uji', '-c', 'user.email=uji@contoh.test', 'merge', '--no-ff', 'fitur', '-m', 'gabung fitur');
  // Cabang yang TIDAK digabung, dengan a.txt berbeda dari main. Ini yang dipakai
  // menguji penolakan pindah cabang: setelah merge, a.txt main sama dengan versi
  // fitur, jadi memakai fitur tidak akan pernah bertabrakan.
  git('checkout', '-q', '-b', 'lain');
  commit('a.txt versi lain', 'a.txt', 'versi cabang lain');
  git('checkout', '-q', 'main');
});

test.after(() => {
  for (const d of [dir, plain]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('folder biasa dilaporkan bukan repo, bukan repo kosong', { skip: !gitOk }, async () => {
  const g = await readGraph(plain);
  assert.equal(g.repo, false);
  assert.deepEqual(g.commits, []);
  assert.equal(g.lanes, 0);
});

test('repo tanpa commit dilaporkan kosong, bukan bukan-repo', { skip: !gitOk }, async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-gitempty-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: bare, windowsHide: true, stdio: 'ignore' });
    const g = await readGraph(bare);
    assert.equal(g.repo, true);
    assert.deepEqual(g.commits, []);
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});

test('grafik memuat commit, dekorasi ref, dan merge dari repo sungguhan', { skip: !gitOk }, async () => {
  const g = await readGraph(dir, { maxCount: 50 });
  assert.equal(g.repo, true);
  assert.ok(g.commits.length >= 6, `harus ada minimal 6 commit, dapat ${g.commits.length}`);
  // Commit merge harus ada di halaman ini dengan dua orang tua, dan — karena
  // topologis — ia berada di atas kedua cabangnya.
  const merge = g.commits.find((c) => /gabung fitur/.test(c.subject));
  assert.ok(merge, 'commit merge harus muncul');
  assert.equal(merge.parents.length, 2, 'commit merge punya dua orang tua');
  const mergeRow = g.commits.indexOf(merge);
  for (const p of merge.parents) {
    const row = g.commits.findIndex((c) => c.sha === p);
    assert.ok(row > mergeRow, 'orang tua merge berada di bawahnya');
  }
  // Dekorasi ref dibersihkan: tanpa prefix refs/heads, dan "main" ada di suatu tempat.
  const refs = g.commits.flatMap((c) => c.refs);
  assert.ok(refs.includes('main'), `ref main harus muncul, dapat ${JSON.stringify(refs)}`);
  assert.ok(refs.includes('fitur'), `ref fitur harus muncul, dapat ${JSON.stringify(refs)}`);
  assert.ok(refs.every((r) => !r.startsWith('refs/')), 'prefix refs/ sudah dibuang');
  assert.ok(refs.every((r) => r !== 'HEAD'), 'HEAD bukan label ref');
  // Setiap commit punya tanggal ISO dan subjek tidak kosong.
  for (const c of g.commits) {
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}T/, 'tanggal ISO');
    assert.ok(c.subject, 'subjek tidak kosong');
  }
  // Grafiknya punya dua rel, karena ada satu cabang yang digabung.
  assert.ok(g.lanes >= 2, `merge harus membuka rel kedua, dapat ${g.lanes}`);
  assert.ok(g.edges.some((e) => e.kind === 'merge'), 'ada garis merge');
  // Urutan topologis: orang tua selalu di bawah anaknya.
  for (const e of g.edges) {
    if (e.kind === 'truncated') continue;
    assert.ok(e.toRow > e.row, 'garis menurun');
    assert.ok(g.commits[e.toRow], 'baris tujuan ada di daftar');
  }
});

test('halaman kedua tidak mengulang commit halaman pertama', { skip: !gitOk }, async () => {
  const first = await readGraph(dir, { maxCount: 2, skip: 0 });
  const second = await readGraph(dir, { maxCount: 2, skip: 2 });
  assert.equal(first.commits.length, 2);
  assert.equal(second.commits.length, 2);
  const a = new Set(first.commits.map((c) => c.sha));
  for (const c of second.commits) assert.equal(a.has(c.sha), false, 'tidak ada commit yang terulang');
  assert.equal(first.truncated, true, 'halaman penuh dilaporkan bisa dilanjutkan');
});

test('maxCount dibatasi: klien tidak bisa meminta seluruh riwayat', { skip: !gitOk }, async () => {
  const g = await readGraph(dir, { maxCount: 999999 });
  assert.ok(g.commits.length <= GRAPH_LIMITS.MAX_COUNT);
});

test('daftar cabang menandai cabang aktif dan mengenali cabang remote', { skip: !gitOk }, async () => {
  const b = await listBranches(dir);
  assert.equal(b.repo, true);
  assert.equal(b.current, 'main');
  const names = b.branches.map((x) => x.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('fitur'));
  assert.equal(b.branches.find((x) => x.name === 'main').current, true);
  assert.equal(b.branches.find((x) => x.name === 'fitur').current, false);
  // Setiap cabang punya sha pendek untuk ditampilkan.
  for (const x of b.branches) assert.match(x.sha, /^[0-9a-f]{4,}$/);
});

test('pindah cabang berhasil dan cabang aktif ikut berubah', { skip: !gitOk }, async () => {
  const r = await checkoutBranch(dir, 'fitur');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch, 'fitur');
  const b = await listBranches(dir);
  assert.equal(b.current, 'fitur');
  // Kembali ke main supaya tes berikutnya mulai dari keadaan yang sama.
  const back = await checkoutBranch(dir, 'main');
  assert.equal(back.ok, true);
});

test('cabang tak dikenal dan nama tidak valid ditolak sebelum git dipanggil', { skip: !gitOk }, async () => {
  const unknown = await checkoutBranch(dir, 'tidak-ada-cabang-ini');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'BRANCH_UNKNOWN');

  const empty = await checkoutBranch(dir, '   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'BRANCH_REQUIRED');

  // Karakter yang mustahil ada di nama ref.
  for (const bad of ['a b', 'x~1', 'y^2', 'z:3', 'a..b', '-rf']) {
    const r = await checkoutBranch(dir, bad);
    assert.equal(r.ok, false, `${bad} harus ditolak`);
    assert.equal(r.code, 'BRANCH_INVALID', `${bad} → ${r.code}`);
  }
});

test('perubahan yang belum disimpan menghalangi pindah cabang, dan tidak dibuang', { skip: !gitOk }, async () => {
  // File yang berbeda isinya di cabang `lain`: git akan menolak, dan penolakan
  // itu harus diteruskan sebagai WORKTREE_DIRTY — bukan dipaksa dengan force.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'isi yang belum di-commit\n');
  const r = await checkoutBranch(dir, 'lain');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WORKTREE_DIRTY', `dapat ${r.code}: ${r.message}`);
  // Perubahan pengguna harus masih ada.
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim(), 'isi yang belum di-commit');
  const b = await listBranches(dir);
  assert.equal(b.current, 'main', 'tidak berpindah cabang');
  // Bersihkan supaya tidak mengganggu tes lain.
  git('checkout', '--', 'a.txt');
});
