// lib/hooks.js — hook siklus hidup agent (REA ZCode: hooks-runtime-contract).
//
// Kenapa hook, bukan sekadar pengaturan: beberapa hal memang harus dijalankan
// sebagai program di luar server — guard yang memeriksa perintah sebelum
// dijalankan, logger audit, penyuntik konteks dari sistem lain. Server AgentHub
// tidak boleh mengimpor kode semacam itu; ia hanya perlu memanggilnya di titik
// yang tepat dan menuruti jawabannya.
//
// Kontrak yang diikuti (sama seperti ZCode):
//   • sembilan event: SessionStart, UserPromptSubmit, PreToolUse,
//     PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart,
//     SubagentStop, Stop
//   • hook menerima satu objek JSON di stdin, boleh membalas satu objek JSON di stdout
//   • exit code 2 = memblokir; exit code lain = diagnostik, BUKAN blokir
//   • balasan `hookSpecificOutput.permissionDecision` = allow | ask | deny
//   • `updatedInput` mengganti argumen tool, `additionalContext` ditambahkan ke konteks
//   • matcher: daftar nama tool persis bila hanya berisi `A|B`, regex bila ada
//     sintaks regex lain
//
// Yang sengaja TIDAK dilakukan: hook tidak pernah dijalankan otomatis dari repo
// orang lain. Hook yang dideklarasikan di dalam folder kerja baru berjalan
// setelah pemilik workspace menyetujuinya (digest terikat isi deklarasi), karena
// hook adalah eksekusi kode arbitrer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { pluginHookEvents } from './plugins.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  // Siklus hidup subagent. Dipisah dari SessionStart/Stop karena anak bukan
  // run tersendiri: ia bagian dari satu run induk, dan hook yang menghitung
  // "berapa run" tidak boleh menghitungnya dua kali.
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

const FILE = 'hooks.json';
const TRUST_FILE = 'hooks-trust.json';
const PROJECT_DIR = '.agenthub';
const PROJECT_FILE = 'hooks.json';
const MAX_OUTPUT = 200000;
const MAX_HOOKS = 40;
const DEFAULT_TIMEOUT = 10000;

export class HookError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'HookError';
    this.statusCode = statusCode;
  }
}

// ---------- konfigurasi pengguna ----------
// Bentuk: { enabled, events: { PreToolUse: [ { matcher, hooks: [ {…} ] } ] } }
// Isi berkas ini bisa ditulis tangan, jadi ia dinormalisasi seperti deklarasi
// proyek: hook tanpa `timeoutMs` akan jatuh ke setTimeout(NaN) yang menyala
// seketika, sehingga hook seolah-olah "selalu habis waktu" dan tidak pernah
// benar-benar berjalan.
export function readConfig() {
  const data = readJson(FILE, null);
  const events = data && typeof data === 'object' && data.events && typeof data.events === 'object' ? data.events : {};
  return { enabled: data?.enabled === true, events: normalizeEvents(events) };
}

function cleanHook(input, existing = null) {
  const type = String(input?.type || existing?.type || 'command');
  if (!['command', 'process'].includes(type)) {
    throw new HookError(`Tipe hook "${type}" tidak dikenal (pakai command atau process)`);
  }
  const command = String(input?.command ?? existing?.command ?? '').trim();
  if (!command) throw new HookError('Hook memerlukan perintah (command)');
  if (command.length > 500) throw new HookError('Perintah hook terlalu panjang');
  const args = input?.args === undefined ? (existing?.args || []) : input.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new HookError('args hook harus berupa daftar string');
  }
  // `timeout` (detik) diterima sebagai alias lama; `timeoutMs` yang dipakai.
  const rawTimeout = input?.timeoutMs ?? (input?.timeout !== undefined ? Number(input.timeout) * 1000 : undefined);
  const timeoutMs = Math.min(120000, Math.max(1000, Number(rawTimeout ?? existing?.timeoutMs) || DEFAULT_TIMEOUT));
  return {
    type,
    command,
    args: args.slice(0, 32).map((a) => a.slice(0, 2000)),
    timeoutMs,
    // async hanya boleh untuk event yang tidak butuh jawaban (audit). Hook async
    // tidak bisa memblokir maupun mengubah input — itu batasan, bukan bug.
    async: input?.async === undefined ? (existing?.async ?? false) : !!input.async,
  };
}

