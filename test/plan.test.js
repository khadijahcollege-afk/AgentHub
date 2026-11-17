// test/plan.test.js — plan mode yang dipimpin agent: aturan transisi, bentuk
// rencana, berkas rencana, dan efek nyata persetujuan terhadap gerbang izin.
//
// Yang diuji di sini adalah PERILAKU, bukan sekadar bentuk objek: setelah
// rencana disetujui, `write_file` harus benar-benar lolos tanpa bertanya; setelah
// ditolak, ia harus tetap ditolak. Itu dua kalimat yang menjadi alasan seluruh
// modul ini ada — kalau keduanya salah, kartu rencana hanya hiasan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plan-'));
process.env.AGENTHUB_DATA = dir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plan-work-'));

const plan = await import('../lib/plan.js');
const tools = await import('../lib/tools.js');

test.after(() => {
  for (const d of [dir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

// ---------- nama berkas ----------
test('sanitizeName tidak pernah menghasilkan path yang keluar folder', () => {
  // Sumber nama adalah id thread dari server, tetapi helper ini juga dipakai
  // untuk nilai yang datang dari luar (mis. id dari URL). Karena itu `.`/`..`
  // dan pemisah path harus hilang, bukan sekadar di-encode.
  assert.equal(plan.sanitizeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(plan.sanitizeName('..'), 'plan');
  assert.equal(plan.sanitizeName('.'), 'plan');
  assert.equal(plan.sanitizeName(''), 'plan');
  assert.equal(plan.sanitizeName(null), 'plan');
  assert.equal(plan.sanitizeName('abc-123_XY'), 'abc-123_XY');
  assert.ok(!plan.sanitizeName('a/b\\c:d*e?f').includes('/'));
  assert.ok(!plan.sanitizeName('a/b\\c:d*e?f').includes('\\'));
});

test('planFilePath tinggal di .agenthub/plans dan tetap di dalam folder kerja', () => {
  const file = plan.planFilePath(work, 'thread1');
  assert.equal(path.dirname(file), path.join(work, '.agenthub', 'plans'));
  assert.equal(plan.planFileRelPath('thread1'), '.agenthub/plans/plan-thread1.md');
  // Folder kerja belum dipilih: tidak ada tempat menulis, jadi null — bukan
  // path relatif terhadap proses server yang kebetulan sedang berjalan.
  assert.equal(plan.planFilePath(null, 'thread1'), null);
});

// ---------- bentuk rencana ----------
test('normalizePlan menolak rencana kosong dan terlalu panjang', () => {
  assert.equal(plan.normalizePlan({ plan: '   \n\t ' }).ok, false);
  assert.equal(plan.normalizePlan({}).ok, false);
  assert.equal(plan.normalizePlan({ plan: 42 }).ok, false);
  const long = 'x'.repeat(plan.MAX_PLAN_CHARS + 1);
  const over = plan.normalizePlan({ plan: long });
  assert.equal(over.ok, false);
  assert.match(over.error, /terlalu panjang/);
  assert.equal(plan.normalizePlan({ plan: 'x'.repeat(plan.MAX_PLAN_CHARS) }).ok, true);
});

test('normalizePlan merapikan CRLF dan spasi tepi', () => {
  const r = plan.normalizePlan({ plan: '  satu\r\ndua  \n' });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'satu\ndua');
});

test('normalizeAllowedPrompts membatasi jumlah dan membuang yang hampa', () => {
  const list = plan.normalizeAllowedPrompts([
    { tool: 'run_command', prompt: '  jalankan   tes  ' },
    { prompt: '' },
    null,
    ...Array.from({ length: 10 }, (_, i) => ({ prompt: `langkah ${i}` })),
  ]);
  assert.equal(list.length, 8);
  assert.deepEqual(list[0], { tool: 'run_command', prompt: 'jalankan tes' });
  // Tool yang tidak disebut tetap punya nilai: UI menampilkan "tool: prompt",
  // dan baris tanpa nama tool terlihat seperti data yang rusak.
  assert.equal(list[1].tool, 'run_command');
  assert.equal(plan.normalizeAllowedPrompts('bukan array').length, 0);
});

// ---------- transisi mode ----------
test('EnterPlanMode tidak pernah bertanya, bahkan di yolo', () => {
  for (const mode of ['yolo', 'guarded', 'edit', 'build', 'plan']) {
    const v = plan.planTransitionVerdict('EnterPlanMode', { mode });
    assert.equal(v.allow, true, mode);
    assert.equal(v.decision, 'allow', mode);
  }
});

test('ExitPlanMode selalu bertanya saat plan aktif, dan ditolak di luar plan', () => {
  for (const mode of ['plan', 'yolo', 'build']) {
    const active = plan.planTransitionVerdict('ExitPlanMode', { mode, planActive: true });
    assert.equal(active.decision, 'ask', mode);
    assert.equal(active.planApproval, true, mode);
    assert.equal(active.alwaysAsk, true, mode);
  }
  const outside = plan.planTransitionVerdict('ExitPlanMode', { mode: 'yolo', planActive: false });
  assert.equal(outside.allow, false);
  assert.equal(outside.decision, 'deny');
  assert.equal(outside.code, 'NOT_IN_PLAN_MODE');
  // Mode `plan` yang dipilih dari chip juga dihitung "di dalam plan".
  assert.equal(plan.planTransitionVerdict('ExitPlanMode', { mode: 'plan', planActive: false }).decision, 'ask');
});

test('planTransitionVerdict mengembalikan undefined untuk tool lain', () => {
  assert.equal(plan.planTransitionVerdict('write_file', { mode: 'plan' }), undefined);
  assert.equal(plan.isPlanTool('write_file'), false);
  assert.equal(plan.isPlanTool('EnterPlanMode'), true);
});

test('nextPrePlanMode mengingat mode sebelumnya, bukan bawaan', () => {
  assert.equal(plan.nextPrePlanMode('yolo'), 'yolo');
  assert.equal(plan.nextPrePlanMode('plan', 'guarded'), 'guarded');
  assert.equal(plan.nextPrePlanMode('plan', null), 'build');
  assert.equal(plan.nextPrePlanMode('', 'edit'), 'edit');
});

// ---------- berkas rencana ----------
test('renderPlanFile memberi kepala yang menyebut thread dan folder', () => {
  const text = plan.renderPlanFile({ plan: '# Langkah\n\n- ubah a.txt', threadId: 't1', cwd: '/x', approvedAt: Date.UTC(2026, 0, 2) });
  assert.match(text, /^# Rencana\n/);
  assert.match(text, /- Thread: t1/);
  assert.match(text, /- Folder: \/x/);
  assert.match(text, /- Disetujui: 2026-01-02T00:00:00.000Z/);
  assert.match(text, /---\n\n# Langkah/);
});

test('writePlanFile menulis atomik dan bisa dibaca kembali', () => {
  const file = plan.writePlanFile({ cwd: work, threadId: 'thr-a', plan: 'isi rencana', approvedAt: Date.now() });
  assert.equal(fs.existsSync(file), true);
  // Tidak ada berkas .tmp yang tertinggal: penulisan setengah jadi akan dibaca
  // model sebagai rencana yang terpotong.
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.match(plan.readPlanFile({ cwd: work, threadId: 'thr-a' }), /isi rencana/);
  assert.equal(plan.planFileExists({ cwd: work, threadId: 'thr-a' }), true);
  assert.equal(plan.planFileExists({ cwd: work, threadId: 'thr-b' }), false);
  assert.equal(plan.readPlanFile({ cwd: work, threadId: 'thr-b' }), null);
});

test('planReminder hanya muncul bila berkas rencana ada', () => {
  assert.equal(plan.planReminder({ cwd: work, threadId: 'tidak-ada' }), null);
  const r = plan.planReminder({ cwd: work, threadId: 'thr-a', approved: false });
  assert.match(r, /BELUM disetujui/);
  assert.match(r, /\.agenthub\/plans\/plan-thr-a\.md/);
  assert.match(plan.planReminder({ cwd: work, threadId: 'thr-a', approved: true }), /sudah disetujui/);
});

// ---------- gerbang izin memakai runtime ----------
test('decide: tool plan memakai runtime, bukan mode saja', () => {
  const enter = tools.decide('EnterPlanMode', {}, 'plan');
  assert.equal(enter.decision, 'allow');
  const exit = tools.decide('ExitPlanMode', {}, 'plan', { planActive: true });
  assert.equal(exit.decision, 'ask');
  const denied = tools.decide('ExitPlanMode', {}, 'yolo', { planActive: false });
  assert.equal(denied.code, 'NOT_IN_PLAN_MODE');
  // Tool biasa tidak terpengaruh: runtime hanya mengubah dua tool itu.
  assert.equal(tools.decide('write_file', {}, 'yolo', { planActive: true }).allow, true);
});

// ---------- alur setuju / tolak ----------
function fakeClient(answer) {
  const seen = [];
  return {
    calls: seen,
    askPlan: async ({ plan: text, allowedPrompts }) => { seen.push({ text, allowedPrompts }); return answer; },
  };
}

test('ExitPlanMode tanpa rencana ditolak sebagai kesalahan schema, bukan disetujui', async () => {
  const runtime = { active: true, pre: 'yolo', mode: 'plan', threadId: 'thr-schema' };
  const client = fakeClient({ decision: 'approve' });
  const r = await tools.executeTool('ExitPlanMode', { plan: '  ' }, { cwd: work, mode: 'plan', client, planRuntime: runtime });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'SCHEMA');
  // Tidak ada yang ditanyakan: rencana hampa tidak layak ditampilkan ke manusia.
  assert.equal(client.calls.length, 0);
  assert.equal(runtime.mode, 'plan');
});

test('rencana disetujui: berkas tertulis, mode berubah, dan tulis berkas jadi boleh', async () => {
  const runtime = { active: true, pre: 'yolo', mode: 'plan', threadId: 'thr-ok' };
  const client = fakeClient({ decision: 'approve' });
  const r = await tools.executeTool(
    'ExitPlanMode',
    { plan: '## Rencana\n- ubah a.txt', allowedPrompts: [{ prompt: 'jalankan tes' }] },
    { cwd: work, mode: 'plan', client, planRuntime: runtime },
  );
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'allow');
  assert.equal(r.mode, 'yolo');
  assert.equal(runtime.mode, 'yolo');
  assert.equal(runtime.active, false);
  assert.equal(runtime.approved, true);
  assert.match(r.text, /Rencana disetujui/);
  assert.match(r.text, /\.agenthub\/plans\/plan-thr-ok\.md/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].allowedPrompts[0].prompt, 'jalankan tes');
  assert.match(plan.readPlanFile({ cwd: work, threadId: 'thr-ok' }), /ubah a\.txt/);

  // Inti seluruh fitur: tool berikutnya di run yang sama memakai mode baru.
  // `mode` sengaja masih 'plan' di sini — nilai itulah yang dikirim loop saat
  // run dimulai, dan runtime yang harus menang.
  const write = await tools.executeTool('write_file', { path: 'hasil.txt', content: 'ok' }, {
    cwd: work, mode: 'plan', client, planRuntime: runtime,
  });
  assert.equal(write.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'hasil.txt'), 'utf8'), 'ok');
});

test('rencana ditolak: mode tidak berubah dan tulis berkas tetap ditolak', async () => {
  const runtime = { active: true, pre: 'yolo', mode: 'plan', threadId: 'thr-no', approved: false };
  const client = fakeClient({ decision: 'reject', reason: 'jangan sentuh b.txt' });
  const r = await tools.executeTool('ExitPlanMode', { plan: 'ubah b.txt' }, {
    cwd: work, mode: 'plan', client, planRuntime: runtime,
  });
  assert.equal(r.ok, false);
  assert.equal(r.decision, 'deny');
  assert.equal(r.error, 'REJECTED');
  assert.match(r.text, /jangan sentuh b\.txt/);
  assert.equal(runtime.mode, 'plan');
  assert.equal(runtime.approved, false);
  assert.equal(plan.planFileExists({ cwd: work, threadId: 'thr-no' }), false);

  const write = await tools.executeTool('write_file', { path: 'ditolak.txt', content: 'x' }, {
    cwd: work, mode: 'plan', client, planRuntime: runtime,
  });
  assert.equal(write.ok, false);
  assert.equal(write.decision, 'deny');
  assert.equal(fs.existsSync(path.join(work, 'ditolak.txt')), false);
});

test('tanpa klien persetujuan run tetap di plan, bukan menggantung', async () => {
  const runtime = { active: true, pre: 'build', mode: 'plan', threadId: 'thr-noclient' };
  const r = await tools.executeTool('ExitPlanMode', { plan: 'sesuatu' }, { cwd: work, mode: 'plan', planRuntime: runtime });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_CLIENT');
  assert.match(r.text, /tidak ada pengguna/i);
  assert.equal(runtime.mode, 'plan');
});

test('EnterPlanMode mencatat mode sebelumnya dan memaksa plan', async () => {
  const runtime = { active: false, pre: null, mode: 'guarded', threadId: 'thr-enter' };
  const r = await tools.executeTool('EnterPlanMode', {}, { cwd: work, mode: 'guarded', planRuntime: runtime });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'plan');
  assert.equal(r.previousMode, 'guarded');
  assert.equal(runtime.active, true);
  assert.equal(runtime.pre, 'guarded');
  assert.equal(runtime.mode, 'plan');

  // Masuk plan memang menutup tulisan: gerbang memakai runtime, bukan mode lama.
  const write = await tools.executeTool('write_file', { path: 'x.txt', content: 'x' }, {
    cwd: work, mode: 'guarded', planRuntime: runtime,
  });
  assert.equal(write.ok, false);
});

