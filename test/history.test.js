// test/history.test.js — riwayat percakapan yang dikirim ke gateway.
// Fungsi murni, tanpa jaringan: memastikan konteks thread benar-benar ikut,
// tetapi dibatasi agar thread panjang tidak membanjiri provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-history-'));
process.env.AGENTHUB_DATA = dataDir;
const { buildPoolMessages } = await import('../lib/harness.js');

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('history: tanpa riwayat hanya mengirim pesan baru', () => {
  assert.deepEqual(buildPoolMessages(undefined, 'halo'), [{ role: 'user', content: 'halo' }]);
  assert.deepEqual(buildPoolMessages([], 'halo'), [{ role: 'user', content: 'halo' }]);
});

test('history: urutan role dipertahankan dan pesan baru ada di akhir', () => {
  const history = [
    { role: 'user', content: 'pertama' },
    { role: 'assistant', content: 'jawaban pertama' },
    { role: 'user', content: 'kedua' },
    { role: 'assistant', content: 'jawaban kedua' },
  ];
  const msgs = buildPoolMessages(history, 'ketiga');
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(msgs.at(-1).content, 'ketiga');
  assert.equal(msgs[1].content, 'jawaban pertama');
});

test('history: subrun, pesan streaming, dan error tidak dikirim ulang', () => {
  const history = [
    { role: 'user', content: 'konteks sah' },
    { role: 'assistant', content: 'sedang menulis', status: 'working' },
    { role: 'assistant', content: 'subrun delegation', subrun: true },
    { role: 'assistant', content: 'run gagal', runStatus: 'error' },
    { role: 'assistant', content: 'jawaban sah', runStatus: 'done' },
    { role: 'system', content: 'bukan pesan percakapan' },
    { role: 'assistant', content: '   ' },
  ];
  const msgs = buildPoolMessages(history, 'lanjut');
  assert.deepEqual(msgs.map((m) => m.content), ['konteks sah', 'jawaban sah', 'lanjut']);
});

test('history: pesan paling lama dibuang lebih dulu saat melewati batas', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `pesan-${i}`,
  }));
  const msgs = buildPoolMessages(history, 'baru');
  assert.ok(msgs.length <= 13, `maksimal 12 riwayat + pesan baru, dapat ${msgs.length}`);
  assert.equal(msgs.at(-1).content, 'baru');
  // pesan terbaru harus bertahan, pesan paling awal harus hilang.
  assert.equal(msgs.at(-2).content, 'pesan-29');
  assert.equal(msgs.some((m) => m.content === 'pesan-0'), false);
});

test('history: total karakter dibatasi dan pesan tertua dipotong dari depan', () => {
  const big = 'x'.repeat(5000);
  const history = [
    { role: 'user', content: `AWAL-${big}` },
    { role: 'assistant', content: big },
    { role: 'user', content: big },
    { role: 'assistant', content: big },
  ];
  const msgs = buildPoolMessages(history, 'baru');
  const chars = msgs.slice(0, -1).reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 12000, `riwayat harus <= 12000 karakter, dapat ${chars}`);
  // Pesan yang dipotong mempertahankan bagian akhirnya (paling dekat ke sekarang).
  assert.equal(msgs[0].content.startsWith('AWAL-'), false);
  assert.equal(msgs[0].content.endsWith('x'), true);
});
