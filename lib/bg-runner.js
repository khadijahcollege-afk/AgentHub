// lib/bg-runner.js — pemilik proses perintah latar.
//
// Pembagian dengan `lib/background.js`: modul itu memutuskan BENTUK (batas,
// kalimat, kapan selesai); modul ini memegang proses, berkas keluaran, dan
// catatan tugas. Semua yang butuh jam atau spawn ada di sini supaya aturannya
// tetap bisa diuji tanpa menjalankan apa pun.
//
// Kenapa keluaran ditulis ke BERKAS, bukan ditahan di memori:
//   • `npm install` bisa mencetak puluhan ribu baris. Menahannya di memori
//     sampai tugas selesai berarti satu perintah bisa menghabiskan memori server
//     yang dipakai semua thread.
//   • Berkas bertahan saat run selesai, tab ditutup, bahkan server dimulai
//     ulang. Itulah yang membuat "baca lagi nanti" mungkin.
//   • Yang dibaca kembali adalah EKOR berkas (`tailOutput`), jadi berkas besar
//     tidak pernah masuk konteks model sekaligus.
//
// Kenapa catatan tugas juga disimpan, padahal prosesnya tidak bisa dipulihkan:
// setelah server dimulai ulang, pengguna dan agent tetap perlu tahu bahwa
// perintah tadi ADA dan di mana ia berhenti. Tanpa catatan, satu-satunya yang
// tersisa adalah berkas `.log` tanpa nama perintah, dan agent akan mengulang
// `npm install` dari nol tanpa tahu bahwa instalasi sebelumnya sudah separuh
// jalan. Yang dipulihkan adalah KENANGANNYA, bukan prosesnya — dan statusnya
// diturunkan menjadi `error` supaya tidak ada yang menunggu proses yang sudah
// tidak ada.
//
// Kenapa proses dijalankan `detached` di POSIX: tanpanya, menghentikan server
// ikut membunuh perintah latar — padahal justru sebaliknya yang dijanjikan.
// Di Windows `detached` membuat jendela konsol baru, jadi tidak dipakai; proses
// dibunuh lewat `taskkill /t` yang ikut menutup anak-anaknya.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';
import {
  MAX_LIFETIME_MS, RETENTION_MS, tailOutput, statusFromExit,
  taskDir, taskOutputPath, taskOutputRelPath, sanitizeTaskId, pruneList,
} from './background.js';

const win = process.platform === 'win32';
const REGISTRY = 'background-tasks.json';

// Registry di memori memegang proses nyata (`child`, `fd`, timer); yang
// disimpan ke disk hanya bentuk yang bisa dibaca lagi setelah restart.
const tasks = new Map(); // id -> record

// Pendengar perubahan. Server mendaftar sekali di sini, bukan lewat `onEvent`
// milik run: tugas latar hidup lebih lama dari run, jadi pemberitahuan
// "selesai" bisa datang setelah tidak ada lagi run yang menunggu.
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(task) {
  const snapshot = view(task);
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* pendengar rusak tidak boleh menggagalkan tugas */ }
  }
}

function nowMs() { return Date.now(); }

function alive(threadId = null) {
  const all = [...tasks.values()].filter((t) => t.status === 'running');
  return threadId ? all.filter((t) => t.threadId === threadId) : all;
}

export function activeCounts(threadId) {
  return { active: alive(threadId).length, total: alive().length };
}

export function getTask(id) {
  return tasks.get(sanitizeTaskId(id)) || null;
}

