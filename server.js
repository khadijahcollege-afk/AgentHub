// AgentHub — server lokal Windows: pantau promo API gratis, API key, dan agent.
// Nol dependency npm — hanya modul bawaan Node.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, readJson, writeJson, DATA_DIR } from './lib/store.js';
import { refreshPromo, getCatalog } from './lib/promo.js';
import { listKeys, addKey, removeKey, checkKey, checkAllKeys, setPool, PRESETS, DEFAULT_MODELS } from './lib/keys.js';
import { listAgents, addAgent, removeAgent, checkAgent, checkAllAgents } from './lib/agents.js';
import { routeChat, testPool, poolStatus, poolModels } from './lib/pool.js';
import { listEngines, runEngine, usageStats } from './lib/harness.js';
import * as threads from './lib/threads.js';
import * as tasks from './lib/tasks.js';
import * as notes from './lib/notes.js';
import { toast } from './lib/notify.js';
import {
  TASK_MACHINE, RUN_MACHINE, KEY_MACHINE, AGENT_MACHINE, CONNECTION_MACHINE,
  PROMO_MACHINE, VIEW_MACHINE, UI_MACHINE, SSE_SCOPES, VIEWS, TASK_STATUSES,
} from './lib/machines.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');
const startedAt = Date.now();

// ---------- state runtime ----------
let config = loadConfig();
let alerts = readJson('alerts.json', []);
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

// Pendaftar pembatalan run: threadId -> Set<() => void>
const runStops = new Map();

function registerRun(threadId, stop) {
  if (!runStops.has(threadId)) runStops.set(threadId, new Set());
  runStops.get(threadId).add(stop);
  return () => {
    const s = runStops.get(threadId);
    if (!s) return;
    s.delete(stop);
    if (!s.size) runStops.delete(threadId);
  };
}

export function stopRun(threadId) {
  const s = runStops.get(threadId);
  if (!s || !s.size) return 0;
  for (const stop of [...s]) { try { stop(); } catch { /* noop */ } }
  runStops.delete(threadId);
  return s.size;
}

// ---------- util ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
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
    lanIp: ip,
    localUrl: `http://127.0.0.1:${port}`,
    lanUrl: `http://${ip}:${port}`,
    phoneUrl: `http://${ip}:${port}/?token=${config.token}`,
    uptimeMs: Date.now() - startedAt,
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    startedAt,
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
    },
    token: config.token,
    keys: listKeys(),
    notes: notes.listNotes(),
    keyPresets: PRESETS,
    defaultModels: DEFAULT_MODELS,
    agents: listAgents(),
    alerts,
    snapshot: snap,
    catalog: getCatalog(),
    pool: poolStatus(),
    server: serverInfo(),
    // kontrak state machine — UI memakainya untuk tombol/label yang sah,
    // agent memakainya untuk tahu transisi apa yang diizinkan tanpa menebak.
    machines: machineContracts(),
  };
}

// Satu sumber kebenaran yang bisa dibaca mesin (AX): semua mesin + versinya.
function machineContracts() {
  return {
    version: 1,
    views: VIEWS,
    tasks: TASK_MACHINE,
    run: RUN_MACHINE,
    keys: KEY_MACHINE,
    agents: AGENT_MACHINE,
    connection: CONNECTION_MACHINE,
    promo: PROMO_MACHINE,
    ui: UI_MACHINE,
    viewsMachine: VIEW_MACHINE,
    sseScopes: SSE_SCOPES,
  };
}

