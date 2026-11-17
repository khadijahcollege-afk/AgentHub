// lib/background.js — aturan murni untuk perintah latar (background tasks).
//
// Masalah yang diselesaikan: `run_command` sepenuhnya sinkron. Perintah yang
// lebih lama dari 120 detik dibunuh, dan yang dilihat model adalah "Perintah
// melewati batas 120 detik" — tanpa keluaran, tanpa cara melanjutkan. Padahal
// perintah yang paling sering dibutuhkan agent justru yang panjang: `npm
// install`, `npm run dev`, server pengembangan, `pytest` seluruh suite. Yang
// diambil dari ZCode (docs/bash-background-parity.md,
// docs/background-bash-output-details.md) adalah semantiknya, bukan
// implementasinya:
//
//   • Perintah latar adalah TASK, bukan run. Ia hidup lebih lama dari run yang
//     memulainya, dan run boleh selesai sementara ia masih berjalan.
//   • Keluarannya berkas, bukan memori. Tab browser ditutup, run selesai, server
//     dimulai ulang — keluarannya masih bisa dibaca.
//   • Satu id, satu proses. Menjalankan ulang berarti id baru; pembaca lama
//     tidak boleh tiba-tiba melihat keluaran proses lain.
//   • Menunggu itu opsional dan berbatas. Tool boleh menunggu sebentar supaya
//     perintah pendek selesai di tempat, tetapi tidak boleh menahan run selama
//     perintah panjang.
//
// Modul ini sengaja tanpa spawn dan tanpa jam: semua keputusan yang bisa salah
// (bentuk masukan, batas, kapan dianggap selesai, potongan keluaran) diuji tanpa
// proses nyata. `lib/bg-runner.js` yang menjalankan prosesnya.
import path from 'node:path';

export const START_BG_TOOL = 'start_background_command';
export const CHECK_BG_TOOL = 'check_background_command';
export const STOP_BG_TOOL = 'stop_background_command';

export const BG_TOOLS = [START_BG_TOOL, CHECK_BG_TOOL, STOP_BG_TOOL];

// Batas jumlah proses hidup per thread. Bukan angka besar: perintah latar yang
// menumpuk tanpa batas adalah cara paling mudah membuat mesin pengguna kehabisan
// memori, dan agent yang menumpuk sepuluh server pengembangan tidak sedang
// membantu siapa pun.
export const MAX_ACTIVE_PER_THREAD = 3;
export const MAX_ACTIVE_TOTAL = 8;

// Keluaran disimpan ke berkas dan dibaca bertahap. `MAX_TAIL` adalah berapa
// karakter yang dikembalikan ke model sekali baca: cukup untuk membaca galat,
// tidak cukup untuk membanjiri konteks.
export const MAX_TAIL = 16000;

// Perintah yang lebih panjang dari ini bukan perintah, ia skrip yang ditempel.
export const MAX_COMMAND_CHARS = 8000;

// Lama menunggu bawaan saat memulai: cukup untuk perintah yang memang cepat
// (`npm run build` kecil, `git status`), terlalu pendek untuk menyembunyikan
// perintah panjang. Batas atasnya kecil dengan sengaja — menunggu lebih lama
// hanya membuat run tampak menggantung.
export const DEFAULT_WAIT_MS = 15000;
export const MAX_WAIT_MS = 60000;

// Perintah latar yang tidak pernah selesai tetap harus berhenti sendiri. Batas
// ini panjang (satu jam) karena ada perintah sah yang memang berjalan lama,
// tetapi tanpa batas sama sekali satu proses yang lupa ditutup akan hidup
// sampai server mati.
export const MAX_LIFETIME_MS = 60 * 60 * 1000;

// Berapa lama task yang sudah selesai tetap disimpan. Cukup untuk dibaca setelah
// pengguna kembali dari makan siang, tidak cukup untuk menumpuk selamanya.
export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_TASKS_PER_THREAD = 20;

export const BG_DIR = '.agenthub';
export const BG_SUBDIR = 'tasks';

function bad(error) { return { ok: false, error }; }

export function isBgTool(name) {
  return BG_TOOLS.includes(name);
}

// Nama berkas dari id task. Sumbernya id yang dibuat server, tetapi helper ini
// juga dipakai untuk nilai yang datang dari URL, jadi `.`/`..` dan pemisah path
// harus hilang — bukan di-encode.
export function sanitizeTaskId(value) {
  const s = String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return s.slice(0, 80) || 'task';
}

