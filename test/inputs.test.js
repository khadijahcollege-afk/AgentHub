// test/inputs.test.js — buku besar idempotensi kiriman: klaim sebelum run,
// pelengkapan sesudahnya, pelepasan saat run tidak jadi mulai.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-inputs-'));
process.env.AGENTHUB_DATA = dir;
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

const ledger = await import('../lib/inputs.js');

const T = 'aaaa1111';
const CMD = 'cmd-abc123';

test.beforeEach(() => { ledger.reset(); });

test('id perintah: hanya bentuk aman yang diterima', () => {
  assert.equal(ledger.normalizeCommandId('cmd-abc123'), 'cmd-abc123');
  assert.equal(ledger.normalizeCommandId('  cmd-abc123  '), 'cmd-abc123');
  assert.equal(ledger.normalizeCommandId('lima5'), null, 'terlalu pendek ditolak');
  assert.equal(ledger.normalizeCommandId('ada spasi'), null);
  assert.equal(ledger.normalizeCommandId('a'.repeat(65)), null, 'terlalu panjang ditolak');
  assert.equal(ledger.normalizeCommandId('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(ledger.normalizeCommandId(null), null);
  assert.equal(ledger.normalizeCommandId(12345), null);
});

test('klaim pertama kosong, klaim kedua mengembalikan catatan lama', () => {
  assert.equal(ledger.claim(T, CMD), null, 'id baru: tidak ada catatan');
  const again = ledger.claim(T, CMD);
  assert.ok(again, 'id yang sama: catatan dikembalikan');
  assert.equal(again.status, 'accepted');
  assert.equal(again.commandId, CMD);
});

test('settle melengkapi status dan pesan user', () => {
  ledger.claim(T, CMD);
  assert.equal(ledger.settle(T, CMD, { status: 'done', userMessageId: 'm1' }), true);
  const rec = ledger.lookup(T, CMD);
  assert.equal(rec.status, 'done');
  assert.equal(rec.userMessageId, 'm1');
});

test('settle pada catatan yang tidak ada bukan kesalahan', () => {
  assert.equal(ledger.settle(T, 'tidakada123', { status: 'done' }), false);
});

test('forget melepas klaim supaya kiriman yang diperbaiki bisa masuk', () => {
  ledger.claim(T, CMD);
  assert.equal(ledger.forget(T, CMD), true);
  assert.equal(ledger.lookup(T, CMD), null);
  // Klaim berikutnya harus dianggap baru — bukan "sudah diterima".
  assert.equal(ledger.claim(T, CMD), null);
});

test('forget pada catatan yang tidak ada mengembalikan false', () => {
  assert.equal(ledger.forget(T, 'tidakada123'), false);
});

test('tanpa id perintah, buku besar tidak mencatat apa pun', () => {
  assert.equal(ledger.claim(T, null), null);
  assert.equal(ledger.lookup(T, null), null);
  assert.equal(ledger.settle(T, null, { status: 'done' }), false);
});

test('catatan terpisah per thread untuk id yang sama', () => {
  ledger.claim(T, CMD, { queueItemId: 'q1' });
  assert.equal(ledger.lookup('bbbb2222', CMD), null, 'id yang sama di thread lain bukan duplikat');
  assert.equal(ledger.lookup(T, CMD).queueItemId, 'q1');
});

test('catatan kedaluwarsa dianggap tidak ada', () => {
  ledger.claim(T, CMD);
  // Penuaan catatan disimulasikan langsung di berkas: menunggu 24 jam di tes
  // bukan pilihan, tetapi jalur kodenya harus tetap terbukti.
  const file = path.join(dir, 'inputs.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of Object.keys(map)) map[k].at = Date.now() - (ledger.LEDGER_TTL_MS + 1000);
  fs.writeFileSync(file, JSON.stringify(map));

  assert.equal(ledger.lookup(T, CMD), null);
  assert.equal(ledger.claim(T, CMD), null, 'kedaluwarsa = boleh diklaim ulang');
});

test('jumlah catatan dibatasi, yang terbaru dipertahankan', () => {
  const n = ledger.MAX_ENTRIES + 20;
  for (let i = 0; i < n; i++) ledger.claim(T, `cmd-${String(i).padStart(6, '0')}`);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
  assert.ok(Object.keys(map).length <= ledger.MAX_ENTRIES, 'berkas tidak tumbuh tanpa batas');
  // Yang terbaru harus selamat: pengulangan yang masuk akal datang beberapa
  // detik kemudian, bukan untuk kiriman dari kemarin.
  const newest = `cmd-${String(n - 1).padStart(6, '0')}`;
  assert.ok(ledger.lookup(T, newest), 'catatan terbaru tidak ikut terpangkas');
});
