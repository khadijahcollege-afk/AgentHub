// lib/shopthemes.js — Tema Shop: katalog tema curasi ala Shop Discord.
// Tiap tema = satu PALET lengkap (55 token) yang dibangun dari spek ringkas
// (5 warna dasar) lewat builder ramp — bukan 55 baris tulisan tangan per tema.
// Palet diaktifkan lewat mekanisme palet lama (ah_palette + data-palette),
// CSS-nya dilayani dinamis dari /shop-palettes.css.
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function hexToRgb(hex) {
  let x = String(hex || '').replace('#', '').trim();
  if (x.length === 3) x = x.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(x)) x = '000000';
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
}
const rgbHex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => {
  const A = hexToRgb(a); const B = hexToRgb(b);
  return rgbHex(A.map((v, i) => v + (B[i] - v) * clamp01(t)));
};
const lighten = (h, t) => mix(h, '#ffffff', t);
const darken = (h, t) => mix(h, '#000000', t);
const triplet = (h) => hexToRgb(h).join(' ');

// Spek minimal per tema: bg, side, rail, card, accent, text + meta toko.
const RAW = [
  {
    id: 'shop-discord', name: 'Discord', price: 0, tags: ['dark-moody', 'gaming'],
    desc: 'Palet resmi Discord — blurple di atas permukaan abu klasik.',
    bg: '#313338', side: '#2b2d31', rail: '#1e1f22', card: '#2b2d31',
    text: '#f2f3f5', text2: '#dbdee1', accent: '#5865f2',
  },
  {
    id: 'shop-blurple-night', name: 'Blurple Night', price: 0, tags: ['dark-moody', 'gaming'],
    desc: 'Malam blurple pekat untuk yang betah begadang.',
    bg: '#232437', side: '#1b1c30', rail: '#141523', card: '#1b1c30',
    text: '#e6e9ff', text2: '#c3c8ee', accent: '#5865f2',
  },
  {
    id: 'shop-anime-sky', name: 'Anime Sky', price: 0, tags: ['anime', 'cute-cozy'],
    desc: 'Langit siang Anime — biru muda lembut, cheerful tapi nyaman.',
    bg: '#e8f1fb', side: '#dbeafc', rail: '#cfe0f6', card: '#f2f7fe',
    text: '#1d2b3f', text2: '#3c5474', accent: '#3b82f6',
  },
  {
    id: 'shop-gaming-neon', name: 'Gaming Neon', price: 0, tags: ['gaming', 'sci-fi'],
    desc: 'Hitam pekat dengan neon lime — setup esports feel.',
    bg: '#0a0f0a', side: '#0d130d', rail: '#070b07', card: '#0f1710',
    text: '#e4ffe8', text2: '#b8e6c3', accent: '#39ff88',
  },
  {
    id: 'shop-dark-moody', name: 'Dark & Moody', price: 0, tags: ['dark-moody'],
    desc: 'Hampir hitam, kontras rendah — untuk sesi malam yang tenang.',
    bg: '#151517', side: '#111113', rail: '#0c0c0e', card: '#1a1a1d',
    text: '#d8d8dc', text2: '#a3a3ab', accent: '#8f8fff',
  },
  {
    id: 'shop-cute-cozy', name: 'Cute & Cozy', price: 0, tags: ['cute-cozy', 'anime'],
    desc: 'Pastel pink hangat — manis tanpa membuat mata capek.',
    bg: '#2a2226', side: '#241d21', rail: '#1c171a', card: '#322a2e',
    text: '#ffe9f3', text2: '#f2c6dd', accent: '#ff8fb8',
  },
  {
    id: 'shop-sci-fi-terminal', name: 'Sci-Fi Terminal', price: 0, tags: ['sci-fi', 'gaming'],
    desc: 'Hijau terminal di atas hitam — hack the planet.',
    bg: '#031007', side: '#02120a', rail: '#010c06', card: '#06180d',
    text: '#c9ffe0', text2: '#8fe8b8', accent: '#22e584',
  },
  {
    id: 'shop-nature-forest', name: 'Nature Forest', price: 0, tags: ['nature'],
    desc: 'Hijau hutan gelap — tenang seperti kerja di kabin.',
    bg: '#16211a', side: '#121a15', rail: '#0d140f', card: '#1c2920',
    text: '#e4f2e8', text2: '#bcd8c5', accent: '#4fd68b',
  },
  {
    id: 'shop-ocean-deep', name: 'Ocean Deep', price: 0, tags: ['nature', 'sci-fi'],
    desc: 'Biru laut dalam — dingin, fokus, keheningan dasar laut.',
    bg: '#0c1a24', side: '#0a141d', rail: '#060d13', card: '#10212e',
    text: '#dceefc', text2: '#a7c8e0', accent: '#3aa6e0',
  },
  {
    id: 'shop-sunset-vibes', name: 'Sunset Vibes', price: 0, tags: ['cute-cozy', 'nature'],
    desc: 'Senja jingga-unggu — hangat di ujung hari.',
    bg: '#241a22', side: '#1e151d', rail: '#170f16', card: '#2e222c',
    text: '#ffeef0', text2: '#e6c2cd', accent: '#ff7d6b',
  },
];

