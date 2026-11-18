// test/port-helper.test.js — pemilih port tes harus melewati port yang terpakai.
// Regresi nyata: port 8890 di mesin ini dipakai server proyek lain, jadi tes
// share gagal boot dengan pesan "server harus hidup" seolah kode yang rusak.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function occupy(port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, host, () => resolve(srv));
  });
}

test('port yang sedang dipakai dilewati', async () => {
  // cari satu port bebas, lalu pakai — pemilih harus melompatinya
  const free = await pickFreePort(9200, 60);
  const srv = await occupy(free);
  try {
    const picked = await pickFreePort(free, 6);
    assert.notEqual(picked, free, 'tidak boleh menawarkan port yang sudah dipakai');
    assert.equal(picked >= free && picked < free + 6, true, 'tetap berada di rentang yang diminta');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('seluruh rentang terpakai → jatuh ke port ephemeral OS', async () => {
  const base = await pickFreePort(9300, 20);
  const srv = await occupy(base);
  try {
    // rentang selebar 1 dan sudah dipakai: tidak ada kandidat tersisa
    const picked = await pickFreePort(base, 1);
    assert.equal(picked > 0, true);
    assert.notEqual(picked, base);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('port hasil pilihan benar-benar bisa didengarkan', async () => {
  const port = await pickFreePort(9400, 30);
  const srv = await occupy(port);
  try {
    assert.equal(srv.address().port, port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('port yang didengarkan proses lain di :: saja tetap dilewati', async () => {
  // Regresi nyata: server tetangga mendengarkan `::` saja. Bind IPv4 ke
  // 0.0.0.0 di port yang sama BERHASIL di Windows, jadi pemeriksaan "bisa
  // didengarkan" saja tidak cukup — permintaan ke 127.0.0.1 akan dijawab
  // proses lain itu dan server uji tidak pernah terlihat hidup.
  const free = await pickFreePort(9500, 60);
  let srv;
  try {
    srv = await occupy(free, '::');
  } catch {
    return; // platform tanpa IPv6: kasus ini tidak berlaku
  }
  try {
    const picked = await pickFreePort(free, 6);
    assert.notEqual(picked, free, 'port yang menjawab di :: tidak boleh ditawarkan');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('blok port setiap berkas tes tidak bertumpuk', () => {
  // Regresi nyata: 16 pasang berkas memilih port dari rentang yang sama
  // (mcp-api 8760-8799 dan threads-export 8760-8779, dan seterusnya). Tes
  // berjalan berurutan, tetapi `kill()` tidak seketika melepas port, jadi
  // berkas berikutnya bisa mendapat port yang masih dipegang proses yang
  // sedang mati — dan gagal dengan pesan yang menyesatkan.
  //
  // Invarian ini murah diuji dan mahal ditemukan kembali, jadi ia dikunci:
  // setiap berkas yang menjalankan server WAJIB memakai blok 40 port sendiri.
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
  const blocks = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    // Berkas yang memakai port ephemeral dari OS tidak masuk hitungan.
    const m = /const\s+PORT\s*=\s*await\s+pickFreePort\((\d+)(?:,\s*(\d+))?\)/.exec(src);
    if (!m) continue;
    const lo = Number(m[1]);
    const span = m[2] ? Number(m[2]) : 20;
    blocks.push({ file: f, lo, hi: lo + span - 1 });
  }

  assert.ok(blocks.length >= 25, `harus menemukan blok port: hanya ${blocks.length}`);

  const overlaps = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]; const b = blocks[j];
      if (a.lo <= b.hi && b.lo <= a.hi) overlaps.push(`${a.file} (${a.lo}-${a.hi}) x ${b.file} (${b.lo}-${b.hi})`);
    }
  }
  assert.deepEqual(overlaps, [], `blok port bertumpuk:\n${overlaps.join('\n')}`);
});

