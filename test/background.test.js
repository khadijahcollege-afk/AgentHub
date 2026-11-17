// test/background.test.js — aturan murni perintah latar.
//
// Yang diuji di sini adalah keputusan yang MAHAL bila salah: batas jumlah
// proses, bentuk masukan yang datang dari model, potongan keluaran yang dibaca,
// dan pemetaan kode keluar menjadi status. Semuanya tanpa menjalankan proses —
// itulah alasan modulnya dipisah dari `lib/bg-runner.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const bg = await import('../lib/background.js');

test('nama tool tetap: model mengandalkan nama ini di instruksinya', () => {
  assert.equal(bg.START_BG_TOOL, 'start_background_command');
  assert.equal(bg.CHECK_BG_TOOL, 'check_background_command');
  assert.equal(bg.STOP_BG_TOOL, 'stop_background_command');
  assert.deepEqual(bg.BG_TOOLS, [bg.START_BG_TOOL, bg.CHECK_BG_TOOL, bg.STOP_BG_TOOL]);
  for (const n of bg.BG_TOOLS) assert.equal(bg.isBgTool(n), true, n);
  assert.equal(bg.isBgTool('run_command'), false);
});

test('sanitizeTaskId tidak pernah menghasilkan path yang keluar folder', () => {
  // Id dibuat server, tetapi helper ini juga dipakai untuk nilai dari URL.
  // `..` dan pemisah path harus HILANG, bukan di-encode: `%2e%2e` masih bisa
  // diterjemahkan jadi `..` oleh lapisan lain di kemudian hari.
  assert.equal(bg.sanitizeTaskId('../../etc/passwd'), 'etc-passwd');
  assert.equal(bg.sanitizeTaskId('..'), 'task');
  assert.equal(bg.sanitizeTaskId('.'), 'task');
  assert.equal(bg.sanitizeTaskId(''), 'task');
  assert.equal(bg.sanitizeTaskId(null), 'task');
  assert.equal(bg.sanitizeTaskId('abc-123_XY'), 'abc-123_XY');
  assert.ok(!bg.sanitizeTaskId('a/b\\c:d*e?f').includes('/'));
  assert.ok(!bg.sanitizeTaskId('a/b\\c:d*e?f').includes('\\'));
  assert.equal(bg.sanitizeTaskId('x'.repeat(200)).length, 80);
});

test('path keluaran tinggal di .agenthub/tasks di dalam folder kerja', () => {
  const file = bg.taskOutputPath('C:/kerja', 'abc');
  assert.equal(path.dirname(file), path.join('C:/kerja', '.agenthub', 'tasks'));
  assert.equal(bg.taskOutputRelPath('abc'), '.agenthub/tasks/abc.log');
  // Tanpa folder kerja tidak ada tempat menulis: null, bukan folder kerja
  // proses server yang kebetulan sedang berjalan.
  assert.equal(bg.taskOutputPath(null, 'abc'), null);
  assert.equal(bg.taskDir(''), null);
});

test('normalizeStartInput menolak perintah kosong dan yang terlalu panjang', () => {
  assert.equal(bg.normalizeStartInput({}).ok, false);
  assert.equal(bg.normalizeStartInput({ command: '   ' }).ok, false);
  assert.equal(bg.normalizeStartInput({ command: 42 }).ok, false);

  const long = bg.normalizeStartInput({ command: 'x'.repeat(bg.MAX_COMMAND_CHARS + 1) });
  assert.equal(long.ok, false);
  assert.match(long.error, /terlalu panjang/);
  assert.equal(bg.normalizeStartInput({ command: 'x'.repeat(bg.MAX_COMMAND_CHARS) }).ok, true);
});

test('normalizeStartInput: waitMs aneh menjadi bawaan, bukan tunggu selamanya', () => {
  assert.equal(bg.normalizeStartInput({ command: 'x' }).waitMs, bg.DEFAULT_WAIT_MS);
  // Negatif dan NaN berarti "pakai bawaan": nilai aneh dari model tidak boleh
  // memperpanjang run tanpa batas.
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: -5 }).waitMs, 0);
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: 'bukan angka' }).waitMs, bg.DEFAULT_WAIT_MS);
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: null }).waitMs, bg.DEFAULT_WAIT_MS);
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: 999999 }).waitMs, bg.MAX_WAIT_MS);
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: 1234 }).waitMs, 1234);
  assert.equal(bg.normalizeStartInput({ command: 'x', waitMs: 10.6 }).waitMs, 11);
});

test('normalizeStartInput merapikan label dan memotong yang kepanjangan', () => {
  assert.equal(bg.normalizeStartInput({ command: ' npm install ' }).command, 'npm install');
  assert.equal(bg.normalizeStartInput({ command: 'x' }).label, null);
  assert.equal(bg.normalizeStartInput({ command: 'x', label: '   ' }).label, null);
  assert.equal(bg.normalizeStartInput({ command: 'x', label: 'a'.repeat(200) }).label.length, 80);
});

