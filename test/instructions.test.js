// test/instructions.test.js — instruksi tetap yang masuk ke prompt: AGENTS.md
// level user, aturan proyek, dan instruksi thread, dengan urutan yang benar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-instr-'));
process.env.AGENTHUB_DATA = dataDir;

const instr = await import('../lib/instructions.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-instr-repo-'));

test.after(() => {
  for (const d of [dataDir, repo]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('tanpa berkas apa pun tidak ada blok yang dikirim', () => {
  const r = instr.buildInstructions({ cwd: repo });
  assert.equal(r.text, '');
  assert.deepEqual(r.sources, []);
});

test('AGENTS.md level user terbaca dan berlaku tanpa folder kerja', () => {
  instr.writeUserInstructions('# Preferensi saya\n- Jawab singkat\n- Selalu pakai TypeScript\n');
  const r = instr.buildInstructions({});
  assert.match(r.text, /Jawab singkat/);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].source, 'user');

  const read = instr.readUserInstructions();
  assert.equal(read.present, true);
  assert.match(read.text, /TypeScript/);
});

test('urutan blok: user → proyek → thread', () => {
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Aturan proyek\n- Jangan ubah lockfile\n');
  const r = instr.buildInstructions({ cwd: repo, systemPrompt: 'Selalu jelaskan sebelum menulis.' });
  assert.deepEqual(r.sources.map((s) => s.source), ['user', 'project', 'thread']);
  const atUser = r.text.indexOf('Jawab singkat');
  const atProject = r.text.indexOf('Jangan ubah lockfile');
  const atThread = r.text.indexOf('Selalu jelaskan');
  assert.equal(atUser > -1 && atProject > -1 && atThread > -1, true, 'ketiga bagian ada');
  assert.equal(atUser < atProject, true, 'user sebelum proyek');
  assert.equal(atProject < atThread, true, 'proyek sebelum thread');
});

test('berkas aturan kosong tidak menghasilkan blok hampa', () => {
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '   \n\n\t\n');
  const r = instr.buildInstructions({ cwd: repo });
  const project = r.sources.find((s) => s.source === 'project');
  assert.ok(project, 'blok proyek tetap ada karena AGENTS.md berisi');
  assert.equal(r.text.includes('CLAUDE.md'), false, 'berkas kosong tidak disebut');
  fs.rmSync(path.join(repo, 'CLAUDE.md'));
});

test('aturan proyek besar dipotong dan ditandai terpotong', () => {
  const big = `# Besar\n${'x'.repeat(60000)}`;
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), big);
  const r = instr.buildInstructions({ cwd: repo });
  const project = r.sources.find((s) => s.source === 'project');
  assert.equal(project.truncated, true);
  assert.equal(r.text.length < big.length, true, 'isi yang dikirim lebih kecil dari berkas');
  assert.match(r.text, /dipotong/);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Aturan proyek\n- Jangan ubah lockfile\n');
});

test('systemPrompt thread panjang dibatasi 4000 karakter', () => {
  const r = instr.buildInstructions({ systemPrompt: 'y'.repeat(9000) });
  const thread = r.sources.find((s) => s.source === 'thread');
  assert.equal(thread.truncated, true);
  const body = r.text.split('### Instruksi thread')[1] || '';
  assert.equal(body.trim().length <= 4000, true);
});

test('tulis instruksi pengguna menolak isi melebihi batas', () => {
  assert.throws(() => instr.writeUserInstructions('z'.repeat(20000)), /maksimal/i);
  // isi lama tidak ikut terhapus saat penulisan ditolak
  assert.match(instr.readUserInstructions().text, /Jawab singkat/);
});

test('ringkasan tidak membocorkan isi instruksi', () => {
  const s = instr.instructionsSummary({ cwd: repo, systemPrompt: 'rahasia-thread' });
  const flat = JSON.stringify(s);
  assert.equal(flat.includes('rahasia-thread'), false, 'isi thread tidak ikut');
  assert.equal(flat.includes('Jawab singkat'), false, 'isi user tidak ikut');
  assert.equal(s.userPresent, true);
  assert.equal(s.projectPresent, true);
  assert.equal(s.threadPresent, true);
});
