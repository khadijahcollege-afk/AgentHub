// lib/freerot.js — Free Auto: tangga rotasi model gratis CLI (opencode-free-*).
// Saat engine kena limit/429/error, ia ditandai cooldown dan permintaan pindah
// otomatis ke engine gratis berikutnya — tanpa ganti manual satu per satu.
import { readJson, writeJson } from './store.js';

const FILE = 'freerot.json';
const COOLDOWN_MS = 10 * 60 * 1000;
// Model yang tidak mengeluarkan output sama sekali dalam batas waktu TIDAK
// sama dengan model yang kena limit. Bisa jadi ia hanya lambat/dingin. Jeda
// yang panjang untuk kasus ini membuat Free Auto membuang model sehat
// (terukur: token pertama model gratis 11-39 detik, sementara ambang lamanya
// 30 detik — jadi model yang benar-benar menjawab pun dikarantina).
const SLOW_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_FAILS_BEFORE_COOL = 1;

// Pola jawaban yang berarti "kuota/limit habis" — meski exit code 0,
// model semacam ini tetap dianggap gagal dan diputar ke yang berikutnya.
const LIMIT_RE = /(rate\s*limit|\b429\b|quota|usage\s*limit|limit\s*(reached|exceeded)|exceeded|insufficient|credit|balance|out\s*of\s*(credits?|tokens?)|terlalu banyak|kuota|melewati batas)/i;

// stateOverride: mode uji — ladder/pool dibaca dari memori, tanpa disk.
let stateOverride = null;
export function _setState(m) { stateOverride = m && typeof m === 'object' ? { ...m } : null; }
// Untuk tes: baca state aktif tanpa menyentuh disk bila override sedang dipakai.
export function _state() { return all(); }
function all() {
  if (stateOverride) return { ...stateOverride };
  const d = readJson(FILE, {});
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}
function save(state) { if (!stateOverride) writeJson(FILE, state); }

export function markOk(id) {
  const st = all();
  const prev = st[id] || {};
  // firstMs HARUS dipertahankan. Sebelumnya markOk menulis objek baru tanpa
  // field itu, sehingga catatan kecepatan model yang justru BERHASIL menjawab
  // langsung terhapus — dan model lambat yang sukses tetap dipotong di tenggat
  // bawaan pada percobaan berikutnya.
  st[id] = {
    ...(prev.firstMs ? { firstMs: prev.firstMs } : {}),
    ok: true,
    fails: 0,
    slow: 0,
    cooldownUntil: 0,
    lastError: null,
    lastOkAt: Date.now(),
  };
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
    // Riwayat kecepatan tetap disimpan: model yang lambat sekali tetap boleh
    // dipakai lebih awal dengan tenggat yang lebih longgar.
    ...(prev.firstMs ? { firstMs: prev.firstMs } : {}),
  };
  if (stateOverride) stateOverride[id] = st[id];
  save(st);
}

// Model yang belum mengeluarkan apa pun sampai tenggat: bukan berarti rusak.
// Ia dijeda SINGKAT (bukan 10 menit) supaya permintaan sekarang pindah ke
// model lain, tetapi model itu tetap ikut rotasi beberapa menit kemudian.
export function markSlow(id, ms) {
  const st = all();
  const prev = st[id] || { fails: 0 };
  st[id] = {
    ok: false,
    fails: prev.fails || 0,
    slow: (prev.slow || 0) + 1,
    cooldownUntil: Date.now() + SLOW_COOLDOWN_MS,
    lastError: `lambat: tanpa output ${Math.round((ms || 0) / 1000)} detik`,
    lastFailAt: Date.now(),
    ...(prev.firstMs ? { firstMs: prev.firstMs } : {}),
  };
  if (stateOverride) stateOverride[id] = st[id];
  save(st);
}

// Catat kecepatan token pertama yang benar-benar teramati. Dipakai untuk
// menyesuaikan tenggat per model: model yang terbukti butuh 39 detik tidak
// boleh dipotong di 30 detik pada percobaan berikutnya.
export function noteFirst(id, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const st = all();
  const prev = st[id] || {};
  // rata-rata bergerak, dibulatkan: cukup untuk menaikkan tenggat, tidak
  // perlu presisi, dan tidak boleh membuat tenggat melonjak karena satu
  // percobaan yang kebetulan sangat lambat.
  const prevMs = Number(prev.firstMs) || 0;
  const next = prevMs ? Math.round(prevMs * 0.6 + ms * 0.4) : Math.round(ms);
  st[id] = { ...prev, firstMs: next };
  if (stateOverride) stateOverride[id] = st[id];
  save(st);
}

// Tenggat "tidak ada output" untuk satu model: bawaan, atau lebih longgar bila
// model itu pernah terbukti butuh waktu lebih lama (2x kecepatan teramati).
export function firstTimeoutFor(id, baseMs) {
  const st = all()[id] || {};
  const seen = Number(st.firstMs) || 0;
  return Math.max(baseMs || 0, seen ? Math.round(seen * 2) : 0);
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
