// test/lang.test.js — bahasa balasan agent.
//
// Yang dijaga: "auto" tidak boleh menambah apa pun ke prompt (agent sudah
// mengikuti bahasa user), dan nilai liar tidak boleh menyuntik instruksi asing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_LANGS, normalizeReplyLang, withReplyLanguage } from '../lib/lang.js';

test('lang: auto tidak menambah apa pun ke prompt', () => {
  const prompt = 'Tolong periksa kode ini.';
  assert.equal(withReplyLanguage(prompt, 'auto'), prompt);
  assert.equal(withReplyLanguage(prompt, undefined), prompt, 'kosong = auto');
  assert.equal(withReplyLanguage(prompt, null), prompt);
  assert.equal(withReplyLanguage('', 'auto'), '');
});

test('lang: setiap bahasa mengirim instruksi yang menyebut bahasanya', () => {
  const prompt = 'Jelaskan hasilnya';
  const expected = {
    id: /Indonesian/,
    en: /English/,
    ja: /Japanese/,
    zh: /Chinese/,
    es: /Spanish/,
    ar: /Arabic/,
  };
  for (const [id, re] of Object.entries(expected)) {
    const out = withReplyLanguage(prompt, id);
    assert.ok(out.startsWith(prompt), 'prompt asli tetap utuh di depan');
    assert.match(out, re, `instruksi ${id} menyebut bahasanya`);
    assert.match(out, /<reply_language>/, 'ditandai sebagai blok terpisah');
    assert.match(out, /unchanged/, 'kode/path tidak ikut diterjemahkan');
  }
});

test('lang: prompt asli tidak diubah, hanya diberi blok tambahan', () => {
  const prompt = 'Tulis tes untuk fungsi ini.';
  const out = withReplyLanguage(prompt, 'en');
  assert.notEqual(out, prompt, 'ada tambahan');
  assert.ok(out.includes(prompt));
  // baris asli tetap persis, tidak dipotong/dirapikan
  assert.ok(out.split('\n')[0] === prompt);
});

test('lang: nilai tak dikenal jatuh ke auto (tanpa instruksi)', () => {
  const prompt = 'Halo';
  assert.equal(normalizeReplyLang('klingon'), 'auto');
  assert.equal(normalizeReplyLang(''), 'auto');
  assert.equal(normalizeReplyLang(null), 'auto');
  assert.equal(normalizeReplyLang(undefined), 'auto');
  assert.equal(normalizeReplyLang(42), 'auto');
  assert.equal(normalizeReplyLang('EN'), 'auto', 'hanya huruf kecil yang sah');
  assert.equal(withReplyLanguage(prompt, 'klingon'), prompt, 'tidak menyuntik apa pun');
});

test('lang: semua id di REPLY_LANGS dinormalisasi apa adanya', () => {
  for (const id of REPLY_LANGS) assert.equal(normalizeReplyLang(id), id);
  assert.ok(REPLY_LANGS.includes('auto'));
  assert.equal(new Set(REPLY_LANGS).size, REPLY_LANGS.length, 'tidak ada duplikat');
});
