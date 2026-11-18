// test/install.test.js — pemasangan terverifikasi: checksum, intersepsi proxy,
// preflight, retry/sumber berantai, keputusan siklus hidup, dan bundel
// diagnostik. Semua fungsi murni diuji langsung; alur server diuji dengan
// fixture lokal.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import {
  parseChecksums, hashFile, verifyFile, detectInterception, readMagic, preflight,
  firstSuccess, retry, installDecision, uninstallPlan, redact,
  diagnosticsBundle, bundleToText,
} from '../lib/install.js';
import { CHECKSUM_ASSET, fetchChecksums } from '../lib/update.js';
import { INSTALL_MACHINE, canTransition, MACHINE_VERSION } from '../lib/machines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8560, 20);
const TOKEN = 'installtok0123456789';
let child;
let dataDir;
let distDir;
let mockServer;
let mockPort;

const FIXTURE = Buffer.from('AgentHub-fake-installer-'.repeat(30000)); // ~660 KB
const FIXTURE_SHA = crypto.createHash('sha256').update(FIXTURE).digest('hex');
// Mode mock: 'ok' menyajikan SHA256SUMS yang benar, 'bad' yang salah,
// 'html' halaman proxy, 'none' tanpa berkas checksum.
let mockMode = 'ok';
// Tag diubah antar-tes supaya unduhan dipicu ulang: `startDownload` sengaja
// melewati versi yang sudah `ready`, dan itu perilaku yang benar.
let mockTag = 'v99.0.0';
// Aset pe yang sah: diawali MZ supaya lolos pemeriksaan tanda tangan PE.
const PE_FIXTURE = Buffer.concat([Buffer.from('MZ'), FIXTURE]);

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

const PE_SHA = crypto.createHash('sha256').update(PE_FIXTURE).digest('hex');

test.before(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url.includes(CHECKSUM_ASSET)) {
      if (mockMode === 'none') { res.writeHead(404); res.end('tidak ada'); return; }
      const hash = mockMode === 'bad' ? 'f'.repeat(64) : PE_SHA;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${hash}  ${'AgentHub-Setup.exe'}\n`);
      return;
    }
    if (req.url.startsWith('/download/')) {
      if (mockMode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>Login ke jaringan kantor</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': PE_FIXTURE.length });
      res.end(PE_FIXTURE);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: mockTag, name: 'Release uji',
      html_url: `https://github.com/khadijahcollege-afk/AgentHub/releases/tag/${mockTag}`,
      published_at: '2026-11-18T00:00:00Z', body: 'catatan',
    }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-install-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installdist-'));
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

// ---------- checksum ----------

test('install: parse SHA256SUMS (format sha256sum, baris rusak dilewati)', () => {
  const text = [
    `${'a'.repeat(64)}  AgentHub-Setup.exe`,
    `${'b'.repeat(64)} *AgentHub-Portable.zip`,
    '',
    '# komentar',
    'baris tidak valid sama sekali',
    `${'c'.repeat(63)}  kurang-satu-hex.exe`,
    `${'D'.repeat(64)}  AgentHub-macOS.dmg`,
  ].join('\n');
  const map = parseChecksums(text);
  assert.equal(map.size, 3, 'hanya tiga baris sah');
  assert.equal(map.get('AgentHub-Setup.exe'), 'a'.repeat(64));
  assert.equal(map.get('AgentHub-Portable.zip'), 'b'.repeat(64), 'tanda * (mode biner) diterima');
  assert.equal(map.get('AgentHub-macOS.dmg'), 'd'.repeat(64), 'hash dinormalkan ke huruf kecil');
  assert.equal(map.get('kurang-satu-hex.exe'), undefined);
  // teks kosong / null tidak melempar
  assert.equal(parseChecksums('').size, 0);
  assert.equal(parseChecksums(null).size, 0);
});

test('install: hash berkas sungguhan sama dengan crypto langsung', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hash-'));
  const f = path.join(dir, 'x.bin');
  fs.writeFileSync(f, FIXTURE);
  const h = await hashFile(f);
  assert.equal(h, FIXTURE_SHA);
  // chunk kecil harus memberi hash yang sama (streaming, bukan baca-sekaligus)
  assert.equal(await hashFile(f, { chunkSize: 1024 }), FIXTURE_SHA);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install: verifyFile membedakan ok/unverified/mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-verify-'));
  const f = path.join(dir, 'x.bin');
  fs.writeFileSync(f, FIXTURE);

  const ok = await verifyFile(f, FIXTURE_SHA);
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'ok');

  // tidak ada pembanding → BUKAN ok: tidak boleh ada centang palsu
  const none = await verifyFile(f, null);
  assert.equal(none.ok, false);
  assert.equal(none.status, 'unverified');

  const bad = await verifyFile(f, 'e'.repeat(64));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 'mismatch');
  assert.equal(bad.actual, FIXTURE_SHA, 'hash nyata dilaporkan untuk laporan bug');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- intersepsi proxy ----------

