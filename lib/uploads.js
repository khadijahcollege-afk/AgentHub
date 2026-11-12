// lib/uploads.js — lampiran file untuk pesan chat.
//
// Aplikasi agent populer mengizinkan file/gambar ditempel ke percakapan. Kita
// menyimpannya di data dir (bukan folder kerja pengguna) supaya tidak mengotori
// repo, dan mengirimkannya ke agent sebagai path nyata (CLI) atau teks inline
// (gateway). Tidak ada dependensi multipart: klien mengirim base64 dalam JSON.
//
// Batas keras: 8 MB per file, 5 lampiran per pesan. Nama file selalu diambil
// basename-nya, jadi `../../evil.txt` tidak bisa keluar dari folder uploads.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson, newId } from './store.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const MAX_INLINE_CHARS = 20000;
const MAX_INLINE_FILE_CHARS = 12000;
const MAX_NAME = 120;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'ps1', 'sql', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'conf', 'log', 'csv', 'tsv', 'env', 'gitignore',
]);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'text/javascript',
};

export class UploadError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function dir() {
  const d = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function index() {
  const list = readJson('uploads.json', []);
  return Array.isArray(list) ? list : [];
}

function saveIndex(list) {
  writeJson('uploads.json', list);
}

export function safeName(input) {
  const base = String(input || 'file').replace(/\\/g, '/').split('/').pop() || 'file';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+$/, 'file')
    .trim()
    .slice(0, MAX_NAME);
  return cleaned || 'file';
}

function extension(name) {
  return path.extname(name).slice(1).toLowerCase();
}

export function safeType(type, name) {
  const raw = String(type || '').trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw)) return raw;
  return TYPE_BY_EXT[extension(safeName(name))] || 'application/octet-stream';
}

function fullPath(meta) {
  const file = path.basename(String(meta?.file || ''));
  return path.join(dir(), file);
}

// Metadata yang aman dikirim ke klien / disimpan di pesan: tanpa path lokal.
export function publicUpload(meta) {
  return { id: meta.id, name: meta.name, type: meta.type, bytes: meta.bytes };
}

export function saveUpload({ name, type, data } = {}) {
  if (typeof data !== 'string' || !data.trim()) {
    throw new UploadError('UPLOAD_INVALID', 'Isi file wajib dikirim sebagai base64');
  }
  const payload = data.replace(/^data:[^;]*;base64,/i, '').replace(/\s+/g, '');
  if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new UploadError('UPLOAD_INVALID', 'Base64 tidak valid');
  }
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) throw new UploadError('UPLOAD_INVALID', 'File kosong');
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new UploadError('UPLOAD_TOO_LARGE',
      `File maksimal ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 413);
  }
  const clean = safeName(name);
  const id = newId();
  const file = `${id}-${clean}`;
  fs.writeFileSync(path.join(dir(), file), buffer);
  const meta = {
    id,
    name: clean,
    type: safeType(type, clean),
    bytes: buffer.length,
    file,
    createdAt: Date.now(),
  };
  const list = index();
  list.push(meta);
  saveIndex(list);
  return meta;
}

export function getUpload(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) return null;
  const meta = index().find((x) => x.id === id);
  if (!meta) return null;
  const full = fullPath(meta);
  if (!fs.existsSync(full)) return null;
  return { ...meta, path: full };
}

export function readUpload(id) {
  const meta = getUpload(id);
  if (!meta) return null;
  return { meta, buffer: fs.readFileSync(meta.path) };
}

export function deleteUpload(id) {
  const list = index();
  const meta = list.find((x) => x.id === id);
  if (!meta) return false;
  try { fs.rmSync(fullPath(meta), { force: true }); } catch { /* file sudah hilang */ }
  saveIndex(list.filter((x) => x.id !== id));
  return true;
}

export function isInlineImage(meta) {
  return IMAGE_TYPES.has(String(meta?.type || '').toLowerCase());
}

export function isTextAttachment(meta) {
  const type = String(meta?.type || '').toLowerCase();
  if (type.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/javascript'].includes(type)) return true;
  return TEXT_EXTENSIONS.has(extension(meta?.name || ''));
}

// Tambahkan lampiran ke prompt yang dikirim ke engine.
// - CLI: path absolut (agent punya alat baca file), isi tidak di-inline.
// - Pool: isi teks di-inline (model tidak punya akses disk), path tidak bocor.
export async function augmentPrompt(prompt, metas, { includePaths = false, inlineText = false } = {}) {
  const base = String(prompt || '');
  const list = Array.isArray(metas) ? metas : [];
  if (!list.length) return base;

  const lines = ['', 'Lampiran:'];
  for (const m of list) {
    lines.push(`- ${m.name} (${m.type}, ${m.bytes} byte)${includePaths ? `: ${m.path}` : ''}`);
  }
  let out = base + lines.join('\n');
  if (!inlineText) return out;

  let used = 0;
  for (const m of list) {
    if (!isTextAttachment(m) || used >= MAX_INLINE_CHARS) continue;
    try {
      const raw = fs.readFileSync(m.path, 'utf8');
      const room = MAX_INLINE_CHARS - used;
      const slice = raw.slice(0, Math.min(room, MAX_INLINE_FILE_CHARS));
      out += `\n\n--- ${m.name} ---\n${slice}${slice.length < raw.length ? '\n[…dipotong]' : ''}`;
      used += slice.length;
    } catch { /* file biner/hilang — cukup path/daftar di atas */ }
  }
  return out;
}
