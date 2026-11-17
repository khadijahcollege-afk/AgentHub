// test/plugins-api.test.js — rute plugin lewat server nyata: pasang, perintah
// slash benar-benar sampai ke engine, marketplace, dan kepercayaan hook/MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8100, 60);
const TOKEN = 'plugtok0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let pluginSrc;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function runSink(threadId, prompt) {
  const res = await api(`/api/threads/${threadId}/send`, {
    method: 'POST', body: JSON.stringify({ prompt, engine: 'sink' }),
  });
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    for (const block of dec.decode(chunk, { stream: true }).split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'delta') text += evt.text || '';
    }
  }
  const marker = text.indexOf('SINK:');
  const raw = marker >= 0 ? text.slice(marker + 5) : text;
  let seen = raw;
  try { seen = JSON.parse(raw); } catch { /* apa adanya */ }
  return { status: 200, prompt: seen };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plug-api-'));
  pluginSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plug-api-src-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  const sink = path.join(dataDir, 'sink.cjs');
  fs.writeFileSync(sink, 'process.stdout.write("SINK:" + JSON.stringify(process.argv[2] || ""));\n');
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'sink', label: 'Sink (uji)', cmd: process.execPath, args: [sink, '{prompt}'] },
  ]));

  // Plugin uji di folder terpisah.
  fs.mkdirSync(path.join(pluginSrc, '.agenthub-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginSrc, '.agenthub-plugin', 'plugin.json'), JSON.stringify({
    name: 'rangkum',
    version: '1.2.0',
    description: 'Perintah rangkum berkas',
    commands: 'commands',
    skills: 'skills',
  }));
  fs.mkdirSync(path.join(pluginSrc, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pluginSrc, 'commands', 'rangkum.md'),
    '---\ndescription: Rangkum berkas\nexample: /rangkum src/app.js\n---\nRangkum berkas $ARGUMENTS dalam lima poin.\n');
  fs.mkdirSync(path.join(pluginSrc, 'skills', 'rangkum-berkas'), { recursive: true });
  fs.writeFileSync(path.join(pluginSrc, 'skills', 'rangkum-berkas', 'SKILL.md'),
    '---\nname: rangkum-berkas\ndescription: Cara meringkas berkas panjang.\n---\nBaca berkas, lalu ringkas.\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  assert.equal(await waitUp(), true, `server harus hidup\n${bootLog.slice(-600)}`);
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  for (const d of [dataDir, pluginSrc]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('daftar plugin kosong di awal, dengan kontrak lengkap', async () => {
  const r = await api('/api/plugins');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.enabled, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.plugins, []);
  assert.deepEqual(body.commands, []);
});

test('validate menolak folder tanpa manifest tanpa memasang apa pun', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plug-api-empty-'));
  try {
    const r = await api('/api/plugins/validate', { method: 'POST', body: JSON.stringify({ dir: empty }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.errors[0], /manifest tidak ditemukan/);
    assert.equal((await (await api('/api/plugins')).json()).count, 0);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('install dari folder lokal, perintah dan skill muncul', async () => {
  const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ name: pluginSrc }) });
  assert.equal(r.status, 200);
  const installed = await r.json();
  assert.equal(installed.name, 'rangkum');
  assert.equal(installed.version, '1.2.0');

  const list = await (await api('/api/plugins')).json();
  assert.equal(list.count, 1);
  const cmd = list.commands.find((c) => c.name === 'rangkum');
  assert.ok(cmd, 'perintah plugin harus terdaftar');
  assert.equal(cmd.plugin, 'rangkum');

  const sk = await (await api('/api/skills')).json();
  assert.equal(sk.skills.some((s) => s.id === 'rangkum-berkas'), true, 'skill plugin harus terlihat di /api/skills');
});

test('perintah plugin diperluas sebelum dikirim ke engine, pesan user tetap asli', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'sink' }) })).json();
  const r = await runSink(t.id, '/rangkum src/app.js');
  assert.equal(r.status, 200);
  assert.match(r.prompt, /Rangkum berkas src\/app.js dalam lima poin/);

  const after = await (await api(`/api/threads/${t.id}`)).json();
  const userMsg = after.messages.find((m) => m.role === 'user');
  assert.equal(userMsg.content, '/rangkum src/app.js', 'yang dilihat pengguna tetap perintah aslinya');
});

