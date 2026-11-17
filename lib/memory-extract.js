// lib/memory-extract.js — ekstraksi memori otomatis setelah percakapan selesai.
//
// REA ZCode packages/core/src/memory/extraction.ts. Tanpa ini memori hanya
// tumbuh kalau pengguna ingat menekan "Ingat", jadi fakta yang jelas-jelas
// diucapkan ("saya selalu pakai pnpm") hilang begitu thread ditutup.
//
// Yang dijaga ketat, karena hasil ekstraksi disuntikkan ke SETIAP prompt:
//   • Hanya jalan bila diaktifkan. ZCode pun tidak menyalakannya untuk prompt
//     biasa: satu panggilan model tambahan per percakapan adalah biaya nyata,
//     dan percakapan receh tidak menghasilkan fakta apa pun.
//   • Hanya membaca pesan SETELAH cursor terakhir. Tanpa cursor, setiap run
//     akan mengekstrak ulang seluruh riwayat dan menumpuk fakta yang sama.
//   • Hasilnya bukan instruksi. Teks dari model (dan dari halaman yang ditempel
//     pengguna) tidak boleh bisa menanam "abaikan instruksi sebelumnya" ke dalam
//     memori yang lalu masuk ke semua prompt. Fakta yang berbentuk perintah,
//     berisi prompt-marker, atau mirip kredensial dibuang.
//   • Maksimal tiga fakta per run dan 300 karakter per fakta: satu run panjang
//     tidak boleh mengubah blok memori menjadi ratusan baris.
import { readJson, writeJson } from './store.js';
import { routeChat } from './pool.js';

const FILE = 'memory-extract.json';
const MAX_THREADS = 200;
const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_FACTS_PER_RUN = 3;
const MAX_FACT_LEN = 300;
const MIN_FACT_LEN = 8;
const MIN_USER_WORDS = 3;          // sama dengan ZCode: sapaan singkat bukan fakta
const TIMEOUT_MS = 45000;

function state() {
  const raw = readJson(FILE, null);
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    threads: data.threads && typeof data.threads === 'object' && !Array.isArray(data.threads)
      ? data.threads : {},
    last: data.last || null,
  };
}

function saveState(next) {
  // Hanya simpan sebagian thread terbaru: berkas ini catatan kemajuan, bukan
  // arsip. Menyimpan semua thread akan tumbuh tanpa batas.
  const entries = Object.entries(next.threads || {})
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
    .slice(0, MAX_THREADS);
  writeJson(FILE, { threads: Object.fromEntries(entries), last: next.last || null });
}

export function extractStatus(threadId = null) {
  const st = state();
  if (threadId) return st.threads[threadId] || null;
  return { last: st.last, tracked: Object.keys(st.threads).length };
}

// Ringkasan lengkap untuk UI: selain jumlah thread, peta per-thread ikut
// dikirim. Tanpa peta itu tombol "Ekstrak sekarang" tidak bisa tahu hasil
// ekstraksi thread yang sedang dibuka, dan selalu melaporkan "tidak ada fakta
// baru" walau fakta benar-benar tersimpan.
export function extractOverview() {
  const st = state();
  return { last: st.last, tracked: Object.keys(st.threads).length, threads: st.threads };
}

export function resetThread(threadId) {
  const st = state();
  if (!threadId) { saveState({ threads: {}, last: st.last }); return { ok: true }; }
  delete st.threads[threadId];
  saveState(st);
  return { ok: true };
}

// ---------- kandidat pesan ----------
// Hanya percakapan sungguhan: pesan user/assistant dengan teks. Pesan sistem,
// sub-run orkestrasi, dan hasil tool tidak menjelaskan siapa penggunanya.
function conversationMessages(thread) {
  return (thread?.messages || []).filter((m) => (
    (m.role === 'user' || m.role === 'assistant')
    && !m.subrun
    && typeof m.content === 'string'
    && m.content.trim()
  ));
}

function afterCursor(messages, cursor) {
  if (!cursor) return messages;
  const idx = messages.findIndex((m) => m.id === cursor);
  // Cursor menunjuk pesan yang sudah tidak ada (thread dipangkas / fork):
  // anggap belum pernah diekstrak, jangan diam-diam melewati percakapan baru.
  return idx < 0 ? messages : messages.slice(idx + 1);
}

