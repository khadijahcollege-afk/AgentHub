// Penjaga sistem tema: palet yang tidak lengkap akan membuat sebagian UI tetap
// abu-abu, dan palet yang tidak terbaca lebih buruk daripada tidak ada palet.
// Uji ini statis (baca berkas), jadi cepat dan tidak butuh server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const wsCss = fs.readFileSync(path.join(ROOT, 'public/workspace.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const rootBlock = () => css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')) + 2);
const paletteIds = () => [...new Set([...css.matchAll(/html\[data-palette="([a-z0-9-]+)"\] \{/g)].map((m) => m[1]))].sort();

// Satu palet boleh punya beberapa blok dengan selector sama (blok permukaan dan
// blok kanal kaca dipisah supaya terbaca). Semuanya digabung di sini — kalau
// hanya blok pertama yang dibaca, kanal kaca akan tampak "hilang".
const tokensOfId = (id) => {
  const m = new Map();
  const re = new RegExp(`html\\[data-palette="${id}"\\] \\{([^{}]*)\\}`, 'g');
  for (const b of css.matchAll(re)) {
    for (const x of b[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m.set(x[1], x[2].trim());
  }
  return m;
};
const tokensOfBlock = (block) => {
  const m = new Map();
  for (const x of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m.set(x[1], x[2].trim());
  return m;
};

const hex2rgb = (h) => {
  let x = String(h).replace('#', '').trim();
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// Token yang WAJIB diisi tiap palet. Kalau satu saja tidak diisi, elemen yang
// memakainya jatuh ke nilai tema bawaan dan tetap abu-abu di tengah palet
// berwarna — bocor yang sulit terlihat tetapi nyata.
const REQUIRED = [
  '--bg', '--terminal-bg', '--rail', '--side', '--side-solid', '--line', '--line2',
  '--card', '--card-0', '--card-1', '--card-2', '--card-3', '--card-4', '--card-hi',
  '--pop', '--panel-2', '--panel-3', '--surface-hi',
  '--edge', '--edge-0', '--edge-1', '--edge-2', '--edge-3', '--edge-btn', '--edge-panel', '--edge-pill',
  '--text', '--text2', '--ink-3', '--ink-4', '--ink-5', '--ink-5-fill', '--muted', '--muted2',
  // kanal RGB untuk permukaan kaca
  '--glass-app-rgb', '--glass-rail-rgb', '--glass-side-rgb', '--glass-pill-rgb',
  '--glass-pop-rgb', '--glass-chat-top-rgb', '--glass-stat-rgb', '--glass-panel-rgb',
  '--glass-set-rgb', '--glass-seg-rgb',
];

test('tema: setiap palet di CSS punya blok lengkap', () => {
  const ids = paletteIds();
  assert.ok(ids.length >= 4, `palet yang tersedia terlalu sedikit: ${ids.join(',')}`);
  for (const id of ids) {
    const t = tokensOfId(id);
    const missing = REQUIRED.filter((k) => !t.has(k));
    assert.deepEqual(missing, [], `palet "${id}" tidak mengisi: ${missing.join(', ')}`);
  }
});

test('tema: setiap palet punya latar jendela & pratinjau sendiri', () => {
  for (const id of paletteIds()) {
    // latar jendela dibatasi :not([data-tl="1"]) supaya tidak mematikan kaca
    assert.ok(css.includes(`html[data-palette="${id}"]:not([data-tl="1"]) #app.layout {`),
      `palet "${id}" tanpa latar #app.layout`);
    assert.ok(css.includes(`.theme-prev.${id} `), `palet "${id}" tanpa pratinjau kartu`);
  }
});

test('tema: daftar palet di app.js sama dengan blok CSS', () => {
  const i = app.indexOf('const PALETTES');
  assert.ok(i > 0, 'PALETTES tidak ditemukan');
  const js = [...app.slice(i, app.indexOf('];', i)).matchAll(/\['([a-z0-9-]+)'/g)].map((m) => m[1]);
  const cssIds = paletteIds();
  // 'bawaan' adalah pilihan "tanpa palet" — ia tidak punya blok data-palette
  const jsPalettes = js.filter((x) => x !== 'bawaan').sort();
  assert.deepEqual(jsPalettes, cssIds, 'daftar palet JS dan CSS tidak sinkron');
  assert.ok(js.includes('bawaan'), 'pilihan Bawaan harus tetap ada');
  for (const id of js) {
    assert.ok(css.includes(`.theme-prev.${id}`) || id === 'bawaan', `pratinjau "${id}" tidak ada di CSS`);
  }
});

test('tema: palet yang dipilih benar-benar mengubah warna', () => {
  const base = tokensOfBlock(rootBlock());
  const seen = new Map();
  for (const id of paletteIds()) {
    const t = tokensOfId(id);
    // latar utama harus berbeda dari bawaan...
    assert.notEqual(t.get('--bg'), base.get('--bg'), `palet "${id}" tidak mengubah --bg`);
    // ...dan dari palet lain, kalau tidak pilihannya tidak berarti apa-apa
    const prev = seen.get(t.get('--bg'));
    assert.equal(prev, undefined, `palet "${id}" punya --bg sama dengan "${prev}"`);
    seen.set(t.get('--bg'), id);
  }
});

test('tema: teks di tiap palet tetap terbaca (kontras WCAG)', () => {
  const base = tokensOfBlock(rootBlock());
  const cases = [['bawaan', base]];
  for (const id of paletteIds()) cases.push([id, tokensOfId(id)]);

  for (const [label, t] of cases) {
    const card = t.get('--card');
    assert.ok(card, `${label}: --card tidak ada`);
    const checks = [
      ['--text', 7], ['--ink-3', 7], ['--ink-4', 4.5], ['--ink-5', 4.5], ['--muted2', 4.5],
    ];
    for (const [token, min] of checks) {
      const val = t.get(token);
      assert.ok(val, `${label}: ${token} tidak ada`);
      const r = contrast(val, card);
      assert.ok(r >= min, `${label}: ${token} di atas --card hanya ${r.toFixed(2)}:1 (butuh ${min})`);
    }
  }
});

test('tema: palet tidak menyentuh warna semantik & aksen', () => {
  const base = tokensOfBlock(rootBlock());
  for (const id of paletteIds()) {
    const t = tokensOfId(id);
    for (const semantic of ['--ok', '--warn', '--err', '--accent']) {
      assert.equal(t.get(semantic), undefined, `palet "${id}" menimpa ${semantic} — status akan berubah warna`);
    }
    assert.equal(base.get('--ok'), '#4ec77a', '--ok bawaan harus tetap');
  }
});

test('tema: palet hanya aktif di tema gelap (Terang memakai inversi)', () => {
  assert.ok(app.includes("document.documentElement.removeAttribute('data-palette')"),
    'applyTheme harus melepas palet saat tema Terang');
  assert.ok(app.includes('ah_palette'), 'pilihan palet harus tersimpan');
  assert.match(css, /html\[data-theme="light"\] body \{\s*filter: invert/, 'mekanisme inversi masih ada');
});

test('tema: UI palet tersedia di panel Tampilan', () => {
  assert.ok(html.includes('id="palette-cards"'), 'wadah #palette-cards hilang');
  assert.ok(html.includes('Palet warna'), 'label palet hilang');
  assert.ok(app.includes('function renderPaletteCards'), 'renderPaletteCards hilang');
});

test('tema: satu kosakata token — workspace.css tidak menimpa :root lagi', () => {
  // Kalau workspace.css mendefinisikan ulang --bg/--side/--surface, palet di
  // style.css kalah untuk token itu dan sebagian UI tetap abu-abu.
  const wsRootStart = wsCss.indexOf(':root {');
  const wsRoot = wsRootStart < 0 ? '' : wsCss.slice(wsRootStart, wsCss.indexOf('\n}', wsRootStart));
  const shared = ['--bg', '--rail', '--side', '--surface', '--surface2', '--line', '--line2', '--muted', '--muted2'];
  for (const token of shared) {
    assert.ok(!new RegExp(`\\n\\s*${token}:`).test(wsRoot), `workspace.css masih menimpa ${token}`);
  }
  for (const token of shared) {
    assert.ok(tokensOfBlock(rootBlock()).has(token), `style.css :root harus mendefinisikan ${token}`);
  }
});

test('tema: latar permukaan kaca tidak lagi harfiah', () => {
  // rgba(r, g, b, a) tidak bisa memuat var() per kanal; kalau latar kaca masih
  // harfiah, permukaan itu tidak ikut palet. Hitam/putih murni dikecualikan:
  // itu overlay peredup, bukan warna permukaan.
  const glassBlocks = [...css.matchAll(/html\[data-tl="1"\][^{]*\{([^{}]*)\}/g)].map((m) => m[1]);
  const bad = [];
  for (const b of glassBlocks) {
    for (const d of b.matchAll(/background[^:]*:\s*([^;]+);/g)) {
      const v = d[1].trim();
      const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
      if (!m) continue;
      const [r, g, bl] = [m[1], m[2], m[3]].map(Number);
      const achromatic = r === g && g === bl && (r === 0 || r === 255);
      if (!achromatic) bad.push(v);
    }
  }
  assert.deepEqual(bad, [], `latar kaca masih harfiah: ${bad.slice(0, 3).join(' | ')}`);
  assert.ok(css.includes('rgb(var(--glass-app-rgb)'), 'kanal kaca harus dipakai lewat var()');
});

test('tema: setiap palet mengisi set token yang sama persis', () => {
  // Cacat nyata yang pernah lolos: satu palet kehilangan --surface/--surface2
  // karena blok-nya diganti nama setelah token turunan disuntikkan. Akibatnya
  // sebagian panel di palet itu tetap abu-abu bawaan.
  const sets = new Map(paletteIds().map((id) => [id, tokensOfId(id)]));
  const all = new Set();
  for (const t of sets.values()) for (const k of t.keys()) all.add(k);
  const beda = [];
  for (const [id, t] of sets) {
    for (const k of all) if (!t.has(k)) beda.push(`${id} kurang ${k}`);
  }
  assert.deepEqual(beda, [], `set token palet tidak seragam: ${beda.slice(0, 5).join(', ')}`);
});

test('tema: setiap palet menurunkan --surface/--surface2 dari ramp-nya', () => {
  // --surface dan --surface2 dipakai sebagai latar panel di workspace.css, dan
  // harus diturunkan dari palet itu (var), bukan disalin dari warna lain.
  for (const id of paletteIds()) {
    const t = tokensOfId(id);
    assert.equal(t.get('--surface'), 'var(--card)', `palet "${id}": --surface harus var(--card)`);
    assert.equal(t.get('--surface2'), 'var(--card-0)', `palet "${id}": --surface2 harus var(--card-0)`);
  }
});

test('tema: tidak ada token ganda di dalam satu palet', () => {
  // Bug nyata yang pernah lolos: --side didefinisikan dua kali, dan yang kedua
  // (solid) menimpa yang pertama (rgba) sehingga sidebar kehilangan efek kaca.
  const dupes = [];
  for (const id of paletteIds()) {
    const seen = new Set();
    const re = new RegExp(`html\\[data-palette="${id}"\\] \\{([^{}]*)\\}`, 'g');
    for (const b of css.matchAll(re)) {
      for (const x of b[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) {
        const key = `${id}/${x[1]}`;
        if (seen.has(x[1])) dupes.push(key);
        seen.add(x[1]);
      }
    }
  }
  assert.deepEqual(dupes, [], `token ganda: ${dupes.join(', ')}`);
});

test('tema: --side tetap translusen supaya efek kaca hidup', () => {
  for (const id of paletteIds()) {
    const v = tokensOfId(id).get('--side');
    assert.match(v, /^rgba\(/, `palet "${id}": --side harus rgba agar kaca bekerja, bukan ${v}`);
  }
});

test('tema: latar palet tidak mematikan efek kaca', () => {
  // Cacat nyata yang pernah lolos: `html[data-palette=X] #app.layout` menang
  // atas `html[data-tl="1"] #app.layout`, sehingga di mode kaca jendela memakai
  // gradien buram-penuh dan blur tembus wallpaper mati sama sekali.
  for (const id of paletteIds()) {
    assert.ok(
      css.includes(`html[data-palette="${id}"]:not([data-tl="1"]) #app.layout {`),
      `palet "${id}": latar jendela harus dibatasi :not([data-tl="1"]) agar kaca hidup`,
    );
    assert.ok(
      !css.includes(`html[data-palette="${id}"] #app.layout {`),
      `palet "${id}": masih ada latar jendela tanpa penjaga kaca`,
    );
    // saat kaca menyala, jendela tetap transparan tetapi berwarna palet
    assert.ok(
      css.includes(`html[data-palette="${id}"][data-tl="1"] #app.layout {`),
      `palet "${id}": tidak ada aturan jendela transparan berwarna palet`,
    );
  }
});

test('tema: label tema & palet punya padanan Inggris (kecuali nama diri)', () => {
  // UI dua bahasa: label yang tampil harus ada di kamus, kalau tidak UI Inggris
  // menyisakan kata Indonesia di tengahnya. Nama diri (OLED, Midnight, Aurora)
  // sengaja dibiarkan karena itu nama, bukan kata biasa.
  const dict = fs.readFileSync(path.join(ROOT, 'public/i18n-dict.js'), 'utf8');
  const NAMA_DIRI = new Set(['OLED', 'Midnight', 'Aurora']);
  const has = (k) => new RegExp(`(^|\\n)\\s*'?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\s*:`, 'm').test(dict);

  const grab = (constName) => {
    const i = app.indexOf(`const ${constName}`);
    assert.ok(i > 0, `${constName} tidak ditemukan`);
    return [...app.slice(i, app.indexOf('];', i)).matchAll(/\['[a-z]+', '([^']+)'/g)].map((m) => m[1]);
  };
  const labels = [...grab('THEMES'), ...grab('PALETTES')];
  const hilang = [...new Set(labels)].filter((k) => !NAMA_DIRI.has(k) && !has(k));
  assert.deepEqual(hilang, [], `label tanpa padanan Inggris: ${hilang.join(', ')}`);

  // keterangan panel palet juga harus diterjemahkan — kalimat panjang ini yang
  // paling mencolok kalau tertinggal dalam bahasa Indonesia pada UI Inggris.
  assert.ok(has('Palet warna'), 'label "Palet warna" belum ada di kamus');
});

test('tema: token turunan workspace ikut terisi di setiap palet', () => {
  // --card-5..9 dan --edge-4..7 lahir dari migrasi workspace.css. Palet yang
  // tidak mengisinya akan menyisakan panel abu-abu di tengah palet berwarna.
  const derived = ['--card-5', '--card-6', '--card-7', '--card-8', '--card-9',
    '--edge-4', '--edge-5', '--edge-6', '--edge-7'];
  const base = tokensOfBlock(rootBlock());
  for (const id of paletteIds()) {
    const t = tokensOfId(id);
    for (const token of derived) {
      assert.ok(base.has(token), `:root harus mendefinisikan ${token}`);
      assert.match(t.get(token) || '', /^#[0-9a-f]{6}$/i, `palet "${id}" tidak mengisi ${token}`);
    }
  }
});
