// test/shopthemes.test.js — katalog Tema Shop lengkap & konsisten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shopCatalog, shopCss, SHOP_CATEGORIES, expandTheme } from '../lib/shopthemes.js';

test('shop: katalog >= 10 tema, tiap tema 55 token lengkap', () => {
  const cat = shopCatalog();
  assert.ok(cat.length >= 10, `minimal 10 tema, ada ${cat.length}`);
  for (const t of cat) {
    const n = Object.keys(t.tokens).length;
    assert.equal(n, 55, `${t.name}: token ${n}, harus 55`);
    assert.ok(t.tokens['--bg'], 'bg ada');
    assert.ok(t.tokens['--glass-app-rgb'], 'kanal kaca ada');
    assert.ok(!t.tokens['--accent'], 'palet tidak menyentuh --accent');
  }
});

test('shop: latar tiap tema unik', () => {
  const seen = new Map();
  for (const t of shopCatalog()) {
    const bg = t.tokens['--bg'];
    assert.equal(seen.get(bg), undefined, `--bg ${bg} dobel dengan ${seen.get(bg)}`);
    seen.set(bg, t.name);
  }
});

test('shop: semua kategori sah dan terpakai', () => {
  const sah = new Set(SHOP_CATEGORIES);
  for (const t of shopCatalog()) {
    for (const tg of t.tags) assert.ok(sah.has(tg), `tag "${tg}" tidak terdaftar`);
  }
  const terpakai = new Set(shopCatalog().flatMap((t) => t.tags));
  for (const c of SHOP_CATEGORIES) assert.ok(terpakai.has(c), `kategori "${c}" tidak terpakai`);
});

test('shop: CSS berisi blok palet tiap tema + versi kaca', () => {
  const css = shopCss();
  for (const t of shopCatalog()) {
    assert.ok(css.includes(`html[data-palette="${t.paletteId}"] {`), `blok ${t.paletteId} ada`);
    assert.ok(css.includes(`html[data-palette="${t.paletteId}"]:not([data-tl="1"]) #app.layout`), 'versi solid ada');
    assert.ok(css.includes(`html[data-palette="${t.paletteId}"][data-tl="1"] #app.layout`), 'versi kaca ada');
  }
});

test('shop: builder hasil deterministik', () => {
  const spec = { bg: '#111111', side: '#222222', rail: '#000000', card: '#333333', text: '#ffffff', text2: '#eeeeee', accent: '#ff0000' };
  assert.deepEqual(expandTheme(spec), expandTheme(spec));
});
