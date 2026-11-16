// lib/memory.js — memori jangka panjang agent: fakta ringkas yang otomatis
// disuntikkan ke setiap prompt yang dikirim (ala "Memory" ChatGPT dan
// CLAUDE.md-nya Claude). Satu sumber kebenaran: memory.json di folder data.
import { readJson, writeJson, newId } from './store.js';

const FILE = 'memory.json';
const MAX_FACTS = 200;
const MAX_LEN = 500;

function all() { const d = readJson(FILE, []); return Array.isArray(d) ? d : []; }
function save(list) { writeJson(FILE, list.slice(0, MAX_FACTS)); }

// Fakta: satu kalimat, whitespace diratakan, dibatasi panjang.
export function sanitizeFact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

export function listMemory() {
  return all().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export class MemoryError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

export function addMemory(text, { source = 'manual', threadId = null } = {}) {
  const content = sanitizeFact(text);
  if (!content) throw new MemoryError('Fakta tidak boleh kosong');
  const list = all();
  const key = content.toLowerCase();
  const existing = list.find((f) => (f.text || '').toLowerCase() === key);
  if (existing) {
    // duplikat: perbarui timestamp & sumber, jangan tumpuk entri kembar
    existing.createdAt = Date.now();
    existing.source = source;
    if (threadId) existing.threadId = threadId;
    save(list);
    return existing;
  }
  const fact = { id: newId(), text: content, source, threadId: threadId || null, createdAt: Date.now() };
  list.push(fact);
  save(list);
  return fact;
}

export function deleteMemory(id) {
  const list = all();
  const idx = list.findIndex((f) => f.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  save(list);
  return true;
}

export function clearMemory() {
  save([]);
}

// Blok konteks untuk disuntikkan ke prompt. Kosong bila tidak ada fakta —
// pemanggil tidak perlu mengecek isi memory.json dulu.
export function memoryContext(limit = 40) {
  const facts = all().slice(-limit); // yang terlama di atas, terbaru di bawah
  if (!facts.length) return '';
  return [
    '## Memori pengguna (AgentHub — fakta jangka panjang)',
    'Gunakan bila relevan; jangan sebut ulang apa adanya.',
    ...facts.map((f) => `- ${f.text}`),
  ].join('\n');
}
