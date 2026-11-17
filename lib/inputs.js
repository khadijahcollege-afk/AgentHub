// lib/inputs.js — buku besar idempotensi untuk kiriman prompt.
//
// Kenapa perlu: satu POST yang berhasil tetapi balasannya hilang (jaringan
// seluler putus, tab ditutup di tengah jalan, proxy memutus koneksi) membuat
// pengirim mencoba lagi. Tanpa buku besar, percobaan kedua adalah run kedua:
// model menjawab dua kali, dua pesan user muncul, dan tool berjalan dua kali.
// Itu bukan kasus teoretis — ia yang paling sering terjadi justru di jaringan
// buruk, tempat pengulangan paling wajar dilakukan.
//
// Buku besar ini mencatat "perintah ini sudah diterima" SEBELUM run dimulai,
// dan menyimpan hasil akhirnya. Percobaan ulang dengan id yang sama mendapat
// jawaban dari catatan, bukan run baru.
//
// Batasnya dinyatakan jelas di sini: ini idempotensi untuk KIRIMAN, bukan
// transaksi. Ia menjamin satu prompt tidak dijalankan dua kali; ia tidak
// menjamin hasil run-nya bisa diputar ulang, dan bukan itu gunanya.
import { readJson, writeJson } from './store.js';

const FILE = 'inputs.json';

// Satu hari cukup: pengulangan yang masuk akal terjadi dalam hitungan detik
// sampai menit. Catatan lebih tua hanya menambah berkas tanpa pernah dipakai.
export const LEDGER_TTL_MS = 24 * 3600 * 1000;
export const MAX_ENTRIES = 2000;

function all() {
  const data = readJson(FILE, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function save(map) {
  const now = Date.now();
  const rows = Object.entries(map)
    .filter(([, rec]) => rec && now - (rec.at || 0) < LEDGER_TTL_MS)
    // Terbaru dulu saat memangkas: yang paling mungkin dipakai ulang adalah
    // kiriman yang baru saja terjadi.
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, MAX_ENTRIES);
  writeJson(FILE, Object.fromEntries(rows));
}

function key(threadId, commandId) {
  return `${threadId}:${commandId}`;
}

export function normalizeCommandId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  // Batas panjang menjaga berkas tetap kecil; karakter dibatasi karena id ini
  // datang dari klien dan langsung dipakai sebagai kunci.
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null;
}

// Catat bahwa perintah ini diterima. Mengembalikan `null` bila id ini baru,
// atau catatan lama bila perintah yang sama sudah pernah diterima — pemanggil
// memakai catatan itu untuk menjawab ulang tanpa menjalankan apa pun.
export function claim(threadId, commandId, meta = {}) {
  if (!commandId) return null;
  const map = all();
  const k = key(threadId, commandId);
  const existing = map[k];
  if (existing && Date.now() - (existing.at || 0) < LEDGER_TTL_MS) return existing;

  map[k] = {
    threadId,
    commandId,
    // `accepted` berarti run-nya sudah dimulai. Bila server mati di sini,
    // percobaan ulang harus dijawab "sudah diterima" — bukan dijalankan lagi.
    status: 'accepted',
    userMessageId: null,
    queueItemId: meta.queueItemId || null,
    at: Date.now(),
  };
  save(map);
  return null;
}

// Lengkapi catatan setelah run mencapai keadaan akhir. Idempoten: catatan yang
// hilang (kedaluwarsa saat run panjang) bukan kesalahan, hanya tidak ada yang
// bisa dilengkapi.
export function settle(threadId, commandId, { status = 'done', userMessageId = null } = {}) {
  if (!commandId) return false;
  const map = all();
  const k = key(threadId, commandId);
  const rec = map[k];
  if (!rec) return false;
  rec.status = status;
  if (userMessageId) rec.userMessageId = userMessageId;
  rec.settledAt = Date.now();
  save(map);
  return true;
}

// Lepas catatan saat run TIDAK jadi dimulai (validasi gagal, hook menolak).
// Tanpa ini, kiriman yang ditolak hook akan selamanya dianggap "sudah
// diterima" dan pengguna yang memperbaiki promptnya tidak bisa mengirim ulang
// dengan id yang sama.
export function forget(threadId, commandId) {
  if (!commandId) return false;
  const map = all();
  const k = key(threadId, commandId);
  if (!map[k]) return false;
  delete map[k];
  save(map);
  return true;
}

export function lookup(threadId, commandId) {
  if (!commandId) return null;
  const rec = all()[key(threadId, commandId)];
  if (!rec || Date.now() - (rec.at || 0) >= LEDGER_TTL_MS) return null;
  return rec;
}

// Untuk tes dan diagnostik: bersihkan semuanya.
export function reset() {
  writeJson(FILE, {});
}