export function listTasks(threadId) {
  return [...tasks.values()]
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function sizeOf(task) {
  try { return fs.statSync(task.outputFile).size; } catch { return task.bytes || 0; }
}

// Catatan yang aman dikirim ke UI/API: tanpa `child`/`fd` (tidak bisa
// diserialisasi, dan memegang handle ke proses nyata).
function view(task) {
  if (!task) return null;
  return {
    id: task.id,
    threadId: task.threadId,
    command: task.command,
    cwd: task.cwd,
    label: task.label || null,
    status: task.status,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    outputPath: task.outputRelPath || null,
    bytes: task.status === 'running' ? sizeOf(task) : (task.bytes || sizeOf(task)),
    truncated: !!task.truncated,
    recovered: !!task.recovered,
  };
}

export function taskView(id) { return view(getTask(id)); }
export function listViews(threadId) { return listTasks(threadId).map(view); }

// ---------- catatan di disk ----------
// Ditulis hanya saat tugas lahir dan saat ia berhenti. Bukan tiap potongan
// keluaran: isi keluaran sudah ada di berkasnya sendiri, dan menulis JSON di
// setiap baris `npm install` akan membuat disk lebih sibuk daripada prosesnya.
function persist() {
  try {
    writeJson(REGISTRY, [...tasks.values()].map((t) => ({ ...view(t), outputFile: t.outputFile })));
  } catch { /* catatan gagal ditulis tidak boleh menggagalkan tugas */ }
}

// ---------- berkas keluaran ----------
function ensureDir(cwd) {
  const dir = taskDir(cwd);
  if (!dir) throw Object.assign(new Error('Folder kerja belum ada'), { statusCode: 409 });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readOutput(task, limit) {
  if (!task?.outputFile) return { text: '', truncated: false, totalChars: 0 };
  let text = '';
  try { text = fs.readFileSync(task.outputFile, 'utf8'); } catch { text = ''; }
  // `truncated` di sini berarti "berkasnya lebih besar dari yang dibaca", bukan
  // "berkasnya dibuang": berkas lengkapnya tetap ada untuk dibuka pengguna.
  const out = tailOutput(text, limit);
  return { ...out, truncated: out.truncated || !!task.truncated };
}

// ---------- penyelesaian ----------
// Satu tempat untuk semua akhir: proses keluar sendiri, gagal dijalankan,
// dihentikan pengguna, atau kehabisan waktu. `status` hanya dipakai bila tugas
// masih `running` — penghentian oleh pengguna sudah menetapkan `stopped` lebih
// dulu, dan hasil `close` yang datang belakangan tidak boleh mengubahnya.
function finalize(task, { status = null, code = null, errorText = null } = {}) {
  if (task.timer) { clearTimeout(task.timer); task.timer = null; }
  if (status && task.status === 'running') {
    task.status = status;
    task.exitCode = typeof code === 'number' ? code : null;
    task.endedAt = nowMs();
  }
  if (errorText) {
    try { fs.appendFileSync(task.outputFile, `\n[gagal menjalankan: ${errorText}]\n`); } catch { /* berkas hilang */ }
    task.truncated = true;
  }
  if (task.fd != null) {
    try { fs.closeSync(task.fd); } catch { /* sudah ditutup */ }
    task.fd = null;
  }
  task.bytes = sizeOf(task);
  if (task.recovered) {
    // Catatan hasil pemulihan tidak punya proses untuk diberitakan pada saat
    // pemulihan; UI cukup membacanya sekali lewat daftar.
    task.recovered = false;
  } else {
    notify(task);
  }
  persist();
  for (const resolve of task.waiters || []) resolve(view(task));
  task.waiters = null;
}

// ---------- mulai ----------
export function start({ threadId, cwd, command, label = null }) {
  ensureDir(cwd);
  const id = crypto.randomBytes(12).toString('hex');
  const outputFile = taskOutputPath(cwd, id);
  // Berkas dibuka dengan `w`: id selalu baru, jadi tidak ada yang perlu
  // ditambahkan ke berkas lama. Nama berkas dari id acak berarti tabrakan nama
  // tidak mungkin, dan pembaca lama tidak pernah melihat keluaran tugas lain.
  const fd = fs.openSync(outputFile, 'w');

  // Cangkang dipilih sama seperti `run_command`. Skrip PowerShell di sini TIDAK
  // memakai `exit $LASTEXITCODE`: perintah latar biasanya berjalan sampai
  // dihentikan, dan pembungkus yang menormalkan kode keluar akan menyamarkan apa
  // yang sebenarnya terjadi.
  const child = spawn(
    win ? 'powershell.exe' : '/bin/sh',
    win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
    {
      cwd,
      windowsHide: true,
      detached: !win,
      stdio: ['ignore', fd, fd],
    },
  );

  const task = {
    id,
    threadId,
    command,
    label,
    cwd,
    outputFile,
    outputRelPath: taskOutputRelPath(id),
    status: 'running',
    exitCode: null,
    startedAt: nowMs(),
    endedAt: null,
    bytes: 0,
    truncated: false,
    child,
    fd,
    stopped: false,
    waiters: new Set(),
    timer: null,
  };
  tasks.set(id, task);

  // Batas umur: perintah yang tidak pernah selesai tetap harus berhenti sendiri.
  // `unref` supaya proses server tidak ditahan hidup oleh timer ini.
  task.timer = setTimeout(() => stop(id, 'lifetime'), MAX_LIFETIME_MS);
  task.timer.unref?.();

  child.on('error', (error) => finalize(task, { status: 'error', errorText: String(error.message || error) }));
  child.on('close', (code, signal) => {
    // Penghentian oleh pengguna sudah menulis `stopped`; `close` yang datang
    // setelahnya hanya merapikan berkas dan menghitung ukuran akhir.
    const status = task.status === 'running' ? statusFromExit({ code, signal, stopped: task.stopped }) : null;
    finalize(task, { status, code });
  });

  persist();
  return view(task);
}

// Menunggu tugas berhenti, paling lama `ms`. Dipakai tool supaya perintah yang
// memang cepat (`git status`) selesai di tempat, bukan memaksa model memanggil
// `check_background_command` untuk sesuatu yang sudah selesai satu detik lagi.
export function waitFor(id, ms) {
  const task = getTask(id);
  if (!task) return Promise.resolve(null);
  if (task.status !== 'running') return Promise.resolve(view(task));
  if (!(ms > 0)) return Promise.resolve(view(task));
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      task.waiters?.delete(finish);
      resolve(value);
    };
    // Penunggu juga dilepas saat batas waktunya habis: tanpa ini, satu run yang
    // menunggu lama menumpuk penunggu di tugas yang mungkin hidup berjam-jam.
    const timer = setTimeout(() => finish(view(task)), ms);
    timer.unref?.();
    task.waiters.add(finish);
  });
}

