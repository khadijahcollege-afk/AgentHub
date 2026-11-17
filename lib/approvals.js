// lib/approvals.js — jembatan antara keputusan izin `ask` dan manusia.
//
// Sebelum modul ini, `ask` berarti "tidak ada klien persetujuan", jadi mode
// build menolak setiap tulisan dan mode edit menolak setiap perintah. Model
// mencoba, ditolak, lalu mencoba cara lain — pengguna melihat agent yang
// tampak bodoh padahal gerbangnya yang menutup. Sekarang `ask` benar-benar
// menunggu: run berhenti di tool itu, UI menampilkan pertanyaan, dan keputusan
// pengguna menentukan kelanjutannya.
//
// Tiga aturan yang dipegang:
//   • Fail closed. Tanpa klien (delegate, CLI headless, tes) `ask` tetap
//     ditolak dengan alasan yang jelas — tidak ada penantian tanpa batas.
//   • Selalu ada batas waktu. Permintaan yang tidak dijawab harus melepas run;
//     promise yang menggantung akan menahan thread "running" selamanya.
//   • Pembatalan melepas. Run yang dihentikan, tab yang ditutup, atau server
//     yang dimatikan harus menyelesaikan permintaan yang menunggu — kalau
//     tidak, memori tumbuh dan tool tidak pernah kembali.
import { newId, readJson, writeJson } from './store.js';

// Batas waktu berbeda karena sifat keputusannya berbeda: izin adalah keputusan
// cepat (satu klik), pertanyaan butuh waktu membaca dan menimbang.
export const PERMISSION_TIMEOUT_MS = 180000;
export const QUESTION_TIMEOUT_MS = 600000;
// Rencana lebih lama lagi: pengguna harus membaca dokumen sebelum menyetujui
// perubahan multi-berkas. Batas yang terlalu pendek membuat kartu paling penting
// kedaluwarsa tepat saat sedang dibaca.
export const PLAN_TIMEOUT_MS = 900000;

// requestId -> { threadId, kind, payload, resolve, timer, createdAt, settled }
const pending = new Map();

// Aturan "selalu bolehkan di folder ini" disimpan per folder kerja, bukan per
// proyek: proyek bisa berisi beberapa folder, dan izin menulis di satu repo
// tidak boleh diam-diam berlaku di repo lain.
export const RULES_FILE = 'permissions.json';