export function sanitizeDeclaration(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HookError('Deklarasi hook harus berupa objek');
  }
  const matcher = input.matcher === undefined
    ? (existing?.matcher ?? '*')
    : String(input.matcher || '*').slice(0, 200);
  const hooks = input.hooks === undefined ? (existing?.hooks || []) : input.hooks;
  if (!Array.isArray(hooks) || !hooks.length) throw new HookError('Deklarasi hook memerlukan minimal satu hook');
  if (hooks.length > 10) throw new HookError('Maksimal 10 hook per deklarasi');
  return { matcher, hooks: hooks.map((h) => cleanHook(h)) };
}

export function listHooks() {
  const cfg = readConfig();
  return HOOK_EVENTS.map((event) => ({
    event,
    declarations: (cfg.events[event] || []).map((d, index) => ({ index, ...d })),
  }));
}

export function setEnabled(enabled) {
  const cfg = readConfig();
  writeJson(FILE, { enabled: !!enabled, events: cfg.events });
  return { enabled: !!enabled };
}

// Ganti seluruh deklarasi satu event. Menambah/menghapus per-indeks jauh lebih
// mudah salah daripada mengirim ulang daftar kecil yang sudah tervalidasi.
export function setEventHooks(event, declarations) {
  if (!HOOK_EVENTS.includes(event)) throw new HookError(`Event "${event}" tidak dikenal`);
  const cfg = readConfig();
  if (!Array.isArray(declarations)) throw new HookError('declarations harus berupa daftar');
  if (declarations.length > MAX_HOOKS) throw new HookError(`Maksimal ${MAX_HOOKS} deklarasi per event`);
  cfg.events[event] = declarations.map((d) => sanitizeDeclaration(d));
  writeJson(FILE, { enabled: cfg.enabled, events: cfg.events });
  return listHooks().find((x) => x.event === event);
}

// ---------- hook proyek + kepercayaan ----------
// Hook dari repo orang lain adalah kode yang akan dijalankan di mesin ini.
// Karena itu deklarasi proyek hanya dipakai bila digest-nya pernah disetujui.
export function projectFile(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  return path.join(cwd, PROJECT_DIR, PROJECT_FILE);
}

// Deklarasi proyek tidak melewati sanitizeServer karena ditulis di repo, bukan
// lewat API. Tetap harus dinormalisasi: hook tanpa `timeoutMs` akan jatuh ke
// setTimeout(NaN) yang menyala seketika, sehingga hook seolah tidak pernah jalan.
function normalizeEvents(events) {
  const out = {};
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(events?.[event])) continue;
    out[event] = events[event].slice(0, MAX_HOOKS).map((d) => {
      const hooks = Array.isArray(d?.hooks) ? d.hooks : [];
      return {
        matcher: typeof d?.matcher === 'string' ? d.matcher : '*',
        // `source` dipertahankan: hook dari plugin harus tetap bisa dibedakan
        // dari hook pengguna di hasil run, kalau tidak audit log menyesatkan.
        ...(typeof d?.source === 'string' ? { source: d.source } : {}),
        hooks: hooks.slice(0, 10).map((h) => ({
          type: h?.type === 'command' ? 'command' : 'process',
          command: String(h?.command || ''),
          args: Array.isArray(h?.args) ? h.args.filter((a) => typeof a === 'string') : [],
          timeoutMs: Math.min(120000, Math.max(1000, Number(h?.timeoutMs ?? (h?.timeout !== undefined ? Number(h.timeout) * 1000 : 0)) || DEFAULT_TIMEOUT)),
          async: h?.async === true,
        })).filter((h) => h.command),
      };
    }).filter((d) => d.hooks.length);
  }
  return out;
}

