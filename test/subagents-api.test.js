// test/subagents-api.test.js — subagent lewat server nyata: SSE harus membawa
// event `subagent` (start/end) dan menandai tool anak, supaya UI bisa
// menggambar barisnya. Provider OpenAI-compatible palsu memutuskan bentuk
// balasan dari isi permintaan (bukan urutan), karena server juga memanggil
// /v1/models saat key ditambahkan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { removeDir, startTestServer, stopTestServer } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await pickFreePort(8260, 40);
const TOKEN = 'subapi0123456789';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let upstream;
let work;
const seen = [];

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

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
    const system = String(body.messages?.[0]?.content || '');
    const isChild = /Kamu subagent/.test(system);
    const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
    seen.push({
      child: isChild,
      tools: (body.tools || []).map((t) => t.function?.name),
      system,
    });
    const reply = isChild
      ? (hasToolResult
        ? { content: 'Laporan anak: catatan.txt ada di folder kerja.' }
        : {
          // Anak benar-benar memakai tool: itu yang membuat event tool bertanda
          // `subagent` bisa diperiksa di SSE.
          tool_calls: [{
            id: 'call_child_read',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'catatan.txt' }) },
          }],
        })
      : !hasToolResult
        ? {
          tool_calls: [{
            id: 'call_agent_api',
            type: 'function',
            function: {
              name: 'Agent',
              arguments: JSON.stringify({
                description: 'periksa folder',
                prompt: 'Baca catatan.txt lalu laporkan isinya.',
                subagent_type: 'Explore',
              }),
            },
          }],
        }
        : { content: 'Selesai memakai subagent.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-subapi', object: 'chat.completion', model: 'uji',
      choices: [{ index: 0, message: { role: 'assistant', ...reply }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }));
  });
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-subapi-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-subapi-work-'));
  fs.writeFileSync(path.join(work, 'catatan.txt'), 'isi asli\n');
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

  // Lewat helper, bukan `spawn` langsung: berkas ini pernah mati ~100 ms tanpa
  // sebab yang terlihat. Helper menyimpan keluaran server dan menyebut
  // penyebabnya (port terpakai, crash setelah boot, modul gagal dimuat).
  const started = await startTestServer({ root: ROOT, port: PORT, dataDir });
  child = started.child;
  assert.equal(started.alive, true, started.failure());

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
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  try { upstream?.close(); } catch { /* noop */ }
  for (const d of [dataDir, work]) {
    if (d) removeDir(d);
  }
});

test('SSE membawa event subagent dan tool anak ditandai', async () => {
  const t = await (await api('/api/threads', {
    method: 'POST', body: JSON.stringify({ engine: 'pool', cwd: work }),
  })).json();

  const res = await api(`/api/threads/${t.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Periksa folder kerja', cwd: work, permission: 'full', tools: true }),
  });
  // Jangan membaca body sebelum stream dibaca: `res.text()` pada pesan assert
  // dievaluasi lebih dulu dan mengunci ReadableStream-nya.
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
      try { events.push(JSON.parse(line.slice(6))); } catch { /* abaikan */ }
    }
  }

  const lifecycle = events.filter((e) => e.type === 'subagent');
  assert.deepEqual(lifecycle.map((e) => e.phase), ['start', 'end'], JSON.stringify(events.map((e) => e.type)));
  const start = lifecycle[0];
  assert.equal(start.agentType, 'Explore');
  assert.equal(start.description, 'periksa folder');
  assert.ok(start.agentId, 'agentId harus ada supaya UI bisa mencocokkan baris');
  const end = lifecycle[1];
  assert.equal(end.ok, true);
  assert.equal(end.agentId, start.agentId);
  assert.equal(typeof end.ms, 'number');

  // Anak tidak pernah ditawari `Agent`: rekursi tertutup di jalur nyata juga.
  const childReq = seen.find((s) => s.child);
  assert.ok(childReq, 'anak harus memanggil model');
  assert.equal(childReq.tools.includes('Agent'), false);
  assert.deepEqual(childReq.tools.sort(), ['grep_files', 'list_files', 'read_file']);

  // Chip tool untuk tool anak membawa nama agent: tanpa itu UI menampilkan
  // "read_file" seolah-olah induk yang membacanya.
  const childTools = events.filter((e) => e.type === 'tool' && e.subagent);
  assert.equal(childTools.length > 0, true, 'anak memanggil tool, jadi harus ada event tool bertanda');
  assert.equal(childTools.every((e) => e.subagent === 'Explore' && e.agentId === start.agentId), true);

  // Jejak pesan menyimpan pemanggilan Agent beserta metanya, sehingga riwayat
  // tetap bisa menjelaskan apa yang terjadi setelah run selesai.
  const thread = await (await api(`/api/threads/${t.id}`)).json();
  const last = thread.messages.at(-1);
  assert.equal(last.content, 'Selesai memakai subagent.');
  const agentCall = (last.tools || []).find((x) => x.name === 'Agent');
  assert.ok(agentCall, 'tools pesan harus memuat Agent');
  assert.equal(agentCall.ok, true);
});

test('subagent_type tak dikenal dilaporkan ke model, bukan menggagalkan run', async () => {
  // Lewat modul langsung: provider palsu di atas selalu meminta Explore, jadi
  // jalur "nama agent salah" tidak bisa dipicu dari sana.
  process.env.AGENTHUB_DATA = dataDir;
  const { runSubagent } = await import('../lib/subagents.js');
  const r = await runSubagent({
    args: { prompt: 'apa saja', description: 'x', subagent_type: 'TidakAda' },
    cwd: work, mode: 'yolo',
    runner: async () => { throw new Error('runner tidak boleh dipanggil'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /tidak dikenal/);
  assert.match(r.text, /general-purpose/, 'penolakan harus menyebut pilihan yang ada');
});
