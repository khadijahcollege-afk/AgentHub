// test/store.test.js — penulisan JSON atomik dengan retry rename.
//
// Kenapa diuji: `writeJson` adalah satu-satunya jalan data AgentHub disimpan.
// Di Windows, `rename` bisa gagal `EPERM` sesaat karena antivirus memindai
// berkas yang baru ditulis. Sebelum 1.9.0 kegagalan itu naik ke pemanggil dan
// membuat penyimpanan config gagal tanpa sebab yang terlihat. Tes ini mengunci
// dua hal: tulisan biasa tetap benar, dan kegagalan transien benar-benar
// dicoba ulang alih-alih langsung dilempar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR dibaca saat modul diimpor, jadi env harus diset sebelum import.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-store-'));
process.env.AGENTHUB_DATA = DATA;

const store = await import('../lib/store.js');

test.after(() => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* noop */ }
});

test('store: writeJson menulis lalu bisa dibaca kembali', () => {
  store.writeJson('a.json', { nama: 'uji', n: 1, nested: { ok: true } });
  assert.deepEqual(store.readJson('a.json', null), { nama: 'uji', n: 1, nested: { ok: true } });
  // Berkasnya JSON yang terbaca manusia (indentasi 2 spasi), bukan satu baris.
  const raw = fs.readFileSync(path.join(DATA, 'a.json'), 'utf8');
  assert.match(raw, /\n  "nama"/);
});

test('store: writeJson menimpa tanpa meninggalkan berkas .tmp', () => {
  for (let i = 0; i < 20; i++) store.writeJson('b.json', { i });
  assert.deepEqual(store.readJson('b.json', null), { i: 19 });
  assert.equal(fs.existsSync(path.join(DATA, 'b.json.tmp')), false, 'berkas sementara tidak boleh tertinggal');
});

test('store: readJson mengembalikan fallback untuk berkas hilang atau rusak', () => {
  assert.equal(store.readJson('tidak-ada.json', 'default'), 'default');
  fs.writeFileSync(path.join(DATA, 'rusak.json'), '{ bukan json');
  assert.equal(store.readJson('rusak.json', 'default'), 'default', 'JSON rusak tidak boleh melempar');
});

test('store: kegagalan rename yang transien dicoba ulang, bukan langsung dilempar', () => {
  // Simulasi antivirus: `renameSync` gagal EPERM dua kali lalu berhasil.
  // Yang diuji adalah PERILAKU retry, bukan sistem berkasnya.
  const target = path.join(DATA, 'c.json');
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls += 1;
    if (calls <= 2) {
      const e = new Error('simulasi antivirus menahan berkas');
      e.code = 'EPERM';
      throw e;
    }
    return realRename(from, to);
  };
  try {
    store.writeJson('c.json', { selamat: true });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(calls, 3, 'dua kegagalan transien + satu keberhasilan');
  assert.deepEqual(store.readJson('c.json', null), { selamat: true });
});

test('store: kegagalan permanen tetap dilaporkan, tidak ditelan', () => {
  // Retry tidak boleh menyembunyikan error sungguhan: bila rename selalu
  // gagal, pemanggil HARUS tahu — data yang tidak tersimpan tidak boleh
  // terlihat seperti tersimpan.
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => {
    calls += 1;
    const e = new Error('disk penuh');
    e.code = 'ENOSPC';
    throw e;
  };
  try {
    assert.throws(() => store.writeJson('d.json', { x: 1 }), /disk penuh/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(calls, 1, 'error non-transien tidak diulang');
});
