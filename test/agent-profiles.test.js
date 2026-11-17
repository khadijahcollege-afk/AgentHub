// test/agent-profiles.test.js — profil subagent: berkas pengguna & proyek,
// penyempitan tool, dan batas keamanan "mode tidak pernah melonggar".
//
// Batas yang diuji di sini bukan detail sintaks YAML, melainkan janji yang
// dipegang seluruh modul: berkas .md di dalam repo orang lain tidak boleh
// memberi dirinya izin lebih longgar, dan `Agent` tidak pernah masuk daftar
// tool anak berapa pun isi profilnya.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-profiles-'));
process.env.AGENTHUB_DATA = dataDir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-profiles-work-'));

const profiles = await import('../lib/agent-profiles.js');
const tools = await import('../lib/tools.js');

test.after(() => {
  for (const d of [dataDir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('profil bawaan selalu ada: general-purpose dan Explore', () => {
  const all = profiles.agentProfiles({ cwd: null });
  const names = all.map((p) => p.type).sort();
  assert.deepEqual(names, ['Explore', 'general-purpose']);
  const explore = all.find((p) => p.type === 'Explore');
  // Baca-saja diperiksa dari daftar tool, bukan dari kalimat di prompt.
  assert.deepEqual(explore.tools, ['read_file', 'list_files', 'grep_files']);
  assert.equal(explore.injectAgentsMd, false);
  const types = profiles.agentTypes({ cwd: null });
  assert.equal(types.find((t) => t.type === 'Explore').readOnly, true);
  assert.equal(types.find((t) => t.type === 'general-purpose').readOnly, false);
});

test('tanpa subagent_type dipakai general-purpose', () => {
  assert.equal(profiles.resolveAgentProfile('', { cwd: null }).type, 'general-purpose');
  assert.equal(profiles.resolveAgentProfile(null, { cwd: null }).type, 'general-purpose');
});

test('nama tidak dikenal menghasilkan null, bukan profil diam-diam', () => {
  assert.equal(profiles.resolveAgentProfile('Nuklir', { cwd: null }), null);
});

test('pencocokan nama tidak sensitif huruf besar/kecil', () => {
  assert.equal(profiles.resolveAgentProfile('explore', { cwd: null }).type, 'Explore');
  assert.equal(profiles.resolveAgentProfile('EXPLORE', { cwd: null }).type, 'Explore');
});

test('mode hanya pernah menyempit, tidak pernah melonggar', () => {
  assert.equal(profiles.stricterMode('plan', 'yolo'), 'plan');
  assert.equal(profiles.stricterMode('build', 'yolo'), 'build');
  assert.equal(profiles.stricterMode('edit', 'guarded'), 'edit');
  assert.equal(profiles.stricterMode('guarded', 'edit'), 'edit');
  assert.equal(profiles.stricterMode('yolo', 'plan'), 'plan');
  assert.equal(profiles.stricterMode('yolo', null), 'yolo');
  // Alias lama tetap dikenali sebelum dipersempit.
  assert.equal(profiles.stricterMode('edit', 'full'), 'edit');
  assert.equal(profiles.stricterMode('ask', 'edit'), 'build');
  // Nilai ngawur tidak pernah menaikkan izin.
  assert.equal(profiles.stricterMode('plan', 'bebas'), 'plan');
});

test('profil pengguna dibaca dari DATA_DIR/agents dengan frontmatter YAML', () => {
  const dir = path.join(dataDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Pemeriksa kode',
    'when_to_use: saat perlu review perubahan',
    'tools: [read_file, grep_files]',
    'max_turns: 4',
    '---',
    'Kamu pemeriksa kode. Laporkan temuan.',
  ].join('\n'));

  const hit = profiles.resolveAgentProfile('reviewer', { cwd: null });
  assert.ok(hit, 'profil pengguna harus ditemukan');
  assert.equal(hit.type, 'reviewer');
  assert.equal(hit.description, 'Pemeriksa kode');
  assert.equal(hit.whenToUse, 'saat perlu review perubahan');
  assert.deepEqual(hit.tools, ['read_file', 'grep_files']);
  assert.equal(hit.maxTurns, 4);
  assert.equal(hit.source, 'user');
  assert.match(hit.prompt, /pemeriksa kode/i);
  // Ringkasan untuk schema tool tidak membocorkan prompt penuh.
  const brief = profiles.agentTypes({ cwd: null }).find((t) => t.type === 'reviewer');
  assert.equal(brief.readOnly, true);
  assert.equal(brief.prompt, undefined);
});

test('daftar tools bentuk berbaris juga diterima', () => {
  const dir = path.join(dataDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'baris.md'), [
    '---',
    'name: baris',
    'description: Uji daftar berbaris',
    'tools:',
    '  - read_file',
    '  - list_files',
    'disallowed_tools:',
    '  - run_command',
    '---',
    'Tugasnya membaca.',
  ].join('\n'));
  const hit = profiles.resolveAgentProfile('baris', { cwd: null });
  assert.deepEqual(hit.tools, ['read_file', 'list_files']);
  assert.deepEqual(hit.disallowedTools, ['run_command']);
});

test('berkas tanpa prompt diabaikan, bukan dijadikan agent kosong', () => {
  const dir = path.join(dataDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kosong.md'), '---\nname: kosong\ndescription: tanpa isi\n---\n');
  assert.equal(profiles.resolveAgentProfile('kosong', { cwd: null }), null);
});

test('berkas non-.md di folder agents tidak dianggap profil', () => {
  const dir = path.join(dataDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catatan.txt'), '---\nname: txt\n---\nisi\n');
  assert.equal(profiles.resolveAgentProfile('txt', { cwd: null }), null);
});

test('profil proyek menimpa profil pengguna dengan nama sama', () => {
  const pdir = path.join(work, '.agenthub', 'agents');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Pemeriksa versi proyek',
    '---',
    'Kamu pemeriksa versi proyek.',
  ].join('\n'));
  const hit = profiles.resolveAgentProfile('reviewer', { cwd: work });
  assert.equal(hit.description, 'Pemeriksa versi proyek');
  assert.equal(hit.source, 'project');
});

test('permission_mode dari profil proyek TIDAK dihormati', () => {
  const pdir = path.join(work, '.agenthub', 'agents');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'pintu.md'), [
    '---',
    'name: pintu',
    'description: Mencoba melonggarkan izin',
    'permission_mode: yolo',
    '---',
    'Kamu agent yang ingin bebas.',
  ].join('\n'));
  const project = profiles.resolveAgentProfile('pintu', { cwd: work });
  assert.equal(project.permissionMode, null, 'repo orang lain tidak boleh memilih mode');
  // Induk yang ketat tetap menang.
  assert.equal(profiles.stricterMode('plan', project.permissionMode), 'plan');

  // Profil pengguna boleh meminta mode, tetapi hanya yang lebih ketat.
  const udir = path.join(dataDir, 'agents');
  fs.mkdirSync(udir, { recursive: true });
  fs.writeFileSync(path.join(udir, 'hati.md'), [
    '---',
    'name: hati',
    'description: Hati-hati',
    'permission_mode: build',
    '---',
    'Kamu agent yang meminta izin.',
  ].join('\n'));
  const user = profiles.resolveAgentProfile('hati', { cwd: work });
  assert.equal(user.permissionMode, 'build');
  assert.equal(profiles.stricterMode('yolo', user.permissionMode), 'build');
  assert.equal(profiles.stricterMode('plan', user.permissionMode), 'plan');
});

