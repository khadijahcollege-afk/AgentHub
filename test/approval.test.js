// test/approval.test.js — broker persetujuan: `ask` berhenti dan menunggu,
// bukan menolak. Yang diuji di sini adalah janji-janji yang membuat run tidak
// pernah menggantung: setiap permintaan selesai lewat jawaban, batas waktu,
// pembatalan, atau tidak pernah dibuat sama sekali.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-approval-'));
process.env.AGENTHUB_DATA = dir;

const approvals = await import('../lib/approvals.js');

test.after(() => {
  approvals.cancelAll('tes selesai');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

const cwdA = path.join(dir, 'proyek-a');
const cwdB = path.join(dir, 'proyek-b');

function client(overrides = {}) {
  return approvals.createClient({ threadId: 'aaaa1111', ...overrides });
}

test('klien membawa threadId dan meneruskan tag', () => {
  const c = client();
  assert.equal(c.threadId, 'aaaa1111');
});

test('izin: allow dan deny menyelesaikan promise dengan keputusan itu', async () => {
  const noted = [];
  const c = approvals.createClient({ threadId: 'aaaa1111', notify: (r) => noted.push(r) });

  const p1 = c.askPermission({ tool: 'write_file', input: { path: 'a.txt' }, reason: 'menulis', mode: 'build', cwd: cwdA, risk: 'medium' });
  assert.equal(noted.length, 1, 'payload dikirim ke UI saat permintaan dibuat');
  assert.equal(noted[0].kind, 'permission');
  const r1 = approvals.resolve('aaaa1111', noted[0].requestId, { decision: 'allow' });
  assert.equal(r1.ok, true);
  const a1 = await p1;
  assert.equal(a1.decision, 'allow');

  const p2 = c.askPermission({ tool: 'write_file', input: {}, reason: 'menulis', mode: 'build', cwd: cwdA });
  const listNow = approvals.list('aaaa1111');
  assert.equal(listNow.length, 1);
  approvals.resolve('aaaa1111', listNow[0].requestId, { decision: 'deny', reason: 'tidak perlu' });
  const a2 = await p2;
  assert.equal(a2.decision, 'deny');
  assert.equal(a2.reason, 'tidak perlu');
  assert.equal(approvals.list('aaaa1111').length, 0, 'permintaan yang sudah dijawab tidak tersisa');
});

test('izin: batas waktu melepas run, bukan menggantung', async () => {
  const c = approvals.createClient({ threadId: 'bbbb2222', permissionTimeoutMs: 30 });
  const a = await c.askPermission({ tool: 'run_command', input: { command: 'dir' }, reason: 'perintah', mode: 'build', cwd: cwdA });
  assert.equal(a.decision, 'deny');
  assert.equal(a.timedOut, true);
  assert.match(a.reason, /Tidak dijawab/);
  assert.equal(approvals.list('bbbb2222').length, 0);
});

test('abort membatalkan permintaan yang sedang menunggu', async () => {
  const ctrl = new AbortController();
  const c = approvals.createClient({ threadId: 'cccc3333', signal: ctrl.signal });
  const p = c.askPermission({ tool: 'write_file', input: {}, reason: 'menulis', mode: 'build', cwd: cwdA });
  assert.equal(approvals.list('cccc3333').length, 1);
  ctrl.abort();
  const a = await p;
  assert.equal(a.decision, 'deny');
  assert.equal(a.cancelled, true);
  assert.equal(approvals.list('cccc3333').length, 0, 'pembatalan harus melepas registry');
});

test('signal yang sudah dibatalkan tidak membuat permintaan menunggu', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const c = approvals.createClient({ threadId: 'dddd4444', signal: ctrl.signal });
  const a = await c.askPermission({ tool: 'write_file', input: {}, reason: 'x', mode: 'build', cwd: cwdA });
  assert.equal(a.decision, 'deny');
  assert.equal(a.cancelled, true);
  assert.equal(approvals.pendingCount(), 0);
});

test('cancelThread hanya melepas thread itu', async () => {
  const a = approvals.createClient({ threadId: 'eeee5555' }).askPermission({ tool: 'write_file', input: {}, reason: 'x', mode: 'build', cwd: cwdA });
  const b = approvals.createClient({ threadId: 'ffff6666' }).askPermission({ tool: 'write_file', input: {}, reason: 'x', mode: 'build', cwd: cwdA });
  const released = approvals.cancelThread('eeee5555', 'dihentikan');
  assert.equal(released, 1);
  assert.equal((await a).cancelled, true);
  assert.equal(approvals.list('ffff6666').length, 1, 'thread lain tidak tersentuh');
  approvals.cancelAll();
  await b;
  assert.equal(approvals.pendingCount(), 0);
});

test('jawaban untuk request yang tidak ada / thread lain ditolak', async () => {
  const c = approvals.createClient({ threadId: 'aaaa9999' });
  const p = c.askPermission({ tool: 'write_file', input: {}, reason: 'x', mode: 'build', cwd: cwdA });
  const [req] = approvals.list('aaaa9999');

  const wrong = approvals.resolve('ffff0000', req.requestId, { decision: 'allow' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'WRONG_THREAD');
  assert.equal(wrong.status, 403);

  const missing = approvals.resolve('aaaa9999', 'tidakada', { decision: 'allow' });
  assert.equal(missing.code, 'NOT_PENDING');
  assert.equal(missing.status, 404);

  const bad = approvals.resolve('aaaa9999', req.requestId, { decision: 'mungkin' });
  assert.equal(bad.code, 'BAD_DECISION');
  assert.equal(bad.status, 400);

  // Permintaan yang gagal dijawab tetap menunggu: kesalahan klien tidak boleh
  // melepas run secara diam-diam.
  assert.equal(approvals.list('aaaa9999').length, 1);
  approvals.resolve('aaaa9999', req.requestId, { decision: 'allow' });
  assert.equal((await p).decision, 'allow');
});

test('aturan "selalu di folder ini" hanya untuk tool tulis, dan per folder', async () => {
  assert.equal(approvals.canRemember('write_file'), true);
  assert.equal(approvals.canRemember('edit_file'), true);
  assert.equal(approvals.canRemember('delete_file'), true);
  // Satu perintah yang tampak jinak tidak menjamin perintah berikutnya jinak.
  assert.equal(approvals.canRemember('run_command'), false);
  assert.equal(approvals.canRemember('read_file'), false);

  const c = approvals.createClient({ threadId: 'a1b2c3d4' });
  const p = c.askPermission({ tool: 'write_file', input: { path: 'x.txt' }, reason: 'menulis', mode: 'build', cwd: cwdA });
  const [req] = approvals.list('a1b2c3d4');
  const r = approvals.resolve('a1b2c3d4', req.requestId, { decision: 'allow', always: true });
  assert.equal(r.ok, true);
  await p;

  assert.equal(approvals.allowedByRule(cwdA, 'write_file'), true);
  assert.equal(approvals.allowedByRule(cwdA, 'run_command'), false);
  assert.equal(approvals.allowedByRule(cwdB, 'write_file'), false, 'izin satu folder tidak bocor ke folder lain');

  // run_command tidak bisa diingat: permintaannya ditolak, bukan disimpan diam-diam.
  const p2 = c.askPermission({ tool: 'run_command', input: { command: 'dir' }, reason: 'perintah', mode: 'build', cwd: cwdA });
  const [req2] = approvals.list('a1b2c3d4');
  const r2 = approvals.resolve('a1b2c3d4', req2.requestId, { decision: 'allow', always: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'CANNOT_REMEMBER');
  approvals.resolve('a1b2c3d4', req2.requestId, { decision: 'deny' });
  await p2;
  assert.equal(approvals.allowedByRule(cwdA, 'run_command'), false);

  assert.equal(approvals.clearRules(cwdA), true);
  assert.equal(approvals.allowedByRule(cwdA, 'write_file'), false);
  assert.equal(approvals.clearRules(cwdA), false, 'menghapus aturan yang tidak ada bukan kesalahan');
});

test('jawaban pertanyaan: answered meneruskan answers, reject melepas', async () => {
  const c = approvals.createClient({ threadId: 'beef1234' });
  const questions = [{
    question: 'Database apa?',
    header: 'Database',
    multiSelect: false,
    options: [{ label: 'SQLite', description: 'sederhana' }, { label: 'Postgres', description: 'skala besar' }],
  }];

  const p = c.askQuestion({ tool: 'AskUserQuestion', questions });
  const [req] = approvals.list('beef1234');
  assert.equal(req.kind, 'question');
  assert.deepEqual(req.questions, questions);
  approvals.resolve('beef1234', req.requestId, { decision: 'answered', answers: { 'Database apa?': 'SQLite' } });
  const a = await p;
  assert.equal(a.decision, 'answered');
  assert.deepEqual(a.answers, { 'Database apa?': 'SQLite' });

  const p2 = c.askQuestion({ tool: 'AskUserQuestion', questions });
  const [req2] = approvals.list('beef1234');
  approvals.resolve('beef1234', req2.requestId, { decision: 'reject', reason: 'lewati saja' });
  const a2 = await p2;
  assert.equal(a2.decision, 'deny');
  assert.equal(a2.reason, 'lewati saja');

  // `decision` selain answered/reject tidak sah untuk pertanyaan.
  const p3 = c.askQuestion({ tool: 'AskUserQuestion', questions });
  const [req3] = approvals.list('beef1234');
  assert.equal(approvals.resolve('beef1234', req3.requestId, { decision: 'allow' }).code, 'BAD_DECISION');
  approvals.resolve('beef1234', req3.requestId, { decision: 'answered', answers: {} });
  assert.deepEqual((await p3).answers, {});
});

test('pertanyaan dari subagent ditandai, dan klien turunannya tidak bisa bercabang lagi', async () => {
  const parent = approvals.createClient({ threadId: 'cafe5555' });
  const child = parent.forSubagent({ subagent: 'Explore', agentId: 'agent-1' });
  const p = child.askQuestion({ tool: 'AskUserQuestion', questions: [] });
  const [req] = approvals.list('cafe5555');
  assert.equal(req.subagent, 'Explore');
  assert.equal(req.agentId, 'agent-1');
  assert.equal(child.forSubagent({ subagent: 'x', agentId: 'y' }), null, 'subagent tidak boleh punya subagent');
  approvals.resolve('cafe5555', req.requestId, { decision: 'answered', answers: {} });
  await p;

  // Izin dari anak juga ditandai supaya kartunya bisa dicocokkan dengan barisnya.
  const p2 = child.askPermission({ tool: 'write_file', input: {}, reason: 'menulis', mode: 'edit', cwd: cwdB });
  const [req2] = approvals.list('cafe5555');
  assert.equal(req2.subagent, 'Explore');
  approvals.resolve('cafe5555', req2.requestId, { decision: 'deny' });
  await p2;
});

test('createClient.list melihat permintaan thread-nya sendiri', async () => {
  const c = approvals.createClient({ threadId: 'dead7777' });
  const p = c.askPermission({ tool: 'write_file', input: {}, reason: 'x', mode: 'build', cwd: cwdA });
  const mine = c.list();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].tool, 'write_file');
  assert.equal(typeof mine[0].expiresAt, 'number');
  assert.equal(c.cancel('selesai'), 1);
  assert.equal((await p).cancelled, true);
});
