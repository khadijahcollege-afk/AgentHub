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
import { stopTestServer } from './helpers/server.js';
import {
  parseChecksums, hashFile, verifyFile, detectInterception, readMagic, preflight,
  firstSuccess, retry, installDecision, installGate, pickWritableDir, uninstallPlan, redact,
  canWrite, diagnosticsBundle, bundleToText, needsElevation, installStall,
} from '../lib/install.js';
import { CHECKSUM_ASSET, fetchChecksums, launchInstaller, installerArgs, startProcessArgLine } from '../lib/update.js';
import { INSTALL_MACHINE, canTransition, MACHINE_VERSION } from '../lib/machines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8660, 40);
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
  // Harness lambat: satu-satunya cara menguji bahwa pemasangan otomatis BENAR
  // menunggu run selesai adalah punya run yang benar-benar masih berjalan.
  // Tanpa ini, "defer" hanya bisa diuji sebagai fungsi murni — dan justru
  // sambungan ke `runs.onIdle` yang bisa putus tanpa ketahuan.
  const isWin = process.platform === 'win32';
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify(
    isWin
      ? [{ id: 'slow', label: 'Slow', cmd: 'cmd', args: ['/c', 'ping', '-n', '30', '127.0.0.1'] }]
      : [{ id: 'slow', label: 'Slow', cmd: 'sleep', args: ['25'] }],
  ));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_DATA: dataDir,
      AGENTHUB_DIST: distDir,
      AGENTHUB_NO_TOAST: '1',
      // Port dipatok: server TIDAK boleh diam-diam pindah ke port lain,
      // karena tes menunggu port yang ia minta. Lihat test/helpers/server.js.
      AGENTHUB_STRICT_PORT: '1',
      AGENTHUB_UPDATE_API: `http://127.0.0.1:${mockPort}/releases/latest`,
      AGENTHUB_UPDATE_DOWNLOAD: `http://127.0.0.1:${mockPort}/download`,
      // Installer sungguhan tidak boleh dijalankan oleh tes: ia memasang
      // AgentHub dan menutup proses. Yang diuji adalah KEPUTUSAN dan urutannya.
      AGENTHUB_NO_LAUNCH_INSTALLER: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
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

