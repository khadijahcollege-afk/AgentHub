// Sumber info promo / API gratis:
//  1) Live: OpenRouter public models API (model berharga 0 = gratis)
//  2) Live: daftar free-tier LLM dari repo GitHub free-llm-api-resources
//  3) Statis: katalog provider free-tier terkenal (fallback offline) + seed offline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.js';
import { toast } from './notify.js';
import { CATALOG } from './catalog.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'AgentHub/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Sumber 1: OpenRouter ----------
export async function fetchOpenRouterFree() {
  const raw = await fetchText('https://openrouter.ai/api/v1/models');
  const data = JSON.parse(raw);
  const models = (data.data || [])
    .filter((m) => {
      const p = m.pricing || {};
      return parseFloat(p.prompt || '1') === 0 && parseFloat(p.completion || '1') === 0;
    })
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || 0,
      provider: (m.id.split('/')[0] || '').replace(':free', ''),
      page: m.id.endsWith(':free')
        ? 'https://openrouter.ai/' + m.id.replace(/:free$/, '')
        : 'https://openrouter.ai/models',
      modality: m.architecture?.modality || 'text',
    }))
    .sort((a, b) => b.context - a.context);
  return { ts: Date.now(), models };
}

// ---------- Sumber 2b: models.dev (registry lintas provider) ----------
export async function fetchModelsDevFree() {
  const raw = await fetchText('https://models.dev/api.json', 30000);
  const data = JSON.parse(raw);
  const models = [];
  for (const [pid, p] of Object.entries(data)) {
    for (const [mid, mo] of Object.entries(p.models || {})) {
      const pr = mo.cost || mo.pricing || {};
      const inCost = parseFloat(pr.prompt ?? pr.input ?? '1') === 0;
      const outCost = parseFloat(pr.completion ?? pr.output ?? '1') === 0;
      if (inCost && outCost) {
        models.push({
          id: `${pid}/${mid}`,
          name: mo.name || mid,
          provider: pid,
          context: mo.limit?.context || 0,
          page: p.link || 'https://models.dev/',
        });
      }
    }
  }
  models.sort((a, b) => b.context - a.context);
  return { ts: Date.now(), models: models.slice(0, 400) };
}

// ---------- Sumber 2: daftar free-tier (repo GitHub) ----------
// Repo sempat berpindah owner — coba beberapa URL sumber.
const FREELIST_URLS = [
  'https://raw.githubusercontent.com/raullenchai/free-llm-api-resources/main/README.md',
  'https://raw.githubusercontent.com/cheahjs/free-llm-api-resources/main/README.md',
];

function parseFreeTierMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const providers = [];
  let cur = null;
  let afterLimits = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    const h = line.match(/^#{2,4}\s+\[([^\]]+)\]\((https?:[^)]+)\)/);
    if (h) {
      cur = { name: h[1].trim(), url: h[2], limits: '', models: [], rows: [], notes: [] };
      providers.push(cur);
      afterLimits = false;
      continue;
    }
    if (!cur) continue;

    // tabel HTML: <tr><td>a</td><td>b</td></tr>
    if (line.includes('<tr>')) {
      const cells = [...line.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gi)].map((m) =>
        m[1].replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length >= 1 && cur.rows.length < 25) cur.rows.push(cells.slice(0, 4));
      continue;
    }

    // batas pemakaian: **Limits:** 40 req/min — teks bisa di baris yang sama atau berikutnya
    const lim = line.match(/\*\*Limits?\b[^*]*\*\*:?\s*(.*)$/i);
    if (lim) {
      const rest = lim[1].replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
      if (rest && !rest.startsWith('`')) cur.limits = rest.slice(0, 220);
      else if (rest.startsWith('`')) cur.limits = rest.replaceAll('`', '').slice(0, 220);
      afterLimits = !rest;
      continue;
    }
    if (afterLimits && !cur.limits) {
      const plain = line.replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
      if (plain) { cur.limits = plain.slice(0, 220); afterLimits = false; }
      continue;
    }

    // bullet model: - [Nama](url)
    const bullet = line.match(/^[-*]\s+\[([^\]]+)\]\((https?:[^)]+)\)/);
    if (bullet) {
      if (cur.models.length < 25) cur.models.push({ name: bullet[1].trim(), url: bullet[2] });
      continue;
    }

    // tabel markdown: | a | b |
    if (line.startsWith('|') && line.includes('|', 1)) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length >= 2 && !cells.every((c) => /^[-: ]*$/.test(c)) && cur.rows.length < 25) {
        cur.rows.push(cells.slice(0, 4));
      }
      continue;
    }

    // catatan biasa / quote
    const plain = line.replace(/^>\s?/, '').replace(/^[*_]+|[*_]+$/g, '').trim();
    if (plain && plain.length > 8 && cur.notes.length < 3 && !/^[-*#|<>]/.test(plain)) {
      cur.notes.push(plain.slice(0, 220));
    }
  }
  // buang header tabel & provider tanpa isi
  return providers
    .filter((p) => p.models.length > 0 || p.rows.length > 0 || p.limits || p.notes.length > 0)
    .map((p) => ({
      name: p.name,
      url: p.url,
      limits: p.limits,
      models: p.models,
      notes: p.notes,
      rows: p.rows.filter((r, i) => !(i === 0 && r.some((c) => /model|limit/i.test(c)))),
    }));
}

