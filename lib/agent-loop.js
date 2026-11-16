// lib/agent-loop.js — loop tool-calling untuk engine pool.
//
// Kenapa loop terpisah, bukan di dalam runEngine: runEngine mengurus satu
// panggilan model (dan proses CLI). Memberi tool kepada model berarti memanggil
// model berkali-kali: model minta tool → server menjalankan → hasil dikirim
// balik → model lanjut. Loop itu punya batas, pembatalan, dan pelaporan sendiri,
// jadi ia layak jadi modul yang bisa diuji tanpa jaringan.
//
// Batas yang dipilih sadar: turn dibatasi supaya model yang berputar-putar
// (memanggil tool yang sama tanpa kemajuan) tidak menghabiskan kuota pool tanpa
// akhir. Setiap pemanggilan tool dilaporkan lewat onEvent agar UI bisa menampilkan
// apa yang sedang terjadi — bukan pesan "Working" yang buta.
import { routeChat } from './pool.js';
import { toolDefinitions, executeTool, normalizeMode } from './tools.js';
import * as hooks from './hooks.js';

const MAX_TURNS = 12;
const MAX_TOOL_CALLS_PER_TURN = 8;

function abortError() {
  const e = new Error('Run dihentikan');
  e.name = 'AbortError';
  return e;
}

function raceAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Instruksi mode ditulis sebagai pesan system, bukan disisipkan ke pesan user:
// pesan user adalah isi percakapan yang dilihat pengguna dan dikirim ulang tiap
// turn, sedangkan aturan mode boleh berubah tanpa mengubah riwayat.
const MODE_HINT = {
  plan: 'Mode plan: kamu boleh membaca berkas dan mencari, tetapi TIDAK boleh mengubah berkas atau menjalankan perintah. Susun rencana, sebutkan berkas yang akan diubah, lalu berhenti.',
  build: 'Mode build: kamu boleh membaca berkas; menulis berkas atau menjalankan perintah memerlukan persetujuan pengguna dan akan gagal bila tidak ada. Jelaskan rencana sebelum bertindak.',
  edit: 'Mode edit: kamu boleh membaca dan mengubah berkas di folder kerja. Perintah shell memerlukan persetujuan.',
  guarded: 'Mode guarded: kamu boleh membaca, mengubah berkas, dan menjalankan perintah; perintah berbahaya akan meminta persetujuan.',
  yolo: 'Mode yolo: kamu boleh membaca, mengubah berkas, dan menjalankan perintah tanpa persetujuan. Berhati-hatilah dan verifikasi hasilnya.',
};

const TOOL_HINT = 'Kamu punya tool. Panggil tool saat butuh data nyata dari folder kerja — jangan menebak isi berkas. Setelah selesai, jawab dalam bahasa pengguna.';

function parseCalls(message) {
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return raw.slice(0, MAX_TOOL_CALLS_PER_TURN).map((call, index) => {
    let args = {};
    try {
      const text = call.function?.arguments;
      args = typeof text === 'string' ? (text.trim() ? JSON.parse(text) : {}) : (text || {});
    } catch { args = {}; }
    return {
      id: call.id || `call_${Date.now()}_${index}`,
      name: String(call.function?.name || ''),
      args,
      rawArguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}),
    };
  }).filter((c) => c.name);
}

// Ringkas pemanggilan tool untuk ditampilkan di UI tanpa membocorkan isi berkas
// besar: satu baris per tool, argumen penting saja.
export function describeCall(call) {
  const a = call.args || {};
  if (a.path) return `${call.name} ${a.path}`;
  if (a.command) return `${call.name} ${String(a.command).slice(0, 100)}`;
  if (a.pattern) return `${call.name} /${String(a.pattern).slice(0, 60)}/`;
  return call.name;
}