export function taskDir(cwd) {
  if (!cwd) return null;
  return path.join(cwd, BG_DIR, BG_SUBDIR);
}

export function taskOutputPath(cwd, id) {
  const dir = taskDir(cwd);
  if (!dir) return null;
  return path.join(dir, `${sanitizeTaskId(id)}.log`);
}

// Path relatif untuk ditampilkan ke pengguna dan disebut model: path absolut
// folder pengguna tidak perlu muncul di UI.
export function taskOutputRelPath(id) {
  return `${BG_DIR}/${BG_SUBDIR}/${sanitizeTaskId(id)}.log`;
}

export function normalizeStartInput(input = {}) {
  // Perintah harus string. Angka/objek yang lolos akan dijalankan sebagai teks
  // `[object Object]` — kegagalan yang membingungkan jauh dari penyebabnya.
  if (typeof input.command !== 'string') return bad('`command` wajib berupa teks.');
  const command = input.command.trim();
  if (!command) return bad('`command` wajib diisi.');
  if (command.length > MAX_COMMAND_CHARS) {
    return bad(`Perintah terlalu panjang: ${command.length} karakter, maksimal ${MAX_COMMAND_CHARS}. Simpan sebagai skrip lalu jalankan skripnya.`);
  }
  // `waitMs` kosong berarti "pakai bawaan". Angka negatif berarti "jangan
  // menunggu" — dibaca sebagai 0, bukan nilai aneh yang jatuh ke bawaan. Yang
  // harus dijaga: nilai yang tidak bisa dibaca tidak boleh memperpanjang run,
  // dan `null`/`''` tidak boleh diam-diam menjadi 0 lewat `Number(null)`.
  const rawValue = input.waitMs;
  const missing = rawValue === undefined || rawValue === null || rawValue === '';
  const raw = Number(rawValue);
  const waitMs = !missing && Number.isFinite(raw)
    ? Math.min(MAX_WAIT_MS, Math.max(0, Math.round(raw)))
    : DEFAULT_WAIT_MS;
  return { ok: true, command, waitMs, label: String(input.label || '').trim().slice(0, 80) || null };
}

export function normalizeCheckInput(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) return bad('`id` wajib diisi.');
  const raw = Number(input.tail);
  const tail = Number.isFinite(raw) && raw > 0 ? Math.min(MAX_TAIL, Math.max(200, Math.round(raw))) : MAX_TAIL;
  return { ok: true, id: sanitizeTaskId(id), tail };
}

// Keluaran bisa sangat besar (`npm install` mencetak ribuan baris). Yang
// dikembalikan ke model adalah EKORNYA, bukan kepalanya: galat dan ringkasan
// selalu muncul di akhir, sementara kepala biasanya hanya spanduk pemasangan.
// `truncated` diberitahukan supaya model tidak mengira ia sudah membaca semua.
export function tailOutput(text, limit = MAX_TAIL) {
  const s = String(text || '');
  if (s.length <= limit) return { text: s, truncated: false, totalChars: s.length };
  return { text: s.slice(-limit), truncated: true, totalChars: s.length };
}

export function mayStart(activeCount, totalCount) {
  if (totalCount >= MAX_ACTIVE_TOTAL) {
    return { ok: false, error: `Sudah ada ${totalCount} perintah latar berjalan (maksimal ${MAX_ACTIVE_TOTAL}). Hentikan salah satu dulu.` };
  }
  if (activeCount >= MAX_ACTIVE_PER_THREAD) {
    return { ok: false, error: `Thread ini sudah menjalankan ${activeCount} perintah latar (maksimal ${MAX_ACTIVE_PER_THREAD}). Hentikan salah satu dulu.` };
  }
  return { ok: true };
}

// Status akhir dari kode keluar. Tanda negatif pada POSIX berarti proses dibunuh
// signal, dan itu bukan "gagal menjalankan" — itu dihentikan.
export function statusFromExit({ code, signal = null, stopped = false }) {
  if (stopped) return 'stopped';
  if (signal) return 'stopped';
  if (code === 0) return 'done';
  return 'error';
}

