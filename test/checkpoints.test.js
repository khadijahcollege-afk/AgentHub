// test/checkpoints.test.js — snapshot berkas per putaran: index sementara tidak
// menyentuh staging pengguna, diff antar-snapshot benar, restore menolak menimpa
// perubahan tak terduga, dan force melewatinya.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-'));
process.env.AGENTHUB_DATA = dir;

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-repo-'));
const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const cp = await import('../lib/checkpoints.js');
const THREAD = 'aaaaaaaaaaaa';

test.before(() => {
  if (!GIT) return;
  g('init', '-b', 'main');
  g('config', 'user.email', 'uji@contoh.test');
  g('config', 'user.name', 'Uji');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'versi satu\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b awal\n');
  g('add', '-A');
  g('commit', '-m', 'awal');
});

test.after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
});

test('snapshot tidak menyentuh index atau HEAD pengguna', { skip: !GIT }, async () => {
  // staging area sengaja dikotori: snapshot tidak boleh mengubahnya
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'ter-stage\n');
  g('add', 'staged.txt');
  const before = g('status', '--porcelain=v1', '-uall');
  const head = g('rev-parse', 'HEAD');

  const entry = await cp.createCheckpoint(THREAD, repo, { label: 'awal' });
  assert.equal(entry.files >= 3, true);
  assert.equal(entry.scope, '');
  assert.equal(entry.commit.length, 40);

  assert.equal(g('status', '--porcelain=v1', '-uall'), before, 'git status tidak berubah');
  assert.equal(g('rev-parse', 'HEAD'), head, 'HEAD tidak berpindah');
  // hidden ref ada, dan tidak ada branch baru yang terlihat pengguna
  assert.equal(g('for-each-ref', '--format=%(refname)', entry.ref).trim(), entry.ref);
  assert.equal(g('branch', '--list').includes('agenthub'), false);
});

test('checkpoint tercatat per thread dan bisa dipangkas', { skip: !GIT }, async () => {
  const list = cp.listCheckpoints(THREAD);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'awal');
  assert.equal(cp.summary(THREAD).count, 1);
  assert.equal(cp.summary('thread-lain').count, 0);

  const pruned = await cp.pruneCheckpoints([]);
  assert.equal(pruned, 1);
  assert.equal(cp.listCheckpoints(THREAD).length, 0);
});

test('diff menandai tambah, ubah, dan hapus dibatasi folder kerja', { skip: !GIT }, async () => {
  const base = await cp.createCheckpoint(THREAD, repo, { label: 'base' });
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'versi dua\n');
  fs.writeFileSync(path.join(repo, 'src', 'baru.txt'), 'baru\n');
  fs.rmSync(path.join(repo, 'b.txt'));
  const next = await cp.createCheckpoint(THREAD, repo, { label: 'sesudah' });

  const d = await cp.diffCheckpoints(base.id, next.id);
  assert.equal(d.count, 3);
  const byPath = new Map(d.files.map((f) => [f.path, f.status]));
  assert.equal(byPath.get('src/a.txt'), 'modified');
  assert.equal(byPath.get('src/baru.txt'), 'added');
  assert.equal(byPath.get('b.txt'), 'deleted');

  // scope subfolder: berkas di luar src/ terlihat "hilang" dari snapshot itu
  // (memang begitu — snapshot subfolder hanya memuat isi subfolder), sedangkan
  // isi src/ yang tidak berubah tidak dilaporkan sama sekali.
  const sub = await cp.createCheckpoint(THREAD, path.join(repo, 'src'), { label: 'sub' });
  assert.equal(sub.scope, 'src');
  assert.equal(sub.files, 2, 'hanya isi src/ yang masuk snapshot');
  const d2 = await cp.diffCheckpoints(next.id, sub.id);
  assert.equal(d2.files.some((f) => f.path.startsWith('src/a.txt')), false, 'isi src/ tidak berubah');
  assert.equal(d2.files.every((f) => !f.path.startsWith('src/')), true, 'hanya berkas di luar scope yang dilaporkan hilang');
});

