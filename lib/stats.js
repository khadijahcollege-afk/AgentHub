// lib/stats.js — statistik pemakaian fitur.
//
// Statistik engine yang lama (engine-stats.json) hanya berisi angka kumulatif:
// total run, ok, gagal. Itu tidak bisa menjawab "kapan saya produktif?" atau
// "fitur mana yang benar-benar saya pakai?", jadi tidak bisa digambar sebagai
// grafik waktu. Modul ini menyimpan peristiwa per hari dan per fitur.
//
// Prinsip yang sama seperti bagian lain aplikasi: data nyata, bukan tebakan.
// Angka awalnya diturunkan dari data yang SUDAH ada (thread, tugas, catatan,
// jadwal, engine-stats) supaya grafiknya tidak kosong pada hari pertama.
import { readJson, writeJson } from './store.js';

const FILE = 'usage-daily.json';
// Satu tahun + beberapa minggu agar heatmap 52 kolom penuh punya cadangan.
const KEEP_DAYS = 400;

// Kunci hari dalam waktu lokal, bukan UTC. Kalau memakai toISOString(), hari
// bergeser pada 07:00 WIB dan aktivitas malam akan tercatat di tanggal
// berikutnya — salah untuk heatmap "per hari".
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Daftar fitur yang dicatat. `id` dipakai di berkas, `label` di UI.
// Urutan ini juga urutan tampil di panel rincian.
export const FEATURES = [
  { id: 'chat', label: 'Chat agent', icon: 'M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z' },
  { id: 'tasks', label: 'Papan tugas', icon: 'M4 6h16M4 12h10M4 18h13' },
  { id: 'notes', label: 'Catatan', icon: 'M5 5.5h14M5 12h14M5 18.5h9' },
  { id: 'terminal', label: 'Terminal', icon: 'M4 6h16v12H4z M7 10l2.5 2L7 14' },
  { id: 'skills', label: 'Skills', icon: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z' },
  { id: 'delegate', label: 'Orkestrasi tim', icon: 'M6 7a2.2 2.2 0 1 0 0-.1M18 7a2.2 2.2 0 1 0 0-.1M12 18a2.2 2.2 0 1 0 0-.1' },
  { id: 'schedules', label: 'Jadwal otomatis', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7.5V12l3 2' },
  { id: 'gateway', label: 'Gateway /v1', icon: 'M4 8h9V4l7 8-7 8v-4H4z' },
  { id: 'promo', label: 'Promo & katalog', icon: 'M3 8h18v4H3z M5 12v8h14v-8' },
  { id: 'keys', label: 'API key', icon: 'M8 8m-3.6 0a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0-7.2 0 M10.7 10.7 20 20' },
];
const FEATURE_IDS = new Set(FEATURES.map((f) => f.id));

function read() {
  const raw = readJson(FILE, null);
  if (raw && typeof raw === 'object' && raw.days) return raw;
  return null; // sinyal untuk "perlu seed"
}

function emptyDay() {
  return { total: 0, features: {}, engines: {} };
}

// ---------- seed dari data yang sudah ada ----------
// Dipanggil sekali, saat berkas statistik belum ada. Semua angka diturunkan
// dari timestamp nyata di berkas lain; tidak ada angka karangan.
function seedFromExisting() {
  const days = {};
  const touch = (ts, feature, key) => {
    if (!ts || !Number.isFinite(ts)) return;
    const k = dayKey(ts);
    const d = days[k] || (days[k] = emptyDay());
    d.total += 1;
    if (feature) d.features[feature] = (d.features[feature] || 0) + 1;
    if (key) d.engines[key] = (d.engines[key] || 0) + 1;
  };

  // Thread: satu pesan asisten = satu run. Berkasnya array polos (bukan
  // {threads:[...]}) — sama seperti tasks/notes/schedules.
  const threads = readJson('threads.json', []);
  for (const t of Array.isArray(threads) ? threads : []) {
    for (const m of t.messages || []) {
      if (m.role === 'assistant') touch(m.ts || t.updatedAt, 'chat', m.engine || t.engine);
    }
  }

  for (const k of readJson('tasks.json', []) || []) touch(k.createdAt, 'tasks');
  for (const n of readJson('notes.json', []) || []) touch(n.createdAt, 'notes');
  for (const s of readJson('schedules.json', []) || []) touch(s.createdAt || s.lastRun, 'schedules');

  // engine-stats.json hanya punya total tanpa tanggal, jadi TIDAK dipakai untuk
  // mengarang aktivitas harian: angka tanpa tanggal tidak bisa diletakkan di
  // heatmap tanpa menebak. Yang dipakai hanya engine-stats bila thread belum
  // punya pesan asisten sama sekali (kasus pemakaian lewat /v1 gateway), dan
  // hasilnya diberi label per engine agar konsisten dengan grafik per engine.
  const es = readJson('engine-stats.json', {});
  const trackedEngines = {};
  for (const [id, st] of Object.entries(es || {})) {
    const n = (st && st.runs) || 0;
    if (n > 0) trackedEngines[id] = n;
  }
  const chatCounted = Object.values(
    Object.fromEntries(Object.entries(days).flatMap(([, d]) => Object.entries(d.engines || {})))
  ).reduce((a, b) => a + b, 0);
  if (chatCounted === 0 && Object.keys(trackedEngines).length) {
    const k = dayKey();
    const d = days[k] || (days[k] = emptyDay());
    for (const [id, n] of Object.entries(trackedEngines)) {
      d.total += n;
      d.features.chat = (d.features.chat || 0) + n;
      d.engines[id] = (d.engines[id] || 0) + n;
    }
  }
  return { version: 1, seededAt: Date.now(), days };
}

function load() {
  let db = read();
  if (!db) {
    db = seedFromExisting();
    writeJson(FILE, db);
  }
  return db;
}

// Catat satu peristiwa. `feature` harus salah satu FEATURE_IDS; selain itu
// diabaikan supaya berkas tidak dipenuhi kunci liar dari bug pemanggil.
export function record(feature, opts = {}) {
  if (!FEATURE_IDS.has(feature)) return false;
  const db = load();
  const k = dayKey();
  const d = db.days[k] || (db.days[k] = emptyDay());
  d.total += 1;
  d.features[feature] = (d.features[feature] || 0) + 1;
  if (opts.engine) d.engines[opts.engine] = (d.engines[opts.engine] || 0) + 1;
  prune(db);
  writeJson(FILE, db);
  return true;
}

function prune(db) {
  const keys = Object.keys(db.days).sort();
  if (keys.length <= KEEP_DAYS) return;
  for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete db.days[k];
}

// ---------- baca untuk UI ----------
// Ringkasan yang dipakai panel: heatmap satu tahun, deret harian 30 hari,
// rincian per fitur, dan angka kunci (total, streak, rata-rata).
export function usageSummary(now = Date.now()) {
  const db = load();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // 364 hari = 52 minggu penuh. Dengan padding di awal/akhir agar tiap kolom
  // tepat satu minggu kalender, hasilnya paling banyak 53 kolom — bukan 54
  // dengan satu kolom nyaris kosong.
  const span = 364;
  const series = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    const day = db.days[k];
    series.push({ date: k, total: day?.total || 0 });
  }

  const total = series.reduce((n, d) => n + d.total, 0);
  const activeDays = series.filter((d) => d.total > 0).length;

  // Streak berjalan: hitung mundur dari hari ini. Hari ini yang masih kosong
  // tidak memutus streak (hari belum selesai).
  let streak = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].total > 0) streak++;
    else if (i === series.length - 1) continue;
    else break;
  }
  let best = 0;
  let run = 0;
  for (const d of series) { run = d.total > 0 ? run + 1 : 0; if (run > best) best = run; }

  // Rincian per fitur dihitung dari seluruh rentang, bukan hanya 30 hari,
  // supaya proporsinya stabil dan tidak melompat tiap hari.
  const featureTotals = {};
  const engineTotals = {};
  for (const [k, day] of Object.entries(db.days)) {
    void k;
    for (const [f, n] of Object.entries(day.features || {})) featureTotals[f] = (featureTotals[f] || 0) + n;
    for (const [e, n] of Object.entries(day.engines || {})) engineTotals[e] = (engineTotals[e] || 0) + n;
  }
  const featureSum = Object.values(featureTotals).reduce((a, b) => a + b, 0) || 1;

  const last30 = series.slice(-30);
  const prev30 = series.slice(-60, -30);
  const sum30 = last30.reduce((n, d) => n + d.total, 0);

  return {
    today: dayKey(now),
    series,
    last30,
    total,
    activeDays,
    streak,
    bestStreak: best,
    avgPerActiveDay: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0,
    sum30,
    features: FEATURES.map((f) => ({
      id: f.id,
      label: f.label,
      icon: f.icon,
      count: featureTotals[f.id] || 0,
      pct: Math.round(((featureTotals[f.id] || 0) / featureSum) * 1000) / 10,
    })).sort((a, b) => b.count - a.count),
    engines: Object.entries(engineTotals).sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    seeded: db.seededAt || null,
  };
}

// Perbandingan rentang: dipakai grafik batang agar angka "naik/turun" selalu
// membandingkan panjang rentang yang SAMA dengan yang sedang ditampilkan.
export function rangeDelta(days, now = Date.now()) {
  // Rentang tidak sah (kosong, nol, negatif, bukan angka) jatuh ke 7 hari —
  // nilai default UI. Batas atas 365 karena seri heatmap hanya setahun; lebih
  // dari itu tidak ada pembanding untuk dibandingkan.
  const raw = Math.trunc(Number(days));
  const n = Number.isFinite(raw) && raw > 0 ? Math.min(365, raw) : 7;
  const s = usageSummary(now).series;
  const cur = s.slice(-n).reduce((a, d) => a + d.total, 0);
  const prevSlice = s.slice(-n * 2, -n);
  const prev = prevSlice.reduce((a, d) => a + d.total, 0);
  return {
    days: n,
    current: cur,
    previous: prev,
    deltaPct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
    comparable: prevSlice.length === n,
  };
}