function countWords(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

// Alasan untuk tidak menjalankan ekstraksi. Dikembalikan sebagai data, bukan
// dilempar, supaya UI bisa menjelaskan mengapa tidak ada fakta baru.
export function evaluateCandidate(thread, { enabled, cursor = null, runStatus = null } = {}) {
  if (!enabled) return { run: false, reason: 'off', messageCount: 0 };
  if (!thread) return { run: false, reason: 'no-thread', messageCount: 0 };
  if (runStatus && runStatus !== 'done') return { run: false, reason: 'run-' + runStatus, messageCount: 0 };
  const messages = conversationMessages(thread);
  const fresh = afterCursor(messages, cursor);
  const userTurns = fresh.filter((m) => m.role === 'user');
  const prose = userTurns.filter((m) => countWords(m.content) >= MIN_USER_WORDS);
  if (!fresh.length) return { run: false, reason: 'nothing-new', messageCount: 0, messages: fresh };
  if (!prose.length) return { run: false, reason: 'no-user-prose', messageCount: fresh.length, messages: fresh };
  return { run: true, reason: 'ok', messageCount: fresh.length, messages: fresh };
}

// ---------- penyaring fakta ----------
// Semua pola di sini menolak teks yang, kalau disuntikkan ke prompt, berubah
// menjadi perintah alih-alih keterangan tentang pengguna. Kalimat preferensi
// biasa ("jangan pakai tab", "tulis jawaban dalam bahasa Indonesia") tetap
// diterima: yang berbahaya adalah teks yang menyuruh model mengabaikan aturan
// atau menyamar sebagai pesan sistem.
const INSTRUCTION_PATTERNS = [
  /(abaikan|ignore|forget|lupakan)\s+(semua\s+)?(instruksi|instruction|prompt|aturan|rule|pesan)/i,
  /(system|developer|sistem)\s*(prompt|message|instruction|pesan)/i,
  /<\/?(system|assistant|user|instructions?|prompt)[\s>]/i,
  /<\|[a-z_]+\|>/,
  /\[(inst|system)\]/i,
  /\b(kamu|anda|you)\s+(harus|wajib|must|should|shall|will now)\b/i,
  /\b(mulai|starting)\s+(sekarang|now)\b.*\b(kamu|anda|you)\b/i,
  /```/,
];
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b(api[\s_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function sanitizeFact(text) {
  let raw = String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Model sering menambahkan penanda daftar walau diminta JSON.
  raw = raw.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
  raw = raw.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (raw.length < MIN_FACT_LEN) return null;
  if (raw.length > MAX_FACT_LEN) raw = raw.slice(0, MAX_FACT_LEN).trim();
  for (const re of INSTRUCTION_PATTERNS) if (re.test(raw)) return null;
  for (const re of SECRET_PATTERNS) if (re.test(raw)) return null;
  // Fakta adalah pernyataan tentang pengguna/proyek; satu titik dua di tengah
  // masih wajar ("pakai pnpm: karena lockfile"), tetapi baris yang seluruhnya
  // berbentuk "kunci: nilai" hampir selalu setelan atau kredensial.
  if (/^[a-z0-9 ._-]{2,30}:\s*\S{24,}$/i.test(raw)) return null;
  return raw;
}

// Model diminta JSON, tetapi tetap harus tahan terhadap pagar kode dan kalimat
// pembuka. Baris yang tidak lolos penyaring dibuang, bukan menggagalkan semua.
export function parseFacts(text) {
  const raw = String(text || '');
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  const lines = [];
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') lines.push(item);
          else if (item && typeof item === 'object' && typeof item.text === 'string') lines.push(item.text);
        }
      }
    } catch { /* jatuh ke pembacaan per baris */ }
  }
  if (!lines.length) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/) || line.match(/^\s*\{?\s*"text"\s*:\s*"(.*?)"\s*\}?,?\s*$/);
      if (m) lines.push(m[1]);
    }
  }
  if (!lines.length) {
    const plain = sanitizeFact(raw);
    if (plain && !/^nothing to save/i.test(plain)) lines.push(plain);
  }
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const fact = sanitizeFact(line);
    if (!fact) continue;
    if (/^nothing to save\.?$/i.test(fact)) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= MAX_FACTS_PER_RUN) break;
  }
  return out;
}

export function buildPrompt(messages, existing = []) {
  const transcript = messages.slice(-MAX_MESSAGES).map((m) => {
    const who = m.role === 'user' ? 'USER' : 'ASSISTANT';
    return `${who}: ${String(m.content).slice(0, MAX_CHARS_PER_MESSAGE)}`;
  }).join('\n\n');
  const known = existing.length
    ? `\n\nFakta yang SUDAH tersimpan (jangan diulang):\n${existing.slice(-40).map((f) => `- ${f.text}`).join('\n')}`
    : '';
  return [
    'Kamu mengekstrak memori jangka panjang dari potongan percakapan di bawah.',
    '',
    'Simpan HANYA fakta tahan lama tentang pengguna atau proyeknya: preferensi kerja, gaya bahasa, alat yang dipakai, keputusan yang berlaku terus, batasan yang berulang.',
    'JANGAN simpan: isi tugas sesaat, pertanyaan, hasil kerja, kode, path sementara, nama berkas yang mungkin berubah, atau apa pun yang hanya penting untuk percakapan ini.',
    'JANGAN simpan rahasia: kunci API, token, kata sandi, atau isi berkas pribadi.',
    'Setiap fakta harus satu kalimat pernyataan orang ketiga, tanpa kata perintah, maksimal 200 karakter.',
    '',
    'Jawab HANYA dengan array JSON berisi string, misalnya ["Memakai pnpm untuk semua proyek Node."].',
    'Bila tidak ada yang layak disimpan, jawab persis: Nothing to save.',
    '',
    '--- percakapan ---',
    transcript,
    known,
  ].join('\n');
}

// ---------- eksekusi ----------
let running = null;   // satu ekstraksi sekaligus: jangan rebutan kuota key pool
let queued = null;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ekstraksi melewati batas ${Math.round(ms / 1000)} detik`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `router` bisa diganti di tes supaya tidak butuh key pool sungguhan.
export async function runExtraction({ messages, existing = [], model = 'auto', router = routeChat } = {}) {
  const prompt = buildPrompt(messages, existing);
  const r = await withTimeout(
    router({ model, messages: [{ role: 'user', content: prompt }] }),
    TIMEOUT_MS,
  );
  if (!r || r.type === 'error') {
    return { ok: false, error: 'pool tidak tersedia', facts: [] };
  }
  let text = '';
  if (r.type === 'json') {
    try {
      const j = JSON.parse(r.body);
      text = j.choices?.[0]?.message?.content || '';
    } catch { text = ''; }
  } else if (typeof r.body === 'string') {
    // Balasan streaming: ambil potongan `content` dari SSE.
    for (const line of r.body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        text += j.choices?.[0]?.delta?.content || '';
      } catch { /* baris bukan JSON */ }
    }
  }
  if (!text.trim()) return { ok: false, error: 'balasan kosong', facts: [] };
  return { ok: true, facts: parseFacts(text), error: null };
}

// Dijalankan di latar belakang: kegagalan ekstraksi tidak boleh menyentuh run
// yang sudah selesai, dan hasilnya tidak ditunggu oleh pengguna.
// `router` hanya dipakai tes; produksi memakai routeChat dari pool.
export function schedule({ threadId, thread, enabled, cursor, runStatus, model, onDone, router } = {}) {
  const decision = evaluateCandidate(thread, { enabled, cursor, runStatus });
  if (!decision.run) {
    return { scheduled: false, reason: decision.reason };
  }
  if (running) {
    // Satu antrean saja, dan hanya yang terbaru: percakapan lama yang belum
    // diekstrak tidak lebih penting daripada yang baru selesai.
    queued = { threadId, decision, model, onDone, router };
    return { scheduled: false, reason: 'busy' };
  }
  running = execute({ threadId, decision, model, onDone, router }).finally(() => {
    running = null;
    const next = queued;
    queued = null;
    if (next) {
      running = execute({ threadId: next.threadId, decision: next.decision, model: next.model, onDone: next.onDone, router: next.router })
        .finally(() => { running = null; });
    }
  });
  return { scheduled: true, reason: 'ok', messageCount: decision.messageCount };
}

async function execute({ threadId, decision, model, onDone, router = routeChat }) {
  const st = state();
  const lastMessage = decision.messages[decision.messages.length - 1];
  const record = {
    cursor: st.threads[threadId]?.cursor || null,
    at: Date.now(),
    status: 'running',
    added: 0,
    skipped: 0,
    error: null,
  };
  st.threads[threadId] = record;
  saveState(st);
  try {
    const { listMemory, addMemory } = await import('./memory.js');
    const result = await runExtraction({
      messages: decision.messages,
      existing: listMemory(),
      model: model || 'auto',
      router,
    });
    let added = 0;
    let skipped = 0;
    for (const fact of result.facts) {
      try {
        const before = listMemory().length;
        addMemory(fact, { source: 'auto', threadId });
        if (listMemory().length > before) added += 1; else skipped += 1;
      } catch { skipped += 1; }
    }
    // Cursor hanya maju bila ekstraksi benar-benar berhasil. Kalau pool sedang
    // mati, percakapan ini masih perlu dicoba pada run berikutnya; memajukan
    // cursor berarti fakta di dalamnya hilang untuk selamanya.
    const st2 = state();
    st2.threads[threadId] = {
      cursor: result.ok ? (lastMessage?.id || null) : record.cursor,
      at: Date.now(),
      status: result.ok ? 'ok' : 'error',
      added,
      skipped,
      error: result.error || null,
    };
    st2.last = { threadId, at: Date.now(), status: st2.threads[threadId].status, added, skipped, error: result.error || null };
    saveState(st2);
    if (onDone) { try { onDone(st2.threads[threadId]); } catch { /* callback UI tidak boleh menggagalkan */ } }
    return st2.threads[threadId];
  } catch (error) {
    const st2 = state();
    st2.threads[threadId] = {
      cursor: record.cursor,
      at: Date.now(),
      status: 'error',
      added: 0,
      skipped: 0,
      error: String(error.message || error),
    };
    st2.last = { threadId, at: Date.now(), status: 'error', added: 0, skipped: 0, error: st2.threads[threadId].error };
    saveState(st2);
    return st2.threads[threadId];
  }
}

// Penanda untuk mencegah dua ekstraksi paralel pada thread yang sama saat
// pengguna menekan "Ekstrak sekarang" berulang kali.
export function isRunning() {
  return running !== null;
}
