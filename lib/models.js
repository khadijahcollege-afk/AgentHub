// lib/models.js — katalog model gateway: pilih model, dan bila API key untuk
// provider itu sudah tersimpan & bisa dipakai, model langsung aktif di pool
// tanpa membuka situs provider. Key utuh tidak pernah keluar dari server.
import { readJson } from './store.js';
import { PRESETS, DEFAULT_MODELS, setPool } from './keys.js';
import { keyPoolCandidate } from './machines.js';

function keysFile() {
  return readJson('keys.json', []);
}

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

// Key yang boleh dipakai mengaktifkan model: aturan sama dengan kandidat pool
// (valid / unknown / error / checking). Hanya `invalid` yang ditolak — provider
// yang sempat error boleh dicoba lagi.
function usableKeyFor(preset, keyId) {
  const all = keysFile();
  if (keyId) {
    const k = all.find((x) => x.id === keyId);
    if (!k) fail(404, 'API key tidak ditemukan');
    if (k.status === 'invalid') fail(409, 'API key untuk provider ini ditolak provider — perbarui key dulu');
    return k;
  }
  const found = all
    .filter((k) => k.preset === preset && k.baseUrl && k.key && keyPoolCandidate(k.status))
    .sort((a, b) => (a.status === 'valid' ? -1 : 0) - (b.status === 'valid' ? -1 : 0) || (a.createdAt || 0) - (b.createdAt || 0));
  return found[0] || null;
}

// "openrouter/deepseek/deepseek-v4.1:free" → "deepseek/deepseek-v4.1:free"
// (prefiks preset hanya label routing gateway; upstream perlu ID aslinya).
export function rawModelId(preset, model) {
  const m = String(model || '').match(/^([a-z0-9_-]+)\/(.+)$/i);
  if (m && preset && m[1].toLowerCase() === String(preset).toLowerCase()) return m[2];
  return String(model || '');
}

function firstUsable(preset) {
  return keysFile()
    .find((k) => k.preset === preset && k.baseUrl && k.key && k.status !== 'invalid') || null;
}

// Katalog gabungan untuk pemilih model di UI.
//   auto            — default per provider (tersedia bila pool punya kandidat)
//   anggota pool    — preset/poolModel dari tiap key yang aktif
//   katalog gratis  — model cached dari snapshot promo (tanpa jaringan)
export function listModelChoices() {
  const keys = keysFile();
  const poolEmpty = !keys.some((k) => k.pool && k.baseUrl && k.key && keyPoolCandidate(k.status));

  const rows = [{
    id: 'auto',
    label: 'Auto — default per provider',
    preset: '',
    model: 'auto',
    keyId: null,
    available: !poolEmpty,
    reason: poolEmpty ? 'Pool kosong — aktifkan key dulu' : 'Gateway memilih model default provider',
  }];

  for (const k of keys) {
    if (!k.pool || !k.baseUrl || !k.key) continue;
    const model = k.poolModel || DEFAULT_MODELS[k.preset] || '';
    if (!model) continue;
    rows.push({
      id: `${k.preset}/${model}`,
      label: `${PRESETS[k.preset]?.label || k.preset} · ${model}`,
      preset: k.preset,
      model: `${k.preset}/${model}`,
      keyId: k.id,
      available: keyPoolCandidate(k.status),
      reason: k.status === 'invalid' ? 'Key ditolak' : 'Anggota pool',
    });
  }

  const snap = readJson('snapshot.json', null);
  const catalog = [
    ...(snap?.sources?.openrouter?.models || []).map((mm) => ({ ...mm, preset: 'openrouter' })),
    ...(snap?.sources?.cross?.models || []).map((mm) => ({ ...mm, preset: PRESETS[mm.preset] ? mm.preset : guessPreset(mm.provider) })),
  ];
  const seen = new Set(rows.map((r) => r.id));
  for (const mm of catalog) {
    const raw = rawModelId(mm.preset, mm.id);
    const id = `${mm.preset}/${raw}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const usable = firstUsable(mm.preset);
    rows.push({
      id,
      label: mm.name || raw,
      preset: mm.preset,
      model: id,
      keyId: usable?.id || null,
      available: !!usable,
      reason: usable ? 'Key tersimpan — aktif tanpa buka web' : 'Perlu API key (klik untuk tempel)',
    });
  }
  return rows;
}

function guessPreset(provider) {
  const map = {
    groq: 'groq', openrouter: 'openrouter', google: 'gemini', 'google ai studio': 'gemini',
    github: 'github', mistral: 'mistral', together: 'together', deepseek: 'deepseek',
    'x-ai': 'xai', xai: 'xai', zhipu: 'glm', huggingface: 'hf',
  };
  return map[String(provider || '').toLowerCase()] || 'custom';
}

// Aktifkan model dengan key yang SUDAH tersimpan — tanpa key baru, tanpa web.
// { preset, model, keyId? } → entry pool terbaru (masked).
export function activateModel({ preset, model, keyId } = {}) {
  const raw = rawModelId(preset, model);
  if (!raw || raw === 'auto') fail(400, 'Model wajib diisi (bukan auto)');
  const presetName = PRESETS[preset] ? preset : 'custom';
  const key = usableKeyFor(presetName, keyId);
  if (!key) {
    fail(409, `Belum ada API key ${PRESETS[presetName]?.label || presetName} yang bisa dipakai — tempel key dulu`);
  }
  const entry = setPool(key.id, { pool: true, poolModel: raw.slice(0, 120) });
  return { ...entry, key: undefined, keyMask: entry.key ? entry.key.slice(0, 6) + '…' + entry.key.slice(-4) : '' };
}

// Nilai yang berisi mask (mis. "sk-…abcd") bukan key sungguhan. Server menolak
// supaya form yang tidak sengaja berisi mask tidak menyimpan "key" palsu.
export function isMaskedKey(value) {
  return typeof value === 'string' && value.includes('…');
}
