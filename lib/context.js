// lib/context.js — perkiraan pemakaian jendela konteks per thread.
//
// Sumber angka:
//   - usage upstream NYATA dari pesan asisten (prompt_tokens,
//     completion_tokens, prompt_tokens_details.cached_tokens) — disimpan saat
//     run pool selesai.
//   - batas konteks model dari snapshot promo (models.dev / OpenRouter
//     memuat context_length). Model tidak dikenal → null, bukan tebakan.
//   - komposisi riwayat = PERKIRAAN (chars ÷ 4) yang meniru batas builder
//     pool (12 pesan terakhir, maks 12 ribu karakter).
export const CONTEXT_EST_CHARS_PER_TOKEN = 4;
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 12000;

// Cari batas konteks model di snapshot promo. Pencocokan longgar: persis,
// tanpa akhiran :free, atau akhiran id cocok (gateway bisa mengembalikan
// nama upstream yang berbeda prefiks).
export function modelContextLimit(modelId, snapshot) {
  if (!modelId) return null;
  const sources = snapshot?.sources || {};
  const lists = [
    ...(sources.openrouter?.models || []),
    ...(sources.cross?.models || []),
    ...(sources.list?.models || []),
  ];
  const want = String(modelId).toLowerCase();
  const base = want.replace(/:free$/, '');
  const idOf = (m) => String(m.id || '').toLowerCase();
  const hit =
    lists.find((m) => idOf(m) === want) ||
    lists.find((m) => idOf(m).replace(/:free$/, '') === base) ||
    lists.find((m) => {
      const id = idOf(m).replace(/:free$/, '');
      return id && (want.endsWith(id) || id.endsWith(base));
    });
  const context = Number(hit?.context) || 0;
  return context > 0 ? context : null;
}

// Statistik konteks satu thread, atau null bila tidak ada run pool yang
// melaporkan usage (engine CLI tidak melaporkannya).
export function contextStats({ model, msgs, snapshot } = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  const withUsage = [...list].reverse().find((m) => Number(m?.usage?.prompt_tokens) > 0);
  if (!withUsage) return null;
  const usage = withUsage.usage;
  const input = Number(usage.prompt_tokens) || 0;
  const limit = modelContextLimit(model, snapshot);

  // Perkiraan komposisi permintaan terakhir: riwayat sebelum pesan user
  // terakhir, dengan batas yang sama seperti builder pool.
  const lastUserIdx = list.map((m) => m?.role).lastIndexOf('user');
  let chars = 0;
  let picked = 0;
  for (let i = (lastUserIdx < 0 ? list.length : lastUserIdx) - 1; i >= 0 && picked < HISTORY_MESSAGES; i--) {
    const m = list[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.subrun || m.status === 'working' || (m.runStatus && m.runStatus !== 'done')) continue;
    const content = String(m.modelContent || m.content || '').trim();
    if (!content) continue;
    const room = HISTORY_CHARS - chars;
    if (room <= 0) break;
    chars += Math.min(content.length, room);
    picked += 1;
  }
  const est = Math.ceil;
  const historyTokens = Math.min(input, est(chars / CONTEXT_EST_CHARS_PER_TOKEN));
  const promptTokens = Math.max(0, input - historyTokens);

  const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
  const cacheHitRate = cached > 0 && input > 0 ? Math.round((cached / input) * 1000) / 10 : null;
  const usagePct = limit ? Math.round((input / limit) * 1000) / 10 : null;

  return {
    model: model || null,
    limit,
    input,
    output: Number(usage.completion_tokens) || null,
    usagePct,
    historyTokens,
    promptTokens,
    cacheHitRate,
    estimated: true,
  };
}
