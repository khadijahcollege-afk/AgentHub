// AgentHub — server lokal Windows: pantau promo API gratis, API key, dan agent.
// Nol dependency npm — hanya modul bawaan Node.js.
import http from 'node:http';
import { discoverSkills, activeSkillIds } from './lib/skills.js';
import { startTerminal, terminalStatus, stopTerminal } from './lib/terminal.js';
import { connectOpenRouter, connectionStatus } from './lib/openrouter-connect.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, readJson, writeJson, DATA_DIR } from './lib/store.js';
import { refreshPromo, getCatalog, catalogValiditySummary, getFreeTierProviders } from './lib/promo.js';
import {
  loadPass, claimPass, dismissPass, togglePassModel, addPassModel,
  renamePassModel, upgradePass, markShared, shareText, publicPass, recordUsage,
} from './lib/promoPass.js';
import { listKeys, addKey, removeKey, checkKey, checkAllKeys, setPool, checkingKeyIds, PRESETS, RETIRED_PRESETS, DEFAULT_MODELS, API_FORMATS } from './lib/keys.js';
import { listAgents, addAgent, removeAgent, checkAgent, checkAllAgents, checkingAgentIds } from './lib/agents.js';
import { routeChat, testPool, poolStatus, poolModels } from './lib/pool.js';
import { listEngines, runEngine, usageStats, engineType } from './lib/harness.js';
import { usageSummary, rangeDelta, record as recordFeature } from './lib/stats.js';
import { normalizeReplyLang } from './lib/lang.js';
import * as threads from './lib/threads.js';
import * as tasks from './lib/tasks.js';
import * as notes from './lib/notes.js';
import * as prompts from './lib/prompts.js';
import * as schedules from './lib/schedules.js';
import { backupBundle, restoreBackup } from './lib/backup.js';
import * as orchestra from './lib/orchestra.js';
import { contextStats } from './lib/context.js';
import * as projects from './lib/projects.js';
import { searchAll } from './lib/search.js';
import {
  saveUpload, getUpload, readUpload, deleteUpload, augmentPrompt, publicUpload,
  isInlineImage, MAX_ATTACHMENTS,
} from './lib/uploads.js';
import * as environments from './lib/environments.js';
import * as memory from './lib/memory.js';
import * as memoryExtract from './lib/memory-extract.js';
import * as share from './lib/share.js';
import { searchWeb, researchContext, ResearchError } from './lib/research.js';
import { listModelChoices, activateModel, isMaskedKey } from './lib/models.js';
import { tunnelStatus, startTunnel, stopTunnel } from './lib/tunnel.js';
import {
  fetchLatestRelease, updateInfo, fullUpdateInfo, assetFor, downloadAsset, launchInstaller,
} from './lib/update.js';
import * as runs from './lib/runs.js';
import * as mcp from './lib/mcp.js';
import * as hooks from './lib/hooks.js';
import * as checkpoints from './lib/checkpoints.js';
import * as instructionsLib from './lib/instructions.js';
import * as pluginsLib from './lib/plugins.js';
import { toolSummary, PERMISSION_MODES, normalizeMode } from './lib/tools.js';

// Nilai `permission` yang diterima dari UI. Nama lama (ask/edits/full) tetap sah
// karena disimpan di localStorage pengguna; pemetaannya dilakukan di lib/tools.js
// untuk gerbang tool, dan di lib/harness.js untuk flag CLI.
const PERMISSION_INPUTS = [...PERMISSION_MODES, 'ask', 'edits', 'full'];
import {
  resolveWorkspace, workspaceSummary, diffReport, revertPaths, listRules, writeRule,
} from './lib/workspace.js';
import { toast } from './lib/notify.js';
import {
  TASK_MACHINE, RUN_MACHINE, KEY_MACHINE, AGENT_MACHINE, CONNECTION_MACHINE,
  PROMO_MACHINE, PROMO_PASS_MACHINE, VIEW_MACHINE, UI_MACHINE, SSE_SCOPES, VIEWS, TASK_STATUSES,
  STEP_MACHINE, DELEGATION_MACHINE, NOTE_EDITOR_MACHINE, MACHINE_VERSION,
  KEY_POOL_CANDIDATE, KEY_POOL_ACTIVE, KEY_MODEL_VISIBLE, canTransition,
  CHANGE_STATUSES, RULE_FILES,
} from './lib/machines.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = process.env.AGENTHUB_DIST ? path.resolve(process.env.AGENTHUB_DIST) : path.join(ROOT, 'dist');
const startedAt = Date.now();
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ---------- state runtime ----------
let config = loadConfig();
// ID perangkat stabil: dipakai menu akun & identifikasi perangkat saat HP/
// komputer lain terhubung. Dibuat sekali pada boot pertama.
if (!config.instanceId) {
  config.instanceId = (await import('node:crypto')).randomUUID();
  saveConfig(config);
}
let alerts = readJson('alerts.json', []);
let updateCache = { at: 0, data: null };

// ---------- auto-update (cek berkala + unduh otomatis + pasang) ----------
// Sumber kebenaran: GitHub Releases latest. Server memeriksa sendiri secara
// berkala; bila ada versi baru, aset untuk platform ini diunduh otomatis ke
// dist/ (progres disiarkan lewat SSE), dan UI menawarkan tombol "Pasang
// sekarang". Gagal jaringan dilaporkan apa adanya di /api/update.
let updateDl = { status: 'idle', pct: 0, bytes: 0, total: 0, error: null, path: null, version: null, at: 0 };
let updateBusy = false;

function updatePublic() {
  const info = updateCache.data;
  const { path, ...rest } = updateDl;
  return {
    ...info,
    autoUpdate: config.autoUpdate !== false,
    download: rest,
    installable: updateDl.status === 'ready' && fs.existsSync(updateDl.path || ''),
    installerPath: updateDl.status === 'ready' ? updateDl.path : null,
    asset: info?.ok && info.hasUpdate ? assetFor() : null,
  };
}

async function updateTick(force = false) {
  const now = Date.now();
  if (!force && updateCache.at && now - updateCache.at < 30 * 60 * 1000) return;
  try {
    // AGENTHUB_UPDATE_API memungkinkan pengujian tanpa menyentuh GitHub.
    const release = await fetchLatestRelease(fetch, process.env.AGENTHUB_UPDATE_API || undefined);
    updateCache = { at: now, data: fullUpdateInfo(APP_VERSION, release) };
  } catch (e) {
    updateCache = { at: now, data: fullUpdateInfo(APP_VERSION, null, { error: String(e.message || e) }) };
  }
  broadcast('update');
  // ada versi baru + autoUpdate aktif → unduh otomatis (sekali per versi)
  if (updateCache.data?.hasUpdate && config.autoUpdate !== false
    && updateDl.version !== updateCache.data.latest && updateDl.status !== 'downloading') {
    startDownload();
  }
}

function startDownload(force = false) {
  const info = updateCache.data;
  if (!info?.ok || !info.hasUpdate || !info.asset) return;
  if (updateBusy || updateDl.status === 'downloading') return;
  // sudah ada untuk versi ini → jangan unduh ulang (kecuali diminta paksa
  // setelah gagal)
  if (updateDl.version === info.latest && updateDl.status === 'ready' && !force) return;
  updateBusy = true;
  updateDl = { status: 'downloading', pct: 0, bytes: 0, total: 0, error: null, path: null, version: info.latest, at: Date.now() };
  broadcast('update');
  const dest = path.join(DIST_DIR, info.asset.name);
  downloadAsset(info.asset.url, dest, {
    onProgress: (p) => {
      updateDl = { ...updateDl, pct: p.pct, bytes: p.bytes, total: p.total };
      broadcast('update'); // throttle: onProgress sendiri sudah di-throttle 512KB
    },
  }).then((r) => {
    updateDl = { ...updateDl, status: 'ready', bytes: r.bytes, path: r.path, pct: 100, at: Date.now() };
    broadcast('update');
  }).catch((e) => {
    updateDl = { ...updateDl, status: 'error', error: String(e.message || e), at: Date.now() };
    broadcast('update');
  }).finally(() => {
    updateBusy = false;
  });
}
// ip → { count, firstAt }: percobaan token salah dalam 60 detik terakhir
const authFailures = new Map();
// folder kerja yang dipantau: perubahan berkas → SSE scope workspace
const workspaceWatchers = new Map();
function watchWorkspace(cwd) {
  if (!cwd || workspaceWatchers.has(cwd) || workspaceWatchers.size >= 8) return;
  try {
    let timer = null;
    const watcher = fs.watch(cwd, { recursive: true }, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; broadcast('workspace'); }, 600);
    });
    watcher.on('error', () => {});
    workspaceWatchers.set(cwd, { watcher, timer });
  } catch { /* folder mungkin sudah hilang */ }
}
const sseClients = new Set();

function addAlert({ type, title, detail }) {
  alerts = [{ id: Math.random().toString(36).slice(2), ts: Date.now(), type, title, detail, read: false }, ...alerts].slice(0, 200);
  writeJson('alerts.json', alerts);
}

function broadcast(scope) {
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify({ scope, ts: Date.now() })}\n\n`); } catch { /* klien putus */ }
  }
}

// ---------- eksekusi jadwal (scheduled runs) ----------
// Sama seperti /send: satu run per thread, pesan user+asisten nyata, usage
// upstream dicatat. Hasil menumpuk di satu thread per jadwal supaya riwayat
// eksekusi bisa dibaca seperti percakapan biasa.
async function executeSchedule(s) {
  const engineId = s.engine;
  if (!(await listEngines()).some((e) => e.id === engineId)) {
    schedules.markFailed(s.id, `Engine tidak tersedia: ${engineId}`);
    return;
  }
  let t = s.threadId ? threads.getThread(s.threadId) : null;
  if (!t) {
    t = threads.createThread({ title: `Jadwal — ${s.name}`.slice(0, 80), engine: engineId, cwd: s.cwd || null });
    schedules.attachThread(s.id, t.id);
  }
  // Thread sibuk (run manual masih jalan) → lewati siklus ini; jadwal tetap
  // berjalan pada tempo berikutnya, tidak menumpuk antrian.
  if (runs.isActive(t.id)) return;

  let workspace;
  try {
    workspace = s.cwd ? resolveWorkspace(s.cwd) : (t.cwd ? resolveWorkspace(t.cwd) : undefined);
  } catch (error) {
    schedules.markFailed(s.id, error.message);
    return;
  }

  try {
    runs.begin(t.id);
    threads.appendMessage(t.id, { role: 'user', content: s.prompt, engine: engineId, scheduledBy: s.name });
    threads.patchThread(t.id, { engine: engineId, ...(workspace ? { cwd: workspace } : {}) });
    broadcast('threads');
    const r = await runEngine(engineId, s.prompt, { cwd: workspace, replyLang: config.replyLang });
    threads.appendMessage(t.id, {
      role: 'assistant',
      engine: engineId,
      content: String(r.text || '').slice(0, 200000),
      ms: r.ms,
      servedBy: r.servedBy,
      model: r.model,
      tokens: r.tokens || null,
      usage: r.usage || null,
      runStatus: 'done',
    });
    if (r.tokens) {
      try { recordUsage(loadPass(), r.model, r.tokens); } catch { /* statistik tidak boleh menggagalkan run */ }
    }
    runs.finish(t.id, 'done');
    schedules.markRan(s.id);
    broadcast('threads');
    broadcast('schedules');
    if (r.ms > 15000) toast(`Jadwal "${s.name}" selesai`, `${engineId} · ${Math.round(r.ms / 1000)} detik`);
  } catch (error) {
    try { runs.finish(t.id, 'error', { error: error.message }); } catch { /* thread hilang */ }
    schedules.markFailed(s.id, error.message);
    broadcast('threads');
    broadcast('schedules');
    toast(`Jadwal "${s.name}" gagal`, String(error.message || error).slice(0, 120));
  }
}

// Pemeriksa tempo setiap 30 detik. Tidak menahan proses keluar (unref).
setInterval(() => {
  for (const s of schedules.dueSchedules()) executeSchedule(s);
}, 30000).unref();

// Tandai "sedang diperiksa" supaya UI punya state nyata, bukan cuma tombol mati.
function markKeyChecking(id) {
  const all = readJson('keys.json', []);
  const k = all.find((x) => x.id === id);
  if (!k) return;
  k.status = 'checking';
  k.statusText = 'Memeriksa…';
  writeJson('keys.json', all);
}

function markAgentChecking(id, state = 'checking') {
  const all = readJson('agents.json', []);
  const a = all.find((x) => x.id === id);
  if (!a) return;
  a.status = state;
  a.statusText = state === 'triggering' ? 'Mengirim tes…' : 'Memeriksa…';
  writeJson('agents.json', all);
}

// Siklus hidup run kini dimiliki lib/runs.js (state + registry proses).
// Wrapper ini dipertahankan untuk pemanggil lama.
export function stopRun(threadId) {
  return runs.stop(threadId);
}

// ---------- promo: satu refresh pada satu waktu ----------
// Tombol UI, scheduler, dan panggilan agent bisa memicu refresh bersamaan.
// Dulu dua refresh bisa saling menimpa snapshot dan menggandakan alert.
let promoState = 'idle';
let promoRun = null;

function setPromoState(next) {
  if (!canTransition(PROMO_MACHINE, promoState, next)) {
    console.warn(`[promo] transisi ${promoState} → ${next} tidak sah`);
  }
  promoState = next;
}

function refreshPromoOnce() {
  if (promoRun) return promoRun;
  setPromoState('refreshing');
  const task = (async () => {
    try {
      const result = await refreshPromo(config, addAlert, broadcast);
      setPromoState('ready');
      return result;
    } catch (error) {
      setPromoState('error');
      throw error;
    } finally {
      promoRun = null;
      const timer = setTimeout(() => { if (promoState === 'ready') setPromoState('idle'); }, 1500);
      timer.unref?.();
    }
  })();
  promoRun = task;
  return task;
}

export function promoStatus() {
  return { state: promoState, refreshing: !!promoRun };
}

// ---------- util ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// Argumen tool dipangkas untuk dikirim ke UI: isi berkas penuh tidak boleh
// masuk lewat SSE hanya supaya chip tool bisa menampilkan nama berkasnya.
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'content' || key === 'old' || key === 'new') { out[key] = `(${String(value ?? '').length} karakter)`; continue; }
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return out;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

function lanIp() {
  // prioritaskan rentang privat nyata; hindari link-local 169.254.x.x
  const score = (addr) => {
    if (/^192\.168\./.test(addr)) return 3;
    if (/^10\./.test(addr)) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2;
    if (/^169\.254\./.test(addr)) return 0;
    return 1;
  };
  let best = null;
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (!best || score(i.address) > score(best)) best = i.address;
    }
  }
  return best || '127.0.0.1';
}

function serverInfo() {
  const port = config.port;
  const ip = lanIp();
  return {
    port,
    version: APP_VERSION,
    instanceId: config.instanceId,
    lanIp: ip,
    localUrl: `http://127.0.0.1:${port}`,
    lanUrl: `http://${ip}:${port}`,
    phoneUrl: `http://${ip}:${port}/`,
    // URL yang benar-benar dipindai dari QR. Menyertakan token sekali-pakai
    // supaya HP tidak perlu mengetik token manual — dulu QR hanya berisi
    // alamat polos dan HP selalu mendarat di halaman "butuh token".
    pairUrl: `http://${ip}:${port}/?token=${encodeURIComponent(config.token)}`,
    uptimeMs: Date.now() - startedAt,
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    startedAt,
    // Folder default untuk terminal & sesi tanpa proyek. UI memakainya sebagai
    // titik awal ("C:\Users\nama") alih-alih memaksa user memilih folder dulu.
    homeDir: os.homedir(),
    cwdDefault: process.cwd(),
  };
}

