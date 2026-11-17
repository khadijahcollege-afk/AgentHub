// test/freerot.test.js — Free Auto: tangga rotasi model gratis.
// Unit: ladder, cooldown, deteksi limit. Server: engine free-auto memutar
// model saat yang pertama kena limit — tanpa sentuhan pengguna.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladder, markFail, looksLimited, cooling, _setState } from '../lib/freerot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9030 + Math.floor(Math.random() * 30);
const TOKEN = 'freerottok012345678';
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
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const SAVED_DATA = process.env.AGENTHUB_DATA;
test('freerot unit: ladder urut gagal, cooling dilewati, deteksi limit', () => {
  _setState({}); // unit test murni memori — jangan sentuh freerot.json live
  process.env.AGENTHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rot-'));
  try {
    const engines = [
      { id: 'opencode-free-glm-flash-free', label: 'GLM Flash', available: true },
      { id: 'opencode-free-nemotron-free', label: 'Nemotron', available: true },
      { id: 'opencode-free', label: 'induk', available: true },
      { id: 'free-auto', label: 'virtual', available: true },
    ];
    let l = ladder(engines);
    assert.equal(l.ok.length, 2, 'induk & virtual bukan kandidat');
    assert.ok(l.cooling.length === 0);

    markFail('opencode-free-glm-flash-free', 'limit');
    assert.equal(cooling('opencode-free-glm-flash-free'), true, 'cooldown aktif');
    l = ladder(engines);
    assert.equal(l.ok.length, 1);
    assert.equal(l.cooling.length, 1, 'engine kena limit masuk cooling');
    assert.equal(l.cooling[0].id, 'opencode-free-glm-flash-free');

    assert.equal(looksLimited('rate limit exceeded for key'), true);
    assert.equal(looksLimited('quota habis'), true);
    assert.equal(looksLimited('jawaban normal dari model'), false);
    assert.equal(looksLimited(''), false);
  } finally {
    fs.rmSync(process.env.AGENTHUB_DATA, { recursive: true, force: true });
    if (SAVED_DATA === undefined) delete process.env.AGENTHUB_DATA; else process.env.AGENTHUB_DATA = SAVED_DATA;
  }
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rot-srv-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  // Dua engine gratis palsu: AA selalu "kena limit", BB jawab sukses.
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'opencode-free-aa-free', label: 'AA (limit)', type: 'cli', cmd: 'cmd', args: ['/c', 'echo', 'rate limit exceeded for this key'] },
    { id: 'opencode-free-bb-free', label: 'BB (oke)', type: 'cli', cmd: 'cmd', args: ['/c', 'echo', 'jawaban dari BB'] },
  ]));
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

test('free-auto: AA kena limit -> otomatis pindah ke BB', async () => {
  // engine virtual terdaftar di /api/engines
  const engines = await (await api('/api/engines')).json();
  const fa = engines.find((e) => e.id === 'free-auto');
  assert.ok(fa, 'engine free-auto terdaftar');
  assert.equal(fa.available, true, 'tersedia bila ada engine gratis');

  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Uji rotasi', engine: 'free-auto' }) })).json();
  assert.ok(t.id);
  const s = await api(`/api/threads/${t.id}/send`, { method: 'POST', body: JSON.stringify({ prompt: 'halo' }) });
  assert.ok(s.ok, 'send sukses');
  // tunggu run selesai
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const th = await (await api(`/api/threads/${t.id}`)).json();
    if (th.messages?.some((x) => x.role === 'assistant')) { th._done = true; break; }
  }
  const th = await (await api(`/api/threads/${t.id}`)).json();
  const replies = th.messages.filter((x) => x.role === 'assistant');
  assert.ok(replies.length >= 1, 'ada balasan');
  const last = replies[replies.length - 1];
  assert.match(last.content || '', /jawaban dari BB/, 'jawaban datang dari engine BB (bukan AA)');
  assert.equal(last.engine, 'opencode-free-bb-free', 'engine asli tercatat jujur');
  assert.equal(th.runState, 'done', 'run selesai');
});
