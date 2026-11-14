// test/build-machines.test.js — hasil generate machines harus deterministik
// walau checkout memakai CRLF (runner Windows core.autocrlf=true). Inilah yang
// membuat GitHub Actions gagal padahal isi file sama.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, isSynced } from '../tools/build-machines.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'lib', 'machines.js');

test('machines: file publik sinkron dengan sumber', () => {
  assert.equal(isSynced(), true);
});

test('machines: sumber CRLF menghasilkan output LF yang identik', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-machines-'));
  try {
    const src = path.join(dir, 'lib-machines.js');
    const outFile = path.join(dir, 'public-machines.js');
    // normalisasi dulu: clone ini sendiri bisa sudah ber-CRLF
    const original = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const expected = render(SRC);

    // sumber ber-CRLF (kondisi checkout CI Windows) → output tetap LF
    fs.writeFileSync(src, original.replace(/\n/g, '\r\n'));
    assert.equal(render(src).includes('\r'), false, 'output tidak boleh CRLF');

    fs.writeFileSync(outFile, expected);
    assert.equal(isSynced(src, outFile), true, 'sumber CRLF + output LF harus sinkron');

    // output yang terlanjur CRLF (checkout lama) tetap dianggap sinkron
    fs.writeFileSync(outFile, expected.replace(/\n/g, '\r\n'));
    assert.equal(isSynced(src, outFile), true, 'output CRLF harus toleran');

    // perbedaan isi nyata tetap terdeteksi
    fs.writeFileSync(outFile, expected + '\n// tambahan\n');
    assert.equal(isSynced(src, outFile), false, 'isi berbeda harus gagal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
