// test/research.test.js — riset web tanpa API key: parser hasil DDG
// (fixture offline, tidak menembus jaringan) + endpoint /api/research.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResults, parseBing, researchContext, searchWeb } from '../lib/research.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8830 + Math.floor(Math.random() * 20);
const TOKEN = 'researchtok01234567';
let child;
let dataDir;

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Fixture meniru struktur HTML hasil DuckDuckGo html endpoint:
// judul dibungkus redirect /l/?uddg=<encoded>, snippet menyertakan <b>.
const FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgroq.com%2Ffree&amp;rut=abc123">Groq <b>free</b> tier API</a>
  <a class="result__snippet">Groq offers a <b>free plan</b> with rate limits &amp; fast LPU inference.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://openrouter.ai/docs">OpenRouter :free models</a>
  <a class="result__snippet">17 models with &lt;code&gt;:free&lt;/code&gt; suffix, 50 requests/day.</a>
</div>
<div class="result">
  <a class="result__a" href="/internal/link">link relatif diabaikan</a>
</div>
`;

// Bing: <li class="b_algo"> dengan redirect /ck/a dan URL asli base64url
// di param u=a1 (aHR0cHM6Ly9leGFtcGxlLmNvbS9h = https://example.com/a).
const B64A = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9h';
const B64B = 'aHR0cHM6Ly9leGFtcGxlLmNvbS9i';
const BING_FIXTURE = `
<ol id="b_results"><li class="b_algo" data-iid>
  <h2><a target="_blank" href="https://www.bing.com/ck/a?&amp;u=a1${B64A}&amp;ntb=1" h="ID=SERP"><strong>Free</strong> API A</a></h2>
  <div class="b_caption"><p class="b_lineclamp2">Snippet A with &lt;b&gt;markup&lt;/b&gt;.</p></div>
</li><li class="b_algo">
  <h2><a href="https://example.com/b">Direct link B</a></h2>
  <p class="b_caption p-5px">Snippet B.</p>
</li></ol>
`;

test('research unit: parser Bing (redirect base64url diuraikan)', () => {
  const r = parseBing(BING_FIXTURE);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://example.com/a', 'u=a1 base64url didekode');
  assert.equal(r[0].title, 'Free API A');
  assert.equal(r[0].snippet, 'Snippet A with markup.');
  assert.equal(r[1].url, 'https://example.com/b', 'href langsung dipakai');
  assert.equal(r[1].snippet, 'Snippet B.');
});

test('research unit: fallback engine saat DDG diblokir (halaman 202)', async () => {
  const fake = async (url) => ({
    ok: true, status: url.includes('duckduckgo') ? 202 : 200,
    text: async () => (url.includes('duckduckgo') ? '<html>anomaly page</html>' : BING_FIXTURE),
  });
  const r = await searchWeb('uji', { fetchImpl: fake });
  assert.equal(r.engine, 'bing', 'harus jatuh ke mesin ketiga');
  assert.equal(r.results.length, 2);
});

test('research unit: semua mesin gagal → error jelas, bukan 0 hasil palsu', async () => {
  const fake = async () => ({ ok: true, status: 202, text: async () => '<html>challenge</html>' });
  await assert.rejects(() => searchWeb('uji', { fetchImpl: fake }), (e) => {
    assert.match(e.message, /semua mesin menolak/);
    assert.match(e.message, /bing/);
    return true;
  });
});

test('research unit: parser fixture DDG offline', () => {
  const r = parseResults(FIXTURE);
  assert.equal(r.length, 2, 'link relatif dibuang');
  assert.equal(r[0].url, 'https://groq.com/free', 'uddg redirect diuraikan');
  assert.equal(r[0].title, 'Groq free tier API', 'tag dihapus & entitas dibersihkan');
  assert.equal(r[0].snippet, 'Groq offers a free plan with rate limits & fast LPU inference.');
  assert.equal(r[1].url, 'https://openrouter.ai/docs', 'URL langsung dipakai apa adanya');
  assert.equal(r[1].snippet, '17 models with :free suffix, 50 requests/day.');

  // konteks prompt: nomor, url, arahan sitasi
  const ctx = researchContext('uji', r);
  assert.match(ctx, /## Hasil riset web: "uji"/);
  assert.match(ctx, /1\. Groq free tier API — https:\/\/groq\.com\/free/);
  assert.match(ctx, /sebutkan sumbernya/);

  // hasil kosong → konteks kosong (bukan blok palsu)
  assert.equal(researchContext('uji', []), '');
});

test('research unit: query kosong ditolak sebelum jaringan', async () => {
  await assert.rejects(() => searchWeb('   '), { statusCode: 400 });
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-res-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('research API: query kosong 400, 401 tanpa token, endpoint hidup', async () => {
  // query kosong → 400 (tidak menyentuh jaringan)
  assert.equal((await api('/api/research?q=%20%20')).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/research?q=halo`)).status, 401);
  // query nyata boleh sukses atau gagal jelas (jaringan CI bisa diblokir —
  // keduanya bukan crash: server tetap balik JSON dengan status terkontrol)
  const r = await api('/api/research?q=agenthub');
  assert.ok([200, 502, 504].includes(r.status), `status terkontrol, dapat ${r.status}`);
});
