// Environment bookmarks only. Saving a URL never connects to that environment.
import { readJson, writeJson, newId } from './store.js';

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function bookmarkUrl(value) {
  if (typeof value !== 'string') fail(400, 'Environment URL is required');
  const text = value.trim();
  // Inspect the raw URL too: URL() silently normalizes dot paths, empty ?/#,
  // empty credentials, and backslashes. None belong in a token-free bookmark.
  if (!/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(text) || /[\x00-\x20\x7f]/.test(text)) {
    fail(400, 'Use an http/https origin without credentials, path, query, or fragment');
  }
  let url;
  try { url = new URL(text); } catch { fail(400, 'Invalid environment URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    fail(400, 'Use an http/https origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function listEnvironments() {
  const list = readJson('environments.json', []);
  return Array.isArray(list) ? list : [];
}

// POST /api/environments creates without id, or patches an existing bookmark with id.
export function saveEnvironment(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'Environment must be a JSON object');
  }
  const list = listEnvironments();
  let current;
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !input.id) fail(400, 'Invalid environment id');
    current = list.find((entry) => entry.id === input.id);
    if (!current) fail(404, 'Environment not found');
  }
  const name = input.name === undefined ? current?.name : input.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    fail(400, 'Environment name is required and must be at most 100 characters');
  }
  const url = bookmarkUrl(input.url === undefined ? current?.url : input.url);
  const environment = { id: current?.id || newId(), name: name.trim(), url };
  if (current) list[list.indexOf(current)] = environment;
  else list.push(environment);
  writeJson('environments.json', list);
  return environment;
}

export function deleteEnvironment(id) {
  const list = listEnvironments();
  if (!list.some((entry) => entry.id === id)) fail(404, 'Environment not found');
  writeJson('environments.json', list.filter((entry) => entry.id !== id));
}
