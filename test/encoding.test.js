// Penjaga: berkas teks di repo tidak boleh mengandung mojibake encoding ganda
// dan tidak boleh ber-BOM.
//
// Nyata terjadi: berkas ditulis ulang lewat PowerShell (`Get-Content -Raw` lalu
// `WriteAllText`). PowerShell membaca UTF-8 tanpa BOM sebagai CP1252, sehingga
// em dash berubah menjadi tiga karakter sampah dan middle dot menjadi dua, lalu
// ditulis kembali sebagai UTF-8 yang SAH. Karena hasilnya UTF-8 sah, validasi
// encoding biasa tetap lolos dan kerusakannya hanya terlihat di layar.
//
// Karena itu tes ini memeriksa BYTE, bukan hasil decode.
//
// Catatan: pola di bawah ditulis sebagai byte eksplisit, bukan karakter literal.
// Kalau ditulis literal, berkas tes ini sendiri akan cocok dengan polanya.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'release', 'out', 'coverage']);
const TEXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|html|css|md|txt|nsh|nsi|yml|yaml|svg|bat|ps1)$/i;

// Urutan byte yang hanya muncul kalau UTF-8 dibaca CP1252 lalu ditulis UTF-8.
const MOJIBAKE = [
  { hex: 'c3 a2 e2 82', label: 'em dash / kutip rusak (U+00E2 + U+20AC)' },
  { hex: 'c3 82 c2', label: 'double-encoded (U+00C2 + U+0080-009F)' },
  { hex: 'c3 af c2 bf c2 bd', label: 'replacement char rusak' },
  { hex: 'c3 83 c2 a2', label: 'A-tilde + cent' },
  { hex: 'c3 83 c2 a9', label: 'A-tilde + copyright' },
  { hex: 'c3 83 c2 bc', label: 'A-tilde + 1/4' },
].map((m) => ({ ...m, bytes: Buffer.from(m.hex.split(' ').map((h) => parseInt(h, 16))) }));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT.test(e.name)) yield p;
  }
}

test('encoding: tidak ada mojibake dan BOM di berkas teks repo', () => {
  const bad = [];
  let checked = 0;

  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const buf = fs.readFileSync(file);
    checked++;

    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bad.push(`${rel}: BOM di awal berkas`);
      continue;
    }

    for (const { bytes, label } of MOJIBAKE) {
      const i = buf.indexOf(bytes);
      if (i < 0) continue;
      const line = buf.subarray(0, i).toString('utf8').split('\n').length;
      bad.push(`${rel}:${line}: mojibake ${label} [${bytes.toString('hex')}]`);
      break;
    }
  }

  assert.ok(checked > 100, `pemindaian terlalu sedikit berkas (${checked}) - pola glob salah?`);
  assert.deepEqual(bad, [], 'berkas rusak encoding:\n  ' + bad.join('\n  '));
});

test('encoding: semua berkas teks adalah UTF-8 sah', () => {
  // Pelengkap: mojibake terjadi justru pada berkas yang UTF-8-nya SAH, jadi
  // kedua pemeriksaan ini harus terpisah.
  const broken = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    } catch {
      broken.push(rel);
    }
  }
  assert.deepEqual(broken, [], 'bukan UTF-8 sah:\n  ' + broken.join('\n  '));
});
