// Prompt library: prompt favorit yang bisa dipakai ulang dari composer.
// Mirip notes — datar, tanpa folder, sort pinned dulu lalu terbaru.
import { readJson, writeJson, newId } from './store.js';

function all() {
  const data = readJson('prompts.json', []);
  return Array.isArray(data) ? data : [];
}

function save(list) {
  writeJson('prompts.json', list.slice(0, 200));
}

export function listPrompts() {
  return all().sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function createPrompt({ title, body, pinned } = {}) {
  const clean = String(body || '').trim();
  if (!clean) throw new Error('isi prompt wajib');
  const now = Date.now();
  const prompt = {
    id: newId(),
    title: String(title || clean.split('\n')[0]).slice(0, 120),
    body: clean.slice(0, 8000),
    pinned: !!pinned,
    createdAt: now,
    updatedAt: now,
  };
  const list = all();
  list.unshift(prompt);
  save(list);
  return prompt;
}

export function patchPrompt(id, patch = {}) {
  const list = all();
  const prompt = list.find((p) => p.id === id);
  if (!prompt) throw new Error('Prompt tidak ditemukan');
  if (typeof patch.title === 'string') prompt.title = patch.title.slice(0, 120);
  if (typeof patch.body === 'string') {
    const clean = patch.body.trim();
    if (!clean) throw new Error('isi prompt wajib');
    prompt.body = clean.slice(0, 8000);
  }
  if (typeof patch.pinned === 'boolean') prompt.pinned = patch.pinned;
  prompt.updatedAt = Date.now();
  save(list);
  return prompt;
}

export function deletePrompt(id) {
  const list = all().filter((p) => p.id !== id);
  save(list);
  return list.length;
}
