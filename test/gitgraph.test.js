// test/gitgraph.test.js — tata letak grafik commit, diuji tanpa repo.
//
// Tata letak adalah bagian yang paling mudah salah dan paling sulit dilihat
// salahnya di layar: garis yang menyeberang terlihat "agak aneh" tapi tidak
// jelas keliru. Karena `layoutGitGraph` murni, bentuk grafik yang rumit bisa
// diuji langsung — merge, cabang yang bertemu, dan commit di luar halaman.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGitGraph } from '../lib/gitgraph.js';

// Membangun daftar commit dari peta sha → orang tua, dalam urutan tampil.
function make(order, parents) {
  return order.map((sha) => ({ sha, parents: parents[sha] || [], refs: [], author: 'uji', date: '2026-01-01T00:00:00Z', subject: sha }));
}

test('garis lurus: semua commit di rel yang sama', () => {
  const g = layoutGitGraph(make(['c', 'b', 'a'], { c: ['b'], b: ['a'] }));
  assert.deepEqual(g.commits.map((c) => c.lane), [0, 0, 0]);
  assert.equal(g.lanes, 1);
  // Hanya commit yang punya orang tua menghasilkan garis. Akar (a) tidak.
  assert.equal(g.edges.filter((e) => e.kind === 'parent').length, 2);
  assert.equal(g.edges.length, 2);
});

test('commit masukan tidak diubah: lane ada di salinan, bukan di objek asli', () => {
  const input = make(['b', 'a'], { b: ['a'] });
  const g = layoutGitGraph(input);
  assert.equal(input[0].lane, undefined, 'objek masukan tidak boleh disentuh');
  assert.equal(typeof g.commits[0].lane, 'number');
  assert.notEqual(g.commits[0], input[0], 'keluaran adalah salinan');
});

test('cabang paralel memakai dua rel, lalu menyatu kembali', () => {
  //   m  (merge dari a dan b)
  //   a  cabang kiri
  //   b  cabang kanan
  //   r  akar
  const g = layoutGitGraph(make(['m', 'a', 'b', 'r'], { m: ['a', 'b'], a: ['r'], b: ['r'] }));
  const lane = Object.fromEntries(g.commits.map((c) => [c.sha, c.lane]));
  assert.equal(lane.m, 0, 'merge ada di rel utama');
  assert.notEqual(lane.a, lane.b, 'dua cabang tidak boleh berbagi satu rel');
  assert.equal(lane.r, lane.a, 'orang tua pertama mewarisi rel cabangnya');
  assert.equal(g.lanes, 2, 'dua rel cukup untuk satu merge sederhana — bukan tiga');
  const fromMerge = g.edges.filter((e) => e.row === 0);
  assert.equal(fromMerge.filter((e) => e.kind === 'merge').length, 1, 'satu garis masuk dari samping');
  assert.equal(fromMerge.filter((e) => e.kind === 'parent').length, 1, 'satu garis lurus');
});

test('dua cabang bertemu di satu orang tua tidak menggambar rel kembar', () => {
  // a dan b sama-sama menunjuk r. r hanya boleh punya SATU rel; kalau tidak,
  // grafik tumbuh satu rel setiap merge dan akhirnya melebar tanpa isi.
  const g = layoutGitGraph(make(['a', 'b', 'r'], { a: ['r'], b: ['r'] }));
  const lanesOfR = g.commits.filter((c) => c.sha === 'r').map((c) => c.lane);
  assert.equal(lanesOfR.length, 1, 'r muncul sekali');
  const laneR = lanesOfR[0];
  const intoR = g.edges.filter((e) => e.toLane === laneR && e.toRow === 2);
  assert.equal(intoR.length, 2, 'kedua cabang berakhir di rel yang sama');
  assert.equal(g.lanes, 2, 'tidak ada rel tambahan untuk orang tua yang sama');
});