export async function fetchFreeTierList() {
  let md = null;
  for (const url of FREELIST_URLS) {
    try { md = await fetchText(url); break; } catch { /* coba berikutnya */ }
  }
  if (!md) throw new Error('Semua sumber daftar free-tier gagal diakses');
  return { ts: Date.now(), providers: parseFreeTierMarkdown(md) };
}

// ---------- Seed offline ----------
// Seed adalah aset bawaan app (ikut installer) — selalu dibaca dari folder app,
// bukan dari folder data runtime (yang bisa pindah ke %APPDATA%).
const SEED_DIR = path.join(ROOT, '..', 'data');

function seedOpenRouter() {
  try {
    const p = path.join(SEED_DIR, 'seed-openrouter.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const models = (raw.data || [])
      .filter((m) => {
        const pr = m.pricing || {};
        return parseFloat(pr.prompt || '1') === 0 && parseFloat(pr.completion || '1') === 0;
      })
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || 0,
        provider: (m.id.split('/')[0] || '').replace(':free', ''),
        page: 'https://openrouter.ai/' + m.id.replace(/:free$/, ''),
        modality: m.architecture?.modality || 'text',
      }));
    return { ts: 0, models, seeded: true };
  } catch {
    return { ts: 0, models: [], seeded: true };
  }
}

function seedFreeList() {
  try {
    const p = path.join(SEED_DIR, 'seed-freelist.md');
    const md = fs.readFileSync(p, 'utf8');
    return { ts: 0, providers: parseFreeTierMarkdown(md), seeded: true };
  } catch {
    return { ts: 0, providers: [], seeded: true };
  }
}

// ---------- Refresh + diff alert ----------
export async function refreshPromo(config, addAlert, broadcast) {
  const snap = readJson('snapshot.json', null) || { sources: {}, knownIds: [] };

  const results = { openrouter: false, list: false, cross: false };
  try {
    snap.sources.openrouter = await fetchOpenRouterFree();
    results.openrouter = true;
  } catch (e) {
    if (!snap.sources.openrouter?.models?.length) snap.sources.openrouter = seedOpenRouter();
    snap.errors = snap.errors || {};
    snap.errors.openrouter = String(e.message || e);
  }

  try {
    snap.sources.list = await fetchFreeTierList();
    results.list = true;
  } catch (e) {
    if (!snap.sources.list?.providers?.length) snap.sources.list = seedFreeList();
    snap.errors = snap.errors || {};
    snap.errors.list = String(e.message || e);
  }

  try {
    snap.sources.cross = await fetchModelsDevFree();
    results.cross = true;
  } catch (e) {
    snap.errors = snap.errors || {};
    snap.errors.cross = String(e.message || e);
  }

  const ids = (snap.sources.openrouter?.models || []).map((m) => m.id);
  const prevKnown = new Set(snap.knownIds || []);

  if (config.baselined && prevKnown.size > 0) {
    const added = ids.filter((id) => !prevKnown.has(id));
    const removed = [...prevKnown].filter((id) => !ids.includes(id));
    if (added.length > 0) {
      addAlert({
        type: 'new-model',
        title: `${added.length} model GRATIS baru terdeteksi`,
        detail: added.slice(0, 8).join(', ') + (added.length > 8 ? ` +${added.length - 8} lainnya` : ''),
      });
      toast('AgentHub — Promo Baru!', `${added.length} model gratis baru: ${added.slice(0, 3).join(', ')}`);
    }
    if (removed.length > 0) {
      addAlert({
        type: 'removed-model',
        title: `${removed.length} model gratis tidak lagi tersedia`,
        detail: removed.slice(0, 8).join(', '),
      });
    }
  } else {
    addAlert({
      type: 'info',
      title: 'Snapshot pertama dibuat',
      detail: `${ids.length} model gratis dipantau. Alert berikutnya muncul saat ada perubahan.`,
    });
  }

  snap.knownIds = ids;
  snap.lastRefresh = Date.now();
  writeJson('snapshot.json', snap);
  if (broadcast) broadcast('promo');
  return { results, count: ids.length };
}

export function getCatalog() {
  return CATALOG;
}
