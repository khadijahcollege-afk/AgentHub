// test/port-helper.test.js — pemilih port tes harus melewati port yang terpakai.
// Regresi nyata: port 8890 di mesin ini dipakai server proyek lain, jadi tes
// share gagal boot dengan pesan "server harus hidup" seolah kode yang rusak.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { pickFreePort } from './helpers/port.js';

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
