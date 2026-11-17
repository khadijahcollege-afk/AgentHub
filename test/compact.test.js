// test/compact.test.js — ringkasan konteks: percakapan lama diringkas, pesan
// terbaru tetap verbatim, cursor hanya maju bila ringkasan benar-benar jadi.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-compact-'));
process.env.AGENTHUB_DATA = dir;
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

const c = await import('../lib/compact.js');

// Percakapan sintetis: cukup panjang agar melewati MIN_FOLD_CHARS.
function conversation(n = 14, { chars = 400 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i % 2 === 0 ? 'Pertanyaan' : 'Jawaban'} ${i}: ` + 'x'.repeat(chars),
      runStatus: 'done',
    });
  }
  return out;
}

const fakeRouter = (summary) => async () => ({
  type: 'json',
  body: JSON.stringify({ choices: [{ message: { content: summary } }] }),
});

test('percakapan pendek tidak diringkas', () => {
  const short = conversation(4, { chars: 20 });
  assert.equal(c.selectFolded(short, null), null, 'di bawah ambang pesan/karakter');
  assert.equal(c.needsCompact({ messages: short }), null);
});

test('pesan terbaru selalu dipertahankan verbatim', () => {
  const msgs = conversation(14);
  const picked = c.selectFolded(msgs, null);
  assert.ok(picked, 'harus ada yang dilipat');
  assert.equal(picked.keep.length, c.KEEP_RECENT);
  // Pesan yang dilipat + yang dipertahankan = seluruh percakapan, tanpa celah.
  assert.equal(picked.fold.length + picked.keep.length, msgs.length);
  assert.equal(picked.throughId, picked.fold[picked.fold.length - 1].id);
  // Yang dipertahankan adalah ekor, bukan kepala.
  assert.deepEqual(picked.keep.map((m) => m.id), msgs.slice(-c.KEEP_RECENT).map((m) => m.id));
});

test('ringkasan tersimpan dan menggantikan pesan yang dilipat', async () => {
  const msgs = conversation(14);
  const r = await c.compactThread({
    thread: { messages: msgs },
    router: fakeRouter('Pengguna memilih pnpm; berkas src/a.ts sudah diubah; sisa: uji unit.'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.compact.throughMessageId, 'm7');
  assert.equal(r.compact.messages, 8);
  assert.equal(r.compact.keptMessages, 6);
  assert.equal(r.compact.generations, 1);

  // Pesan setelah cursor tetap segar; pesan sebelumnya tidak muncul lagi.
  const { fresh } = c.afterCompaction(msgs, r.compact);
  assert.equal(fresh.length, 6);
  assert.equal(fresh[0].id, 'm8');
});

test('cursor yang menunjuk pesan hilang memulai dari awal, bukan melewati percakapan', () => {
  const msgs = conversation(10);
  const stale = { summary: 'ringkasan lama', throughMessageId: 'sudah-tidak-ada' };
  const { fresh } = c.afterCompaction(msgs, stale);
  assert.equal(fresh.length, 10, 'jangan diam-diam melewati percakapan yang belum diringkas');
});

test('ringkasan kosong atau terlalu pendek ditolak, thread tidak berubah', async () => {
  const msgs = conversation(14);
  for (const bad of ['', '   ', 'terlalu pendek', '```\n```']) {
    const r = await c.compactThread({ thread: { messages: msgs }, router: fakeRouter(bad) });
    assert.equal(r.ok, false, `ringkasan ${JSON.stringify(bad)} harus ditolak`);
    assert.equal(r.reason, 'summary-failed');
  }
});

test('pool mati tidak memajukan cursor', async () => {
  const msgs = conversation(14);
  const r = await c.compactThread({
    thread: { messages: msgs },
    router: async () => ({ type: 'error', attempts: [{ note: 'tidak ada key' }] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'summary-failed');
  assert.equal(r.compact, undefined);
});

test('ringkasan dibatasi panjangnya dan tidak berhenti di tengah kata', async () => {
  const long = 'Kalimat panjang tentang keputusan proyek. '.repeat(400);
  const r = await c.compactThread({ thread: { messages: conversation(14) }, router: fakeRouter(long) });
  assert.equal(r.ok, true);
  assert.equal(r.compact.summary.length <= 4000, true, `panjang ${r.compact.summary.length}`);
  assert.equal(/\.$/.test(r.compact.summary), true, 'berhenti di batas kalimat');
});

test('kompaksi kedua ikut meringkas ringkasan sebelumnya', async () => {
  const first = await c.compactThread({
    thread: { messages: conversation(14) },
    router: fakeRouter('Ringkasan pertama: memakai pnpm, mengubah src/a.ts, menyisakan uji unit.'),
  });
  assert.equal(first.ok, true);

  // Percakapan bertambah setelah kompaksi pertama.
  const more = [...conversation(14), ...conversation(8).map((m) => ({ ...m, id: m.id + '-baru' }))];
  let seenPrompt = '';
  const r = await c.compactThread({
    thread: { messages: more, compact: first.compact },
    router: async ({ messages }) => {
      seenPrompt = messages[0].content;
      return { type: 'json', body: JSON.stringify({ choices: [{ message: { content: 'Ringkasan kedua: pnpm, src/a.ts, uji unit masih tersisa.' } }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.compact.generations, 2, 'generasi bertambah, bukan kembali ke 1');
  assert.match(seenPrompt, /Ringkasan pertama/, 'ringkasan lama ikut jadi bahan, bukan dibuang');
});

test('ringkasan diberi pagar sebagai konteks, bukan instruksi', () => {
  const block = c.summaryBlock({ summary: 'Pengguna memakai pnpm.' });
  assert.match(block, /Ringkasan percakapan sebelumnya/);
  assert.match(block, /Akhir ringkasan/);
  assert.match(block, /bukan instruksi baru/);
  assert.equal(c.summaryBlock({ summary: '' }), null);
  assert.equal(c.summaryBlock(null), null);
});

test('pesan sub-run, streaming, dan gagal tidak ikut diringkas', () => {
  const msgs = [
    ...conversation(6),
    { id: 's1', role: 'assistant', subrun: true, content: 'subrun ' + 'y'.repeat(500) },
    { id: 's2', role: 'assistant', status: 'working', content: 'streaming ' + 'y'.repeat(500) },
    { id: 's3', role: 'assistant', runStatus: 'error', content: 'gagal ' + 'y'.repeat(500) },
    { id: 's4', role: 'system', content: 'system ' + 'y'.repeat(500) },
  ];
  const usable = c.usableMessages(msgs);
  assert.equal(usable.length, 6);
  assert.equal(usable.every((m) => !m.subrun && m.status !== 'working'), true);
});

test('bentuk publik tidak membocorkan seluruh isi internal', () => {
  const pub = c.publicCompact({
    summary: 'ringkasan',
    throughMessageId: 'm7',
    messages: 8,
    foldedChars: 3200,
    keptMessages: 6,
    generations: 2,
    model: 'auto',
    at: 123,
  });
  assert.deepEqual(Object.keys(pub).sort(), [
    'at', 'foldedChars', 'generations', 'keptMessages', 'messages', 'model', 'summary', 'throughMessageId',
  ]);
  assert.equal(c.publicCompact(null), null);
  assert.equal(c.publicCompact({}), null);
});