test('install: detectInterception mengenali halaman HTML dan unduhan terpotong', () => {
  const html = detectInterception({ contentType: 'text/html; charset=utf-8', bytes: 420 });
  assert.equal(html.kind, 'content-type');
  assert.match(html.detail, /text\/html/);

  const json = detectInterception({ contentType: 'application/json', bytes: 80 });
  assert.equal(json.kind, 'content-type');

  const short = detectInterception({ contentType: 'application/octet-stream', bytes: 1000, expectedBytes: 5000 });
  assert.equal(short.kind, 'short-body');
  assert.match(short.detail, /1000 dari 5000/);

  // berkas yang mengaku biner tetapi tidak diawali MZ
  const notPe = detectInterception({ contentType: 'application/octet-stream', bytes: 100, magic: '<!DO' });
  assert.equal(notPe.kind, 'not-pe');

  // respons yang wajar: tidak ada temuan
  assert.equal(detectInterception({ contentType: 'application/octet-stream', bytes: 100, expectedBytes: 100, magic: 'MZ' }), null);
  assert.equal(detectInterception({}), null);
});

test('install: readMagic membaca dua byte pertama', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-magic-'));
  const pe = path.join(dir, 'a.exe');
  fs.writeFileSync(pe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  assert.equal(readMagic(pe), 'MZ');
  // berkas tidak ada → string kosong, bukan lempar
  assert.equal(readMagic(path.join(dir, 'hilang.exe')), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- preflight ----------

test('install: preflight menolak platform/arsitektur/disk yang tidak layak', () => {
  const ok = preflight({ platform: 'win32', arch: 'x64', nodeVersion: '22.0.0', freeBytes: 10 * 1024 ** 3, dataWritable: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.failed.length, 0);

  const bad = preflight({ platform: 'sunos', arch: 'mips', nodeVersion: '16.0.0', freeBytes: 1024, dataWritable: false });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failed.sort(), ['arch', 'data', 'disk', 'node', 'platform'].sort());

  // disk tidak diketahui → warn, bukan error: jangan halangi pemasangan
  // hanya karena statfs gagal di satu platform.
  const unknown = preflight({ platform: 'win32', arch: 'arm64', nodeVersion: '20.0.0', freeBytes: null, dataWritable: true });
  assert.equal(unknown.ok, true);
  assert.ok(unknown.checks.some((c) => c.id === 'disk' && c.level === 'warn'));
});

// ---------- retry & sumber berantai ----------

test('install: retry berhenti setelah sukses dan menghitung percobaan', async () => {
  let n = 0;
  const ok = await retry(async () => { n++; if (n < 3) throw new Error('sementara'); return 'selesai'; },
    { attempts: 5, baseMs: 1, sleep: async () => {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'selesai');
  assert.equal(ok.attempts, 3);

  const fail = await retry(async () => { throw new Error('selalu'); }, { attempts: 2, baseMs: 1, sleep: async () => {} });
  assert.equal(fail.ok, false);
  assert.equal(fail.attempts, 2);
  assert.match(fail.error, /selalu/);

  // shouldRetry=false menghentikan lebih awal (error permanen tidak diulang)
  let calls = 0;
  const stop = await retry(async () => { calls++; throw new Error('permanen'); },
    { attempts: 5, baseMs: 1, sleep: async () => {}, shouldRetry: () => false });
  assert.equal(stop.ok, false);
  assert.equal(calls, 1, 'tidak diulang saat error permanen');
});

test('install: firstSuccess mencoba sumber berurutan dan mencatat kegagalan', async () => {
  const seen = [];
  const r = await firstSuccess([
    { label: 'A', fn: async () => { throw new Error('diblokir'); } },
    { label: 'B', fn: async () => 'dari B' },
    { label: 'C', fn: async () => 'tidak dipanggil' },
  ], { onFallback: (i) => seen.push(`${i.from}->${i.to}`) });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'dari B');
  assert.equal(r.source, 'B');
  assert.deepEqual(seen, ['A->B'], 'fallback dilaporkan sekali');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /diblokir/);

  const all = await firstSuccess([
    { label: 'A', fn: async () => { throw new Error('x'); } },
    { label: 'B', fn: async () => { throw new Error('y'); } },
  ]);
  assert.equal(all.ok, false);
  assert.equal(all.errors.length, 2, 'semua kegagalan dicatat, bukan hanya yang terakhir');
});

// ---------- keputusan siklus hidup ----------

test('install: installDecision memetakan status unduhan ke langkah berikutnya', () => {
  assert.equal(installDecision({ current: '1.9.0', latest: null, hasUpdate: false }).action, 'none');
  assert.equal(installDecision({ current: '1.9.0', latest: 'v1.9.0', hasUpdate: false }).why, 'sudah versi terbaru');
  assert.equal(installDecision({ current: '1.8.0', latest: 'v1.9.0', hasUpdate: true, downloadStatus: 'downloading' }).action, 'wait');
  assert.equal(installDecision({ current: '1.8.0', latest: 'v1.9.0', hasUpdate: true, downloadStatus: 'ready' }).action, 'install');
  assert.equal(installDecision({ current: '1.8.0', latest: 'v1.9.0', hasUpdate: true, downloadStatus: 'error' }).action, 'retry');
  assert.equal(installDecision({ current: '1.8.0', latest: 'v1.9.0', hasUpdate: true, downloadStatus: 'idle' }).action, 'download');
});

test('install: uninstallPlan menyebut langkah per platform tanpa menjalankannya', () => {
  const win = uninstallPlan({ platform: 'win32', root: 'C:\\App', startupDir: 'C:\\Start', dataDir: 'C:\\Data' });
  assert.equal(win.platform, 'win32');
  assert.ok(win.steps.some((s) => s.id === 'autostart' && s.path.endsWith('agenthub-server.vbs')));
  assert.ok(win.steps.some((s) => s.id === 'data' && s.path === 'C:\\Data'));
  const mac = uninstallPlan({ platform: 'darwin', root: '/Applications/AgentHub.app', dataDir: '/tmp/d' });
  assert.equal(mac.steps.length, 2);
  assert.ok(!mac.steps.some((s) => s.id === 'autostart'), 'macOS tidak punya entri autostart Windows');
});

test('install: mesin install punya jalur sah dari checking ke ready dan sebaliknya', () => {
  assert.equal(MACHINE_VERSION >= 5, true);
  assert.equal(canTransition(INSTALL_MACHINE, 'checking', 'eligible'), true);
  assert.equal(canTransition(INSTALL_MACHINE, 'eligible', 'downloading'), true);
  assert.equal(canTransition(INSTALL_MACHINE, 'downloading', 'verifying'), true);
  assert.equal(canTransition(INSTALL_MACHINE, 'verifying', 'ready'), true);
  assert.equal(canTransition(INSTALL_MACHINE, 'verifying', 'blocked'), true, 'checksum beda memblokir');
  assert.equal(canTransition(INSTALL_MACHINE, 'ready', 'installing'), true);
  // installing boleh kembali ke ready bila spawn gagal
  assert.equal(canTransition(INSTALL_MACHINE, 'installing', 'ready'), true);
  // jalur terlarang
  assert.equal(canTransition(INSTALL_MACHINE, 'checking', 'installing'), false);
  assert.equal(canTransition(INSTALL_MACHINE, 'blocked', 'installing'), false);
});

// ---------- diagnostik ----------

test('install: redact menyembunyikan rahasia tapi mempertahankan keberadaannya', () => {
  const out = redact({
    token: 'rahasia-sekali',
    apiKey: 'sk-123',
    nested: { password: 'p', normal: 'terlihat' },
    list: [{ secret: 'x' }, { aman: 1 }],
    empty: { token: null },
  });
  assert.equal(out.token, '[disembunyikan]');
  assert.equal(out.apiKey, '[disembunyikan]');
  assert.equal(out.nested.password, '[disembunyikan]');
  assert.equal(out.nested.normal, 'terlihat');
  assert.equal(out.list[0].secret, '[disembunyikan]');
  assert.equal(out.list[1].aman, 1);
  assert.equal(out.empty.token, null, 'nilai kosong tetap kosong, bukan [disembunyikan]');
});

test('install: diagnosticsBundle + bundleToText terbaca manusia dan tanpa rahasia', () => {
  const b = diagnosticsBundle({
    appVersion: '1.9.0', platform: 'win32', arch: 'x64', nodeVersion: '22.0.0',
    uptimeMs: 5000,
    parts: { token: 'jangan-bocor', dataDir: 'C:\\Data', counts: { threads: 3 } },
    logs: ['WARN contoh', 'ERR contoh'],
    now: () => new Date('2026-11-18T10:00:00Z'),
  });
  assert.equal(b.app, 'agenthub-diagnostics');
  assert.equal(b.generatedAt, '2026-11-18T10:00:00.000Z');
  assert.equal(b.sections.token, '[disembunyikan]', 'token disaring di dalam bundel');
  const text = bundleToText(b);
  assert.match(text, /AgentHub diagnostics/);
  assert.match(text, /1\.9\.0/);
  assert.match(text, /WARN contoh/);
  assert.equal(text.includes('jangan-bocor'), false, 'token asli tidak pernah muncul di teks');
});

// ---------- alur server ----------

test('install: unduhan diverifikasi lalu siap dipasang (checksum cocok)', async () => {
  mockMode = 'ok';
  mockTag = 'v99.0.0';
  const r = await api('/api/update-check?force=1');
  assert.equal(r.status, 200);

  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (['ready', 'error'].includes(u.download?.status)) break;
  }
  assert.equal(u.download.status, 'ready', 'unduhan selesai: ' + JSON.stringify(u.download));
  assert.equal(u.verify.status, 'ok', 'checksum dari SHA256SUMS.txt cocok: ' + JSON.stringify(u.verify));
  assert.equal(u.verify.expected, PE_SHA);
  assert.equal(u.verify.actual, PE_SHA);
  assert.equal(u.installable, true);
  // keputusan untuk UI ikut dihitung server, tidak diulang di klien
  assert.equal(u.decision.action, 'install');
  assert.equal(fs.readFileSync(u.installerPath).length, PE_FIXTURE.length);
});

test('install: preflight bisa dibaca UI sebelum memasang', async () => {
  const r = await api('/api/install/preflight');
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(typeof p.ok, 'boolean');
  assert.ok(Array.isArray(p.checks) && p.checks.length >= 5);
  assert.ok(p.checks.every((c) => ['ok', 'warn', 'error'].includes(c.level)));
});

test('install: rencana uninstall tersedia sebagai data', async () => {
  const r = await api('/api/install/uninstall-plan');
  assert.equal(r.status, 200);
  const plan = await r.json();
  assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 2);
  assert.ok(plan.steps.some((s) => s.id === 'data'));
});

test('install: bundel diagnostik menyembunyikan token akses', async () => {
  const r = await api('/api/diagnostics');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes(TOKEN), false, 'token akses tidak boleh muncul di bundel');
  const b = JSON.parse(text);
  assert.equal(b.app, 'agenthub-diagnostics');
  assert.equal(b.sections.config.token, '[disembunyikan]');
  assert.ok(b.runtime.appVersion);
  // bentuk teks untuk dilampirkan ke laporan bug
  const txt = await api('/api/diagnostics?format=text');
  assert.match(txt.headers.get('content-type'), /text\/plain/);
  const body = await txt.text();
  assert.match(body, /AgentHub diagnostics/);
  assert.equal(body.includes(TOKEN), false);
});

