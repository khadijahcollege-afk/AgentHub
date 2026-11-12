// test/run.test.js — uji siklus hidup run sungguhan (RUN_MACHINE).
// Menjalankan server + engine palsu berbasis `node -e` supaya tidak butuh CLI
// AI, jaringan, atau data user. Fokus: run selesai = `done`, run dihentikan =
// `stopped`, dan thread tidak tertinggal dalam status `running`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7990 + Math.floor(Math.random() * 90);
const TOKEN = 'runtoken0123456789';
let child;
let dataDir;

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Baca SSE sampai stream tutup, kembalikan daftar event.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-run-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 6,
    agentCheckMinutes: 15, keyCheckHours: 12, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  // Harness uji harus aman terhadap pembungkusan cmdline Windows (cmd.exe /c),
  // jadi pakai perintah shell sederhana, bukan `node -e` dengan tanda kutip.
  const isWin = process.platform === 'win32';
  const harnesses = isWin
    ? [
        { id: 'echo', label: 'Echo', cmd: 'cmd', args: ['/c', 'echo', 'ECHO:{prompt}'] },
        { id: 'slow', label: 'Slow', cmd: 'cmd', args: ['/c', 'ping', '-n', '30', '127.0.0.1'] },
        // harness palsu bernama engine asli: memperlihatkan flag mode izin
        // yang disisipkan lib/harness.js (lihat pemetaan permission).
        { id: 'claude', label: 'Claude (uji)', cmd: 'cmd', args: ['/c', 'echo', 'FLAGS:{prompt}'] },
        { id: 'codex', label: 'Codex (uji)', cmd: 'cmd', args: ['/c', 'echo', 'CODEX:{prompt}'] },
      ]
    : [
        { id: 'echo', label: 'Echo', cmd: 'sh', args: ['-c', 'echo "ECHO:{prompt}"'] },
        { id: 'slow', label: 'Slow', cmd: 'sleep', args: ['30'] },
        { id: 'claude', label: 'Claude (uji)', cmd: 'sh', args: ['-c', 'echo "FLAGS:{prompt}"'] },
        { id: 'codex', label: 'Codex (uji)', cmd: 'sh', args: ['-c', 'echo "CODEX:{prompt}"'] },
      ];
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify(harnesses));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('run: selesai normal mengirim delta lalu done, thread tidak running', async () => {
  const th = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'echo' }),
  })).json();
  const res = await api(`/api/threads/${th.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'halo mesin', engine: 'echo' }),
  });
  assert.equal(res.status, 200);
  const events = await readEvents(res);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('delta'), `harus ada delta: ${types}`);
  assert.equal(types.at(-1), 'done', `event terakhir harus done: ${types}`);
  assert.ok(events.filter((e) => e.type === 'delta').map((e) => e.text).join('').includes('halo mesin'));

  const t = await (await api(`/api/threads/${th.id}`)).json();
  assert.equal(t.running, false);
  assert.equal(t.runState, 'done');
  const last = t.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.ok(last.content.includes('ECHO:halo mesin'));

  // stop setelah selesai tidak boleh mengubah state akhir menjadi stopped
  const stop = await (await api(`/api/threads/${th.id}/stop`, { method: 'POST' })).json();
  assert.equal(stop.stopped, 0);
  const afterStop = await (await api(`/api/threads/${th.id}`)).json();
  assert.equal(afterStop.runState, 'done');
});

test('run: kiriman kedua ke thread yang sama ditolak 409 (bukan menumpuk)', async () => {
  const th = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'slow' }),
  })).json();
  const first = await api(`/api/threads/${th.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'pertama', engine: 'slow' }),
  });
  assert.equal(first.status, 200);
  await sleep(250);

  const second = await api(`/api/threads/${th.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'kedua', engine: 'echo' }),
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.code, 'RUN_IN_PROGRESS');

  await api(`/api/threads/${th.id}/stop`, { method: 'POST' });
  const events = await readEvents(first);
  assert.equal(events.at(-1).type, 'stopped');
  const t = await (await api(`/api/threads/${th.id}`)).json();
  assert.equal(t.runState, 'stopped');
  assert.equal(t.running, false);
});

test('run: stop di tengah jalan menghasilkan stopped dan melepas thread', async () => {
  const th = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'slow' }),
  })).json();
  const res = await api(`/api/threads/${th.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'lama', engine: 'slow' }),
  });
  assert.equal(res.status, 200);

  // thread harus terlihat running sebelum dihentikan
  await sleep(400);
  const running = await (await api('/api/status')).json();
  assert.ok(running.runningThreads.some((t) => t.id === th.id), 'thread harus tercatat running');

  const stop = await (await api(`/api/threads/${th.id}/stop`, { method: 'POST' })).json();
  assert.ok(stop.stopped >= 1, 'harus ada proses yang dihentikan');

  const events = await readEvents(res);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('stopped'), `harus ada event stopped: ${types}`);
  assert.equal(types.at(-1), 'stopped');

  const t = await (await api(`/api/threads/${th.id}`)).json();
  assert.equal(t.running, false);
  assert.equal(t.messages.at(-1).runStatus, 'stopped');

  const after = await (await api('/api/status')).json();
  assert.equal(after.runningThreads.some((x) => x.id === th.id), false);
});

test('run: engine tak dikenal gagal dengan error, bukan menggantung', async () => {
  const th = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'echo' }),
  })).json();
  const res = await api(`/api/threads/${th.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'x', engine: 'tidak-ada' }),
  });
  const events = await readEvents(res);
  assert.equal(events.at(-1).type, 'error');
  const t = await (await api(`/api/threads/${th.id}`)).json();
  assert.equal(t.running, false);
});

test('permission: flag CLI disisipkan sesuai tingkat izin', async () => {
  // claude (harness uji) + 'edits' → --permission-mode acceptEdits
  const th1 = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'claude' }),
  })).json();
  const r1 = await api(`/api/threads/${th1.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'uji', engine: 'claude', permission: 'edits' }),
  });
  const ev1 = await readEvents(r1);
  const out1 = ev1.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(out1, /--permission-mode acceptEdits/, `flag edits harus terlihat: ${out1.slice(0, 200)}`);

  // codex + 'ask' → --sandbox read-only
  const th2 = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'codex' }),
  })).json();
  const r2 = await api(`/api/threads/${th2.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'uji', engine: 'codex', permission: 'ask' }),
  });
  const ev2 = await readEvents(r2);
  const out2 = ev2.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(out2, /--sandbox read-only/, `flag ask codex harus terlihat: ${out2.slice(0, 200)}`);

  // full → tanpa flag tambahan
  const th3 = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'claude' }),
  })).json();
  const r3 = await api(`/api/threads/${th3.id}/send`, {
    method: 'POST', body: JSON.stringify({ prompt: 'uji', engine: 'claude', permission: 'full' }),
  });
  const ev3 = await readEvents(r3);
  const out3 = ev3.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.doesNotMatch(out3, /--permission-mode/, 'full tidak menyuntik flag');
});
