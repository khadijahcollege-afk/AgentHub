// test/mcp-api.test.js — rute MCP & hooks lewat server nyata: status masuk
// /api/state, CRUD server, katalog, dan kepercayaan hook proyek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8860, 40);
const TOKEN = 'mcptok0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let project;

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

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-api-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-api-proj-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  // Server MCP sungguhan untuk diuji lewat API.
  const srv = path.join(dataDir, 'srv.mjs');
  fs.writeFileSync(srv, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'api-uji', version: '1' } } });
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'tidak ada' } });
});
`);
  fs.writeFileSync(path.join(dataDir, 'mcp-server-path.txt'), srv);
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1', AGENTHUB_STRICT_PORT: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  for (const d of [dataDir, project]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('/api/state memuat mcp, hooks, dan mode izin', async () => {
  const s = await (await api('/api/state')).json();
  assert.deepEqual(s.mcp, []);
  assert.equal(s.hooks.enabled, false);
  assert.equal(s.hooks.userHooks, 0);
  assert.deepEqual(s.permissionModes, ['plan', 'build', 'edit', 'yolo', 'guarded']);
});

test('tambah server MCP lewat API, rahasia tidak kembali', async () => {
  const srv = fs.readFileSync(path.join(dataDir, 'mcp-server-path.txt'), 'utf8').trim();
  const r = await api('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ name: 'uji', server: { type: 'stdio', command: process.execPath, args: [srv], env: { RAHASIA: 'jangan-bocor' } } }),
  });
  assert.equal(r.status, 200);
  const created = await r.json();
  assert.equal(created.name, 'uji');
  assert.equal(created.hasEnv, true);
  assert.equal(JSON.stringify(created).includes('jangan-bocor'), false);

  const list = await (await api('/api/mcp')).json();
  assert.equal(list.servers.length, 1);
  assert.equal(JSON.stringify(list).includes('jangan-bocor'), false, 'env tidak bocor lewat daftar');
});

test('katalog dan tools per server lewat API', async () => {
  const cat = await (await api('/api/mcp/catalog?refresh=1')).json();
  assert.equal(cat.total, 1);
  assert.equal(cat.servers[0].name, 'uji');
  assert.equal(cat.servers[0].error, null);

  const tools = await (await api('/api/mcp/uji/tools')).json();
  assert.deepEqual(tools.tools.map((t) => t.name), ['mcp__uji__ping']);

  const summary = await (await api(`/api/mcp/tools?cwd=${encodeURIComponent(project)}&mode=yolo`)).json();
  assert.equal(summary.mcp.includes('mcp__uji__ping'), true);
  assert.equal(summary.mode, 'yolo');
});

test('menonaktifkan server menghapus tool-nya dari ringkasan', async () => {
  const r = await api('/api/mcp/uji/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal((await r.json()).enabled, false);
  const summary = await (await api(`/api/mcp/tools?cwd=${encodeURIComponent(project)}&mode=yolo`)).json();
  assert.equal(summary.mcp.length, 0);
  await api('/api/mcp/uji/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
});

test('validasi ditolak dengan 4xx, bukan 500', async () => {
  const bad = await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'x', server: { type: 'ngawur' } }) });
  assert.equal(bad.status, 400);
  const missing = await api('/api/mcp/tidak-ada/tools');
  assert.equal(missing.status, 404);
});

test('hapus server MCP', async () => {
  const r = await api('/api/mcp/uji', { method: 'DELETE' });
  assert.equal(r.status, 200);
  const list = await (await api('/api/mcp')).json();
  assert.equal(list.servers.length, 0);
});

test('hooks: aktifkan, set event, dan jalankan uji', async () => {
  const script = path.join(dataDir, 'hook.mjs');
  fs.writeFileSync(script, `
let raw = '';
for await (const c of process.stdin) raw += c;
const e = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: e.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'dari uji API' } }));
`);

  let r = await api('/api/hooks/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal((await r.json()).enabled, true);

  r = await api('/api/hooks/events', {
    method: 'POST',
    body: JSON.stringify({ event: 'PreToolUse', declarations: [{ matcher: 'run_command', hooks: [{ type: 'process', command: process.execPath, args: [script] }] }] }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).declarations.length, 1);

  r = await api('/api/hooks/test', {
    method: 'POST',
    body: JSON.stringify({ event: 'PreToolUse', payload: { tool_name: 'run_command' } }),
  });
  const out = await r.json();
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /dari uji API/);

  const state = await (await api('/api/state')).json();
  assert.equal(state.hooks.enabled, true);
  assert.equal(state.hooks.userHooks, 1);
});

test('hook proyek: status belum dipercaya, grant, lalu dipercaya', async () => {
  fs.mkdirSync(path.join(project, '.agenthub'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agenthub', 'hooks.json'), JSON.stringify({
    enabled: true,
    events: { SessionStart: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: ['-e', 'process.stdout.write("{}")'] }] }] },
  }));

  let st = await (await api(`/api/hooks/trust?cwd=${encodeURIComponent(project)}`)).json();
  assert.equal(st.present, true);
  assert.equal(st.trusted, false);

  const wrong = await api('/api/hooks/trust', { method: 'POST', body: JSON.stringify({ cwd: project, digest: 'salah' }) });
  assert.equal(wrong.status, 400);

  const ok = await api('/api/hooks/trust', { method: 'POST', body: JSON.stringify({ cwd: project, digest: st.digest }) });
  assert.equal((await ok.json()).trusted, true);

  st = await (await api(`/api/hooks/trust?cwd=${encodeURIComponent(project)}`)).json();
  assert.equal(st.trusted, true);

  const revoke = await api(`/api/hooks/trust?cwd=${encodeURIComponent(project)}`, { method: 'DELETE' });
  assert.equal((await revoke.json()).ok, true);
  st = await (await api(`/api/hooks/trust?cwd=${encodeURIComponent(project)}`)).json();
  assert.equal(st.trusted, false);
});
