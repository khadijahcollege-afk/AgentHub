// lib/mcp.js — klien Model Context Protocol (MCP).
//
// Kenapa ditulis sendiri, bukan memakai SDK: server AgentHub sengaja nol
// dependency npm (lihat README). Protokol yang dipakai di sini kecil — JSON-RPC
// 2.0 di atas newline-delimited JSON untuk stdio, dan POST JSON untuk HTTP.
// Menambah SDK berarti menambah rantai dependency yang harus diaudit, untuk
// fungsi yang bisa ditulis dalam beberapa ratus baris.
//
// Yang TIDAK dilakukan modul ini:
//   • tidak menebak tool yang tersedia — katalog berasal dari `tools/list`
//   • tidak menyembunyikan kegagalan — server yang gagal start tetap terlihat
//     sebagai status `error` dengan pesan stderr-nya
//   • tidak menjalankan apa pun saat konfigurasi dibaca; koneksi baru dibuka
//     ketika katalog atau tool benar-benar dipakai
import { spawn } from 'node:child_process';
import { readJson, writeJson } from './store.js';

const FILE = 'mcp.json';
const DEFAULT_TIMEOUT = 30000;      // handshake & tools/list
const CALL_TIMEOUT = 120000;        // satu pemanggilan tool boleh lebih lama
const CATALOG_TTL = 5 * 60 * 1000;  // katalog tool di-cache 5 menit
const MAX_OUTPUT = 200000;          // potong hasil raksasa, jangan simpan ke memori
const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, { statusCode = 400, server = null } = {}) {
    super(message);
    this.name = 'McpError';
    this.statusCode = statusCode;
    this.server = server;
  }
}

// ---------- konfigurasi ----------
// Bentuk: { servers: { nama: { type:'stdio'|'http', command, args, env, url,
//   headers, enabled, timeoutMs } } }
export function readConfig() {
  const data = readJson(FILE, null);
  const servers = data && typeof data === 'object' && data.servers && typeof data.servers === 'object'
    ? data.servers : {};
  return { servers };
}

function writeConfig(config) {
  writeJson(FILE, { servers: config.servers });
}

// Validasi ketat: konfigurasi yang salah harus ditolak dengan alasan yang bisa
// dibaca, bukan gagal saat spawn dengan pesan ENOENT yang membingungkan.
export function sanitizeServer(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new McpError('Konfigurasi server MCP harus berupa objek');
  }
  const type = String(input.type || existing?.type || 'stdio');
  if (!['stdio', 'http', 'sse'].includes(type)) {
    throw new McpError(`Transport "${type}" tidak dikenal (pakai stdio, http, atau sse)`);
  }
  const out = {
    type,
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : !!input.enabled,
    timeoutMs: Math.min(600000, Math.max(1000, Number(input.timeoutMs ?? existing?.timeoutMs) || DEFAULT_TIMEOUT)),
  };

  if (type === 'stdio') {
    const command = String(input.command ?? existing?.command ?? '').trim();
    if (!command) throw new McpError('Server stdio memerlukan perintah (command)');
    if (command.length > 500) throw new McpError('Perintah terlalu panjang');
    const args = input.args === undefined ? (existing?.args || []) : input.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new McpError('args harus berupa daftar string');
    }
    out.command = command;
    out.args = args.slice(0, 64).map((a) => a.slice(0, 2000));
    // env hanya ditambahkan, tidak menggantikan environment induk: server MCP
    // tetap butuh PATH untuk menemukan runtime-nya sendiri.
    const env = input.env === undefined ? (existing?.env || {}) : input.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      out.env = Object.fromEntries(
        Object.entries(env).slice(0, 64)
          .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')
          .map(([k, v]) => [k, v.slice(0, 4000)]),
      );
    }
    out.cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : (existing?.cwd || null);
  } else {
    const raw = String(input.url ?? existing?.url ?? '').trim();
    let url;
    try { url = new URL(raw); } catch { throw new McpError('URL server MCP tidak valid'); }
    // Kredensial di dalam URL akan tersimpan di disk dan tampil di UI.
    // Lebih baik ditolak dengan jelas daripada disimpan diam-diam.
    if (url.username || url.password) throw new McpError('Jangan taruh kredensial di URL; pakai header');
    if (!['http:', 'https:'].includes(url.protocol)) throw new McpError('URL harus http atau https');
    out.url = url.toString();
    const headers = input.headers === undefined ? (existing?.headers || {}) : input.headers;
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      out.headers = Object.fromEntries(
        Object.entries(headers).slice(0, 32)
          .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string')
          .map(([k, v]) => [k, v.slice(0, 4000)]),
      );
    }
  }
  return out;
}

