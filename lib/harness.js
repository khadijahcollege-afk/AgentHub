// Engine registry: agent "harness" yang bisa dikendarai Studio.
//  - pool   : LLM via Gateway Pool (token gratis, OpenAI-compatible)
//  - cli    : CLI agent yang terpasang (claude, codex, opencode, gemini, …)
// Konfigurasi harness bisa di-override lewat data/harnesses.json
// (array: [{id, label, cmd, args:[…, "{prompt}"]}]). {prompt} diganti isi pesan.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { poolStatus, routeChat } from './pool.js';

const DEFAULT_ENGINES = [
  { id: 'pool', label: 'Free tokens (Gateway)', type: 'pool' },
  { id: 'claude',   label: 'Claude Code', type: 'cli', cmd: 'claude',   args: ['-p', '--output-format', 'text'], stdin: true },
  { id: 'codex',    label: 'Codex',      type: 'cli', cmd: 'codex',    args: ['exec', '{prompt}'] },
  { id: 'opencode', label: 'OpenCode',   type: 'cli', cmd: 'opencode', args: ['run', '{prompt}'] },
  { id: 'gemini',   label: 'Gemini CLI', type: 'cli', cmd: 'gemini',   args: ['-p'], stdin: true },
];

const RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit per run CLI

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
  return [DEFAULT_ENGINES[0], ...cli, ...extra];
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

export async function listEngines(force = false) {
  if (force || Date.now() - availCache.ts > 60000) {
    const entries = await Promise.all(
      engineList().map(async (e) => {
        if (e.type === 'pool') {
          const st = poolStatus();
          return { ...e, available: st.active > 0, note: st.active ? `${st.active} provider siap` : 'pool kosong — tambah key' };
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
export async function runEngine(engineId, prompt, { cwd, model, onDelta } = {}) {
  const engine = getEngine(engineId);
  if (!engine) throw new Error(`Engine "${engineId}" tidak dikenal`);

  if (engine.type === 'pool') {
    const t0 = Date.now();
    bumpStat(engineId, { runs: 1 });
    const payload = { model: model || 'auto', messages: [{ role: 'user', content: prompt }] };
    const r = await routeChat(payload);
    if (r.type === 'error') {
      bumpStat(engineId, { failed: 1 });
      throw new Error('Gateway Pool gagal: ' + JSON.stringify(r.attempts || []).slice(0, 300));
    }
    let text = '';
    if (r.type === 'json') {
      try {
        const j = JSON.parse(r.body);
        text = j.choices?.[0]?.message?.content || r.body.slice(0, 2000);
      } catch {
        text = r.body.slice(0, 2000);
      }
    } else {
      text = '(respons streaming)';
    }
    const ms = Date.now() - t0;
    bumpStat(engineId, { ok: 1, msTotal: ms });
    onDelta?.(text);
    return { text, ms, servedBy: r.servedBy, model: r.model };
  }

  // CLI harness — di Windows shim npm berupa .cmd, wajib dibungkus cmd.exe
  if (!engine.cmd) throw new Error('Engine CLI tidak memiliki perintah');
  const isWin = process.platform === 'win32';
  const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const args = (engine.args || ['{prompt}']).map((a) => a.replace('{prompt}', prompt));
  const workingDir = cwd || os.homedir();
  const t0 = Date.now();
  bumpStat(engineId, { runs: 1 });

  return new Promise((resolve, reject) => {
    let p;
    try {
      if (isWin) {
        // kutip hanya argumen yang mengandung spasi; token perintah/flag polos
        const cmdline = [engine.cmd, ...args].map((a) => (/\s/.test(a) ? quote(a) : a)).join(' ');
        p = spawn('cmd.exe', ['/d', '/s', '/c', cmdline], { cwd: workingDir, windowsHide: true });
      } else {
        p = spawn(engine.cmd, args, { cwd: workingDir, windowsHide: true });
      }
    } catch (e) {
      bumpStat(engineId, { failed: 1 });
      return reject(e);
    }
    let out = '';
    let timer = setTimeout(() => {
      try { p.kill(); } catch { /* abaikan */ }
    }, RUN_TIMEOUT_MS);

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
      clearTimeout(timer);
      bumpStat(engineId, { failed: 1 });
      reject(new Error(`${engine.cmd}: ${e.message} (CLI terpasang?)`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
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
