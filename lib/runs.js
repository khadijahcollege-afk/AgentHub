// lib/runs.js — satu pemilik siklus hidup run.
//
// Sebelumnya `running: true/false`, `runStartedAt`, dan daftar pembatalan
// ditulis dari beberapa tempat di server. Dua akibatnya nyata:
//   - dua request `/send` bisa jalan bersamaan di thread yang sama
//   - kalau server mati di tengah run, thread tertinggal "running" selamanya
//
// Modul ini menyimpan state run di thread (`runState`, mengikuti RUN_MACHINE)
// dan registry proses hidup di memori. `running` tetap ditulis agar klien/data
// lama tetap kompatibel, tetapi selalu diturunkan dari `runState`.
import * as threads from './threads.js';
import { RUN_MACHINE, canTransition, transitionError } from './machines.js';

// threadId -> { startedAt, stops: Set<() => void> }
const active = new Map();
let recoveredCount = 0;

export class RunBusyError extends Error {
  constructor(threadId, from) {
    super(`Thread ini masih menjalankan run (${from}). Tunggu selesai atau hentikan dulu.`);
    this.name = 'RunBusyError';
    this.code = 'RUN_IN_PROGRESS';
    this.statusCode = 409;
    this.threadId = threadId;
    this.allowed = RUN_MACHINE.transitions[from] || [];
  }
}

export function isActive(threadId) {
  return active.has(threadId);
}

export function activeRuns() {
  return [...active.entries()].map(([id, rec]) => ({ id, startedAt: rec.startedAt }));
}

export function recoveredRuns() {
  return recoveredCount;
}

// Daftarkan pembatal proses untuk run aktif. Mengembalikan fungsi unregister.
export function registerStop(threadId, stop) {
  const rec = active.get(threadId);
  if (!rec) return () => {};
  rec.stops.add(stop);
  return () => { rec.stops.delete(stop); };
}

// Abort semua proses milik thread. Tidak mengubah state; pemanggil memanggil
// finish() agar transisi tetap tercatat di satu tempat.
export function stop(threadId) {
  const rec = active.get(threadId);
  if (!rec) return 0;
  const stops = [...rec.stops];
  for (const fn of stops) { try { fn(); } catch { /* proses sudah mati */ } }
  rec.stops.clear();
  return stops.length;
}

// Mulai run. Melempar 409 bila thread sudah punya run aktif atau transisi
// RUN_MACHINE tidak sah. Semua tulisan state awal terjadi di sini.
export function begin(threadId) {
  const thread = threads.getThread(threadId);
  if (!thread) {
    const error = new Error('Thread tidak ditemukan');
    error.statusCode = 404;
    throw error;
  }
  const from = thread.runState || (thread.running ? 'running' : 'idle');
  if (active.has(threadId)) throw new RunBusyError(threadId, from);
  if (!canTransition(RUN_MACHINE, from, 'running')) throw transitionError(RUN_MACHINE, from, 'running');

  const now = Date.now();
  active.set(threadId, { startedAt: now, stops: new Set() });
  threads.patchThread(threadId, {
    running: true,
    runState: 'running',
    runStartedAt: now,
    runEndedAt: null,
    runError: null,
  });
  return { threadId, startedAt: now };
}

// Selesaikan run: done | error | stopped. Idempoten dan aman bila thread
// dihapus saat run berjalan. State akhir yang tidak sah jatuh ke `error`.
export function finish(threadId, state, { error } = {}) {
  const rec = active.get(threadId);
  active.delete(threadId);
  const thread = threads.getThread(threadId);
  if (!thread) return null;

  const from = thread.runState || (thread.running ? 'running' : 'idle');
  const to = canTransition(RUN_MACHINE, from, state) ? state : 'error';
  if (to !== state) {
    console.warn(`[run] ${threadId}: ${from} → ${state} tidak sah, dicatat sebagai error`);
  }
  return threads.patchThread(threadId, {
    running: false,
    runState: to,
    runStartedAt: null,
    runEndedAt: Date.now(),
    runError: error ? String(error).slice(0, 300) : null,
  });
}

// Dipanggil sekali saat server mulai. Run yang tercatat `running` tetapi tidak
// punya proses (server restart / crash) ditandai error supaya UI tidak
// menampilkan "Working" palsu dan tombol kirim tidak terkunci.
export function recoverInterrupted(now = Date.now()) {
  const interrupted = threads.listThreads().filter((t) => (t.runState === 'running' || t.running) && !active.has(t.id));
  for (const t of interrupted) {
    threads.patchThread(t.id, {
      running: false,
      runState: 'error',
      runStartedAt: null,
      runEndedAt: now,
      runError: 'Terputus karena server berhenti saat run berjalan',
    });
  }
  recoveredCount = interrupted.length;
  if (recoveredCount) console.log(`[run] ${recoveredCount} run terputus dipulihkan sebagai error`);
  return recoveredCount;
}
