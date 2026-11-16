// Engine registry: agent "harness" yang bisa dikendarai Studio.
//  - pool   : LLM via Gateway Pool (token gratis, OpenAI-compatible)
//  - cli    : CLI agent yang terpasang (claude, codex, opencode, gemini, …)
// Konfigurasi harness bisa di-override lewat data/harnesses.json
// (array: [{id, label, cmd, args:[…, "{prompt}"]}]). {prompt} diganti isi pesan.
import { spawn, execFileSync } from 'node:child_process';
import { augmentWithSkills } from './skills.js';
import { withReplyLanguage } from './lang.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { poolStatus, routeChat } from './pool.js';
import { parseFreeModels, freeModelEngine } from './free-models.js';

const DEFAULT_ENGINES = [
  { id: 'pool', label: 'Free tokens (Gateway)', type: 'pool' },
  { id: 'claude',   label: 'Claude Code', type: 'cli', cmd: 'claude',   args: ['-p', '--output-format', 'text'], stdin: true },
  { id: 'codex',    label: 'Codex',      type: 'cli', cmd: 'codex',    args: ['exec', '{prompt}'] },
  { id: 'opencode', label: 'OpenCode',   type: 'cli', cmd: 'opencode', args: ['run', '{prompt}'] },
  { id: 'opencode-free', label: 'OpenCode · Big Pickle (gratis)', type: 'cli', cmd: 'opencode', args: ['run', '--pure', '--model', 'opencode/big-pickle', '--auto'], stdin: true, optIn: true },
  { id: 'gemini',   label: 'Gemini CLI', type: 'cli', cmd: 'gemini',   args: ['-p'], stdin: true },
];

const RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit per run CLI

// Batas konteks percakapan yang dikirim ke gateway. Tanpa batas, thread panjang
// akan gagal di provider karena melebihi context window — dan biayanya naik
// tanpa manfaat karena pesan paling lama biasanya sudah tidak relevan.
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 12000;

// Kutip satu argumen untuk command line Windows sesuai aturan MSVC C runtime —
// aturan yang dipakai Node/Python/CLI lain saat mengurai argv mereka sendiri.
//
// Kenapa bukan `"…"` + `""`: menggandakan tanda kutip di dalamnya hanya benar
// untuk cmd.exe, bukan untuk parser argv programnya. Hasilnya prompt seperti
// `katakan "halo"` sampai ke CLI sebagai potongan berisi kutip harfiah.
export function winArg(value) {
  const s = String(value);
  if (s !== '' && !/[\s"&|<>^]/.test(s)) return s;
  // Backslash hanya perlu digandakan bila tepat sebelum tanda kutip penutup.
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

function usableHistory(history) {
  const list = Array.isArray(history) ? history : [];
  const picked = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 0 && picked.length < MAX_HISTORY_MESSAGES; i--) {
    const m = list[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    // subrun delegation, pesan yang masih streaming, dan pesan error bukan
    // konteks yang layak dikirim ulang ke model.
    if (m.subrun || m.status === 'working') continue;
    if (m.runStatus && m.runStatus !== 'done') continue;
    const content = String(m.modelContent || m.content || '').trim();
    if (!content) continue;
    const room = MAX_HISTORY_CHARS - chars;
    if (room <= 0) break;
    // Pesan tertua dipotong dari depan: bagian terbarunya yang paling relevan.
    const kept = content.length > room ? content.slice(-room) : content;
    picked.push({ role: m.role, content: kept });
    chars += kept.length;
  }
  return picked.reverse();
}

// Susun messages OpenAI-compatible: riwayat (bila ada) + pesan baru.
// Diekspor agar bisa diuji tanpa memanggil jaringan.
export function buildPoolMessages(history, prompt) {
  return [...usableHistory(history), { role: 'user', content: String(prompt || '') }];
}

function abortError() {
  const e = new Error('Run dihentikan');
  e.name = 'AbortError';
  return e;
}

// Balapan promise dengan AbortSignal tanpa membocorkan listener.
function raceAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function overrides() {
  return readJson('harnesses.json', null);
}

function engineList() {
  const over = overrides() || [];
  const cli = DEFAULT_ENGINES.filter((e) => e.type === 'cli').map((e) => {
    const o = over.find((x) => x.id === e.id);
    return o ? { ...e, cmd: o.cmd || e.cmd, args: Array.isArray(o.args) ? o.args : e.args, label: o.label || e.label } : e;
  });
  // engine tambahan dari override yang tidak menimpa default (mis. echo untuk tes)
  const extra = over.filter((x) => x.cmd && !cli.some((e) => e.id === x.id));
  const discovered = readJson('opencode-free-models.json', { models: [] }).models || [];
  const free = discovered.map(freeModelEngine).filter(e => !cli.some(x => x.id === e.id) && !extra.some(x => x.id === e.id));
  return [DEFAULT_ENGINES[0], ...cli, ...extra, ...free];
}

let catalogRequest;
async function refreshFreeModels() {
  const cached = readJson('opencode-free-models.json', {});
  if (cached.version === 2 && Date.now() - (cached.checkedAt || 0) < 60 * 60 * 1000) return;
  if (catalogRequest) return catalogRequest;
  catalogRequest = new Promise(resolve => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'cmd.exe' : 'opencode', win
      ? ['/d', '/s', '/c', 'opencode models opencode --verbose --pure']
      : ['models', 'opencode', '--verbose', '--pure'], { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(); }, 15000);
    child.stdout.on('data', chunk => { if (output.length < 2000000) output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) writeJson('opencode-free-models.json', { version: 2, checkedAt: Date.now(), models: parseFreeModels(output) });
      resolve();
    });
  }).finally(() => { catalogRequest = null; });
  return catalogRequest;
}