function appState() {
  const snap = readJson('snapshot.json', null);
  return {
    config: {
      port: config.port,
      notify: config.notify,
      refreshHours: config.refreshHours,
      agentCheckMinutes: config.agentCheckMinutes,
      keyCheckHours: config.keyCheckHours,
      autoPool: config.autoPool !== false,
      baselined: config.baselined,
      cloudflaredPath: config.cloudflaredPath || '',
      replyLang: config.replyLang || 'auto',
      memoryEnabled: config.memoryEnabled !== false,
      memoryAutoExtract: config.memoryAutoExtract === true,
      autoUpdate: config.autoUpdate !== false,
    },
    memory: memory.listMemory(),
    memoryExtract: memoryExtract.extractStatus(),
    update: updatePublic(),
    token: config.token,
    keys: listKeys(),
    notes: notes.listNotes(),
    projects: projects.listProjects(),
    environments: environments.listEnvironments(),
    keyPresets: PRESETS,
    // Preset yang endpoint-nya sudah pensiun. UI memakai ini untuk berhenti
    // menawarkannya pada key baru, tanpa menyembunyikan key lama yang sah.
    retiredPresets: RETIRED_PRESETS,
    defaultModels: DEFAULT_MODELS,
    agents: listAgents(),
    alerts,
    snapshot: snap,
    // Daftar free-tier pihak ketiga sudah disaring dari provider yang pensiun.
    // UI memakai ini, bukan state.snapshot mentah, supaya daftar eksternal yang
    // tertinggal tidak lagi menjanjikan layanan yang sudah tiada.
    freeTierProviders: getFreeTierProviders(snap),
    catalog: getCatalog(),
    catalogValidity: catalogValiditySummary(),
    promoPass: publicPass(loadPass()),
    pool: poolStatus(),
    server: serverInfo(),
    // Tool MCP & hook: daftar konfigurasi (rahasia tetap tertutup) + ringkasan.
    mcp: mcp.status(),
    hooks: hooks.summary(),
    instructions: instructionsLib.instructionsSummary(),
    plugins: pluginsLib.summary(),
    permissionModes: PERMISSION_MODES,
    // kontrak state machine — UI memakainya untuk tombol/label yang sah,
    // agent memakainya untuk tahu transisi apa yang diizinkan tanpa menebak.
    machines: machineContracts(),
  };
}

// Satu sumber kebenaran yang bisa dibaca mesin (AX): semua mesin + versinya.
function machineContracts() {
  return {
    version: MACHINE_VERSION,
    views: VIEWS,
    tasks: TASK_MACHINE,
    run: RUN_MACHINE,
    step: STEP_MACHINE,
    delegation: DELEGATION_MACHINE,
    noteEditor: NOTE_EDITOR_MACHINE,
    keys: KEY_MACHINE,
    agents: AGENT_MACHINE,
    connection: CONNECTION_MACHINE,
    promo: PROMO_MACHINE,
    promoPass: PROMO_PASS_MACHINE,
    ui: UI_MACHINE,
    viewsMachine: VIEW_MACHINE,
    keyPool: {
      candidate: KEY_POOL_CANDIDATE,
      active: KEY_POOL_ACTIVE,
      models: KEY_MODEL_VISIBLE,
    },
    workspace: {
      changeStatuses: CHANGE_STATUSES,
      ruleFiles: RULE_FILES,
    },
    sseScopes: SSE_SCOPES,
  };
}

// Bentuk ringkas status runtime: apa yang sedang berjalan sekarang.
// Dipakai UI untuk memulihkan tampilan "Working" setelah refresh/reconnect.
function runtimeStatus() {
  const summaries = threads.listThreads();
  const byId = new Map(summaries.map((t) => [t.id, t]));
  const running = runs.activeRuns().map((r) => {
    const t = byId.get(r.id);
    return { id: r.id, kind: t?.kind || 'chat', title: t?.title || r.id, startedAt: r.startedAt };
  });
  return {
    runningThreads: running,
    runningCount: running.length,
    recoveredRuns: runs.recoveredRuns(),
    threads: summaries.length,
    tasks: tasks.listTasks().length,
    notes: notes.listNotes().length,
    projects: projects.listProjects().length,
    environments: environments.listEnvironments().length,
    tasksByStatus: TASK_STATUSES.reduce((acc, s) => {
      acc[s] = tasks.listTasks().filter((t) => t.status === s).length;
      return acc;
    }, {}),
    checkingKeys: checkingKeyIds(),
    checkingAgents: checkingAgentIds(),
    promo: promoStatus(),
    uptimeMs: Date.now() - startedAt,
  };
}

// ---------- auth ----------
function authorized(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && h.slice(7) === config.token) return true;
  if (url.searchParams.get('token') === config.token) return true;
  const cookie = req.headers.cookie || '';
  if (cookie.split(/;\s*/).some((c) => c === `token=${config.token}`)) return true;
  return false;
}

function isLocalDashboard(req) {
  const loopbacks = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  if (!loopbacks.includes(req.socket.remoteAddress)) return false;
  // Tunnel/proxy juga tersambung lewat loopback, tetapi bukan browser lokal.
  if (Object.keys(req.headers).some((key) => key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('cf-'))) return false;
  const port = req.socket.localPort;
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(req.headers.host?.toLowerCase());
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(res, relPath) {
  const full = path.resolve(PUBLIC_DIR, relPath);
  const relative = path.relative(PUBLIC_DIR, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(res, 403, { error: 'Ditolak' });
  try {
    const data = fs.readFileSync(full);
    const ext = path.extname(full);
    // HTML/CSS/JS selalu revalidate supaya update UI langsung terlihat
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Tidak ditemukan');
  }
}

function serveDownload(res, filePath, downloadName) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${downloadName}"`,
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p style="font-family:sans-serif">Berkas installer belum tersedia di folder <code>dist/</code> aplikasi ini. Jalankan build (lihat README) atau salin AgentHub-Setup.exe ke folder dist.</p>');
  }
}

// ---------- routing ----------
async function route(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;
  // `m` dipakai banyak rute di bawah (termasuk rute publik sebelum blok auth),
  // jadi deklarasinya harus di awal fungsi — bukan di tengah — agar tidak kena TDZ.
  let m;
  if (p.startsWith('/api/') || p.startsWith('/v1/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const origin = req.headers.origin;
      let sameOrigin = false;
      try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch { /* invalid origin */ }
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !sameOrigin)) {
        return sendJson(res, 403, { error: 'Permintaan lintas situs ditolak' });
      }
    }
  }

  // shell & aset statis terbuka (tidak ada data sensitif di dalamnya)
  if (method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  // service worker wajib di root agar scope-nya mencakup seluruh aplikasi
  if (method === 'GET' && p === '/sw.js') return serveStatic(res, 'sw.js');
  if (method === 'GET' && p.startsWith('/public/')) return serveStatic(res, p.slice('/public/'.length));
  if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, name: 'AgentHub', version: APP_VERSION });
  // UI komputer sendiri masuk otomatis; API lain tetap memerlukan token.
  // POST memakai pemeriksaan origin di atas dan respons tidak pernah di-cache.
  if (method === 'POST' && p === '/api/local-session') {
    if (!isLocalDashboard(req)) return sendJson(res, 403, { error: 'Sesi otomatis hanya tersedia di komputer ini' });
    return sendJson(res, 200, { token: config.token });
  }

  // halaman & berkas unduhan (terbuka agar HP/komputer lain mudah mengambil)
  if (method === 'GET' && p === '/download') return serveStatic(res, 'download.html');
  if (method === 'GET' && p === '/download/setup.exe') {
    return serveDownload(res, path.join(DIST_DIR, 'AgentHub-Setup.exe'), `AgentHub-Setup-${APP_VERSION}.exe`);
  }
  if (method === 'GET' && p === '/download/portable.zip') {
    return serveDownload(res, path.join(DIST_DIR, 'AgentHub-Portable.zip'), `AgentHub-Portable-${APP_VERSION}.zip`);
  }

  // ---- tautan baca-saja (REA ZCode: conversationShare) ----
  // Publik tanpa token: isi thread saja, tidak pernah menyentuh token/key.
  // Punya masa berlaku & bisa dicabut (lihat lib/share.js).
  if ((m = p.match(/^\/share\/([a-f0-9]+)$/)) && method === 'GET') {
    const s = share.getShare(m[1]);
    if (!s) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
      return res.end(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tautan tidak tersedia</title><style>body{background:#0b0b0c;color:#9a9aa2;font:14px/1.6 system-ui;display:grid;place-items:center;height:100dvh;margin:0}main{text-align:center}b{color:#e6e6ec}</style></head><body><main><b>Tautan tidak tersedia</b><p>Tautan sudah kedaluwarsa atau dicabut pemiliknya.</p></main></body></html>`);
    }
    const t = threads.getThread(s.threadId);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    const escHtml = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const mdHtml = (raw) => {
      let out = escHtml(String(raw || ''));
      out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _l, code) => `<pre class="code">${code}</pre>`);
      out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      out = out.replace(/\n/g, '<br>');
      return out;
    };
    const msgs = (t.messages || []).filter((x) => !x.subrun).map((x) => {
      const who = x.role === 'user' ? 'Pengguna' : 'Assistant';
      const eng = x.role !== 'user' && x.engine ? ` · ${escHtml(String(x.engine))}` : '';
      return `<div class="msg ${x.role === 'user' ? 'user' : 'asst'}"><div class="who">${who}${eng}</div><div class="body">${mdHtml(x.content)}</div></div>`;
    }).join('\n');
    const expires = new Date(s.expiresAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(t.title || 'Percakapan')} — AgentHub</title>
