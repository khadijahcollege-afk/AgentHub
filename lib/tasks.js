// Tasks: papan tugas kanban (inbox / todo / running / review / done).
import { readJson, writeJson, newId } from './store.js';

export const STATUSES = ['inbox', 'todo', 'running', 'review', 'done'];

function file() {
  return readJson('tasks.json', []);
}

function save(all) {
  writeJson('tasks.json', all.slice(0, 1000));
}

export function listTasks() {
  return file().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function createTask({ title, projectId, threadId, status = 'todo' }) {
  const all = file();
  const t = {
    id: newId(),
    title: String(title || '').slice(0, 200),
    status: STATUSES.includes(status) ? status : 'todo',
    projectId: projectId || 'default',
    threadId: threadId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(t);
  save(all);
  return t;
}

export function patchTask(id, patch) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Task tidak ditemukan');
  if (patch.status && STATUSES.includes(patch.status)) t.status = patch.status;
  if (typeof patch.title === 'string') t.title = patch.title.slice(0, 200);
  t.updatedAt = Date.now();
  save(all);
  return t;
}

export function deleteTask(id) {
  const all = file().filter((t) => t.id !== id);
  save(all);
  return all.length;
}
