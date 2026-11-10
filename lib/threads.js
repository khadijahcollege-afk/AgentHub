// Threads: percakapan chat per proyek (Studio).
import { readJson, writeJson, newId } from './store.js';

const MAX_THREADS = 500;

function file() {
  return readJson('threads.json', []);
}

function save(all) {
  writeJson('threads.json', all.slice(0, MAX_THREADS));
}

export function listThreads() {
  return file()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      kind: t.kind || 'chat',
      engine: t.engine,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      messages: t.messages?.length || 0,
      preview: (t.messages?.[t.messages.length - 1]?.content || '').slice(0, 120),
      running: !!t.running,
    }));
}

export function getThread(id) {
  return file().find((t) => t.id === id) || null;
}

export function createThread({ title, projectId, engine, kind = 'chat' }) {
  const all = file();
  const t = {
    id: newId(),
    title: (title || 'Chat baru').slice(0, 80),
    projectId: projectId || 'default',
    kind,
    engine: engine || 'pool',
    messages: [],
    running: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(t);
  save(all);
  return t;
}

export function appendMessage(id, msg) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Thread tidak ditemukan');
  const m = { id: newId(), ts: Date.now(), ...msg };
  t.messages = [...(t.messages || []), m];
  t.updatedAt = Date.now();
  // judul otomatis dari pesan user pertama
  if (m.role === 'user' && (t.title === 'Chat baru' || !t.title)) {
    t.title = String(m.content).replace(/\s+/g, ' ').slice(0, 60);
  }
  save(all);
  return m;
}

export function patchThread(id, patch) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Thread tidak ditemukan');
  Object.assign(t, patch, { updatedAt: Date.now() });
  save(all);
  return t;
}

// perbarui sub-run terakhir milik engine tertentu (dipakai delegation)
export function updateSubrun(id, engine, patch) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Thread tidak ditemukan');
  const msgs = t.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].subrun && msgs[i].engine === engine) {
      Object.assign(msgs[i], patch, { ts: Date.now() });
      break;
    }
  }
  t.updatedAt = Date.now();
  save(all);
  return t;
}

export function deleteThread(id) {
  const all = file().filter((t) => t.id !== id);
  save(all);
  return all.length;
}
