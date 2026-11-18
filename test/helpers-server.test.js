// test/helpers-server.test.js — helper boot tes harus JUJUR saat gagal.
//
// Kenapa diuji: 28 berkas tes menjalankan `server.js` sungguhan. Sebelum ini,
// bila boot gagal, satu-satunya pesan adalah "server harus hidup" setelah
// menunggu 20 detik — tanpa sebab. Flake jadi mahal karena tidak bisa
// dibedakan antara bug server dan gangguan lingkungan.
//
// Tiga janji yang dikunci di sini, semuanya ditemukan dari kegagalan nyata:
//   1. port yang sudah dipakai → gagal CEPAT (bukan 20 detik) dan pesannya
//      menyebut port itu, bukan "server harus hidup"
//   2. server yang menemukan portnya terpakai TIDAK boleh diam-diam pindah
//      port (AGENTHUB_STRICT_PORT) — itu yang membuat tes menunggu selamanya
//      di port yang salah
//   3. `stopTestServer` benar-benar melepas port sebelum mengembalikan kendali,
//      supaya berkas berikutnya tidak mendapat port yang masih dipegang
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer, removeDir } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = await pickFreePort(9020, 30);
let dataDir;

function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '0.0.0.0', () => resolve(srv));
  });
}

test.before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-helper-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: 'helpertok0123456789', notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
});

test.after(() => { removeDir(dataDir); });

test('helper: port terpakai → gagal cepat dengan sebab yang benar', async () => {
  const blocker = await occupy(PORT);
  try {
    const t0 = Date.now();
    const boot = await startTestServer({ root: ROOT, port: PORT, dataDir, waitMs: 15000 });
    const elapsed = Date.now() - t0;

    assert.equal(boot.alive, false, 'tidak boleh dianggap hidup');
    // Server keluar sendiri karena strict port, jadi tidak perlu menunggu
    // batas waktu penuh. Ambang longgar (5 dtk) supaya tidak flaky di CI.
    assert.ok(elapsed < 5000, `harus gagal cepat, bukan menunggu timeout: ${elapsed} ms`);

    const msg = boot.failure();
    assert.match(msg, /sudah dipakai|keluar lebih awal/, `pesan harus menyebut sebabnya: ${msg}`);
    assert.ok(msg.includes(String(PORT)), `pesan harus menyebut port ${PORT} yang bentrok: ${msg}`);
    assert.ok(boot.log.trim().length > 0, 'keluaran server harus tertangkap, bukan dibuang');

    await stopTestServer(boot.child);
  } finally {
    blocker.close();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('helper: server TIDAK memundurkan port saat AGENTHUB_STRICT_PORT aktif', async () => {
  // Inilah akar flake lama: server diam-diam pindah ke port+1, tes menunggu
  // port aslinya, lalu melaporkan "server harus hidup" padahal server hidup.
  const blocker = await occupy(PORT);
  try {
    const boot = await startTestServer({ root: ROOT, port: PORT, dataDir, waitMs: 15000 });
    assert.equal(boot.alive, false);
    assert.ok(boot.exited, 'server harus keluar, bukan pindah port');
    assert.equal(boot.exited.code, 1);
    assert.match(boot.log, /STRICT_PORT|sudah dipakai/i);
    await stopTestServer(boot.child);
  } finally {
    blocker.close();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('helper: boot normal berhasil dan port dilepas setelah stop', async () => {
  const boot = await startTestServer({ root: ROOT, port: PORT, dataDir });
  assert.equal(boot.alive, true, boot.failure());
  assert.equal(boot.exited, null, 'proses masih hidup');

  await stopTestServer(boot.child);

  // Port harus benar-benar bisa didengarkan lagi. Tanpa ini, berkas tes
  // berikutnya bisa kehilangan port ke proses yang sedang mati.
  const again = net.createServer();
  const freed = await new Promise((resolve) => {
    again.once('error', () => resolve(false));
    again.listen(PORT, '0.0.0.0', () => resolve(true));
  });
  await new Promise((r) => again.close(r));
  assert.equal(freed, true, 'port harus bebas setelah stopTestServer');
});

test('helper: stopTestServer aman dipanggil dua kali dan pada proses yang sudah mati', async () => {
  const boot = await startTestServer({ root: ROOT, port: PORT, dataDir });
  await stopTestServer(boot.child);
  await stopTestServer(boot.child); // tidak boleh melempar
  await stopTestServer(null);       // tidak boleh melempar
});

test('helper: crash SETELAH boot tidak boleh dilaporkan sebagai port bentrok', async () => {
  // Regresi nyata: helper melaporkan "biasanya port sudah dipakai" untuk
  // setiap kematian dini, padahal pada satu kegagalan log-nya berisi banner
  // "AgentHub aktif" — server sempat hidup lalu crash. Sebab yang salah
  // membuat orang memeriksa port yang tidak bersalah, dan menyembunyikan
  // crash yang sebenarnya.
  const boot = await startTestServer({
    root: ROOT, port: PORT, dataDir, waitMs: 8000,
    script: 'test/helpers/crash-after-boot.js',
  });

  assert.equal(boot.alive, false, 'fixture tidak pernah menjawab /healthz');
  assert.ok(boot.exited, 'proses harus tercatat sudah keluar');

  const msg = boot.failure();
  assert.match(msg, /crash setelah boot/, `harus menyebut crash setelah boot: ${msg}`);
  assert.doesNotMatch(msg, /port \d+ sudah dipakai proses lain/, 'tidak boleh menuduh port');
  // Kode Windows disebut dengan nama, supaya laporan bisa dicari. Node
  // memetakan abort native menjadi SIGABRT (134), sedangkan fast-fail
  // Windows muncul sebagai NTSTATUS mentah — keduanya harus terbaca jelas.
  if (process.platform === 'win32') {
    assert.match(msg, /0xC0000409|SIGABRT|134/, 'kode berhenti paksa harus disebut namanya');
  }

  await stopTestServer(boot.child);
});
