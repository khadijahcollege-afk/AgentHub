import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, RETIRED_PRESETS, presetInfo, DEFAULT_MODELS } from '../lib/keys.js';

// GitHub Models pensiun 30 Juli 2026: endpoint models.inference.ai.azure.com
// tidak lagi melayani permintaan, jadi tidak boleh ditawarkan sebagai preset
// baru. Key lama tetap harus punya label supaya bisa dikenali dan dihapus.
test('preset: GitHub Models dipindah ke daftar pensiun', () => {
  assert.equal(PRESETS.github, undefined, 'GitHub Models bukan preset aktif lagi');
  assert.ok(RETIRED_PRESETS.github, 'GitHub Models tetap tercatat sebagai pensiun');
  assert.match(RETIRED_PRESETS.github.retired, /pensiun/i);
});

test('preset: label key lama berpreset pensiun tetap terbaca', () => {
  const info = presetInfo('github');
  assert.ok(info, 'presetInfo tidak mengembalikan undefined untuk preset pensiun');
  assert.match(info.label, /GitHub Models/);
  assert.ok(info.baseUrl, 'baseUrl tetap ada agar key lama bisa ditampilkan');
});

test('preset: preset aktif tetap punya label dan baseUrl', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    assert.ok(p.label, `${key}: label wajib`);
    if (key !== 'custom') assert.match(p.baseUrl, /^https:\/\//, `${key}: baseUrl harus https`);
  }
  assert.equal(presetInfo('tidak-ada').label, PRESETS.custom.label, 'preset tak dikenal jatuh ke custom');
});

test('preset: preset aktif dan pensiun tidak tumpang tindih', () => {
  for (const key of Object.keys(RETIRED_PRESETS)) {
    assert.equal(PRESETS[key], undefined, `${key} tidak boleh ada di dua daftar sekaligus`);
  }
});

test('preset: setiap preset aktif punya model default, kecuali custom', () => {
  for (const key of Object.keys(PRESETS)) {
    if (key === 'custom') continue;
    assert.ok(DEFAULT_MODELS[key], `${key}: model default wajib ada`);
  }
  assert.equal(DEFAULT_MODELS.github, undefined, 'preset pensiun tidak lagi punya model default');
});
