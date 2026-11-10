// Tasks: papan tugas kanban (inbox / todo / running / review / done).
// Transisi status bukan lagi bebas: mesin status strict-linear dijaga di sini
// supaya UI dan agent tidak bisa melompat kolom (mis. inbox → running).
import { readJson, writeJson, newId } from './store.js';
import { TASK_STATUSES, TASK_LABELS, TASK_MACHINE, taskCanMove, taskNext } from './machines.js';

export const STATUSES = TASK_STATUSES;
export { TASK_LABELS, TASK_MACHINE, taskCanMove, taskNext };

// Dilempar saat patch.status bukan transisi yang sah. Route memetakannya ke 409.
export class IllegalTransition extends Error {
  constructor(id, from, to) {
    const allowed = TASK_MACHINE.transitions[from] || [];
    super(allowed.length
      ? `Status "${from}" hanya bisa pindah ke: ${allowed.join(', ')} (diminta: ${to})`
      : `Status "${from}" bersifat final — tidak bisa dipindah lagi`);
    this.name = 'IllegalTransition';
    this.code = 'ILLEGAL_TRANSITION';
    this.taskId = id;
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

function file() {
  return readJson('tasks.json', []);
}

function save(all) {
  writeJson('tasks.json', all.slice(0, 1000));
}

export function listTasks() {
  const all = file();
  let dirty = false;
  for (const t of all) { backfill(t); if (t._dirty) { delete t._dirty; dirty = true; } }
  if (dirty) save(all);
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Task lama (sebelum mesin ini ada) tidak punya `statusAt` per kolom.
// Isi sekali dari updatedAt supaya kolom "Recently done" tidak kosong.
function backfill(t) {
  if (!t.statusAt || typeof t.statusAt !== 'object') {
    t.statusAt = { [t.status || 'todo']: t.updatedAt || t.createdAt || Date.now() };
    t._dirty = true;
  }
  return t;
}

export function createTask({ title, projectId, threadId, status = 'todo' }) {
  const all = file();
  const now = Date.now();
  const st = STATUSES.includes(status) ? status : 'todo';
  const t = {
    id: newId(),
    title: String(title || '').slice(0, 200),
    status: st,
    projectId: projectId || 'default',
    threadId: threadId || null,
    createdAt: now,
    updatedAt: now,
    statusAt: { [st]: now },
  };
  all.push(t);
  save(all);
  return t;
}

export function patchTask(id, patch) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Task tidak ditemukan');
  backfill(t);
  delete t._dirty;
  const now = Date.now();
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new IllegalTransition(id, t.status, String(patch.status));
    }
    if (patch.status !== t.status) {
      if (!taskCanMove(t.status, patch.status)) throw new IllegalTransition(id, t.status, patch.status);
      t.status = patch.status;
      t.statusAt = { ...(t.statusAt || {}), [patch.status]: now };
    }
  }
  if (typeof patch.title === 'string') t.title = patch.title.slice(0, 200);
  t.updatedAt = now;
  save(all);
  return t;
}

export function deleteTask(id) {
  const all = file().filter((t) => t.id !== id);
  save(all);
  return all.length;
}
