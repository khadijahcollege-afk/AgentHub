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

test('decide: perintah latar mengikuti aturan perintah, menghentikan selalu boleh', () => {
  // Memulai perintah latar adalah MENJALANKAN perintah: ia tidak boleh lebih
  // longgar dari `run_command` hanya karena ia tidak menunggu.
  assert.equal(tools.decide('start_background_command', { command: 'npm install' }, 'build').decision, 'ask');
  assert.equal(tools.decide('start_background_command', { command: 'npm install' }, 'edit').decision, 'ask');
  assert.equal(tools.decide('start_background_command', { command: 'npm install' }, 'guarded').allow, true);
  assert.equal(tools.decide('start_background_command', { command: 'rm -rf /' }, 'guarded').decision, 'ask');
  assert.equal(tools.decide('start_background_command', { command: 'npm install' }, 'yolo').allow, true);
  assert.equal(tools.decide('start_background_command', { command: 'npm install' }, 'plan').decision, 'deny');

  // Membaca keluaran = membaca berkas.
  assert.equal(tools.decide('check_background_command', { id: 'abc' }, 'plan').allow, true);

  // Menghentikan tidak pernah butuh izin, termasuk di plan mode: ia hanya
  // mencabut izin yang sudah diberikan.
  assert.equal(tools.decide('stop_background_command', { id: 'abc' }, 'plan').allow, true);
  assert.equal(tools.decide('stop_background_command', { id: 'abc' }, 'build').allow, true);
  assert.equal(tools.decide('stop_background_command', { id: 'abc' }, 'yolo').allow, true);
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

test('perintah latar: mulai, baca, dan hentikan lewat tool', async () => {
  const win = process.platform === 'win32';
  // Perintah yang tetap hidup: tes ini butuh tugas yang MASIH berjalan saat
  // `start` menjawab, karena itulah perbedaan satu-satunya dengan run_command.
  const long = win ? 'Start-Sleep -Milliseconds 30000' : 'sleep 30';

  const started = await tools.executeTool(
    'start_background_command',
    { command: long, waitMs: 0, label: 'tidur' },
    { cwd: work, mode: 'yolo', threadId: 'thread-bg' },
  );
  assert.equal(started.ok, true, started.text);
  assert.match(started.text, /Perintah latar dimulai/);
  assert.match(started.text, /Masih berjalan/);
  assert.match(started.text, /\.agenthub\/tasks\//);
  const id = started.meta?.task?.id;
  assert.ok(id, 'id tugas harus dilaporkan supaya model bisa memeriksanya');
  assert.equal(started.meta.task.status, 'running');

  // Daftar tanpa id.
  const list = await tools.executeTool('check_background_command', {}, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(list.ok, true);
  assert.match(list.text, new RegExp(id));

  // Satu tugas, dengan keluaran (kosong karena hanya tidur).
  const one = await tools.executeTool('check_background_command', { id }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(one.ok, true);
  assert.match(one.text, /masih berjalan/);
  assert.match(one.text, /menunggu masukan/);

  const stopped = await tools.executeTool('stop_background_command', { id }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(stopped.ok, true, stopped.text);
  assert.match(stopped.text, /dihentikan/);

  // Menghentikan dua kali bukan galat: UI dan model sama-sama boleh menekan.
  const again = await tools.executeTool('stop_background_command', { id }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(again.ok, true);
  assert.match(again.text, /sudah berhenti/);
});

test('perintah latar pendek selesai di tempat dan mengembalikan keluarannya', async () => {
  const r = await tools.executeTool(
    'start_background_command',
    { command: 'echo cepat-latar', waitMs: 20000 },
    { cwd: work, mode: 'yolo', threadId: 'thread-bg' },
  );
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /selesai \(id: .+\) dengan kode keluar 0/);
  assert.match(r.text, /cepat-latar/);
  assert.equal(r.meta.task.status, 'done');
});

test('perintah latar menolak perintah kosong dan id yang tidak dikenal', async () => {
  const empty = await tools.executeTool('start_background_command', { command: '   ' }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'SCHEMA');

  const missing = await tools.executeTool('check_background_command', { id: 'tidakada' }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'NOT_FOUND');
  // Pesannya menunjuk jalan keluar, bukan hanya mengeluh.
  assert.match(missing.text, /tanpa id/);

  const stopMissing = await tools.executeTool('stop_background_command', { id: 'tidakada' }, { cwd: work, mode: 'yolo', threadId: 'thread-bg' });
  assert.equal(stopMissing.ok, false);
  assert.equal(stopMissing.error, 'NOT_FOUND');
});

test('perintah latar milik thread lain tidak bisa dibaca atau dihentikan', async () => {
  const r = await tools.executeTool(
    'start_background_command',
    { command: 'echo rahasia', waitMs: 20000 },
    { cwd: work, mode: 'yolo', threadId: 'pemilik' },
  );
  assert.equal(r.ok, true, r.text);
  const id = r.meta.task.id;

  const peek = await tools.executeTool('check_background_command', { id }, { cwd: work, mode: 'yolo', threadId: 'penyusup' });
  assert.equal(peek.ok, false);
  assert.equal(peek.error, 'FORBIDDEN');
  assert.match(peek.text, /thread lain/);

  const kill = await tools.executeTool('stop_background_command', { id }, { cwd: work, mode: 'yolo', threadId: 'penyusup' });
  assert.equal(kill.ok, false);
  assert.equal(kill.error, 'FORBIDDEN');
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
  // Plan mode kini juga menawarkan kedua tool transisi: tanpa `ExitPlanMode`
  // agent yang masuk plan tidak punya jalan keluar selain menunggu pengguna
  // mengganti chip akses sendiri.
  assert.deepEqual(plan.map((d) => d.function.name).sort(), [
    'Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
    'check_background_command', 'grep_files', 'list_files', 'read_file', 'stop_background_command',
  ]);
  // Build & edit tidak lagi menyembunyikan tool: `ask` sekarang benar-benar
  // bertanya, jadi menyembunyikan tool berarti agent tidak bisa meminta izin.
  const edit = await tools.toolDefinitions({ cwd: work, mode: 'edit', includeMcp: false });
  assert.equal(edit.some((d) => d.function.name === 'run_command'), true, 'mode edit menawarkan perintah (dengan persetujuan)');
  const build = await tools.toolDefinitions({ cwd: work, mode: 'build', includeMcp: false });
  assert.equal(build.some((d) => d.function.name === 'write_file'), true, 'mode build menawarkan tulis (dengan persetujuan)');
  const yolo = await tools.toolDefinitions({ cwd: work, mode: 'yolo', includeMcp: false });
  // `EnterPlanMode` tetap ditawarkan di luar plan (agent boleh memutuskan
  // merencanakan dulu), tetapi `ExitPlanMode` tidak: panggilan itu pasti ditolak.
  assert.equal(yolo.some((d) => d.function.name === 'EnterPlanMode'), true);
  assert.equal(yolo.some((d) => d.function.name === 'ExitPlanMode'), false);
  assert.equal(yolo.length, 12);
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
  assert.equal(s.builtin.length, 12);
  assert.equal(s.builtin.includes('Agent'), true);
  assert.equal(s.builtin.includes('AskUserQuestion'), true);
  // Tiga tool perintah latar adalah satu keluarga, dan ketiganya harus terlihat
  // oleh model di mode yang mengizinkan perintah.
  for (const n of ['start_background_command', 'check_background_command', 'stop_background_command']) {
    assert.equal(s.builtin.includes(n), true, n);
  }
  assert.equal(s.total >= 8, true);
});