export function readProjectHooks(cwd) {
  const file = projectFile(cwd);
  if (!file) return { enabled: false, events: {}, present: false, error: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { enabled: false, events: {}, present: false, error: null }; }
  try {
    const data = JSON.parse(raw);
    return {
      enabled: data?.enabled === true || data?.enabled === undefined,
      events: normalizeEvents(data && typeof data.events === 'object' && data.events ? data.events : {}),
      present: true,
      error: null,
    };
  } catch (error) {
    // Deklarasi rusak bukan alasan menjalankan apa pun: fail closed.
    return { enabled: false, events: {}, present: true, error: `hooks.json proyek tidak valid: ${error.message}` };
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Digest terikat isi deklarasi: mengubah satu argumen membuat izin lama gugur.
export function trustDigest(events) {
  return crypto.createHash('sha256').update(canonical(events)).digest('hex');
}

function trustStore() {
  const data = readJson(TRUST_FILE, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function trustStatus(cwd) {
  const project = readProjectHooks(cwd);
  if (!project.present) return { present: false, trusted: false, digest: null, error: null };
  const digest = trustDigest(project.events);
  const granted = trustStore()[cwd] || null;
  return {
    present: true,
    trusted: !!granted && granted.digest === digest,
    digest,
    grantedAt: granted?.digest === digest ? granted.at : null,
    error: project.error,
  };
}

export function grantTrust(cwd, digest) {
  const status = trustStatus(cwd);
  if (!status.present) throw new HookError('Proyek ini tidak punya hook', 404);
  if (!digest || digest !== status.digest) {
    throw new HookError('Digest tidak cocok dengan deklarasi saat ini — tinjau ulang sebelum menyetujui');
  }
  const store = trustStore();
  store[cwd] = { digest, at: Date.now() };
  writeJson(TRUST_FILE, store);
  return trustStatus(cwd);
}

export function revokeTrust(cwd) {
  const store = trustStore();
  if (!store[cwd]) return false;
  delete store[cwd];
  writeJson(TRUST_FILE, store);
  return true;
}

// ---------- pencocokan ----------
// `Write|Edit` adalah daftar nama, bukan regex. Aturan ini penting: regex akan
// membuat "Edit" cocok dengan "EditMany", dan nama tool yang tidak dimaksud ikut
// terkena guard. Regex hanya dipakai bila memang ada sintaks regex lain.
export function matches(matcher, subject) {
  const pattern = String(matcher ?? '*').trim();
  if (!pattern || pattern === '*') return true;
  const bare = /^[A-Za-z0-9_.:-]+(\|[A-Za-z0-9_.:-]+)*$/.test(pattern);
  if (bare) return pattern.split('|').map((s) => s.trim()).includes(subject);
  try { return new RegExp(pattern).test(subject); } catch { return false; }
}

// ---------- eksekusi ----------
function runOne(hook, event, payload, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(hook.command, hook.args || [], {
        cwd: cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ hook, ok: false, blocked: false, error: `gagal dijalankan: ${error.message}`, ms: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hook, ms: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* sudah mati */ }
      finish({ ok: false, blocked: false, error: `melewati batas ${Math.round(hook.timeoutMs / 1000)} detik` });
    }, hook.timeoutMs);

    child.stdout?.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { if (stderr.length < 8000) stderr += d.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, blocked: false, error: `gagal dijalankan: ${error.message}` }));
    child.on('close', (code) => {
      // exit 2 = blokir tegas. Exit lain dengan stderr hanya diagnostik: hook
      // yang rusak tidak boleh diam-diam menghentikan semua tool.
      if (code === 2) {
        finish({ ok: false, blocked: true, error: stderr.trim() || 'diblokir hook', code });
        return;
      }
      let parsed = null;
      const text = stdout.trim();
      if (text) {
        try { parsed = JSON.parse(text); } catch {
          finish({ ok: false, blocked: false, error: 'keluaran hook bukan JSON', code });
          return;
        }
      }
      if (code !== 0) {
        finish({ ok: false, blocked: false, error: stderr.trim() || `keluar dengan kode ${code}`, code, output: parsed });
        return;
      }
      finish({ ok: true, blocked: false, output: parsed, code });
    });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch { /* proses sudah menutup stdin */ }
  });
}

