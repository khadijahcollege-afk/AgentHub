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
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      kind: t.kind || 'chat',
      engine: t.engine,
      cwd: t.cwd || null,
      pinned: !!t.pinned,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      messages: t.messages?.length || 0,
      preview: (t.messages?.[t.messages.length - 1]?.content || '').slice(0, 120),
      running: t.runState === 'running' || !!t.running,
      runState: t.runState || (t.running ? 'running' : 'idle'),
      runStartedAt: t.runStartedAt || null,
      runEndedAt: t.runEndedAt || null,
      runError: t.runError || null,
    }));
}

// Thread lengkap (termasuk messages) untuk pencarian & fitur yang butuh isi.
// listThreads sengaja tetap ringan karena dipakai sidebar setiap render.
export function allThreads() {
  return file();
}

export function getThread(id) {
  return file().find((t) => t.id === id) || null;
}

export function createThread({ title, projectId, engine, kind = 'chat', cwd = null }) {
  const all = file();
  const t = {
    id: newId(),
    title: (title || 'Chat baru').slice(0, 80),
    projectId: projectId || 'default',
    kind,
    engine: engine || 'pool',
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    messages: [],
    running: false,
    runState: 'idle',
    runStartedAt: null,
    runEndedAt: null,
    runError: null,
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
  // judul otomatis dari pesan user pertama. Pesan berisi lampiran saja tetap
  // mendapat judul dari nama file, bukan judul kosong.
  if (m.role === 'user' && (t.title === 'Chat baru' || !t.title)) {
    const text = String(m.content || '').trim()
      || (Array.isArray(m.attachments) ? m.attachments.map((a) => a.name).filter(Boolean).join(', ') : '');
    if (text) t.title = text.replace(/\s+/g, ' ').slice(0, 60);
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
