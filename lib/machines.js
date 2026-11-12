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

// Versi kontrak. Naikkan bila state/transisi berubah agar agent bisa memeriksa
// kompatibilitas lewat /api/version sebelum mengemudikan UI.
export const MACHINE_VERSION = 4;

// Aturan yang dipakai semua mesin: transisi ke state yang sama selalu sah
// (idempoten), selain itu hanya edge yang tercantum di `transitions`.
export function canTransition(machine, from, to) {
  if (from === to) return true;
  return (machine.transitions[from] || []).includes(to);
}

export function allowedNext(machine, from) {
  return machine.transitions[from] || [];
}

// Error transisi yang bisa dipetakan route ke 409 tanpa menebak pesan.
export function transitionError(machine, from, to) {
  const allowed = allowedNext(machine, from);
  const error = new Error(allowed.length
    ? `${machine.id}: "${from}" hanya bisa pindah ke: ${allowed.join(', ')} (diminta: ${to})`
    : `${machine.id}: "${from}" bersifat final — tidak bisa pindah ke "${to}"`);
  error.name = 'IllegalTransition';
  error.code = 'ILLEGAL_TRANSITION';
  error.machine = machine.id;
  error.from = from;
  error.to = to;
  error.allowed = allowed;
  return error;
}

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

export const RUN_STATES = Object.keys(RUN_MACHINE.states);

export function runCanTransition(from, to) {
  return canTransition(RUN_MACHINE, from, to);
}

// ---------- STEP (satu pesan assistant / subrun dalam delegation) ----------
// State ini yang tampil di kartu delegation dan di thread. Dulu UI memakai
// string `'working' | 'done' | 'error'` tanpa aturan; sekarang punya mesin.
export const STEP_MACHINE = {
  id: 'step',
  initial: 'working',
  terminal: ['done', 'error', 'stopped'],
  states: { working: 'Working', done: 'Done', error: 'Failed', stopped: 'Dihentikan' },
  transitions: {
    working: ['done', 'error', 'stopped'],
    done: ['working'],
    error: ['working'],
    stopped: ['working'],
  },
};

export function stepIsTerminal(status) {
  return STEP_MACHINE.terminal.includes(status || 'working');
}

// ---------- DELEGATION (satu prompt → banyak engine) ----------
// idle → starting → running → (done | error | stopped) → idle.
// Server memakai `running` untuk thread; klien memakai status ini untuk
// mengunci tombol dan menampilkan tombol "Hentikan" alih-alih "Batal".
export const DELEGATION_MACHINE = {
  id: 'delegation',
  initial: 'idle',
  terminal: ['done', 'error', 'stopped'],
  states: {
    idle: 'Siap',
    starting: 'Menyiapkan…',
    running: 'Berjalan…',
    done: 'Selesai',
    error: 'Gagal',
    stopped: 'Dihentikan',
  },
  transitions: {
    idle: ['starting'],
    starting: ['running', 'done', 'error', 'stopped'],
    running: ['done', 'error', 'stopped'],
    done: ['starting', 'idle'],
    error: ['starting', 'idle'],
    stopped: ['starting', 'idle'],
  },
};

// ---------- NOTE EDITOR ----------
// closed → editing ⇄ dirty → saving → closed/editing.
// Menutup saat `dirty` harus dikonfirmasi; dulu Esc menghapus tulisan tanpa jejak.
export const NOTE_EDITOR_MACHINE = {
  id: 'noteEditor',
  initial: 'closed',
  terminal: ['closed'],
  states: { closed: 'Tertutup', editing: 'Mengedit', dirty: 'Belum disimpan', saving: 'Menyimpan…' },
  transitions: {
    closed: ['editing'],
    editing: ['dirty', 'saving', 'closed'],
    dirty: ['dirty', 'saving', 'editing', 'closed'],
    saving: ['closed', 'dirty', 'editing'],
  },
};

export function noteEditorCanLeave(state) {
  return state === 'closed' || state === 'saving';
}

// ---------- WORKSPACE / PERUBAHAN FILE ----------
// Status perubahan file berasal dari `git status`. Dideklarasikan di sini karena
// UI (drawer Perubahan), server (revert), dan agent (kontrak) harus memakai
// kosakata yang sama. Ini bukan mesin transisi: satu file bisa berpindah status
// kapan saja saat user/agent mengedit, tanpa urutan yang bermakna.
export const CHANGE_STATUSES = ['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflict'];

// File aturan/memory yang dibaca agent populer. Hanya nama ini yang boleh ditulis
// lewat API; path bebas akan menjadi izin tulis ke seluruh repo.
export const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'];

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

// Status key yang boleh DICOBA oleh gateway. Key yang pernah error tetap
// dicoba (provider bisa pulih); hanya `invalid` yang dibuang. Sebelumnya aturan
// ini tersebar sebagai `status !== 'invalid'` di pool.js.
export const KEY_POOL_CANDIDATE = ['valid', 'unknown', 'error', 'checking'];
// Status yang dihitung "siap" di UI pool.
export const KEY_POOL_ACTIVE = ['valid'];
// Status yang modelnya boleh muncul di GET /v1/models.
export const KEY_MODEL_VISIBLE = ['valid', 'unknown'];
// Nama lama dipertahankan untuk kompatibilitas; artinya = kandidat pool.
export const KEY_POOL_ELIGIBLE = KEY_POOL_CANDIDATE;

export function keyPoolCandidate(status) {
  return KEY_POOL_CANDIDATE.includes(status);
}

export function keyPoolActive(status) {
  return KEY_POOL_ACTIVE.includes(status);
}

export function keyModelVisible(status) {
  return KEY_MODEL_VISIBLE.includes(status);
}

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

// ---------- PROMO PASS (kartu klaim → Start Plan) ----------
// `available` = belum diklaim. Setelah klaim, waktu menentukan apakah tiket
// masih menunggu jadwal (`pending`), sedang berjalan (`active`), atau habis.
// `expired` final: kartu tetap bisa dilihat sebagai riwayat, bukan dipakai.
export const PROMO_PASS_MACHINE = {
  id: 'promoPass',
  initial: 'available',
  terminal: ['expired'],
  states: {
    available: 'Tersedia',
    pending: 'Menunggu jadwal',
    active: 'Aktif',
    expired: 'Kedaluwarsa',
  },
  transitions: {
    available: ['pending', 'active'],
    pending: ['active', 'expired'],
    active: ['expired'],
    expired: [],
  },
};

// ---------- URI / OVERLAY (satu overlay aktif pada satu waktu) ----------
// project/projectEdit = pemilih & editor proyek; models = katalog model
// gateway; effort = pilihan effort model. Semua mengikuti aturan yang sama:
// hanya satu layer aktif, Esc menutup.
export const UI_LAYERS = ['usage', 'env', 'qr', 'delegate', 'note', 'adopt', 'promoClaim', 'project', 'projectEdit', 'models', 'effort', 'engines', 'access', 'git', 'sbMenu', 'palette', 'search', 'mention', 'prompts', 'session', 'account', 'integrations', 'tools', 'shortcuts'];
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
  promoPass: ['promoPass'],
  config: ['config', 'server'],
  schedules: ['schedules'],
  workspace: ['workspace', 'threads'],
};

export function scopeSlices(scope) {
  return SSE_SCOPES[scope] || ['all'];
}
