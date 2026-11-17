// test/queue.test.js — antrean input: FIFO, satu pemenang reservasi, TTL,
// commit/release, batas, dan idempotensi berdasarkan clientCommandId.
//
// Modul ini murni (tanpa HTTP), jadi yang diuji adalah kontrak antreannya
// sendiri: kapan item boleh hilang, kapan harus kembali, dan mengapa.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-queue-'));
process.env.AGENTHUB_DATA = dir;
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

const q = await import('../lib/queue.js');

const T = 'aaaa1111';

test.beforeEach(() => { q.clearThread(T); });

test('antrean: FIFO ketat — urutan masuk = urutan keluar', () => {
  q.enqueue(T, { prompt: 'satu' });
  q.enqueue(T, { prompt: 'dua' });
  q.enqueue(T, { prompt: 'tiga' });
  assert.deepEqual(q.list(T).map((x) => x.prompt), ['satu', 'dua', 'tiga']);
  const r1 = q.reserve(T);
  assert.equal(r1.item.prompt, 'satu');
  q.commit(T, r1.reservationId);
  const r2 = q.reserve(T);
  assert.equal(r2.item.prompt, 'dua');
});

test('antrean: reserve hanya memberi satu pemenang', () => {
  q.enqueue(T, { prompt: 'hanya' });
  const first = q.reserve(T);
  assert.ok(first.reservationId);
  // Percobaan kedua harus ditolak: item yang sama tidak boleh dijalankan dua kali.
  assert.throws(() => q.reserve(T), (e) => e.code === 'QUEUE_RESERVED' && e.statusCode === 409);
});

test('antrean: commit menghapus item, release mengembalikannya utuh', () => {
  const { item } = q.enqueue(T, { prompt: 'penting', attachments: ['u1'] });
  const r = q.reserve(T);
  assert.equal(q.count(T), 1, 'item belum hilang saat diambil');

  // Start gagal → item kembali dengan isi lengkap, bukan potongan.
  assert.equal(q.release(T, r.reservationId), true);
  const back = q.list(T);
  assert.equal(back.length, 1);
  assert.equal(back[0].prompt, 'penting');
  assert.deepEqual(back[0].attachments, ['u1']);
  assert.equal(back[0].id, item.id);
  assert.equal(back[0].reserved, false);

  // Start berhasil → baru sekarang item boleh hilang.
  const r2 = q.reserve(T);
  q.commit(T, r2.reservationId);
  assert.equal(q.count(T), 0);
});

test('antrean: commit dengan reservasi tak dikenal ditolak, bukan diam-diam', () => {
  q.enqueue(T, { prompt: 'x' });
  assert.throws(() => q.commit(T, 'tidakada'), (e) => e.code === 'QUEUE_STALE');
});

test('antrean: reservasi kedaluwarsa dilepas saat daftar dibaca', () => {
  q.enqueue(T, { prompt: 'macet' });
  const r = q.reserve(T);
  // Paksa kedaluwarsa: klien yang mati di antara ambil dan kirim.
  const file = path.join(dir, 'queue.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  map[T][0].reservedUntil = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(map));

  const items = q.list(T);
  assert.equal(items[0].reserved, false, 'TTL habis = bukan milik siapa pun lagi');
  // Dan sekarang bisa diambil lagi — antrean tidak membeku selamanya.
  const again = q.reserve(T);
  assert.ok(again.reservationId);
  assert.notEqual(again.reservationId, r.reservationId);
});

test('antrean: item yang sedang dijalankan tidak bisa dihapus', () => {
  const { item } = q.enqueue(T, { prompt: 'jalan' });
  q.reserve(T);
  assert.throws(() => q.remove(T, item.id), (e) => e.code === 'QUEUE_RESERVED');
  q.clearThread(T);
});

test('antrean: batas per thread ditegakkan dengan kode yang jelas', () => {
  for (let i = 0; i < q.MAX_QUEUE_PER_THREAD; i++) q.enqueue(T, { prompt: `p${i}` });
  assert.throws(() => q.enqueue(T, { prompt: 'lebih' }), (e) => e.code === 'QUEUE_FULL' && e.statusCode === 409);
});

test('antrean: pesan kosong tanpa lampiran ditolak', () => {
  assert.throws(() => q.enqueue(T, { prompt: '   ' }), (e) => e.code === 'QUEUE_EMPTY');
  // Lampiran saja tetap sah: file sering jadi prompt.
  const r = q.enqueue(T, { prompt: '', attachments: ['u1'] });
  assert.equal(r.item.attachments.length, 1);
});

test('antrean: clientCommandId yang sama tidak membuat item kedua', () => {
  const a = q.enqueue(T, { prompt: 'sekali', clientCommandId: 'cmd-abc123' });
  const b = q.enqueue(T, { prompt: 'sekali', clientCommandId: 'cmd-abc123' });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.item.id, a.item.id);
  assert.equal(q.count(T), 1, 'pengulangan jaringan tidak menumpuk pesan');
});

test('antrean: id yang sama boleh dipakai lagi setelah itemnya dijalankan', () => {
  q.enqueue(T, { prompt: 'sekali', clientCommandId: 'cmd-abc123' });
  const r = q.reserve(T);
  q.commit(T, r.reservationId);
  // Item yang sudah pergi tidak ada lagi di antrean, jadi id boleh dipakai lagi.
  const again = q.enqueue(T, { prompt: 'sekali', clientCommandId: 'cmd-abc123' });
  assert.equal(again.duplicate, false);
});

test('antrean: thread berbeda punya antrean sendiri', () => {
  const other = 'bbbb2222';
  q.clearThread(other);
  q.enqueue(T, { prompt: 'punya A' });
  q.enqueue(other, { prompt: 'punya B' });
  assert.deepEqual(q.list(T).map((x) => x.prompt), ['punya A']);
  assert.deepEqual(q.list(other).map((x) => x.prompt), ['punya B']);
  assert.equal(q.counts()[T], 1);
  assert.equal(q.counts()[other], 1);
  q.clearThread(other);
});