// Header rahasia tidak boleh keluar lewat API dalam bentuk asli. UI hanya butuh
// tahu bahwa nilainya ADA, bukan nilainya — pola yang sama dengan mask API key.
function publicServer(name, cfg) {
  return {
    name,
    type: cfg.type,
    enabled: cfg.enabled !== false,
    timeoutMs: cfg.timeoutMs,
    command: cfg.command || null,
    args: cfg.args || [],
    url: cfg.url || null,
    cwd: cfg.cwd || null,
    headerNames: Object.keys(cfg.headers || {}),
    hasEnv: Object.keys(cfg.env || {}).length > 0,
  };
}

export function listServers() {
  const { servers } = readConfig();
  return Object.entries(servers)
    .map(([name, cfg]) => publicServer(name, cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertServer(name, input) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(clean)) {
    throw new McpError('Nama server hanya boleh huruf, angka, titik, garis bawah, dan strip (maks 48)');
  }
  const config = readConfig();
  config.servers[clean] = sanitizeServer(input, config.servers[clean] || null);
  writeConfig(config);
  closeConnection(clean);
  return publicServer(clean, config.servers[clean]);
}

export function removeServer(name) {
  const config = readConfig();
  if (!config.servers[name]) throw new McpError('Server MCP tidak ditemukan', { statusCode: 404 });
  delete config.servers[name];
  writeConfig(config);
  closeConnection(name);
  return true;
}

export function setServerEnabled(name, enabled) {
  const config = readConfig();
  const cfg = config.servers[name];
  if (!cfg) throw new McpError('Server MCP tidak ditemukan', { statusCode: 404 });
  cfg.enabled = !!enabled;
  writeConfig(config);
  closeConnection(name);
  return publicServer(name, cfg);
}

// ---------- koneksi ----------
// Satu koneksi per server, dibuka saat pertama dipakai lalu dipakai ulang.
// Tanpa ini, setiap pemanggilan tool akan men-spawn proses baru — server MCP
// yang menyimpan state (mis. browser) akan kehilangan state setiap kali.
const connections = new Map();

function truncate(text) {
  const s = String(text || '');
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (dipotong ${s.length - MAX_OUTPUT} karakter)` : s;
}

class StdioConnection {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.proc = null;
    this.tools = null;
    this.toolsAt = 0;
    this.sessionId = null;
  }

  start() {
    if (this.proc) return;
    const env = { ...process.env, ...(this.cfg.env || {}) };
    const proc = spawn(this.cfg.command, this.cfg.args || [], {
      cwd: this.cfg.cwd || process.cwd(),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    // stderr adalah diagnostik, bukan protokol. Disimpan terbatas supaya pesan
    // kegagalan server tetap bisa ditampilkan tanpa membengkakkan memori.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    proc.on('error', (error) => this.failAll(new McpError(`Server MCP "${this.name}" gagal dijalankan: ${error.message}`, { statusCode: 502, server: this.name })));
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.tools = null;
      const detail = this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : '';
      this.failAll(new McpError(`Server MCP "${this.name}" berhenti (kode ${code})${detail}`, { statusCode: 502, server: this.name }));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    // Satu baris = satu pesan JSON-RPC. Baris kosong diabaikan; server yang
    // menulis log ke stdout akan menghasilkan baris tidak sah — itu galat
    // protokol, bukan sesuatu yang boleh membuat proses mati diam-diam.
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.stderr = (this.stderr + `\nbaris bukan JSON: ${line.slice(0, 200)}`).slice(-8000); continue; }
      this.dispatch(msg);
    }
    if (this.buffer.length > MAX_OUTPUT * 2) this.buffer = this.buffer.slice(-MAX_OUTPUT);
  }

  dispatch(msg) {
    if (msg.id === undefined || msg.id === null) {
      // notifikasi dari server (mis. logging/progress): tidak ada yang menunggu
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new McpError(`MCP ${this.name}: ${msg.error.message || 'galat tidak dikenal'}`, { statusCode: 502, server: this.name }));
    else entry.resolve(msg.result);
  }

  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT) {
    this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP ${this.name}: ${method} melewati batas ${Math.round(timeoutMs / 1000)} detik`, { statusCode: 504, server: this.name }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`MCP ${this.name}: gagal menulis ke stdin (${error.message})`, { statusCode: 502, server: this.name }));
      }
    });
  }

  notify(method, params) {
    this.start();
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); } catch { /* koneksi sudah mati */ }
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    this.tools = null;
    this.failAll(new McpError(`Koneksi MCP "${this.name}" ditutup`, { statusCode: 409, server: this.name }));
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* sudah tertutup */ }
    try { proc.kill(); } catch { /* sudah mati */ }
  }
}