test('normalizeCheckInput: id dibersihkan, tail dibatasi', () => {
  assert.equal(bg.normalizeCheckInput({}).ok, false);
  assert.equal(bg.normalizeCheckInput({ id: '  ' }).ok, false);
  const r = bg.normalizeCheckInput({ id: '../x', tail: 999999 });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'x');
  assert.equal(r.tail, bg.MAX_TAIL);
  assert.equal(bg.normalizeCheckInput({ id: 'a' }).tail, bg.MAX_TAIL);
  assert.equal(bg.normalizeCheckInput({ id: 'a', tail: 1 }).tail, 200, 'terlalu kecil dinaikkan, bukan dibiarkan kosong');
  assert.equal(bg.normalizeCheckInput({ id: 'a', tail: -3 }).tail, bg.MAX_TAIL);
});

test('tailOutput mengambil EKOR dan melaporkan bahwa ia terpotong', () => {
  const short = bg.tailOutput('halo', 100);
  assert.deepEqual(short, { text: 'halo', truncated: false, totalChars: 4 });
  const long = bg.tailOutput('a'.repeat(50) + 'GALAT', 10);
  assert.equal(long.text, 'aaaaaGALAT');
  assert.equal(long.truncated, true);
  assert.equal(long.totalChars, 55);
  // Keluaran kosong bukan kesalahan: perintah yang hanya diam tetap berhasil.
  assert.deepEqual(bg.tailOutput('', 10), { text: '', truncated: false, totalChars: 0 });
  assert.deepEqual(bg.tailOutput(null, 10), { text: '', truncated: false, totalChars: 0 });
});

test('mayStart menolak pada batas thread dan batas total', () => {
  assert.equal(bg.mayStart(0, 0).ok, true);
  assert.equal(bg.mayStart(bg.MAX_ACTIVE_PER_THREAD - 1, 0).ok, true);
  const perThread = bg.mayStart(bg.MAX_ACTIVE_PER_THREAD, bg.MAX_ACTIVE_PER_THREAD);
  assert.equal(perThread.ok, false);
  assert.match(perThread.error, /Thread ini/);
  // Batas total menang atas batas thread: pesannya harus menyebut angka total,
  // karena yang harus dihentikan bisa milik thread lain.
  const total = bg.mayStart(0, bg.MAX_ACTIVE_TOTAL);
  assert.equal(total.ok, false);
  assert.match(total.error, new RegExp(String(bg.MAX_ACTIVE_TOTAL)));
});

test('statusFromExit memisahkan gagal, selesai, dan dihentikan', () => {
  assert.equal(bg.statusFromExit({ code: 0 }), 'done');
  assert.equal(bg.statusFromExit({ code: 1 }), 'error');
  assert.equal(bg.statusFromExit({ code: 127 }), 'error');
  // Signal berarti proses dibunuh. Itu bukan kegagalan perintah — perintahnya
  // tidak pernah menyelesaikan apa pun.
  assert.equal(bg.statusFromExit({ code: null, signal: 'SIGKILL' }), 'stopped');
  assert.equal(bg.statusFromExit({ code: 1, signal: 'SIGTERM' }), 'stopped');
  assert.equal(bg.statusFromExit({ code: null, stopped: true }), 'stopped');
  assert.equal(bg.statusFromExit({ code: 0, stopped: true }), 'stopped', 'dihentikan pengguna tetap dihentikan');
});

test('startNotice: masih berjalan menyuruh lanjut, bukan menunggu', () => {
  const running = bg.startNotice({
    id: 'abc', command: 'npm install', output: 'added 1 package', running: true, exitCode: null, waitedMs: 15000,
  });
  assert.match(running, /id: abc/);
  assert.match(running, /Masih berjalan setelah 15 detik/);
  assert.match(running, new RegExp(bg.CHECK_BG_TOOL));
  assert.match(running, /Jangan menunggu di tempat/);
  // Id harus muncul dua kali: sekali di kalimat pembuka, sekali di perintah
  // lanjutan yang bisa langsung dipakai model.
  assert.equal(running.match(/abc/g).length >= 2, true);
});

test('startNotice: selesai menyebut kode keluar apa adanya', () => {
  const ok = bg.startNotice({ id: 'x', command: 'echo', output: 'halo\n', running: false, exitCode: 0, waitedMs: 300 });
  assert.match(ok, /selesai \(id: x\) dengan kode keluar 0/);
  assert.match(ok, /halo/);
  const bad = bg.startNotice({ id: 'x', command: 'echo', output: 'boom\n', running: false, exitCode: 2, waitedMs: 300 });
  assert.match(bad, /kode keluar 2/);
  assert.match(bad, /boom/);
});

test('startNotice menyebut path relatif, bukan path absolut pengguna', () => {
  const text = bg.startNotice({
    id: 'x', command: 'echo', output: '', running: false, exitCode: 0,
    relPath: bg.taskOutputRelPath('x'), waitedMs: 10,
  });
  assert.match(text, /\.agenthub\/tasks\/x\.log/);
  assert.match(text, /\(tanpa keluaran\)/);
});

