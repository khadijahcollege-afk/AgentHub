// test/harness.test.js — pengutipan argumen Windows.
//
// Kenapa diuji terpisah: bug di sini tidak terlihat di UI. Prompt hanya
// terpotong di tengah jalan, jadi agent "menjawab" sesuatu yang bukan
// pertanyaan user. Dua kasus nyata yang pernah terjadi:
//   • "halo mesin" sampai ke CLI sebagai dua token berisi kutip harfiah.
//   • Prompt multi-baris hanya mengirim baris pertama, membuang blok skill
//     dan blok bahasa balasan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { winArg, resolveShim } from '../lib/harness.js';

test('winArg: argumen polos dibiarkan apa adanya', () => {
  assert.equal(winArg('halo'), 'halo');
  assert.equal(winArg('--permission-mode'), '--permission-mode');
  assert.equal(winArg('C:\\tools\\x.exe'), 'C:\\tools\\x.exe');
});

test('winArg: spasi dibungkus kutip tanpa mengubah isi', () => {
  assert.equal(winArg('halo mesin'), '"halo mesin"');
  // backslash yang tidak diikuti kutip tidak digandakan (path Windows aman)
  assert.equal(winArg('C:\\Program Files\\node'), '"C:\\Program Files\\node"');
});

test('winArg: tanda kutip di dalam di-escape menurut aturan MSVC', () => {
  assert.equal(winArg('katakan "halo"'), '"katakan \\"halo\\""');
  // backslash tepat sebelum kutip harus digandakan
  assert.equal(winArg('a\\"b'), '"a\\\\\\"b"');
  // backslash di akhir argumen digandakan supaya tidak lolos ke kutip penutup
  assert.equal(winArg('a b\\'), '"a b\\\\"');
});

test('winArg: metakarakter cmd tidak bisa memecah argumen', () => {
  // Kalau tidak dibungkus, `&` menjalankan perintah lain di cmd.exe.
  assert.equal(winArg('a & b'), '"a & b"');
  assert.equal(winArg('a | b > c'), '"a | b > c"');
  assert.equal(winArg('naik 50%'), '"naik 50%"');
  assert.equal(winArg('a ^ b'), '"a ^ b"');
});

test('winArg: string kosong tetap terbaca sebagai satu argumen', () => {
  assert.equal(winArg(''), '""');
});

test('winArg: unicode tidak diubah', () => {
  assert.equal(winArg('halo — dunia'), '"halo — dunia"');
  // di luar ASCII aman karena diteruskan sebagai UTF-16 ke cmd.exe
  assert.equal(winArg('日本語'), '日本語');
});

// ---------- resolveShim ----------
// Di Windows, `claude`/`codex`/... adalah shim .cmd buatan npm. Memanggil shim
// itu lewat cmd.exe memotong prompt pada newline dan pada 8191 karakter, jadi
// resolver mencari program sebenarnya di balik shim. Kalau resolver salah,
// prompt panjang hilang tanpa pesan apa pun — karena itu bentuk-bentuk shim
// yang nyata diuji di sini.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shim-test-'));

test('resolveShim: shim .exe mengembalikan exe tanpa prefix', () => {
  const dir = tmp();
  try {
    const exe = path.join(dir, 'tool.exe');
    fs.writeFileSync(exe, 'x');
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"${exe}"   %*\r\n`);
    assert.deepEqual(resolveShim(shim), { cmd: exe, prefix: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveShim: shim skrip .js dijalankan lewat node', () => {
  const dir = tmp();
  try {
    const js = path.join(dir, 'tool.js');
    fs.writeFileSync(js, '');
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "${js}" %*\r\n`);
    assert.deepEqual(resolveShim(shim), { cmd: process.execPath, prefix: [js] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveShim: node.exe eksplisit + skrip jadi prefix, bukan target', () => {
  // Bentuk ini muncul saat shim ditulis dengan path node absolut. Kalau resolver
  // berhenti di node.exe, skripnya hilang dan CLI tidak bisa dijalankan.
  const dir = tmp();
  try {
    const js = path.join(dir, 'tool.js');
    fs.writeFileSync(js, '');
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${js}" %*\r\n`);
    assert.deepEqual(resolveShim(shim), { cmd: process.execPath, prefix: [js] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveShim: shim tanpa target yang ada di disk ditolak (null)', () => {
  const dir = tmp();
  try {
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@ECHO off\r\n"${path.join(dir, 'hilang.exe')}" %*\r\n`);
    assert.equal(resolveShim(shim), null, 'jalur cmd.exe dipakai, bukan path palsu');

    const noArgs = path.join(dir, 'kosong.cmd');
    fs.writeFileSync(noArgs, '@ECHO off\r\necho halo\r\n');
    assert.equal(resolveShim(noArgs), null, 'tidak ada %* = bukan shim');

    assert.equal(resolveShim(path.join(dir, 'tidak-ada.cmd')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveShim: variabel batch seperti %_prog% tidak dianggap path', () => {
  const dir = tmp();
  try {
    const js = path.join(dir, 'tool.js');
    fs.writeFileSync(js, '');
    const shim = path.join(dir, 'tool.cmd');
    fs.writeFileSync(shim, `@ECHO off\r\n"%_prog%" "${js}" %*\r\n`);
    const r = resolveShim(shim);
    assert.ok(r, 'tetap teresolusi');
    assert.ok(!String(r.cmd).includes('%'), 'tidak mengembalikan nama variabel');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
