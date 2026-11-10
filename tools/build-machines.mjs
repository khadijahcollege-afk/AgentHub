// tools/build-machines.mjs — hasilkan public/machines.js dari lib/machines.js.
//
// Satu sumber kebenaran (lib/machines.js), dua konsumen (server ESM + browser).
// Jalankan: node tools/build-machines.mjs
// CI menjalankan ini dengan --check dan gagal bila file klien tidak sinkron.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'lib', 'machines.js');
const OUT = path.join(ROOT, 'public', 'machines.js');

const HEADER = `// DIHASILKAN OTOMATIS dari lib/machines.js — jangan diedit manual.
// Regenerate: node tools/build-machines.mjs
`;

export function render() {
  const body = fs.readFileSync(SRC, 'utf8');
  // buang komentar kepala sumber, ganti dengan penanda generated + ekspor browser
  const stripped = body.replace(/^(\/\/[^\n]*\n)+/, '');
  const plain = stripped.replace(/^export /gm, '');
  const names = [...stripped.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  return `${HEADER}${plain}
// ekspor eksplisit agar tetap bekerja sebagai ESM di browser
export { ${names.join(', ')} };
`;
}

const out = render();
const check = process.argv.includes('--check');

if (check) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) {
    console.error('public/machines.js tidak sinkron dengan lib/machines.js — jalankan: node tools/build-machines.mjs');
    process.exit(1);
  }
  console.log('machines sinkron');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log('ditulis', path.relative(ROOT, OUT));
}