test('install: canWrite membuktikan dengan menulis, bukan hanya bertanya', () => {
  // Regresi nyata: `accessSync(W_OK)` di Windows hanya memeriksa atribut
  // read-only, bukan ACL yang menolak. Folder `Program Files` lolos pemeriksaan
  // itu lalu gagal `EPERM` saat benar-benar ditulis — sesudah 78 MB terunduh.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-canwrite-'));
  try {
    assert.equal(canWrite(dir), true, 'folder biasa bisa ditulis');
    // Buktinya harus dengan benar-benar menulis; berkas percobaan tidak boleh
    // tertinggal, karena preflight dipanggil berulang kali.
    assert.deepEqual(fs.readdirSync(dir), [], 'tidak ada berkas percobaan yang tertinggal');

    assert.equal(canWrite(path.join(dir, 'tidak-ada')), false, 'folder yang tidak ada bukan "bisa ditulis"');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('install: preflight menolak folder unduhan yang tidak bisa ditulis', () => {  // Regresi nyata: di instalasi per-machine (`Program Files`), folder data ada
  // di %APPDATA% dan bisa ditulis, sedangkan `dist/` di samping server.js TIDAK.
  // Preflight lama hanya memeriksa folder data, jadi ia menyatakan "lolos" lalu
  // unduhan 78 MB gagal di byte terakhir — tepat setelah user menunggu.
  const base = { platform: 'win32', arch: 'x64', nodeVersion: '22.0.0', freeBytes: 10 * 1024 ** 3, dataWritable: true };
  const ok = preflight({ ...base, distWritable: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.find((c) => c.id === 'dist')?.level, 'ok');

  const bad = preflight({ ...base, distWritable: false, distDir: 'C:\\Program Files\\AgentHub\\resources\\server\\dist' });
  assert.equal(bad.ok, false, 'folder unduhan yang read-only harus MENGHENTIKAN, bukan sekadar dicatat');
  assert.ok(bad.failed.includes('dist'));
  // Pesannya menyebut path, supaya user tahu folder mana yang harus diperbaiki.
  assert.match(bad.checks.find((c) => c.id === 'dist').detail, /Program Files/);
});

test('install: folder unduhan dipilih yang bisa ditulis, bukan yang pertama saja', () => {
  // Regresi nyata: di instalasi per-machine, `dist/` di samping server.js ada di
  // Program Files dan read-only. Server harus pindah ke folder data di %APPDATA%,
  // bukan menunggu 78 MB terunduh lalu gagal.
  const candidates = ['C:\\Program Files\\AgentHub\\resources\\server\\dist', 'C:\\Users\\x\\AppData\\Roaming\\AgentHub\\dist'];
  const calls = [];
  const r = pickWritableDir(candidates, {
    mkdir: (d) => calls.push(['mkdir', d]),
    writable: (d) => !/Program Files/.test(d),
  });
  assert.equal(r.dir, candidates[1], 'folder read-only harus dilewati');
  assert.deepEqual(calls.map((c) => c[1]), candidates, 'keduanya dicoba, berurutan');
  assert.equal(r.tried[0].ok, false);
  assert.match(r.tried[0].reason, /tidak bisa ditulis/);
  assert.equal(r.tried[1].ok, true);

  // Bila folder bawaan bisa ditulis, ia yang dipakai — cadangan tidak disentuh.
  const first = pickWritableDir(candidates, { mkdir: () => {}, writable: () => true });
  assert.equal(first.dir, candidates[0]);
  assert.equal(first.tried.length, 1, 'berhenti pada kandidat pertama yang berhasil');

  // Tidak ada yang bisa ditulis: kembalikan kandidat pertama supaya pesan galat
  // menyebut path yang memang diharapkan.
  const none = pickWritableDir(candidates, { mkdir: () => {}, writable: () => false });
  assert.equal(none.dir, candidates[0]);
  assert.equal(none.tried.every((t) => !t.ok), true);

  // Folder yang gagal dibuat (mis. izin ditolak) juga dilewati, bukan melempar.
  const thrown = pickWritableDir(candidates, {
    mkdir: (d) => { if (/Program Files/.test(d)) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } },
    writable: () => true,
  });
  assert.equal(thrown.dir, candidates[1]);
  assert.match(thrown.tried[0].reason, /EACCES/);
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

test('install: launchInstaller melaporkan kegagalan spawn alih-alih mematikan proses', () => {
  // `spawn` bisa gagal secara ASINKRON (antivirus, berkas hilang). Tanpa
  // pendengar `error`, Node melempar error tak tertangani dan server mati
  // tepat sesudah user menekan "pasang".
  const seen = [];
  const fakeSpawn = () => {
    const handlers = {};
    return {
      pid: 4242,
      on: (ev, fn) => { handlers[ev] = fn; },
      unref: () => { seen.push('unref'); },
      emit: (ev, arg) => handlers[ev]?.(arg),
    };
  };
  const child = fakeSpawn();
  const r = launchInstaller('C:\\fake\\setup.exe', 'win32', () => child, { onError: (e) => seen.push(`err:${e.message}`) });
  assert.equal(r.launched, true);
  assert.equal(r.mode, 'silent');
  assert.deepEqual(seen, ['unref'], 'proses dilepas agar induk bisa keluar');
  // Simulasikan kegagalan asinkron: pelapor dipanggil, bukan melempar.
  child.emit('error', new Error('EBUSY'));
  assert.deepEqual(seen, ['unref', 'err:EBUSY']);

  // macOS/Linux tidak bisa senyap — mode jujur "open", bukan "silent" palsu.
  const mac = launchInstaller('/Applications/x.dmg', 'darwin', () => fakeSpawn());
  assert.equal(mac.mode, 'open');
});

test('install: kebijakan mesin bisa melarang installer dijalankan', async () => {
  // Tanpa kunci ini, satu-satunya cara mematikan pemasangan otomatis adalah
  // mematikan autoUpdate sepenuhnya — yang juga mematikan unduhan.
  const before = process.env.AGENTHUB_NO_LAUNCH_INSTALLER;
  process.env.AGENTHUB_NO_LAUNCH_INSTALLER = '1';
  try {
    let spawned = false;
    const r = launchInstaller('x.exe', 'win32', () => { spawned = true; return {}; });
    assert.equal(r.launched, false);
    assert.equal(r.suppressed, true);
    assert.equal(spawned, false, 'tidak ada proses yang dijalankan');
  } finally {
    if (before === undefined) delete process.env.AGENTHUB_NO_LAUNCH_INSTALLER;
    else process.env.AGENTHUB_NO_LAUNCH_INSTALLER = before;
  }
});

test('install: pemasangan per-machine meminta elevasi DI DEPAN, bukan menggantung di tengah', () => {
  // Bug nyata: aplikasi terpasang per-machine (Program Files, terdaftar di HKLM
  // dengan /allusers), sedangkan installer dibangun `perMachine: false`. NSIS
  // membaca HKLM\Software\<GUID>\InstallLocation, menyimpulkan mode "all users",
  // lalu memanggil UAC_RunElevated di tengah pemasangan. Karena prosesnya
  // diluncurkan `windowsHide: true`, dialog UAC tidak pernah dijangkau user:
  // installer menunggu jawaban selamanya dan dari sisi user terlihat
  // "sudah diunduh tapi tidak bisa dipasang".
  const calls = [];
  const fakeSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { pid: 999, on: () => {}, unref: () => {} };
  };

  const r = launchInstaller('C:\\Program Files\\AgentHub\\setup.exe', 'win32', fakeSpawn, {
    needsElevation: true,
  });
  assert.equal(r.launched, true);
  assert.equal(r.mode, 'elevated', 'mode jujur: ada permintaan izin, bukan "silent"');
  assert.equal(r.needsElevation, true);

  assert.equal(calls.length, 1);
  const { file, args } = calls[0];
  assert.match(file, /powershell\.exe$/i, 'elevasi memakai jalur resmi Windows');
  const script = args[args.length - 1];
  assert.match(script, /-Verb RunAs/, 'permintaan izin harus eksplisit ke Windows');
  assert.match(script, /setup\.exe/, 'installer yang benar yang dijalankan');
  assert.match(script, /\/S/, 'pemasangan tetap senyap setelah izin diberikan');
  assert.equal(calls[0].opts.windowsHide, true, 'shell perantara tidak menampilkan jendela');
});

test('install: jalur elevasi meng-escape kutip tunggal di path', () => {
  // Path seperti C:\O'Brien\setup.exe tidak boleh memecah perintah PowerShell:
  // kutip tunggal di-escape dengan menggandakannya, bukan dibiarkan.
  let script = '';
  const fakeSpawn = (file, args) => {
    script = args[args.length - 1];
    return { pid: 1, on: () => {}, unref: () => {} };
  };
  launchInstaller("C:\\O'Brien\\setup.exe", 'win32', fakeSpawn, { needsElevation: true });
  assert.match(script, /O''Brien/, 'kutip tunggal digandakan');
  assert.equal(/O'Brien/.test(script), false, 'kutip tunggal tunggal akan memecah perintah');
});

test('install: tanpa elevasi installer dijalankan langsung dan tetap senyap', () => {
  const calls = [];
  const fakeSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { pid: 4242, on: () => {}, unref: () => {} };
  };
  const r = launchInstaller('C:\\Users\\x\\AppData\\Local\\Programs\\AgentHub\\setup.exe', 'win32', fakeSpawn, {
    needsElevation: false,
  });
  assert.equal(r.mode, 'silent');
  assert.equal(r.needsElevation, false);
  assert.equal(calls[0].file, 'C:\\Users\\x\\AppData\\Local\\Programs\\AgentHub\\setup.exe',
    'pemasangan per-user tidak butuh perantara');
  assert.deepEqual(calls[0].args, ['--updated', '/S', '--force-run'],
    'argumen lengkap: pemasangan tetap senyap DAN aplikasi dijalankan ulang');
});

test('install: penolakan UAC dilaporkan lewat onExit, bukan didiamkan', () => {
  // PowerShell keluar dengan kode bukan nol saat dialog UAC ditolak. Tanpa
  // laporan ini, penolakan hanya terlihat sebagai status yang diam sampai
  // batas waktu habis.
  const handlers = {};
  const fakeSpawn = () => ({
    pid: 7,
    on: (ev, fn) => { handlers[ev] = fn; },
    unref: () => {},
  });
  const seen = [];
  launchInstaller('x.exe', 'win32', fakeSpawn, {
    needsElevation: true,
    onExit: (code) => seen.push(code),
  });
  handlers.exit(1223); // ERROR_CANCELLED: user menolak UAC
  assert.deepEqual(seen, [1223]);
});

test('install: needsElevation ditentukan oleh kemampuan menulis folder aplikasi', () => {
  // Bukan nama foldernya yang menentukan, melainkan apakah installer benar-benar
  // bisa menimpa folder aplikasi. Folder baca-saja = NSIS akan meminta elevasi.
  assert.equal(needsElevation({ platform: 'win32', root: 'C:\\Program Files\\AgentHub', writable: false }), true);
  assert.equal(needsElevation({ platform: 'win32', root: 'C:\\Users\\x\\AppData\\Local\\Programs\\AgentHub', writable: true }), false);
  assert.equal(needsElevation({ platform: 'darwin', root: '/Applications/AgentHub.app', writable: false }), false,
    'hanya Windows yang memakai UAC di jalur installer');
});

test('install: installStall hanya menyatakan macet setelah batas waktu mode itu', () => {
  // `installing` TANPA batas waktu adalah bug yang dialami user: installer
  // menunggu UAC yang tak terjangkau, dan status tinggal di sana selamanya.
  const now = 1_000_000_000_000;
  assert.equal(installStall({ status: 'ready', mode: 'silent', startedAt: now - 1e9, now }).stalled, false,
    'status selain installing tidak pernah "macet"');
  assert.equal(installStall({ status: 'installing', mode: 'elevated', startedAt: 0, now }).stalled, false,
    'tanpa waktu mulai tidak ada yang bisa dibandingkan');

  // Jalur ber-elevasi menunggu JAWABAN USER, jadi batasnya pendek.
  const fresh = installStall({ status: 'installing', mode: 'elevated', startedAt: now - 60_000, now });
  assert.equal(fresh.stalled, false, 'satu menit masih wajar untuk menjawab UAC');
  const stale = installStall({ status: 'installing', mode: 'elevated', startedAt: now - 4 * 60_000, now });
  assert.equal(stale.stalled, true, '4 menit tanpa jawaban = macet');
  assert.match(stale.why, /izin administrator|UAC/i, 'alasan menyebut UAC, bukan "gagal"');

  // Jalur senyap menunggu DISK: 4 menit bukan alasan membatalkan.
  assert.equal(installStall({ status: 'installing', mode: 'silent', startedAt: now - 4 * 60_000, now }).stalled, false);
  assert.equal(installStall({ status: 'installing', mode: 'silent', startedAt: now - 11 * 60_000, now }).stalled, true);

  // Mode tak dikenal tidak boleh membuat status tergantung selamanya.
  assert.equal(installStall({ status: 'installing', mode: 'entah', startedAt: now - 11 * 60_000, now }).stalled, true,
    'mode tak dikenal memakai batas paling longgar yang diketahui, bukan tak terbatas');
});

test('install: hasil peluncuran selalu jujur soal elevasi', () => {
  // `mode` dipakai UI dan status untuk membedakan "sedang memasang" dari
  // "menunggu izin". Nilai yang salah di sini membuat pesan UI berbohong.
  const spawnOk = () => ({ pid: 5, on: () => {}, unref: () => {} });
  const elevated = launchInstaller('x.exe', 'win32', spawnOk, { needsElevation: true });
  assert.deepEqual(
    { mode: elevated.mode, needsElevation: elevated.needsElevation },
    { mode: 'elevated', needsElevation: true },
  );
  const silent = launchInstaller('x.exe', 'win32', spawnOk, { needsElevation: false });
  assert.deepEqual(
    { mode: silent.mode, needsElevation: silent.needsElevation },
    { mode: 'silent', needsElevation: false },
  );
  // Non-Windows tidak pernah mengaku butuh elevasi walau diminta.
  const mac = launchInstaller('/x.dmg', 'darwin', spawnOk, { needsElevation: true });
  assert.equal(mac.needsElevation, false);
});

test('install: pid peluncuran tersedia, bukan selalu null', () => {
  // Bug nyata: `spawn` diambil lewat `import()` dinamis sehingga mengembalikan
  // Promise — `child.pid` SELALU undefined dan pendengar `error` tidak pernah
  // terpasang. Kegagalan spawn jadi tidak terlihat sampai server mati.
  const r = launchInstaller('x.exe', 'win32', () => ({ pid: 31337, on: () => {}, unref: () => {} }), {});
  assert.equal(r.pid, 31337, 'pid proses anak harus diteruskan');
});

test('install: argumen installer NSIS menyertakan --updated dan --force-run', () => {
  // `/S` saja memasang berkas lalu BERHENTI: template assisted-installer hanya
  // menjalankan ulang aplikasi bila `${isForceRun}`. Akibatnya di mata user
  // "sudah diunduh, tapi tidak terjadi apa-apa". `--updated` juga wajib supaya
  // NSIS melewati halaman dan memakai jalur tutup-aplikasi khusus pembaruan.
  assert.deepEqual(installerArgs(), ['--updated', '/S', '--force-run']);
  assert.deepEqual(installerArgs({ forceRun: false }), ['--updated', '/S']);
  assert.deepEqual(installerArgs({ silent: false, forceRun: false }), ['--updated']);
  assert.equal(installerArgs()[0], '--updated', 'urutan sama dengan NsisUpdater resmi');
});

test('install: peluncuran tanpa elevasi memakai argumen lengkap, bukan /S saja', () => {
  const calls = [];
  const fakeSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { pid: 1, on: () => {}, unref: () => {} };
  };
  launchInstaller('setup.exe', 'win32', fakeSpawn, { needsElevation: false });
  assert.deepEqual(calls[0].args, ['--updated', '/S', '--force-run'],
    'tanpa --force-run aplikasi tidak pernah dijalankan ulang setelah pemasangan');
});

test('install: jalur elevasi meneruskan argumen lengkap ke Start-Process', () => {
  let script = '';
  const fakeSpawn = (file, args) => {
    script = args[args.length - 1];
    return { pid: 1, on: () => {}, unref: () => {} };
  };
  launchInstaller('setup.exe', 'win32', fakeSpawn, { needsElevation: true });
  assert.match(script, /--updated/, 'NSIS harus tahu ini pembaruan, bukan pemasangan baru');
  assert.match(script, /\/S/, 'tetap senyap');
  assert.match(script, /--force-run/, 'aplikasi dijalankan ulang sesudah pemasangan');
});

test('install: /S TIDAK PERNAH dikutip di baris argumen Start-Process', () => {
  // Ini kesalahan yang benar-benar terjadi di 1.9.12 dan membuat pemasangan
  // otomatis tidak pernah jalan. NSIS hanya mengenali mode senyap bila karakter
  // sesudah `S` adalah spasi atau akhir baris:
  //
  //   #define END_OF_ARG(c) (c == _T(' ') || c == _T('\0'))
  //   if (cmdline[0] == _T('S') && END_OF_ARG(cmdline[1])) g_exec_flags.silent = 1;
  //
  // `"/S"` membuat karakter itu tanda kutip, flag senyap diabaikan, dan installer
  // menampilkan wizard "Choose Installation Options" yang menunggu klik:
  // prosesnya hidup, terlihat "sedang memasang", tetapi tidak memasang apa pun.
  const line = startProcessArgLine();
  assert.equal(line, '--updated /S --force-run', 'argumen polos, tanpa kutip: ' + line);
  assert.ok(!/"\/S"|'\/S'/.test(line), '/S yang dikutip mematikan mode senyap NSIS');

  // Aturan yang sama harus terbukti lewat jalur peluncuran sungguhan.
  let script = '';
  const fakeSpawn = (file, args) => {
    script = args[args.length - 1];
    return { pid: 1, on: () => {}, unref: () => {} };
  };
  launchInstaller('setup.exe', 'win32', fakeSpawn, { needsElevation: true });
  const argPart = script.slice(script.indexOf('-ArgumentList') + 14);
  assert.ok(!argPart.includes('"/S"'), 'skrip PowerShell mengirim /S terkutip: ' + script);
  // Hanya argumen yang mengandung spasi/kutip yang boleh dikutip.
  assert.equal(startProcessArgLine(['--updated', '/S', 'C:\\a b\\x.exe']),
    '--updated /S "C:\\a b\\x.exe"', 'path berspasi tetap butuh kutip');
});

test('install: status pembaruan menyebut kebutuhan elevasi SEBELUM user menunggu', async () => {
  // UI harus bisa memberi tahu "Windows akan meminta izin administrator" tanpa
  // menebak dari path. Server yang tahu apakah folder aplikasi bisa ditulis,
  // jadi dialah yang menjawab. Tanpa field ini, satu-satunya cara user tahu
  // adalah melihat dialog UAC yang — pada pemasangan per-machine lama —
  // tidak pernah muncul sama sekali.
  const u = await (await api('/api/update')).json();
  assert.equal(typeof u.elevation?.needed, 'boolean',
    'status harus membawa kebutuhan elevasi: ' + JSON.stringify(u.elevation));
  assert.equal(u.elevation.needed, false,
    'server uji berjalan dari folder yang bisa ditulis, jadi tidak butuh elevasi');
});

test('install: status pemasangan yang macet kembali jujur, bukan "installing" selamanya', async () => {
  // Kegagalan nyata di mesin user: installer diluncurkan, menunggu UAC yang tak
  // pernah dijawab, dan status tinggal di `installing` selamanya. Tombol hilang,
  // unduhan dianggap berjalan, dan jalan keluarnya hanya menutup aplikasi.
  // Kontraknya: `installing` SELALU punya batas waktu, dan sesudah lewat status
  // kembali ke `ready` dengan alasan yang bisa dibaca.
  mockMode = 'ok';
  mockTag = 'v99.6.0';
  await api('/api/update-check?force=1');
  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (['ready', 'error'].includes(u.download?.status)) break;
  }
  assert.equal(u.download.status, 'ready', 'berkas siap: ' + JSON.stringify(u.download));

  // Mesin uji melarang peluncuran installer, jadi status harus tetap `ready`
  // dan TIDAK pernah berpura-pura memasang. Itu bukti bahwa status hanya
  // berpindah ke `installing` bila prosesnya benar-benar lahir.
  const r = await (await api('/api/update/install', { method: 'POST' })).json();
  assert.equal(r.launched, false, 'peluncuran dilarang di mesin uji');
  const after = await (await api('/api/update')).json();
  assert.equal(after.download.status, 'ready',
    'status tidak boleh mengaku memasang saat installer tidak dijalankan: ' + JSON.stringify(after.download));
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

test('install: installGate menolak checksum/preflight dan menunda saat ada run', () => {
  // Jalur normal
  assert.equal(installGate({ ready: true }).action, 'install');
  // Penolakan keras tidak bergantung pada `auto`
  assert.equal(installGate({ ready: true, verifyStatus: 'mismatch' }).code, 'CHECKSUM_MISMATCH');
  assert.equal(installGate({ ready: true, preflightFailed: ['disk'] }).code, 'PREFLIGHT_FAILED');
  // Satu penolakan tidak bisa ditawar dengan menekan tombol
  assert.equal(installGate({ ready: true, verifyStatus: 'mismatch', auto: false }).action, 'refuse');
  // Belum siap / sedang memasang: bukan penolakan, hanya belum waktunya
  assert.equal(installGate({ ready: false }).code, 'NOT_READY');
  assert.equal(installGate({ ready: true, installing: true }).code, 'INSTALLING');
  // Penundaan HANYA berlaku untuk pemasangan otomatis: menekan "Pasang
  // sekarang" adalah keputusan user dan tidak boleh diabaikan diam-diam.
  assert.equal(installGate({ ready: true, activeRuns: 2 }).action, 'install', 'manual tetap jalan');
  const auto = installGate({ ready: true, activeRuns: 2, auto: true });
  assert.equal(auto.action, 'defer');
  assert.equal(auto.activeRuns, 2);
  // `unverified` (tanpa SHA256SUMS.txt) BUKAN penolakan: berkas tidak bisa
  // dibandingkan, tetapi bukan berarti rusak. UI yang wajib mengatakannya.
  assert.equal(installGate({ ready: true, verifyStatus: 'unverified' }).action, 'install');
});

test('install: cek manual dengan ?install=1 merantai unduh → verifikasi → pasang', async () => {
  // Kebijakan mesin melarang installer dijalankan, jadi yang diamati adalah
  // bahwa rantai sampai ke titik peluncuran DAN melaporkannya dengan jujur.
  mockMode = 'ok';
  mockTag = 'v99.3.0';

  const r = await api('/api/update-check?force=1&install=1');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.hasUpdate, true);
  assert.equal(body.autoInstall?.enabled, true, 'pemasangan otomatis menyala pada config default');

  // Tunggu rantai selesai. Status akhir yang sah: `ready` (dijalankan/ditahan)
  // — tidak boleh tertinggal di `downloading`.
  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (['ready', 'error', 'installing'].includes(u.download?.status)) break;
  }
  assert.equal(u.download.status, 'ready',
    'rantai berhenti di siap-pasang karena peluncuran dilarang di mesin uji: ' + JSON.stringify(u.download));
  assert.equal(u.verify.status, 'ok', 'checksum diperiksa sebelum pemasangan diputuskan: ' + JSON.stringify(u.verify));
  assert.equal(u.installable, true);
  // Gerbang terakhir tercatat, jadi UI bisa menyebut alasan apa pun yang
  // menghalangi tanpa menebak.
  assert.equal(u.autoInstall?.gate?.code, 'OK', 'gerbang meloloskan pemasangan: ' + JSON.stringify(u.autoInstall));
  assert.equal(u.autoInstall?.pending, false, 'tidak ada run aktif → tidak ada penundaan');
});

test('install: pemasangan otomatis TIDAK melewati penolakan checksum', async () => {
  mockMode = 'bad';
  mockTag = 'v99.4.0';

  await api('/api/update-check?force=1&install=1');
  let u = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (u.download?.status === 'error') break;
  }
  assert.equal(u.download.status, 'error');
  assert.equal(u.verify.status, 'mismatch');
  assert.equal(u.installable, false, 'berkas dengan checksum salah tidak pernah "siap"');
  // Status tidak boleh berpura-pura memasang berkas yang ditolak.
  assert.notEqual(u.download.status, 'installing');
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

test('install: pemasangan otomatis DITUNDA selama ada run, lalu jalan setelah run selesai', async () => {
  // Ini sambungan yang paling mudah putus tanpa ketahuan: `installGate`
  // mengembalikan `defer` dengan benar, tetapi tidak ada yang memicunya lagi
  // sesudah run terakhir selesai. Akibatnya installer tidak pernah berjalan
  // dan UI diam-diam menampilkan "menunggu" selamanya.
  mockMode = 'ok';
  mockTag = 'v99.5.0';

  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'slow' }),
  })).json();
  const run = await api(`/api/threads/${t.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'kerja panjang', engine: 'slow' }),
  });
  assert.equal(run.status, 200, 'run harus mulai supaya penundaan bisa diuji');

  const started = await (await api('/api/update')).json();
  assert.equal(started.autoInstall.activeRuns >= 1, true,
    'server harus MELIHAT run yang sedang berjalan: ' + JSON.stringify(started.autoInstall));

  await api('/api/update-check?force=1&install=1');

  let u = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 250));
    u = await (await api('/api/update')).json();
    if (u.download?.status === 'ready') break;
    if (u.download?.status === 'error') break;
  }
  assert.equal(u.download.status, 'ready', 'unduhan selesai & terverifikasi: ' + JSON.stringify(u.download));
  assert.equal(u.installable, true);
  // Inti penundaan: berkas SIAP, tetapi pemasangan sengaja belum dijalankan.
  // Installer menutup aplikasi, dan run yang masih bekerja akan mati di tengah.
  assert.equal(u.autoInstall.pending, true,
    'pemasangan harus tertunda selama run berjalan: ' + JSON.stringify(u.autoInstall));
  assert.equal(u.autoInstall.gate?.code, 'DEFERRED');
  assert.notEqual(u.download.status, 'installing', 'installer tidak boleh jalan saat agent bekerja');

  // Selesaikan run → pendengar `runs.onIdle` harus melanjutkan pemasangan.
  await api(`/api/threads/${t.id}/stop`, { method: 'POST' });
  await run.text().catch(() => '');

  let after = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 250));
    after = await (await api('/api/update')).json();
    if (after.autoInstall?.pending === false && after.autoInstall?.gate?.auto === true) break;
  }
  assert.equal(after.autoInstall.pending, false,
    'penundaan harus dilepas setelah run selesai: ' + JSON.stringify(after.autoInstall));
  assert.equal(after.autoInstall.activeRuns, 0, 'run benar-benar sudah berhenti');
  assert.equal(after.autoInstall.gate.code, 'OK',
    'gerbang meloloskan pemasangan pada percobaan kedua: ' + JSON.stringify(after.autoInstall.gate));
  assert.equal(after.autoInstall.gate.auto, true, 'perjalanan kedua berasal dari rantai otomatis');
  // Peluncuran dilarang di mesin uji, jadi status kembali `ready` — bukan
  // berpura-pura `installing` untuk installer yang tidak pernah dijalankan.
  assert.equal(after.download.status, 'ready');
});

