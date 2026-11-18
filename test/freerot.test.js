// test/freerot.test.js â€” Free Auto: tangga rotasi model gratis.
// Unit: ladder, cooldown, deteksi limit. Server: engine free-auto memutar
// model saat yang pertama kena limit â€” tanpa sentuhan pengguna.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './helpers/port.js';
import { stopTestServer } from './helpers/server.js';
import { ladder, markFail, markOk, looksLimited, cooling, _setState, _state, markSlow, noteFirst, firstTimeoutFor } from '../lib/freerot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Blok port sendiri, bukan `9030 + Math.random() * 30`. Port acak dalam rentang
// tetap tetap bisa bertabrakan dengan berkas tes lain yang memakai rentang yang
// sama, dan tabrakan itu hanya muncul sesekali â€” persis jenis kegagalan yang
// paling mahal untuk dilacak. `pickFreePort` juga memeriksa port benar-benar
// bisa didengarkan, bukan hanya belum dipakai saat dipilih.
const PORT = await pickFreePort(9060, 30);
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
  _setState({}); // unit test murni memori â€” jangan sentuh freerot.json live
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

test('freerot unit: model lambat dijeda sebentar, bukan dikarantina', () => {
  // Regresi nyata: ambang "tanpa output" 30 detik lebih pendek daripada waktu
  // jawab model gratis yang sebenarnya (11-39 detik), sehingga model SEHAT
  // ditandai gagal dan dikarantina 10 menit. Free Auto lalu kehilangan anggota
  // tangganya sendiri. Model lambat harus dijeda singkat, bukan dibuang.
  _setState({});
  process.env.AGENTHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rot-slow-'));
  try {
    const id = 'opencode-free-slow-free';
    markSlow(id, 75000);
    assert.equal(cooling(id), true, 'model lambat tetap dijeda supaya permintaan pindah');
    const st = _state();
    const jeda = st[id].cooldownUntil - Date.now();
    assert.ok(jeda <= 3 * 60 * 1000 + 1000, `jeda harus singkat (3 menit), ternyata ${Math.round(jeda / 1000)} detik`);
    assert.ok(jeda > 60 * 1000, 'jeda tetap ada, bukan nol');
    assert.equal(st[id].fails, 0, 'lambat bukan kegagalan: hitungan gagal tidak naik');
    assert.match(st[id].lastError, /lambat/, 'alasan jujur: lambat, bukan gagal');

    // model yang benar-benar gagal tetap dikarantina penuh
    const bad = 'opencode-free-bad-free';
    markFail(bad, 'keluar dengan kode 1');
    const jedaBad = _state()[bad].cooldownUntil - Date.now();
    assert.ok(jedaBad > 5 * 60 * 1000, `gagal nyata harus 10 menit, ternyata ${Math.round(jedaBad / 1000)} detik`);
    assert.equal(_state()[bad].fails, 1, 'gagal nyata menaikkan hitungan');
  } finally {
    fs.rmSync(process.env.AGENTHUB_DATA, { recursive: true, force: true });
    if (SAVED_DATA === undefined) delete process.env.AGENTHUB_DATA; else process.env.AGENTHUB_DATA = SAVED_DATA;
  }
});

