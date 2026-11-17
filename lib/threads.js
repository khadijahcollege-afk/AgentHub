// Threads: percakapan chat per proyek (Studio).
import { readJson, writeJson, newId } from './store.js';

const MAX_THREADS = 500;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;

// tag: array string pendek, unik, di-trim, dibatasi jumlah & panjang.
export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    const v = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

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
      tags: Array.isArray(t.tags) ? t.tags : [],
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      messages: t.messages?.length || 0,
      preview: (t.messages?.[t.messages.length - 1]?.content || '').slice(0, 120),
      running: t.runState === 'running' || !!t.running,
      runState: t.runState || (t.running ? 'running' : 'idle'),
      runStartedAt: t.runStartedAt || null,
      runEndedAt: t.runEndedAt || null,
      runError: t.runError || null,
      // Ringkasan konteks: hanya penandanya, bukan teksnya. Sidebar butuh tahu
      // apakah thread sudah diringkas (untuk chip), tetapi mengirim ringkasan
      // penuh ke setiap render sidebar berarti membayar payload itu terus-menerus.
      compacted: !!t.compact?.summary,
      compactMessages: t.compact?.messages || 0,
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

export function createThread({ title, projectId, engine, kind = 'chat', cwd = null, tags = null }) {
  const all = file();
  const t = {
    id: newId(),
    title: (title || 'Chat baru').slice(0, 80),
    projectId: projectId || 'default',
    kind,
    engine: engine || 'pool',
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    tags: sanitizeTags(tags),
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

// set tag thread (validasi & persist). Dipakai UI untuk tambah/hapus tag.
export function setThreadTags(id, tags) {
  const all = file();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Thread tidak ditemukan');
  t.tags = sanitizeTags(tags);
  t.updatedAt = Date.now();
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

// Fork/cabang percakapan (ala ChatGPT "edit message" & Claude "retry from
// here"): salin thread sampai pesan `until` — termasuk bila include, tanpa
// pesan itu bila tidak (mode edit: isi pesan lama dikembalikan ke composer).
// Mengembalikan thread baru; thread asli tidak tersentuh.
export function forkThread(id, { until = null, include = true, title = null } = {}) {
  const src = getThread(id);
  if (!src) throw new Error('Thread tidak ditemukan');
  let msgs = src.messages || [];
  if (until) {
    const idx = msgs.findIndex((x) => x.id === until);
    if (idx === -1) throw new Error('Pesan acuan tidak ditemukan');
    msgs = msgs.slice(0, include ? idx + 1 : idx);
  }
  const copy = createThread({
    title: title || (src.title ? `${src.title} (cabang)` : 'Chat baru (cabang)'),
    projectId: src.projectId,
    engine: src.engine,
    kind: src.kind || 'chat',
    cwd: src.cwd || null,
    tags: src.tags || null,
  });
  patchThread(copy.id, { systemPrompt: src.systemPrompt || null });
  const all = file();
  const t = all.find((x) => x.id === copy.id);
  t.messages = msgs.map((m) => ({ ...m, id: newId() }));
  t.updatedAt = Date.now();
  save(all);
  return getThread(copy.id);
}

// Ekspor percakapan: markdown siap-baca dan JSON lengkap (untuk arsip/migrasi).
export function exportThread(id, format = 'md') {
  const t = getThread(id);
  if (!t) throw new Error('Thread tidak ditemukan');
  const msgs = t.messages || [];
  if (format === 'json') {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: 'AgentHub', version: 1,
      thread: { ...t },
    }, null, 2);
  }
  const engineLabel = (e) => String(e || 'pool');
  const lines = [
    `# ${t.title || 'Chat'}`,
    '',
    `- Tanggal: ${new Date(t.createdAt).toISOString()}`,
    `- Engine: ${engineLabel(t.engine)}`,
    t.cwd ? `- Folder: ${t.cwd}` : '',
    Array.isArray(t.tags) && t.tags.length ? `- Tag: ${t.tags.join(', ')}` : '',
    '',
    '---',
    '',
  ].filter(Boolean);
  for (const m of msgs) {
    const when = m.ts ? new Date(m.ts).toISOString() : '';
    if (m.role === 'user') {
      lines.push(`## Pengguna ${when ? `(${when})` : ''}`.trimEnd());
      lines.push('', String(m.content || ''), '');
    } else if (m.subrun) {
      lines.push(`### Agent: ${engineLabel(m.engine)} ${when ? `(${when})` : ''}`.trimEnd());
      lines.push('', String(m.content || ''), '');
    } else {
      lines.push(`## Assistant (${engineLabel(m.engine)}) ${when ? `(${when})` : ''}`.trimEnd());
      lines.push('', String(m.content || ''), '');
    }
  }
  return lines.join('\n');
}
