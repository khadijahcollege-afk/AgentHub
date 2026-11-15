// Validitas entri promo katalog.
//
// Katalog statis tidak selalu menyebut tanggal berakhir. Yang tidak diketahui
// TIDAK dianggap kedaluwarsa dan tidak pula dikarang tanggalnya: entri seperti
// itu tetap tampil, sedangkan entri dengan `validUntil` yang sudah lewat
// disembunyikan. Dengan cara ini UI tidak pernah menjanjikan promo yang sudah
// berakhir, tanpa mengisi data yang tidak kita ketahui.
const DAY = 24 * 60 * 60 * 1000;
const ENDING_SOON_MS = 7 * DAY;

/**
 * @param {{validUntil?: string, expired?: boolean}} entry
 * @param {number} now
 * @returns {{state: 'active'|'ending'|'expired', endsAt: number, daysLeft: number|null}}
 */
export function promoValidity(entry, now = Date.now()) {
  // Penanda eksplisit dari sumber (mis. ditandai berakhir di halaman resmi).
  if (entry?.expired === true) return { state: 'expired', endsAt: 0, daysLeft: null };

  const raw = entry?.validUntil;
  if (!raw) return { state: 'active', endsAt: 0, daysLeft: null };

  const endsAt = Date.parse(raw);
  if (!Number.isFinite(endsAt)) return { state: 'active', endsAt: 0, daysLeft: null };
  if (endsAt <= now) return { state: 'expired', endsAt, daysLeft: 0 };

  const daysLeft = Math.ceil((endsAt - now) / DAY);
  return { state: endsAt - now <= ENDING_SOON_MS ? 'ending' : 'active', endsAt, daysLeft };
}

// Entri yang masih boleh ditampilkan sebagai promo berlaku.
export function activePromos(list, now = Date.now()) {
  return (list || []).filter((entry) => promoValidity(entry, now).state !== 'expired');
}

// Entri yang ditandai berakhir, dipakai untuk menjelaskan kenapa daftar kosong.
export function expiredPromos(list, now = Date.now()) {
  return (list || []).filter((entry) => promoValidity(entry, now).state === 'expired');
}
