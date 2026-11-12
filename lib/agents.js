// Konektor agent: pantau aplikasi agent lain (webhook n8n/Make/custom,
// atau endpoint OpenAI-compatible milik agent) — health check + tes kirim.
import { loadCollection, writeJson, newId } from './store.js';
import { AGENT_MACHINE, canTransition } from './machines.js';

const HISTORY_MAX = 60;

function agentsFile() {
  return loadCollection('agents.json');
}

export function listAgents() {
  return agentsFile().map((a) => ({ ...a, key: undefined, keyMask: a.key ? a.key.slice(0, 6) + '…' : '' }));
}

export function addAgent({ name, type, url, method, headers, body, key, model, baseUrl }) {
  const entry = {
    id: newId(),
    name: name || 'Agent tanpa nama',
    type: type === 'openai' ? 'openai' : 'webhook',
    url: String(url || '').trim(),
    baseUrl: String(baseUrl || '').trim(),
    method: (method || 'GET').toUpperCase(),
    headers: sanitizeHeaders(headers),
    body: String(body || '').slice(0, 4000),
    key: String(key || '').trim(),
    model: String(model || '').trim(),
    status: 'unknown',
    statusText: '',
    latency: null,
    history: [],
    lastChecked: 0,
    lastResponse: '',
    createdAt: Date.now(),
  };
  const all = agentsFile();
  all.push(entry);
  writeJson('agents.json', all);
  return entry;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers).slice(0, 15)) {
    if (typeof k === 'string' && typeof v === 'string' && k.length < 80 && v.length < 400) {
      out[k] = v;
    }
  }
  return out;
}

export function removeAgent(id) {
  const all = agentsFile().filter((a) => a.id !== id);
  writeJson('agents.json', all);
  return all.length;
}

function pushHistory(entry, ok, ms, text) {
  entry.history = [
    ...(entry.history || []),
    { ts: Date.now(), ok: !!ok, ms, preview: String(text || '').slice(0, 200) },
  ].slice(-HISTORY_MAX);
}

async function httpRequest(url, { method = 'GET', headers = {}, body = '', key = '', timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const h = { ...headers };
  if (key && !Object.keys(h).some((k) => k.toLowerCase() === 'authorization')) {
    h.authorization = `Bearer ${key}`;
  }
  try {
    const res = await fetch(url, {
      method,
      headers: h,
      body: method !== 'GET' && method !== 'HEAD' && body ? body : undefined,
      signal: ctrl.signal,
    });
    const text = (await res.text().catch(() => '')).slice(0, 500);
    return { ok: res.ok, status: res.status, text, latency: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

// Satu probe per agent pada satu waktu (klik ganda / scheduler / trigger).
const inFlight = new Map();

export function checkingAgentIds() {
  return [...inFlight.keys()];
}

// Health check / trigger. `manual=true` -> hasil disimpan lastResponse utk ditampilkan.
export function checkAgent(id, manual = false) {
  if (inFlight.has(id)) return inFlight.get(id);
  const run = (async () => {
  const all = agentsFile();
  const entry = all.find((a) => a.id === id);
  if (!entry) throw new Error('Agent tidak ditemukan');

  let res;
  try {
    if (entry.type === 'openai') {
      const base = (entry.baseUrl || '').replace(/\/+$/, '');
      res = await httpRequest(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        key: entry.key,
        body: JSON.stringify({
          model: entry.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Balas satu kata: OK' }],
          max_tokens: 8,
        }),
      });
    } else {
      res = await httpRequest(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.method !== 'GET' && entry.method !== 'HEAD' ? entry.body : '',
        key: entry.key,
      });
    }
  } catch (e) {
    const ms = 0;
    res = { ok: false, status: 0, text: '', latency: ms, netError: String(e.cause?.code || e.message || e) };
  }

  const next = canTransition(AGENT_MACHINE, entry.status || 'unknown', res.ok ? 'online' : 'error')
    ? (res.ok ? 'online' : 'error')
    : 'error';
  entry.status = next;
  entry.statusText = res.ok
    ? `OK · HTTP ${res.status} · ${res.latency} ms`
    : `Gagal · ${res.netError || (res.status ? 'HTTP ' + res.status : 'tanpa respons')} · ${res.latency} ms`;
  entry.latency = res.latency;
  entry.lastChecked = Date.now();
  if (manual) entry.lastResponse = res.text.slice(0, 400);
  pushHistory(entry, res.ok, res.latency, res.text);
  writeJson('agents.json', all);
  return { entry, res };
  })();
  const tracked = run.finally(() => {
    if (inFlight.get(id) === tracked) inFlight.delete(id);
  });
  inFlight.set(id, tracked);
  return tracked;
}

export async function checkAllAgents() {
  const all = agentsFile();
  for (const a of all) {
    try { await checkAgent(a.id); } catch { /* lanjut */ }
  }
}
