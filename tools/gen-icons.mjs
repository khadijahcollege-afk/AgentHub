// tools/gen-icons.mjs — hasilkan icon-192.png & icon-512.png tanpa dependency.
// Desain sama dengan favicon SVG: kotak membulat oranye bergradasi,
// lingkaran putih + palang putih (logo AgentHub).
// Jalankan: node tools/gen-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const head = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
  return Buffer.concat([len, head, data, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- bentuk ----------
const lerp = (a, b, t) => a + (b - a) * t;

function inRoundedRect(px, py, S, r, x0 = 0, y0 = 0, x1 = S, y1 = S) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx, dy = py - cy;
  const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1;
  if (!inside) return false;
  // dekat batas sudut? jarak ke titik sudut membulat
  const corner = (px < x0 + r || px > x1 - r) && (py < y0 + r || py > y1 - r);
  return corner ? dx * dx + dy * dy <= r * r : true;
}

function draw(S) {
  return (px, py) => {
    const r = S * 0.22;
    const N = 4; // subpixel anti-alias
    let bg = 0, fg = 0;
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const x = px + (sx + 0.5) / N;
        const y = py + (sy + 0.5) / N;
        if (inRoundedRect(x, y, S, r)) bg += 1 / (N * N);
        const head = (x - S * 0.5) ** 2 + (y - S * 0.37) ** 2 <= (S * 0.165) ** 2;
        const bar = inRoundedRect(x, y, S, S * 0.05, S * 0.30, S * 0.60, S * 0.70, S * 0.70);
        if (head || bar) fg += 1 / (N * N);
      }
    }
    if (bg <= 0) return [0, 0, 0, 0];
    const t = py / S;
    const R = Math.round(lerp(0xf2, 0xe4, t));
    const G = Math.round(lerp(0x90, 0x6a, t));
    const B = Math.round(lerp(0x5c, 0x30, t));
    const fa = Math.min(fg / Math.max(bg, 1e-6), 1);
    return [
      Math.round(lerp(R, 255, fa)),
      Math.round(lerp(G, 255, fa)),
      Math.round(lerp(B, 255, fa)),
      Math.round(bg * 255),
    ];
  };
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log('ditulis', path.relative(process.cwd(), file), fs.statSync(file).size, 'bytes');
}