test('install: checksum salah menolak pemasangan, bukan menjalankan berkas', async () => {
  // Versi baru + SHA256SUMS yang salah: unduhan diverifikasi dan harus gagal.
  mockMode = 'bad';
  mockTag = 'v99.1.0';
  await api('/api/update-check?force=1');

  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (u.download?.status === 'error') break;
    if (u.verify?.status === 'mismatch') break;
  }
  assert.equal(u.verify.status, 'mismatch', 'checksum beda tercatat: ' + JSON.stringify(u.verify));
  assert.equal(u.download.status, 'error', 'unduhan ditandai gagal, bukan siap');
  assert.match(u.download.error, /Checksum tidak cocok/);
  assert.equal(u.installable, false, 'berkas yang gagal verifikasi tidak boleh dianggap siap');

  // Memasang tetap ditolak — dan penolakan menyebut sebabnya.
  const inst = await api('/api/update/install', { method: 'POST' });
  assert.equal(inst.status, 409);
  const body = await inst.json();
  assert.match(body.error, /belum siap|checksum/i);
});

test('install: isi HTML dari proxy ditolak sebagai bukan installer', async () => {
  mockMode = 'html';
  mockTag = 'v99.2.0';
  await api('/api/update-check?force=1');

  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (u.download?.status === 'error') break;
  }
  assert.equal(u.download.status, 'error', 'halaman HTML tidak boleh menjadi "installer"');
  assert.match(u.download.error, /bukan paket installer|MZ|installer/i,
    'pesan menyebut sebabnya, bukan sekadar "gagal": ' + u.download.error);
  assert.equal(u.installable, false);
});
