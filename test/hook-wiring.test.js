// test/hook-wiring.test.js — dua event hook yang tadinya hanya terdefinisi:
// PermissionRequest (membuka keputusan "ask" di executeTool) dan
// UserPromptSubmit (menolak/mengubah prompt sebelum model melihatnya).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hookwire-'));
process.env.AGENTHUB_DATA = dir;

const hooks = await import('../lib/hooks.js');
const tools = await import('../lib/tools.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hookwire-repo-'));

// Hook yang membalas menurut skrip di argv[2].
const SCRIPT = path.join(dir, 'hook.mjs');
fs.writeFileSync(SCRIPT, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw || '{}');
const mode = process.argv[2] || 'allow';
const out = (o) => process.stdout.write(JSON.stringify(o));
if (mode === 'allow') {
  out({ hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'allow', permissionDecisionReason: 'diizinkan kebijakan lokal' } });
} else if (mode === 'deny') {
  out({ hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'dilarang kebijakan' } });
} else if (mode === 'rewrite') {
  out({ hookSpecificOutput: { hookEventName: event.hook_event_name, updatedInput: { prompt: 'PROMPT HASIL HOOK' }, additionalContext: 'konteks dari hook' } });
} else {
  out({ ok: true, event: event.hook_event_name, hasPrompt: typeof event.prompt === 'string' });
}
`);

const configure = (events) => fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ enabled: true, events }));

test.after(() => {
  for (const d of [dir, repo]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('PermissionRequest membuka keputusan ask menjadi allow', async () => {
  fs.writeFileSync(path.join(repo, 'catatan.txt'), 'isi\n');
  configure({
    PermissionRequest: [{ matcher: 'write_file', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'allow'] }] }],
  });
  // mode build: menulis berkas tadinya butuh persetujuan
  const before = tools.decide('write_file', { path: 'catatan.txt', content: 'x' }, 'build');
  assert.equal(before.decision, 'ask');

  const r = await tools.executeTool('write_file', { path: 'baru.txt', content: 'dibuat\n' }, { cwd: repo, mode: 'build' });
  assert.equal(r.ok, true, r.text);
  assert.equal(fs.readFileSync(path.join(repo, 'baru.txt'), 'utf8'), 'dibuat\n');
  assert.match(r.decision, /allow/);
});

test('PermissionRequest bisa menolak, dan penolakan tidak menulis apa pun', async () => {
  configure({
    PermissionRequest: [{ matcher: 'write_file', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }],
  });
  const r = await tools.executeTool('write_file', { path: 'terlarang.txt', content: 'tidak boleh\n' }, { cwd: repo, mode: 'build' });
  assert.equal(r.ok, false);
  assert.equal(r.decision, 'deny');
  assert.equal(fs.existsSync(path.join(repo, 'terlarang.txt')), false);
});

test('mode plan tidak bisa dibuka oleh PermissionRequest', async () => {
  // plan menolak (bukan bertanya), jadi tidak pernah sampai ke PermissionRequest
  configure({
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'allow'] }] }],
  });
  const r = await tools.executeTool('write_file', { path: 'plan.txt', content: 'x' }, { cwd: repo, mode: 'plan' });
  assert.equal(r.ok, false);
  assert.equal(r.decision, 'deny');
  assert.equal(fs.existsSync(path.join(repo, 'plan.txt')), false);
});

test('tanpa hook izin, keputusan ask tetap ask', async () => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ enabled: true, events: {} }));
  const r = await tools.executeTool('write_file', { path: 'tetap.txt', content: 'x' }, { cwd: repo, mode: 'build' });
  assert.equal(r.ok, false);
  assert.equal(r.decision, 'ask');
});

test('UserPromptSubmit: allow meneruskan prompt apa adanya', async () => {
  configure({ UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'noop'] }] }] });
  const r = await hooks.runEvent('UserPromptSubmit', { prompt: 'halo' });
  assert.equal(r.denied, false);
  assert.equal(r.updatedInput, undefined);
});

test('UserPromptSubmit: deny memblokir, rewrite mengganti prompt', async () => {
  configure({ UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'deny'] }] }] });
  const denied = await hooks.runEvent('UserPromptSubmit', { prompt: 'halo' });
  assert.equal(denied.denied, true);
  assert.match(denied.reason, /dilarang/);

  configure({ UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [SCRIPT, 'rewrite'] }] }] });
  const rewritten = await hooks.runEvent('UserPromptSubmit', { prompt: 'halo' });
  assert.equal(rewritten.updatedInput.prompt, 'PROMPT HASIL HOOK');
  assert.match(rewritten.additionalContext, /konteks dari hook/);
});

test('hook rusak tidak menggagalkan run (fail open untuk prompt)', async () => {
  configure({ UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'process', command: path.join(dir, 'tidak-ada.mjs'), args: [] }] }] });
  const r = await hooks.runEvent('UserPromptSubmit', { prompt: 'halo' });
  assert.equal(r.denied, false, 'hook yang gagal dijalankan tidak boleh memblokir');
  assert.equal(r.results[0].ok, false, 'kegagalannya tetap tercatat');
});
