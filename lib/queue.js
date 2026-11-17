// lib/queue.js — antrean input per thread.
//
// Masalah yang diselesaikan: kiriman kedua ke thread yang sedang bekerja
// ditolak 409. Bagi pemanggil API itu benar (dua run tidak boleh berjalan
// bersamaan), tetapi bagi pengguna itu kehilangan teks: ia mengetik pesan
// lanjutan, menekan kirim, dan pesannya hilang tanpa jejak. ZCode menyelesaikan
// ini dengan satu antrean FIFO otoritatif; di sini antreannya dimiliki server,
// bukan tab.
//
// Kontrak yang dipegang:
//   • Antrean milik server, disimpan di disk. Ia bertahan saat halaman dimuat
//     ulang, dan tab lain melihat isi yang sama. Antrean yang hanya hidup di
//     memori tab berarti menutup tab = membuang pesan yang sudah diketik.
//   • FIFO ketat. Hanya item paling depan yang boleh diambil. Antrean yang bisa
//     dilompati bukan antrean, ia daftar.
//   • reserve → mulai → baru hapus. Item TIDAK hilang saat diambil. Kalau
//     pengambilnya mati di antara "ambil" dan "kirim", item kembali ke
//     posisinya dengan seluruh isinya. Menghapus di awal berarti kehilangan
//     pesan yang tidak pernah dijalankan.
//   • Satu pemenang. Dua tab yang mencoba mengambil item yang sama tidak boleh
//     menjalankannya dua kali.
//   • Reservasi selalu kedaluwarsa. Pengambil yang hilang tanpa mengembalikan
//     reservasi tidak boleh menahan antrean selamanya.
import { readJson, writeJson, newId } from './store.js';

const FILE = 'queue.json';

// Batas kecil dan disengaja: antrean ini untuk "beberapa pesan lanjutan", bukan
// tempat menumpuk pekerjaan semalam. Antrean panjang yang tidak pernah dilihat
// lebih berbahaya daripada penolakan yang jelas.
export const MAX_QUEUE_PER_THREAD = 20;
export const MAX_PROMPT_CHARS = 16000;

// Reservasi yang tidak dikonfirmasi dalam waktu ini dianggap milik pengambil
// yang sudah hilang. Cukup lama untuk satu permintaan HTTP yang lambat, cukup
// pendek agar tab yang mati tidak membekukan antrean.
export const RESERVE_TTL_MS = 20000;

