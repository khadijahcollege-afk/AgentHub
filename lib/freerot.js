// lib/freerot.js — Free Auto: tangga rotasi model gratis CLI (opencode-free-*).
// Saat engine kena limit/429/error, ia ditandai cooldown dan permintaan pindah
// otomatis ke engine gratis berikutnya — tanpa ganti manual satu per satu.
import { readJson, writeJson } from './store.js';

const FILE = 'freerot.json';
const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_FAILS_BEFORE_COOL = 1;

// Pola jawaban yang berarti "kuota/limit habis" — meski exit code 0,
// model semacam ini tetap dianggap gagal dan diputar ke yang berikutnya.
const LIMIT_RE = /(rate\s*limit|\b429\b|quota|usage\s*limit|limit\s*(reached|exceeded)|exceeded|insufficient|credit|balance|out\s*of\s*(credits?|tokens?)|terlalu banyak|kuota|melewati batas)/i;

// stateOverride: mode uji — ladder/pool dibaca dari memori, tanpa disk.
let stateOverride = null;
export function _setState(m) { stateOverride = m && typeof m === 'object' ? { ...m } : null; }
function all() {
  if (stateOverride) return { ...stateOverride };
  const d = readJson(FILE, {});
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}
function save(state) { if (!stateOverride) writeJson(FILE, state); }

export function markOk(id) {
  const st = all();
  st[id] = { ok: true, fails: 0, cooldownUntil: 0, lastError: null, lastOkAt: Date.now() };
  if (stateOverride) stateOverride[id] = st[id];
  save(st);
}

export function markFail(id, error) {
  const st = all();
  const prev = st[id] || { fails: 0 };
  const fails = (prev.fails || 0) + 1;
  st[id] = {
    ok: false,
    fails,
    cooldownUntil: Date.now() + COOLDOWN_MS,
    lastError: String(error || '').slice(0, 300),
    lastFailAt: Date.now(),
  };
  if (stateOverride) stateOverride[id] = st[id];
  save(st);
}

export function cooling(id) {
  const st = all()[id];
  return !!st && (st.cooldownUntil || 0) > Date.now();
}

// Pilih kandidat dari daftar engine: hanya opencode-free-* (bukan induk
// 'opencode-free'), yang tersedia, dan tidak sedang cooldown. Urutan: paling
// sedikit gagal dulu.
export function ladder(engines) {
  const st = all();
  const free = (engines || []).filter(
    (e) => /^opencode-free-/.test(e.id) && e.id !== 'opencode-free' && e.available !== false,
  );
  const ok = [];
  const cooling = [];
  for (const e of free) {
    const state = st[e.id];
    if (state && (state.cooldownUntil || 0) > Date.now()) {
      cooling.push({ ...e, cooldownUntil: state.cooldownUntil, fails: state.fails || 0 });
    } else {
      ok.push({ ...e, fails: state?.fails || 0 });
    }
  }
  ok.sort((a, b) => (a.fails || 0) - (b.fails || 0));
  return { ok, cooling };
}

// Deteksi jawaban "kena limit" walau proses sukses (exit 0).
export function looksLimited(text) {
  return LIMIT_RE.test(String(text || '').slice(-4000));
}
