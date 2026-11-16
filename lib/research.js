// lib/research.js — riset web tanpa API key: DuckDuckGo → DDG Lite → Bing,
// zero-dependency. UI menyisipkan hasil terformat ke prompt agent.
//
// Kenapa tiga mesin: mesin pencari memblokir bot dengan halaman tantangan
// (DDG balik HTTP 202 tanpa hasil, Mojeek 403). Riset yang jujur berarti
// mencoba mesin berikutnya dan MENGAKAN GAGAL bila semuanya menolak — bukan
// mengembalikan "0 hasil" palsu.
export class ResearchError extends Error {
  constructor(message, statusCode = 502) { super(message); this.statusCode = statusCode; }
}

// UA browser biasa: endpoint html beberapa mesin menolak UA aneh langsung.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Entitas HTML minimum yang muncul di hasil; selebihnya dibiarkan apa adanya
// karena snippet dipakai sebagai konteks, bukan di-render langsung.
function unescape(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // entitas numerik (&#174; = ®) — dibersihkan terakhir
    .replace(/&#(\d+);/g, (_, n) => {
      const num = Number(n);
      return num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : '';
    });
}

function stripTags(s) {
  // dua lapis: entitas bisa menyembunyikan tag (&lt;b&gt;) — strip, urai,
  // strip lagi supaya hasilnya teks murni.
  let out = String(s).replace(/<[^>]+>/g, '');
  out = unescape(out).replace(/<[^>]+>/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

// URL hasil DDG kadang dibungkus redirect /l/?uddg=<encoded> — uraikan;
// kadang langsung http(s). Selain itu (relative) dibuang.
function resultUrl(href) {
  const raw = unescape(String(href || ''));
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return ''; } }
  return /^https?:\/\//.test(raw) ? raw : '';
}

// Bing membungkus tautan lewat /ck/a dengan URL asli base64url di param
// `u=a1<...>` (tanpa padding). Selain itu: pakai href langsung, kecuali
// redirect Bing itu sendiri (tidak ada gunanya untuk agent).
function bingUrl(href) {
  const raw = unescape(String(href || ''));
  const m = raw.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const dec = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//.test(dec)) return dec;
    } catch { /* jatuh ke aturan umum */ }
  }
  return /^https?:\/\//.test(raw) && !/bing\.com\/ck/.test(raw) ? raw : '';
}

// ---------- parser DuckDuckGo (html & lite) ----------
export function parseResults(html) {
  const results = [];
  // Satu blok hasil = <a class="result__a" href=...>judul</a> ... snippet
  // (result__snippet). Kenapa regex dan bukan DOM: zero-dependency.
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = resultUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const sn = rest.match(snippetRe);
    results.push({ title, url, snippet: sn ? stripTags(sn[1]).slice(0, 300) : '' });
    if (results.length >= 10) break;
  }
  return results;
}

// DDG Lite: tabel <a class="result-link"> + <td class="result-snippet">
export function parseLite(html) {
  const links = [...html.matchAll(/<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g)];
  const results = [];
  links.forEach((m, i) => {
    const url = resultUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) return;
    results.push({ title, url, snippet: snippets[i] ? stripTags(snippets[i][1]).slice(0, 300) : '' });
  });
  return results.slice(0, 10);
}

// ---------- parser Bing ----------
export function parseBing(html) {
  const results = [];
  const liRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const seg = m[0];
    const a = seg.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = bingUrl(a[1]);
    const title = stripTags(a[2]);
    if (!url || !title) continue;
    const p = seg.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || seg.match(/<p[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: p ? stripTags(p[1]).slice(0, 300) : '' });
    if (results.length >= 10) break;
  }
  return results;
}

// ---------- daftar mesin (urutan = prioritas) ----------
const ENGINES = [
  { id: 'ddg', build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseResults },
  { id: 'ddg-lite', build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseLite },
  { id: 'bing', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
];

async function fetchText(url, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new ResearchError(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchWeb(query, { limit = 8, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw new ResearchError('Query riset tidak boleh kosong', 400);
  const tried = [];
  for (const eng of ENGINES) {
    try {
      const html = await fetchText(eng.build(q), timeoutMs, fetchImpl);
      const results = eng.parse(html).slice(0, limit);
      if (results.length) return { query: q, engine: eng.id, results, count: results.length };
      tried.push(`${eng.id}: 0 hasil (kemungkinan halaman tantangan bot)`);
    } catch (e) {
      tried.push(`${eng.id}: ${e.message}`);
    }
  }
  throw new ResearchError(`Riset web gagal — semua mesin menolak (${tried.join('; ')})`);
}

// Blok konteks siap-suntik ke prompt (dipakai UI "Riset web" dan schedule).
export function researchContext(query, results) {
  if (!results?.length) return '';
  return [
    `## Hasil riset web: "${query}"`,
    ...results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`),
    'Gunakan sumber di atas bila relevan dan sebutkan sumbernya.',
  ].join('\n');
}