// Jalankan semua hook untuk satu event. Mengembalikan hasil gabungan yang
// deterministik: deny menang atas ask, ask menang atas allow; updatedInput
// terakhir yang sah dipakai; additionalContext dijumlahkan.
export async function runEvent(event, payload = {}, { cwd = null } = {}) {
  if (!HOOK_EVENTS.includes(event)) throw new HookError(`Event "${event}" tidak dikenal`);
  const user = readConfig();
  const project = cwd ? readProjectHooks(cwd) : { enabled: false, events: {} };
  const trust = cwd ? trustStatus(cwd) : { trusted: false };

  const declarations = [];
  if (user.enabled) {
    for (const d of user.events[event] || []) declarations.push({ ...d, source: 'user' });
  }
  if (project.enabled && trust.trusted) {
    for (const d of project.events[event] || []) declarations.push({ ...d, source: 'project' });
  } else if (project.enabled && project.present && !trust.trusted) {
    // Tidak dijalankan, tetapi alasannya harus terlihat di UI — hook yang
    // "hilang" tanpa penjelasan adalah sumber kebingungan saat men-debug.
    declarations.push({ skipped: true, source: 'project', reason: 'hook proyek belum dipercaya' });
  }
  // Hook dari plugin hanya masuk bila pluginnya sendiri sudah dipercaya; modul
  // plugin sudah menyaring itu, jadi di sini tidak ada pemeriksaan kedua yang
  // bisa berbeda hasilnya. Tetap dinormalisasi: deklarasi yang tidak lewat
  // sanitizeServer (plugin, seperti hooks.json proyek) tidak punya `timeoutMs`,
  // sehingga setTimeout(NaN) menyala seketika dan hook seolah tidak pernah jalan.
  const fromPlugins = normalizeEvents(pluginHookEvents());
  for (const d of fromPlugins[event] || []) declarations.push({ ...d, source: d.source || 'plugin' });

  const subject = payload.tool_name || payload.toolName || payload.source || '';
  const results = [];
  let decision = 'allow';
  // Apakah ada hook yang benar-benar menjawab. Default `allow` berarti "tidak
  // menghalangi", bukan "saya mengizinkan": pemanggil yang butuh persetujuan
  // (PermissionRequest) tidak boleh memperlakukan diamnya hook sebagai izin.
  let answered = false;
  let reason = null;
  let updatedInput;
  const contexts = [];

  for (const d of declarations) {
    if (d.skipped) { results.push({ source: d.source, skipped: true, reason: d.reason }); continue; }
    if (!matches(d.matcher, subject)) continue;
    for (const hook of d.hooks || []) {
      // Hook async tidak boleh dipakai untuk keputusan: jalankan tanpa ditunggu
      // supaya audit log tidak memperlambat tiap tool.
      if (hook.async) {
        runOne(hook, event, { ...payload, hook_event_name: event, hookEventName: event }, cwd).catch(() => {});
        results.push({ source: d.source, command: hook.command, async: true });
        continue;
      }
      const r = await runOne(hook, event, {
        ...payload,
        hook_event_name: event,
        hookEventName: event,
        cwd: payload.cwd ?? cwd ?? null,
      }, cwd);
      const out = r.output?.hookSpecificOutput || {};
      const decided = out.permissionDecision || out.permission_decision || null;
      if (decided) answered = true;
      if (decided === 'deny') { decision = 'deny'; reason = out.permissionDecisionReason || out.permission_decision_reason || r.error || 'ditolak hook'; }
      else if (decided === 'ask' && decision !== 'deny') { decision = 'ask'; reason = out.permissionDecisionReason || out.permission_decision_reason || 'hook meminta persetujuan'; }
      if (out.updatedInput || out.updated_input) updatedInput = out.updatedInput || out.updated_input;
      if (out.additionalContext || out.additional_context) contexts.push(String(out.additionalContext || out.additional_context));
      // exit 2 juga merupakan jawaban tegas, bukan ketiadaan jawaban.
      if (r.blocked) { answered = true; decision = 'deny'; reason = r.error || 'diblokir hook (exit 2)'; }
      results.push({
        source: d.source,
        command: hook.command,
        ok: r.ok,
        blocked: !!r.blocked,
        decision: decided,
        error: r.error || null,
        ms: r.ms,
      });
    }
  }

  return {
    event,
    decision,
    // `answered` membedakan "hook menyetujui" dari "tidak ada hook yang berlaku".
    answered,
    denied: decision === 'deny',
    reason,
    updatedInput,
    additionalContext: contexts.length ? contexts.join('\n\n') : null,
    results,
  };
}

// Ringkasan untuk UI: apa yang aktif, dari mana, dan berapa yang belum dipercaya.
export function summary(cwd) {
  const user = readConfig();
  const project = cwd ? readProjectHooks(cwd) : { present: false, events: {}, enabled: false, error: null };
  const status = cwd ? trustStatus(cwd) : { trusted: false, digest: null };
  const count = (events) => HOOK_EVENTS.reduce((acc, e) => acc + (events[e] || []).reduce((n, d) => n + (d.hooks?.length || 0), 0), 0);  return {
    enabled: user.enabled,
    userHooks: count(user.events),
    project: {
      present: !!project.present,
      trusted: !!status.trusted,
      hooks: project.present ? count(project.events) : 0,
      digest: status.digest,
      error: project.error || null,
    },
    events: HOOK_EVENTS,
  };
}
