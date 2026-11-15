import test from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_PROVIDERS, retiredReason, filterRetiredProviders } from '../lib/retired-providers.js';
import { getFreeTierProviders } from '../lib/promo.js';

// Daftar provider pihak ketiga (repo free-llm-api-resources) tertinggal
// berbulan-bulan. Tanpa penyaringan, tab "Daftar Free-Tier" menjanjikan
// layanan yang sudah tidak ada — provider yang endpoint-nya mati atau sudah
// berbayar tetap tampil seolah gratis.
test('pensiun: provider yang sudah diverifikasi cocok dengan namanya', () => {
  const cases = [
    ['GitHub Models', /pensiun/i],
    ['Mistral (La Plateforme)', /Free/i],
    ['Cerebras', /kredit/i],
    ['HuggingFace Inference Providers', /kredit/i],
    ['Hugging Face', /kredit/i],
    ['Together AI', /free trials/i],
    ['xAI', /kredit/i],
    ['x.ai', /kredit/i],
  ];
  for (const [name, re] of cases) {
    const hit = retiredReason(name);
    assert.ok(hit, `${name} seharusnya dikenali sebagai pensiun`);
    assert.match(hit.reason, re, `${name}: alasan menyebut buktinya`);
    assert.match(hit.source, /^https:\/\//, `${name}: sumber resmi wajib ada`);
  }
});

// Provider yang masih memberi akses gratis TIDAK boleh ikut tersaring:
// penyaringan yang kebablasan sama merusaknya dengan tidak menyaring.
test('pensiun: provider yang masih gratis tidak tersentuh', () => {
  for (const name of ['Groq', 'OpenRouter', 'Cloudflare Workers AI', 'Google AI Studio', 'NVIDIA NIM', 'Cohere', 'CerebrasX']) {
    assert.equal(retiredReason(name), null, `${name} tidak boleh dianggap pensiun`);
  }
  assert.equal(retiredReason(''), null, 'nama kosong tidak cocok dengan apa pun');
  assert.equal(retiredReason(null), null, 'null aman');
  assert.equal(retiredReason(undefined), null, 'undefined aman');
});

test('pensiun: pencocokan tidak sensitif huruf besar/kecil', () => {
  assert.ok(retiredReason('GITHUB MODELS'));
  assert.ok(retiredReason('github models'));
  assert.ok(retiredReason('  Cerebras  '), 'spasi di tepi diabaikan');
});

test('pensiun: setiap entri punya nama, alasan, dan sumber resmi', () => {
  for (const entry of RETIRED_PROVIDERS) {
    assert.ok(entry.name, 'nama provider wajib');
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.name}: alasan harus menjelaskan sebabnya`);
    assert.match(entry.source, /^https:\/\//, `${entry.name}: sumber harus https`);
    assert.ok(Array.isArray(entry.match) && entry.match.length > 0, `${entry.name}: pola pencocokan wajib`);
  }
});

test('pensiun: filter memisahkan yang disembunyikan dari yang tetap tampil', () => {
  const list = [
    { name: 'Groq', url: 'https://console.groq.com' },
    { name: 'GitHub Models', url: 'https://github.com/marketplace/models' },
    { name: 'Cerebras', url: 'https://cloud.cerebras.ai/' },
    { name: 'OpenRouter', url: 'https://openrouter.ai' },
  ];
  const { providers, hidden } = filterRetiredProviders(list);
  assert.deepEqual(providers.map((p) => p.name), ['Groq', 'OpenRouter']);
  assert.deepEqual(hidden.map((h) => h.name), ['GitHub Models', 'Cerebras']);
  assert.ok(hidden[0].reason && hidden[0].source, 'yang disembunyikan membawa alasan untuk ditampilkan');
  // Entri asli tidak dimodifikasi — daftar sumber tetap utuh untuk audit.
  assert.equal(list.length, 4);
});

test('pensiun: input aneh tidak membuat filter melempar', () => {
  assert.deepEqual(filterRetiredProviders(undefined), { providers: [], hidden: [] });
  assert.deepEqual(filterRetiredProviders(null), { providers: [], hidden: [] });
  const { providers, hidden } = filterRetiredProviders([{}, { name: '' }, { name: 'Groq' }]);
  assert.equal(providers.length, 3, 'entri tanpa nama tetap lolos, bukan dianggap pensiun');
  assert.equal(hidden.length, 0);
});

test('pensiun: getFreeTierProviders membaca snapshot dan menyaringnya', () => {
  const snapshot = {
    sources: {
      list: {
        providers: [
          { name: 'Groq', url: 'https://console.groq.com', models: [], rows: [], notes: [] },
          { name: 'GitHub Models', url: 'https://github.com/marketplace/models', models: [], rows: [], notes: [] },
        ],
      },
    },
  };
  const { providers, hidden } = getFreeTierProviders(snapshot);
  assert.deepEqual(providers.map((p) => p.name), ['Groq']);
  assert.deepEqual(hidden.map((h) => h.name), ['GitHub Models']);
});

test('pensiun: snapshot kosong atau rusak aman', () => {
  for (const snap of [null, undefined, {}, { sources: {} }, { sources: { list: {} } }]) {
    const r = getFreeTierProviders(snap);
    assert.deepEqual(r, { providers: [], hidden: [] }, `${JSON.stringify(snap)} tidak boleh melempar`);
  }
});