// ---------- berhenti ----------
export function stop(id, reason = 'user') {
  const task = getTask(id);
  if (!task) return { ok: false, error: 'Perintah latar tidak ditemukan' };
  if (task.status !== 'running') return { ok: true, task: view(task), already: true };
  task.stopped = true;
  const pid = task.child?.pid;
  if (!pid) {
    finalize(task, { status: 'stopped' });
    return { ok: true, task: view(task) };
  }
  if (win) {
    // `taskkill /t` ikut menutup anak proses: `npm run dev` menjalankan node
    // sebagai anak, dan membunuh hanya PowerShell-nya meninggalkan server yang
    // masih memegang port — persis yang membuat "hentikan" tidak bekerja.
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { task.child.kill(); } catch { /* sudah mati */ } });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { task.child.kill('SIGKILL'); } catch { /* sudah mati */ } }
  }
  // Status ditulis sekarang, bukan menunggu `close`: pengguna menekan "hentikan"
  // dan berhak melihatnya berhenti seketika. `close` akan datang dan hanya
  // merapikan sisa.
  task.status = 'stopped';
  task.endedAt = nowMs();
  task.exitCode = null;
  if (reason === 'lifetime') {
    try { fs.appendFileSync(task.outputFile, `\n[dihentikan otomatis setelah ${Math.round(MAX_LIFETIME_MS / 60000)} menit]\n`); } catch { /* berkas hilang */ }
  }
  if (task.timer) { clearTimeout(task.timer); task.timer = null; }
  notify(task);
  persist();
  for (const resolve of task.waiters || []) resolve(view(task));
  task.waiters = null;
  return { ok: true, task: view(task) };
}

export function stopThread(threadId) {
  const running = listTasks(threadId).filter((t) => t.status === 'running');
  for (const t of running) stop(t.id, 'thread');
  return running.length;
}

