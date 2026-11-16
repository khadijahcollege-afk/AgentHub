// test/stats.test.js — statistik fitur: kunci hari lokal, seed dari data nyata,
// dan batas rentang. Uji di level modul supaya perilaku yang tidak terlihat dari
// HTTP (mis. hari lokal vs UTC) tetap terjaga.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;

// store.js menetapkan folder data saat pertama diimpor, jadi tes ini memakai
// SATU folder sementara untuk seluruh berkas dan mengosongkannya tiap kasus.
// (Impor ulang dengan query string tidak akan memindahkan folder data.)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-stats-'));
process.env.AGENTHUB_DATA = DATA;
const stats = await import('../lib/stats.js');

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// Kosongkan folder lalu tulis berkas seed — tiap kasus mulai dari nol.
function reset(seed = {}) {
  for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { force: true });
  for (const [name, value] of Object.entries(seed)) {
    fs.writeFileSync(path.join(DATA, name), JSON.stringify(value));
  }
}

test('stats: kunci hari memakai waktu lokal, bukan UTC', () => {
  // 00:30 dan 23:30 waktu lokal harus tetap tanggal yang sama. Dengan
  // toISOString() kasus ini pecah di zona waktu positif (WIB = UTC+7).
  assert.equal(stats.dayKey(new Date(2026, 4, 17, 0, 30, 0).getTime()), '2026-05-17');
  assert.equal(stats.dayKey(new Date(2026, 4, 17, 23, 30, 0).getTime()), '2026-05-17');
  assert.equal(stats.dayKey(new Date(2026, 0, 1, 0, 0, 0).getTime()), '2026-01-01');
  assert.equal(stats.dayKey(new Date(2026, 8, 9, 12).getTime()), '2026-09-09', 'nol-padu dua digit');
});

test('stats: tanpa data apa pun, ringkasan tetap sah dan tidak mengarang angka', () => {
  reset();
  const s = stats.usageSummary();
  assert.equal(s.total, 0);
  assert.equal(s.activeDays, 0);
  assert.equal(s.streak, 0);
  assert.equal(s.bestStreak, 0);
  assert.equal(s.avgPerActiveDay, 0);
  assert.equal(s.series.length, 364);
  assert.equal(s.series.at(-1).date, s.today, 'seri diakhiri hari ini');
  assert.ok(s.features.every((f) => f.count === 0));
  assert.deepEqual(s.engines, []);
  assert.equal(s.deltaPct, undefined, 'delta hanya dari rangeDelta, bukan tebakan');
});

test('stats: seed menurunkan angka dari thread, tugas, catatan, dan jadwal', () => {
  const now = Date.now();
  reset({
    'threads.json': [{
      id: 'a'.repeat(32),
      engine: 'claude',
      createdAt: now - DAY * 2,
      updatedAt: now - DAY,
      messages: [
        { role: 'user', content: 'hai', ts: now - DAY * 2 },
        { role: 'assistant', engine: 'claude', content: 'yo', ts: now - DAY * 2 },
        { role: 'assistant', engine: 'codex', content: 'yo', ts: now - DAY },
      ],
    }],
    'tasks.json': [{ id: 't1', createdAt: now - DAY }],
    'notes.json': [{ id: 'n1', createdAt: now - DAY * 3 }],
    'schedules.json': [{ id: 's1', createdAt: now - DAY * 4 }],
  });
  const s = stats.usageSummary();
  const count = (id) => s.features.find((f) => f.id === id).count;
  assert.equal(count('chat'), 2, 'satu pesan asisten = satu run');
  assert.equal(count('tasks'), 1);
  assert.equal(count('notes'), 1);
  assert.equal(count('schedules'), 1);
  assert.equal(s.total, 5);
  assert.deepEqual(
    Object.fromEntries(s.engines.map((e) => [e.id, e.count])),
    { claude: 1, codex: 1 },
    'per engine mengikuti pesan asisten',
  );
  assert.equal(count('chat'), s.engines.reduce((n, e) => n + e.count, 0), 'chat = jumlah per engine');
});

test('stats: engine-stats hanya dipakai bila belum ada pesan asisten', () => {
  reset({ 'engine-stats.json': { claude: { runs: 4, ok: 4, failed: 0, msTotal: 10 } } });
  const viaGateway = stats.usageSummary();
  assert.equal(viaGateway.features.find((f) => f.id === 'chat').count, 4, 'pemakaian lewat /v1 tetap tercatat');
  assert.deepEqual(viaGateway.engines, [{ id: 'claude', count: 4 }]);

  // Kalau thread sudah punya pesan asisten, engine-stats TIDAK ditambahkan:
  // menghitung keduanya akan menggandakan angka.
  reset({
    'engine-stats.json': { claude: { runs: 4, ok: 4, failed: 0, msTotal: 10 } },
    'threads.json': [{
      id: 'b'.repeat(32),
      engine: 'claude',
      messages: [{ role: 'assistant', engine: 'claude', content: 'x', ts: Date.now() }],
    }],
  });
  assert.equal(stats.usageSummary().features.find((f) => f.id === 'chat').count, 1, 'tidak dobel');
});