function all() {
  const data = readJson(FILE, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function save(map) {
  writeJson(FILE, map);
}

function bucket(map, threadId) {
  const list = map[threadId];
  return Array.isArray(list) ? list : [];
}

export class QueueError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Reservasi yang sudah lewat waktunya dilepas saat daftar dibaca: tanpa ini,
// tab yang ditutup di tengah pengambilan menahan kepala antrean sampai server
// dimulai ulang. Mengembalikan true bila ada yang berubah (pemanggil menyimpan).
function sweep(list, now = Date.now()) {
  let changed = false;
  for (const item of list) {
    if (item.reservedBy && item.reservedUntil && item.reservedUntil <= now) {
      item.reservedBy = null;
      item.reservedUntil = null;
      changed = true;
    }
  }
  return changed;
}

// Bentuk publik: detail reservasi adalah urusan internal antrean, bukan sesuatu
// yang perlu dilihat UI. UI hanya perlu tahu "ada yang sedang diambil".
function pub(item) {
  const { reservedBy, reservedUntil, ...rest } = item;
  return { ...rest, reserved: !!reservedBy };
}

export function list(threadId) {
  const map = all();
  const items = bucket(map, threadId);
  if (sweep(items)) { map[threadId] = items; save(map); }
  return items.map(pub);
}

export function count(threadId) {
  return bucket(all(), threadId).length;
}

// Jumlah per thread, untuk lencana di sidebar. Thread tanpa antrean tidak
// muncul sama sekali supaya payload tetap kecil.
export function counts() {
  const map = all();
  const out = {};
  for (const [id, items] of Object.entries(map)) {
    if (Array.isArray(items) && items.length) out[id] = items.length;
  }
  return out;
}

// `clientCommandId` berasal dari pengirim (bukan id item). Kiriman yang diulang
// karena jaringan putus harus mendarat sebagai satu item, bukan dua.
export function enqueue(threadId, input = {}) {
  const prompt = String(input.prompt || '').slice(0, MAX_PROMPT_CHARS);
  const attachments = Array.isArray(input.attachments)
    ? [...new Set(input.attachments.filter((x) => typeof x === 'string' && x.trim()))]
    : [];
  if (!prompt.trim() && !attachments.length) {
    throw new QueueError('Pesan kosong tidak bisa diantrekan', 400, 'QUEUE_EMPTY');
  }

  const map = all();
  const items = bucket(map, threadId);
  sweep(items);

  const cmdId = typeof input.clientCommandId === 'string' ? input.clientCommandId.trim().slice(0, 64) : '';
  if (cmdId) {
    const dup = items.find((x) => x.clientCommandId === cmdId);
    // Item yang sudah dijalankan tidak ada lagi di sini, jadi id yang sama
    // boleh dipakai lagi setelah itemnya pergi. Itu disengaja: pengulangan
    // yang perlu ditahan adalah pengulangan atas item yang MASIH menunggu.
    if (dup) return { item: pub(dup), duplicate: true };
  }

  if (items.length >= MAX_QUEUE_PER_THREAD) {
    throw new QueueError(
      `Antrean penuh (${MAX_QUEUE_PER_THREAD} pesan). Tunggu sampai ada yang dijalankan.`,
      409,
      'QUEUE_FULL',
    );
  }

  const item = {
    id: newId(),
    threadId,
    prompt,
    attachments,
    engine: input.engine ? String(input.engine).slice(0, 40) : null,
    model: input.model ? String(input.model).slice(0, 120) : null,
    cwd: input.cwd ? String(input.cwd) : null,
    effort: input.effort ? String(input.effort).slice(0, 20) : null,
    permission: input.permission ? String(input.permission).slice(0, 20) : null,
    ...(cmdId ? { clientCommandId: cmdId } : {}),
    createdAt: Date.now(),
    reservedBy: null,
    reservedUntil: null,
  };
  items.push(item);
  map[threadId] = items;
  save(map);
  return { item: pub(item), duplicate: false };
}

// Ambil kepala antrean. Atomik: `all()` dibaca lalu ditulis dalam satu operasi
// sinkron, jadi dua permintaan HTTP tidak bisa sama-sama mendapat item yang
// sama — Node menjalankan handler satu per satu di antara titik I/O.
export function reserve(threadId) {
  const map = all();
  const items = bucket(map, threadId);
  if (sweep(items)) { map[threadId] = items; save(map); }
  const item = items[0];
  if (!item) throw new QueueError('Antrean kosong', 404, 'QUEUE_EMPTY');
  if (item.reservedBy) {
    throw new QueueError('Item paling depan sedang diambil klien lain', 409, 'QUEUE_RESERVED');
  }
  const reservationId = newId();
  item.reservedBy = reservationId;
  item.reservedUntil = Date.now() + RESERVE_TTL_MS;
  map[threadId] = items;
  save(map);
  return { reservationId, expiresAt: item.reservedUntil, item: { ...pub(item), reserved: true } };
}

// Hapus item SETELAH run-nya benar-benar dimulai. Ini satu-satunya tempat item
// hilang dari antrean selain penghapusan manual oleh pengguna.
export function commit(threadId, reservationId) {
  const map = all();
  const items = bucket(map, threadId);
  const idx = items.findIndex((x) => x.reservedBy === reservationId);
  if (idx === -1) {
    throw new QueueError('Reservasi tidak dikenal atau sudah kedaluwarsa', 409, 'QUEUE_STALE');
  }
  const [item] = items.splice(idx, 1);
  if (items.length) map[threadId] = items;
  else delete map[threadId];
  save(map);
  return pub(item);
}

// Kembalikan item ke tempatnya karena start gagal. Posisi dan seluruh isinya
// dipertahankan: yang gagal adalah menjalankannya, bukan isinya.
export function release(threadId, reservationId) {
  const map = all();
  const items = bucket(map, threadId);
  const item = items.find((x) => x.reservedBy === reservationId);
  if (!item) return false;
  item.reservedBy = null;
  item.reservedUntil = null;
  map[threadId] = items;
  save(map);
  return true;
}

export function remove(threadId, itemId) {
  const map = all();
  const items = bucket(map, threadId);
  const idx = items.findIndex((x) => x.id === itemId);
  if (idx === -1) return false;
  // Item yang sedang dijalankan tidak boleh dicabut di tengah jalan: run-nya
  // sudah berjalan, dan menghapus item hanya menyembunyikan fakta itu.
  if (items[idx].reservedBy) {
    throw new QueueError('Item itu sedang dijalankan', 409, 'QUEUE_RESERVED');
  }
  items.splice(idx, 1);
  if (items.length) map[threadId] = items;
  else delete map[threadId];
  save(map);
  return true;
}

export function clearThread(threadId) {
  const map = all();
  if (!map[threadId]) return false;
  delete map[threadId];
  save(map);
  return true;
}
