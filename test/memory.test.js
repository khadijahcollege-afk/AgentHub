// test/memory.test.js — memori jangka panjang: CRUD, dedup, batas, dan
// penyuntikan konteks ke prompt di /send (server-side).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMemory, clearMemory, memoryContext, sanitizeFact } from '../lib/memory.js';
import { pickFreePort } from './helpers/port.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8780, 40);
const TOKEN = 'memorytok012345678';
let child;
let dataDir;

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

// Unit murni (tanpa server): sanitize & bentuk konteks kosong
test('memory unit: sanitize, dedup case-insensitive, konteks kosong', () => {
  assert.equal(sanitizeFact('  halo   dunia  \n'), 'halo dunia');
  assert.equal(sanitizeFact('x'.repeat(600)).length, 500);
  assert.equal(sanitizeFact(null), '');
  assert.equal(typeof memoryContext(), 'string');
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mem-srv-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  // harness echo ditulis SEBELUM boot: daftar engine dibaca server saat start
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'echo', label: 'Echo', type: 'cli', cmd: 'cmd', args: ['/c', 'echo', 'ECHO:{prompt}'] },
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

test('memory API: tambah, list, dedup 409-style update, hapus, clear', async () => {
  // kosong di awal
  assert.equal((await (await api('/api/memory')).json()).length, 0);

  const f1 = await (await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: '  User   suka kopi   tubruk  ' }) })).json();
  assert.equal(f1.text, 'User suka kopi tubruk');
  assert.equal(f1.source, 'manual');

  // duplikat (beda kapital/whitespace) tidak menambah entri baru
  const dup = await (await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: 'user suka KOPI tubruk' }) })).json();
  assert.equal(dup.id, f1.id);
  assert.equal((await (await api('/api/memory')).json()).length, 1);

  // kosong ditolak
  assert.equal((await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: '   ' }) })).status, 400);
  // 401 tanpa token
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/memory`)).status, 401);
  // hapus id tak dikenal
  assert.equal((await api('/api/memory/ffffffffffffffffffffffffffffffff', { method: 'DELETE' })).status, 404);

  const f2 = await (await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: 'Repo utama di Documents/Agent/AgentHub', source: 'chat' }) })).json();
  const list = await (await api('/api/memory')).json();
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt >= list[1].createdAt, 'urut terbaru dulu');

  assert.equal((await api(`/api/memory/${f2.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await api('/api/memory')).json()).length, 1);

  assert.equal((await api('/api/memory/clear', { method: 'POST' })).status, 200);
  assert.equal((await (await api('/api/memory')).json()).length, 0);
});

test('memory: toggle settings + suntingan konteks terlihat di alur kirim', async () => {
  // simpan fakta lalu kirim pesan via /send ke harness echo palsu
  await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: 'Nama panggilan user: Kinan' }) });

  // tunggu run selesai (assistant muncul), apa pun state akhirnya
  const waitAssistant = async (threadId, atLeast) => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const t = await (await api(`/api/threads/${threadId}`)).json();
      if ((t.messages?.filter((x) => x.role === 'assistant').length || 0) >= atLeast) return t;
    }
    return await (await api(`/api/threads/${threadId}`)).json();
  };

  const thread = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Uji memori', engine: 'echo' }) })).json();
  assert.ok(thread.id);

  // nonaktifkan memori → prompt tanpa blok memori
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ memoryEnabled: false }) })).status, 200);
  const off = await api(`/api/threads/${thread.id}/send`, { method: 'POST', body: JSON.stringify({ prompt: 'hai' }) });
  assert.ok(off.ok, 'send harus sukses');
  await waitAssistant(thread.id, 1);
  let t = await (await api(`/api/threads/${thread.id}`)).json();
  const userOff = t.messages.find((x) => x.role === 'user');
  assert.ok(!userOff.modelContent?.includes('Memori pengguna'), 'memori nonaktif tidak boleh disuntik');
  assert.ok(!userOff.modelContent?.includes('Kinan'), 'tidak ada kebocoran fakta saat off');

  // aktifkan → prompt berisi blok memori, tapi pesan user tetap bersih
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ memoryEnabled: true }) })).status, 200);
  const on = await api(`/api/threads/${thread.id}/send`, { method: 'POST', body: JSON.stringify({ prompt: 'siapa saya' }) });
  assert.ok(on.ok);
  await waitAssistant(thread.id, 2);
  t = await (await api(`/api/threads/${thread.id}`)).json();
  const userOn = t.messages.filter((x) => x.role === 'user')[1];
  assert.ok(userOn.modelContent?.includes('Memori pengguna'), 'blok memori disuntik ke prompt engine');
  assert.ok(userOn.modelContent?.includes('Kinan'), 'fakta ada di prompt engine');
  assert.equal(userOn.content, 'siapa saya', 'pesan yang terlihat user tetap bersih');

  // toggle juga terlihat di /api/state
  const state = await (await api('/api/state')).json();
  assert.equal(state.config.memoryEnabled, true);
  assert.ok(Array.isArray(state.memory), 'state membawa daftar memori');
});
