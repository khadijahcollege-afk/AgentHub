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
import { runSubagent, AGENT_TOOL } from './subagents.js';
import { summaryBlock } from './compact.js';
import { planReminder } from './plan.js';
import * as hooks from './hooks.js';

const MAX_TURNS = 12;
const MAX_TOOL_CALLS_PER_TURN = 8;
// Batas subagent per run. Tanpa batas, model bisa memecah satu tugas menjadi
// puluhan Agent dan setiap satu adalah percakapan model penuh — biaya nyata
// yang tidak terlihat oleh pengguna sampai kuota pool habis.
const MAX_SUBAGENTS_PER_RUN = 4;

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
  // `Agent` tidak punya path atau perintah: yang berguna dilihat pengguna adalah
  // tugasnya, bukan prompt panjangnya.
  if (call.name === AGENT_TOOL) {
    const type = a.subagent_type ? `${a.subagent_type}: ` : '';
    return `${AGENT_TOOL} ${type}${String(a.description || '').slice(0, 60)}`.trim();
  }
  if (a.path) return `${call.name} ${a.path}`;
  if (a.command) return `${call.name} ${String(a.command).slice(0, 100)}`;
  if (a.pattern) return `${call.name} /${String(a.pattern).slice(0, 60)}/`;
  return call.name;
}

