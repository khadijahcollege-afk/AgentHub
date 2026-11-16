// test/update.test.js — pembaruan lengkap: pembanding versi murni, aset per
// platform, unduhan berprogres (fixture lokal, tanpa jaringan luar), dan alur
// auto-update server: cek → unduh otomatis → siap dipasang.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import {
  parseSemver, isNewer, updateInfo, fetchLatestRelease,
  assetFor, downloadUrl, fullUpdateInfo, downloadAsset,
} from '../lib/update.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8520, 20);
const TOKEN = 'updatetok0123456789';
let child;
let dataDir;
let distDir;
let mockTag = 'v9.9.9';
let mockServer;
const FIXTURE = Buffer.from('AgentHub-fake-installer'.repeat(32768)); // ~716 KB
const SPLIT_AT = 600 * 1024; // potong melewati ambang progres 512 KB

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
  // mock GitHub Releases API + host unduhan di localhost
  mockServer = http.createServer((req, res) => {
    if (req.url.startsWith('/download/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': FIXTURE.length });
      res.end(FIXTURE);
      return;
    }
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
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dist-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_DATA: dataDir,
      AGENTHUB_DIST: distDir,
      AGENTHUB_NO_TOAST: '1',
      AGENTHUB_UPDATE_API: `http://127.0.0.1:${mockPort}/releases/latest`,
      AGENTHUB_UPDATE_DOWNLOAD: `http://127.0.0.1:${mockPort}/download`,
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
  try { fs.rmSync(distDir, { recursive: true, force: true }); } catch { /* noop */ }
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

test('update: aset per platform + URL unduhan bisa dioverride', () => {
  assert.deepEqual(assetFor('win32'), { name: 'AgentHub-Setup.exe', kind: 'installer' });
  assert.deepEqual(assetFor('darwin'), { name: 'AgentHub-macOS.dmg', kind: 'dmg' });
  assert.deepEqual(assetFor('linux'), { name: 'AgentHub-linux.AppImage', kind: 'appimage' });
  assert.equal(downloadUrl('AgentHub-Setup.exe'),
    'https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download/AgentHub-Setup.exe');
  assert.equal(downloadUrl('X.exe', 'http://localhost:1234/dl'),
    'http://localhost:1234/dl/X.exe');
  const info = fullUpdateInfo('1.6.13', { tag: 'v1.6.14', url: 'u', name: 'n', publishedAt: '', notes: '' });
  assert.equal(info.hasUpdate, true);
  assert.equal(info.asset.name, assetFor(process.platform).name, 'aset mengikuti platform');
});

test('update: unduh berprogres ke berkas (fetch palsu, stream nyata)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dl-'));
  const dest = path.join(dir, 'setup.exe');
  let progress = null;
  const fake = async () => ({
    ok: true,
    headers: new Map([['content-length', String(FIXTURE.length)]]),
    body: Readable.toWeb(Readable.from([FIXTURE.subarray(0, SPLIT_AT), FIXTURE.subarray(SPLIT_AT)])),
  });
  const r = await downloadAsset('http://fixture/setup.exe', dest, { fetchImpl: fake, onProgress: (p) => { progress = p; } });
  assert.equal(r.bytes, FIXTURE.length);
  assert.equal(fs.readFileSync(dest).length, FIXTURE.length, 'berkas utuh ditulis');
  assert.ok(progress && progress.pct > 0, 'progres dilaporkan');
  assert.equal(fs.existsSync(dest + '.part'), false, 'tidak ada .part tersisa');
  // HTTP gagal → error jelas
  const bad = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => downloadAsset('http://fixture/x', dest, { fetchImpl: bad }), /HTTP 404/);
  // unduhan kosong ditolak (bukan file 0-byte palsu)
  const empty = async () => ({ ok: true, headers: new Map(), body: Readable.toWeb(Readable.from([])) });
  await assert.rejects(() => downloadAsset('http://fixture/x', dest, { fetchImpl: empty }), /kosong/);
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

test('update: server auto-check → auto-unduh → siap dipasang', async () => {
  const r = await api('/api/update-check');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.latest, 'v9.9.9', 'sumber mock dipakai, bukan GitHub nyata');
  assert.equal(body.hasUpdate, true, 'v9.9.9 selalu lebih baru dari versi app');

  // auto-unduh berjalan sendiri (autoUpdate default aktif): tunggu ready
  let u = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (u.download?.status === 'ready') break;
    if (u.download?.status === 'error') break;
  }
  assert.equal(u.download.status, 'ready', 'unduhan otomatis selesai, dapat: ' + JSON.stringify(u.download));
  assert.equal(u.installable, true, 'installer terdeteksi di dist override');
  assert.ok(u.installerPath.startsWith(distDir), 'berkas ditulis ke folder dist yang dioverride');
  assert.equal(fs.readFileSync(u.installerPath).length, FIXTURE.length, 'isi unduhan utuh');

  // 409 saat versi sama (tak ada yang perlu diunduh) untuk unduhan manual
  assert.equal((await api('/api/update/download', { method: 'POST' })).status, 409);

  // install: berkas dihapus → 409 jujur, bukan spawn buta
  fs.unlinkSync(u.installerPath);
  const bad = await api('/api/update/install', { method: 'POST' });
  assert.equal(bad.status, 409);
  assert.match((await bad.json()).error, /hilang|siap/);

  // state membawa ringkasan update untuk UI
  const state = await (await api('/api/state')).json();
  assert.equal(state.config.autoUpdate, true);
  assert.ok(state.update?.ok, 'state membawa info update');
});

test('update: versi sama → tidak ada unduhan ulang, status tetap', async () => {
  mockTag = 'v1.0.0';
  // cache 30 menit masih menjawab v9.9.9 — perilaku benar (tak menagih GitHub)
  const r2 = await api('/api/update-check');
  assert.equal((await r2.json()).ok, true);
});
