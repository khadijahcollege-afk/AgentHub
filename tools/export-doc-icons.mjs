// tools/export-doc-icons.mjs — ekspor set ikon UI (ICON_PATHS) menjadi berkas
// SVG mandiri untuk dokumen GitHub (README/CHANGELOG).
//
// Kenapa berkas terpisah: GitHub merender <img src="...svg"> di markdown,
// dan sumber ikon tetap SATU — public/app.js. Jika ikon di UI berubah,
// jalankan `npm run icons` untuk menyinkronkan aset dokumen.
// Warna stroke dibuat tetap (aksen brand) karena dokumen tidak bisa
// mengikuti currentColor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STROKE = '#ef7d45'; // aksen brand AgentHub — terbaca di tema terang & gelap GitHub

const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const block = src.slice(src.indexOf('const ICON_PATHS = {'), src.indexOf('};', src.indexOf('const ICON_PATHS = {')));
const icons = {};
for (const m of block.matchAll(/(\w+):\s*'((?:[^'\\]|\\.)*)'/g)) {
  icons[m[1]] = m[2];
}

const outDir = path.join(ROOT, 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [name, paths] of Object.entries(icons)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${STROKE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>\n`;
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  written++;
}
console.log(`ditulis ${written} ikon ke assets/icons/ (${Object.keys(icons).join(', ')})`);
