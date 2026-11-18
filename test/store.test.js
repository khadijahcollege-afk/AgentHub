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

test('store: config baru menyimpan autoUpdate sebagai nilai, bukan tebakan', () => {
  // Regresi: `autoUpdate` dulu TIDAK ada di DEFAULT_CONFIG, dan seluruh kode
  // memakai `config.autoUpdate !== false`. Artinya pengguna yang tidak pernah
  // melihat pilihan itu selalu dianggap memilih "pasang otomatis" — dan tidak
  // ada jalan mematikannya dari UI karena nilainya tidak pernah tersimpan.
  const cfgPath = path.join(DATA, 'config.json');
  try { fs.unlinkSync(cfgPath); } catch { /* belum ada */ }
  const fresh = store.loadConfig();
  assert.equal(fresh.autoUpdate, true, 'default: pembaruan otomatis menyala');
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(onDisk.autoUpdate, true, 'nilai benar-benar tertulis ke config.json');
  // Mematikannya harus bertahan setelah dimuat ulang.
  store.saveConfig({ ...fresh, autoUpdate: false });
  assert.equal(store.loadConfig().autoUpdate, false);
});

test('store: config berawalan BOM tidak menghapus token dan port pengguna', () => {
  // Regresi nyata, ditemukan saat menguji paket portable: config yang ditulis
  // dengan BOM (Notepad, atau `Set-Content -Encoding utf8` di PowerShell 5.1)
  // ditolak `JSON.parse`, sehingga `loadConfig()` menyimpulkan "belum ada
  // config" lalu MENIMPA berkasnya. Token dan port pengguna hilang, dan
  // gejalanya menyesatkan: server hidup di port lain dengan token lain.
  const cfgPath = path.join(DATA, 'config.json');
  const token = 'token-asli-0123456789';
  const isi = JSON.stringify({ port: 9761, token, notify: false }, null, 2);
  fs.writeFileSync(cfgPath, '\uFEFF' + isi, 'utf8');

  const cfg = store.loadConfig();
  assert.equal(cfg.token, token, 'token pengguna tidak diganti token acak');
  assert.equal(cfg.port, 9761, 'port pengguna tidak kembali ke 7788');
  // Berkas TIDAK boleh ditulis ulang hanya karena ia dibaca: menulis ulang
  // menghapus BOM-nya, dan pengguna lain yang membuka berkas yang sama tidak
  // perlu melihat perubahan yang tidak ia minta.
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '\uFEFF' + isi, 'berkas tidak ditimpa saat dibaca');
});

test('store: BOM juga dimaafkan pada berkas koleksi, bukan hanya config', () => {
  // BOM adalah sifat berkas, bukan sifat config. Bila hanya config yang
  // dimaafkan, daftar thread atau key yang tersunting tangan tetap bisa
  // terlihat "kosong" lalu ditimpa.
  fs.writeFileSync(path.join(DATA, 'bom-coll.json'), '\uFEFF[{"id":"a"},{"id":"b"}]', 'utf8');
  const arr = store.loadCollection('bom-coll.json', []);
  assert.deepEqual(arr.map((x) => x.id), ['a', 'b'], 'isi koleksi terbaca walau ada BOM');
});

test('store: berkas yang benar-benar rusak tetap memakai fallback', () => {
  // BOM dimaafkan, tetapi JSON yang betul-betul rusak tidak boleh diam-diam
  // dianggap sah: itu akan menyembunyikan kerusakan yang nyata.
  fs.writeFileSync(path.join(DATA, 'rusak.json'), '{"a": 1,, }', 'utf8');
  assert.equal(store.readJson('rusak.json', 'cadangan'), 'cadangan');
});

test('store: config rusak disisihkan, bukan ditimpa tanpa jejak', () => {
  // Bila `config.json` ada tetapi tidak bisa diurai, `loadConfig` tetap harus
  // jalan — tetapi menimpanya langsung menghapus token dan port pengguna
  // beserta satu-satunya bukti yang bisa dipakai untuk memulihkannya.
  const cfgPath = path.join(DATA, 'config.json');
  fs.rmSync(cfgPath, { force: true });
  for (const f of fs.readdirSync(DATA)) {
    if (f.startsWith('config.json.rusak-')) fs.rmSync(path.join(DATA, f), { force: true });
  }
  fs.writeFileSync(cfgPath, '{"token": "rusak-tapi-berharga"', 'utf8');

  const cfg = store.loadConfig();
  assert.equal(cfg.port, 7788, 'config baru tetap dibuat supaya server bisa jalan');

  const sisa = fs.readdirSync(DATA).filter((f) => f.startsWith('config.json.rusak-'));
  assert.equal(sisa.length, 1, 'berkas rusak disisihkan, bukan dihapus');
  assert.equal(
    fs.readFileSync(path.join(DATA, sisa[0]), 'utf8'),
    '{"token": "rusak-tapi-berharga"',
    'isi asli masih utuh di berkas sisihan',
  );
});