test('startNotice menandai keluaran yang terpotong', () => {
  const text = bg.startNotice({
    id: 'x', command: 'big', output: 'z'.repeat(bg.MAX_TAIL + 10), running: false, exitCode: 0, waitedMs: 10,
  });
  assert.match(text, /hanya ekornya/);
  assert.equal(text.length < bg.MAX_TAIL + 1000, true, 'satu pesan tidak boleh jauh melebihi batas ekor');
});

test('checkNotice: status berjalan menyarankan memeriksa perintah interaktif', () => {
  const running = bg.checkNotice({
    id: 'q', status: 'running', exitCode: null, output: '', relPath: 'x.log', startedAt: Date.now() - 5000, endedAt: null,
  });
  assert.match(running, /masih berjalan/);
  assert.match(running, /\(belum ada keluaran\)/);
  assert.match(running, /menunggu masukan/);

  const done = bg.checkNotice({
    id: 'q', status: 'done', exitCode: 0, output: 'selesai', relPath: 'x.log',
    startedAt: 1000, endedAt: 4000,
  });
  assert.match(done, /selesai \(kode keluar 0\)/);
  assert.match(done, /Berjalan selama 3 detik/);
  assert.equal(done.includes('menunggu masukan'), false);

  const stopped = bg.checkNotice({ id: 'q', status: 'stopped', exitCode: null, output: '', relPath: 'x.log' });
  assert.match(stopped, /dihentikan/);
  const failed = bg.checkNotice({ id: 'q', status: 'error', exitCode: 1, output: '', relPath: 'x.log' });
  assert.match(failed, /gagal \(kode keluar 1\)/);
});

test('listNotice: satu baris per tugas, dan daftar kosong berbunyi jelas', () => {
  assert.match(bg.listNotice([]), /^Tidak ada perintah latar/);
  const text = bg.listNotice([
    { id: 'a1', status: 'running', exitCode: null, command: 'npm run dev' },
    { id: 'b2', status: 'done', exitCode: 0, command: 'npm install' },
    { id: 'c3', status: 'error', exitCode: 1, command: 'npm test' },
    { id: 'd4', status: 'stopped', exitCode: null, command: 'sleep 100' },
  ]);
  assert.match(text, /Perintah latar \(4\)/);
  assert.match(text, /a1 — berjalan — npm run dev/);
  assert.match(text, /b2 — selesai · exit 0 — npm install/);
  assert.match(text, /c3 — gagal · exit 1 — npm test/);
  assert.match(text, /d4 — dihentikan — sleep 100/);
  assert.equal(text.split('\n').length, 5, 'satu baris judul + satu baris per tugas');
});

test('listNotice memotong perintah yang panjang', () => {
  const text = bg.listNotice([{ id: 'a', status: 'running', exitCode: null, command: 'y'.repeat(400) }]);
  assert.equal(text.includes('y'.repeat(121)), false);
});

test('pruneList membuang yang kedaluwarsa dan menyisakan yang berjalan', () => {
  const now = 1_000_000_000;
  const old = now - bg.RETENTION_MS - 1;
  const tasks = [
    { id: 'hidup', status: 'running', startedAt: old },           // tua, tapi masih hidup
    { id: 'baru', status: 'done', startedAt: now - 1000, endedAt: now - 500 },
    { id: 'basi', status: 'done', startedAt: old, endedAt: old },
  ];
  const kept = bg.pruneList(tasks, { now });
  assert.deepEqual(kept.map((t) => t.id).sort(), ['baru', 'hidup']);
});

test('pruneList membatasi jumlah per thread dari yang paling lama', () => {
  const now = 5_000_000;
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`, status: 'done', startedAt: now - (6 - i) * 1000, endedAt: now - (6 - i) * 1000,
  }));
  const kept = bg.pruneList(tasks, { now, max: 3 });
  assert.equal(kept.length, 3);
  // Yang tersisa adalah tiga yang paling baru.
  assert.deepEqual(kept.map((t) => t.id).sort(), ['t3', 't4', 't5']);
});

test('pruneList: tugas berjalan memakan jatah, jadi yang selesai bisa habis', () => {
  const now = 5_000_000;
  const alive = [
    { id: 'r1', status: 'running', startedAt: now - 100 },
    { id: 'r2', status: 'running', startedAt: now - 200 },
  ];
  const done = [{ id: 'd1', status: 'done', startedAt: now - 300, endedAt: now - 300 }];
  const kept = bg.pruneList([...alive, ...done], { now, max: 2 });
  assert.deepEqual(kept.map((t) => t.id).sort(), ['r1', 'r2']);
  // Tugas yang masih berjalan TIDAK PERNAH dibuang, bahkan bila jatahnya nol:
  // membuang catatan proses hidup membuatnya tak bisa dihentikan lagi.
  const allAlive = bg.pruneList(alive, { now, max: 0 });
  assert.equal(allAlive.length, 2);
});
