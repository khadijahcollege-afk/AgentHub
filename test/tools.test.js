// test/tools.test.js — tool bawaan: konfinasi path, mode izin, hook gate,
// dan loop tool-calling dengan provider palsu.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-tools-'));
process.env.AGENTHUB_DATA = dir;

const tools = await import('../lib/tools.js');
const hooks = await import('../lib/hooks.js');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-tool-work-'));
fs.writeFileSync(path.join(work, 'a.txt'), 'satu\ndua\ntiga\n');
fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
fs.writeFileSync(path.join(work, 'sub', 'b.js'), 'const x = "cari";\n');

test.after(() => {
  for (const d of [dir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('normalizeMode memetakan nama lama ke nama ZCode', () => {
  assert.equal(tools.normalizeMode('ask'), 'build');
  assert.equal(tools.normalizeMode('edits'), 'edit');
  assert.equal(tools.normalizeMode('full'), 'yolo');
  assert.equal(tools.normalizeMode('plan'), 'plan');
  assert.equal(tools.normalizeMode('guarded'), 'guarded');
  assert.equal(tools.normalizeMode(''), 'yolo');
  assert.equal(tools.normalizeMode(undefined), 'yolo');
});

test('decide: plan menolak tulis & perintah, mengizinkan baca', () => {
  assert.equal(tools.decide('read_file', {}, 'plan').allow, true);
  assert.equal(tools.decide('write_file', { path: 'a.txt' }, 'plan').allow, false);
  assert.equal(tools.decide('run_command', { command: 'dir' }, 'plan').decision, 'deny');
  assert.equal(tools.decide('mcp__s__read_thing', {}, 'plan').allow, true);
  assert.equal(tools.decide('mcp__s__delete_thing', {}, 'plan').allow, false);
});

test('decide: build & edit minta persetujuan, yolo membolehkan', () => {
  assert.equal(tools.decide('write_file', {}, 'build').decision, 'ask');
  assert.equal(tools.decide('run_command', { command: 'dir' }, 'build').decision, 'ask');
  assert.equal(tools.decide('write_file', {}, 'edit').allow, true);
  assert.equal(tools.decide('run_command', { command: 'dir' }, 'edit').decision, 'ask');
  assert.equal(tools.decide('write_file', {}, 'yolo').allow, true);
  assert.equal(tools.decide('run_command', { command: 'dir' }, 'yolo').allow, true);
});

test('guarded: perintah berbahaya minta persetujuan, perintah biasa lolos', () => {
  assert.equal(tools.decide('run_command', { command: 'git status' }, 'guarded').allow, true);
  assert.equal(tools.isDangerous('git status'), false);
  assert.equal(tools.isDangerous('rm -rf /'), true);
  assert.equal(tools.isDangerous('git reset --hard HEAD~3'), true);
  assert.equal(tools.isDangerous('git push --force origin main'), true);
  assert.equal(tools.decide('run_command', { command: 'rm -rf /' }, 'guarded').decision, 'ask');
  assert.equal(tools.decide('run_command', { command: 'rm -rf /' }, 'yolo').allow, true);
});

test('tool baca/tulis/edit/list/grep bekerja di folder kerja', async () => {
  const read = await tools.executeTool('read_file', { path: 'a.txt' }, { cwd: work, mode: 'yolo' });
  assert.equal(read.ok, true);
  assert.match(read.text, /1: satu/);

  const write = await tools.executeTool('write_file', { path: 'baru/c.txt', content: 'halo' }, { cwd: work, mode: 'yolo' });
  assert.equal(write.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'baru', 'c.txt'), 'utf8'), 'halo');

  const edit = await tools.executeTool('edit_file', { path: 'a.txt', old: 'dua', new: 'DUA' }, { cwd: work, mode: 'yolo' });
  assert.equal(edit.ok, true);
  assert.match(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), /DUA/);

  // teks yang tidak unik ditolak, bukan diganti sembarangan
  fs.writeFileSync(path.join(work, 'dup.txt'), 'x x');
  const dup = await tools.executeTool('edit_file', { path: 'dup.txt', old: 'x', new: 'y' }, { cwd: work, mode: 'yolo' });
  assert.equal(dup.ok, false);
  assert.match(dup.text, /muncul 2 kali/);

  const list = await tools.executeTool('list_files', { pattern: '.txt' }, { cwd: work, mode: 'yolo' });
  assert.equal(list.ok, true);
  assert.match(list.text, /a\.txt/);

  const grep = await tools.executeTool('grep_files', { pattern: 'cari', include: '.js' }, { cwd: work, mode: 'yolo' });
  assert.equal(grep.ok, true);
  assert.match(grep.text, /sub\/b\.js:1/);
});

test('path di luar folder kerja ditolak dan .git tidak bisa disentuh', async () => {
  for (const p of ['../keluar.txt', 'C:\\Windows\\win.ini', '/etc/passwd']) {
    const r = await tools.executeTool('read_file', { path: p }, { cwd: work, mode: 'yolo' });
    assert.equal(r.ok, false, p);
    assert.match(r.text, /di luar folder kerja/);
  }
  const gitDir = await tools.executeTool('write_file', { path: '.git/config', content: 'x' }, { cwd: work, mode: 'yolo' });
  assert.equal(gitDir.ok, false);
  assert.match(gitDir.text, /\.git/);
});

test('tanpa folder kerja, tool berkas gagal dengan alasan jelas', async () => {
  const r = await tools.executeTool('read_file', { path: 'a.txt' }, { cwd: null, mode: 'yolo' });
  assert.equal(r.ok, false);
  assert.match(r.text, /folder kerja/);
});

test('perintah dijalankan di folder kerja dan keluarannya terbaca', async () => {
  const r = await tools.executeTool('run_command', { command: 'echo halo-tool' }, { cwd: work, mode: 'yolo' });
  assert.equal(r.ok, true);
  assert.match(r.text, /halo-tool/);
});

test('hook PreToolUse bisa memblokir sebelum izin diperiksa', async () => {
  const script = path.join(dir, 'deny.mjs');
  fs.writeFileSync(script, `
let raw = '';
for await (const c of process.stdin) raw += c;
const e = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: e.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'ujian blokir' } }));
`);
  hooks.setEnabled(true);
  hooks.setEventHooks('PreToolUse', [{ matcher: 'write_file', hooks: [{ type: 'process', command: process.execPath, args: [script] }] }]);
  const r = await tools.executeTool('write_file', { path: 'ditolak.txt', content: 'x' }, { cwd: work, mode: 'yolo' });
  assert.equal(r.ok, false);
  assert.match(r.text, /Ditolak hook/);
  assert.equal(fs.existsSync(path.join(work, 'ditolak.txt')), false, 'hook menolak → tidak ada tulisan');
  hooks.setEventHooks('PreToolUse', []);
});

test('hook dapat mengganti argumen tool lewat updatedInput', async () => {
  const script = path.join(dir, 'rewrite.mjs');
  fs.writeFileSync(script, `
let raw = '';
for await (const c of process.stdin) raw += c;
const e = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: e.hook_event_name, updatedInput: { path: 'diubah.txt', content: 'dari hook' } } }));
`);
  hooks.setEventHooks('PreToolUse', [{ matcher: 'write_file', hooks: [{ type: 'process', command: process.execPath, args: [script] }] }]);
  const r = await tools.executeTool('write_file', { path: 'asli.txt', content: 'dari model' }, { cwd: work, mode: 'yolo' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'diubah.txt'), 'utf8'), 'dari hook');
  assert.equal(fs.existsSync(path.join(work, 'asli.txt')), false);
  hooks.setEventHooks('PreToolUse', []);
});

