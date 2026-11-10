// Gateway Pool: satu endpoint OpenAI-compatible untuk semua agent.
// Saat kuota provider gratis habis (429) / gagal, permintaan otomatis
// dipindahkan ke provider pool berikutnya — agent tetap hidup.
import { readJson, writeJson } from './store.js';
import { DEFAULT_MODELS } from './keys.js';

const COOLDOWN_429_MS = 5 * 60 * 1000;      // kena 429 → istirahat 5 menit
const UPSTREAM_TIMEOUT_MS = 120 * 1000;      // batas waktu respons LLM

function keysFile() {
  return readJson('keys.json', []);
}

function saveKeys(all) {
  writeJson('keys.json', all);
}

// anggota pool urut prioritas, buang yang invalid / sedang cooldown
function candidates() {
  const now = Date.now();
  return keysFile()
    .filter((k) => k.pool && k.baseUrl && k.key && k.status !== 'invalid')
    .sort((a, b) => (a.priority || 99) - (b.priority || 99) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((k) => ({
      ...k,
      cooling: (k.cooldownUntil || 0) > now,
    }));
}

export function poolStatus() {
  const entries = candidates();
  return {
    members: entries.map((k) => ({
      id: k.id,
      name: k.name,
      preset: k.preset,
      priority: k.priority,
      status: k.status,
      poolModel: k.poolModel || DEFAULT_MODELS[k.preset] || '',
      cooling: k.cooling,
      cooldownUntil: k.cooldownUntil || 0,
      stats: k.stats || { req: 0, err: 0, lastUsed: 0 },
    })),
    active: entries.filter((k) => k.status === 'valid' && !k.cooling).length,
    total: entries.length,
  };
}

// tentukan model upstream untuk satu entry
function resolveModel(requested, entry) {
  const fallback = entry.poolModel || DEFAULT_MODELS[entry.preset] || '';
  let model = String(requested || '').trim();
  if (!model || model === 'auto' || model === 'default') return fallback || model;
  // "groq/llama-3.3-70b" → entry preset groq memakai "llama-3.3-70b"
  const m = model.match(/^([a-z0-9_-]+)\/(.+)$/i);
  if (m && entry.preset && m[1].toLowerCase() === entry.preset.toLowerCase()) {
    model = m[2];
  }
  return model || fallback;
}

function bumpStat(all, id, field) {
  const k = all.find((x) => x.id === id);
  if (!k) return;
  k.stats = k.stats || { req: 0, err: 0, lastUsed: 0 };
  k.stats[field] = (k.stats[field] || 0) + (field === 'lastUsed' ? 0 : 1);
  if (field === 'lastUsed') k.stats.lastUsed = Date.now();
}

function headersFor(entry) {
  const h = { 'content-type': 'application/json', authorization: `Bearer ${entry.key}` };
  if (entry.preset === 'openrouter') {
    h['http-referer'] = 'http://localhost:7788';
    h['x-title'] = 'AgentHub';
  }
  return h;
}

// teruskan ke upstream; kembalikan {res} mentah untuk stream passthrough
async function forward(entry, payload, model) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(entry.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: headersFor(entry),
      body: JSON.stringify({ ...payload, model }),
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function readUpstreamError(res) {
  const text = (await res.text().catch(() => '')).slice(0, 300);
  return text || `HTTP ${res.status}`;
}

// utama: coba tiap anggota sampai ada yang sukses.
// payload: objek chat/completions dari agent (boleh stream:true)
// hasil:
//   { type:'json', status, body }  — respons normal
//   { type:'stream', status, webStream }  — passthrough SSE upstream
//   { type:'error', status, body }  — semua anggota gagal
export async function routeChat(payload) {
  const entries = candidates();
  const all = keysFile();
  const attempts = [];

  for (const entry of entries) {
    if (entry.cooling) {
      attempts.push({ entry: entry.name, note: 'cooldown, dilewati' });
      continue;
    }
    const model = resolveModel(payload.model, entry);
    let res;
    try {
      res = await forward(entry, payload, model);
    } catch (e) {
      bumpStat(all, entry.id, 'err');
      attempts.push({ entry: entry.name, model, note: String(e.cause?.code || e.message || e) });
      continue;
    }

    if (res.ok) {
      bumpStat(all, entry.id, 'req');
      bumpStat(all, entry.id, 'lastUsed');
      saveKeys(all);
      if (payload.stream === true && res.body) {
        return { type: 'stream', status: res.status, webStream: res.body, servedBy: entry.name, model };
      }
      const body = await res.text();
      return { type: 'json', status: res.status, body, servedBy: entry.name, model };
    }

    const detail = await readUpstreamError(res);
    if (res.status === 429) {
      const k = all.find((x) => x.id === entry.id);
      if (k) k.cooldownUntil = Date.now() + COOLDOWN_429_MS;
      bumpStat(all, entry.id, 'err');
      attempts.push({ entry: entry.name, model, note: `kuota/429 → cooldown ${COOLDOWN_429_MS / 60000}m` });
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const k = all.find((x) => x.id === entry.id);
      if (k) { k.status = 'invalid'; k.statusText = `Key ditolak (HTTP ${res.status}) — dicek via gateway`; k.lastChecked = Date.now(); }
      bumpStat(all, entry.id, 'err');
      attempts.push({ entry: entry.name, model, note: `key invalid (${res.status})` });
      continue;
    }
    // 400/404/5xx — catat dan lanjut ke anggota berikutnya
    bumpStat(all, entry.id, 'err');
    attempts.push({ entry: entry.name, model, note: `HTTP ${res.status}: ${detail}` });
  }
  saveKeys(all);
  return { type: 'error', status: 502, attempts };
}

// tes singkat: permintaan minimal lewat rotasi
export async function testPool() {
  const payload = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Balas satu kata: OK' }],
    max_tokens: 8,
  };
  const r = await routeChat(payload);
  if (r.type === 'error') return { ok: false, attempts: r.attempts };
  let preview = '';
  if (r.type === 'json') {
    try {
      const j = JSON.parse(r.body);
      preview = j.choices?.[0]?.message?.content || r.body.slice(0, 120);
    } catch { preview = r.body.slice(0, 120); }
  } else {
    preview = '(respons streaming)';
  }
  return { ok: true, servedBy: r.servedBy, model: r.model, preview };
}

// daftar model gabungan untuk GET /v1/models
export function poolModels() {
  return candidates()
    .filter((k) => k.status === 'valid' || k.status === 'unknown')
    .map((k) => ({
      id: `${k.preset}/${k.poolModel || DEFAULT_MODELS[k.preset] || 'auto'}`,
      object: 'model',
      owned_by: k.name,
    }));
}
