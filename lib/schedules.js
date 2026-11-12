// lib/schedules.js — jadwal prompt berulang (scheduled runs) ala fitur
// "jadwalkan agent" pada aplikasi agent populer. Satu jadwal = satu prompt +
// engine + mode (interval menit atau harian jam tertentu); hasilnya menumpuk
// di satu thread sehingga riwayat eksekusi bisa dibaca ulang.
//
// Modul ini murni data + matematika waktu; eksekusi run dilakukan server.js
// (yang punya akses ke harness & runs) lewat dueSchedules()/markRan().
import { readJson, writeJson, newId } from './store.js';

const FILE = 'schedules.json';
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 7 * 24 * 60; // seminggu

function all() {
  const data = readJson(FILE, []);
  return Array.isArray(data) ? data : [];
}

function save(list) {
  writeJson(FILE, list.slice(0, 100));
}

function invalid(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

// Interval dijepit ke [1 menit, 1 minggu]; nilai kosong/tak valid → default 60.
function clampInterval(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, n));
}

function normalize(input = {}) {
  const name = String(input.name || '').trim().slice(0, 80) || 'Jadwal tanpa nama';
  const prompt = String(input.prompt || '').trim().slice(0, 16000);
  if (!prompt) throw invalid('isi prompt jadwal wajib');
  const engine = String(input.engine || '').trim().slice(0, 40);
  if (!engine) throw invalid('engine jadwal wajib');
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : null;
  const mode = input.mode === 'daily' ? 'daily' : 'interval';

  let intervalMinutes = null;
  let dailyAt = null;
  if (mode === 'daily') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(input.dailyAt || '').trim());
    if (!m) throw invalid('jam harian harus format HH:MM (00:00–23:59)');
    dailyAt = `${m[1].padStart(2, '0')}:${m[2]}`;
  } else {
    intervalMinutes = clampInterval(input.intervalMinutes);
  }
  return { name, prompt, engine, cwd, mode, intervalMinutes, dailyAt, enabled: input.enabled !== false };
}

// Waktu eksekusi berikutnya untuk satu jadwal (mode harian memperhatikan jam
// lokal; kalau jam tersebut sudah lewat hari ini, besok jam yang sama).
export function nextRunAt(s, now = Date.now()) {
  if (s.mode === 'daily') {
    const [hh, mm] = String(s.dailyAt || '09:00').split(':').map(Number);
    const d = new Date(now);
    d.setHours(hh || 0, mm || 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return now + clampInterval(s.intervalMinutes) * 60000;
}

export function listSchedules() {
  return all().sort((a, b) => (b.enabled === true) - (a.enabled === true) || (a.nextRunAt || 0) - (b.nextRunAt || 0));
}

export function createSchedule(input, now = Date.now()) {
  const s = normalize(input);
  s.id = newId();
  s.threadId = null;
  s.createdAt = now;
  s.nextRunAt = nextRunAt(s, now);
  s.lastRunAt = null;
  s.lastStatus = null;
  s.lastError = null;
  const list = all();
  list.unshift(s);
  save(list);
  return s;
}

export function patchSchedule(id, patch = {}, now = Date.now()) {
  const list = all();
  const s = list.find((x) => x.id === id);
  if (!s) throw invalid('Jadwal tidak ditemukan');
  const merged = normalize({
    name: patch.name !== undefined ? patch.name : s.name,
    prompt: patch.prompt !== undefined ? patch.prompt : s.prompt,
    engine: patch.engine !== undefined ? patch.engine : s.engine,
    cwd: patch.cwd !== undefined ? patch.cwd : s.cwd,
    mode: patch.mode !== undefined ? patch.mode : s.mode,
    intervalMinutes: patch.intervalMinutes !== undefined ? patch.intervalMinutes : s.intervalMinutes,
    dailyAt: patch.dailyAt !== undefined ? patch.dailyAt : s.dailyAt,
    enabled: patch.enabled !== undefined ? patch.enabled : s.enabled,
  });
  Object.assign(s, merged);
  // Perubahan jadwal (atau diaktifkan lagi) → jadwal ulang dari sekarang.
  if (s.enabled) s.nextRunAt = nextRunAt(s, now);
  else s.nextRunAt = null;
  save(list);
  return s;
}

// Hubungkan thread hasil eksekusi tanpa lewat patch user (threadId bukan
// milik user untuk diubah).
export function attachThread(id, threadId) {
  const list = all();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.threadId = threadId;
  save(list);
}

export function deleteSchedule(id) {
  save(all().filter((s) => s.id !== id));
  return listSchedules().length;
}

export function getSchedule(id) {
  return all().find((s) => s.id === id) || null;
}

// Jadwal yang jatuh tempo sekarang — dipanggil timer server berkala.
export function dueSchedules(now = Date.now()) {
  return all().filter((s) => s.enabled && typeof s.nextRunAt === 'number' && s.nextRunAt <= now);
}

export function markRan(id, now = Date.now()) {
  const list = all();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.lastRunAt = now;
  s.lastStatus = 'ok';
  s.lastError = null;
  s.nextRunAt = nextRunAt(s, now);
  save(list);
}

export function markFailed(id, message, now = Date.now()) {
  const list = all();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.lastRunAt = now;
  s.lastStatus = 'error';
  s.lastError = String(message || '').slice(0, 300);
  s.nextRunAt = nextRunAt(s, now);
  save(list);
}
