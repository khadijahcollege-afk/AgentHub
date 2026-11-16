// test/mcp.test.js — klien MCP: handshake, tools/list, tools/call, namespacing,
// pemisahan kegagalan per server, dan penyaringan rahasia dari API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-'));
process.env.AGENTHUB_DATA = dir;

const mcp = await import('../lib/mcp.js');

// Server MCP minimal yang benar-benar bicara JSON-RPC di stdio. Tes memakai
// proses nyata (bukan tiruan) supaya newline-delimited framing benar-benar diuji.
const SERVER = path.join(dir, 'server.mjs');
fs.writeFileSync(SERVER, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const TOOLS = [
  { name: 'echo', description: 'Kembalikan teks', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Selalu gagal', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Kembalikan gambar', inputSchema: { type: 'object', properties: {} } },
];
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'uji', version: '1.0.0' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') { out({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return; }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'echo') { out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] } }); return; }
    if (name === 'boom') { out({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'gagal di server' }] } }); return; }
    if (name === 'image') { out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } }); return; }
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'tool tidak ada' } });
    return;
  }
  out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'metode tidak ada' } });
});
`);

// Server yang langsung mati: kegagalannya harus terlihat, bukan menggantung.
const CRASH = path.join(dir, 'crash.mjs');
fs.writeFileSync(CRASH, `process.stderr.write('tidak bisa start'); process.exit(3);\n`);

test.after(() => {
  mcp.closeAll();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('validasi konfigurasi: transport, nama, perintah, URL', () => {
  assert.throws(() => mcp.sanitizeServer({ type: 'ajaib' }), /tidak dikenal/);
  assert.throws(() => mcp.sanitizeServer({ type: 'stdio', command: '' }), /perintah/);
  assert.throws(() => mcp.sanitizeServer({ type: 'stdio', command: 'node', args: 'bukan array' }), /daftar string/);
  assert.throws(() => mcp.sanitizeServer({ type: 'http', url: 'bukan-url' }), /URL/);
  assert.throws(() => mcp.sanitizeServer({ type: 'http', url: 'https://user:pass@host/mcp' }), /kredensial/);
  assert.throws(() => mcp.sanitizeServer({ type: 'http', url: 'ftp://host/mcp' }), /http atau https/);
  assert.throws(() => mcp.upsertServer('nama salah!', { type: 'stdio', command: 'node' }), /Nama server/);

  const ok = mcp.sanitizeServer({ type: 'stdio', command: 'node', args: ['x'], env: { BAIK: 'v', 'salah-key': 'v' } });
  assert.equal(ok.command, 'node');
  assert.deepEqual(ok.args, ['x']);
  assert.deepEqual(Object.keys(ok.env), ['BAIK'], 'nama env tidak sah dibuang');
  assert.equal(ok.timeoutMs, 30000);
});

test('server tersimpan tanpa membocorkan header/env', () => {
  mcp.upsertServer('rahasia', { type: 'http', url: 'https://contoh.test/mcp', headers: { Authorization: 'Bearer abc123' } });
  mcp.upsertServer('lokal', { type: 'stdio', command: process.execPath, args: [SERVER], env: { TOKEN: 'qwerty' } });
  const list = mcp.listServers();
  const rahasia = list.find((s) => s.name === 'rahasia');
  assert.deepEqual(rahasia.headerNames, ['Authorization']);
  assert.equal(JSON.stringify(list).includes('abc123'), false, 'nilai header tidak boleh keluar');
  const lokal = list.find((s) => s.name === 'lokal');
  assert.equal(lokal.hasEnv, true);
  assert.equal(JSON.stringify(list).includes('qwerty'), false, 'nilai env tidak boleh keluar');
  mcp.removeServer('rahasia');
});

test('handshake, tools/list, dan namespacing', async () => {
  const tools = await mcp.listTools('lokal');
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__lokal__boom', 'mcp__lokal__echo', 'mcp__lokal__image']);
  assert.equal(tools[0].server, 'lokal');
  assert.equal(tools[0].inputSchema.type, 'object');
});

test('tools/call meneruskan hasil teks dan menandai error', async () => {
  const ok = await mcp.callTool('mcp__lokal__echo', { text: 'halo' });
  assert.equal(ok.text, 'echo:halo');
  assert.equal(ok.isError, false);

  const bad = await mcp.callTool('mcp__lokal__boom', {});
  assert.equal(bad.isError, true);
  assert.match(bad.text, /gagal di server/);

  // gambar tidak dikirim sebagai base64 ke model
  const img = await mcp.callTool('mcp__lokal__image', {});
  assert.match(img.text, /gambar/);
  assert.equal(img.text.length < 200, true);
});

test('tool tak dikenal dan server tak dikenal ditolak dengan jelas', async () => {
  await assert.rejects(() => mcp.callTool('bukan_mcp', {}), /bukan tool MCP/);
  assert.equal(await mcp.isMcpTool('mcp__a__b'), true);
  assert.equal(await mcp.isMcpTool('read_file'), false);
  await assert.rejects(() => mcp.callTool('mcp__hilang__x', {}), /tidak ada di konfigurasi/);
});

test('katalog menggabungkan server dan memisahkan kegagalan', async () => {
  mcp.upsertServer('mati', { type: 'stdio', command: process.execPath, args: [CRASH] });
  const c = await mcp.catalog({ force: true });
  const lokal = c.servers.find((s) => s.name === 'lokal');
  const mati = c.servers.find((s) => s.name === 'mati');
  assert.equal(lokal.tools, 3);
  assert.equal(mati.tools, 0);
  assert.ok(mati.error, 'kegagalan server harus terlihat');
  assert.equal(c.total, 3, 'server mati tidak menghapus tool server lain');
  mcp.removeServer('mati');
});

test('server dinonaktifkan tidak dipanggil', async () => {
  mcp.setServerEnabled('lokal', false);
  const c = await mcp.catalog({ force: true });
  assert.equal(c.servers.some((s) => s.name === 'lokal'), false);
  assert.equal(c.total, 0);
  await assert.rejects(() => mcp.listTools('lokal'), /dinonaktifkan/);
  mcp.setServerEnabled('lokal', true);
  assert.equal((await mcp.listTools('lokal')).length, 3);
});

test('definisi tool memakai bentuk function yang diterima provider', async () => {
  const defs = await mcp.toolDefinitions({ force: true });
  assert.equal(defs.length, 3);
  const echo = defs.find((d) => d.function.name === 'mcp__lokal__echo');
  assert.equal(echo.type, 'function');
  assert.deepEqual(echo.function.parameters.required, ['text']);
  assert.equal(typeof echo.function.description, 'string');
});

test('status melaporkan koneksi hidup setelah dipakai', async () => {
  await mcp.listTools('lokal', { force: true });
  const s = mcp.status().find((x) => x.name === 'lokal');
  assert.equal(s.connected, true);
  assert.equal(s.initialized, true);
  assert.equal(s.toolCount, 3);
  assert.equal(s.serverInfo.name, 'uji');
});