// Bangun 55 token lengkap dari spek. Fungsi murni — mudah diuji tanpa disk.
export function expandTheme(spec) {
  const bg = spec.bg; const card = spec.card; const side = spec.side;
  const rail = spec.rail || darken(side, .25);
  const line = spec.line || mix(bg, spec.text, .16);
  const line2 = lighten(line, .14);
  const text = spec.text; const text2 = spec.text2 || mix(text, bg, .2);
  const ink3 = mix(text, bg, .12); const ink4 = mix(text, bg, .3);
  const ink5 = mix(text, bg, .45);
  const t = new Map([
    ['--surface', 'var(--card)'],
    ['--surface2', 'var(--card-0)'],
    ['--bg', bg],
    ['--terminal-bg', darken(bg, .1)],
    ['--rail', rail],
    ['--side', side],
    ['--side-solid', side],
    ['--line', line],
    ['--line2', line2],
    ['--card', card],
    ['--card-0', darken(card, .16)],
    ['--card-1', lighten(card, .07)],
    ['--card-2', darken(bg, .05)],
    ['--card-3', mix(bg, card, .5)],
    ['--card-4', lighten(card, .05)],
    ['--card-hi', lighten(card, .14)],
    ['--pop', darken(card, .18)],
    ['--panel-2', darken(card, .2)],
    ['--panel-3', lighten(card, .06)],
    ['--surface-hi', lighten(card, .12)],
    ['--edge', line],
    ['--edge-0', darken(line, .2)],
    ['--edge-1', line],
    ['--edge-2', lighten(line, .1)],
    ['--edge-3', lighten(line, .26)],
    ['--edge-btn', mix(card, line, .5)],
    ['--edge-panel', darken(card, .1)],
    ['--edge-pill', mix(card, line, .3)],
    ['--text', text],
    ['--text2', text2],
    ['--ink-3', ink3],
    ['--ink-4', ink4],
    ['--ink-5', ink5],
    ['--ink-5-fill', ink5],
    ['--muted', spec.muted || ink5],
    ['--muted2', mix(text, bg, .5)],
    ['--card-5', darken(card, .24)],
    ['--card-6', mix(bg, card, .25)],
    ['--card-7', darken(bg, .06)],
    ['--card-8', lighten(card, .1)],
    ['--card-9', mix(card, bg, .35)],
    ['--edge-4', lighten(line, .12)],
    ['--edge-5', lighten(line, .24)],
    ['--edge-6', darken(line, .1)],
    ['--edge-7', mix(bg, line, .4)],
    ['--glass-app-rgb', triplet(bg)],
    ['--glass-rail-rgb', triplet(rail)],
    ['--glass-side-rgb', triplet(side)],
    ['--glass-pill-rgb', triplet(card)],
    ['--glass-pop-rgb', triplet(darken(card, .18))],
    ['--glass-chat-top-rgb', triplet(bg)],
    ['--glass-stat-rgb', triplet(darken(card, .16))],
    ['--glass-panel-rgb', triplet(darken(card, .16))],
    ['--glass-set-rgb', triplet(darken(card, .16))],
    ['--glass-seg-rgb', triplet(darken(card, .18))],
  ]);
  return Object.fromEntries(t);
}

// Katalog untuk /api/shop: meta toko + palet lengkap per tema.
export function shopCatalog() {
  return RAW.map((spec) => {
    const tokens = expandTheme(spec);
    return {
      id: spec.id,
      name: spec.name,
      desc: spec.desc,
      price: 'Gratis',
      tags: spec.tags,
      accent: spec.accent,
      preview: { bg: spec.bg, side: spec.side, rail: spec.rail, card: spec.card, accent: spec.accent, text: spec.text },
      paletteId: 'shop-' + spec.id.replace(/^shop-/, ''),
      tokens: Object.fromEntries(Object.entries(tokens)),
    };
  });
}

export function shopCss() {
  return shopCatalog()
    .map((t) => {
      const lines = Object.entries(t.tokens).map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n');
      const appLine = 'html[data-palette="' + t.paletteId + '"]:not([data-tl="1"]) #app.layout {\n  background: var(--bg);\n}\n';
      const tlLine = 'html[data-palette="' + t.paletteId + '"][data-tl="1"] #app.layout {\n  background: rgb(var(--glass-app-rgb) / var(--t-content, 1));\n}\n';
      return '/* Tema Shop: ' + t.name + ' */\nhtml[data-palette="' + t.paletteId + '"] {\n' + lines + '\n}\n' + appLine + tlLine;
    })
    .join('\n');
}

export const SHOP_CATEGORIES = ['dark-moody', 'gaming', 'anime', 'cute-cozy', 'sci-fi', 'nature'];
export const CATEGORY_LABEL = {
  'dark-moody': 'Dark & Moody', gaming: 'Gaming', anime: 'Anime',
  'cute-cozy': 'Cute & Cozy', 'sci-fi': 'Sci-Fi', nature: 'Nature',
};