// deteksi ketersediaan CLI (cache 60 detik)
let availCache = { ts: 0, map: {} };

function checkCmd(cmd) {
  return new Promise((resolve) => {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const p = spawn(tool, [cmd], { windowsHide: true });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// ---------- resolusi executable nyata (Windows) ----------
// Di Windows, perintah seperti `claude` adalah shim .cmd buatan npm yang
// meneruskan ke program sungguhan. Dua alasan lebih baik memanggil program itu
// langsung daripada lewat cmd.exe:
//   1. cmd.exe memotong prompt pada baris baru dan membatasi command line
//      8191 karakter. Dengan katalog skill + instruksi bahasa, prompt normal
//      sudah ~6.700 karakter — prompt panjang langsung melewati batas.
//   2. Batch mem-parsing ulang argumen, jadi tanda kutip dan `&` di dalam
//      prompt bisa berubah arti.
// Spawn langsung ke .exe/.js tidak punya masalah itu sama sekali. Kalau
// resolusi gagal, jalur cmd.exe tetap dipakai (dengan pengutipan yang benar).
let shimCache = new Map();

function whichSync(cmd) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(tool, [cmd], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Baca shim .cmd/.bat npm dan ambil target sebenarnya (baris yang memakai %*).
// Mengembalikan { cmd, prefix } — prefix adalah argumen tetap yang harus
// didahulukan (mis. path skrip .js saat dijalankan lewat node).
export function resolveShim(shimPath) {
  let text;
  try { text = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/).filter((l) => l.includes('%*'));
  if (!lines.length) return null;
  const dir = path.dirname(shimPath);
  const line = lines[lines.length - 1]
    .replace(/%dp0%/gi, dir + path.sep)
    .replace(/%~dp0/gi, dir + path.sep);
  const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const existing = [];
  for (const cand of quoted) {
    if (cand.startsWith('%')) continue;           // variabel, bukan path
    try { if (fs.statSync(cand).isFile()) existing.push(cand); } catch { /* lewati */ }
  }
  if (!existing.length) return null;
  const first = existing[0];
  // Skrip JS: jalankan lewat node supaya tidak bergantung asosiasi .js
  if (/\.(c?js|mjs)$/i.test(first)) return { cmd: process.execPath, prefix: [first] };
  // `"node.exe" "skrip.js" %*` — node-nya eksplisit, skrip jadi argumen pertama
  if (/^node(\.exe)?$/i.test(path.basename(first)) && existing.length > 1) {
    return { cmd: first, prefix: existing.slice(1) };
  }
  return { cmd: first, prefix: [] };
}

function realCommand(cmd) {
  if (process.platform !== 'win32') return { cmd, prefix: [] };
  if (shimCache.has(cmd)) return shimCache.get(cmd);
  let result = { cmd, prefix: [] };

  // `cmd` bisa berupa nama polos (`claude`) atau path shim lengkap
  // (`C:\…\fakecli.cmd`, seperti di harness.json buatan user). `where` hanya
  // mencari nama polos, jadi path langsung diperiksa tanpa `where`.
  const hasSep = /[\\/]/.test(cmd);
  const shimPath = hasSep && /\.(cmd|bat)$/i.test(cmd) ? cmd : null;
  if (shimPath) {
    const hit = resolveShim(shimPath);
    if (hit) result = hit;
  } else {
    const found = hasSep ? [cmd] : whichSync(cmd);
    const shim = found.find((p) => /\.(cmd|bat)$/i.test(p));
    if (shim) {
      const hit = resolveShim(shim);
      if (hit) result = hit;
    } else {
      const exe = found.find((p) => /\.exe$/i.test(p));
      if (exe) result = { cmd: exe, prefix: [] };
    }
  }
  shimCache.set(cmd, result);
  return result;
}

export async function listEngines(force = false) {
  if (force || Date.now() - availCache.ts > 60000) {
    await refreshFreeModels();
    const entries = await Promise.all(
      engineList().map(async (e) => {
        if (e.type === 'pool') {
          const st = poolStatus();
          // Pool "tersedia" bila punya anggota kandidat — gateway memang mencoba
          // anggota berstatus error/unknown juga. Yang hanya valid = "siap".
          return {
            ...e,
            available: st.total > 0,
            note: st.active ? `${st.active} provider siap`
              : st.total ? `${st.total} provider masuk pool — belum terverifikasi`
              : 'pool kosong — tambah key',
          };
        }
        const ok = await checkCmd(e.cmd);
        return { ...e, available: ok, note: ok ? 'CLI terpasang' : 'CLI tidak ditemukan di PATH' };
      })
    );
    availCache = { ts: Date.now(), map: Object.fromEntries(entries.map((e) => [e.id, e])) };
  }
  return engineList().map((e) => availCache.map[e.id] || e);
}

function getEngine(id) {
  return engineList().find((e) => e.id === id);
}

// Jenis engine ('pool' | 'cli') tanpa membocorkan daftar penuh ke pemanggil.
export function engineType(id) {
  return getEngine(id)?.type || null;
}

// ---------- statistik pemakaian per engine ----------
function statsFile() {
  return readJson('engine-stats.json', {});
}

function bumpStat(id, patch) {
  const s = statsFile();
  const cur = s[id] || { runs: 0, ok: 0, failed: 0, msTotal: 0 };
  for (const [k, v] of Object.entries(patch)) cur[k] = (cur[k] || 0) + v;
  s[id] = cur;
  writeJson('engine-stats.json', s);
}

export function usageStats() {
  const s = statsFile();
  return engineList().map((e) => {
    const st = s[e.id] || { runs: 0, ok: 0, failed: 0, msTotal: 0 };
    return {
      id: e.id,
      label: e.label,
      type: e.type,
      runs: st.runs,
      ok: st.ok,
      failed: st.failed,
      avgMs: st.ok ? Math.round(st.msTotal / st.ok) : 0,
    };
  });
}

// ---------- eksekusi ----------
// onDelta(text) dipanggil per potongan keluaran. resolve: {text, ms, ok}
// signal (opsional, AbortSignal) membatalkan run: CLI dibunuh, permintaan pool
// dibatalkan, dan promise ditolak dengan AbortError.
export async function runEngine(engineId, prompt, { cwd, model, effort, permission, history, onDelta, signal, replyLang } = {}) {
  if (signal?.aborted) throw abortError();
  const engine = getEngine(engineId);
  if (!engine) throw new Error(`Engine "${engineId}" tidak dikenal`);
  prompt = withReplyLanguage(augmentWithSkills(prompt, cwd), replyLang);

  if (engine.type === 'pool') {
    const t0 = Date.now();
    bumpStat(engineId, { runs: 1 });
    // effort sengaja tidak diteruskan ke upstream: setiap provider punya nama
    // parameter reasoning berbeda — meneruskannya butuh pemetaan per-provider
    // yang terverifikasi, bukan tebakan.
    // Riwayat thread ikut dikirim supaya percakapan benar-benar bersambung;
    // engine CLI mengelola sesinya sendiri dan tidak memakai jalur ini.
    const payload = { model: model || 'auto', messages: buildPoolMessages(history, prompt) };
    const r = await raceAbort(routeChat(payload), signal);
    if (signal?.aborted) throw abortError();
    if (r.type === 'error') {
      bumpStat(engineId, { failed: 1 });
      throw new Error('Gateway Pool gagal: ' + JSON.stringify(r.attempts || []).slice(0, 300));
    }
    let text = '';
    let tokens = null;
    let usage = null;
    if (r.type === 'json') {
      try {
        const j = JSON.parse(r.body);
        text = j.choices?.[0]?.message?.content || r.body.slice(0, 2000);
        tokens = j.usage?.total_tokens ?? null;
        usage = j.usage || null;
      } catch {
        text = r.body.slice(0, 2000);
      }
    } else {
      text = '(respons streaming)';
    }
    const ms = Date.now() - t0;
    bumpStat(engineId, { ok: 1, msTotal: ms });
    onDelta?.(text);
    return { text, ms, servedBy: r.servedBy, model: r.model, tokens, usage };
  }

  // CLI harness. Di Windows `cmd` biasanya shim npm `.cmd`, tapi kita coba
  // tembus ke executable aslinya dulu (lihat realCommand) supaya prompt tidak
  // terpotong oleh cmd.exe.
  if (!engine.cmd) throw new Error('Engine CLI tidak memiliki perintah');
  const isWin = process.platform === 'win32';
  let cliArgs = engine.args || ['{prompt}'];
  // Effort hanya dipetakan ke CLI yang memang punya flag-nya (Codex:
  // `codex exec -c model_reasoning_effort=<nilai>`). CLI lain mengabaikannya.
  if (engine.id === 'codex' && effort && ['low', 'medium', 'high'].includes(effort)) {
    const at = cliArgs.indexOf('{prompt}');
    cliArgs = [...cliArgs.slice(0, at), '-c', `model_reasoning_effort=${effort}`, ...cliArgs.slice(at)];
  }
  // Mode izin nyata per CLI (4 tingkat ala aplikasi agent populer):
  //   ask   = selalu tanya sebelum edit/perintah
  //   edits = edit berkas bebas, perintah tetap dikonfirmasi
  //   plan  = baca & rencana saja
  //   full  = tanpa flag (perilaku bawaan headless)
  // Flag yang dipakai sudah ada di CLI resmi: Claude Code --permission-mode
  // (default|acceptEdits|plan), Codex --sandbox (read-only|workspace-write),
  // Gemini CLI --approval-mode (default|auto_edit). CLI versi lama tanpa flag
  // ini akan error dengan pesan jelas dari CLI-nya sendiri.
  if (permission && permission !== 'full' && engine.type === 'cli') {
    const flags = {
      claude: { ask: ['--permission-mode', 'default'], edits: ['--permission-mode', 'acceptEdits'], plan: ['--permission-mode', 'plan'] },
      codex: { ask: ['--sandbox', 'read-only'], edits: ['--sandbox', 'workspace-write'], plan: ['--sandbox', 'read-only'] },
      gemini: { ask: ['--approval-mode', 'default'], edits: ['--approval-mode', 'auto_edit'] },
    }[engine.id]?.[permission];
    if (flags) {
      const at = cliArgs.indexOf('{prompt}');
      cliArgs = [...cliArgs.slice(0, at), ...flags, ...cliArgs.slice(at)];
    }
  }
  const args = cliArgs.map((a) => a.replace('{prompt}', prompt));
  const workingDir = cwd || os.homedir();
  const t0 = Date.now();
  bumpStat(engineId, { runs: 1 });

  return new Promise((resolve, reject) => {
    let p;
    try {
      // Windows: pakai executable nyata di balik shim .cmd kalau bisa ditemukan.
      // Itu menghapus batas 8191 karakter dan pemotongan newline sekaligus,
      // karena tidak ada shell di antaranya.
      //
      // Pengecualian: kalau targetnya cmd.exe sendiri, jangan dianggap "direct".
      // Harness yang memang menulis `cmd /c …` butuh shell untuk redirection,
      // dan cmd.exe tetap memotong prompt pada newline — jadi jalur cadangan di
      // bawah lebih aman untuk mereka.
      const real = realCommand(engine.cmd);
      const isShell = /^(cmd|cmd\.exe)$/i.test(path.basename(real.cmd));
      const direct = !isShell && (real.prefix.length > 0 || real.cmd !== engine.cmd);
      const fullArgs = [...real.prefix, ...args];
      if (direct) {
        p = spawn(real.cmd, fullArgs, { cwd: workingDir, windowsHide: true });
      } else if (isWin) {
        // Jalur cadangan: bungkus cmd.exe. Dua hal yang dulu rusak di sini:
        //   1. Kutip. `""` bukan escape yang sah untuk argv; aturan MSVC C
        //      runtime adalah `\"` + penggandaan backslash sebelum kutip.
        //      Tanpa itu, prompt "halo mesin" sampai ke CLI sebagai dua token
        //      berisi tanda kutip harfiah.
        //   2. Newline. cmd.exe memotong command line pada baris baru, jadi
        //      yang sampai ke CLI hanya baris pertama. Itu diam-diam membuang
        //      blok <available_local_skills> dan <reply_language>. Prompt yang
        //      lewat command line diratakan jadi satu baris supaya isinya utuh.
        //
        // Token yang berisi operator shell (`>`, `|`, `&`) sengaja TIDAK
        // dikutip: itu ditulis di harness.json untuk memakai fitur shell
        // (mis. `echo {prompt}>hasil.txt`). Hanya token argumen biasa yang
        // dikutip, supaya spasi di prompt tidak memecahnya jadi beberapa token.
        const flat = (s) => String(s).replace(/[\r\n]+/g, ' ');
        const shellish = (a) => /[>|&<>^]/.test(a);
        const cmdline = [engine.cmd, ...cliArgs.map((a) => {
          if (!a.includes('{prompt}')) return a;
          const filled = a.replace('{prompt}', flat(prompt));
          return shellish(a) ? filled : winArg(filled);
        })].join(' ');
        p = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], {
          cwd: workingDir, windowsHide: true, windowsVerbatimArguments: true,
        });
      } else {
        p = spawn(engine.cmd, args, { cwd: workingDir, windowsHide: true });
      }
    } catch (e) {
      bumpStat(engineId, { failed: 1 });
      return reject(e);
    }
    let out = '';
    let killed = null; // 'timeout' | 'abort'
    const killTree = (why) => {
      killed = why;
      try {
        if (isWin && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        else p.kill('SIGKILL');
      } catch { try { p.kill(); } catch { /* abaikan */ } }
    };
    let timer = setTimeout(() => killTree('timeout'), RUN_TIMEOUT_MS);
    const onAbort = () => killTree('abort');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    p.stdout?.on('data', (d) => {
      const chunk = d.toString('utf8');
      out += chunk;
      onDelta?.(chunk);
    });
    p.stderr?.on('data', (d) => {
      // sebagian CLI menulis progres ke stderr — gabungkan hanya bila stdout kosong
      if (!out) out += d.toString('utf8');
    });
    p.on('error', (e) => {
      cleanup();
      bumpStat(engineId, { failed: 1 });
      reject(killed ? abortError() : new Error(`${engine.cmd}: ${e.message} (CLI terpasang?)`));
    });
    p.on('close', (code) => {
      cleanup();
      const ms = Date.now() - t0;
      if (killed === 'abort') { bumpStat(engineId, { failed: 1 }); return reject(abortError()); }
      if (killed === 'timeout') {
        bumpStat(engineId, { failed: 1 });
        return reject(new Error(`${engine.cmd} melewati batas ${Math.round(RUN_TIMEOUT_MS / 60000)} menit dan dihentikan`));
      }
      if (code === 0 || out.trim()) {
        bumpStat(engineId, { ok: 1, msTotal: ms });
        resolve({ text: out.trim(), ms, exitCode: code });
      } else {
        bumpStat(engineId, { failed: 1 });
        reject(new Error(`${engine.cmd} keluar dengan kode ${code} tanpa keluaran`));
      }
    });

    // prompt via stdin untuk harness yang mendukung (claude, gemini)
    if (engine.stdin) {
      try { p.stdin.write(prompt); p.stdin.end(); } catch { /* abaikan */ }
    }
  });
}