export async function runAgentLoop({
  prompt,
  history = [],
  compact = null,
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
  // Dipakai oleh subagent: anak tidak boleh menawarkan `Agent` lagi, dan
  // profilnya boleh mempersempit daftar tool sebelum model melihatnya.
  allowSubagents = true,
  toolPolicy = null,
  roleHint = null,
  // Subagent punya siklus hidup sendiri (SubagentStart/SubagentStop). SessionStart
  // dan Stop milik run induk, jadi anak tidak boleh memicunya dua kali.
  skipLifecycleHooks = false,
  subagentBudget = null,
  // Klien persetujuan (lib/approvals.js): `ask` berhenti dan bertanya di sini,
  // bukan ditolak. Anak mewarisi klien induk supaya pertanyaannya juga sampai
  // ke orang yang sama — tetapi ditandai, agar UI bisa menunjukkan agent mana
  // yang bertanya.
  approvals = null,
  // Status plan mode milik run ini (lib/plan.js). Dibuat di sini bila
  // pemanggil tidak memberikannya, dan dipakai bersama `executeTool` supaya
  // `ExitPlanMode` bisa mengubah mode yang berlaku untuk gerbang tool
  // berikutnya. Tanpa objek bersama, persetujuan rencana hanya mengubah teks
  // yang dibaca model — bukan izin yang benar-benar ditegakkan.
  planRuntime = null,
  // Mentah-mentah dipakai server untuk menyimpan rencana ke berkas.
  threadId = null,
} = {}) {
  const normalized = normalizeMode(mode);
  const plan = planRuntime || {
    active: normalized === 'plan',
    pre: normalized === 'plan' ? 'build' : normalized,
    mode: normalized,
    approved: false,
    plan: null,
    planFile: null,
    planFileRel: null,
    threadId,
  };
  if (threadId && !plan.threadId) plan.threadId = threadId;
  const messages = [];
  // Bagian system disimpan terpisah supaya bisa disusun ulang setiap turn:
  // mode bisa berubah di tengah run (EnterPlanMode/ExitPlanMode), dan
  // instruksi mode yang basi membuat model mencoba hal yang gerbangnya sudah
  // menutup — atau tidak mencoba hal yang kini diizinkan.
  const systemParts = {
    role: roleHint || TOOL_HINT,
    systemPrompt: systemPrompt || '',
    extra: '',
  };
  const buildSystem = (modeNow) => [
    systemParts.role,
    MODE_HINT[modeNow] || MODE_HINT.yolo,
    systemParts.systemPrompt,
    systemParts.extra,
  ].filter(Boolean).join('\n\n');
  messages.push({ role: 'system', content: buildSystem(normalized) });
  // Ringkasan percakapan lama masuk sebagai giliran user pertama: ia konteks
  // yang paling tua, dan provider tidak menerima pesan system kedua di tengah.
  // Tanpa ini, loop hanya melihat 12 pesan terakhir dan mengulangi keputusan
  // yang sudah dibuat di awal thread.
  const summary = summaryBlock(compact);
  if (summary) messages.push({ role: 'user', content: summary, compacted: true });
  // Rencana yang sudah disetujui dicantumkan lagi di sini. Ringkasan konteks
  // membuang pesan lama — termasuk pesan yang memuat rencana — jadi tanpa
  // pengingat ini model bisa menyusun ulang rencana yang berbeda dari yang
  // sudah disepakati, atau lupa bahwa ia sudah boleh menulis.
  const reminder = planReminder({ cwd, threadId, approved: !!plan.approved });
  if (reminder) messages.push({ role: 'user', content: `[berkas rencana]\n${reminder}`, compacted: true });
  const throughId = compact?.throughMessageId || null;
  const fromIdx = throughId ? history.findIndex((m) => m?.id === throughId) : -1;
  const freshHistory = fromIdx >= 0 ? history.slice(fromIdx + 1) : history;
  for (const m of freshHistory) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.subrun || m.status === 'working') continue;
    if (m.runStatus && m.runStatus !== 'done') continue;
    const content = String(m.modelContent || m.content || '').trim();
    if (content) messages.push({ role: m.role, content });
  }
  messages.push({ role: 'user', content: withReplyLanguage(String(prompt || '')) });

  const tools = await toolDefinitions({ cwd, mode: normalized, allowSubagents, toolPolicy });
  let toolsMode = normalized;
  const ctx = { cwd, mode: normalized, signal, onEvent, client: approvals, planRuntime: plan };

  // SessionStart dijalankan sekali per run, seperti ZCode: hook bisa menyiapkan
  // lingkungan atau menyuntikkan konteks awal.
  if (!skipLifecycleHooks) {
    try {
      const start = await hooks.runEvent('SessionStart', { source: 'studio', cwd, mode: normalized }, { cwd });
      // Konteks hook masuk ke bagian system yang disusun ulang, bukan ditambahkan
      // langsung ke pesan system: penyusunan ulang per turn (karena mode bisa
      // berubah) akan menghapus tambahan itu di turn kedua.
      if (start.additionalContext) {
        systemParts.extra = `[konteks tambahan dari hook]\n${start.additionalContext}`;
        messages[0].content = buildSystem(plan.mode);
      }
    } catch { /* hook rusak tidak boleh menggagalkan run */ }
  }

  let text = '';
  // Teks langkah terakhir dipisah dari `text`: yang dibutuhkan subagent sebagai
  // laporan adalah kesimpulan di langkah akhir, bukan seluruh narasi perantara.
  let lastStep = '';
  let turns = 0;
  let tokens = 0;
  let usage = null;
  let servedBy = null;
  let usedModel = model;
  const toolLog = [];
  // Anggaran subagent dibagi ke seluruh run: model tidak bisa memanggil Agent
  // berkali-kali hanya karena setiap panggilan terlihat "baru" baginya.
  const budget = subagentBudget || { count: 0, max: MAX_SUBAGENTS_PER_RUN };

  while (turns < maxTurns) {
    if (signal?.aborted) throw abortError();
    turns++;
    // Mode bisa berubah di turn sebelumnya (ExitPlanMode disetujui). Instruksi
    // mode, daftar tool, dan gerbang izin harus membaca nilai TERKINI, bukan
    // nilai saat run dimulai.
    if (messages[0]?.role === 'system') messages[0].content = buildSystem(plan.mode);
    // Daftar tool ikut mode. Setelah rencana disetujui, tool tulis harus
    // MUNCUL kembali di daftar — kalau tidak, model tetap hanya melihat tool
    // baca dan menyimpulkan pekerjaannya tidak mungkin dilanjutkan, padahal
    // izinnya sudah ada.
    if (plan.mode !== toolsMode) {
      const next = await toolDefinitions({ cwd, mode: plan.mode, allowSubagents, toolPolicy });
      tools.splice(0, tools.length, ...next);
      toolsMode = plan.mode;
    }
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
    // Langkah terakhir yang berisi teks disimpan; kalau langkah ini hanya
    // berisi panggilan tool, nilainya tetap dari langkah sebelumnya.
    if (content.trim()) lastStep = content;

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
      // Mode SEBELUM panggilan ini: `executeTool` memutasi `planRuntime` secara
      // langsung, jadi membandingkan hasilnya dengan `plan.mode` setelah
      // panggilan selalu sama dan perubahannya tidak pernah dilaporkan ke UI.
      const modeBefore = plan.mode;
      const activeBefore = !!plan.active;
      // `Agent` bukan tool biasa: ia menjalankan loop model kedua di dalam loop
      // ini. Dikerjakan di sini, bukan di executeTool, karena runner subagent
      // butuh mode, model, dan anggaran milik run ini.
      const result = call.name === AGENT_TOOL
        ? await runSubagent({
          args: call.args,
          cwd,
          // Mode anak mengikuti mode TERKINI induk. Memakai `normalized`
          // (mode saat run dimulai) akan memberi anak izin plan saat induknya
          // sudah disetujui keluar — atau sebaliknya, menahannya di izin lama.
          mode: plan.mode,
          model,
          signal,
          onEvent,
          runner: runAgentLoop,
          depth: allowSubagents ? 0 : 1,
          budget,
          // Anak mewarisi klien yang sama: pertanyaan dan izinnya harus sampai
          // ke orang yang sama. Subagent juga tidak boleh lebih longgar dari
          // induk, jadi mewarisi klien tidak membuka izin tambahan.
          approvals,
        })
        : await executeTool(call.name, call.args, { ...ctx, mode: plan.mode });
      // `ExitPlanMode` yang disetujui mengubah mode lewat `planRuntime`. Tool
      // berikutnya di putaran yang sama sudah memakai mode itu karena `ctx`
      // dibuat ulang per panggilan. Perubahannya dilaporkan ke UI supaya chip
      // akses tidak terus menampilkan mode yang sudah ditinggalkan.
      if (plan.mode !== modeBefore || !!plan.active !== activeBefore) {
        onEvent?.({ type: 'mode', mode: plan.mode, planActive: !!plan.active });
      }
      toolLog.push({
        name: call.name,
        args: call.args,
        ok: result.ok,
        decision: result.decision,
        ...(result.meta ? { subagent: result.meta } : {}),
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.text || '').slice(0, 20000) });
    }
  }

  if (turns >= maxTurns && !text.trim()) {
    text = `Berhenti setelah ${maxTurns} putaran tool tanpa jawaban akhir. Coba perjelas permintaan atau kurangi cakupannya.`;
    onDelta?.(text);
  }

  if (!skipLifecycleHooks) {
    try { await hooks.runEvent('Stop', { cwd, mode: plan.mode, turns }, { cwd }); } catch { /* diagnosa saja */ }
  }

  return { text, lastStep, turns, tokens: tokens || null, usage, servedBy, model: usedModel, tools: toolLog, planMode: plan.mode, planApproved: !!plan.approved };
}
