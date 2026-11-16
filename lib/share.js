// lib/share.js — bagikan percakapan sebagai tautan baca-saja (REA aplikasi
// ZCode: fitur conversationShare-nya besar dan sering dipakai). Tautan punya
// masa berlaku & bisa dicabut; isi dibaca publik TANPA token akses — jadi
// berkas share terpisah dari config, dan halaman publik tidak pernah
// membocorkan token, key, maupun pesan sistem.
import { readJson, writeJson, newId } from './store.js';

const FILE = 'shares.json';
const MAX = 100;
const DAY = 24 * 3600 * 1000;
const ALLOWED_DAYS = [1, 7, 30];

function all() { const d = readJson(FILE, []); return Array.isArray(d) ? d : []; }
function save(list) { writeJson(FILE, list.slice(0, MAX)); }

// bersihkan yang kedaluwarsa saat menyentuh daftar (tanpa cron)
function purge(list) {
  const now = Date.now();
  return list.filter((s) => s.expiresAt > now && !s.revoked);
}

export class ShareError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

export function createShare(threadId, { days = 7, title = '' } = {}) {
  if (!ALLOWED_DAYS.includes(days)) throw new ShareError(`Masa berlaku harus ${ALLOWED_DAYS.join(', ')} hari`);
  const list = purge(all());
  const existing = list.find((s) => s.threadId === threadId && !s.revoked && s.expiresAt > Date.now());
  if (existing) {
    // satu tautan aktif per thread: perpanjang, jangan tumpuk tautan kembar
    existing.expiresAt = Date.now() + days * DAY;
    existing.days = days;
    save(list);
    return existing;
  }
  const share = {
    id: newId(),
    threadId,
    title: String(title || '').slice(0, 80),
    days,
    createdAt: Date.now(),
    expiresAt: Date.now() + days * DAY,
    revoked: false,
  };
  list.push(share);
  save(list);
  return share;
}

export function getShare(id) {
  const s = all().find((x) => x.id === id);
  if (!s || s.revoked || s.expiresAt <= Date.now()) return null;
  return s;
}

export function revokeShare(id) {
  const list = all();
  const s = list.find((x) => x.id === id);
  if (!s) return false;
  s.revoked = true;
  save(list);
  return true;
}

export function deleteShare(id) {
  const list = all();
  const before = list.length;
  save(list.filter((x) => x.id !== id));
  return all().length < before;
}

export function listShares() {
  const list = purge(all());
  // terbaru dulu + status siap tampil
  return list
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((s) => ({
      id: s.id,
      threadId: s.threadId,
      title: s.title,
      days: s.days,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      remainingMs: Math.max(0, s.expiresAt - Date.now()),
    }));
}
