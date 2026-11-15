// Manajemen & validasi API key provider (endpoint kompatibel OpenAI).
import { loadCollection, writeJson, newId } from './store.js';
import { KEY_MACHINE, canTransition } from './machines.js';
import { API_FORMATS, upstreamHeaders, upstreamUrl } from './api-formats.js';
export { API_FORMATS } from './api-formats.js';

// Preset = endpoint API yang masih hidup, bukan daftar promo. Provider berbayar
// tetap ada karena endpoint-nya berfungsi; yang dihapus hanya yang benar-benar
// sudah tidak melayani permintaan (lihat catatan di bawah).
export const PRESETS = {
  groq:       { label: 'Groq',           baseUrl: 'https://api.groq.com/openai/v1',                        signup: 'https://console.groq.com/keys' },
  openrouter: { label: 'OpenRouter',     baseUrl: 'https://openrouter.ai/api/v1',                          signup: 'https://openrouter.ai/keys' },
  // Cerebras: free tier tanpa kartu sudah tidak ada, tapi endpoint tetap
  // melayani akun dengan kredit berbayar — jadi preset dipertahankan.
  cerebras:   { label: 'Cerebras',       baseUrl: 'https://api.cerebras.ai/v1',                            signup: 'https://cloud.cerebras.ai' },
  gemini:     { label: 'Google Gemini',  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', signup: 'https://aistudio.google.com/apikey' },
  // GitHub Models DIHAPUS: layanan pensiun 30 Juli 2026, endpoint
  // models.inference.ai.azure.com tidak lagi melayani permintaan.
  mistral:    { label: 'Mistral AI',     baseUrl: 'https://api.mistral.ai/v1',                             signup: 'https://console.mistral.ai/api-keys' },
  together:   { label: 'Together AI',    baseUrl: 'https://api.together.xyz/v1',                           signup: 'https://api.together.ai/settings/api-keys' },
  deepseek:   { label: 'DeepSeek',       baseUrl: 'https://api.deepseek.com/v1',                           signup: 'https://platform.deepseek.com/api_keys' },
  xai:        { label: 'xAI (Grok)',     baseUrl: 'https://api.x.ai/v1',                                   signup: 'https://console.x.ai' },
  glm:        { label: 'Zhipu GLM',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',                  signup: 'https://open.bigmodel.cn' },
  hf:         { label: 'Hugging Face',   baseUrl: 'https://router.huggingface.co/v1',                      signup: 'https://huggingface.co/settings/tokens' },
  custom:     { label: 'Custom (OpenAI-compatible)', baseUrl: '', signup: '' },
};

// Preset yang sudah tidak bisa dipakai, dipisah supaya key lama tidak hilang
// dari daftar (masih bisa dihapus/diedit) tapi tidak lagi bisa DIPILIH saat
// menambah key baru.
export const RETIRED_PRESETS = {
  github: { label: 'GitHub Models (pensiun)', baseUrl: 'https://models.inference.ai.azure.com', signup: '', retired: 'Layanan pensiun 30 Juli 2026' },
};

export function presetInfo(preset) {
  return PRESETS[preset] || RETIRED_PRESETS[preset] || PRESETS.custom;
}

// model cadangan yang dipakai bila permintaan agent pakai model "auto"
export const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
  cerebras: 'llama-3.3-70b',
  gemini: 'gemini-2.5-flash',
  mistral: 'mistral-small-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  deepseek: 'deepseek-chat',
  xai: 'grok-3-mini',
  glm: 'glm-4.5-flash',
  hf: 'meta-llama/Llama-3.3-70B-Instruct',
  custom: '',
};

function keysFile() {
  return loadCollection('keys.json');
}

export function listKeys() {
  // jangan pernah kirim key utuh ke UI — hanya mask
  return keysFile().map((k) => ({
    ...k,
    key: undefined,
    keyMask: k.key ? k.key.slice(0, 6) + '…' + k.key.slice(-4) : '',
    stats: k.stats || { req: 0, err: 0, lastUsed: 0 },
  }));
}

export function addKey({ preset, name, baseUrl, key, pool, poolModel, priority, format }) {
  // Preset yang layanannya sudah pensiun ditolak saat MENAMBAH key baru —
  // sebelumnya UI menawarkannya dan user berakhir dengan endpoint mati.
  if (preset && RETIRED_PRESETS[preset]) {
    throw Object.assign(
      Error(`${RETIRED_PRESETS[preset].label} tidak bisa dipakai: ${RETIRED_PRESETS[preset].retired}. Pilih provider lain.`),
      { statusCode: 400 },
    );
  }
  const p = PRESETS[preset] || PRESETS.custom;
  const all = keysFile();
  const entry = {
    id: newId(),
    preset: preset || 'custom',
    name: name || p.label,
    baseUrl: (baseUrl || p.baseUrl || '').replace(/\/+$/, ''),
    key: String(key || '').trim(),
    format: API_FORMATS.includes(format) ? format : 'chat_completions',
    signup: p.signup || '',
    status: 'unknown', // valid | invalid | error | unknown
    statusText: '',
    models: 0,
    lastChecked: 0,
    createdAt: Date.now(),
    // --- pool gateway ---
    pool: pool === true || pool === false ? pool : false,
    priority: Number.isFinite(priority) ? Math.min(99, Math.max(1, Math.round(priority))) : all.length + 1,
    poolModel: String(poolModel || '').trim().slice(0, 160),
    cooldownUntil: 0,
    stats: { req: 0, err: 0, lastUsed: 0 },
  };
  all.push(entry);
  writeJson('keys.json', all);
  return entry;
}

// ubah keanggotaan pool: {pool, priority, poolModel}
export function setPool(id, patch) {
  const all = keysFile();
  const entry = all.find((k) => k.id === id);
  if (!entry) throw new Error('API key tidak ditemukan');
  if (typeof patch.pool === 'boolean') entry.pool = patch.pool;
  if (typeof patch.poolModel === 'string') entry.poolModel = patch.poolModel.trim().slice(0, 120);
  if (typeof patch.priority === 'number' && patch.priority >= 1 && patch.priority <= 99) entry.priority = Math.round(patch.priority);
  writeJson('keys.json', all);
  return entry;
}

export function removeKey(id) {
  const all = keysFile().filter((k) => k.id !== id);
  writeJson('keys.json', all);
  return all.length;
}

// Satu probe per key pada satu waktu. Klik ganda, scheduler, dan agent bisa
// memicu pengecekan bersamaan; tanpa ini hasil terakhir menimpa yang lebih baru
// dan provider menerima permintaan ganda.
const inFlight = new Map();

export function checkingKeyIds() {
  return [...inFlight.keys()];
}

export function checkKey(id) {
  if (inFlight.has(id)) return inFlight.get(id);
  const run = (async () => {
    const all = keysFile();
    const entry = all.find((k) => k.id === id);
    if (!entry) throw new Error('API key tidak ditemukan');
    const res = await probeKey(entry.baseUrl, entry.key, 12000, entry.format);
    const next = canTransition(KEY_MACHINE, entry.status || 'unknown', res.status) ? res.status : 'error';
    entry.status = next;
    entry.statusText = next === res.status ? res.statusText : `Status tak terduga: ${res.statusText}`;
    entry.models = res.models || 0;
    entry.latency = res.latency;
    entry.lastChecked = Date.now();
    writeJson('keys.json', all);
    return entry;
  })();
  const tracked = run.finally(() => {
    if (inFlight.get(id) === tracked) inFlight.delete(id);
  });
  inFlight.set(id, tracked);
  return tracked;
}

export async function checkAllKeys() {
  const all = keysFile();
  for (const k of all) {
    try { await checkKey(k.id); } catch { /* lanjut */ }
  }
}

export async function probeKey(baseUrl, key, timeoutMs = 12000, format = 'chat_completions') {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(upstreamUrl(format, baseUrl, '/models'), {
      headers: upstreamHeaders(format, { key }),
      signal: ctrl.signal,
    });
    const latency = Date.now() - t0;
    if (res.ok) {
      let count = 0;
      try {
        const j = await res.json();
        count = (j.data || j.models || []).length;
      } catch { /* abaikan */ }
      return { status: 'valid', statusText: `Key valid · ${count} model`, models: count, latency };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'invalid', statusText: `Key ditolak (HTTP ${res.status})`, latency };
    }
    if (res.status === 429) {
      return { status: 'valid', statusText: 'Key diterima (rate limit / kuota), coba lagi nanti', latency };
    }
    return { status: 'error', statusText: `HTTP ${res.status}`, latency };
  } catch (e) {
    return { status: 'error', statusText: e.name === 'AbortError' ? 'Timeout' : String(e.message || e), latency: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}