test('menonaktifkan plugin mencabut perintah dan skill dari API', async () => {
  await api('/api/plugins/rangkum/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  const list = await (await api('/api/plugins')).json();
  assert.equal(list.commands.some((c) => c.name === 'rangkum'), false);
  const sk = await (await api('/api/skills')).json();
  assert.equal(sk.skills.some((s) => s.id === 'rangkum-berkas'), false);

  // perintah yang tidak lagi ada tidak diperluas — dikirim apa adanya
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'sink' }) })).json();
  const r = await runSink(t.id, '/rangkum src/app.js');
  assert.match(r.prompt, /\/rangkum src\/app\.js/);

  await api('/api/plugins/rangkum/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal((await (await api('/api/plugins')).json()).commands.length, 1);
});

test('marketplace: daftar kosong ditolak dengan 4xx, bukan 500', async () => {
  const r = await api('/api/plugins/marketplaces', {
    method: 'POST', body: JSON.stringify({ dir: path.join(os.tmpdir(), 'tidak-ada-market-xyz') }),
  });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /tidak ditemukan/);
});

test('kepercayaan: plugin tanpa hook/MCP tidak perlu izin', async () => {
  const r = await api('/api/plugins/rangkum/trust');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.needsTrust, false);
  assert.equal(body.trusted, true);
});

test('uninstall menghapus folder plugin dan perintahnya', async () => {
  const before = (await (await api('/api/plugins')).json()).plugins[0];
  const r = await api('/api/plugins/rangkum?keepData=1', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(before.dir), false);
  const after = await (await api('/api/plugins')).json();
  assert.equal(after.count, 0);
  assert.deepEqual(after.commands, []);
});

test('server MCP milik plugin tidak bisa dihapus/diubah lewat API MCP', async () => {
  // Plugin dengan server MCP sungguhan (proses node yang langsung keluar).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plug-mcp-'));
  try {
    fs.mkdirSync(path.join(dir, '.agenthub-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenthub-plugin', 'plugin.json'), JSON.stringify({
      name: 'pembawa-mcp',
      version: '1.0.0',
      mcp: { servers: { arsip: { type: 'stdio', command: process.execPath, args: ['-e', '0'] } } },
    }));
    const inst = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ name: dir }) });
    assert.equal(inst.status, 200);
    const trust = await (await api('/api/plugins/pembawa-mcp/trust')).json();
    assert.equal(trust.needsTrust, true);
    assert.equal(trust.trusted, false);

    // Belum dipercaya: server belum muncul sama sekali.
    const before = await (await api('/api/mcp')).json();
    assert.equal(before.servers.some((s) => s.managedBy), false);

    const granted = await api('/api/plugins/pembawa-mcp/trust', {
      method: 'POST', body: JSON.stringify({ digest: trust.digest }),
    });
    assert.equal(granted.status, 200);

    const after = await (await api('/api/mcp')).json();
    const server = after.servers.find((s) => s.name === 'pembawa-mcp-arsip');
    assert.ok(server, 'server MCP plugin muncul setelah dipercaya');
    assert.equal(server.managedBy, 'plugin:pembawa-mcp');

    // Baca-saja: hapus dan ubah harus 409, bukan menghapus entri diam-diam.
    for (const [method, path2, body] of [
      ['DELETE', '/api/mcp/pembawa-mcp-arsip'],
      ['POST', '/api/mcp/pembawa-mcp-arsip/enabled', JSON.stringify({ enabled: false })],
      ['POST', '/api/mcp', JSON.stringify({ name: 'pembawa-mcp-arsip', server: { type: 'stdio', command: 'node' } })],
    ]) {
      const r = await api(path2, { method, ...(body ? { body } : {}) });
      assert.equal(r.status, 409, `${method} ${path2} harus 409`);
      assert.equal((await r.json()).code, 'MCP_MANAGED_BY_PLUGIN');
    }

    // Dan tidak boleh tertulis ke mcp.json pengguna: kalau tersimpan, server itu
    // akan tetap ada setelah plugin dicopot. Berkasnya bahkan tidak dibuat sama
    // sekali ketika hanya ada server plugin.
    const mcpFile = path.join(dataDir, 'mcp.json');
    const onDisk = fs.existsSync(mcpFile)
      ? JSON.parse(fs.readFileSync(mcpFile, 'utf8').replace(/^\uFEFF/, '') || '{"servers":{}}')
      : { servers: {} };
    assert.equal(Object.keys(onDisk.servers || {}).some((n) => n.includes('pembawa-mcp')), false);

    // Mencopot plugin menghapus servernya juga.
    await api('/api/plugins/pembawa-mcp?keepData=0', { method: 'DELETE' });
    const end = await (await api('/api/mcp')).json();
    assert.equal(end.servers.some((s) => s.managedBy), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