class HttpConnection {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.nextId = 1;
    this.tools = null;
    this.toolsAt = 0;
    this.sessionId = null;
  }

  async request(method, params, timeoutMs = DEFAULT_TIMEOUT) {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.cfg.headers || {}),
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await fetch(this.cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
        signal: controller.signal,
      });
      const session = res.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new McpError(`MCP ${this.name}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { statusCode: 502, server: this.name });
      }
      // Server boleh menjawab JSON langsung atau SSE. Keduanya sah; yang dicari
      // hanya pesan dengan id yang cocok.
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        const text = await res.text();
        for (const block of text.split(/\n\n+/)) {
          const data = block.split(/\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            const msg = JSON.parse(data);
            if (msg.id === id && !msg.error) return msg.result;
            if (msg.id === id && msg.error) throw new McpError(`MCP ${this.name}: ${msg.error.message}`, { statusCode: 502, server: this.name });
          } catch (error) {
            if (error instanceof McpError) throw error;
          }
        }
        throw new McpError(`MCP ${this.name}: tidak ada balasan untuk ${method}`, { statusCode: 502, server: this.name });
      }
      const msg = await res.json();
      if (msg.error) throw new McpError(`MCP ${this.name}: ${msg.error.message}`, { statusCode: 502, server: this.name });
      return msg.result;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new McpError(`MCP ${this.name}: ${method} melewati batas ${Math.round(timeoutMs / 1000)} detik`, { statusCode: 504, server: this.name });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  notify() { /* HTTP tidak punya kanal notifikasi terpisah */ }
  close() { this.tools = null; }
}

function connection(name) {
  const { servers } = readConfig();
  const cfg = servers[name];
  if (!cfg) throw new McpError(`Server MCP "${name}" tidak ada di konfigurasi`, { statusCode: 404 });
  if (cfg.enabled === false) throw new McpError(`Server MCP "${name}" sedang dinonaktifkan`, { statusCode: 409 });

  const existing = connections.get(name);
  if (existing) {
    // Konfigurasi bisa berubah di antara pemakaian; bandingkan bentuk publiknya
    // supaya koneksi lama tidak dipakai untuk endpoint yang sudah berbeda.
    if (JSON.stringify(existing.cfg) === JSON.stringify(cfg)) return existing;
    existing.close();
    connections.delete(name);
  }
  const conn = cfg.type === 'stdio' ? new StdioConnection(name, cfg) : new HttpConnection(name, cfg);
  connections.set(name, conn);
  return conn;
}

export function closeConnection(name) {
  const conn = connections.get(name);
  if (!conn) return false;
  conn.close();
  connections.delete(name);
  return true;
}

export function closeAll() {
  for (const [, conn] of connections) conn.close();
  connections.clear();
}

// ---------- handshake & katalog ----------
function clientInfo() {
  return { name: 'AgentHub', version: process.env.AGENTHUB_VERSION || '1.0.0' };
}

async function ensureInitialized(conn) {
  if (conn.initialized) return;
  const result = await conn.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {}, roots: { listChanged: false } },
    clientInfo: clientInfo(),
  }, conn.cfg.timeoutMs || DEFAULT_TIMEOUT);
  conn.initialized = true;
  conn.serverInfo = result?.serverInfo || null;
  conn.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
  conn.notify('notifications/initialized', {});
}

// Nama tool di MCP hanya unik per server. Di AgentHub semua tool masuk ke satu
// ruang nama, jadi prefix `mcp__<server>__` wajib — tanpa itu dua server yang
// sama-sama punya tool `search` akan saling menimpa diam-diam.
export function toolPrefix(server) {
  return `mcp__${server}__`;
}

function describeTool(server, tool) {
  return {
    name: `${toolPrefix(server)}${tool.name}`,
    server,
    tool: tool.name,
    description: String(tool.description || '').slice(0, 1000),
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

export async function listTools(name, { force = false } = {}) {
  const conn = connection(name);
  if (!force && conn.tools && Date.now() - conn.toolsAt < CATALOG_TTL) return conn.tools;
  try {
    await ensureInitialized(conn);
    const result = await conn.request('tools/list', {}, conn.cfg.timeoutMs || DEFAULT_TIMEOUT);
    const tools = Array.isArray(result?.tools) ? result.tools.map((t) => describeTool(name, t)) : [];
    conn.tools = tools;
    conn.toolsAt = Date.now();
    return tools;
  } catch (error) {
    conn.tools = null;
    throw error;
  }
}

// Katalog gabungan semua server aktif. Server yang gagal tidak menggagalkan
// seluruh katalog: kegagalannya dilaporkan per server supaya satu server mati
// tidak menyembunyikan tool dari server lain.
export async function catalog({ force = false } = {}) {
  const { servers } = readConfig();
  const results = await Promise.all(Object.entries(servers)
    .filter(([, cfg]) => cfg.enabled !== false)
    .map(async ([name]) => {
      try {
        return { name, tools: await listTools(name, { force }), error: null };
      } catch (error) {
        return { name, tools: [], error: error.message };
      }
    }));

  const tools = results.flatMap((r) => r.tools);
  return {
    servers: results.map((r) => ({ name: r.name, tools: r.tools.length, error: r.error })),
    tools,
    total: tools.length,
  };
}

export function status() {
  const { servers } = readConfig();
  return Object.entries(servers).map(([name, cfg]) => {
    const conn = connections.get(name);
    return {
      ...publicServer(name, cfg),
      connected: !!conn,
      initialized: !!conn?.initialized,
      toolCount: conn?.tools?.length ?? null,
      serverInfo: conn?.serverInfo || null,
    };
  });
}

// ---------- pemanggilan tool ----------
function parseToolName(fullName) {
  const match = /^mcp__([A-Za-z0-9._-]+)__(.+)$/.exec(String(fullName || ''));
  if (!match) throw new McpError(`Nama tool "${fullName}" bukan tool MCP`);
  return { server: match[1], tool: match[2] };
}

// Hasil MCP bisa berisi teks, gambar, atau resource. Yang dikirim ke model
// hanya teks (dan penanda untuk bagian lain) — melampirkan base64 gambar ke
// prompt akan memakan konteks berkali-kali lipat tanpa manfaat.
function normalizeContent(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'image') texts.push('[gambar dikembalikan oleh tool — tidak dikirim ke model]');
    else if (part.type === 'resource' && part.resource?.text) texts.push(String(part.resource.text));
    else if (part.type === 'resource_link') texts.push(`[resource: ${part.uri || part.name || 'tanpa nama'}]`);
  }
  if (!texts.length && result?.structuredContent) texts.push(JSON.stringify(result.structuredContent));
  return {
    text: truncate(texts.join('\n') || '(tool tidak mengembalikan teks)'),
    isError: !!result?.isError,
  };
}

export async function callTool(fullName, args = {}) {
  const { server } = parseToolName(fullName);
  const conn = connection(server);
  await ensureInitialized(conn);
  const result = await conn.request('tools/call', { name: fullName.slice(toolPrefix(server).length), arguments: args }, CALL_TIMEOUT);
  return { ...normalizeContent(result), server };
}

// ---------- definisi tool untuk model ----------
// Bentuk ini yang dikirim ke provider (OpenAI-compatible `tools`).
export async function toolDefinitions({ force = false } = {}) {
  const c = await catalog({ force });
  return c.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || `Tool dari server MCP ${t.server}`,
      parameters: t.inputSchema,
    },
  }));
}

export async function isMcpTool(name) {
  return /^mcp__[A-Za-z0-9._-]+__.+$/.test(String(name || ''));
}
