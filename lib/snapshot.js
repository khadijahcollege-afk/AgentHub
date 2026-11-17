// lib/snapshot.js — potong muatan thread untuk perangkat kecil.
//
// Masalahnya bukan "thread besar", tetapi "satu pesan assistant yang sangat
// panjang". Satu balasan 200 KB membuat HP di jaringan seluler menunggu seluruh
// JSON selesai diunduh DAN di-parse sebelum satu baris pun tampil. Halaman
// terasa rusak, padahal isinya cuma besar.
//
// Yang dilakukan: atas permintaan, isi pesan dipotong menjadi pratinjau dengan
// `refId` yang bisa dipakai untuk mengambil versi lengkapnya. Pemotongan HANYA
// terjadi pada respons — berkas thread tidak pernah ditulis ulang, jadi tidak
// ada data yang hilang dan tidak ada jalur "pratinjau yang diam-diam permanen".
//
// Pemotongan ini sengaja sederhana dan bisa dihitung ulang: pesan terbesar
// dipotong lebih dulu sampai anggaran terpenuhi. Tidak ada prioritas
// tersembunyi yang membuat pesan tertentu hilang tanpa penjelasan.
import crypto from 'node:crypto';

export const DEFAULT_BYTE_BUDGET = 200 * 1024;
export const MAX_BYTE_BUDGET = 2 * 1024 * 1024;
export const MIN_BYTE_BUDGET = 32 * 1024;

// Pratinjau tidak pernah lebih pendek dari ini: pesan yang dipotong menjadi
// beberapa karakter sama saja disembunyikan, dan pengguna tidak bisa menilai
// apakah itu pesan yang ia cari.
const MIN_PREVIEW_CHARS = 2000;

function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

export function hashOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

export function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BYTE_BUDGET;
  return Math.min(MAX_BYTE_BUDGET, Math.max(MIN_BYTE_BUDGET, Math.round(n)));
}

// Pesan mana yang boleh dipotong. Pesan user tidak pernah dipotong: itu teks
// yang pengguna ketik sendiri dan ia harus bisa melihatnya utuh tanpa meminta.
// Pesan subrun (delegasi) juga tidak — isinya sudah dibatasi saat dibuat.
function trimmable(msg) {
  return msg && msg.role === 'assistant' && !msg.subrun && typeof msg.content === 'string';
}

// `messageLimit` = jumlah pesan terakhir yang dipertahankan; potong dari depan.
// Percakapan dibaca dari awal, tetapi yang dibutuhkan saat membuka thread di HP
// adalah bagian AKHIR — tempat pekerjaan terakhir berada. Pesan yang dibuang
// dilaporkan jumlahnya, bukan dihilangkan diam-diam.
export function applyLimits(thread, { messageLimit = 0, byteBudget = 0 } = {}) {
  if (!thread || !Array.isArray(thread.messages)) return thread;
  const budget = byteBudget ? clampBudget(byteBudget) : 0;
  const limit = Number(messageLimit) > 0 ? Math.floor(Number(messageLimit)) : 0;
  if (!budget && !limit) return thread;

  let msgs = thread.messages;
  let dropped = 0;
  if (limit && msgs.length > limit) {
    dropped = msgs.length - limit;
    msgs = msgs.slice(dropped);
  }

  const out = { ...thread, messages: msgs };
  if (dropped) out.truncatedMessages = dropped;
  if (!budget) return out;

  // Anggaran diukur dari JSON yang benar-benar akan dikirim, bukan perkiraan
  // jumlah karakter: escape dan metadata ikut membebani jaringan.
  let size = bytes(JSON.stringify(out));
  if (size <= budget) return out;

  // Pesan dikloning SEBELUM dipotong. `getThread()` mengembalikan objek hasil
  // parse, tetapi memotong objek itu di tempat membuat pemanggil lain yang
  // masih memegangnya melihat pratinjau — dan pemotongan respons tidak boleh
  // pernah mengubah data yang dianggap utuh.
  out.messages = msgs.map((m) => ({ ...m }));
  size = bytes(JSON.stringify(out));
  if (size <= budget) return out;

  const bodyRefs = [];
  // Daftar ini WAJIB dibangun dari `out.messages` (hasil kloning), bukan dari
  // `msgs`: memotong objek asli akan mengubah thread yang sedang dipakai
  // pemanggil, sementara responsnya sendiri tidak ikut terpotong.
  const order = out.messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => trimmable(m))
    .sort((a, b) => bytes(b.m.content) - bytes(a.m.content));

  for (const { m, index } of order) {
    if (size <= budget) break;
    const full = m.content;
    const fullBytes = bytes(full);
    // Ruang yang tersedia untuk isi pesan ini = anggaran dikurangi seluruh
    // muatan lain, termasuk isi pesan ini yang sudah ada sekarang.
    const room = budget - (size - fullBytes);
    if (fullBytes <= room) continue;
    const take = Math.max(MIN_PREVIEW_CHARS, Math.floor(room * 0.9));
    if (take >= full.length) continue;
    const preview = full.slice(0, take);
    // `refId` memakai indeks pesan ASLI, bukan indeks setelah dipotong: dengan
    // begitu pengambilan versi lengkap tidak pernah salah pesan.
    const refId = `m${index}`;
    m.content = preview;
    m.truncated = true;
    m.refId = refId;
    bodyRefs.push({
      refId,
      field: 'content',
      fullBytes,
      previewBytes: bytes(preview),
      hash: hashOf(full),
    });
    size = bytes(JSON.stringify(out));
  }
  if (bodyRefs.length) {
    out.bodyRefs = bodyRefs;
    out.byteBudget = budget;
    out.byteBudgetApplied = true;
  }
  return out;
}

// Ambil satu isi pesan lengkap dari thread yang tersimpan (bukan dari versi
// yang sudah dipotong), beserta hash untuk verifikasi di klien.
export function bodyFor(thread, refId) {
  if (!thread || !Array.isArray(thread.messages)) return null;
  const match = String(refId || '').match(/^m(\d+)$/);
  if (!match) return null;
  const msg = thread.messages[Number(match[1])];
  if (!msg || typeof msg.content !== 'string') return null;
  return { refId: String(refId), content: msg.content, hash: hashOf(msg.content), role: msg.role };
}