test('subagent tidak mewarisi askPlan, jadi tidak bisa menaikkan izinnya sendiri', async () => {
  const approvals = await import('../lib/approvals.js');
  const client = approvals.createClient({ threadId: 'thr-sub' });
  assert.equal(typeof client.askPlan, 'function');
  const child = client.forSubagent({ subagent: 'peneliti', agentId: 'a1' });
  assert.equal(child.askPlan, undefined);
  client.cancel('selesai');
});

test('buildPlanFile: ExitPlanMode tidak ditawarkan di luar plan, tapi EnterPlanMode tetap', async () => {
  const inPlan = await tools.toolDefinitions({ cwd: work, mode: 'plan' });
  const names = inPlan.map((d) => d.function?.name || d.name);
  assert.ok(names.includes('ExitPlanMode'));
  assert.ok(names.includes('EnterPlanMode'));
  // Plan mode hanya membaca: tool tulis tidak ditawarkan sama sekali, supaya
  // model tidak mencoba lalu ditolak berulang-ulang.
  assert.ok(!names.includes('write_file'));

  const outside = await tools.toolDefinitions({ cwd: work, mode: 'yolo' });
  const outNames = outside.map((d) => d.function?.name || d.name);
  assert.ok(outNames.includes('EnterPlanMode'));
  assert.ok(!outNames.includes('ExitPlanMode'));
  assert.ok(outNames.includes('write_file'));
});
