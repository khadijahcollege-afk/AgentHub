// lib/machines.js — definisi tunggal untuk semua state machine AgentHub.
//
// Kenapa file ini ada: sebelumnya aturan transisi tersebar sebagai array
// (`STATUSES`), string literal (`'working'`, `'done'`, `'error'`), dan
// `data-move="±1"` di UI. Itu membuat tiga hal mahal:
//   - server tidak bisa menolak transisi ilegal (task bisa lompat inbox→running)
//   - UI tidak tahu tombol mana yang sah sebelum user menekannya
//   - agent/AX tidak punya kontrak yang bisa dibaca mesin
//
// Semua definisi di bawah dipakai bersama oleh server (validasi) dan klien
// (label, tombol, urutan). Nol dependency, ESM, aman untuk browser lewat
// /public/machines.js (file itu re-export dari sini lewat build-time copy).
//
// Bentuk umum:
//   { id, initial, states: {name: {label, ...}}, transitions: {from: [to]} }

// ---------- TASK ----------
// Strict linear: inbox → todo → running → review → done.
// `done` adalah sink: tidak ada jalan keluar (riwayat tetap ada di thread).
export const TASK_STATUSES = ['inbox', 'todo', 'running', 'review', 'done'];

export const TASK_LABELS = {
  inbox: 'Inbox',
  todo: 'To do',
  running: 'Running',
  review: 'Needs review',
  done: 'Recently done',
};

export const TASK_MACHINE = {
  id: 'task',
  initial: 'inbox',
  terminal: ['done'],
  states: TASK_LABELS,
  transitions: {
    inbox: ['todo'],
    todo: ['running'],
    running: ['review'],
    review: ['done'],
    done: [],
  },
};

export function taskCanMove(from, to) {
  return (TASK_MACHINE.transitions[from] || []).includes(to);
}

export function taskNext(status, dir = 1) {
  const i = TASK_STATUSES.indexOf(status);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < TASK_STATUSES.length ? TASK_STATUSES[j] : null;
}

// ---------- RUN (thread / subrun) ----------
// Satu run = satu prompt yang dikirim ke satu engine.
// idle → running → (done | error | stopped) → idle (indikator direset).
// Dari state akhir, `running` juga boleh langsung: itu tombol "coba lagi".
export const RUN_MACHINE = {
  id: 'run',
  initial: 'idle',
  terminal: ['done', 'error', 'stopped'],
  states: { idle: 'Idle', running: 'Working', done: 'Done', error: 'Error', stopped: 'Dihentikan' },
  transitions: {
    idle: ['running'],
    running: ['done', 'error', 'stopped'],
    done: ['idle', 'running'],
    error: ['idle', 'running'],
    stopped: ['idle', 'running'],
  },
};

export function runIsTerminal(status) {
  return RUN_MACHINE.terminal.includes(status);
}

// ---------- KEY (provider API key) ----------
export const KEY_MACHINE = {
  id: 'key',
  initial: 'unknown',
  terminal: [],
  states: {
    unknown: 'Belum dicek',
    valid: 'Key valid',
    invalid: 'Key ditolak',
    error: 'Gagal diperiksa',
    checking: 'Memeriksa…',
  },
  transitions: {
    unknown: ['checking', 'valid', 'invalid', 'error'],
    checking: ['valid', 'invalid', 'error'],
    valid: ['checking', 'invalid', 'error'],
    invalid: ['checking', 'valid', 'error'],
    error: ['checking', 'valid', 'invalid'],
  },
};

// key dianggap bisa dipakai pool hanya saat status ini
export const KEY_POOL_ELIGIBLE = ['valid', 'unknown'];

// ---------- AGENT (konektor) ----------
export const AGENT_MACHINE = {
  id: 'agent',
  initial: 'unknown',
  terminal: [],
  states: {
    unknown: 'Belum dicek',
    online: 'Online',
    error: 'Error',
    checking: 'Memeriksa…',
    triggering: 'Mengirim…',
  },
  transitions: {
    unknown: ['checking', 'triggering', 'online', 'error'],
    checking: ['online', 'error'],
    triggering: ['online', 'error'],
    online: ['checking', 'triggering', 'error'],
    error: ['checking', 'triggering', 'online'],
  },
};

// ---------- CONNECTION (transport UI ↔ server) ----------
// Ini yang dulu tidak ada sama sekali: UI tidak pernah tahu server mati.
export const CONNECTION_MACHINE = {
  id: 'connection',
  initial: 'connecting',
  terminal: [],
  states: {
    connecting: 'Menghubungkan…',
    live: 'Terhubung',
    degraded: 'Koneksi terputus — mencoba lagi',
    offline: 'Server tidak terjangkau',
    unauthorized: 'Token tidak valid',
  },
  transitions: {
    connecting: ['live', 'degraded', 'offline', 'unauthorized'],
    live: ['degraded', 'offline', 'unauthorized'],
    degraded: ['live', 'offline', 'unauthorized'],
    offline: ['connecting', 'live', 'degraded'],
    unauthorized: ['connecting', 'live'],
  },
};

// ---------- PROMO SOURCE ----------
export const PROMO_MACHINE = {
  id: 'promo',
  initial: 'idle',
  terminal: [],
  states: { idle: 'Siap', refreshing: 'Memperbarui…', error: 'Gagal diperbarui', ready: 'Terbaru' },
  transitions: {
    idle: ['refreshing'],
    refreshing: ['ready', 'error'],
    ready: ['refreshing', 'idle'],
    error: ['refreshing', 'idle'],
  },
};

// ---------- URI / OVERLAY (satu overlay aktif pada satu waktu) ----------
export const UI_LAYERS = ['usage', 'env', 'qr', 'delegate', 'note', 'adopt'];
export const UI_MACHINE = {
  id: 'ui',
  initial: null,
  terminal: [],
  states: Object.fromEntries(UI_LAYERS.map((l) => [l, l])),
  transitions: {
    null: UI_LAYERS,
    ...Object.fromEntries(UI_LAYERS.map((l) => [l, [null, ...UI_LAYERS.filter((x) => x !== l)]])),
  },
};

// ---------- VIEW / ROUTE ----------
export const VIEWS = ['studio', 'tasks', 'notes', 'promo', 'keys', 'gateway', 'agents', 'alerts', 'settings'];
export const VIEW_MACHINE = {
  id: 'view',
  initial: 'studio',
  terminal: [],
  states: Object.fromEntries(VIEWS.map((v) => [v, v])),
  transitions: Object.fromEntries(VIEWS.map((v) => [v, VIEWS.filter((x) => x !== v)])),
};

// ---------- SSE SCOPE → apa yang harus di-refresh ----------
// Satu tabel. Dulu string scope tersebar di server (broadcast) dan klien (if-scope).
// Nilai = daftar slice state yang terpengaruh; klien memakainya untuk render
// selektif, bukan `loadState()` penuh tiap event.
export const SSE_SCOPES = {
  hello: [],
  threads: ['threads'],
  tasks: ['tasks'],
  notes: ['notes'],
  keys: ['keys', 'pool'],
  pool: ['pool', 'keys'],
  agents: ['agents'],
  alerts: ['alerts'],
  promo: ['promo', 'snapshot'],
  config: ['config', 'server'],
};

export function scopeSlices(scope) {
  return SSE_SCOPES[scope] || ['all'];
}