// Bentuk ringkas status runtime: apa yang sedang berjalan sekarang.
// Dipakai UI untuk memulihkan tampilan "Working" setelah refresh/reconnect.
function runtimeStatus() {
  const running = threads.listThreads().filter((t) => t.running).map((t) => ({ id: t.id, kind: t.kind, title: t.title }));
  const busy = listKeys().filter((k) => k.status === 'checking').map((k) => k.id);
  return {
    runningThreads: running,
    runningCount: running.length,
    threads: threads.listThreads().length,
    tasks: tasks.listTasks().length,
    notes: notes.listNotes().length,
    tasksByStatus: TASK_STATUSES.reduce((acc, s) => {
      acc[s] = tasks.listTasks().filter((t) => t.status === s).length;
      return acc;
    }, {}),
    checkingKeys: busy,
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

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^([.][.][\\/])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Ditolak' });
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
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  // shell & aset statis terbuka (tidak ada data sensitif di dalamnya)
  if (method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  if (method === 'GET' && p.startsWith('/public/')) return serveStatic(res, p.slice('/public/'.length));
  if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, name: 'AgentHub' });

  // halaman & berkas unduhan (terbuka agar HP/komputer lain mudah mengambil)
  if (method === 'GET' && p === '/download') return serveStatic(res, 'download.html');
  if (method === 'GET' && p === '/download/setup.exe') {
    return serveDownload(res, path.join(DIST_DIR, 'AgentHub-Setup.exe'), 'AgentHub-Setup-1.2.0.exe');
  }
  if (method === 'GET' && p === '/download/portable.zip') {
    return serveDownload(res, path.join(DIST_DIR, 'AgentHub-Portable.zip'), 'AgentHub-Portable-1.2.0.zip');
  }

  if (!authorized(req, url)) {
    return sendJson(res, 401, { error: 'Token tidak valid. Buka URL dengan ?token=...' });
  }

  // ---- SSE ----
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
    return sendJson(res, 200, { name: 'AgentHub', machines: 1, views: VIEWS, taskStatuses: TASK_STATUSES });
  }

  // ---- promo ----
  if (p === '/api/promo/refresh' && method === 'POST') {
    const r = await refreshPromo(config, addAlert, broadcast);
    return sendJson(res, 200, { ok: true, ...r, snapshot: readJson('snapshot.json', null) });
  }

  // ---- api keys ----
  if (p === '/api/keys' && method === 'POST') {
    const b = await readBody(req);
    if (!b.key || (!b.baseUrl && !PRESETS[b.preset]?.baseUrl)) {
      return sendJson(res, 400, { error: 'Key dan baseUrl wajib diisi' });
    }
    // Key baru langsung masuk pool (bisa dimatikan di Pengaturan). Ini yang
    // membuat promo gratis langsung terpakai agent lewat /v1 tanpa langkah
    // tambahan: simpan key → siap dipanggil.
    if (b.pool === undefined) b.pool = config.autoPool !== false;
    const entry = addKey(b);
    await checkKey(entry.id).catch(() => {});
    broadcast('keys');
    return sendJson(res, 200, { ok: true, entry: listKeys().find((k) => k.id === entry.id) });
  }
  let m;
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
  if (p === '/api/threads' && method === 'POST') {
    const b = await readBody(req);
    const t = threads.createThread(b);
    broadcast('threads');
    return sendJson(res, 200, t);
  }
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)$/))) {
    if (method === 'GET') {
      const t = threads.getThread(m[1]);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    }
    if (method === 'DELETE') {
      threads.deleteThread(m[1]);
      broadcast('threads');
      return sendJson(res, 200, { ok: true });
    }
  }
  // kirim prompt: respons SSE (delta / done / error)
  if ((m = p.match(/^\/api\/threads\/([a-f0-9]+)\/send$/)) && method === 'POST') {
    const b = await readBody(req);
    const t = threads.getThread(m[1]);
    if (!t) return sendJson(res, 404, { error: 'Thread tidak ditemukan' });
    const engineId = b.engine || t.engine || 'pool';
    threads.appendMessage(m[1], { role: 'user', content: String(b.prompt || '').slice(0, 16000), engine: engineId });
    threads.patchThread(m[1], { engine: engineId, running: true, runStartedAt: Date.now() });
    broadcast('threads');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Client putus (tab ditutup / jaringan hilang) → hentikan proses agar tidak
    // menggantung 10 menit dan tidak menahan thread dalam status running.
    // Pakai `res` (bukan `req`): 'close' pada req bisa menyala begitu body selesai
    // dibaca, yang akan membatalkan setiap run tepat setelah dimulai.
    const ctrl = new AbortController();
    const unregister = registerRun(m[1], () => ctrl.abort());
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

    try {
      let acc = '';
      const r = await runEngine(engineId, b.prompt, {
        cwd: b.cwd,
        model: b.model,
        signal: ctrl.signal,
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
      });
      threads.patchThread(m[1], { running: false, runStartedAt: null });
      broadcast('threads');
      send({ type: 'done', ms: r.ms, servedBy: r.servedBy });
    } catch (e) {
      const stopped = e.name === 'AbortError' || ctrl.signal.aborted;
      threads.appendMessage(m[1], {
        role: 'assistant',
        engine: engineId,
        content: stopped ? '⏹️ Dihentikan.' : `⚠️ ${e.message}`,
        runStatus: stopped ? 'stopped' : 'error',
      });
      threads.patchThread(m[1], { running: false, runStartedAt: null });
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
    const n = stopRun(m[1]);
    if (threads.getThread(m[1])) {
      threads.patchThread(m[1], { running: false, runStartedAt: null });
      broadcast('threads');
    }
    return sendJson(res, 200, { ok: true, stopped: n });
  }

  // delegasi: satu prompt → banyak agent paralel (SSE)
  if (p === '/api/delegate' && method === 'POST') {
    const b = await readBody(req);
    const engines = Array.isArray(b.engines) ? b.engines.slice(0, 6) : [];
    if (!b.prompt || engines.length === 0) {
      return sendJson(res, 400, { error: 'prompt dan engines (min 1) wajib' });
    }
    const t = threads.createThread({ title: '🎯 ' + String(b.prompt).replace(/\s+/g, ' ').slice(0, 50), projectId: b.projectId, kind: 'delegation' });
    threads.appendMessage(t.id, { role: 'user', content: b.prompt });
    broadcast('threads');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const task = tasks.createTask({ title: String(b.prompt).slice(0, 120), status: 'running', threadId: t.id, projectId: b.projectId });
    send({ type: 'start', threadId: t.id, engines, taskId: task.id });

    await Promise.all(
      engines.map(async (engineId) => {
        send({ type: 'sub', engine: engineId, status: 'working' });
        threads.appendMessage(t.id, { role: 'assistant', engine: engineId, subrun: true, content: '', status: 'working' });
        try {
          let acc = '';
          const r = await runEngine(engineId, b.prompt, {
            cwd: b.cwd,
            onDelta: (chunk) => {
              acc += chunk;
              if (acc.length < 100000) send({ type: 'subdelta', engine: engineId, text: chunk });
            },
          });
          threads.updateSubrun(t.id, engineId, { status: 'done', content: acc.slice(0, 100000), ms: r.ms });
          send({ type: 'sub', engine: engineId, status: 'done', ms: r.ms });
        } catch (e) {
          threads.updateSubrun(t.id, engineId, { status: 'error', content: String(e.message || e) });
          send({ type: 'sub', engine: engineId, status: 'error', message: String(e.message || e) });
        }
        broadcast('threads');
      })
    );
    threads.patchThread(t.id, { running: false });
    tasks.patchTask(task.id, { status: 'review' });
    broadcast('threads');
    send({ type: 'done', threadId: t.id });
    return res.end();
  }
  if (p === '/api/usage' && method === 'GET') return sendJson(res, 200, usageStats());

  // notes
  if (p === '/api/notes' && method === 'GET') return sendJson(res, 200, notes.listNotes());
  if (p === '/api/notes' && method === 'POST') {
    const b = await readBody(req);
    if (!b.title && !b.body) return sendJson(res, 400, { error: 'judul atau isi catatan wajib' });
    const n = notes.createNote(b);
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

  // tasks kanban
  if (p === '/api/tasks' && method === 'GET') return sendJson(res, 200, tasks.listTasks());
  if (p === '/api/tasks' && method === 'POST') {
    const b = await readBody(req);
    if (!b.title) return sendJson(res, 400, { error: 'judul task wajib' });
    const t = tasks.createTask(b);
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

  // ---- settings ----
  if (p === '/api/settings' && method === 'POST') {
    const b = await readBody(req);
    const num = (v, min, max) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
    if (typeof b.notify === 'boolean') config.notify = b.notify;
    if (typeof b.autoPool === 'boolean') config.autoPool = b.autoPool;
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
    refreshPromo(config, addAlert, broadcast).catch(() => {});
  }, Math.max(1, config.refreshHours) * HOUR);

  setInterval(() => {
    if (listAgents().length) checkAllAgents().then(() => broadcast('agents')).catch(() => {});
  }, Math.max(1, config.agentCheckMinutes) * MIN);

  setInterval(() => {
    if (listKeys().length) checkAllKeys().then(() => broadcast('keys')).catch(() => {});
  }, Math.max(1, config.keyCheckHours) * HOUR);
}

// ---------- start ----------
async function main() {
  // refresh saat mulai bila snapshot belum ada / sudah basi
  const snap = readJson('snapshot.json', null);
  const staleSnap = !snap || !snap.lastRefresh || Date.now() - snap.lastRefresh > config.refreshHours * 3600 * 1000;
  if (staleSnap) {
    try { await refreshPromo(config, addAlert, broadcast); } catch (e) {
      console.error('[promo] refresh awal gagal:', e.message);
    }
  }

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

  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│  AgentHub aktif                                  │');
  console.log(`│  Komputer : ${serverInfo().localUrl.padEnd(41)}│`);
  console.log(`│  HP/LAN   : ${serverInfo().phoneUrl.padEnd(41)}│`);
  console.log('└──────────────────────────────────────────────────┘');
  toast('AgentHub berjalan', `Buka di HP: ${serverInfo().lanUrl}:${config.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