test('definisi tool menyesuaikan mode', async () => {
  const plan = await tools.toolDefinitions({ cwd: work, mode: 'plan', includeMcp: false });
  assert.deepEqual(plan.map((d) => d.function.name).sort(), ['Agent', 'AskUserQuestion', 'grep_files', 'list_files', 'read_file']);
  // Build & edit tidak lagi menyembunyikan tool: `ask` sekarang benar-benar
  // bertanya, jadi menyembunyikan tool berarti agent tidak bisa meminta izin.
  const edit = await tools.toolDefinitions({ cwd: work, mode: 'edit', includeMcp: false });
  assert.equal(edit.some((d) => d.function.name === 'run_command'), true, 'mode edit menawarkan perintah (dengan persetujuan)');
  const build = await tools.toolDefinitions({ cwd: work, mode: 'build', includeMcp: false });
  assert.equal(build.some((d) => d.function.name === 'write_file'), true, 'mode build menawarkan tulis (dengan persetujuan)');
  const yolo = await tools.toolDefinitions({ cwd: work, mode: 'yolo', includeMcp: false });
  assert.equal(yolo.length, 8);
  for (const d of yolo) assert.equal(d.type, 'function');
});

test('AskUserQuestion ditawarkan tanpa folder kerja (bertanya = cara memilih folder)', async () => {
  const noCwd = await tools.toolDefinitions({ cwd: null, mode: 'yolo', includeMcp: false });
  assert.deepEqual(noCwd.map((d) => d.function.name), ['AskUserQuestion']);
});

test('subagent tidak ditawarkan ke child, dan profil boleh mempersempit', async () => {
  const child = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false, allowSubagents: false,
  });
  assert.equal(child.some((d) => d.function.name === 'Agent'), false, 'rekursi harus tertutup');

  const explore = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false,
    toolPolicy: { tools: ['read_file', 'grep_files'], disallowedTools: [] },
  });
  assert.deepEqual(explore.map((d) => d.function.name).sort(), ['grep_files', 'read_file']);
  // `Agent` dibuang juga bila profil menuliskannya di `tools`.
  const sneaky = await tools.toolDefinitions({
    cwd: work, mode: 'yolo', includeMcp: false,
    toolPolicy: { tools: ['read_file', 'Agent'], disallowedTools: [] },
  });
  assert.deepEqual(sneaky.map((d) => d.function.name), ['read_file']);
});

test('Agent adalah tool orkestrasi: boleh di plan, tanpa cwd tidak ditawarkan', async () => {
  assert.equal(tools.decide('Agent', {}, 'plan').allow, true);
  const noCwd = await tools.toolDefinitions({ cwd: null, mode: 'yolo', includeMcp: false });
  assert.deepEqual(noCwd.map((d) => d.function.name), ['AskUserQuestion'], 'tanpa folder kerja hanya bertanya yang masuk akal');
});

test('ringkasan tool melaporkan mode dan jumlahnya', async () => {
  const s = await tools.toolSummary({ cwd: work, mode: 'yolo' });
  assert.equal(s.mode, 'yolo');
  assert.equal(s.builtin.length, 8);
  assert.equal(s.builtin.includes('Agent'), true);
  assert.equal(s.builtin.includes('AskUserQuestion'), true);
  assert.equal(s.total >= 8, true);
});