function ruleKey(cwd) {
  const key = String(cwd || '').trim();
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function readRules() {
  const data = readJson(RULES_FILE, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function allowedByRule(cwd, tool) {
  if (!cwd || !tool) return false;
  const bucket = readRules()[ruleKey(cwd)];
  return !!(bucket && bucket.allow && bucket.allow[tool]);
}

// Hanya tool tulis berkas yang boleh diingat. "Selalu bolehkan run_command"
// sama saja dengan memindahkan mode ke yolo lewat satu klik, dan satu perintah
// yang tampak jinak (`npm test`) tidak menjamin perintah berikutnya jinak.
export function canRemember(tool) {
  return ['write_file', 'edit_file', 'delete_file'].includes(String(tool || ''));
}

export function addRule(cwd, tool) {
  const key = ruleKey(cwd);
  if (!key || !canRemember(tool)) return false;
  const all = readRules();
  const bucket = all[key] && typeof all[key] === 'object' ? all[key] : {};
  const allow = bucket.allow && typeof bucket.allow === 'object' ? bucket.allow : {};
  allow[tool] = true;
  all[key] = { ...bucket, allow };
  writeJson(RULES_FILE, all);
  return true;
}

export function listRules() {
  return readRules();
}

export function clearRules(cwd) {
  const all = readRules();
  const key = ruleKey(cwd);
  if (!key || !all[key]) return false;
  delete all[key];
  writeJson(RULES_FILE, all);
  return true;
}

function settle(requestId, result) {
  const entry = pending.get(requestId);
  if (!entry) return { ok: false, code: 'NOT_PENDING', error: 'Permintaan itu sudah tidak menunggu jawaban' };
  pending.delete(requestId);
  clearTimeout(entry.timer);
  try { entry.removeAbort?.(); } catch { /* signal sudah lepas */ }
  entry.settled = true;
  entry.resolve(result);
  return { ok: true };
}

// Daftar permintaan yang menunggu di satu thread. Dipakai UI saat halaman
// dimuat ulang: tanpa ini, kartu pertanyaan hilang saat refresh dan run tetap
// menunggu sampai batas waktunya habis.
export function list(threadId) {
  return [...pending.values()]
    .filter((e) => e.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => ({ ...e.payload, requestId: e.requestId, createdAt: e.createdAt, expiresAt: e.expiresAt }));
}

export function pendingCount() {
  return pending.size;
}

// Lepas semua permintaan milik satu thread. Dipanggil saat run dihentikan atau
// thread dihapus, supaya tidak ada tool yang menunggu jawaban yang tak akan
// pernah datang.
export function cancelThread(threadId, reason = 'Run dihentikan sebelum dijawab') {
  const ids = [...pending.values()].filter((e) => e.threadId === threadId).map((e) => e.requestId);
  for (const id of ids) settle(id, { decision: 'deny', reason, cancelled: true });
  return ids.length;
}

export function cancelAll(reason = 'Server berhenti') {
  const ids = [...pending.keys()];
  for (const id of ids) settle(id, { decision: 'deny', reason, cancelled: true });
  return ids.length;
}

// Jawaban dari klien. `decision` sah berbeda per jenis permintaan; menerima
// nilai lain akan membuat tool berjalan dengan keputusan yang tidak ia mengerti.
export function resolve(threadId, requestId, input = {}) {
  const entry = pending.get(requestId);
  if (!entry) return { ok: false, status: 404, code: 'NOT_PENDING', error: 'Permintaan tidak ditemukan atau sudah dijawab' };
  if (entry.threadId !== threadId) {
    return { ok: false, status: 403, code: 'WRONG_THREAD', error: 'Permintaan itu milik thread lain' };
  }
  const decision = String(input.decision || '');

  // Rencana: keputusannya `approve`/`reject`, bukan allow/deny. Menyetujui
  // rencana berarti membuka kemampuan menulis untuk sisa run, jadi ia tidak
  // boleh berbagi bentuk dengan izin satu pemanggilan tool.
  if (entry.kind === 'plan') {
    if (!['approve', 'reject'].includes(decision)) {
      return { ok: false, status: 400, code: 'BAD_DECISION', error: 'decision harus "approve" atau "reject"' };
    }
    settle(requestId, { decision, reason: String(input.reason || '').slice(0, 500) || null });
    return { ok: true, decision };
  }

  if (entry.kind === 'permission') {
    if (!['allow', 'deny'].includes(decision)) {
      return { ok: false, status: 400, code: 'BAD_DECISION', error: 'decision harus "allow" atau "deny"' };
    }
    if (decision === 'allow' && input.always === true) {
      if (!canRemember(entry.payload.tool)) {
        return { ok: false, status: 400, code: 'CANNOT_REMEMBER', error: 'Izin itu tidak bisa diingat: hanya tool tulis berkas yang boleh selalu diizinkan' };
      }
      addRule(entry.payload.cwd, entry.payload.tool);
    }
    settle(requestId, { decision, reason: String(input.reason || '').slice(0, 300) || null });
    return { ok: true, decision };
  }

  if (!['answered', 'reject'].includes(decision)) {
    return { ok: false, status: 400, code: 'BAD_DECISION', error: 'decision harus "answered" atau "reject"' };
  }
  if (decision === 'reject') {
    settle(requestId, { decision: 'deny', reason: String(input.reason || '').slice(0, 300) || 'Pengguna menolak menjawab' });
    return { ok: true, decision };
  }
  const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
  const annotations = input.annotations && typeof input.annotations === 'object' && !Array.isArray(input.annotations) ? input.annotations : {};
  settle(requestId, { decision: 'answered', answers, annotations });
  return { ok: true, decision };
}

// Klien untuk satu run. `notify` mengirim payload ke UI (lewat SSE), dan
// promise yang dikembalikan selesai ketika `resolve()` dipanggil, batas waktu
// habis, atau run dibatalkan.
export function createClient({
  threadId,
  notify = null,
  signal = null,
  tag = null,
  permissionTimeoutMs = PERMISSION_TIMEOUT_MS,
  questionTimeoutMs = QUESTION_TIMEOUT_MS,
  planTimeoutMs = PLAN_TIMEOUT_MS,
} = {}) {
  const ask = (kind, payload, timeoutMs, extraTag = null) => new Promise((resolvePromise) => {
    const requestId = newId();
    const createdAt = Date.now();
    const expiresAt = createdAt + timeoutMs;
    const marks = { ...(tag || {}), ...(extraTag || {}) };
    const entry = {
      requestId,
      threadId,
      kind,
      createdAt,
      expiresAt,
      payload: {
        kind,
        ...payload,
        ...(marks.subagent ? { subagent: marks.subagent, agentId: marks.agentId || null } : {}),
      },
      resolve: resolvePromise,
      timer: null,
      removeAbort: null,
      settled: false,
    };

    entry.timer = setTimeout(() => {
      settle(requestId, {
        decision: 'deny',
        reason: `Tidak dijawab dalam ${Math.round(timeoutMs / 1000)} detik`,
        timedOut: true,
      });
    }, timeoutMs);

    if (signal) {
      const onAbort = () => settle(requestId, { decision: 'deny', reason: 'Run dihentikan', cancelled: true });
      // Signal yang sudah dibatalkan sebelum permintaan dibuat: janji harus
      // langsung selesai. `settle` tidak bisa dipakai di sini karena entri belum
      // masuk registry — memanggilnya hanya menghasilkan NOT_PENDING dan tool
      // menunggu sampai batas waktunya habis.
      if (signal.aborted) {
        clearTimeout(entry.timer);
        resolvePromise({ decision: 'deny', reason: 'Run dihentikan', cancelled: true });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.removeAbort = () => signal.removeEventListener('abort', onAbort);
    }

    pending.set(requestId, entry);
    try { notify?.({ ...entry.payload, requestId, createdAt, expiresAt }); } catch { /* UI putus */ }
  });

  const client = {
    threadId,
    // Izin untuk tool yang sudah diputuskan `ask`.
    askPermission: ({ tool, input, reason, mode, cwd, risk }) => ask('permission', { tool, input, reason, mode, cwd, risk }, permissionTimeoutMs),
    // Pertanyaan dari `AskUserQuestion`. Bentuknya sama dengan izin: run berhenti
    // di sini sampai manusia menjawab.
    askQuestion: ({ tool, questions }) => ask('question', { tool, questions }, questionTimeoutMs),
    // Rencana dari `ExitPlanMode`. Payload-nya membawa teks rencana itu sendiri
    // supaya kartunya bisa dibaca dan dinilai — bukan sekadar nama tool.
    askPlan: ({ plan, allowedPrompts = [], cwd }) => ask('plan', { plan, allowedPrompts, cwd }, planTimeoutMs),
    list: () => list(threadId),
    cancel: (reason) => cancelThread(threadId, reason),
    // Klien turunan untuk subagent: permintaan tetap masuk ke registry thread
    // yang sama, tetapi membawa nama agent sehingga kartunya bisa dicocokkan
    // dengan baris subagent di UI. Tanpa ini dua pertanyaan dari dua agent
    // tampak identik dan pengguna tidak tahu siapa yang menunggu.
    //
    // `askPlan` sengaja TIDAK diwariskan: persetujuan rencana membuka
    // kemampuan menulis untuk sisa run, dan anak tidak boleh menaikkan
    // izinnya sendiri lewat persetujuan yang ditujukan untuk induk. Anak yang
    // memanggil `ExitPlanMode` mendapat jalur tanpa-klien dan tetap di plan.
    forSubagent: ({ subagent, agentId }) => ({
      threadId,
      askPermission: (p) => ask('permission', p, permissionTimeoutMs, { subagent, agentId }),
      askQuestion: ({ tool, questions }) => ask('question', { tool, questions }, questionTimeoutMs, { subagent, agentId }),
      list: () => list(threadId),
      cancel: (reason) => cancelThread(threadId, reason),
      forSubagent: () => null,
    }),
  };
  return client;
}
