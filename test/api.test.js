// test/api.test.js — uji kontrak HTTP yang dipakai UI & agent.
// Menjalankan server sungguhan di port acak dengan data dir sementara,
// supaya tidak menyentuh data/dev milik user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7900 + Math.floor(Math.random() * 90);
const TOKEN = 'testtoken0123456789';
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

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 6,
    agentCheckMinutes: 15, keyCheckHours: 12, baselined: false, createdAt: Date.now(),
  }));
  // snapshot minimal supaya server tidak mencoba refresh jaringan saat boot
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
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

test('/healthz dan serverinfo melaporkan versi aplikasi sebenarnya', async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;
  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  assert.equal(health.version, expected);
  const info = await (await api('/api/serverinfo')).json();
  assert.equal(info.version, expected);
  assert.equal(info.port, PORT);
  assert.match(info.instanceId || '', /^[0-9a-f-]{36}$/, 'ID perangkat dibuat (UUID)');
  // ID perangkat stabil antar permintaan (dipakai menu akun)
  const info2 = await (await api('/api/serverinfo')).json();
  assert.equal(info2.instanceId, info.instanceId);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(onDisk.instanceId, info.instanceId, 'instanceId tersimpan di config');
});

test('tanpa token → 401', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
  assert.equal(r.status, 401);
});

test('/api/machines mengembalikan kontrak lengkap', async () => {
  const r = await api('/api/machines');
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.version, 4);
  assert.deepEqual(m.tasks.transitions.inbox, ['todo']);
  assert.ok(m.run.states.running);
  assert.ok(m.step.states.working);
  assert.ok(m.delegation.states.running);
  assert.ok(m.connection.states.offline);
  assert.equal(m.promoPass.states.active, 'Aktif');
  assert.ok(Array.isArray(m.views) && m.views.includes('tasks'));
  assert.deepEqual(m.sseScopes.tasks, ['tasks']);
  assert.deepEqual(m.sseScopes.promoPass, ['promoPass']);
});

test('/api/status melaporkan apa yang berjalan', async () => {
  const r = await api('/api/status');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.runningCount, 0);
  assert.deepEqual(s.runningThreads, []);
  assert.ok('tasksByStatus' in s);
});

test('task: transisi linear ditegakkan, 409 untuk lompatan', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'uji mesin', status: 'inbox' }),
  })).json();
  const id = created.id;

  // sah: inbox → todo
  const ok = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'todo' }) });
  assert.equal(ok.status, 200);

  // ilegal: todo → review (lompat satu kolom)
  const bad = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(bad.status, 409);
  const body = await bad.json();
  assert.equal(body.code, 'ILLEGAL_TRANSITION');
  assert.deepEqual(body.allowed, ['running']);
  assert.equal(body.from, 'todo');

  // status tak dikenal juga 409, bukan diam-diam diabaikan
  const bogus = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'selesai' }) });
  assert.equal(bogus.status, 409);

  // rantai penuh sampai done
  for (const st of ['running', 'review', 'done']) {
    const r = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: st }) });
    assert.equal(r.status, 200, `→ ${st}`);
  }
  // done adalah sink
  const out = await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(out.status, 409);

  // statusAt tercatat per kolom
  const list = await (await api('/api/tasks')).json();
  const t = list.find((x) => x.id === id);
  assert.ok(t.statusAt.done > 0);
  assert.equal(t.status, 'done');
});

test('task: patch judul saja tidak mengubah status', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'judul awal', status: 'todo' }),
  })).json();
  const r = await api(`/api/tasks/${created.id}`, { method: 'POST', body: JSON.stringify({ title: 'judul baru' }) });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.title, 'judul baru');
  assert.equal(t.status, 'todo');
});

test('task: status sama dengan sekarang tidak dianggap transisi ilegal', async () => {
  const created = await (await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'idempoten', status: 'review' }),
  })).json();
  const r = await api(`/api/tasks/${created.id}`, { method: 'POST', body: JSON.stringify({ status: 'review' }) });
  assert.equal(r.status, 200);
});

