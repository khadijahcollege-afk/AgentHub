// lib/search.js — satu pencarian untuk semua yang dimiliki aplikasi.
//
// Sebelumnya pencarian hanya menyaring judul thread di memori UI, sehingga
// keputusan di catatan, judul tugas, atau folder proyek tidak bisa ditemukan.
// Modul ini membaca sumber yang sudah ada (threads/tasks/notes/projects) dan
// mengembalikan hasil terkelompok dengan potongan konteks.
//
// Read-only, tanpa indeks baru: cukup untuk skala data lokal AgentHub dan tidak
// menambah file yang harus dimigrasikan. Kueri dicocokkan dengan indexOf
// (case-insensitive), bukan RegExp, supaya karakter seperti `[` tidak error.
import { allThreads } from './threads.js';
import { listTasks } from './tasks.js';
import { listNotes } from './notes.js';
import { listProjects } from './projects.js';

const MAX_QUERY = 120;
const MAX_SNIPPET_SOURCE = 12000;
const MAX_MESSAGES_PER_THREAD = 60;

export function normalizeQuery(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

// Potongan di sekitar kecocokan. Teks diratakan dulu agar cuplikan tidak
// mengandung baris baru yang merusak tinggi baris hasil.
export function snippet(text, query, radius = 52) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const at = src.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (at < 0) return src.length > radius * 2 ? src.slice(0, radius * 2) + '…' : src;
  const start = Math.max(0, at - radius);
  const end = Math.min(src.length, at + String(query).length + radius);
  return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
}

function hitThread(t, q) {
  const title = String(t.title || '');
  if (title.toLowerCase().includes(q)) {
    return { where: 'judul', snippet: snippet(title, q), role: null };
  }
  const msgs = Array.isArray(t.messages) ? t.messages.slice(-MAX_MESSAGES_PER_THREAD) : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const content = String(msgs[i]?.content || '').slice(0, MAX_SNIPPET_SOURCE);
    if (!content || !content.toLowerCase().includes(q)) continue;
    return {
      where: msgs[i].role === 'user' ? 'pesan Anda' : 'jawaban agent',
      snippet: snippet(content, q),
      role: msgs[i].role || null,
    };
  }
  return null;
}

// q sudah dinormalisasi & lowercase oleh pemanggil.
export function searchAll(rawQuery, { limit = 8 } = {}) {
  const q = normalizeQuery(rawQuery);
  const cap = Math.min(20, Math.max(1, Number(limit) || 8));
  const empty = { q, total: 0, groups: { threads: [], tasks: [], notes: [], projects: [] }, truncated: false };
  // Satu huruf menghasilkan hampir semua baris; UI menahan sampai 2 huruf.
  if (q.length < 2) return empty;
  const needle = q.toLowerCase();

  const threadHits = [];
  for (const t of allThreads().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const hit = hitThread(t, needle);
    if (!hit) continue;
    threadHits.push({
      id: t.id,
      title: t.title || 'Chat baru',
      projectId: t.projectId || 'default',
      engine: t.engine || null,
      updatedAt: t.updatedAt || null,
      ...hit,
    });
  }

  const taskHits = listTasks()
    .filter((t) => String(t.title || '').toLowerCase().includes(needle))
    .map((t) => ({
      id: t.id,
      title: t.title || 'Tugas',
      status: t.status || 'todo',
      projectId: t.projectId || 'default',
      updatedAt: t.updatedAt || null,
      snippet: snippet(t.title, q),
    }));

  const noteHits = listNotes()
    .filter((n) => `${n.title || ''} ${n.body || ''}`.toLowerCase().includes(needle))
    .map((n) => ({
      id: n.id,
      title: n.title || 'Untitled',
      projectId: n.projectId || 'global',
      updatedAt: n.updatedAt || null,
      where: String(n.title || '').toLowerCase().includes(needle) ? 'judul' : 'isi catatan',
      snippet: snippet(`${n.title || ''} ${n.body || ''}`.trim(), q),
    }));

  const projectHits = listProjects()
    .filter((p) => `${p.name || ''} ${(p.folders || []).join(' ')}`.toLowerCase().includes(needle))
    .map((p) => ({
      id: p.id,
      name: p.name || 'Proyek',
      folders: p.folders || [],
      primaryFolder: p.primaryFolder || null,
      snippet: snippet(`${p.name || ''} ${(p.folders || []).join(' ')}`.trim(), q),
    }));

  const groups = {
    threads: threadHits.slice(0, cap),
    tasks: taskHits.slice(0, cap),
    notes: noteHits.slice(0, cap),
    projects: projectHits.slice(0, cap),
  };
  const total = Object.values(groups).reduce((n, list) => n + list.length, 0);
  return {
    q,
    total,
    groups,
    // true bila ada hasil yang tidak ditampilkan karena batas per grup.
    truncated: threadHits.length > cap || taskHits.length > cap || noteHits.length > cap || projectHits.length > cap,
  };
}