<style>
  body{background:#0b0b0c;color:#d6d6dc;font:14px/1.65 system-ui,Segoe UI,sans-serif;margin:0}
  main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
  header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#f2905c,#e46a30);display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px}
  h1{font-size:18px;margin:0;color:#f2f2f5}
  .meta{color:#8d8d94;font-size:12px;margin:0 0 26px}
  .msg{margin:0 0 18px;padding:12px 14px;border-radius:12px;background:#161618;border:1px solid #24242a}
  .msg.user{background:#1d1a17;border-color:#3a2d22}
  .who{font-size:11px;color:#8d8d94;margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase}
  .body{overflow-wrap:anywhere}
  .code{background:#0d0d0f;border:1px solid #26262b;border-radius:8px;padding:10px 12px;overflow-x:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre}
  code{background:#0d0d0f;border-radius:4px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace}
  footer{margin-top:34px;color:#6d6d76;font-size:12px;text-align:center}
  footer a{color:#e46a30;text-decoration:none}
</style></head><body><main>
<header><span class="mark">A</span><h1>${escHtml(t.title || 'Percakapan')}</h1></header>
<p class="meta">Dibagikan dari AgentHub · kedaluwarsa ${escHtml(expires)}</p>
${msgs || '<p class="meta">Percakapan kosong.</p>'}
<footer>Halaman baca-saja — dibuat dengan <a href="https://github.com/khadijahcollege-afk/AgentHub">AgentHub</a></footer>
</main></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (!authorized(req, url)) {
    // Rate limit percobaan token salah per IP (anti brute-force). Request yang
    // sah tidak pernah diblokir — hitungan direset saat token valid.
    const ip = req.socket.remoteAddress || '?';
    const now = Date.now();
    const rec = authFailures.get(ip) || { count: 0, firstAt: now };
    if (now - rec.firstAt > 60_000) { rec.count = 0; rec.firstAt = now; }
    rec.count += 1;
    authFailures.set(ip, rec);
    if (rec.count > 12) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      return res.end(JSON.stringify({ error: 'Terlalu banyak percobaan token salah. Coba lagi nanti.' }));
    }
    return sendJson(res, 401, { error: 'Token tidak valid. Masukkan token akses pada halaman masuk.' });
  }
  // token valid → bersihkan catatan gagal untuk IP ini
  authFailures.delete(req.socket.remoteAddress || '?');

  // ---- SSE ----
  if (p === '/api/skills' && method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    const prompt = url.searchParams.get('prompt');
    // `prompt` opsional: bila ada, server menyebut skill mana yang akan aktif
    // OTOMATIS untuk permintaan itu — UI menampilkannya sebelum pesan dikirim,
    // jadi user tidak perlu memilih skill satu per satu.
    const active = prompt ? activeSkillIds(prompt, cwd) : [];
    return sendJson(res, 200, { skills: discoverSkills(cwd), automatic: true, active });
  }
  if (p === '/api/terminal' || p.startsWith('/api/terminal/')) {
    try {
      if (p === '/api/terminal' && method === 'POST') {
        const r = startTerminal(await readBody(req));
        recordFeature('terminal');
        return sendJson(res, 200, r);
      }
      const terminalMatch = p.match(/^\/api\/terminal\/([a-f0-9]{32})$/);
      if (terminalMatch && method === 'GET') return sendJson(res, 200, terminalStatus(terminalMatch[1]));
      if (terminalMatch && method === 'DELETE') { stopTerminal(terminalMatch[1]); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 404, { error: 'Sesi terminal tidak ditemukan' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }

  // ---- MCP: server tool eksternal (REA ZCode 07-mcp) ----
  if (p === '/api/mcp' || p.startsWith('/api/mcp/')) {
    try {
      if (p === '/api/mcp' && method === 'GET') {
        return sendJson(res, 200, { servers: mcp.listServers(), status: mcp.status() });
      }
      if (p === '/api/mcp' && method === 'POST') {
        const b = await readBody(req);
        const server = mcp.upsertServer(b.name, b.server || b);
        broadcast('config');
        return sendJson(res, 200, server);
      }
      if ((m = p.match(/^\/api\/mcp\/([A-Za-z0-9._-]+)\/enabled$/)) && method === 'POST') {
        const b = await readBody(req);
        const server = mcp.setServerEnabled(m[1], b.enabled);
        broadcast('config');
        return sendJson(res, 200, server);
      }
      if ((m = p.match(/^\/api\/mcp\/([A-Za-z0-9._-]+)\/tools$/)) && method === 'GET') {
        const tools = await mcp.listTools(m[1], { force: url.searchParams.get('refresh') === '1' });
        return sendJson(res, 200, { server: m[1], tools });
      }
      if ((m = p.match(/^\/api\/mcp\/([A-Za-z0-9._-]+)$/)) && method === 'DELETE') {
        mcp.removeServer(m[1]);
        broadcast('config');
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/mcp/catalog' && method === 'GET') {
        return sendJson(res, 200, await mcp.catalog({ force: url.searchParams.get('refresh') === '1' }));
      }
      if (p === '/api/mcp/tools' && method === 'GET') {
        // Ringkasan tool yang akan ditawarkan ke model untuk sebuah folder + mode.
        const cwd = url.searchParams.get('cwd');
        let resolved = null;
        if (cwd) { try { resolved = resolveWorkspace(cwd); } catch { resolved = null; } }
        return sendJson(res, 200, await toolSummary({
          cwd: resolved,
          mode: url.searchParams.get('mode') || 'yolo',
        }));
      }
      return sendJson(res, 404, { error: 'Rute MCP tidak dikenal' });
    } catch (error) {
      // `code` wajib ikut: UI membedakan 409 MCP_MANAGED_BY_PLUGIN (server milik
      // plugin, baca-saja) dari konflik lain hanya lewat kode ini.
      return sendJson(res, error.statusCode || 500, { error: error.message, code: error.code });
    }
  }

  // ---- Hooks: lifecycle program lokal (REA ZCode 09-hooks) ----
  if (p === '/api/hooks' || p.startsWith('/api/hooks/')) {
    try {
      if (p === '/api/hooks' && method === 'GET') {
        const cwd = url.searchParams.get('cwd');
        let resolved = null;
        if (cwd) { try { resolved = resolveWorkspace(cwd); } catch { resolved = null; } }
        return sendJson(res, 200, {
          ...hooks.summary(resolved),
          declarations: hooks.listHooks(),
          trust: resolved ? hooks.trustStatus(resolved) : null,
        });
      }
      if (p === '/api/hooks/enabled' && method === 'POST') {
        const b = await readBody(req);
        const r = hooks.setEnabled(b.enabled);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/hooks/events' && method === 'POST') {
        const b = await readBody(req);
        const r = hooks.setEventHooks(b.event, b.declarations);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/hooks/trust' && method === 'GET') {
        const cwd = resolveWorkspace(url.searchParams.get('cwd'));
        return sendJson(res, 200, hooks.trustStatus(cwd));
      }
      if (p === '/api/hooks/trust' && method === 'POST') {
        const b = await readBody(req);
        const cwd = resolveWorkspace(b.cwd);
        const r = hooks.grantTrust(cwd, b.digest);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/hooks/trust' && method === 'DELETE') {
        const cwd = resolveWorkspace(url.searchParams.get('cwd'));
        const r = hooks.revokeTrust(cwd);
        broadcast('config');
        return sendJson(res, 200, { ok: r });
      }
      if (p === '/api/hooks/test' && method === 'POST') {
        const b = await readBody(req);
        const cwd = b.cwd ? resolveWorkspace(b.cwd) : null;
        const r = await hooks.runEvent(b.event || 'SessionStart', b.payload || {}, { cwd });
        return sendJson(res, 200, r);
      }
      return sendJson(res, 404, { error: 'Rute hook tidak dikenal' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }

  // ---- instruksi tetap: AGENTS.md level user + ringkasan aturan proyek ----
  // Endpoint terpisah dari aturan proyek karena cakupannya berbeda: berkas ini
  // berlaku untuk semua thread di komputer ini, bukan untuk satu repo.
  if (p === '/api/instructions' || p === '/api/instructions/global') {
    try {
      if (method === 'GET') {
        const cwd = url.searchParams.get('cwd');
        let dir = null;
        if (cwd) { try { dir = resolveWorkspace(cwd); } catch { dir = null; } }
        const systemPrompt = url.searchParams.get('thread')
          ? threads.getThread(url.searchParams.get('thread'))?.systemPrompt || null
          : null;
        return sendJson(res, 200, {
          global: instructionsLib.readUserInstructions(),
          summary: instructionsLib.instructionsSummary({ cwd: dir, systemPrompt }),
        });
      }
      if (method === 'PUT' && p === '/api/instructions/global') {
        const b = await readBody(req);
        const r = instructionsLib.writeUserInstructions(b.content);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      return sendJson(res, 405, { error: 'Metode tidak didukung' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }

  // ---- plugin: skill + perintah + hook + MCP dalam satu paket (REA ZCode 10) ----
  if (p === '/api/plugins' || p.startsWith('/api/plugins/')) {
    try {
      if (p === '/api/plugins' && method === 'GET') {
        return sendJson(res, 200, {
          ...pluginsLib.summary(),
          plugins: pluginsLib.listPlugins(),
          commands: pluginsLib.listCommands(),
          marketplaces: pluginsLib.listMarketplaces(),
          available: pluginsLib.availablePlugins(),
        });
      }
      if (p === '/api/plugins/enabled' && method === 'POST') {
        const b = await readBody(req);
        const r = pluginsLib.setEnabled(b.enabled);
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/plugins/validate' && method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, pluginsLib.validatePlugin(b.dir || b.name));
      }
      if (p === '/api/plugins/install' && method === 'POST') {
        const b = await readBody(req);
        const r = pluginsLib.installPlugin(b.name || b.dir, { marketplace: b.marketplace, scope: b.scope });
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/plugins/marketplaces' && method === 'POST') {
        const b = await readBody(req);
        const r = pluginsLib.addMarketplace(b.dir || b.path);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if (p === '/api/plugins/marketplaces' && method === 'DELETE') {
        const name = url.searchParams.get('name');
        const r = pluginsLib.removeMarketplace(name);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      let m2;
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)\/enabled$/)) && method === 'POST') {
        const b = await readBody(req);
        const r = pluginsLib.setPluginEnabled(m2[1], b.enabled);
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)\/trust$/)) && method === 'POST') {
        const b = await readBody(req);
        const r = pluginsLib.grantTrust(m2[1], b.digest);
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)\/trust$/)) && method === 'DELETE') {
        const r = pluginsLib.revokeTrust(m2[1]);
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)\/trust$/)) && method === 'GET') {
        return sendJson(res, 200, pluginsLib.trustStatus(m2[1]));
      }
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)\/update$/)) && method === 'POST') {
        const r = pluginsLib.updatePlugin(m2[1]);
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      if ((m2 = p.match(/^\/api\/plugins\/([A-Za-z0-9._-]+)$/)) && method === 'DELETE') {
        const keepData = url.searchParams.get('keepData') !== '0';
        const r = pluginsLib.uninstallPlugin(m2[1], { keepData });
        mcp.closeAll();
        broadcast('config');
        return sendJson(res, 200, r);
      }
      return sendJson(res, 404, { error: 'Rute plugin tidak dikenal' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message, code: error.code }); }
  }
  if (p === '/api/openrouter/connect' && method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await connectOpenRouter(body.model));
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }
  if (p === '/api/openrouter/connection' && method === 'GET') {
    return sendJson(res, 200, connectionStatus(url.searchParams.get('id')));
  }
  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ scope: 'hello' })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* noop */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // ---- state ----
  if (p === '/api/state' && method === 'GET') return sendJson(res, 200, appState());
  if (p === '/api/serverinfo' && method === 'GET') return sendJson(res, 200, serverInfo());
  // kontrak mesin saja — murah, untuk agent yang tidak butuh seluruh state
  if (p === '/api/machines' && method === 'GET') return sendJson(res, 200, machineContracts());
  // apa yang sedang berjalan — UI memulihkan tampilan setelah refresh/reconnect
  if (p === '/api/status' && method === 'GET') return sendJson(res, 200, runtimeStatus());
  // aliran kejadian sebagai JSON-lines (untuk agent non-browser; browser pakai SSE)
  if (p === '/api/events' && method === 'GET' && url.searchParams.get('format') === 'json') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    res.write(JSON.stringify({ scope: 'hello', ts: Date.now() }) + '\n');
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(JSON.stringify({ scope: 'ping', ts: Date.now() }) + '\n'); } catch { /* noop */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  // versi mesin — dipakai CI dan agent untuk memastikan kontrak tidak berubah diam-diam
  if (p === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { name: 'AgentHub', machines: MACHINE_VERSION, views: VIEWS, taskStatuses: TASK_STATUSES });
  }

  // ---- projects & environment bookmarks (metadata only) ----
  if (p === '/api/projects' || p.startsWith('/api/projects/')
      || p === '/api/environments' || p.startsWith('/api/environments/')) {
    try {
      if (p === '/api/projects' && method === 'GET') return sendJson(res, 200, projects.listProjects());
      if (p === '/api/projects' && method === 'POST') {
        const project = projects.createProject(await readBody(req));
        broadcast('all');
        return sendJson(res, 200, project);
      }
      const contextMatch = p.match(/^\/api\/projects\/([^/]+)\/context$/);
      if (contextMatch && method === 'GET') {
        return sendJson(res, 200, await projects.getProjectContext(contextMatch[1]));
      }
      const projectMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === 'POST') {
        const project = projects.patchProject(projectMatch[1], await readBody(req));
        broadcast('all');
        return sendJson(res, 200, project);
      }
      if (projectMatch && method === 'DELETE') {
        projects.deleteProject(projectMatch[1]);
        broadcast('all');
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/environments' && method === 'GET') return sendJson(res, 200, environments.listEnvironments());
      if (p === '/api/environments' && method === 'POST') {
        const environment = environments.saveEnvironment(await readBody(req));
        broadcast('all');
        return sendJson(res, 200, environment);
      }
      const environmentMatch = p.match(/^\/api\/environments\/([^/]+)$/);
      if (environmentMatch && method === 'DELETE') {
        environments.deleteEnvironment(environmentMatch[1]);
        broadcast('all');
        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404) {
        return sendJson(res, error.statusCode, { error: error.message });
      }
      if (error.message === 'JSON tidak valid') return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }

  // ---- katalog model gateway (UI) ----
  // Pilih model tanpa buka web: bila key untuk provider itu sudah tersimpan dan
  // bisa dipakai, aktifasi cukup lewat /api/models/activate.
  if (p === '/api/models' && method === 'GET') {
    return sendJson(res, 200, { models: listModelChoices(), pool: poolStatus() });
  }
  if (p === '/api/models/activate' && method === 'POST') {
    try {
      const entry = activateModel(await readBody(req));
      broadcast('keys');
      return sendJson(res, 200, { ok: true, entry });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 409) {
        return sendJson(res, error.statusCode, { error: error.message });
      }
      throw error;
    }
  }

  // ---- context folder aktif (branch git untuk chip composer) ----
  if (p === '/api/context' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    const cwd = url.searchParams.get('cwd');
    try {
      if (projectId) return sendJson(res, 200, await projects.getProjectContext(projectId));
      return sendJson(res, 200, await projects.contextForCwd(cwd || ''));
    } catch (error) {
      if (error.statusCode === 404) return sendJson(res, 404, { error: error.message });
      throw error;
    }
  }

  // ---- tunnel internet (opsional, untuk akses via data seluler) ----
  if (p === '/api/tunnel' && method === 'GET') {
    return sendJson(res, 200, tunnelStatus());
  }
  if (p === '/api/tunnel' && method === 'POST') {
    const b = await readBody(req);
    if (typeof b.cloudflaredPath === 'string') {
      config.cloudflaredPath = b.cloudflaredPath.trim().slice(0, 300);
      saveConfig(config);
    }
    let st;
    if (b.enabled === false) {
      st = stopTunnel();
    } else if (b.enabled === true) {
      st = startTunnel({ port: config.port, cloudflaredPath: config.cloudflaredPath });
    } else {
      st = tunnelStatus();
    }
    broadcast('config');
    return sendJson(res, 200, st);
  }

  // ---- promo ----
  if (p === '/api/promo/refresh' && method === 'POST') {
    const shared = !!promoRun;
    try {
      const r = await refreshPromoOnce();
      return sendJson(res, 200, {
        ok: true, shared, state: promoState, ...r, snapshot: readJson('snapshot.json', null),
      });
    } catch (error) {
      return sendJson(res, 502, { ok: false, state: promoState, error: String(error.message || error) });
    }
  }

  // ---- promo pass (kartu klaim → Start Plan) ----
  // Aksi mengembalikan state publik yang sama dengan /api/state supaya UI bisa
  // merender ulang tanpa menebak hasil transisi.
  if (p === '/api/promo/pass' && method === 'GET') {
    return sendJson(res, 200, publicPass(loadPass()));
  }
  if (p.startsWith('/api/promo/pass/') && method === 'POST') {
    const action = p.slice('/api/promo/pass/'.length);
    try {
      const pass = loadPass();
      let body = {};
      if (action !== 'claim' && action !== 'upgrade' && action !== 'share') body = await readBody(req);
      if (action === 'claim') { claimPass(pass); recordFeature('promo'); }
      else if (action === 'dismiss') dismissPass(pass, body.dismissed !== false);
      else if (action === 'toggle') togglePassModel(pass, body.model, body.enabled !== false);
      else if (action === 'add-model') addPassModel(pass, body.model);
      else if (action === 'rename') renamePassModel(pass, body.model, body.label);
      else if (action === 'upgrade') upgradePass(pass);
      else if (action === 'share') {
        markShared(pass);
        broadcast('promoPass');
        return sendJson(res, 200, { ok: true, text: shareText(pass), pass: publicPass(pass) });
      } else {
        return sendJson(res, 404, { error: `Aksi promo tidak dikenal: ${action}`, code: 'ACTION_UNKNOWN' });
      }
      broadcast('promoPass');
      return sendJson(res, 200, { ok: true, pass: publicPass(pass) });
    } catch (error) {
      if (error.message === 'JSON tidak valid') {
        return sendJson(res, 400, { error: error.message, code: 'BAD_JSON' });
      }
      if (error.statusCode) {
        return sendJson(res, error.statusCode, { error: error.message, code: error.code || 'PASS_ERROR' });
      }
      throw error;
    }
  }

  // ---- api keys ----
  if (p === '/api/keys' && method === 'POST') {
    const b = await readBody(req);
    if (!b.key || (!b.baseUrl && !PRESETS[b.preset]?.baseUrl)) {
      return sendJson(res, 400, { error: 'Key dan baseUrl wajib diisi' });
    }
    if (b.format !== undefined && !API_FORMATS.includes(b.format)) {
      return sendJson(res, 400, { error: 'Format API tidak dikenal' });
    }
    // Nilai "sk-…abcd" adalah mask tampilan, bukan key. Menyimpannya menghasilkan
    // key palsu yang selalu gagal saat agent memanggil — tolak di sini.
    if (isMaskedKey(b.key)) {
      return sendJson(res, 400, { error: 'Itu mask tampilan, bukan key. Tempel key utuh dari provider.' });
    }
    // Key baru langsung masuk pool (bisa dimatikan di Pengaturan). Ini yang
    // membuat promo gratis langsung terpakai agent lewat /v1 tanpa langkah
    // tambahan: simpan key → siap dipanggil.
    if (b.pool === undefined) b.pool = config.autoPool !== false;
    let entry;
    try {
      entry = addKey(b);
    } catch (error) {
      // Preset pensiun / input tidak sah: jawab 4xx, bukan 500.
      return sendJson(res, error.statusCode || 400, { error: error.message });
    }
    await checkKey(entry.id).catch(() => {});
    recordFeature('keys');
    broadcast('keys');
    return sendJson(res, 200, { ok: true, entry: listKeys().find((k) => k.id === entry.id) });
  }
  if ((m = p.match(/^\/api\/keys\/([a-f0-9]+)\/check$/)) && method === 'POST') {
    markKeyChecking(m[1]);
    broadcast('keys');
    try { await checkKey(m[1]); } finally { broadcast('keys'); }
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/keys\/([a-f0-9]+)$/)) && method === 'DELETE') {
    removeKey(m[1]);
    broadcast('keys');
    return sendJson(res, 200, { ok: true });
  }

  // ---- agents ----
  if (p === '/api/agents' && method === 'POST') {
    const b = await readBody(req);
    if (b.type === 'openai' && !b.baseUrl) return sendJson(res, 400, { error: 'baseUrl wajib untuk tipe openai' });
    if (b.type !== 'openai' && !b.url) return sendJson(res, 400, { error: 'URL webhook wajib diisi' });
    const entry = addAgent(b);
    await checkAgent(entry.id).catch(() => {});
    broadcast('agents');
    return sendJson(res, 200, { ok: true, entry: listAgents().find((a) => a.id === entry.id) });
  }
  if ((m = p.match(/^\/api\/agents\/([a-f0-9]+)\/check$/)) && method === 'POST') {
    markAgentChecking(m[1]);
    broadcast('agents');
    try {
      const { entry } = await checkAgent(m[1]);
      broadcast('agents');
      return sendJson(res, 200, { ok: true, status: entry.status, statusText: entry.statusText });
    } catch (e) { broadcast('agents'); throw e; }
  }
  // kirim pulse ke semua konektor sekaligus (panel Pulse di Settings).
  // Tidak menahan HTTP sampai semua probe selesai — jawab langsung,
  // hasil mengalir lewat SSE scope 'agents'.
  if (p === '/api/agents/check-all' && method === 'POST') {
    if (!listAgents().length) return sendJson(res, 200, { ok: true, checked: 0 });
    checkAllAgents().then(() => broadcast('agents')).catch(() => {});
    return sendJson(res, 200, { ok: true, started: true, count: listAgents().length });
  }
  if ((m = p.match(/^\/api\/agents\/([a-f0-9]+)\/trigger$/)) && method === 'POST') {
    markAgentChecking(m[1], 'triggering');
    broadcast('agents');
    try {
      const { entry, res: r } = await checkAgent(m[1], true);
      broadcast('agents');
      return sendJson(res, 200, { ok: true, status: entry.status, statusText: entry.statusText, response: r.text });
    } catch (e) { broadcast('agents'); throw e; }
  }
  if ((m = p.match(/^\/api\/agents\/([a-f0-9]+)$/)) && method === 'DELETE') {
    removeAgent(m[1]);
    broadcast('agents');
    return sendJson(res, 200, { ok: true });
  }

  // ---- alerts ----
  if (p === '/api/alerts/read' && method === 'POST') {
    alerts = alerts.map((a) => ({ ...a, read: true }));
    writeJson('alerts.json', alerts);
    broadcast('alerts');
    return sendJson(res, 200, { ok: true });
  }

  // ---- gateway pool (kompatibel OpenAI untuk agent) ----
  if (p === '/v1/chat/completions' && method === 'POST') {
    const b = await readBody(req);
    recordFeature('gateway');
    const r = await routeChat(b);
    if (r.type === 'stream') {
      res.writeHead(r.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      Readable.fromWeb(r.webStream).pipe(res);
      return;
    }
    if (r.type === 'error') {
      return sendJson(res, r.status, {
        error: { message: 'Semua provider pool gagal/kuota habis', type: 'pool_exhausted', attempts: r.attempts },
      });
    }
    res.writeHead(r.status, { 'content-type': 'application/json', 'x-served-by': encodeURIComponent(r.servedBy), 'x-served-model': encodeURIComponent(r.model) });
    return res.end(r.body);
  }
  if (p === '/v1/models' && method === 'GET') {
    return sendJson(res, 200, { object: 'list', data: poolModels() });
  }

  // ---- pool API (UI) ----
  if (p === '/api/pool/test' && method === 'POST') {
    const r = await testPool();
    broadcast('pool');
    return sendJson(res, 200, r);
  }
  if ((m = p.match(/^\/api\/keys\/([a-f0-9]+)\/pool$/)) && method === 'POST') {
    const b = await readBody(req);
    setPool(m[1], b);
    broadcast('keys');
    return sendJson(res, 200, { ok: true });
  }

  // ---- studio: engines, threads, tasks ----
  if (p === '/api/engines' && method === 'GET') {
    return sendJson(res, 200, await listEngines(url.searchParams.get('refresh') === '1'));
  }
  if (p === '/api/threads' && method === 'GET') return sendJson(res, 200, threads.listThreads());

  // ---- pencarian global (thread, tugas, catatan, proyek) ----
  // Read-only dan tidak menambah indeks; UI memanggilnya dari kotak cari sidebar.
  if (p === '/api/search' && method === 'GET') {
    return sendJson(res, 200, searchAll(url.searchParams.get('q') || '', {
      limit: Number(url.searchParams.get('limit') || 8),
    }));
  }
  if (p === '/api/threads' && method === 'POST') {
    const b = await readBody(req);
    // Folder kerja tervalidasi di sini, bukan saat run mulai: thread tidak boleh
    // menyimpan path yang tidak ada dan UI tidak boleh menampilkan workspace palsu.
    if (b.cwd) {
      try { b.cwd = resolveWorkspace(b.cwd); } catch (error) {
        return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
      }
    }
    const t = threads.createThread(b);
    if (t.cwd) watchWorkspace(t.cwd);
    broadcast('threads');
    return sendJson(res, 200, t);
  }
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)$/))) {
    if (method === 'GET') {
      const t = threads.getThread(m[1]);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    }
    if (method === 'POST') {
      // patch terbatas: judul, pin, dan folder kerja (bukan pesan/meta run — itu milik run)
      const b = await readBody(req);
      const patch = {};
      if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 80);
      if (typeof b.pinned === 'boolean') patch.pinned = b.pinned;
      if (typeof b.cwd === 'string' && b.cwd.trim()) {
        try { patch.cwd = resolveWorkspace(b.cwd); } catch (error) {
          return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
        }
      }
      if (Array.isArray(b.tags)) patch.tags = threads.sanitizeTags(b.tags);
      if (typeof b.systemPrompt === 'string') patch.systemPrompt = b.systemPrompt.trim().slice(0, 4000) || null;
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'Tidak ada yang bisa diubah' });
      const t = threads.patchThread(m[1], patch);
      broadcast('threads');
      return sendJson(res, 200, t);
    }
    if (method === 'DELETE') {
      threads.deleteThread(m[1]);
      // Checkpoint milik thread ikut dibersihkan: ref git yatim membuat objek
      // snapshot tidak pernah bisa dijangkau lagi oleh pemulihan mana pun.
      await checkpoints.pruneCheckpoints(threads.listThreads().map((t) => t.id)).catch(() => {});
      broadcast('threads');
      return sendJson(res, 200, { ok: true });
    }
  }

  // statistik sesi — dihitung dari pesan nyata; nilai yang tidak dilaporkan
  // engine (CLI hanya total) tetap null, bukan 0 palsu.
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/stats$/)) && method === 'GET') {
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    const msgs = (t.messages || []).filter((msg) => !msg.subrun);
    const count = (role) => msgs.filter((msg) => msg.role === role).length;
    const sum = (get) => msgs.reduce((acc, msg) => acc + (Number(get(msg)) || 0), 0);
    const model = [...msgs].reverse().find((msg) => msg.model)?.model || null;
    const engines = [...new Set(msgs.map((msg) => msg.engine).filter(Boolean))];
    return sendJson(res, 200, {
      id: t.id,
      title: t.title,
      engine: t.engine || engines[0] || null,
      model,
      messages: msgs.length,
      userMessages: count('user'),
      assistantMessages: count('assistant'),
      totalTokens: sum((msg) => msg.usage?.total_tokens ?? msg.tokens) || null,
      inputTokens: sum((msg) => msg.usage?.prompt_tokens) || null,
      outputTokens: sum((msg) => msg.usage?.completion_tokens) || null,
      reasoningTokens: sum((msg) => msg.usage?.completion_tokens_details?.reasoning_tokens) || null,
      cachedTokens: sum((msg) => msg.usage?.prompt_tokens_details?.cached_tokens) || null,
      context: contextStats({ model, msgs, snapshot: readJson('snapshot.json', null) }),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }

  // ekspor percakapan sebagai markdown
  // ---- bagikan thread (REA ZCode: conversationShare) ----
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/share$/)) && method === 'POST') {
    try {
      const b = await readBody(req);
      const t = threads.getThread(m[1]);
      if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
      const s = share.createShare(m[1], { days: Number(b.days) || 7, title: t.title });
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const host = String(req.headers.host || `localhost:${config.port}`);
      broadcast('threads');
      return sendJson(res, 200, { ...s, url: `${proto}://${host}/share/${s.id}` });
    } catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }
  }
  if (p === '/api/shares' && method === 'GET') return sendJson(res, 200, share.listShares());
  if ((m = p.match(/^\/api\/shares\/([a-f0-9]+)\/revoke$/)) && method === 'POST') {
    if (!share.revokeShare(m[1])) return sendJson(res, 404, { error: 'Tautan tidak ditemukan' });
    broadcast('threads');
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/shares\/([a-f0-9]+)$/)) && method === 'DELETE') {
    if (!share.deleteShare(m[1])) return sendJson(res, 404, { error: 'Tautan tidak ditemukan' });
    broadcast('threads');
    return sendJson(res, 200, { ok: true });
  }

  // ekspor percakapan: markdown siap-baca (?format=md) atau JSON lengkap
  // (?format=json) untuk arsip/migrasi.
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/export$/)) && method === 'GET') {
    const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'md';
    try {
      const body = threads.exportThread(m[1], fmt);
      const t = threads.getThread(m[1]);
      const base = `agenthub-${(t?.title || m[1]).replace(/[^\w-]+/g, '_').slice(0, 40) || m[1]}`;
      res.writeHead(200, {
        'content-type': fmt === 'json'
          ? 'application/json; charset=utf-8'
          : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${base}.${fmt}"`,
      });
      return res.end(body);
    } catch (error) {
      return sendJson(res, error.statusCode || 404, { error: error.message });
    }
  }

  // fork/cabang percakapan: salin isi thread sampai pesan acuan, thread asli
  // utuh. Mode include=false untuk alur "edit pesan" di UI.
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/fork$/)) && method === 'POST') {
    try {
      const b = await readBody(req);
      const t = threads.forkThread(m[1], {
        until: typeof b.until === 'string' ? b.until : null,
        include: b.include !== false,
        title: typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 80) : null,
      });
      broadcast('threads');
      return sendJson(res, 200, { id: t.id, title: t.title, messages: t.messages?.length || 0 });
    } catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }
  }

  // Validasi folder kerja bebas tanpa membuat thread atau menyentuh disk.
  // Dipakai pemilih folder di UI supaya path salah ditolak sebelum disimpan.
  if (p === '/api/workspace/check' && method === 'GET') {
    try {
      const dir = resolveWorkspace(url.searchParams.get('cwd') || '');
      return sendJson(res, 200, { ok: true, cwd: dir });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
  }

  // daftar file/folder untuk @ mention di composer (read-only, tanpa isi file)
  if (p === '/api/files' && method === 'GET') {
    const cwd = url.searchParams.get('cwd') || '';
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const dir = path.resolve(cwd.trim());
    if (!cwd.trim() || !path.isAbsolute(dir) || !fs.existsSync(dir)) {
      return sendJson(res, 400, { error: 'cwd folder valid wajib diisi' });
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      return sendJson(res, 400, { error: `Folder tidak bisa dibaca: ${e.message}` });
    }
    const rows = entries
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git' && e.name.toLowerCase().includes(q))
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name))
      .slice(0, 200)
      .map((e) => {
        const full = path.join(dir, e.name);
        const rel = path.relative(dir, full);
        return { name: e.name, dir: e.isDirectory(), rel, path: full };
      });
    return sendJson(res, 200, { cwd: dir, entries: rows });
  }

  // ---- lampiran file/gambar ----
  // JSON + base64, tanpa dependensi multipart. Metadata disimpan di uploads.json;
  // nama file selalu di-basename-kan agar tidak bisa keluar dari folder uploads.
  if (p === '/api/uploads' && method === 'POST') {
    let b;
    try { b = await readBody(req, 12 * 1024 * 1024); } catch {
      return sendJson(res, 413, { error: 'Lampiran terlalu besar', code: 'UPLOAD_TOO_LARGE' });
    }
    try { return sendJson(res, 200, publicUpload(saveUpload(b))); } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
  }
  if ((m = p.match(/^\/api\/uploads\/([a-f0-9]+)$/))) {
    if (method === 'GET') {
      const r = readUpload(m[1]);
      if (!r) return sendJson(res, 404, { error: 'Lampiran tidak ditemukan' });
      // Hanya gambar aman yang boleh inline; selain itu dipaksa unduh agar
      // file HTML/SVG tidak dieksekusi di origin aplikasi.
      const inline = isInlineImage(r.meta);
      res.writeHead(200, {
        'content-type': r.meta.type,
        'content-length': r.meta.bytes,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${r.meta.name.replace(/"/g, '')}"`,
      });
      return res.end(r.buffer);
    }
    if (method === 'DELETE') {
      const ok = deleteUpload(m[1]);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Lampiran tidak ditemukan' });
    }
  }

  // ---- workspace thread: ringkasan, diff, revert, aturan proyek ----
  // Workspace hidup di thread, jadi dua tab yang membuka thread berbeda tidak
  // saling menimpa folder kerja (bug yang muncul saat cwd hanya di localStorage).
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/(workspace|diff)$/)) && method === 'GET') {
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    if (!t.cwd) {
      return sendJson(res, 200, {
        cwd: null, repo: false, branch: null, changes: 0, files: [],
        patch: '', truncated: false, rules: [],
      });
    }
    let dir;
    try { dir = resolveWorkspace(t.cwd); } catch (error) {
      return sendJson(res, 409, { error: error.message, code: 'WORKSPACE_MISSING' });
    }
    // drawer Perubahan dibuka → pasang watcher agar perubahan berkas
    // mendorong pembaruan otomatis lewat SSE scope 'workspace'.
    watchWorkspace(dir);
    const rules = listRules(dir);
    if (m[2] === 'workspace') return sendJson(res, 200, { ...(await workspaceSummary(dir)), rules });
    return sendJson(res, 200, { ...(await diffReport(dir)), rules });
  }

  // revert eksplisit per file. File baru hanya dihapus bila pemanggil menyatakan
  // deleteUntracked=true — permintaan revert biasa tidak pernah menghapus file.
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/revert$/)) && method === 'POST') {
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    if (!t.cwd) return sendJson(res, 400, { error: 'Thread belum punya folder kerja', code: 'WORKSPACE_MISSING' });
    const b = await readBody(req);
    let dir;
    try { dir = resolveWorkspace(t.cwd); } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
    try {
      const r = await revertPaths(dir, b.paths, { deleteUntracked: b.deleteUntracked === true });
      broadcast('threads');
      return sendJson(res, 200, { ok: true, ...r });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
  }

  // tulis aturan proyek (AGENTS.md / CLAUDE.md / …) — satu-satunya file yang
  // boleh ditulis di luar mekanisme agent.
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/rules$/)) && method === 'POST') {
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    if (!t.cwd) return sendJson(res, 400, { error: 'Thread belum punya folder kerja', code: 'WORKSPACE_MISSING' });
    let dir;
    try { dir = resolveWorkspace(t.cwd); } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
    const b = await readBody(req);
    try {
      writeRule(dir, b.file, b.content);
      return sendJson(res, 200, { ok: true, rules: listRules(dir) });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
  }

  // ---- checkpoint berkas (REA ZCode git checkpoint) ----
  // Snapshot diambil sebelum agent menulis; rute ini yang memulihkannya.
  if (p.startsWith('/api/threads/') && p.includes('/checkpoints')) {
    try {
      if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/checkpoints$/)) && method === 'GET') {
        const t = threads.getThread(m[1]);
        if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
        return sendJson(res, 200, { checkpoints: checkpoints.listCheckpoints(m[1]) });
      }
      if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/checkpoints$/)) && method === 'POST') {
        const t = threads.getThread(m[1]);
        if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
        if (!t.cwd) return sendJson(res, 400, { error: 'Thread belum punya folder kerja', code: 'WORKSPACE_MISSING' });
        const b = await readBody(req);
        const dir = resolveWorkspace(t.cwd);
        const cp = await checkpoints.createCheckpoint(m[1], dir, { label: b.label || 'manual' });
        return sendJson(res, 200, cp);
      }
      if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/checkpoints\/([a-f0-9]+)\/diff$/)) && method === 'GET') {
        // `:id` adalah checkpoint tujuan; `?from=` checkpoint pembandingnya.
        const from = url.searchParams.get('from');
        if (!from) return sendJson(res, 400, { error: 'Parameter `from` wajib diisi' });
        return sendJson(res, 200, await checkpoints.diffCheckpoints(from, m[2]));
      }
      if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/checkpoints\/([a-f0-9]+)\/restore$/)) && method === 'POST') {
        const t = threads.getThread(m[1]);
        if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
        const b = await readBody(req);
        const r = await checkpoints.restoreCheckpoint(m[1], {
          fromId: b.fromId || null,
          toId: m[2],
          paths: Array.isArray(b.paths) ? b.paths : null,
          force: b.force === true,
        });
        if (!r.ok) {
          return sendJson(res, 409, {
            error: 'Berkas berubah sejak checkpoint dibuat — tinjau konflik sebelum memulihkan',
            code: 'CHECKPOINT_CONFLICT', conflicts: r.conflicts,
          });
        }
        // Perubahan berkas menarik watcher workspace agar UI memuat ulang diff.
        if (t.cwd) { try { watchWorkspace(resolveWorkspace(t.cwd)); } catch { /* folder hilang */ } }
        broadcast('workspace');
        return sendJson(res, 200, r);
      }
      if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/checkpoints\/([a-f0-9]+)$/)) && method === 'DELETE') {
        return sendJson(res, 200, { ok: await checkpoints.deleteCheckpoint(m[2]) });
      }
      return sendJson(res, 404, { error: 'Rute checkpoint tidak dikenal' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }

  // kirim prompt: respons SSE (delta / done / error)
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/send$/)) && method === 'POST') {
    const b = await readBody(req);
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    const engineId = b.engine || t.engine || 'pool';

    // Workspace: kiriman membawa cwd (chip folder) → dipakai & disimpan ke thread.
    // Tanpa itu, thread memakai folder yang terakhir ia pakai, bukan folder tab lain.
    let workspace;
    try {
      workspace = b.cwd ? resolveWorkspace(b.cwd) : (t.cwd ? resolveWorkspace(t.cwd) : undefined);
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }

    // Lampiran divalidasi sebelum run dimulai: id yang tidak dikenal tidak boleh
    // meninggalkan pesan user setengah jadi di thread.
    const ids = Array.isArray(b.attachments)
      ? [...new Set(b.attachments.filter((x) => typeof x === 'string' && x.trim()))]
      : [];
    if (ids.length > MAX_ATTACHMENTS) {
      return sendJson(res, 400, {
        error: `Maksimal ${MAX_ATTACHMENTS} lampiran per pesan`, code: 'ATTACHMENT_LIMIT',
      });
    }
    const attachments = [];
    for (const id of ids) {
      const meta = getUpload(id);
      if (!meta) {
        return sendJson(res, 400, { error: 'Lampiran tidak ditemukan atau sudah dihapus', code: 'ATTACHMENT_INVALID' });
      }
      attachments.push(meta);
    }

    // Satu run per thread. Dua kiriman paralel (tab lain / agent) ditolak
    // sebelum ada pesan yang ditulis, supaya urutan percakapan tidak rusak.
    try { runs.begin(m[1]); } catch (error) {
      return sendJson(res, error.statusCode || 409, {
        error: error.message, code: error.code, machine: error.machine,
        from: error.from, to: error.to, allowed: error.allowed,
      });
    }

    const rawPrompt = String(b.prompt || '').slice(0, 16000);
    const kind = engineType(engineId);
    recordFeature('chat', { engine: engineId });
    // Perintah dari plugin: `/nama argumen` diperluas menjadi isi
    // commands/<nama>.md sebelum apa pun dikirim. Teks asli yang user ketik tetap
    // tersimpan di thread, jadi ia melihat apa yang ia tulis — bukan instruksi
    // panjang hasil perluasan.
    const pluginCommand = pluginsLib.expandCommand(rawPrompt);
    const basePrompt = pluginCommand ? pluginCommand.body : rawPrompt;
    // CLI punya akses disk → beri path. Pool tidak → inline isi teksnya.
    let modelPrompt = attachments.length
      ? await augmentPrompt(basePrompt, attachments, {
        includePaths: kind !== 'pool',
        inlineText: kind === 'pool',
      })
      : basePrompt;
    // Memori jangka panjang disuntikkan di server (bukan UI) supaya SEMUA
    // jalur kirim — UI, API langsung, maupun agent eksternal — mendapat konteks
    // yang sama. Prompt yang terlihat user di chat tetap tanpa blok memori.
    if (config.memoryEnabled !== false) {
      const mem = memory.memoryContext();
      if (mem) modelPrompt = mem + '\n\n---\n\n' + modelPrompt;
    }

    // Instruksi tetap: AGENTS.md level user, aturan proyek, lalu instruksi
    // thread. Ketiganya dulu tersimpan tetapi tidak pernah sampai ke model.
    const instructions = instructionsLib.buildInstructions({ cwd: workspace, systemPrompt: t.systemPrompt });
    if (instructions.text) modelPrompt = `${instructions.text}\n\n---\n\n${modelPrompt}`;

    // UserPromptSubmit: kesempatan terakhir mengubah atau menolak prompt sebelum
    // model melihatnya. Ditolak berarti run tidak dimulai dan pesan user tidak
    // ditulis — supaya percakapan tidak menyimpan pertanyaan yang tak pernah dijawab.
    let promptHook = null;
    try {
      promptHook = await hooks.runEvent('UserPromptSubmit', {
        prompt: modelPrompt, raw_prompt: rawPrompt, cwd: workspace,
      }, { cwd: workspace });
    } catch { promptHook = null; }
    if (promptHook?.denied) {
      runs.finish(m[1], 'stopped');
      return sendJson(res, 403, {
        error: `Prompt ditolak hook: ${promptHook.reason || 'tanpa alasan'}`,
        code: 'PROMPT_BLOCKED',
      });
    }
    if (promptHook?.updatedInput?.prompt) modelPrompt = String(promptHook.updatedInput.prompt);
    if (promptHook?.additionalContext) modelPrompt += `\n\n[konteks tambahan dari hook]\n${promptHook.additionalContext}`;

    const userMsg = threads.appendMessage(m[1], {
      role: 'user',
      content: rawPrompt,
      engine: engineId,
      ...(attachments.length ? { attachments: attachments.map(publicUpload) } : {}),
      // modelContent = prompt persis yang dikirim ke engine (lampiran inline
      // + blok memori). Penting untuk audit: user melihat teks bersih,
      // thread merekam apa yang sebenarnya diterima model.
      ...(modelPrompt !== rawPrompt ? { modelContent: modelPrompt } : {}),
    });
    threads.patchThread(m[1], { engine: engineId, ...(workspace ? { cwd: workspace } : {}) });
    // Riwayat sebelum pesan ini; builder di harness yang memilih & membatasi.
    const history = (threads.getThread(m[1])?.messages || []).filter((x) => x.id !== userMsg.id);
    broadcast('threads');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    // Flush header segera: tanpa ini fetch klien baru selesai saat token pertama
    // datang, sehingga chip lampiran dan status "mengirim" terlihat menggantung
    // selama engine CLI yang lambat start.
    res.write(': connected\n\n');
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Client putus (tab ditutup / jaringan hilang) → hentikan proses agar tidak
    // menggantung 10 menit dan tidak menahan thread dalam status running.
    // Pakai `res` (bukan `req`): 'close' pada req bisa menyala begitu body selesai
    // dibaca, yang akan membatalkan setiap run tepat setelah dimulai.
    const ctrl = new AbortController();
    const unregister = runs.registerStop(m[1], () => ctrl.abort());
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

    try {
      let acc = '';
      // Tool-calling hanya untuk engine pool: engine CLI mengelola tool-nya
      // sendiri. Default aktif bila thread punya folder kerja — tanpa folder,
      // tool berkas tidak ada gunanya dan model hanya akan membuang putaran.
      const useTools = engineType(engineId) === 'pool'
        && !!workspace
        && b.tools !== false;

      // Snapshot sebelum agent menyentuh berkas. Ini satu-satunya cara memulihkan
      // hasil yang buruk tanpa ikut membuang pekerjaan pengguna yang belum
      // di-commit. Gagal membuat snapshot tidak boleh menggagalkan run — agent
      // hanya kehilangan kemampuan undo, bukan kemampuannya bekerja.
      let checkpointId = null;
      if (useTools && workspace && ['edit', 'guarded', 'yolo'].includes(normalizeMode(b.permission))) {
        try {
          const cp = await checkpoints.createCheckpoint(m[1], workspace, {
            label: rawPrompt.slice(0, 80) || 'sebelum run',
          });
          checkpointId = cp.id;
          send({ type: 'checkpoint', id: cp.id, files: cp.files });
        } catch { /* bukan repo git / git tidak ada: lanjut tanpa snapshot */ }
      }

      const r = await runEngine(engineId, modelPrompt, {
        cwd: workspace,
        model: b.model,
        history,
        replyLang: config.replyLang,
        effort: ['low', 'medium', 'high'].includes(b.effort) ? b.effort : undefined,
        // Mode izin dipakai dua kali: untuk flag CLI (nama lama ask/edits/plan
        // dipetakan ke flag resmi tiap CLI) dan sebagai gerbang tool di server
        // (normalizeMode memetakan ask→build, edits→edit, full→yolo). Keduanya
        // menerima nilai mentah supaya pemetaan CLI tidak ikut berubah.
        permission: PERMISSION_INPUTS.includes(b.permission) ? b.permission : undefined,
        useTools,
        signal: ctrl.signal,
        // Event tool diteruskan apa adanya ke UI: pengguna harus bisa melihat
        // tool apa yang dipanggil dan apakah ditolak, bukan hanya "Working".
        onEvent: (evt) => {
          // Event milik subagent ikut ditandai `subagent`/`agentId`: UI
          // menampilkannya di baris anak, bukan mencampurnya dengan tool induk.
          const child = evt?.subagent ? { subagent: evt.subagent, agentId: evt.agentId } : {};
          if (evt?.type === 'tools') send({ type: 'tools', names: evt.names, ...child });
          else if (evt?.type === 'subagent') {
            send({
              type: 'subagent',
              phase: evt.phase,
              agentType: evt.subagent,
              agentId: evt.agentId,
              description: String(evt.description || '').slice(0, 120),
              ok: evt.ok,
              ms: evt.durationMs,
              tokens: evt.tokens,
              toolUses: evt.toolUses,
              error: evt.error ? String(evt.error).slice(0, 200) : null,
            });
          } else if (evt?.type === 'tool_start') send({ type: 'tool', phase: 'start', name: evt.name, decision: evt.decision, reason: evt.reason, input: summarizeToolInput(evt.input), ...child });
          else if (evt?.type === 'tool_result') send({ type: 'tool', phase: 'result', name: evt.name, ok: evt.ok, ms: evt.ms, preview: String(evt.text || '').slice(0, 400), ...child });
        },
        onDelta: (chunk) => {
          acc += chunk;
          if (acc.length < 200000) send({ type: 'delta', text: chunk });
        },
      });
      if (!acc.trim()) { acc = r.text; send({ type: 'delta', text: r.text }); }
      threads.appendMessage(m[1], {
        role: 'assistant',
        engine: engineId,
        content: acc.slice(0, 200000),
        ms: r.ms,
        servedBy: r.servedBy,
        model: r.model,
        tokens: r.tokens || null,
        usage: r.usage || null,
        runStatus: 'done',
        ...(r.tools?.length ? { tools: r.tools.map((t) => ({ name: t.name, ok: t.ok, decision: t.decision })) } : {}),
        // Id snapshot dikirim ke UI supaya tombol "Pulihkan" pada pesan ini tahu
        // keadaan mana yang harus dikembalikan.
        ...(checkpointId ? { checkpointId } : {}),
      });
      // Pemakaian nyata lewat gateway mengurangi saldo promo bila modelnya
      // termasuk plan (GLM-5.3 / GLM-5.3-Flash) dan tiket sedang aktif.
      if (r.tokens) {
        try { recordUsage(loadPass(), r.model, r.tokens); } catch { /* statistik tidak boleh menggagalkan run */ }
      }
      runs.finish(m[1], 'done');
      broadcast('threads');
      // Ekstraksi memori otomatis: hanya bila diaktifkan, hanya setelah run
      // sukses, dan tidak ditunggu — pengguna sudah menerima jawabannya.
      if (config.memoryEnabled !== false && config.memoryAutoExtract === true) {
        try {
          const full = threads.getThread(m[1]);
          const cursor = memoryExtract.extractStatus(m[1])?.cursor || null;
          memoryExtract.schedule({
            threadId: m[1],
            thread: full,
            enabled: true,
            cursor,
            runStatus: 'done',
            model: b.model || 'auto',
            onDone: (rec) => {
              if (rec?.added) {
                broadcast('memory');
                toast('Memori diperbarui', `${rec.added} fakta baru dari percakapan ini`);
              }
            },
          });
        } catch { /* ekstraksi tidak boleh menyentuh run yang sudah selesai */ }
      }
      // run panjang selesai → beri tahu lewat notifikasi Windows
      if (r.ms > 15000) {
        const t = threads.getThread(m[1]);
        toast('Run selesai', `${(t?.title || 'Thread').slice(0, 60)} · ${Math.round(r.ms / 1000)} detik`);
      }
      send({ type: 'done', ms: r.ms, servedBy: r.servedBy });
    } catch (e) {
      const stopped = e.name === 'AbortError' || ctrl.signal.aborted;
      threads.appendMessage(m[1], {
        role: 'assistant',
        engine: engineId,
        content: stopped ? 'Dihentikan.' : `Gagal: ${e.message}`,
        runStatus: stopped ? 'stopped' : 'error',
      });
      runs.finish(m[1], stopped ? 'stopped' : 'error', { error: stopped ? null : e.message });
      broadcast('threads');
      send(stopped
        ? { type: 'stopped', message: 'Run dihentikan' }
        : { type: 'error', message: String(e.message || e) });
    } finally {
      unregister();
      broadcast('threads');
    }
    return res.end();
  }

  // hentikan run yang sedang berjalan di sebuah thread (idempoten)
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/stop$/)) && method === 'POST') {
    const n = runs.stop(m[1]);
    const t = threads.getThread(m[1]);
    // Run yang tercatat running tetapi prosesnya sudah tidak ada (mis. sisa
    // crash) juga disembuhkan di sini, bukan dibiarkan "Working" selamanya.
    if (t && (t.runState === 'running' || t.running)) runs.finish(m[1], 'stopped');
    if (t) broadcast('threads');
    return sendJson(res, 200, { ok: true, stopped: n });
  }

  // delegasi: satu prompt → banyak agent paralel (SSE)
  if (p === '/api/delegate' && method === 'POST') {
    const b = await readBody(req);
    const engines = Array.isArray(b.engines) ? b.engines.slice(0, 6) : [];
    if (!b.prompt || engines.length === 0) {
      return sendJson(res, 400, { error: 'prompt dan engines (min 1) wajib' });
    }
    let workspace;
    if (b.cwd) {
      try { workspace = resolveWorkspace(b.cwd); } catch (error) {
        return sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
      }
    }
    const t = threads.createThread({ title: String(b.prompt).replace(/\s+/g, ' ').slice(0, 50), projectId: b.projectId, kind: 'delegation', cwd: workspace });
    threads.appendMessage(t.id, { role: 'user', content: b.prompt });
    runs.begin(t.id);
    broadcast('threads');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const ctrl = new AbortController();
    const unregister = runs.registerStop(t.id, () => ctrl.abort());
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

    const task = tasks.createTask({ title: String(b.prompt).slice(0, 120), status: 'running', threadId: t.id, projectId: b.projectId });
    recordFeature('delegate');
    send({ type: 'start', threadId: t.id, engines, taskId: task.id });

    const outcomes = new Map();
    let outcome = 'error';
    try {
      await Promise.all(
        engines.map(async (engineId) => {
          send({ type: 'sub', engine: engineId, status: 'working' });
          threads.appendMessage(t.id, { role: 'assistant', engine: engineId, subrun: true, content: '', status: 'working' });
          try {
            let acc = '';
            const r = await runEngine(engineId, b.prompt, {
              cwd: workspace,
              replyLang: config.replyLang,
              effort: ['low', 'medium', 'high'].includes(b.effort) ? b.effort : undefined,
              permission: ['ask', 'edits', 'plan'].includes(b.permission) ? b.permission : undefined,
              signal: ctrl.signal,
              onDelta: (chunk) => {
                acc += chunk;
                if (acc.length < 100000) send({ type: 'subdelta', engine: engineId, text: chunk });
              },
            });
            threads.updateSubrun(t.id, engineId, { status: 'done', content: acc.slice(0, 100000), ms: r.ms });
            outcomes.set(engineId, 'done');
            send({ type: 'sub', engine: engineId, status: 'done', ms: r.ms });
          } catch (e) {
            const stopped = e.name === 'AbortError' || ctrl.signal.aborted;
            const status = stopped ? 'stopped' : 'error';
            threads.updateSubrun(t.id, engineId, {
              status,
              content: stopped ? 'Dihentikan.' : String(e.message || e),
            });
            outcomes.set(engineId, status);
            send({ type: 'sub', engine: engineId, status, message: String(e.message || e) });
          }
          broadcast('threads');
        })
      );

      const values = [...outcomes.values()];
      outcome = ctrl.signal.aborted || values.includes('stopped')
        ? 'stopped'
        : values.length > 0 && values.every((v) => v === 'error') ? 'error' : 'done';
    } finally {
      runs.finish(t.id, outcome, { error: outcome === 'error' ? 'Semua engine gagal' : null });
      tasks.patchTask(task.id, { status: 'review' });
      unregister();
      broadcast('threads');
      send({ type: 'done', threadId: t.id, outcome });
    }
    return res.end();
  }
  if (p === '/api/usage' && method === 'GET') return sendJson(res, 200, usageStats());

  // Statistik fitur: heatmap harian, streak, dan rincian per fitur.
  if (p === '/api/stats' && method === 'GET') {
    const days = url.searchParams.get('days');
    if (days) return sendJson(res, 200, rangeDelta(Number(days)));
    return sendJson(res, 200, usageSummary());
  }

  // cek pembaruan: bandingkan versi berjalan dengan GitHub Releases.
  // Cache 30 menit agar tidak menagih API GitHub setiap kali pane dibuka.
  // ekspor pemakaian engine sebagai CSV (dibuka dengan parameter token)
  if (p === '/api/usage.csv' && method === 'GET') {
    const rows = usageStats();
    const lines = ['engine,label,type,runs,ok,failed,avg_ms'];
    for (const u of rows) {
      lines.push([u.id, '"' + String(u.label).replace(/"/g, '""') + '"', u.type, u.runs, u.ok, u.failed, u.avgMs].join(','));
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename=agenthub-usage.csv',
    });
    return res.end(lines.join('\n'));
  }

  if (p === '/api/update-check' && method === 'GET') {
    await updateTick().catch(() => {});
    return sendJson(res, 200, updateCache.data || updateInfo(APP_VERSION, null, { error: 'belum diperiksa' }));
  }

  // ---- auto-update: status, unduh manual, pasang ----
  if (p === '/api/update' && method === 'GET') return sendJson(res, 200, updatePublic());
  if (p === '/api/update/download' && method === 'POST') {
    const info = updateCache.data;
    if (!info?.ok || !info.hasUpdate) return sendJson(res, 409, { error: 'Tidak ada versi baru untuk diunduh' });
    if (updateDl.status === 'downloading') return sendJson(res, 409, { error: 'Unduhan sedang berjalan' });
    if (updateDl.version === info.latest && updateDl.status === 'ready') {
      return sendJson(res, 409, { error: 'Sudah terunduh untuk versi ini — tinggal dipasang' });
    }
    startDownload(updateDl.status === 'error');
    return sendJson(res, 200, { ok: true, status: 'downloading' });
  }
  if (p === '/api/update/install' && method === 'POST') {
    const info = updateCache.data;
    if (!info?.ok) return sendJson(res, 409, { error: 'Info versi belum tersedia' });
    if (updateDl.status !== 'ready') return sendJson(res, 409, { error: 'Berkas installer belum siap — tunggu unduhan selesai atau panggil /api/update/download' });
    const exists = fs.existsSync(updateDl.path);
    if (!exists) return sendJson(res, 409, { error: 'Berkas installer hilang dari dist/ — unduh ulang' });
    try {
      const r = launchInstaller(updateDl.path);
      broadcast('update');
      return sendJson(res, 200, { ok: true, ...r, path: updateDl.path });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  // notes
  if (p === '/api/notes' && method === 'GET') return sendJson(res, 200, notes.listNotes());
  if (p === '/api/notes' && method === 'POST') {
    const b = await readBody(req);
    if (!b.title && !b.body) return sendJson(res, 400, { error: 'judul atau isi catatan wajib' });
    const n = notes.createNote(b);
    recordFeature('notes');
    broadcast('notes');
    return sendJson(res, 200, n);
  }
  if ((m = p.match(/^\/api\/notes\/([a-f0-9]+)$/))) {
    if (method === 'POST') {
      const b = await readBody(req);
      const n = notes.patchNote(m[1], b);
      broadcast('notes');
      return sendJson(res, 200, n);
    }
    if (method === 'DELETE') {
      notes.deleteNote(m[1]);
      broadcast('notes');
      return sendJson(res, 200, { ok: true });
    }
  }

  // prompt library
  if (p === '/api/prompts' && method === 'GET') return sendJson(res, 200, prompts.listPrompts());
  if (p === '/api/prompts' && method === 'POST') {
    const b = await readBody(req);
    try {
      const prompt = prompts.createPrompt(b);
      broadcast('prompts');
      return sendJson(res, 200, prompt);
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }
  if ((m = p.match(/^\/api\/prompts\/([a-f0-9]+)$/))) {
    if (method === 'POST') {
      const b = await readBody(req);
      try {
        const prompt = prompts.patchPrompt(m[1], b);
        broadcast('prompts');
        return sendJson(res, 200, prompt);
      } catch (e) {
        return sendJson(res, e.message === 'Prompt tidak ditemukan' ? 404 : 400, { error: String(e.message || e) });
      }
    }
    if (method === 'DELETE') {
      prompts.deletePrompt(m[1]);
      broadcast('prompts');
      return sendJson(res, 200, { ok: true });
    }
  }

  // jadwal prompt berulang (scheduled runs)
  if (p === '/api/schedules' && method === 'GET') return sendJson(res, 200, schedules.listSchedules());
  if (p === '/api/schedules' && method === 'POST') {
    const b = await readBody(req);
    if (!(await listEngines()).some((e) => e.id === b.engine)) {
      return sendJson(res, 400, { error: `Engine tidak dikenal: ${b.engine || '(kosong)'}` });
    }
    try {
      const s = schedules.createSchedule(b);
      recordFeature('schedules');
      broadcast('schedules');
      return sendJson(res, 200, s);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }
  }
  if ((m = p.match(/^\/api\/schedules\/([a-f0-9]+)$/))) {
    if (method === 'POST') {
      const b = await readBody(req);
      if (b.engine !== undefined && !(await listEngines()).some((e) => e.id === b.engine)) {
        return sendJson(res, 400, { error: `Engine tidak dikenal: ${b.engine}` });
      }
      try {
        const s = schedules.patchSchedule(m[1], b);
        broadcast('schedules');
        return sendJson(res, 200, s);
      } catch (e) {
        return sendJson(res, e.statusCode || 400, { error: e.message });
      }
    }
    if (method === 'DELETE') {
      schedules.deleteSchedule(m[1]);
      broadcast('schedules');
      return sendJson(res, 200, { ok: true });
    }
  }
  // jalankan sekarang tanpa menunggu tempo — dipakai tombol UI dan tes.
  // Eksekusi async: engine CLI bisa berjalan menit-menit, HTTP tidak boleh ikut.
  if ((m = p.match(/^\/api\/schedules\/([a-f0-9]+)\/run$/)) && method === 'POST') {
    const s = schedules.getSchedule(m[1]);
    if (!s) return sendJson(res, 404, { error: 'Jadwal tidak ditemukan' });
    executeSchedule(s);
    return sendJson(res, 200, { ok: true, started: true, name: s.name });
  }

  // ---------- orchestrator: tim agent paralel di cabang git ----------
  if (p === '/api/orchestra' && method === 'GET') return sendJson(res, 200, orchestra.listOrchestrations());
  if (p === '/api/orchestra' && method === 'POST') {
    const b = await readBody(req);
    try {
      const o = orchestra.createOrchestration(b);
      broadcast('orchestra');
      return sendJson(res, 200, o);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }
  }
  if ((m = p.match(/^\/api\/orchestra\/([a-f0-9]+)$/)) && method === 'GET') {
    const o = orchestra.getOrchestration(m[1]);
    if (!o) return sendJson(res, 404, { error: 'Orkestrasi tidak ditemukan' });
    // sertakan diff per agent (dipotong agar payload wajar)
    const agents = o.agents.map((a, i) => ({ ...a, diff: orchestra.branchDiff(m[1], i).slice(0, 60000) }));
    return sendJson(res, 200, { ...o, agents });
  }
  if ((m = p.match(/^\/api\/orchestra\/([a-f0-9]+)$/)) && method === 'DELETE') {
    orchestra.deleteOrchestration(m[1]);
    broadcast('orchestra');
    return sendJson(res, 200, { ok: true });
  }
  // jalankan tim: mirror + branch + worktree per agent, lalu engine CLI
  // berjalan PARALEL di worktree masing-masing. Hasil: commit + CI + diff,
  // state berakhir 'reviewing' saat semua selesai.
  if ((m = p.match(/^\/api\/orchestra\/([a-f0-9]+)\/run$/)) && method === 'POST') {
    const o = orchestra.getOrchestration(m[1]);
    if (!o) return sendJson(res, 404, { error: 'Orkestrasi tidak ditemukan' });
    if (o.state === 'running') return sendJson(res, 409, { error: 'Orkestrasi sedang berjalan' });
    try { orchestra.prepareOrchestration(m[1]); orchestra.prepareWorktrees(m[1]); } catch (e) {
      return sendJson(res, e.statusCode || 500, { error: e.message });
    }
    const cliAgents = o.agents.filter((a) => engineType(a.engineId) === 'cli');
    if (!cliAgents.length) {
      orchestra.patchOrchestration(m[1], { state: 'error' });
      return sendJson(res, 400, { error: 'Orchestrator butuh engine CLI (claude/codex/opencode/gemini) — pool tidak bisa mengedit berkas' });
    }
    orchestra.patchOrchestration(m[1], { state: 'running', updatedAt: Date.now() });
    o.agents.forEach((a, i) => {
      if (engineType(a.engineId) !== 'cli') {
        orchestra.updateAgent(m[1], i, { status: 'skipped', error: 'bukan engine CLI' });
        return;
      }
      orchestra.updateAgent(m[1], i, { status: 'running', error: null, diff: '', ci: null });
      const wt = orchestra.agentWorktree(m[1], i);
      const agentPrompt = a.task ? `${o.prompt}\n\nTugas khusus agent ${i + 1}:\n${a.task}` : o.prompt;
      runEngine(a.engineId, agentPrompt, { cwd: wt, replyLang: config.replyLang }).then((r) => {
        if (r.exitCode != null && r.exitCode !== 0) throw new Error(`CLI keluar dengan kode ${r.exitCode}: ${r.text.slice(-1000)}`);
        orchestra.commitAgent(m[1], i, `orchestra: ${o.name} — ${a.engineId}`);
        const ci = orchestra.runAgentCi(m[1], i);
        orchestra.updateAgent(m[1], i, {
          status: ci.ok ? 'ok' : 'ci-failed',
          ci: { ok: ci.ok, out: (ci.out || ci.err || '').slice(0, 400) },
          diff: orchestra.branchDiff(m[1], i).slice(0, 100000),
          error: ci.ok ? null : (ci.err || ci.out || '').slice(0, 300),
        });
      }).catch((e) => {
        orchestra.updateAgent(m[1], i, { status: 'error', error: String(e.message || e).slice(0, 300) });
      }).finally(() => {
        broadcast('orchestra');
        // semua selesai → masuk review
        const cur = orchestra.getOrchestration(m[1]);
        if (cur && !cur.agents.some((x) => x.status === 'running' || x.status === 'pending')) {
          orchestra.patchOrchestration(m[1], { state: 'reviewing' });
          broadcast('orchestra');
        }
      });
    });
    broadcast('orchestra');
    return sendJson(res, 200, { ok: true, started: true, agents: o.agents.length });
  }
  // merge agent yang lulus ke cabang team
  if ((m = p.match(/^\/api\/orchestra\/([a-f0-9]+)\/merge$/)) && method === 'POST') {
    try {
      const r = orchestra.mergeOrchestration(m[1]);
      broadcast('orchestra');
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, e.statusCode || 500, { error: e.message });
    }
  }
  // ekspor patch hasil gabungan (untuk diterapkan user ke repo aslinya)
  if ((m = p.match(/^\/api\/orchestra\/([a-f0-9]+)\/patch$/)) && method === 'GET') {
    const patch = orchestra.exportPatch(m[1]);
    res.writeHead(200, {
      'content-type': 'text/x-diff; charset=utf-8',
      'content-disposition': `attachment; filename="orchestra-${m[1].slice(0, 6)}.patch"`,
    });
    return res.end(patch || '(tidak ada perubahan)');
  }

  // cadangan & pulihkan
  if (p === '/api/backup' && method === 'GET') {
    const bundle = backupBundle();
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="agenthub-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }
  if (p === '/api/restore' && method === 'POST') {
    // Berkas cadangan bisa membawa ribuan pesan — batas body lebih longgar
    // daripada default 1 MB.
    const b = await readBody(req, 64 * 1024 * 1024);
    try {
      const result = restoreBackup(b);
      broadcast('all');
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }
  }

  // tasks kanban
  if (p === '/api/tasks' && method === 'GET') return sendJson(res, 200, tasks.listTasks());
  if (p === '/api/tasks' && method === 'POST') {
    const b = await readBody(req);
    if (!b.title) return sendJson(res, 400, { error: 'judul task wajib' });
    const t = tasks.createTask(b);
    recordFeature('tasks');
    broadcast('tasks');
    return sendJson(res, 200, t);
  }
  if ((m = p.match(/^\/api\/tasks\/([a-f0-9]+)$/))) {
    if (method === 'POST') {
      const b = await readBody(req);
      let t;
      try {
        t = tasks.patchTask(m[1], b);
      } catch (e) {
        if (e.code === 'ILLEGAL_TRANSITION') {
          return sendJson(res, 409, {
            error: e.message, code: e.code, from: e.from, to: e.to, allowed: e.allowed,
          });
        }
        if (e.message === 'Task tidak ditemukan') return sendJson(res, 404, { error: e.message });
        throw e;
      }
      broadcast('tasks');
      return sendJson(res, 200, t);
    }
    if (method === 'DELETE') {
      tasks.deleteTask(m[1]);
      broadcast('tasks');
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- riset web tanpa API key (DuckDuckGo html, zero-dependency) ----
  if (p === '/api/research' && (method === 'GET' || method === 'POST')) {
    try {
      const b = method === 'POST' ? await readBody(req) : {};
      const q = (b.query || url.searchParams.get('q') || '').trim();
      const limit = Number(url.searchParams.get('limit')) || b.limit || 8;
      const r = await searchWeb(q, { limit });
      recordFeature('research');
      // context siap-suntik: UI cukup menempelkan string ini ke composer
      return sendJson(res, 200, { ...r, context: researchContext(r.query, r.results) });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { error: error.message, code: error.code });
    }
  }

  // ---- memory (memori jangka panjang) ----
  if (p === '/api/memory' && method === 'GET') return sendJson(res, 200, memory.listMemory());
  if (p === '/api/memory' && method === 'POST') {
    try {
      const b = await readBody(req);
      const fact = memory.addMemory(b.text, { source: b.source === 'chat' ? 'chat' : 'manual', threadId: typeof b.threadId === 'string' ? b.threadId : null });
      broadcast('memory');
      return sendJson(res, 200, fact);
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message }); }
  }
  if (p === '/api/memory/clear' && method === 'POST') {
    memory.clearMemory();
    broadcast('memory');
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/memory\/([a-f0-9]+)$/)) && method === 'DELETE') {
    if (!memory.deleteMemory(m[1])) return sendJson(res, 404, { error: 'Fakta tidak ditemukan' });
    broadcast('memory');
    return sendJson(res, 200, { ok: true });
  }

  // ---- ekstraksi memori otomatis ----
  // Diaktifkan eksplisit: satu panggilan model tambahan per percakapan adalah
  // biaya nyata, jadi tidak boleh menyala diam-diam.
  if (p === '/api/memory/extract' && method === 'GET') {
    // Peta per-thread diratakan ke `threads`, bukan `threads.threads`: klien
    // membaca `threads[id]`, dan bentuk bersarang hanya menambah satu lapis
    // yang mudah salah dibaca.
    const overview = memoryExtract.extractOverview();
    return sendJson(res, 200, {
      enabled: config.memoryAutoExtract === true,
      running: memoryExtract.isRunning(),
      last: overview.last,
      tracked: overview.tracked,
      threads: overview.threads,
    });
  }
  if (p === '/api/memory/extract' && method === 'POST') {
    // Ekstraksi manual untuk satu thread — berguna untuk mencoba sebelum
    // menyalakan otomatis, dan untuk mengejar percakapan lama.
    try {
      const b = await readBody(req);
      const id = String(b.threadId || '');
      const t = threads.getThread(id);
      if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan', code: 'THREAD_MISSING' });
      const cursor = typeof b.threadId === 'string' ? (memoryExtract.extractStatus(id)?.cursor || null) : null;
      const r = memoryExtract.schedule({
        threadId: id,
        thread: t,
        enabled: true,
        cursor: b.all === true ? null : cursor,
        runStatus: null,
        model: b.model || 'auto',
        onDone: (rec) => {
          if (rec?.added) { broadcast('memory'); toast('Memori diperbarui', `${rec.added} fakta baru`); }
        },
      });
      return sendJson(res, 200, { ...r, threadId: id });
    } catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message, code: error.code }); }
  }
  if (p === '/api/memory/extract/reset' && method === 'POST') {
    const b = await readBody(req);
    memoryExtract.resetThread(typeof b.threadId === 'string' ? b.threadId : null);
    return sendJson(res, 200, { ok: true });
  }

  // ---- settings ----
  if (p === '/api/settings' && method === 'POST') {
    const b = await readBody(req);
    const num = (v, min, max) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
    if (typeof b.notify === 'boolean') config.notify = b.notify;
    if (typeof b.autoPool === 'boolean') config.autoPool = b.autoPool;
    if (typeof b.memoryEnabled === 'boolean') config.memoryEnabled = b.memoryEnabled;
    if (typeof b.memoryAutoExtract === 'boolean') config.memoryAutoExtract = b.memoryAutoExtract;
    if (typeof b.autoUpdate === 'boolean') config.autoUpdate = b.autoUpdate;
    if (typeof b.replyLang === 'string') config.replyLang = normalizeReplyLang(b.replyLang);
    config.refreshHours = num(b.refreshHours, 1, 168) ?? config.refreshHours;
    config.agentCheckMinutes = num(b.agentCheckMinutes, 1, 1440) ?? config.agentCheckMinutes;
    config.keyCheckHours = num(b.keyCheckHours, 1, 168) ?? config.keyCheckHours;
    const newPort = num(b.port, 1024, 65535);
    saveConfig(config);
    broadcast('config');
    return sendJson(res, 200, { ok: true, portChanged: !!newPort && newPort !== config.port, config: { ...config, token: undefined } });
  }
  if (p === '/api/settings/regenerate-token' && method === 'POST') {
    config.token = (await import('node:crypto')).randomBytes(20).toString('hex');
    saveConfig(config);
    return sendJson(res, 200, { ok: true, token: config.token, server: serverInfo() });
  }

  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });
}

// ---------- background jobs ----------
function scheduleJobs() {
  const HOUR = 3600 * 1000;
  const MIN = 60 * 1000;

  setInterval(() => {
    refreshPromoOnce().catch(() => {});
  }, Math.max(1, config.refreshHours) * HOUR);

  setInterval(() => {
    if (listAgents().length) checkAllAgents().then(() => broadcast('agents')).catch(() => {});
  }, Math.max(1, config.agentCheckMinutes) * MIN);

  setInterval(() => {
    if (listKeys().length) checkAllKeys().then(() => broadcast('keys')).catch(() => {});
  }, Math.max(1, config.keyCheckHours) * HOUR);

  // Pembaruan: cek segera setelah boot lalu tiap 6 jam. Versi baru otomatis
  // diunduh ke dist/ (bila autoUpdate aktif) — UI memberi tahu & memasang.
  setTimeout(() => updateTick().catch(() => {}), 8_000);
  setInterval(() => updateTick().catch(() => {}), 6 * HOUR);
}

// ---------- start ----------
async function main() {
  // Run yang tertinggal "running" dari proses sebelumnya tidak boleh tampil
  // sebagai pekerjaan aktif. Tandai terputus sebelum UI bisa membacanya.
  runs.recoverInterrupted();

  // Jangan menahan pembukaan UI sambil menunggu sumber internet.
  const snap = readJson('snapshot.json', null);
  const staleSnap = !snap || !snap.lastRefresh || Date.now() - snap.lastRefresh > config.refreshHours * 3600 * 1000;

  // coba port, mundur bila terpakai
  let server;
  let port = config.port;
  for (let i = 0; i < 10; i++) {
    try {
      server = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          route(req, res).catch((e) => {
            console.error('[route]', e);
            sendJson(res, 500, { error: String(e.message || e) });
          });
        });
        s.once('error', reject);
        s.listen(port, '0.0.0.0', () => resolve(s));
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE') { port += 1; server = null; continue; }
      throw e;
    }
  }
  if (!server) { console.error('Tidak ada port bebas'); process.exit(1); }
  if (port !== config.port) {
    config.port = port;
    saveConfig(config);
  }

  scheduleJobs();
  if (staleSnap) {
    refreshPromoOnce().catch((error) => {
      console.error('[promo] refresh awal gagal:', error.message);
    });
  }

  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│  AgentHub aktif                                  │');
  console.log(`│  Komputer : ${serverInfo().localUrl.padEnd(41)}│`);
  console.log(`│  HP/LAN   : ${serverInfo().phoneUrl.padEnd(41)}│`);
  console.log('└──────────────────────────────────────────────────┘');
  toast('AgentHub berjalan', `Buka di HP: ${serverInfo().lanUrl}:${config.port}`);
}

// tunnel tidak boleh ditinggal hidup setelah server mati
process.on('exit', () => { try { stopTunnel(); } catch { /* abaikan */ } });

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