test('stats: record menambah hari ini, menolak fitur tak dikenal, dan mencatat engine', () => {
  reset();
  assert.equal(stats.record('chat', { engine: 'claude' }), true);
  assert.equal(stats.record('terminal'), true);
  assert.equal(stats.record('tidak-ada'), false, 'id liar tidak masuk berkas');
  const s = stats.usageSummary();
  assert.equal(s.total, 2);
  assert.equal(s.series.at(-1).total, 2, 'tercatat di hari ini');
  assert.equal(s.features.find((f) => f.id === 'chat').count, 1);
  assert.equal(s.features.find((f) => f.id === 'terminal').count, 1);
  assert.deepEqual(s.engines, [{ id: 'claude', count: 1 }]);
  assert.equal(s.streak, 1);
  // berkasnya benar-benar ditulis, bukan hanya di memori
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'usage-daily.json'), 'utf8'));
  assert.equal(onDisk.days[s.today].total, 2);
});

test('stats: streak berjalan dan streak terbaik dihitung dari hari berurutan', () => {
  const now = Date.now();
  // tiga hari berurutan, jeda, lalu tiga hari berurutan sampai hari ini
  reset({
    'threads.json': [0, 1, 2, 10, 11, 12].map((back) => ({
      id: String(back).padStart(32, '0'),
      engine: 'claude',
      messages: [{ role: 'assistant', engine: 'claude', content: 'x', ts: now - back * DAY }],
    })),
  });
  const s = stats.usageSummary();
  assert.equal(s.streak, 3, 'streak berjalan 3 hari');
  assert.equal(s.bestStreak, 3);
  assert.equal(s.activeDays, 6);
  assert.equal(s.avgPerActiveDay, 1, 'rata-rata per hari aktif, bukan per hari kalender');
});

test('stats: rangeDelta membandingkan jendela sama panjang', () => {
  const now = Date.now();
  const threads = [];
  // 5 aktivitas hari ini, 1 aktivitas 10 hari lalu
  for (let i = 0; i < 5; i++) {
    threads.push({ id: `a${i}`.padEnd(32, '0'), engine: 'e', messages: [{ role: 'assistant', engine: 'e', content: 'x', ts: now - i }] });
  }
  threads.push({ id: 'b'.padEnd(32, '0'), engine: 'e', messages: [{ role: 'assistant', engine: 'e', content: 'x', ts: now - 10 * DAY }] });
  reset({ 'threads.json': threads });

  const d7 = stats.rangeDelta(7);
  assert.equal(d7.current, 5, '7 hari terakhir');
  assert.equal(d7.previous, 1, 'aktivitas 10 hari lalu masuk jendela 7–14 hari');
  assert.equal(d7.deltaPct, 400);
  assert.equal(d7.comparable, true);

  // Jendela 3 hari sebelumnya kosong → tidak ada pembanding yang sah.
  const d3 = stats.rangeDelta(3);
  assert.equal(d3.current, 5);
  assert.equal(d3.previous, 0);
  assert.equal(d3.deltaPct, null, 'tanpa pembanding → null, bukan 0/Infinity');
});

test('stats: rangeDelta membatasi rentang ke 1..365 dan jatuh ke 7 untuk nilai aneh', () => {
  reset();
  // Nilai tidak sah → 7 hari (default UI). Nol dan negatif tidak punya arti
  // sebagai "rentang", jadi diperlakukan sama seperti nilai kosong.
  assert.equal(stats.rangeDelta(0).days, 7);
  assert.equal(stats.rangeDelta(-50).days, 7);
  assert.equal(stats.rangeDelta('abc').days, 7);
  assert.equal(stats.rangeDelta(undefined).days, 7);
  assert.equal(stats.rangeDelta(1).days, 1);
  assert.equal(stats.rangeDelta(9999).days, 365);
  assert.equal(stats.rangeDelta(12.7).days, 12, 'pecahan dipotong, bukan dibulatkan');
  const empty = stats.rangeDelta(30);
  assert.equal(empty.previous, 0);
  assert.equal(empty.deltaPct, null);
  assert.equal(empty.comparable, true, 'seri 364 hari cukup untuk jendela 30+30');
  // Rentang lebih panjang dari seri: tidak boleh mengaku bisa dibandingkan.
  assert.equal(stats.rangeDelta(365).comparable, false);
});

test('stats: prune membuang data lebih tua dari batas simpan', () => {
  reset();
  // 405 hari: melewati batas 400 hari
  const days = {};
  const start = new Date();
  for (let i = 0; i < 405; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    days[stats.dayKey(d.getTime())] = { total: 1, features: { chat: 1 }, engines: { e: 1 } };
  }
  fs.writeFileSync(path.join(DATA, 'usage-daily.json'), JSON.stringify({ version: 1, seededAt: Date.now(), days }));
  stats.record('notes');
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'usage-daily.json'), 'utf8'));
  assert.ok(Object.keys(onDisk.days).length <= 400, 'jumlah hari dibatasi');
  assert.ok(onDisk.days[stats.dayKey()], 'hari ini tetap ada');
});