// ---------- pemulihan setelah server mulai ----------
// Tiga hal yang harus benar setelah restart:
//   1. Tugas yang tercatat "berjalan" tidak lagi punya proses. Ia ditandai
//      `error` — bukan dibiarkan "berjalan", karena agent yang membacanya akan
//      menunggu proses yang sudah tidak ada.
//   2. Berkas keluarannya TIDAK dihapus. Isinya justru satu-satunya yang tersisa
//      dari perintah itu, dan sering persis yang dibutuhkan untuk tahu di mana
//      ia berhenti.
//   3. Catatannya tetap terlihat di daftar, dengan `recovered: true`, supaya
//      tidak tampak seperti tugas yang baru saja gagal.
export function recover() {
  const saved = readJson(REGISTRY, []);
  const list = Array.isArray(saved) ? saved : [];
  let fixed = 0;
  let loaded = 0;
  for (const rec of list) {
    if (!rec?.id) continue;
    const id = sanitizeTaskId(rec.id);
    if (tasks.has(id)) continue;
    const wasRunning = rec.status === 'running';
    const task = {
      id,
      threadId: rec.threadId || null,
      command: String(rec.command || ''),
      label: rec.label || null,
      cwd: rec.cwd || null,
      outputFile: rec.outputFile || null,
      outputRelPath: rec.outputPath || taskOutputRelPath(id),
      status: wasRunning ? 'error' : (rec.status || 'error'),
      exitCode: wasRunning ? null : (rec.exitCode ?? null),
      startedAt: rec.startedAt || nowMs(),
      endedAt: wasRunning ? nowMs() : (rec.endedAt ?? null),
      bytes: rec.bytes || 0,
      truncated: !!rec.truncated,
      recovered: true,
      child: null,
      fd: null,
      stopped: false,
      onEvent: null,
      waiters: null,
      timer: null,
    };
    if (wasRunning) {
      try { fs.appendFileSync(task.outputFile, '\n[terputus: server berhenti saat perintah ini berjalan]\n'); } catch { /* berkas hilang */ }
      fixed++;
    }
    tasks.set(id, task);
    loaded++;
  }
  if (loaded) persist();
  return { loaded, fixed };
}

// Membersihkan registry dan berkas lama. Dipanggil berkala oleh server, bukan
// tiap permintaan: pemindaian folder tiap panggilan tool akan lebih mahal
// daripada manfaatnya.
export function prune(threadIds = null) {
  let removed = 0;
  const keep = new Set(threadIds || []);
  for (const [id, t] of [...tasks.entries()]) {
    if (t.status === 'running') continue;
    const expired = nowMs() - (t.endedAt || t.startedAt || 0) > RETENTION_MS;
    const orphan = threadIds && !keep.has(t.threadId);
    if (expired || orphan) { tasks.delete(id); removed++; }
  }
  // Batas per thread: yang paling lama selesai dibuang lebih dulu.
  const byThread = new Map();
  for (const t of tasks.values()) {
    if (!byThread.has(t.threadId)) byThread.set(t.threadId, []);
    byThread.get(t.threadId).push(t);
  }
  for (const list of byThread.values()) {
    const kept = pruneList(list.map((t) => ({ ...t })), { now: nowMs() });
    const keptIds = new Set(kept.map((t) => t.id));
    for (const t of list) {
      if (!keptIds.has(t.id)) { tasks.delete(t.id); removed++; }
    }
  }
  if (removed) persist();
  return removed;
}

// Untuk jalur "server berhenti": menghentikan SEMUA proses tanpa menghapus
// catatan. Tugas yang dihentikan karena shutdown tetap bisa dibaca sesudahnya.
export function stopAll() {
  for (const t of alive()) stop(t.id, 'shutdown');
  return true;
}

export function _reset() {
  for (const t of tasks.values()) {
    if (t.timer) clearTimeout(t.timer);
    if (t.fd != null) { try { fs.closeSync(t.fd); } catch { /* sudah ditutup */ } }
  }
  tasks.clear();
}
