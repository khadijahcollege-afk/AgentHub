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
import { toast } from './lib/notify.js';

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
      baselined: config.baselined,
    },
    token: config.token,
    keys: listKeys(),
    keyPresets: PRESETS,
    defaultModels: DEFAULT_MODELS,
    agents: listAgents(),
    alerts,
    snapshot: snap,
    catalog: getCatalog(),
    pool: poolStatus(),
    server: serverInfo(),
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
    const entry = addKey(b);
    await checkKey(entry.id).catch(() => {});
    broadcast('keys');
    return sendJson(res, 200, { ok: true, entry: listKeys().find((k) => k.id === entry.id) });
  }
  let m;
  if ((m = p.match(/^\/api\/keys\/([a-f0-9]+)\/check$/)) && method === 'POST') {
    await checkKey(m[1]);
    broadcast('keys');
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
    const { entry } = await checkAgent(m[1]);
    broadcast('agents');
    return sendJson(res, 200, { ok: true, status: entry.status, statusText: entry.statusText });
  }
  if ((m = p.match(/^\/api\/agents\/([a-f0-9]+)\/trigger$/)) && method === 'POST') {
    const { entry, res: r } = await checkAgent(m[1], true);
    broadcast('agents');
    return sendJson(res, 200, { ok: true, status: entry.status, statusText: entry.statusText, response: r.text });
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
    threads.patchThread(m[1], { engine: engineId, running: true });
    broadcast('threads');

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      let acc = '';
      const r = await runEngine(engineId, b.prompt, {
        cwd: b.cwd,
        model: b.model,
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
      threads.patchThread(m[1], { running: false });
      broadcast('threads');
      send({ type: 'done', ms: r.ms, servedBy: r.servedBy });
    } catch (e) {
      threads.appendMessage(m[1], { role: 'assistant', engine: engineId, content: `⚠️ ${e.message}` });
      threads.patchThread(m[1], { running: false });
      broadcast('threads');
      send({ type: 'error', message: String(e.message || e) });
    }
    return res.end();
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
      const t = tasks.patchTask(m[1], b);
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
