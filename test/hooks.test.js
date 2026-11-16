// test/hooks.test.js — hook siklus hidup (REA ZCode hooks-runtime-contract):
// matcher, keputusan allow/ask/deny, updatedInput, additionalContext, exit 2,
// batas waktu, dan kepercayaan hook proyek yang terikat digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hooks-'));
process.env.AGENTHUB_DATA = dir;

const hooks = await import('../lib/hooks.js');

// Hook kecil yang membaca stdin lalu membalas sesuai skrip di argv.
const SCRIPT = path.join(dir, 'hook.mjs');
fs.writeFileSync(SCRIPT, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw || '{}');
const mode = process.argv[2] || 'allow';
if (mode === 'deny') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'ujian menolak' } }));
} else if (mode === 'ask') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'ask', permissionDecisionReason: 'ujian bertanya' } }));
} else if (mode === 'rewrite') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, updatedInput: { path: 'aman.txt', command: 'echo aman' }, additionalContext: 'konteks dari hook' } }));
} else if (mode === 'block2') {
  process.stderr.write('diblokir lewat exit 2');
  process.exit(2);
} else if (mode === 'bad') {
  process.stdout.write('bukan json');
} else if (mode === 'slow') {
  await new Promise((r) => setTimeout(r, 5000));
  process.stdout.write('{}');
} else {
  process.stdout.write(JSON.stringify({ ok: true, seen: event.hook_event_name, tool: event.tool_name }));
}
`);

function configure(events, enabled = true) {
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ enabled, events }));
}

test.after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('matcher: daftar nama persis, wildcard, dan regex hanya bila ada sintaks regex', () => {
  assert.equal(hooks.matches('*', 'Bash'), true);
  assert.equal(hooks.matches('Write|Edit', 'Edit'), true);
  assert.equal(hooks.matches('Write|Edit', 'EditMany'), false, 'daftar nama bukan awalan');
  assert.equal(hooks.matches('Bash|Read', 'Write'), false);
  assert.equal(hooks.matches('^mcp__.*__search$', 'mcp__gh__search'), true);
  assert.equal(hooks.matches('[', 'Bash'), false, 'regex rusak tidak melempar');
});

test('event tidak dikenal ditolak; hook kosong ditolak', () => {
  assert.throws(() => hooks.setEventHooks('TidakAda', []), /tidak dikenal/);
  assert.throws(() => hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [] }]), /minimal satu hook/);
  assert.throws(() => hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [{ type: 'command', command: '' }] }]), /perintah/);
});

test('event nonaktif tidak menjalankan hook', async () => {
  hooks.setEventHooks('PreToolUse', [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }]);
  hooks.setEnabled(false);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.results.length, 0);
});

test('deny, ask, dan allow sesuai balasan hook', async () => {
  hooks.setEnabled(true);
  hooks.setEventHooks('PreToolUse', [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }]);
  let r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'deny');
  assert.equal(r.denied, true);
  assert.match(r.reason, /ujian menolak/);

  hooks.setEventHooks('PreToolUse', [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'ask'] }] }]);
  r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'ask');
  assert.equal(r.denied, false);

  hooks.setEventHooks('PreToolUse', [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'allow'] }] }]);
  r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.results[0].ok, true);
});

test('matcher yang tidak cocok melewati hook', async () => {
  hooks.setEventHooks('PreToolUse', [{ matcher: 'Write', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }]);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.results.length, 0);
});

test('updatedInput dan additionalContext diteruskan', async () => {
  hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'rewrite'] }] }]);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'write_file', tool_input: { path: 'x.txt' } });
  assert.deepEqual(r.updatedInput, { path: 'aman.txt', command: 'echo aman' });
  assert.equal(r.additionalContext, 'konteks dari hook');
});

test('exit code 2 memblokir tanpa perlu JSON', async () => {
  hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'block2'] }] }]);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /exit 2/);
});

test('keluaran bukan JSON dan batas waktu menjadi diagnostik, bukan blokir diam-diam', async () => {
  hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'bad'] }] }]);
  let r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'allow');
  assert.match(r.results[0].error, /bukan JSON/);

  hooks.setEventHooks('PreToolUse', [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'slow'], timeoutMs: 1000 }] }]);
  const t0 = Date.now();
  r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'allow');
  assert.match(r.results[0].error, /batas 1 detik/);
  assert.ok(Date.now() - t0 < 4500, 'harus berhenti jauh sebelum hook selesai');
});

test('deny menang atas allow ketika beberapa hook berjalan', async () => {
  hooks.setEventHooks('PreToolUse', [
    { matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'allow'] }] },
    { matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] },
  ]);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' });
  assert.equal(r.decision, 'deny');
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].ok, true);
});

test('hook proyek tidak berjalan sebelum dipercaya, lalu berjalan setelah grant', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hook-proj-'));
  fs.mkdirSync(path.join(project, '.agenthub'), { recursive: true });
  const events = {
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }],
  };
  fs.writeFileSync(path.join(project, '.agenthub', 'hooks.json'), JSON.stringify({ enabled: true, events }));

  hooks.setEventHooks('PreToolUse', []);
  const before = await hooks.runEvent('PostToolUse', { tool_name: 'read_file' }, { cwd: project });
  assert.equal(before.decision, 'allow', 'belum dipercaya → tidak dijalankan');
  assert.equal(before.results[0].skipped, true);
  assert.match(before.results[0].reason, /belum dipercaya/);

  const status = hooks.trustStatus(project);
  assert.equal(status.present, true);
  assert.equal(status.trusted, false);
  assert.equal(status.digest.length, 64);

  assert.throws(() => hooks.grantTrust(project, 'deadbeef'), /Digest tidak cocok/);
  hooks.grantTrust(project, status.digest);
  assert.equal(hooks.trustStatus(project).trusted, true);

  const after = await hooks.runEvent('PostToolUse', { tool_name: 'read_file' }, { cwd: project });
  assert.equal(after.decision, 'deny');
  assert.equal(after.results[0].ok, true);

  // deklarasi berubah → digest berubah → izin gugur
  events.PostToolUse[0].hooks[0].args = [SCRIPT, 'allow'];
  fs.writeFileSync(path.join(project, '.agenthub', 'hooks.json'), JSON.stringify({ enabled: true, events }));
  assert.equal(hooks.trustStatus(project).trusted, false);

  // Izin lama masih tercatat tetapi sudah tidak berlaku; mencabutnya sah dan
  // setelah itu status tetap tidak dipercaya.
  assert.equal(hooks.revokeTrust(project), true);
  assert.equal(hooks.trustStatus(project).trusted, false);
  assert.equal(hooks.revokeTrust(project), false, 'pencabutan kedua tidak mengubah apa pun');
  fs.rmSync(project, { recursive: true, force: true });
});

test('hooks.json proyek yang rusak tidak menjalankan apa pun', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hook-bad-'));
  fs.mkdirSync(path.join(project, '.agenthub'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agenthub', 'hooks.json'), '{ rusak');
  const s = hooks.trustStatus(project);
  assert.equal(s.present, true);
  assert.equal(s.trusted, false);
  assert.match(s.error, /tidak valid/);
  fs.rmSync(project, { recursive: true, force: true });
});

test('ringkasan menghitung hook user dan proyek', () => {
  hooks.setEnabled(true);
  hooks.setEventHooks('PreToolUse', [{ matcher: 'Bash', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'allow'] }] }]);
  const s = hooks.summary();
  assert.equal(s.enabled, true);
  assert.equal(s.userHooks, 1);
  assert.equal(s.project.present, false);
  assert.equal(s.events.length, 7);
});