export async function runAgentLoop({
  prompt,
  history = [],
  model = 'auto',
  cwd = null,
  mode = 'yolo',
  signal = null,
  onDelta = null,
  onEvent = null,
  systemPrompt = null,
  replyLang = null,
  maxTurns = MAX_TURNS,
  withReplyLanguage = (text) => text,
} = {}) {
  const normalized = normalizeMode(mode);
  const messages = [];
  const system = [
    TOOL_HINT,
    MODE_HINT[normalized] || MODE_HINT.yolo,
    systemPrompt || '',
  ].filter(Boolean).join('\n\n');
  messages.push({ role: 'system', content: system });
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.subrun || m.status === 'working') continue;
    if (m.runStatus && m.runStatus !== 'done') continue;
    const content = String(m.modelContent || m.content || '').trim();
    if (content) messages.push({ role: m.role, content });
  }
  messages.push({ role: 'user', content: withReplyLanguage(String(prompt || '')) });

  const tools = await toolDefinitions({ cwd, mode: normalized });
  const ctx = { cwd, mode: normalized, signal, onEvent };

  // SessionStart dijalankan sekali per run, seperti ZCode: hook bisa menyiapkan
  // lingkungan atau menyuntikkan konteks awal.
  let startContext = null;
  try {
    const start = await hooks.runEvent('SessionStart', { source: 'studio', cwd, mode: normalized }, { cwd });
    startContext = start.additionalContext || null;
    if (startContext) messages[0].content += `\n\n[konteks tambahan dari hook]\n${startContext}`;
  } catch { /* hook rusak tidak boleh menggagalkan run */ }

  let text = '';
  let turns = 0;
  let tokens = 0;
  let usage = null;
  let servedBy = null;
  let usedModel = model;
  const toolLog = [];

  while (turns < maxTurns) {
    if (signal?.aborted) throw abortError();
    turns++;
    const payload = { model, messages };
    if (tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    const r = await raceAbort(routeChat(payload), signal);
    if (signal?.aborted) throw abortError();
    if (r.type === 'error') {
      throw new Error('Gateway Pool gagal: ' + JSON.stringify(r.attempts || []).slice(0, 300));
    }
    servedBy = r.servedBy || servedBy;
    usedModel = r.model || usedModel;

    let message = null;
    if (r.type === 'json') {
      try { message = JSON.parse(r.body)?.choices?.[0]?.message || null; } catch { message = null; }
      if (!message) {
        // Provider mengembalikan bentuk tak terduga: jangan buang isinya,
        // tampilkan sebagai teks apa adanya supaya pengguna tahu.
        const body = String(r.body || '').slice(0, 2000);
        text += body;
        onDelta?.(body);
        break;
      }
      const u = JSON.parse(r.body)?.usage;
      if (u) {
        usage = u;
        tokens += Number(u.total_tokens) || 0;
      }
    } else {
      const body = await raceAbort(new Response(r.webStream).text(), signal);
      for (const block of String(body).split(/\n\n+/)) {
        const data = block.split(/\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) { message = message || { role: 'assistant', content: '' }; message.content = (message.content || '') + delta.content; }
          if (delta?.tool_calls) {
            message = message || { role: 'assistant', content: '' };
            message.tool_calls = message.tool_calls || [];
            for (const part of delta.tool_calls) {
              const idx = part.index ?? 0;
              message.tool_calls[idx] = message.tool_calls[idx] || { id: part.id, type: 'function', function: { name: '', arguments: '' } };
              if (part.id) message.tool_calls[idx].id = part.id;
              if (part.function?.name) message.tool_calls[idx].function.name += part.function.name;
              if (part.function?.arguments) message.tool_calls[idx].function.arguments += part.function.arguments;
            }
          }
        } catch { /* event rusak diabaikan */ }
      }
      message = message || { role: 'assistant', content: '' };
    }

    const content = String(message.content || '');
    const calls = parseCalls(message);
    if (content) { text += content; onDelta?.(content); }

    if (!calls.length) break;

    // Pesan assistant dengan tool_calls wajib disimpan apa adanya: provider
    // menuntut id tool_call yang sama muncul di pesan tool berikutnya.
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } })),
    });
    onEvent?.({ type: 'tools', names: calls.map(describeCall) });

    for (const call of calls) {
      if (signal?.aborted) throw abortError();
      const result = await executeTool(call.name, call.args, ctx);
      toolLog.push({ name: call.name, args: call.args, ok: result.ok, decision: result.decision });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.text || '').slice(0, 20000) });
    }
  }

  if (turns >= maxTurns && !text.trim()) {
    text = `Berhenti setelah ${maxTurns} putaran tool tanpa jawaban akhir. Coba perjelas permintaan atau kurangi cakupannya.`;
    onDelta?.(text);
  }

  try { await hooks.runEvent('Stop', { cwd, mode: normalized, turns }, { cwd }); } catch { /* diagnosa saja */ }

  return { text, turns, tokens: tokens || null, usage, servedBy, model: usedModel, tools: toolLog };
}
