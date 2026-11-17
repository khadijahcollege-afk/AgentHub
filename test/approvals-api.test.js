// test/approvals-api.test.js — jalur persetujuan lewat server nyata.
//
// Yang dibuktikan di sini adalah janji yang paling mudah rusak tanpa terlihat:
// mode build benar-benar berhenti pada tool tulis, SSE membawa payload izin,
// jawaban lewat HTTP melanjutkan run yang sama, dan `AskUserQuestion` sampai ke
// model sebagai jawaban — bukan sebagai penolakan.
//
// Provider palsu memilih balasan dari ISI permintaan (bukan urutan panggilan),
// karena server juga memanggil /v1/models saat key ditambahkan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8310, 60);
const TOKEN = 'approvalapi0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let upstream;
let work;
let scenario = 'permission';

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const ASK_ARGS = {
  questions: [{
    question: 'Database apa yang dipakai?',
    header: 'Database',
    options: [
      { label: 'SQLite (Recommended)', description: 'nol konfigurasi, cukup satu berkas' },
      { label: 'Postgres', description: 'butuh server terpisah' },
    ],
  }],
};

const upstreamHandler = (req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (!String(req.url || '').includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'uji', object: 'model' }] }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const msgs = body.messages || [];
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    const toolMsgs = msgs.filter((m) => m.role === 'tool');

    let reply;
    if (scenario === 'permission') {
      reply = hasToolResult
        ? { content: 'Berkas sudah ditulis setelah izin diberikan.' }
        : {
          tool_calls: [{
            id: 'call_write',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'izin.txt', content: 'ditulis setelah izin' }) },
          }],
        };
    } else {
      // Pertanyaan: setelah hasil tool berisi jawaban, model menyimpulkan.
      reply = hasToolResult
        ? { content: `Model membaca jawaban: ${String(toolMsgs.at(-1)?.content || '').includes('SQLite') ? 'SQLite' : 'tidak jelas'}` }
        : { tool_calls: [{ id: 'call_ask', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify(ASK_ARGS) } }] };
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-approval', object: 'chat.completion', model: 'uji',
      choices: [{ index: 0, message: { role: 'assistant', ...reply }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }));
  });
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-appr-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-appr-work-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
    memoryEnabled: false,
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));

  upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  assert.equal(await waitUp(), true, `server harus hidup\n${bootLog.slice(-600)}`);

  const r = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({
      preset: 'custom', name: 'Uji', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      key: 'uji-1234567890', pool: true, poolModel: 'uji',
    }),
  });
  assert.equal(r.status, 200, await r.text());
});

test.after(async () => {
  try { child?.kill(); } catch { /* noop */ }
  try { upstream?.close(); } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 200));
  for (const d of [dataDir, work]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// Jalankan satu run dan kembalikan semua event SSE. `onEvent` dipanggil untuk
// setiap event supaya pengujian bisa menjawab permintaan di tengah stream.
async function runStream(threadId, body, onEvent) {
  const res = await api(`/api/threads/${threadId}/send`, { method: 'POST', body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`send ${res.status}: ${await res.text()}`);
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      events.push(ev);
      if (onEvent) await onEvent(ev);
    }
  }
  return events;
}

async function newThread() {
  return (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'pool', cwd: work }) })).json();
}

test('mode build berhenti di tool tulis sampai pengguna mengizinkan', async () => {
  scenario = 'permission';
  const t = await newThread();
  let approval = null;

  const events = await runStream(t.id, {
    prompt: 'Tulis sebuah berkas', cwd: work, permission: 'build', tools: true,
  }, async (ev) => {
    if (ev.type !== 'approval') return;
    approval = ev;
    // Permintaan harus tercatat sebagai menunggu, dan bisa dilihat ulang —
    // itulah yang dipakai UI setelah halaman di-refresh.
    const pending = await (await api(`/api/threads/${t.id}/approvals`)).json();
    assert.equal(pending.requests.length, 1);
    assert.equal(pending.requests[0].requestId, ev.requestId);
    const r = await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'allow' }),
    });
    assert.equal(r.status, 200, await r.text());
  });

  assert.ok(approval, 'SSE harus membawa permintaan izin');
  assert.equal(approval.kind, 'permission');
  assert.equal(approval.tool, 'write_file');
  assert.equal(approval.mode, 'build');
  assert.ok(approval.reason, 'kartu butuh alasan supaya pengguna tahu kenapa');
  assert.equal(approval.risk, 'medium');

  // Izin diberikan → tool benar-benar berjalan, bukan hanya "tidak ditolak".
  assert.equal(fs.existsSync(path.join(work, 'izin.txt')), true);
  assert.equal(fs.readFileSync(path.join(work, 'izin.txt'), 'utf8'), 'ditulis setelah izin');

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'run harus selesai setelah izin diberikan');

  // Permintaan yang sudah dijawab hilang dari daftar: kartu basi tidak boleh
  // muncul lagi saat halaman dimuat ulang.
  const after = await (await api(`/api/threads/${t.id}/approvals`)).json();
  assert.deepEqual(after.requests, []);
});

