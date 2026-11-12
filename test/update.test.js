// test/update.test.js — cek pembaruan: pembanding versi murni + rute HTTP
// dengan sumber GitHub yang di-mock (tanpa jaringan luar).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver, isNewer, updateInfo, fetchLatestRelease } from '../lib/update.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8520 + Math.floor(Math.random() * 20);
const TOKEN = 'updatetok0123456789';
let child;
let dataDir;
let mockTag = 'v9.9.9';
let mockServer;

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  // mock GitHub Releases API di localhost
  mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: mockTag,
      name: `Release ${mockTag}`,
      html_url: `https://github.com/khadijahcollege-afk/AgentHub/releases/tag/${mockTag}`,
      published_at: '2026-11-13T00:00:00Z',
      body: 'Catatan rilis uji.',
    }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-update-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_DATA: dataDir,
      AGENTHUB_NO_TOAST: '1',
      AGENTHUB_UPDATE_API: `http://127.0.0.1:${mockPort}/releases/latest`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { mockServer?.close(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('update: pembanding semver murni', () => {
  assert.deepEqual(parseSemver('v1.6.2'), { major: 1, minor: 6, patch: 2, pre: null });
  assert.equal(parseSemver('bukan versi'), null);
  assert.equal(isNewer('v1.6.2', '1.6.1'), true);
  assert.equal(isNewer('v1.6.1', '1.6.1'), false);
  assert.equal(isNewer('v2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.6.0', 'v1.6.1'), false);
  // prerelease lebih lama dari rilis final dengan nomor sama
  assert.equal(isNewer('v1.6.1-beta.1', 'v1.6.1'), false);
  assert.equal(isNewer('v1.6.1', 'v1.6.1-beta.1'), true);
  // versi tak valid tidak pernah "lebih baru"
  assert.equal(isNewer('sembarang', '1.0.0'), false);
});

test('update: fetchLatestRelease dengan fetch palsu (bentuk data)', async () => {
  const fake = async (url, opts = {}) => ({
    ok: true,
    json: async () => ({
      tag_name: 'v1.7.0', name: 'Rilis uji', html_url: 'https://example.com/r',
      published_at: '2026-11-01T00:00:00Z', body: 'catatan',
    }),
  });
  const rel = await fetchLatestRelease(fake, 'https://example.invalid/latest');
  assert.equal(rel.tag, 'v1.7.0');
  const info = updateInfo('1.6.1', rel);
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, 'v1.7.0');
  assert.equal(info.url, 'https://example.com/r');
  // offline → jujur error, bukan versi karangan
  const off = updateInfo('1.6.1', null, { error: 'offline' });
  assert.equal(off.ok, false);
  assert.equal(off.hasUpdate, undefined);
});

test('update: rute HTTP memakai sumber mock dan menjawab hasUpdate', async () => {
  const r = await api('/api/update-check');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.latest, 'v9.9.9', 'sumber mock dipakai, bukan GitHub nyata');
  assert.equal(body.hasUpdate, true, 'v9.9.9 selalu lebih baru dari versi app');
  assert.equal(body.current, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version);
  assert.equal(body.url.includes('v9.9.9'), true);

  // turunkan versi mock → cache server 30 menit masih menjawab lama;
  // itu perilaku yang benar (tidak menagih GitHub tiap kali), jadi hanya
  // cek bentuk tetap konsisten.
  mockTag = 'v1.0.0';
  const r2 = await api('/api/update-check');
  const body2 = await r2.json();
  assert.equal(body2.ok, true);
});
