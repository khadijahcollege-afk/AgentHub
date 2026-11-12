// Project metadata only: folders, tasks, and threads are never removed here.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson, writeJson, newId } from './store.js';

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function objectInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'Project must be a JSON object');
  }
}

function folderPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)
      || (process.platform === 'win32' && path.parse(value).root.length === 1)) {
    fail(400, 'Folders must be absolute directory paths');
  }
  return path.resolve(value);
}

function folderKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function fields(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) {
    fail(400, 'Project name is required and must be at most 100 characters');
  }
  if (!Array.isArray(input.folders) || !input.folders.length) {
    fail(400, 'At least one existing directory is required');
  }
  const folders = [];
  const seen = new Set();
  for (const value of input.folders) {
    const folder = folderPath(value);
    let directory = false;
    try { directory = fs.statSync(folder).isDirectory(); } catch { /* missing or inaccessible */ }
    if (!directory) fail(400, 'Every folder must be an existing directory');
    const key = folderKey(folder);
    if (!seen.has(key)) { seen.add(key); folders.push(folder); }
  }
  const primary = folderPath(input.primaryFolder === undefined ? folders[0] : input.primaryFolder);
  const primaryFolder = folders.find((folder) => folderKey(folder) === folderKey(primary));
  if (!primaryFolder) fail(400, 'Primary folder must be a member of folders');
  return { name: input.name.trim(), folders, primaryFolder };
}

export function listProjects() {
  const list = readJson('projects.json', []);
  return Array.isArray(list) ? list : [];
}

export function getProject(id) {
  return listProjects().find((project) => project.id === id) || null;
}

export function createProject(input = {}) {
  objectInput(input);
  const values = fields(input);
  const now = Date.now();
  const project = { id: newId(), ...values, createdAt: now, updatedAt: now };
  const list = listProjects();
  list.push(project);
  writeJson('projects.json', list);
  return project;
}

export function patchProject(id, input = {}) {
  const list = listProjects();
  const project = list.find((entry) => entry.id === id);
  if (!project) fail(404, 'Project not found');
  objectInput(input);
  // Keep the current primary unless explicitly replaced, including on folder edits.
  const values = fields({
    name: input.name === undefined ? project.name : input.name,
    folders: input.folders === undefined ? project.folders : input.folders,
    primaryFolder: input.primaryFolder === undefined ? project.primaryFolder : input.primaryFolder,
  });
  Object.assign(project, values, { updatedAt: Date.now() });
  writeJson('projects.json', list);
  return project;
}

export function deleteProject(id) {
  const list = listProjects();
  if (!list.some((project) => project.id === id)) fail(404, 'Project not found');
  writeJson('projects.json', list.filter((project) => project.id !== id));
}

export async function getProjectContext(id) {
  const project = getProject(id);
  if (!project) fail(404, 'Project not found');
  return contextForCwd(project.primaryFolder);
}

// symbolic-ref + status --porcelain hanya membaca metadata lokal; tanpa fetch,
// hook, atau shell. Unborn branch tetap bekerja; repo hilang/detached → null.
export async function contextForCwd(cwd) {
  const dir = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : null;
  if (!dir || !fs.existsSync(dir)) return { branch: null, cwd: dir || null, changes: null };
  const git = (args, maxBuffer = 16 * 1024) => new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', ...args], {
      cwd: dir, timeout: 2000, maxBuffer, encoding: 'utf8', windowsHide: true, shell: false,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
  const out = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = out ? (out.trim() || null) : null;
  const status = await git(['status', '--porcelain'], 64 * 1024);
  // stdout kosong ("" → falsy) berarti repo bersih: 0 perubahan, bukan null.
  const changes = status === null ? null : status.split('\n').filter(Boolean).length;
  return { branch, cwd: dir, changes };
}