test('menolak izin membuat tool gagal, run tetap selesai', async () => {
  scenario = 'permission';
  const t = await newThread();
  fs.rmSync(path.join(work, 'izin.txt'), { force: true });
  let denied = null;

  const events = await runStream(t.id, {
    prompt: 'Tulis sebuah berkas', cwd: work, permission: 'build', tools: true,
  }, async (ev) => {
    if (ev.type !== 'approval') return;
    denied = ev;
    await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'deny', reason: 'tidak sekarang' }),
    });
  });

  assert.ok(denied);
  assert.equal(fs.existsSync(path.join(work, 'izin.txt')), false, 'penolakan tidak boleh menulis apa pun');
  assert.ok(events.find((e) => e.type === 'done'), 'penolakan bukan kegagalan run');
  // Model diberi tahu penolakannya, bukan dibiarkan menebak.
  const thread = await (await api(`/api/threads/${t.id}`)).json();
  const last = thread.messages.at(-1);
  const call = (last.tools || []).find((x) => x.name === 'write_file');
  assert.equal(call.ok, false);
});

test('AskUserQuestion sampai ke model sebagai jawaban pengguna', async () => {
  scenario = 'question';
  const t = await newThread();
  let asked = null;

  const events = await runStream(t.id, {
    prompt: 'Mulai proyek baru', cwd: work, permission: 'full', tools: true,
  }, async (ev) => {
    if (ev.type !== 'approval') return;
    asked = ev;
    await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST',
      body: JSON.stringify({
        decision: 'answered',
        answers: { 'Database apa yang dipakai?': 'SQLite (Recommended)' },
      }),
    });
  });

  assert.ok(asked, 'pertanyaan harus muncul di SSE');
  assert.equal(asked.kind, 'question');
  assert.equal(asked.questions.length, 1);
  assert.equal(asked.questions[0].header, 'Database');

  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  const thread = await (await api(`/api/threads/${t.id}`)).json();
  const last = thread.messages.at(-1);
  assert.match(last.content, /SQLite/, 'jawaban harus terbaca model');
});

test('AskUserQuestion tetap bertanya di yolo (tidak dilewati)', async () => {
  scenario = 'question';
  const t = await newThread();
  let count = 0;
  const events = await runStream(t.id, {
    prompt: 'Mulai proyek baru', cwd: work, permission: 'full', tools: true,
  }, async (ev) => {
    if (ev.type !== 'approval') return;
    count++;
    await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'reject', reason: 'lewati' }),
    });
  });
  assert.equal(count, 1, 'yolo tidak boleh melewati pertanyaan: tanpa manusia run hanya menunggu');
  assert.ok(events.find((e) => e.type === 'done'), 'melewati pertanyaan tidak menggagalkan run');
});

test('jawaban untuk permintaan thread lain ditolak', async () => {
  scenario = 'permission';
  const t = await newThread();
  const other = await newThread();
  let rejected = false;

  await runStream(t.id, { prompt: 'Tulis', cwd: work, permission: 'build', tools: true }, async (ev) => {
    if (ev.type !== 'approval' || rejected) return;
    rejected = true;
    const r = await api(`/api/threads/${other.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'allow' }),
    });
    assert.equal(r.status, 403, 'requestId harus terikat ke thread-nya');
    const bad = await (await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'mungkin' }),
    })).json();
    assert.equal(bad.code, 'BAD_DECISION');
    // Setelah kesalahan itu, jawaban yang sah tetap berhasil.
    await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'deny' }),
    });
  });
  assert.equal(rejected, true);
});

test('aturan "selalu di folder ini" tersimpan dan dipakai ulang', async () => {
  scenario = 'permission';
  const t = await newThread();
  let count = 0;

  await runStream(t.id, { prompt: 'Tulis', cwd: work, permission: 'build', tools: true }, async (ev) => {
    if (ev.type !== 'approval') return;
    count++;
    await api(`/api/threads/${t.id}/approvals/${ev.requestId}`, {
      method: 'POST', body: JSON.stringify({ decision: 'allow', always: true }),
    });
  });
  assert.equal(count, 1);

  const rules = await (await api('/api/permissions')).json();
  const bucket = Object.entries(rules.rules).find(([k]) => k.toLowerCase() === work.toLowerCase());
  assert.ok(bucket, 'aturan harus tersimpan per folder kerja');
  assert.equal(bucket[1].allow.write_file, true);

  // Run kedua di folder yang sama tidak bertanya lagi: itulah gunanya aturan.
  let second = 0;
  await runStream(t.id, { prompt: 'Tulis lagi', cwd: work, permission: 'build', tools: true }, async (ev) => {
    if (ev.type === 'approval') second++;
  });
  assert.equal(second, 0, 'izin yang diingat harus melewati kartu');

  const cleared = await (await api('/api/permissions', {
    method: 'DELETE', body: JSON.stringify({ cwd: work }),
  })).json();
  assert.equal(cleared.ok, true);
  const after = await (await api('/api/permissions')).json();
  assert.equal(Object.keys(after.rules).some((k) => k.toLowerCase() === work.toLowerCase()), false);
});

test('/stop melepas permintaan yang menunggu', async () => {
  scenario = 'permission';
  const t = await newThread();
  let released = null;

  // Run dihentikan saat kartunya tampil: tool harus dilepas, bukan menggantung
  // sampai batas waktu 3 menit.
  await runStream(t.id, { prompt: 'Tulis', cwd: work, permission: 'build', tools: true }, async (ev) => {
    if (ev.type !== 'approval' || released !== null) return;
    const r = await (await api(`/api/threads/${t.id}/stop`, { method: 'POST' })).json();
    released = r.released;
  });
  assert.equal(released, 1, 'permintaan yang menunggu harus dilepas oleh /stop');
  const pend = await (await api(`/api/threads/${t.id}/approvals`)).json();
  assert.deepEqual(pend.requests, []);
});
