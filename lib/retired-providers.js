// Provider yang sudah TIDAK lagi memberi akses gratis, beserta alasan dan
// sumbernya. Dipakai dua tempat sekaligus supaya keduanya konsisten:
//
//  1. katalog promo (lib/catalog.js) — entri bertanda expired tidak ditampilkan
//  2. daftar free-tier pihak ketiga (lib/promo.js) — nama provider yang cocok
//     disembunyikan, karena daftar eksternal itu sering tertinggal berbulan-bulan
//
// Hanya provider yang benar-benar sudah diverifikasi ke dokumen resmi yang
// masuk sini. Ragu = jangan masukkan: lebih baik tampil dengan label "tanggal
// berakhir tidak diumumkan" daripada menuduh promo masih hidup/mati tanpa bukti.
export const RETIRED_PROVIDERS = [
  {
    // Dicocokkan ke nama provider di daftar eksternal dan ke entri katalog.
    match: [/github\s*models/i],
    name: 'GitHub Models',
    retiredAt: '2026-07-30',
    reason: 'Layanan pensiun total 30 Juli 2026 — playground, katalog model, inference API, dan BYOK tidak lagi tersedia.',
    source: 'https://docs.github.com/en/github-models',
  },
  {
    match: [/^mistral\s*\(la plateforme\)/i, /^mistral la plateforme$/i],
    name: 'Mistral La Plateforme',
    retiredAt: null,
    reason: 'Mode Free tidak termasuk akses API; membuat API key butuh billing aktif dan bayar per token.',
    source: 'https://docs.mistral.ai/admin/user-management-finops/tier',
  },
  {
    match: [/^cerebras$/i],
    name: 'Cerebras',
    retiredAt: null,
    reason: 'Tidak ada tier gratis yang diperpanjang otomatis; hanya $5 kredit setelah menambah metode pembayaran, berlaku 30 hari.',
    source: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  {
    match: [/^hugging\s*face/i, /^huggingface/i],
    name: 'Hugging Face Inference Providers',
    retiredAt: null,
    reason: 'Akun gratis tidak lagi mendapat kredit inference bulanan ("Free Users: None"); kredit hanya untuk PRO.',
    source: 'https://huggingface.co/docs/inference-providers/en/pricing',
  },
  {
    match: [/^together/i],
    name: 'Together AI',
    retiredAt: null,
    reason: 'Dokumen resmi: "doesn\'t currently offer free trials" — akses butuh pembelian kredit minimum $15.',
    source: 'https://docs.together.ai/docs/billing-credits',
  },
  {
    match: [/^xai/i, /^x\.ai/i],
    name: 'xAI (Grok)',
    retiredAt: '2025-05-31',
    reason: 'Program kredit data-sharing $150/bulan berakhir 2025; halaman resminya tidak lagi tersedia.',
    source: 'https://docs.x.ai/docs/models',
  },
];

/** Alasan pensiun untuk sebuah nama provider, atau null bila masih berlaku. */
export function retiredReason(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  for (const entry of RETIRED_PROVIDERS) {
    if (entry.match.some((re) => re.test(text))) return entry;
  }
  return null;
}

/** Buang provider yang sudah pensiun dari daftar pihak ketiga. */
export function filterRetiredProviders(list) {
  const kept = [];
  const hidden = [];
  for (const item of list || []) {
    const hit = retiredReason(item?.name);
    if (hit) hidden.push({ name: item.name, reason: hit.reason, source: hit.source });
    else kept.push(item);
  }
  return { providers: kept, hidden };
}