test('freerot unit: tenggat per model menyesuaikan kecepatan yang teramati', () => {
  // Model yang terbukti butuh 39 detik tidak boleh dipotong di 30 detik pada
  // percobaan berikutnya. Tenggat = 2x kecepatan teramati, minimal bawaan.
  _setState({});
  process.env.AGENTHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rot-budget-'));
  try {
    const id = 'opencode-free-x-free';
    assert.equal(firstTimeoutFor(id, 75000), 75000, 'belum ada riwayat: pakai bawaan');

    noteFirst(id, 38800);
    assert.equal(firstTimeoutFor(id, 75000), 77600, 'model lambat dapat 2x kecepatannya');

    // model cepat tidak boleh menurunkan tenggat di bawah bawaan
    const fast = 'opencode-free-fast-free';
    noteFirst(fast, 9000);
    assert.equal(firstTimeoutFor(fast, 75000), 75000, 'model cepat tetap pakai bawaan');

    // model yang berhasil menjawab TIDAK boleh kehilangan catatan kecepatannya
    markOk(id);
    assert.equal(_state()[id].firstMs, 38800, 'markOk mempertahankan firstMs');
    assert.equal(firstTimeoutFor(id, 75000), 77600, 'tenggat tetap menyesuaikan setelah sukses');
    assert.equal(_state()[id].fails, 0, 'sukses mereset hitungan gagal');

    // rata-rata bergerak: nilai simpanan berada DI ANTARA dua pengamatan, jadi
    // satu percobaan yang kebetulan sangat lambat tidak melonjakkan tenggat ke
    // nilai pengamatan terakhir.
    noteFirst(id, 40000);
    const simpan = _state()[id].firstMs;
    assert.ok(simpan > 38800 && simpan < 40000,
      `rata-rata bergerak harus di antara 38800 dan 40000, ternyata ${simpan}`);
    assert.ok(firstTimeoutFor(id, 75000) < 40000 * 2, 'tenggat tidak melonjak ke pengamatan terakhir');
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
  // Engine gratis palsu: SLOW menggantung 45 detik (melewati batas 3 detik),
  // BB jawab cepat â€” rotasi harus pindah otomatis tanpa menunggu.
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), JSON.stringify([
    { id: 'opencode-free-slow-free', label: 'SLOW (menggantung)', type: 'cli', cmd: 'cmd', args: ['/c', 'powershell', '-NoProfile', '-Command', 'Start-Sleep -Seconds 45'] },
    { id: 'opencode-free-bb-free', label: 'BB (oke)', type: 'cli', cmd: 'cmd', args: ['/c', 'echo', 'jawaban dari BB'] },
  ]));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_DATA: dataDir,
      AGENTHUB_NO_TOAST: '1',
      // Port dipatok: server TIDAK boleh diam-diam pindah ke port lain,
      // karena tes menunggu port yang ia minta. Lihat test/helpers/server.js.
      AGENTHUB_STRICT_PORT: '1',
      AGENTHUB_FREE_FIRST_TIMEOUT_MS: '3000', // batas tanpa-output dipendekkan untuk tes
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(async () => {
  // Tunggu proses benar-benar berhenti sebelum menghapus folder: proses
  // yang masih hidup memegang port dan masih bisa menulis ke dataDir.
  await stopTestServer(child);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('free-auto: tenggat "tanpa output" cukup panjang untuk model gratis nyata', () => {
  // Angka ini berasal dari pengukuran di mesin ini: token pertama model gratis
  // datang pada 11-39 detik. Ambang 30 detik memotong model yang SEHAT.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /AGENTHUB_FREE_FIRST_TIMEOUT_MS\)\s*\|\|\s*(\d+)/.exec(src);
  assert.ok(m, 'ambang "tanpa output" harus terbaca dari kode');
  const ms = Number(m[1]);
  assert.ok(ms >= 60000, `ambang bawaan ${ms} ms terlalu pendek: model gratis yang sehat akan dipotong`);
  assert.ok(ms <= 180000, `ambang bawaan ${ms} ms terlalu panjang: run yang benar-benar macet menahan terlalu lama`);
  // model yang pernah teramati lambat mendapat tenggat lebih longgar
  assert.match(src, /firstTimeoutFor\(eng\.id/, 'tenggat harus menyesuaikan kecepatan model');
  assert.match(src, /freerot\.markSlow\(/, 'model lambat harus dijeda singkat, bukan ditandai gagal');
});

test('free-auto: SLOW menggantung -> otomatis pindah ke BB', async () => {
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
  assert.match(last.content || '', /jawaban dari BB/, 'jawaban datang dari engine BB (bukan SLOW)');
  assert.equal(last.engine, 'opencode-free-bb-free', 'engine asli tercatat jujur');
  assert.equal(th.runState, 'done', 'run selesai');

  // Model yang lambat tapi tidak error harus DIPERLAKUKAN BEDA dari model yang
  // gagal: dijeda singkat, bukan dikarantina 10 menit, dan hitungan gagal tidak
  // naik. Diperiksa dari freerot.json di disk — bukan dari kode — supaya yang
  // diuji perilaku server sungguhan.
  const rot = JSON.parse(fs.readFileSync(path.join(dataDir, 'freerot.json'), 'utf8'));
  const slow = rot['opencode-free-slow-free'];
  assert.ok(slow, 'SLOW tercatat di freerot.json');
  assert.match(String(slow.lastError || ''), /lambat/, 'alasan jujur: lambat, bukan gagal');
  assert.equal(slow.fails, 0, 'lambat bukan kegagalan — hitungan gagal tidak naik');
  const jeda = (slow.cooldownUntil || 0) - Date.now();
  assert.ok(jeda > 0, 'tetap dijeda supaya permintaan pindah ke model berikutnya');
  assert.ok(jeda < 9 * 60 * 1000, `BUKAN karantina 10 menit, ternyata ${Math.round(jeda / 1000)} detik`);

  // Statistik pemakaian juga harus jujur. Dulu harness mencatat SETIAP abort
  // sebagai `failed`, termasuk abort karena model terlalu lama diam — jadi
  // pane Pemakaian menampilkan engine sehat sebagai gagal, dan itulah angka
  // yang memicu investigasi ini.
  const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-stats.json'), 'utf8'));
  const sSlow = stats['opencode-free-slow-free'] || {};
  assert.equal(sSlow.slow, 1, 'model lambat dihitung "lambat" di statistik');
  assert.equal(sSlow.failed || 0, 0, 'model lambat TIDAK dihitung gagal di statistik');
  const sBb = stats['opencode-free-bb-free'] || {};
  assert.equal(sBb.ok, 1, 'model yang menjawab tercatat ok');

  // Dan angka itu harus SAMPAI ke UI lewat /api/usage — bukan hanya tersimpan
  // di disk. Kalau usageStats berhenti melaporkan `slow`, pane Pemakaian
  // kembali menyembunyikan alasan sebenarnya.
  const usage = await (await api('/api/usage')).json();
  const uSlow = usage.find((u) => u.id === 'opencode-free-slow-free');
  assert.ok(uSlow, 'engine lambat ada di /api/usage');
  assert.equal(uSlow.slow, 1, '/api/usage melaporkan jumlah "lambat"');
  assert.equal(uSlow.failed, 0, '/api/usage tidak menyebutnya gagal');

  // CSV ikut membawa kolom yang sama, supaya ekspor tidak menghilangkan
  // perbedaan yang sudah dibuat di UI.
  const csv = await (await api('/api/usage.csv')).text();
  assert.match(csv.split('\n')[0], /,slow,/, 'header CSV punya kolom slow');
});
