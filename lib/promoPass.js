// lib/promoPass.js — "AgentHub Global Build": kartu promo, tiket klaim, dan
// Start Plan dengan saldo harian.
//
// Kenapa modul terpisah: promo pass punya siklus hidup sendiri (tersedia →
// menunggu jadwal → aktif → kedaluwarsa), saldo per model, dan preferensi
// tampilan (dismiss / toggle model). Menaruhnya di lib/promo.js akan mencampur
// sumber data eksternal (OpenRouter/models.dev) dengan state lokal pengguna.
//
// Semua fungsi murni menerima `now` agar bisa diuji tanpa mengubah jam mesin.
import { readJson, writeJson } from './store.js';

const FILE = 'promo-pass.json';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Katalog model promo. `baseQuota` = saldo harian sebelum upgrade.
export const PASS_PLAN = {
  id: 'global-build',
  brand: 'AgentHub',
  series: 'GLOBAL BUILD',
  planName: 'AgentHub Start Plan',
  headlineTokens: 300_000_000,
  resetLabel: '22:59',
  models: [
    { id: 'glm-5.3', label: 'GLM-5.3', context: '1M', baseQuota: 3_000_000, vision: false },
    { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', context: '1M', baseQuota: 5_000_000, vision: true },
  ],
  addable: [
    { id: 'glm-5.2', label: 'GLM-5.2', context: '512K', baseQuota: 1_000_000, vision: false },
    { id: 'glm-4.6', label: 'GLM-4.6', context: '200K', baseQuota: 1_000_000, vision: false },
    { id: 'glm-4.5v', label: 'GLM-4.5V', context: '64K', baseQuota: 1_000_000, vision: true },
  ],
  // Daftar benefit plan (dipakai UI Start Plan). Angka dinamis — persentase
  // kuota dan tugas idle — dihitung ulang di publicPass(), bukan di sini.
  benefits: {
    core: [
      'Dibuat untuk pengguna mahir yang bekerja di repo menengah–besar',
      'Akses paling awal ke model flagship dan fitur terbaru',
      'Resource khusus selama jam sibuk',
    ],
    exclusiveLabel: 'Benefit eksklusif ZCode',
    idleTasksPerDay: 5,
    // Checklist "semua yang termasuk" — fitur nyata yang aktif bersama plan.
    included: [
      'Engine agent: Claude Code, Codex, OpenCode, Gemini CLI',
      'Gateway pool multi-provider dengan cooldown 429 otomatis',
      'Delegation — satu prompt dijalankan paralel ke banyak agent',
      'Studio chat dengan lampiran gambar & file',
      'Papan tugas, catatan, dan proyek dengan konteks git',
      'Akses HP: QR, WiFi yang sama, dan tunnel data seluler',
      'PWA Android — terpasang sebagai aplikasi layar penuh',
      'Pustaka prompt, dikte suara, dan palet perintah Ctrl+K',
      'Review perubahan kode (diff) & revert per file',
      'Tanpa pelatihan model dari konten Anda — semua lokal',
    ],
  },
};

const MODEL_BY_ID = new Map(
  [...PASS_PLAN.models, ...PASS_PLAN.addable].map((m) => [m.id, m]),
);

export function isPassModel(id) {
  return MODEL_BY_ID.has(String(id || ''));
}

export function isAddableModel(id) {
  return PASS_PLAN.addable.some((m) => m.id === id);
}

// ---------- jadwal kampanye ----------
// Drop harian pukul 22:00. Bila pengguna mengklaim setelah jam itu, promo
// langsung aktif (tidak menunggu besok). Tiket berlaku 10 jam; plan 3 hari
// sampai 22:59 — angka yang sama dengan kartu promo asli.
export function campaignWindow(now = Date.now()) {
  const start = new Date(now);
  start.setHours(22, 0, 0, 0);
  if (start.getTime() < now) start.setTime(now);

  const ticketValidUntil = start.getTime() + 10 * HOUR;
  const planExpiresAt = new Date(start);
  planExpiresAt.setDate(planExpiresAt.getDate() + 3);
  planExpiresAt.setHours(22, 59, 0, 0);

  return {
    startsAt: start.getTime(),
    ticketValidUntil,
    planExpiresAt: planExpiresAt.getTime(),
  };
}

// Hari penagihan berganti pukul 22:59, bukan tengah malam. Tanpa ini saldo
// tampak "reset" di jam yang salah dan persentase pemakaian melompat.
export function billingDay(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() > 22 || (d.getHours() === 22 && d.getMinutes() >= 59)) {
    d.setDate(d.getDate() + 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nextResetAt(now = Date.now()) {
  const d = new Date(now);
  d.setHours(22, 59, 0, 0);
  if (d.getTime() <= now) d.setTime(d.getTime() + DAY);
  return d.getTime();
}

// ---------- state ----------
const DEFAULTS = {
  v: 1,
  claimed: false,
  dismissed: false,
  claimedAt: 0,
  sharedAt: 0,
  boosts: 0,
  window: null,
  toggles: {},
  extraModels: [],
  aliases: {},
  usage: { day: '', tokens: {} },
};

const MAX_BOOSTS = 4;

function normalize(raw) {
  const pass = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  pass.boosts = Math.min(MAX_BOOSTS, Math.max(0, Number(pass.boosts) || 0));
  pass.toggles = pass.toggles && typeof pass.toggles === 'object' ? pass.toggles : {};
  pass.extraModels = Array.isArray(pass.extraModels)
    ? [...new Set(pass.extraModels.filter((id) => isAddableModel(id)))]
    : [];
  pass.aliases = pass.aliases && typeof pass.aliases === 'object' ? pass.aliases : {};
  for (const id of Object.keys(pass.aliases)) {
    const label = String(pass.aliases[id] || '').trim().slice(0, 40);
    if (!isPassModel(id) || !label) delete pass.aliases[id];
    else pass.aliases[id] = label;
  }
  pass.usage = {
    day: typeof pass.usage?.day === 'string' ? pass.usage.day : '',
    tokens: pass.usage?.tokens && typeof pass.usage.tokens === 'object' ? pass.usage.tokens : {},
  };
  // Jangan percaya angka dari file: hanya model dikenal yang dihitung.
  for (const id of Object.keys(pass.usage.tokens)) {
    const n = Number(pass.usage.tokens[id]);
    if (!isPassModel(id) || !Number.isFinite(n) || n < 0) delete pass.usage.tokens[id];
    else pass.usage.tokens[id] = Math.round(n);
  }
  if (pass.window && !Number.isFinite(Number(pass.window.startsAt))) pass.window = null;
  return pass;
}

export function loadPass() {
  return normalize(readJson(FILE, null));
}

export function savePass(pass) {
  writeJson(FILE, pass);
  return pass;
}

export function passPhase(pass, now = Date.now()) {
  if (!pass?.claimed) return 'available';
  const w = pass.window || campaignWindow(pass.claimedAt || now);
  if (now < w.startsAt) return 'pending';
  if (now < w.planExpiresAt) return 'active';
  return 'expired';
}

export function quotaBoostPct(pass) {
  return 100 + 50 * (Number(pass?.boosts) || 0);
}

// Saldo efektif satu model. Upgrade menambah 50% per tingkat.
export function quotaFor(pass, model) {
  const base = Number(model?.baseQuota) || 0;
  return Math.round(base * (quotaBoostPct(pass) / 100));
}

function activeModels(pass) {
  const extras = (pass.extraModels || [])
    .map((id) => MODEL_BY_ID.get(id))
    .filter(Boolean);
  return [...PASS_PLAN.models, ...extras];
}

function usageToday(pass, now) {
  const day = billingDay(now);
  if (pass.usage.day !== day) {
    pass.usage = { day, tokens: {} };
  }
  return pass.usage;
}

export function publicPass(pass, now = Date.now()) {
  const w = pass.claimed && pass.window ? pass.window : campaignWindow(now);
  const phase = passPhase(pass, now);
  const usage = pass.usage?.day === billingDay(now) ? (pass.usage.tokens || {}) : {};
  const models = activeModels(pass);
  // Model yang sudah ditambahkan tidak muncul lagi sebagai pilihan.
  const addable = PASS_PLAN.addable.filter((m) => !(pass.extraModels || []).includes(m.id));

  return {
    id: PASS_PLAN.id,
    brand: PASS_PLAN.brand,
    series: PASS_PLAN.series,
    planName: PASS_PLAN.planName,
    headlineTokens: PASS_PLAN.headlineTokens,
    resetLabel: PASS_PLAN.resetLabel,
    resetAt: nextResetAt(now),
    claimed: !!pass.claimed,
    dismissed: !!pass.dismissed,
    claimedAt: pass.claimedAt || 0,
    sharedAt: pass.sharedAt || 0,
    phase,
    startsAt: w.startsAt,
    ticketValidUntil: w.ticketValidUntil,
    planExpiresAt: w.planExpiresAt,
    boosts: pass.boosts || 0,
    quotaLabel: `${quotaBoostPct(pass)}% Quota`,
    benefits: {
      core: PASS_PLAN.benefits.core,
      included: PASS_PLAN.benefits.included,
      exclusive: {
        label: PASS_PLAN.benefits.exclusiveLabel,
        items: [
          { text: `Tugas idle-time: ${PASS_PLAN.benefits.idleTasksPerDay}/hari`, mark: 'token gratis' },
          { text: 'Reset kuota 5 jam selama jam idle' },
          { text: 'Benefit MCP ZCode' },
          {
            text: `${quotaBoostPct(pass)}% kuota`,
            mark: quotaBoostPct(pass) > 100 ? 'diskon pengali penggunaan terbatas' : 'upgrade untuk menaikkan',
          },
        ],
      },
    },
    models: models.map((m) => {
      const quota = quotaFor(pass, m);
      const used = usage[m.id] || 0;
      return {
        ...m,
        label: (pass.aliases || {})[m.id] || m.label,
        baseLabel: m.label,
        quota,
        used,
        pct: quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0,
        enabled: pass.toggles?.[m.id] !== false,
      };
    }),
    addable,
    usageDay: billingDay(now),
  };
}

// ---------- aksi ----------
// Semua aksi mengembalikan state yang sudah dinormalisasi. Validasi ketat di
// sini supaya route tidak perlu menduplikasi aturan.
export function claimPass(pass, now = Date.now()) {
  if (pass.claimed) return pass;
  pass.claimed = true;
  pass.claimedAt = now;
  pass.window = campaignWindow(now);
  pass.dismissed = false;
  for (const m of PASS_PLAN.models) {
    if (pass.toggles[m.id] === undefined) pass.toggles[m.id] = true;
  }
  pass.usage = { day: billingDay(now), tokens: {} };
  return savePass(pass);
}

export function dismissPass(pass, dismissed = true) {
  pass.dismissed = dismissed !== false;
  return savePass(pass);
}

export function togglePassModel(pass, modelId, enabled) {
  const id = String(modelId || '');
  if (!isPassModel(id)) {
    const e = new Error(`Model promo tidak dikenal: ${id || '(kosong)'}`);
    e.statusCode = 400;
    e.code = 'MODEL_UNKNOWN';
    throw e;
  }
  if (!activeModels(pass).some((m) => m.id === id)) {
    const e = new Error('Tambahkan model ke plan sebelum mengubah toggle');
    e.statusCode = 409;
    e.code = 'MODEL_NOT_IN_PLAN';
    throw e;
  }
  pass.toggles[id] = enabled !== false;
  return savePass(pass);
}

export function addPassModel(pass, modelId) {
  const id = String(modelId || '');
  if (!isAddableModel(id)) {
    const e = new Error(`Model tidak bisa ditambahkan: ${id || '(kosong)'}`);
    e.statusCode = 400;
    e.code = 'MODEL_NOT_ADDABLE';
    throw e;
  }
  if (!pass.extraModels.includes(id)) pass.extraModels.push(id);
  if (pass.toggles[id] === undefined) pass.toggles[id] = true;
  return savePass(pass);
}

// Nama tampilan model bisa diubah (mis. "GLM-5.3 (kerja)") tanpa mengubah id
// yang dipakai gateway. Label kosong = kembali ke nama bawaan.
export function renamePassModel(pass, modelId, label) {
  const id = String(modelId || '');
  if (!isPassModel(id)) {
    const e = new Error(`Model promo tidak dikenal: ${id || '(kosong)'}`);
    e.statusCode = 400;
    e.code = 'MODEL_UNKNOWN';
    throw e;
  }
  const base = MODEL_BY_ID.get(id);
  const next = String(label || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!next || next === base.label) delete pass.aliases[id];
  else pass.aliases[id] = next;
  return savePass(pass);
}

export function upgradePass(pass) {  if ((pass.boosts || 0) >= MAX_BOOSTS) {
    const e = new Error('Kuota promo sudah berada di tingkat tertinggi');
    e.statusCode = 409;
    e.code = 'QUOTA_MAX';
    throw e;
  }
  pass.boosts = (pass.boosts || 0) + 1;
  return savePass(pass);
}

export function markShared(pass, now = Date.now()) {
  pass.sharedAt = now;
  return savePass(pass);
}

export function shareText(pass) {
  const total = Number(PASS_PLAN.headlineTokens).toLocaleString('en-US');
  return `Saya klaim ${PASS_PLAN.brand} ${PASS_PLAN.series} — ${total} token untuk GLM-5.3-Flash.`;
}

// Pemakaian nyata dari gateway dipetakan ke model promo. Nama model upstream
// bisa "glm-5.3-flash" / "zhipu/GLM-5.3", jadi pencocokan dilakukan longgar.
export function matchPassModel(model) {
  const s = String(model || '').toLowerCase();
  if (!s) return null;
  if (s.includes('glm-5.3-flash') || s.includes('glm-5.3flash') || s.includes('glm-5.3 flash')) {
    return 'glm-5.3-flash';
  }
  if (s.includes('glm-5.3')) return 'glm-5.3';
  return null;
}

export function recordUsage(pass, model, tokens, now = Date.now()) {
  const id = matchPassModel(model);
  const n = Math.round(Number(tokens) || 0);
  if (!id || n <= 0) return false;
  if (passPhase(pass, now) !== 'active') return false;
  const day = usageToday(pass, now);
  day.tokens[id] = (day.tokens[id] || 0) + n;
  savePass(pass);
  return true;
}