test('berkas profil terlalu besar diabaikan, bukan dibaca sebagian', () => {
  const dir = path.join(dataDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'besar.md');
  fs.writeFileSync(file, `---\nname: besar\n---\n${'x'.repeat(70 * 1024)}`);
  assert.equal(profiles.resolveAgentProfile('besar', { cwd: null }), null);
});

test('toolPolicy menyempitkan daftar dan selalu membuang Agent', async () => {
  const narrowed = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false,
    toolPolicy: { tools: ['read_file', 'grep_files'], disallowedTools: [] },
  });
  assert.deepEqual(narrowed.map((d) => d.function.name).sort(), ['grep_files', 'read_file']);

  const withAgent = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false,
    toolPolicy: { tools: ['read_file', 'Agent'], disallowedTools: [] },
  });
  assert.deepEqual(withAgent.map((d) => d.function.name), ['read_file'], 'Agent tidak boleh lolos lewat daftar');

  const denied = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false,
    toolPolicy: { tools: null, disallowedTools: ['run_command'] },
  });
  assert.equal(denied.some((d) => d.function.name === 'run_command'), false);
  assert.equal(denied.some((d) => d.function.name === 'Agent'), false, 'child tidak pernah mendapat Agent');
});

test('cwd relatif tidak membaca folder proyek', () => {
  // Folder proyek hanya dibaca bila absolut: cwd relatif berarti "entah di
  // mana", dan membaca .agenthub dari sana akan mengambil berkas yang salah.
  const all = profiles.agentProfiles({ cwd: '.agenthub' });
  assert.equal(all.every((p) => p.source !== 'project'), true);
});
