// test/send-replay.test.js — idempotensi `/send` dan anggaran byte lewat HTTP.
//
// Yang dibuktikan: kiriman dengan `clientCommandId` yang sama TIDAK
// menghasilkan run kedua, dan thread besar bisa diminta dalam versi ringkas
// lalu isi lengkapnya diambil ulang per pesan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8700, 40);
const TOKEN = 'replaytok012345678';
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readEvents(res) {
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) buf += dec.decode(chunk, { stream: true });
  return buf;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-replay-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 999,
    agentCheckMinutes: 99999, keyCheckHours: 99999, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  const isWin = process.platform === 'win32';
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    isWin
      ? { id: 'echo', label: 'Echo', cmd: 'cmd', args: ['/c', 'echo', 'JAWAB:{prompt}'] }
      : { id: 'echo', label: 'Echo', cmd: 'sh', args: ['-c', 'echo "JAWAB:{prompt}"'] },
  ]));

  // Boot lewat helper: bila gagal, pesannya membawa keluaran server
  // (port terpakai, config rusak, import gagal) alih-alih "server harus hidup".
  const boot = await startTestServer({ root: ROOT, port: PORT, dataDir });
  child = boot.child;
  assert.equal(boot.alive, true, boot.failure());
});

test.after(async () => {
  // Menunggu `exit`, bukan sekadar mengirim sinyal: proses yang masih hidup
  // memegang port-nya, dan tes berikutnya bisa memilih port itu.
  await stopTestServer(child);
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* noop */ }
});

async function newThread(engine = 'echo') {
  return (await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine }),
  })).json()).id;
}

test('kirim ulang dengan id yang sama tidak menjalankan run kedua', async () => {
  const id = await newThread();
  const body = JSON.stringify({ prompt: 'sekali saja', engine: 'echo', clientCommandId: 'cmd-replay-1' });
  const first = await api(`/api/threads/${id}/send`, { method: 'POST', body });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') || '', /event-stream/);
  await readEvents(first);

  const before = await (await api(`/api/threads/${id}`)).json();
  const userCount = before.messages.filter((m) => m.role === 'user').length;
  assert.equal(userCount, 1);

  // Percobaan ulang: jaringan memutus balasan tadi, jadi klien mengirim lagi.
  const second = await api(`/api/threads/${id}/send`, { method: 'POST', body });
  assert.equal(second.status, 200);
  assert.match(second.headers.get('content-type') || '', /application\/json/);
  const dup = await second.json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.commandId, 'cmd-replay-1');
  assert.ok(dup.userMessageId, 'catatan menyebut pesan user mana yang menerima kiriman ini');

  const after = await (await api(`/api/threads/${id}`)).json();
  assert.equal(
    after.messages.filter((m) => m.role === 'user').length, 1,
    'kiriman kedua tidak boleh menambah pesan user',
  );
  assert.equal(
    after.messages.filter((m) => m.role === 'assistant').length, 1,
    'model tidak dipanggil dua kali',
  );
});

test('id yang sama di thread lain adalah kiriman berbeda', async () => {
  const a = await newThread();
  const b = await newThread();
  await readEvents(await api(`/api/threads/${a}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'di A', engine: 'echo', clientCommandId: 'cmd-shared-1' }),
  }));
  const r = await api(`/api/threads/${b}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'di B', engine: 'echo', clientCommandId: 'cmd-shared-1' }),
  });
  assert.match(r.headers.get('content-type') || '', /event-stream/, 'bukan duplikat, jadi run sungguhan');
  await readEvents(r);
});

test('id yang tidak sah diabaikan, bukan ditolak', async () => {
  const id = await newThread();
  const r = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'halo', engine: 'echo', clientCommandId: 'a b' }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /event-stream/, 'id cacat tidak boleh menghalangi kiriman');
  await readEvents(r);
});

test('thread besar bisa diminta ringkas lalu isi lengkapnya diambil ulang', async () => {
  const id = await newThread();
  const big = 'k'.repeat(120000);
  // Tulis langsung ke data: tujuannya menguji jalur baca, bukan jalur tulis run.
  const file = path.join(dataDir, 'threads.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = all.find((x) => x.id === id);
  t.messages = [
    { id: 'u1', role: 'user', content: 'lihat ini', ts: Date.now() },
    { id: 'a1', role: 'assistant', content: big, ts: Date.now() },
  ];
  fs.writeFileSync(file, JSON.stringify(all));

  const full = await (await api(`/api/threads/${id}`)).json();
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  assert.ok(fullBytes > 100000, 'thread penuh memang besar');

  const small = await (await api(`/api/threads/${id}?byteBudget=40000`)).json();
  const smallBytes = Buffer.byteLength(JSON.stringify(small), 'utf8');
  assert.ok(smallBytes < fullBytes / 2, `versi ringkas harus jauh lebih kecil (${smallBytes} vs ${fullBytes})`);
  assert.equal(small.byteBudgetApplied, true);
  assert.equal(small.bodyRefs.length, 1);
  assert.equal(small.messages[0].content, 'lihat ini', 'pesan user tidak dipotong');

  // Pratinjau ber-refId, dan isi lengkapnya bisa diambil kembali.
  assert.equal(small.messages[1].truncated, true);
  const ref = small.messages[1].refId;
  assert.equal(ref, 'm1');
  const body = await (await api(`/api/threads/${id}/message-body?refId=${ref}`)).json();
  assert.equal(body.content.length, big.length, 'isi lengkap dikembalikan utuh');
  assert.equal(body.hash, small.bodyRefs[0].hash, 'hash cocok: pratinjau memang bagian dari pesan ini');

  const missing = await api(`/api/threads/${id}/message-body?refId=m99`);
  assert.equal(missing.status, 404);
});

test('messageLimit membatasi jumlah pesan dan melaporkan sisanya', async () => {
  const id = await newThread();
  const file = path.join(dataDir, 'threads.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = all.find((x) => x.id === id);
  t.messages = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `pesan ${i}`, ts: Date.now(),
  }));
  fs.writeFileSync(file, JSON.stringify(all));

  const r = await (await api(`/api/threads/${id}?messageLimit=6`)).json();
  assert.equal(r.messages.length, 6);
  assert.equal(r.truncatedMessages, 34);
  assert.equal(r.messages.at(-1).content, 'pesan 39', 'yang tersisa adalah bagian akhir percakapan');
});