test('orang tua di luar halaman tetap diberi garis putus-putus', () => {
  // Halaman hanya memuat satu commit; orang tuanya tidak ada di daftar.
  const g = layoutGitGraph(make(['x'], { x: ['tidak-ada'] }));
  const trunc = g.edges.filter((e) => e.kind === 'truncated');
  assert.equal(trunc.length, 1, 'satu garis terpotong untuk satu orang tua di luar halaman');
  assert.equal(trunc[0].row, 0);
  assert.equal(trunc[0].toRow, 1, 'garis terpotong menunjuk keluar halaman');
});

test('commit akar (tanpa orang tua) tidak punya garis turun', () => {
  const g = layoutGitGraph(make(['a', 'b'], { a: [], b: ['a'] }));
  // a di baris 0 adalah akar: tidak ada garis dari a.
  const fromRoot = g.edges.filter((e) => e.row === 0);
  assert.equal(fromRoot.length, 0, 'akar tidak punya garis turun');
  // b punya satu garis ke a.
  assert.equal(g.edges.filter((e) => e.row === 1).length, 1);
});

test('lebar rel tidak lebih besar dari jumlah commit', () => {
  const g = layoutGitGraph(make(['m', 'a', 'b', 'c', 'r'], { m: ['a', 'b', 'c'], a: ['r'], b: ['r'], c: ['r'] }));
  assert.ok(g.lanes <= g.commits.length, `lanes ${g.lanes} tidak boleh melebihi ${g.commits.length} commit`);
  for (const c of g.commits) assert.ok(c.lane < g.lanes, 'setiap commit berada di dalam pita');
});

test('daftar kosong tidak meledak dan tidak butuh rel', () => {
  const g = layoutGitGraph([]);
  assert.deepEqual(g.commits, []);
  assert.deepEqual(g.edges, []);
  assert.equal(g.lanes, 0);
});

test('masukan bukan array diperlakukan sebagai kosong, bukan melempar', () => {
  for (const bad of [null, undefined, 42, 'abc', {}]) {
    const g = layoutGitGraph(bad);
    assert.equal(g.commits.length, 0);
    assert.equal(g.lanes, 0);
  }
});

test('orang tua yang belum muncul tetap punya rel yang berlanjut', () => {
  // m di baris 0 punya dua orang tua; b baru muncul di baris 2, jadi rel b
  // harus digambar melewati baris 1 — kalau tidak, grafiknya terputus.
  const g = layoutGitGraph(make(['m', 'a', 'b'], { m: ['a', 'b'], a: [], b: [] }));
  const railAtRow1 = g.rails.filter((r) => r.row === 1);
  assert.equal(railAtRow1.length, 1, 'tepat satu rel melewati baris 1');
  assert.equal(railAtRow1[0].lane, 1, 'rel cabang kanan yang berlanjut');
});

test('garis selalu menurun: tidak ada edge ke baris yang sama atau ke atas', () => {
  const g = layoutGitGraph(make(['m', 'a', 'b', 'r'], { m: ['a', 'b'], a: ['r'], b: ['r'] }));
  for (const e of g.edges) assert.ok(e.toRow > e.row, `edge ${JSON.stringify(e)} harus menurun`);
});

test('setiap commit yang punya orang tua di halaman mendapat tepat satu garis per orang tua', () => {
  const g = layoutGitGraph(make(['m', 'a', 'b', 'r'], { m: ['a', 'b'], a: ['r'], b: ['r'] }));
  const total = g.commits.reduce((n, c) => n + c.parents.length, 0);
  assert.equal(g.edges.length, total, 'satu garis per orang tua, tidak lebih');
  // Garis merge harus benar-benar menunjuk baris orang tuanya, bukan baris
  // berikutnya: itulah yang membuat cabang panjang terlihat menyatu.
  const merge = g.edges.find((e) => e.kind === 'merge');
  assert.equal(merge.toRow, 2, 'orang tua kedua (b) ada di baris 2');
  assert.equal(merge.toLane, 1, 'dan digambar di rel kanan');
});
