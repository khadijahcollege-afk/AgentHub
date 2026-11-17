// test/snapshot.test.js — anggaran byte thread untuk perangkat kecil.
//
// Yang diuji: pemotongan hanya pada respons (data pemanggil utuh), pesan user
// tidak pernah dipotong, pemotongan dimulai dari pesan terbesar, `refId`
// menunjuk indeks ASLI, dan isi lengkap bisa diambil ulang dengan hash cocok.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as snap from '../lib/snapshot.js';

const bytes = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');

function threadWith({ count = 20, hugeAt = 25, hugeLen = 150000 } = {}) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: `pertanyaan ${i}`, ts: 1000 + i });
    messages.push({
      id: `a${i}`,
      role: 'assistant',
      content: 'x'.repeat(i === hugeAt ? hugeLen : 120),
      ts: 1000 + i,
    });
  }
  return { id: 't1', title: 'Besar', messages };
}

test('tanpa parameter, thread dikembalikan apa adanya', () => {
  const t = threadWith();
  assert.equal(snap.applyLimits(t, {}), t, 'objek yang sama, tanpa salinan');
  assert.equal(snap.applyLimits(t).messages.length, t.messages.length);
});

test('messageLimit memotong dari depan dan melaporkan jumlahnya', () => {
  const t = threadWith({ count: 10 });
  const out = snap.applyLimits(t, { messageLimit: 4 });
  assert.equal(out.messages.length, 4);
  assert.equal(out.truncatedMessages, 16);
  // Yang tersisa adalah bagian AKHIR: pekerjaan terakhir, bukan pembukaan.
  assert.equal(out.messages.at(-1).id, 'a9');
  assert.equal(t.messages.length, 20, 'data pemanggil tidak berubah');
});

test('anggaran byte memotong pesan assistant terbesar lebih dulu', () => {
  const t = threadWith({ count: 20, hugeAt: 8, hugeLen: 120000 });
  const before = bytes(t);
  const out = snap.applyLimits(t, { byteBudget: 65536 });
  const after = bytes(out);

  assert.ok(after <= 70000, `respons harus mendekati anggaran (${after})`);
  assert.ok(after < before / 2, 'setidaknya separuh muatan hilang');
  assert.equal(out.bodyRefs.length, 1, 'hanya satu pesan raksasa yang perlu dipotong');
  assert.equal(out.bodyRefs[0].refId, 'm17', 'indeks pesan ASLI (17), bukan indeks setelah potong');
  assert.ok(out.bodyRefs[0].fullBytes > out.bodyRefs[0].previewBytes);
  assert.equal(out.byteBudgetApplied, true);
});

test('pesan user tidak pernah dipotong', () => {
  const t = {
    id: 't2',
    messages: [
      { id: 'u1', role: 'user', content: 'y'.repeat(120000) },
      { id: 'a1', role: 'assistant', content: 'z'.repeat(120000) },
    ],
  };
  const out = snap.applyLimits(t, { byteBudget: 40000 });
  assert.equal(out.messages[0].content.length, 120000, 'teks yang diketik pengguna tetap utuh');
  assert.equal(out.messages[0].truncated, undefined);
  assert.equal(out.messages[1].truncated, true, 'balasan assistant yang dipotong');
});

test('pesan subrun tidak dipotong', () => {
  const t = {
    id: 't3',
    messages: [
      { id: 's1', role: 'assistant', subrun: true, content: 'q'.repeat(120000) },
      { id: 'a1', role: 'assistant', content: 'z'.repeat(120000) },
    ],
  };
  const out = snap.applyLimits(t, { byteBudget: 40000 });
  assert.equal(out.messages[0].content.length, 120000);
  assert.equal(out.messages[1].truncated, true);
});

test('prilaku pemanggil tidak berubah oleh pemotongan', () => {
  const t = threadWith({ count: 6, hugeAt: 3, hugeLen: 90000 });
  const original = t.messages[7].content;
  const out = snap.applyLimits(t, { byteBudget: 40000 });

  assert.equal(t.messages[7].content, original, 'objek asli tidak boleh ikut dipotong');
  assert.equal(t.messages[7].truncated, undefined);
  assert.ok(out.messages[7].content.length < original.length, 'salinan yang dipotong ada di respons');
  assert.notEqual(out.messages[7], t.messages[7], 'pesan hasil potong adalah objek baru');
});

test('bodyFor mengambil isi lengkap dari thread tersimpan + hash cocok', () => {
  const t = threadWith({ count: 6, hugeAt: 3, hugeLen: 90000 });
  const out = snap.applyLimits(t, { byteBudget: 40000 });
  const ref = out.bodyRefs[0];
  const body = snap.bodyFor(t, ref.refId);

  assert.equal(Buffer.byteLength(body.content, 'utf8'), ref.fullBytes, 'isi lengkap, bukan pratinjau');
  assert.ok(body.content.length > out.messages.find((m) => m.refId === ref.refId).content.length);
  assert.equal(body.hash, ref.hash, 'hash pratinjau harus sama dengan isi lengkap');
  assert.equal(body.role, 'assistant');
});

test('bodyFor menolak refId yang tidak dikenal atau berbahaya', () => {
  const t = threadWith({ count: 2 });
  assert.equal(snap.bodyFor(t, 'm999'), null, 'indeks di luar jangkauan');
  assert.equal(snap.bodyFor(t, '../etc/passwd'), null);
  assert.equal(snap.bodyFor(t, 'abc'), null);
  assert.equal(snap.bodyFor(null, 'm0'), null);
});

test('clampBudget menjaga anggaran di antara batas bawah dan atas', () => {
  assert.equal(snap.clampBudget(1), snap.MIN_BYTE_BUDGET);
  assert.equal(snap.clampBudget(9e9), snap.MAX_BYTE_BUDGET);
  assert.equal(snap.clampBudget('abc'), snap.DEFAULT_BYTE_BUDGET);
  assert.equal(snap.clampBudget(0), snap.DEFAULT_BYTE_BUDGET);
  assert.equal(snap.clampBudget(-5), snap.DEFAULT_BYTE_BUDGET);
  assert.equal(snap.clampBudget(65536), 65536);
});

test('anggaran kecil tetap memberi pratinjau yang masih bisa dinilai', () => {
  const t = threadWith({ count: 4, hugeAt: 2, hugeLen: 200000 });
  const out = snap.applyLimits(t, { byteBudget: snap.MIN_BYTE_BUDGET });
  const trimmed = out.messages.find((m) => m.truncated);
  assert.ok(trimmed, 'ada pesan yang dipotong');
  assert.ok(trimmed.content.length >= 2000, 'pratinjau tidak boleh jadi beberapa karakter saja');
});
test('thread yang sudah kecil tidak dipotong sama sekali', () => {
  const t = { id: 't4', messages: [{ id: 'a', role: 'assistant', content: 'pendek' }] };
  const out = snap.applyLimits(t, { byteBudget: 200000 });
  assert.equal(out.bodyRefs, undefined);
  assert.equal(out.messages[0].truncated, undefined);
});
