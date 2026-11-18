// test/queue-api.test.js — antrean lewat HTTP: kirim saat run berjalan masuk
// antrean (bukan 409), dan antrean itu benar-benar DIJALANKAN sendiri setelah
// run sebelumnya selesai.
//
// Ini bagian yang paling mudah "tampak benar tetapi tidak": antrean yang tidak
// pernah dikuras terlihat sempurna di UI sampai pengguna menyadari pesannya
// tidak pernah dijawab. Karena itu tes ini menunggu run kedua benar-benar
// menghasilkan balasan assistant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8620, 40);
const TOKEN = 'queuetok012345678';
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

const api = (p, opts = {}) => fetch(BASE + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function readEvents(res) {
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* abaikan */ } }
    }
  }
  return events;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-queue-api-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 999,
    agentCheckMinutes: 99999, keyCheckHours: 99999, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  // Dua harness: satu lambat (menahan run pertama), satu cepat (menjawab
  // pesan antrean sehingga hasilnya bisa dibuktikan).
  const isWin = process.platform === 'win32';
  const harnesses = isWin
    ? [
        { id: 'slow', label: 'Slow', cmd: 'cmd', args: ['/c', 'ping', '-n', '6', '127.0.0.1'] },
        { id: 'echo', label: 'Echo', cmd: 'cmd', args: ['/c', 'echo', 'JAWAB:{prompt}'] },
      ]
    : [
        { id: 'slow', label: 'Slow', cmd: 'sleep', args: ['4'] },
        { id: 'echo', label: 'Echo', cmd: 'sh', args: ['-c', 'echo "JAWAB:{prompt}"'] },
      ];
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify(harnesses));

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
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine }),
  })).json();
  return t.id;
}

test('antrean: kirim saat run berjalan masuk antrean, bukan 409', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'pertama', engine: 'slow' }),
  });
  assert.equal(first.status, 200);

  const enq = await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'kedua', engine: 'echo' }),
  });
  assert.equal(enq.status, 201);
  const body = await enq.json();
  assert.equal(body.count, 1);
  assert.equal(body.item.prompt, 'kedua');

  const list = await (await api(`/api/threads/${id}/queue`)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.limit, 20, 'batas antrean dilaporkan ke klien');
  assert.equal(list.items[0].prompt, 'kedua');

  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);
});

test('antrean: item dijalankan otomatis setelah run sebelumnya selesai', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'pertama', engine: 'slow' }),
  });
  assert.equal(first.status, 200);

  // Pesan yang menunggu TIDAK boleh menghilang dari antrean sebelum run-nya
  // benar-benar mulai.
  await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'lanjutan', engine: 'echo' }),
  });

  // Hentikan run pertama: penguras harus jalan dari jalur `stopped`, bukan
  // hanya dari jalur sukses.
  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);

  const answered = await waitFor(async () => {
    const t = await (await api(`/api/threads/${id}`)).json();
    const hit = (t.messages || []).find((m) => m.role === 'assistant' && /JAWAB:lanjutan/.test(m.content || ''));
    return hit ? t : null;
  }, 20000);
  assert.ok(answered, 'pesan antrean harus dijalankan dan dijawab');
  assert.equal(answered.runState, 'done', 'run antrean berakhir normal');

  const left = await (await api(`/api/threads/${id}/queue`)).json();
  assert.equal(left.items.length, 0, 'item hilang dari antrean setelah run-nya mulai');
});

test('antrean: FIFO — dua item dijalankan berurutan', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'awal', engine: 'slow' }),
  });
  await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'satu', engine: 'echo' }),
  });
  await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'dua', engine: 'echo' }),
  });

  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);

  const done = await waitFor(async () => {
    const t = await (await api(`/api/threads/${id}`)).json();
    const msgs = (t.messages || []).filter((m) => m.role === 'assistant');
    return msgs.some((m) => /JAWAB:dua/.test(m.content || '')) ? msgs : null;
  }, 30000);
  assert.ok(done, 'item kedua juga dijalankan');

  const text = done.map((m) => m.content || '').join('\n');
  assert.ok(text.indexOf('JAWAB:satu') < text.indexOf('JAWAB:dua'), 'urutan FIFO dipertahankan');
});

test('antrean: reserve ditolak saat run berjalan', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'kerja', engine: 'slow' }),
  });
  await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'menunggu', engine: 'echo' }),
  });

  const r = await api(`/api/threads/${id}/queue/reserve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 409);
  const b = await r.json();
  assert.equal(b.code, 'RUN_IN_PROGRESS', 'dua run sekaligus tidak pernah boleh terjadi');

  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);
});

test('antrean: hapus item dan kosongkan antrean', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'tahan', engine: 'slow' }),
  });

  const a = await (await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'buang aku', engine: 'echo' }),
  })).json();
  await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'sisakan', engine: 'echo' }),
  });

  const del = await api(`/api/threads/${id}/queue/${a.item.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await (await api(`/api/threads/${id}/queue`)).json();
  assert.deepEqual(after.items.map((x) => x.prompt), ['sisakan']);

  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);
});

test('antrean: lampiran tak dikenal ditolak sebelum masuk antrean', async () => {
  const id = await newThread('echo');
  const r = await api(`/api/threads/${id}/queue`, {
    method: 'POST', body: JSON.stringify({ prompt: 'x', attachments: ['tidakada'] }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'ATTACHMENT_INVALID');
});

test('antrean: clientCommandId yang sama tidak menumpuk item', async () => {
  const id = await newThread('slow');
  const first = await api(`/api/threads/${id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'tahan', engine: 'slow' }),
  });
  const body = JSON.stringify({ prompt: 'sekali', engine: 'echo', clientCommandId: 'cmd-api-0001' });
  const a = await api(`/api/threads/${id}/queue`, { method: 'POST', body });
  const b = await api(`/api/threads/${id}/queue`, { method: 'POST', body });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200, 'pengulangan dijawab 200, bukan dibuat baru');
  const jb = await b.json();
  assert.equal(jb.duplicate, true);
  assert.equal(jb.count, 1);

  await api(`/api/threads/${id}/stop`, { method: 'POST' });
  await readEvents(first);
});
