// Notes: catatan cepat per proyek, tampil seperti papan di Kybern.
// Bentuknya sengaja datar (tanpa folder) — satu catatan = satu kartu.
import { readJson, writeJson, newId } from './store.js';

function all() {
  const data = readJson('notes.json', []);
  return Array.isArray(data) ? data : [];
}

function save(list) {
  writeJson('notes.json', list.slice(0, 500));
}

export function listNotes() {
  return all().sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function createNote({ title, body, projectId, pinned } = {}) {
  const now = Date.now();
  const note = {
    id: newId(),
    title: String(title || '').slice(0, 160),
    body: String(body || '').slice(0, 40000),
    projectId: String(projectId || 'global').slice(0, 80),
    pinned: !!pinned,
    createdAt: now,
    updatedAt: now,
  };
  const list = all();
  list.unshift(note);
  save(list);
  return note;
}

export function patchNote(id, patch = {}) {
  const list = all();
  const note = list.find((n) => n.id === id);
  if (!note) throw new Error('Catatan tidak ditemukan');
  if (typeof patch.title === 'string') note.title = patch.title.slice(0, 160);
  if (typeof patch.body === 'string') note.body = patch.body.slice(0, 40000);
  if (typeof patch.projectId === 'string') note.projectId = patch.projectId.slice(0, 80) || 'global';
  if (typeof patch.pinned === 'boolean') note.pinned = patch.pinned;
  note.updatedAt = Date.now();
  save(list);
  return note;
}

export function deleteNote(id) {
  const list = all().filter((n) => n.id !== id);
  save(list);
  return list.length;
}