// Git di Windows dapat menulis ulang LF→CRLF saat restore; isi logisnya yang
// diuji, jadi perbandingan meratakan akhir baris.
const readText = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

test('restore mengembalikan isi berkas dan menghapus berkas baru', { skip: !GIT }, async () => {
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'versi tiga\n');
  fs.writeFileSync(path.join(repo, 'src', 'sementara.txt'), 'sementara\n');
  const afterEdit = await cp.createCheckpoint(THREAD, repo, { label: 'setelah edit' });
  const before = cp.listCheckpoints(THREAD).find((c) => c.label === 'sesudah');
  assert.ok(before, 'checkpoint sesudah harus ada');

  const r = await cp.restoreCheckpoint(THREAD, {
    fromId: afterEdit.id, toId: before.id,
    paths: ['src/a.txt', 'src/sementara.txt'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.equal(readText('src/a.txt'), 'versi dua\n');
  assert.equal(fs.existsSync(path.join(repo, 'src', 'sementara.txt')), false, 'berkas baru ikut dihapus');
});

test('restore menolak menimpa perubahan yang tidak terduga, force melewatinya', { skip: !GIT }, async () => {
  const anchor = await cp.createCheckpoint(THREAD, repo, { label: 'anchor' });
  // perubahan ini terjadi SETELAH snapshot anchor: tidak tercatat di checkpoint
  // mana pun, jadi restore tidak berhak menimpanya tanpa izin eksplisit.
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'pengguna ubah manual\n');

  const target = await cp.createCheckpoint(THREAD, repo, { label: 'target' });
  // disk menyimpang lagi setelah snapshot target dibuat
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'menyimpang\n');

  const blocked = await cp.restoreCheckpoint(THREAD, { fromId: anchor.id, toId: target.id, paths: ['src/a.txt'] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.conflicts.length, 1);
  assert.equal(blocked.conflicts[0].reason, 'content-mismatch');
  assert.equal(readText('src/a.txt'), 'menyimpang\n', 'penolakan tidak boleh mengubah berkas');

  const forced = await cp.restoreCheckpoint(THREAD, { fromId: anchor.id, toId: target.id, paths: ['src/a.txt'], force: true });
  assert.equal(forced.ok, true);
  assert.equal(readText('src/a.txt'), 'pengguna ubah manual\n');
});

test('path di luar diff ditolak, checkpoint asing ditolak', { skip: !GIT }, async () => {
  const a = await cp.createCheckpoint(THREAD, repo, { label: 'a' });
  const b = await cp.createCheckpoint(THREAD, repo, { label: 'b' });
  await assert.rejects(
    () => cp.restoreCheckpoint(THREAD, { fromId: a.id, toId: b.id, paths: ['file-yang-tidak-berubah.txt'] }),
    /Tidak ada path yang berubah/,
  );
  await assert.rejects(
    () => cp.restoreCheckpoint('thread-lain', { fromId: a.id, toId: b.id }),
    /tidak ditemukan/,
  );
  await assert.rejects(() => cp.diffCheckpoints(a.id, 'tidak-ada'), /tidak ditemukan/);
});

test('folder bukan repo ditolak sebagai 409, bukan 500', { skip: !GIT }, async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-plain-'));
  try {
    await assert.rejects(
      () => cp.createCheckpoint(THREAD, plain),
      (e) => e.statusCode === 409 && /bukan repo git/.test(e.message),
    );
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('hapus checkpoint menghapus ref dan entri', { skip: !GIT }, async () => {
  const list = cp.listCheckpoints(THREAD);
  assert.equal(list.length > 0, true);
  const victim = list[0];
  assert.equal(await cp.deleteCheckpoint(victim.id), true);
  assert.equal(cp.getCheckpoint(victim.id), null);
  assert.equal(g('for-each-ref', '--format=%(refname)', victim.ref).trim(), '');
  assert.equal(await cp.deleteCheckpoint(victim.id), false);
});
