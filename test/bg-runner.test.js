// test/bg-runner.test.js — pemilik proses perintah latar, diuji dengan proses
// NYATA tetapi cepat.
//
// Prosesnya sengaja dijalankan sungguhan: seluruh nilai modul ini ada pada
// perilaku proses (kode keluar, pembunuhan anak proses, berkas keluaran), dan
// tiruan proses tidak akan menangkap kesalahan di sana. Yang dijaga supaya tetap
// cepat: perintahnya hanya `echo` dan tidur singkat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bg-data-'));
process.env.AGENTHUB_DATA = dataDir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bg-work-'));

const runner = await import('../lib/bg-runner.js');
const bg = await import('../lib/background.js');
const store = await import('../lib/store.js');

const win = process.platform === 'win32';
const echo = (text) => (win ? `Write-Output "${text}"` : `printf '%s\\n' "${text}"`);
const sleepThen = (ms, text) => (win
  ? `Start-Sleep -Milliseconds ${ms}; Write-Output "${text}"`
  : `sleep ${(ms / 1000).toFixed(3)}; printf '%s\\n' "${text}"`);
const sleepOnly = (ms) => (win ? `Start-Sleep -Milliseconds ${ms}` : `sleep ${(ms / 1000).toFixed(3)}`);

test.after(() => {
  try { runner.stopAll(); } catch { /* noop */ }
  runner._reset();
  for (const d of [dataDir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('start menjalankan perintah, menyimpan keluaran ke berkas, dan mencatat kode keluar', async () => {
  const view = runner.start({ threadId: 't1', cwd: work, command: echo('halo-latar'), label: 'echo' });
  assert.equal(view.status, 'running');
  assert.equal(view.threadId, 't1');
  assert.equal(view.label, 'echo');
  // Keluaran ada di folder kerja pengguna, bukan di folder data server.
  assert.equal(view.outputPath, bg.taskOutputRelPath(view.id));
  const file = path.join(work, '.agenthub', 'tasks', `${view.id}.log`);
  assert.equal(fs.existsSync(file), true);

  const done = await runner.waitFor(view.id, 20000);
  assert.equal(done.status, 'done');
  assert.equal(done.exitCode, 0);

  const out = runner.readOutput(runner.getTask(view.id), 4000);
  assert.match(out.text, /halo-latar/);
  assert.equal(out.truncated, false);
  // Berkasnya benar-benar berisi: `bytes` bukan angka palsu dari buffer.
  assert.equal(done.bytes > 0, true);
  assert.equal(fs.statSync(file).size, done.bytes);
});

test('kode keluar bukan nol menjadi error, bukan "done"', async () => {
  const command = win ? 'Write-Output "mulai"; exit 3' : 'printf "mulai\\n"; exit 3';
  const view = runner.start({ threadId: 't1', cwd: work, command });
  const done = await runner.waitFor(view.id, 20000);
  assert.equal(done.status, 'error');
  assert.equal(done.exitCode, 3);
  assert.match(runner.readOutput(runner.getTask(view.id), 4000).text, /mulai/);
});

test('keluaran besar dibaca sebagai EKOR dan ditandai terpotong', async () => {
  // 400 baris: cukup untuk melewati batas baca tanpa membuat tes lambat.
  const command = win
    ? '1..400 | ForEach-Object { "baris-$_" }'
    : 'for i in $(seq 1 400); do echo "baris-$i"; done';
  const view = runner.start({ threadId: 't1', cwd: work, command });
  const done = await runner.waitFor(view.id, 30000);
  assert.equal(done.status, 'done');

  const full = runner.readOutput(runner.getTask(view.id), 100000);
  assert.match(full.text, /baris-1\b/);
  assert.match(full.text, /baris-400\b/);

  const tail = runner.readOutput(runner.getTask(view.id), 400);
  assert.equal(tail.truncated, true);
  assert.equal(tail.totalChars > 400, true);
  assert.match(tail.text, /baris-400/, 'ekor harus memuat baris terakhir');
  assert.equal(tail.text.includes('baris-1\n'), false, 'kepala tidak ikut');
});

test('stop menghentikan perintah yang masih berjalan dan tidak bisa diulang', async () => {
  const view = runner.start({ threadId: 't2', cwd: work, command: sleepOnly(30000) });
  // Tunggu sebentar supaya proses benar-benar hidup sebelum dibunuh.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(runner.taskView(view.id).status, 'running');

  const stopped = runner.stop(view.id, 'user');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.already, undefined);
  assert.equal(stopped.task.status, 'stopped');
  assert.equal(runner.getTask(view.id).status, 'stopped');

  // Idempotensi penting untuk UI: tombol "hentikan" yang ditekan dua kali tidak
  // boleh menghasilkan galat.
  const again = runner.stop(view.id, 'user');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);

  // Proses benar-benar mati: `close` datang dan statusnya tidak berubah.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(runner.getTask(view.id).status, 'stopped');
});

test('stopThread hanya menghentikan milik thread itu', async () => {
  const a = runner.start({ threadId: 'ta', cwd: work, command: sleepOnly(30000) });
  const b = runner.start({ threadId: 'tb', cwd: work, command: sleepOnly(30000) });
  await new Promise((r) => setTimeout(r, 300));
  const n = runner.stopThread('ta');
  assert.equal(n >= 1, true);
  assert.equal(runner.getTask(a.id).status, 'stopped');
  assert.equal(runner.getTask(b.id).status, 'running');
  runner.stop(b.id, 'user');
});

test('activeCounts memisahkan per thread dan total', async () => {
  runner.stopAll();
  const a = runner.start({ threadId: 'tc', cwd: work, command: sleepOnly(30000) });
  const b = runner.start({ threadId: 'tc', cwd: work, command: sleepOnly(30000) });
  await new Promise((r) => setTimeout(r, 300));
  const perThread = runner.activeCounts('tc');
  assert.equal(perThread.active, 2);
  assert.equal(perThread.total >= 2, true);
  assert.equal(runner.activeCounts('lain').active, 0);
  assert.equal(runner.listViews('tc').length >= 2, true);
  // Daftar memuat yang terbaru lebih dulu.
  assert.equal(runner.listViews('tc')[0].id, b.id);
  runner.stopThread('tc');
  assert.equal(runner.activeCounts('tc').active, 0);
  runner.stop(a.id);
});

test('recover memuat catatan lama dan menandai yang "running" sebagai error', () => {
  runner._reset();
  const logFile = path.join(work, '.agenthub', 'tasks', 'lama.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'separuh jalan\n', 'utf8');
  store.writeJson('background-tasks.json', [
    {
      id: 'lama', threadId: 't3', command: 'npm install', label: null, cwd: work,
      status: 'running', exitCode: null, startedAt: Date.now() - 60000, endedAt: null,
      outputPath: bg.taskOutputRelPath('lama'), outputFile: logFile, bytes: 12, truncated: false,
    },
    {
      id: 'beres', threadId: 't3', command: 'npm ci', label: 'ci', cwd: work,
      status: 'done', exitCode: 0, startedAt: Date.now() - 90000, endedAt: Date.now() - 80000,
      outputPath: bg.taskOutputRelPath('beres'), outputFile: logFile, bytes: 12, truncated: false,
    },
  ]);

  const r = runner.recover();
  assert.equal(r.loaded, 2);
  assert.equal(r.fixed, 1);

  const lama = runner.taskView('lama');
  assert.equal(lama.status, 'error', 'tidak ada proses yang bisa ditunggu lagi');
  assert.equal(lama.recovered, true);
  // Berkasnya TIDAK dihapus: satu-satunya jejak perintah itu.
  assert.match(fs.readFileSync(logFile, 'utf8'), /terputus: server berhenti/);

  const beres = runner.taskView('beres');
  assert.equal(beres.status, 'done', 'yang sudah selesai tetap selesai');
  assert.equal(beres.exitCode, 0);

  // Pemulihan kedua tidak menggandakan apa pun.
  const again = runner.recover();
  assert.equal(again.loaded, 0);
});

test('recover tidak menimpa tugas yang sudah ada di memori', async () => {
  runner._reset();
  const view = runner.start({ threadId: 't4', cwd: work, command: echo('hidup') });
  await runner.waitFor(view.id, 20000);
  const r = runner.recover();
  assert.equal(r.loaded, 0, 'catatan yang sudah dimuat tidak perlu dimuat ulang');
  assert.equal(runner.taskView(view.id).status, 'done');
});

test('prune membuang catatan kedaluwarsa tetapi tidak pernah yang berjalan', async () => {
  runner._reset();
  const id = 'basi';
  const logFile = path.join(work, '.agenthub', 'tasks', `${id}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'x', 'utf8');
  store.writeJson('background-tasks.json', [{
    id, threadId: 't5', command: 'echo', label: null, cwd: work,
    status: 'done', exitCode: 0, startedAt: 1, endedAt: 1,
    outputPath: bg.taskOutputRelPath(id), outputFile: logFile, bytes: 1, truncated: false,
  }]);
  runner.recover();
  assert.equal(runner.taskView(id).status, 'done');

  const removed = runner.prune(['t5']);
  // Umurnya jauh lebih tua dari RETENTION_MS, jadi ia harus hilang.
  assert.equal(removed >= 1, true);
  assert.equal(runner.taskView(id), null);

  // Tugas yang berjalan tidak tersentuh, berapa pun umurnya.
  const live = runner.start({ threadId: 't5', cwd: work, command: sleepOnly(30000) });
  await new Promise((r) => setTimeout(r, 200));
  runner.prune(['t5']);
  assert.equal(runner.taskView(live.id).status, 'running');
  runner.stop(live.id);
});

test('prune membuang milik thread yang sudah tidak ada', async () => {
  runner._reset();
  const view = runner.start({ threadId: 'sudah-dihapus', cwd: work, command: echo('x') });
  await runner.waitFor(view.id, 20000);
  assert.notEqual(runner.taskView(view.id), null);
  const removed = runner.prune(['thread-lain']);
  assert.equal(removed >= 1, true);
  assert.equal(runner.taskView(view.id), null, 'thread hilang berarti catatannya ikut');
});
