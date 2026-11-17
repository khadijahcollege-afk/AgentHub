// test/agent-loop.test.js — loop tool-calling end-to-end terhadap provider
// OpenAI-compatible lokal: model minta tool → server menjalankan → hasil dikirim
// balik → model menjawab. Juga menguji batas putaran dan pembatalan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-loop-'));
process.env.AGENTHUB_DATA = dataDir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-loop-work-'));
fs.writeFileSync(path.join(work, 'catatan.txt'), 'isi asli\n');

// Provider palsu: mengembalikan tool_calls pada permintaan pertama, lalu teks.
let calls = 0;
let lastBody = null;
let mode = 'tool';
// System prompt setiap permintaan: dipakai untuk membuktikan konteks awal run
// tidak hilang di putaran kedua.
const systemPrompts = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    lastBody = JSON.parse(raw || '{}');
    systemPrompts.push(String(lastBody.messages?.[0]?.content || ''));
    calls++;
    const reply = mode === 'spin'
      ? { tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'catatan.txt' }) } }] }
      : mode === 'planflow'
        // Alur rencana: masuk plan → ajukan rencana → (disetujui) tulis berkas
        // → jawab. Tiga panggilan tool berurutan dalam satu run.
        ? (calls === 1
          ? { tool_calls: [{ id: 'p1', type: 'function', function: { name: 'EnterPlanMode', arguments: '{}' } }] }
          : calls === 2
            ? { tool_calls: [{ id: 'p2', type: 'function', function: { name: 'ExitPlanMode', arguments: JSON.stringify({ plan: '## Rencana\n- tulis rencana.txt' }) } }] }
            : calls === 3
              ? { tool_calls: [{ id: 'p3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'rencana.txt', content: 'dari rencana' }) } }] }
              : { content: 'Rencana dijalankan.' })
        : calls === 1
        ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'catatan.txt' }) } }] }
        : { content: 'Berkas berisi: isi asli' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'uji-model',
      choices: [{ index: 0, message: { role: 'assistant', ...reply }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

fs.writeFileSync(path.join(dataDir, 'keys.json'), JSON.stringify([{
  id: 'aaaa1111bbbb2222',
  preset: 'custom',
  name: 'Uji lokal',
  baseUrl: `http://127.0.0.1:${port}`,
  key: 'kunci-uji',
  format: 'chat_completions',
  status: 'valid',
  pool: true,
  priority: 1,
  poolModel: 'uji-model',
  createdAt: Date.now(),
  stats: { req: 0, err: 0, lastUse: 0 },
}]));

const { runAgentLoop } = await import('../lib/agent-loop.js');

test.after(() => {
  server.close();
  for (const d of [dataDir, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

test('loop menjalankan tool lalu menjawab dengan hasilnya', async () => {
  calls = 0; mode = 'tool';
  const events = [];
  const deltas = [];
  const r = await runAgentLoop({
    prompt: 'Baca catatan.txt',
    cwd: work,
    mode: 'yolo',
    onEvent: (e) => events.push(e),
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r.text, 'Berkas berisi: isi asli');
  assert.equal(r.turns, 2);
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, 'read_file');
  assert.equal(r.tools[0].ok, true);
  assert.equal(r.tokens, 30, 'dua putaran × 15 token');
  assert.equal(r.model, 'uji-model');

  // tool dikirim ke model, dan hasil tool dikembalikan sebagai pesan `tool`
  assert.equal(Array.isArray(lastBody.tools), true);
  assert.equal(lastBody.tools.some((t) => t.function.name === 'read_file'), true);
  assert.equal(deltas.join(''), 'Berkas berisi: isi asli');

  const start = events.find((e) => e.type === 'tools');
  assert.deepEqual(start.names, ['read_file catatan.txt']);
  assert.equal(events.some((e) => e.type === 'tool_result' && e.ok === true), true);
});

test('mode plan menyembunyikan tool tulis dari model', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Apa isi folder?', cwd: work, mode: 'plan' });
  const names = lastBody.tools.map((t) => t.function.name);
  // `Agent` tetap ditawarkan di plan mode: ia sendiri tidak menulis apa pun,
  // dan anaknya mewarisi mode plan sehingga tool tulisnya juga tidak ada.
  // `AskUserQuestion` juga tetap ada: menyusun rencana justru saat pengguna
  // perlu ikut memilih arah, sebelum ada yang diubah.
  // `check_background_command` membaca berkas keluaran, dan
  // `stop_background_command` hanya mencabut izin — keduanya tidak memperluas
  // apa pun, dan tanpa yang kedua perintah latar yang dimulai sebelum masuk plan
  // tidak bisa dihentikan dari dalam plan.
  assert.deepEqual(names.sort(), [
    'Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
    'check_background_command', 'grep_files', 'list_files', 'read_file', 'stop_background_command',
  ]);
  assert.equal(names.includes('write_file'), false);
  assert.equal(names.includes('start_background_command'), false, 'memulai perintah bukan tindakan baca-saja');
});

test('tanpa folder kerja, hanya AskUserQuestion yang ditawarkan', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Halo', cwd: null, mode: 'yolo' });
  // Tool berkas tanpa folder kerja pasti gagal, jadi tidak ditawarkan. Bertanya
  // tetap masuk akal — justru itu cara paling wajar memutuskan folder mana yang
  // dipakai.
  assert.deepEqual(lastBody.tools.map((t) => t.function.name), ['AskUserQuestion']);
});

test('batas putaran menghentikan model yang berputar-putar', async () => {
  calls = 0; mode = 'spin';
  const r = await runAgentLoop({ prompt: 'Ulang terus', cwd: work, mode: 'yolo', maxTurns: 3 });
  assert.equal(r.turns, 3);
  assert.match(r.text, /Berhenti setelah 3 putaran/);
});

test('pembatalan menghentikan loop di tengah', async () => {
  calls = 0; mode = 'spin';
  const ctrl = new AbortController();
  const p = runAgentLoop({ prompt: 'Batal', cwd: work, mode: 'yolo', signal: ctrl.signal, maxTurns: 50 });
  // Batalkan setelah loop benar-benar berjalan, bukan setelah timer tetap:
  // provider lokal bisa menyelesaikan puluhan putaran lebih cepat dari 120 ms di
  // runner CI, sehingga abort datang setelah run selesai dan tes gagal dengan
  // "Missing expected rejection" — padahal pembatalan bekerja.
  const cancelling = (async () => {
    const t0 = Date.now();
    while (calls < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
  })();
  await assert.rejects(() => p, (e) => e.name === 'AbortError');
  await cancelling;
});

test('mode build menawarkan tool tulis/perintah, tetapi keputusannya ask', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Ubah berkas', cwd: work, mode: 'build' });
  const names = lastBody.tools.map((t) => t.function.name);
  // Dulu tool ini disembunyikan karena `ask` mustahil dijawab. Sekarang `ask`
  // benar-benar bertanya, jadi menyembunyikannya membuat agent tidak bisa
  // meminta izin dan pengguna tidak tahu apa yang sedang ditahan.
  assert.equal(names.includes('write_file'), true);
  assert.equal(names.includes('run_command'), true);
});

test('rencana disetujui di tengah run membuka tool tulis untuk sisa run itu', async () => {
  calls = 0; mode = 'planflow';
  const events = [];
  const asked = [];
  const planFile = path.join(work, '.agenthub', 'plans', 'plan-thr-loop.md');
  try { fs.rmSync(planFile, { force: true }); } catch { /* belum ada */ }

  const r = await runAgentLoop({
    prompt: 'Rencanakan lalu kerjakan',
    cwd: work,
    mode: 'yolo',
    threadId: 'thr-loop',
    onEvent: (e) => events.push(e),
    approvals: {
      askPlan: async ({ plan: text }) => { asked.push(text); return { decision: 'approve' }; },
    },
  });

  assert.equal(asked.length, 1);
  assert.match(asked[0], /tulis rencana\.txt/);
  // Mode akhir dilaporkan: run ini masuk plan lalu keluar, dan server memakai
  // nilai itu untuk menyimpan mode thread.
  assert.equal(r.planMode, 'yolo');
  assert.equal(r.planApproved, true);
  // Perubahan mode dilaporkan ke UI supaya chip akses tidak berbohong.
  const modeEvent = events.find((e) => e.type === 'mode');
  assert.equal(modeEvent?.mode, 'plan');
  // Inti: berkas benar-benar tertulis SESUDAH persetujuan, di run yang sama.
  assert.equal(fs.readFileSync(path.join(work, 'rencana.txt'), 'utf8'), 'dari rencana');
  // Dan rencananya tersimpan di folder kerja, bukan hanya di percakapan.
  assert.match(fs.readFileSync(planFile, 'utf8'), /tulis rencana\.txt/);
});

test('rencana ditolak di tengah run: tulis berkas tetap ditolak', async () => {
  calls = 0; mode = 'planflow';
  const r = await runAgentLoop({
    prompt: 'Rencanakan',
    cwd: work,
    mode: 'build',
    threadId: 'thr-loop-no',
    maxTurns: 6,
    approvals: { askPlan: async () => ({ decision: 'reject', reason: 'belum perlu' }) },
  });
  assert.equal(r.planApproved, false);
  assert.equal(r.planMode, 'plan');
  // Berkas dari tes sebelumnya ada di folder kerja yang sama: hapus dulu, kalau
  // tidak pemeriksaan "tidak tertulis" lolos karena sisa run lain.
  try { fs.rmSync(path.join(work, 'rencana.txt'), { force: true }); } catch { /* belum ada */ }
  assert.equal(fs.existsSync(path.join(work, 'rencana.txt')), false);
  const writeAttempt = r.tools.find((t) => t.name === 'write_file');
  assert.equal(writeAttempt?.ok, false);
});

test('konteks SessionStart bertahan di putaran kedua, bukan hanya yang pertama', async () => {
  // Regresi: konteks hook dulu ditambahkan langsung ke `messages[0].content`.
  // System prompt disusun ulang setiap putaran (mode bisa berubah di tengah
  // run), jadi pada putaran kedua konteks itu hilang tanpa jejak — model
  // kehilangan instruksi yang justru diberikan di awal run.
  const hookScript = path.join(dataDir, 'hook-start.mjs');
  fs.writeFileSync(hookScript, `
    let raw = '';
    for await (const c of process.stdin) raw += c;
    const event = JSON.parse(raw || '{}');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: 'pakai pnpm, jangan npm' },
    }));
  `);
  const hookFile = path.join(dataDir, 'hooks.json');
  fs.writeFileSync(hookFile, JSON.stringify({
    enabled: true,
    events: { SessionStart: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath, args: [hookScript] }] }] },
  }));
  try {
    calls = 0; mode = 'tool';
    systemPrompts.length = 0;
    await runAgentLoop({ prompt: 'Baca catatan.txt', cwd: work, mode: 'yolo' });
  } finally {
    fs.rmSync(hookFile, { force: true });
  }
  // Dua permintaan: satu yang memanggil tool, satu yang menjawab.
  assert.equal(calls, 2);
  assert.equal(systemPrompts.length, 2);
  assert.match(systemPrompts[0], /pakai pnpm, jangan npm/, 'konteks ada di putaran pertama');
  assert.match(systemPrompts[1], /pakai pnpm, jangan npm/, 'konteks masih ada saat model menjawab');
});

test('mode yolo menawarkan semua tool bawaan', async () => {
  calls = 0; mode = 'tool';
  await runAgentLoop({ prompt: 'Kerjakan', cwd: work, mode: 'yolo' });
  const names = lastBody.tools.map((t) => t.function.name);
  for (const n of ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_files', 'run_command']) {
    assert.equal(names.includes(n), true, n);
  }
});