test('thread: stop pada run yang tidak ada tetap 200 (idempoten)', async () => {
  const r = await api('/api/threads/abcdef0123456789/stop', { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stopped, 0);
});

test('/api/version stabil untuk agent', async () => {
  const v = await (await api('/api/version')).json();
  assert.equal(v.machines, 4);
  assert.deepEqual(v.taskStatuses, ['inbox', 'todo', 'running', 'review', 'done']);
});

test('notes: buat, sematkan, ubah, hapus', async () => {
  // judul/isi kosong ditolak
  const bad = await api('/api/notes', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(bad.status, 400);

  const a = await (await api('/api/notes', {
    method: 'POST', body: JSON.stringify({ title: 'catatan A', body: 'isi A', projectId: 'alpha' }),
  })).json();
  assert.ok(a.id);
  assert.equal(a.pinned, false);
  assert.equal(a.projectId, 'alpha');

  const b = await (await api('/api/notes', {
    method: 'POST', body: JSON.stringify({ title: 'catatan B', body: 'isi B', pinned: true }),
  })).json();

  // yang disematkan tampil lebih dulu
  const list = await (await api('/api/notes')).json();
  assert.equal(list[0].id, b.id);
  assert.equal(list[0].projectId, 'global');

  const patched = await (await api(`/api/notes/${a.id}`, {
    method: 'POST', body: JSON.stringify({ title: 'A baru', pinned: true }),
  })).json();
  assert.equal(patched.title, 'A baru');
  assert.equal(patched.pinned, true);

  // state & status ikut membawa notes
  const st = await (await api('/api/state')).json();
  assert.equal(st.notes.length, 2);
  const status = await (await api('/api/status')).json();
  assert.equal(status.notes, 2);

  const del = await api(`/api/notes/${a.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await (await api('/api/notes')).json();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, b.id);
});

test('key baru otomatis masuk pool gateway (autoPool)', async () => {
  const st = await (await api('/api/state')).json();
  assert.equal(st.config.autoPool, true);

  const r = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-uji-promo', baseUrl: 'http://127.0.0.1:9/v1', poolModel: 'uji/model-gratis' }),
  });
  assert.equal(r.status, 200);
  const { entry } = await r.json();
  assert.equal(entry.pool, true);
  assert.equal(entry.poolModel, 'uji/model-gratis');

  // autoPool dimatikan → key berikutnya tidak masuk pool
  const off = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autoPool: false }) });
  assert.equal(off.status, 200);
  const r2 = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-uji-promo-2', baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  const { entry: e2 } = await r2.json();
  assert.equal(e2.pool, false);

  const st2 = await (await api('/api/state')).json();
  assert.equal(st2.config.autoPool, false);
});

test('models: katalog berisi auto dan menolak mask sebagai key', async () => {
  const r = await api('/api/models');
  assert.equal(r.status, 200);
  const { models } = await r.json();
  assert.ok(Array.isArray(models));
  const auto = models.find((x) => x.id === 'auto');
  assert.ok(auto, 'katalog harus punya opsi auto');
  assert.equal(typeof auto.available, 'boolean');

  // nilai ber-mask (tampilan UI) tidak boleh tersimpan sebagai key sungguhan
  const masked = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', key: 'sk-…ABCD', baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  assert.equal(masked.status, 400);
  assert.match((await masked.json()).error, /mask/i);
});

test('models: aktif tanpa key baru memakai key tersimpan (tanpa web)', async () => {
  // key custom dengan baseUrl mati → probe gagal → status 'error', tetap kandidat pool
  const made = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', name: 'uji aktifasi', baseUrl: 'http://127.0.0.1:9/v1', key: 'sk-uji-aktifasi' }),
  });
  assert.equal(made.status, 200);
  const keyId = (await made.json()).entry.id;

  const act = await api('/api/models/activate', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', model: 'custom/deepseek/deepseek-v4.1:free', keyId }),
  });
  assert.equal(act.status, 200);
  const { entry } = await act.json();
  assert.equal(entry.id, keyId, 'aktifasi dengan keyId memakai key yang diminta');
  assert.equal(entry.pool, true);
  assert.equal(entry.poolModel, 'deepseek/deepseek-v4.1:free', 'prefiks preset dibuang untuk upstream');
  assert.equal(entry.key, undefined, 'key utuh tidak pernah dikirim balik');

  // tanpa keyId: server memilih kandidat key custom yang bisa dipakai sendiri
  const auto2 = await api('/api/models/activate', {
    method: 'POST',
    body: JSON.stringify({ preset: 'custom', model: 'custom/deepseek/deepseek-v4.1:free' }),
  });
  assert.equal(auto2.status, 200);
  assert.equal((await auto2.json()).entry.pool, true);

  // provider tanpa key yang bisa dipakai → 409, bukan diam
  const miss = await api('/api/models/activate', {
    method: 'POST',
    body: JSON.stringify({ preset: 'groq', model: 'groq/llama-3.3-70b-versatile' }),
  });
  assert.equal(miss.status, 409);
});

test('context: branch folder tanpa proyek bersifat read-only', async () => {
  const r = await api(`/api/context?cwd=${encodeURIComponent(ROOT)}`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok('branch' in c && 'cwd' in c && 'changes' in c);
  assert.equal(c.branch === null || typeof c.branch === 'string', true);
});

test('tunnel: mati secara default, bisa dinyalakan/dimatikan tanpa bocor token', async () => {
  const off = await api('/api/tunnel');
  assert.equal(off.status, 200);
  assert.equal((await off.json()).status, 'stopped');

  // tanpa cloudflared terpasang → status error yang jujur, bukan crash
  const start = await api('/api/tunnel', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(start.status, 200);
  const st = await start.json();
  assert.ok(['starting', 'error'].includes(st.status), `status tak terduga: ${st.status}`);
  assert.equal(st.url, null, 'URL tunnel tidak boleh ada sebelum cloudflared siap');

  // path cloudflared tersimpan lewat endpoint yang sama
  const save = await api('/api/tunnel', { method: 'POST', body: JSON.stringify({ enabled: false, cloudflaredPath: 'C:\\tools\\cloudflared.exe' }) });
  assert.equal(save.status, 200);
  const state = await (await api('/api/state')).json();
  assert.equal(state.config.cloudflaredPath, 'C:\\tools\\cloudflared.exe');

  const stop = await api('/api/tunnel', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal((await stop.json()).status, 'stopped');
});

test('files: daftar folder untuk @ mention (read-only, tanpa isi file)', async () => {
  const r = await api(`/api/files?cwd=${encodeURIComponent(ROOT)}`);
  assert.equal(r.status, 200);
  const { entries, cwd } = await r.json();
  assert.ok(Array.isArray(entries));
  assert.ok(cwd.endsWith('AgentHub') || cwd.endsWith('agenthub'));
  const pkg = entries.find((e) => e.name === 'package.json');
  assert.ok(pkg, 'package.json harus terlihat');
  assert.equal(pkg.dir, false);
  assert.ok(pkg.rel, 'path relatif disertakan untuk disisipkan ke prompt');
  // filter bekerja
  const q = await api(`/api/files?cwd=${encodeURIComponent(ROOT)}&q=packa`);
  assert.ok((await q.json()).entries.some((e) => e.name === 'package.json'));
  // cwd tidak valid → 400, bukan membocorkan isi disk
  const bad = await api('/api/files?cwd=relatif-tidak-absolut');
  assert.equal(bad.status, 400);
});

test('threads: rename, pin, dan urutan pinned pertama', async () => {
  const a = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).json();
  const b = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).json();
  // b lebih baru → harus di atas sebelum pin
  const list1 = await (await api('/api/threads')).json();
  assert.equal(list1[0].id, b.id);
  const patch = await api(`/api/threads/${a.id}`, { method: 'POST', body: JSON.stringify({ title: 'Pinned Uji', pinned: true }) });
  assert.equal(patch.status, 200);
  const patched = await patch.json();
  assert.equal(patched.title, 'Pinned Uji');
  assert.equal(patched.pinned, true);
  const list2 = await (await api('/api/threads')).json();
  assert.equal(list2[0].id, a.id, 'thread ter-pin tampil paling atas');
  // patch kosong → 400
  const empty = await api(`/api/threads/${a.id}`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
  await api(`/api/threads/${a.id}`, { method: 'DELETE' });
  await api(`/api/threads/${b.id}`, { method: 'DELETE' });
});

test('export: thread bisa diunduh sebagai markdown', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).json();
  await api(`/api/threads/${t.id}/send`, { method: 'POST', body: JSON.stringify({ prompt: 'Halo uji export', engine: 'echo' }) }).then((r) => r.text());
  const r = await api(`/api/threads/${t.id}/export`);
  assert.equal(r.status, 200);
  const md = await r.text();
  assert.ok(md.startsWith('# '), 'judul jadi heading');
  assert.ok(md.includes('Halo uji export'), 'pesan user ikut');
  const missing = await api('/api/threads/nonexistent00/export');
  assert.equal(missing.status, 404);
  await api(`/api/threads/${t.id}`, { method: 'DELETE' });
});

test('pwa: manifest, service worker, dan ikon disajikan tanpa token', async () => {
  // HP harus bisa memasang aplikasi sebelum punya token, jadi aset ini terbuka.
  const plain = (p) => fetch(`http://127.0.0.1:${PORT}${p}`);
  const manifest = await plain('/public/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  const app = await manifest.json();
  assert.equal(app.display, 'standalone');
  assert.ok(app.icons.length >= 2, 'ikon 192 dan 512 wajib ada');
  for (const ico of app.icons) {
    const r = await plain(ico.src);
    assert.equal(r.status, 200, `${ico.src} harus tersedia`);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.ok((await r.arrayBuffer()).byteLength > 500, `${ico.src} tidak boleh kosong`);
  }

  // SW harus dari root, kalau tidak scope-nya terbatas pada satu folder
  const sw = await plain('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const body = await sw.text();
  assert.match(body, /addEventListener\('fetch'/);
  assert.ok(!/cache\.put\(\s*[^)]*\/api\//.test(body), 'API tidak boleh ikut di-cache');

  // UI wajib menautkan manifest + mendaftarkan SW
  const html = await (await plain('/')).text();
  assert.match(html, /rel="manifest"\s+href="\/public\/manifest\.webmanifest"/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
});

test('pwa: shell tetap jalan saat offline karena service worker menyimpan kerangka UI', async () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  for (const asset of ['/public/app.js', '/public/style.css', '/public/machines.js']) {
    assert.ok(sw.includes(asset), `${asset} harus masuk daftar cache shell`);
  }
  assert.match(sw, /'\/'/, 'halaman utama harus jadi fallback navigasi offline');
});

test('stats: statistik sesi thread dihitung dari pesan nyata', async () => {
  const t = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: 'echo' }) })).json();
  await api(`/api/threads/${t.id}/send`, { method: 'POST', body: JSON.stringify({ prompt: 'Hitung statistikku', engine: 'echo' }) }).then((r) => r.text());
  const r = await api(`/api/threads/${t.id}/stats`);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.title, 'Hitung statistikku', 'judul thread diambil dari pesan pertama');
  assert.equal(s.engine, 'echo');
  assert.equal(s.messages, 2, 'user + asisten');
  assert.equal(s.userMessages, 1);
  assert.equal(s.assistantMessages, 1);
  // engine echo tidak melaporkan token — harus null, bukan 0 palsu
  assert.equal(s.totalTokens, null);
  assert.equal(s.inputTokens, null);
  assert.ok(s.createdAt > 0 && s.updatedAt >= s.createdAt, 'waktu sesi ada');
  assert.equal((await api('/api/threads/tidakada0000/stats')).status, 404);
  await api(`/api/threads/${t.id}`, { method: 'DELETE' });
});


test('katalog promo: berisi entri hasil riset Nov 2026 dengan sumber', async () => {
  const state = await (await api('/api/state')).json();
  const catalog = state.catalog || [];
  assert.ok(catalog.length >= 28, `katalog harus >= 28 entri, ada ${catalog.length}`);
  const names = catalog.map((c) => c.name).join(' | ');
  for (const expect of ['OVHcloud AI Endpoints', 'Tencent Cloud TokenHub', 'SiliconFlow', 'Z AI (GLM internasional)', 'DeepInfra DeepStart']) {
    assert.ok(names.includes(expect), `entri riset "${expect}" harus ada`);
  }
  for (const c of catalog) {
    assert.ok(c.name && c.url && c.free, `${c.name}: name/url/free wajib`);
    assert.match(c.url, /^https:\/\//, `${c.name}: url harus https`);
  }
});

test('agents: pulse semua konektor — rute check-all idempoten', async () => {
  const r = await api('/api/agents/check-all', { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  // tanpa konektor: checked 0, bukan error — panel Pulse tetap aman dipakai
  assert.ok('checked' in body || body.started === true);
});

test('keamanan: percobaan token salah berlebihan → 429, token sah tetap lolos', async () => {
  // 13 permintaan token salah: 401 di awal, lalu 429 setelah ambang
  const codes = [];
  for (let i = 0; i < 13; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { authorization: 'Bearer token-salah' } });
    codes.push(r.status);
  }
  assert.equal(codes.filter((c) => c === 401).length, 12, '12 percobaan pertama tetap 401');
  assert.equal(codes.at(-1), 429, 'percobaan ke-13 dibatasi 429');

  // token yang sah TIDAK ikut diblokir — dan membersihkan hitungan gagal
  const ok = await api('/api/state');
  assert.equal(ok.status, 200);

  // setelah sukses, hitungan reset: salah satu lagi masih 401 (bukan 429)
  const one = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { authorization: 'Bearer token-salah' } });
  assert.equal(one.status, 401);
});