// Kalimat yang dibaca model. Dibuat di sini, bukan di runner, supaya bentuknya
// bisa diuji tanpa proses: model bergantung pada kalimat ini untuk tahu apakah
// ia harus menunggu, membaca lagi, atau berhenti.
export function startNotice({ id, command, output, running, exitCode, truncated, relPath, waitedMs }) {
  const parts = [];
  if (running) {
    parts.push(`Perintah latar dimulai (id: ${id}).`);
    parts.push(`Masih berjalan setelah ${Math.round((waitedMs || 0) / 1000)} detik — ini normal untuk perintah panjang.`);
    parts.push(`Baca keluarannya dengan ${CHECK_BG_TOOL} (id: "${id}"), atau hentikan dengan ${STOP_BG_TOOL}.`);
    parts.push('Jangan menunggu di tempat: lanjutkan pekerjaan lain, lalu periksa lagi.');
  } else if (exitCode === 0) {
    parts.push(`Perintah selesai (id: ${id}) dengan kode keluar 0.`);
  } else {
    parts.push(`Perintah selesai (id: ${id}) dengan kode keluar ${exitCode}.`);
  }
  parts.push(`Keluaran lengkap tersimpan di ${relPath}.`);
  const tail = tailOutput(output);
  if (tail.text.trim()) {
    parts.push('');
    parts.push(truncated || tail.truncated ? '[keluaran — hanya ekornya]' : '[keluaran]');
    parts.push(tail.text.trim());
  } else if (!running) {
    parts.push('(tanpa keluaran)');
  }
  return parts.join('\n');
}

export function checkNotice({ id, status, exitCode, output, truncated, relPath, startedAt, endedAt }) {
  const head = status === 'running'
    ? `Perintah latar ${id} masih berjalan.`
    : status === 'done'
      ? `Perintah latar ${id} selesai (kode keluar ${exitCode}).`
      : status === 'stopped'
        ? `Perintah latar ${id} dihentikan.`
        : `Perintah latar ${id} gagal (kode keluar ${exitCode}).`;
  const parts = [head];
  if (endedAt && startedAt) parts.push(`Berjalan selama ${Math.round((endedAt - startedAt) / 1000)} detik.`);
  parts.push(`Keluaran lengkap: ${relPath}.`);
  const tail = tailOutput(output);
  if (tail.text.trim()) {
    parts.push('');
    parts.push(truncated || tail.truncated ? '[keluaran — hanya ekornya]' : '[keluaran]');
    parts.push(tail.text.trim());
  } else {
    parts.push('(belum ada keluaran)');
  }
  if (status === 'running') {
    parts.push('');
    parts.push('Kalau perintah ini seharusnya sudah selesai, periksa apakah ia menunggu masukan — perintah interaktif tidak bisa dijawab dari sini. Hentikan dengan ' + STOP_BG_TOOL + ' bila perlu.');
  }
  return parts.join('\n');
}

// Ringkasan untuk daftar task (tool tanpa `id` dan panel UI). Sengaja satu baris
// per task: daftar panjang dibaca dengan mata, dan kolom yang rata lebih mudah
// dipindai daripada paragraf.
export function listNotice(tasks) {
  if (!tasks.length) return 'Tidak ada perintah latar untuk thread ini.';
  const lines = tasks.map((t) => {
    const state = t.status === 'running' ? 'berjalan' : t.status === 'done' ? 'selesai' : t.status === 'stopped' ? 'dihentikan' : 'gagal';
    const code = t.exitCode == null ? '' : ` · exit ${t.exitCode}`;
    return `- ${t.id} — ${state}${code} — ${t.command.slice(0, 120)}`;
  });
  return [`Perintah latar (${tasks.length}):`, ...lines].join('\n');
}

// Pembersihan: task yang sudah selesai lebih lama dari RETENTION_MS dibuang, dan
// jumlah per thread dibatasi dari yang paling lama. Task yang masih berjalan
// TIDAK pernah dibuang, berapa pun umurnya — membuang catatan proses yang masih
// hidup membuatnya tak bisa dihentikan lagi.
export function pruneList(tasks, { now = Date.now(), retentionMs = RETENTION_MS, max = MAX_TASKS_PER_THREAD } = {}) {
  const alive = [];
  const done = [];
  for (const t of tasks) {
    if (t.status === 'running') alive.push(t);
    else if (now - (t.endedAt || t.startedAt || 0) <= retentionMs) done.push(t);
  }
  done.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const room = Math.max(0, max - alive.length);
  return [...alive, ...done.slice(0, room)];
}
