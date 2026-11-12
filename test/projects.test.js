// Real HTTP server, isolated JSON data and folders, OS-selected free ports, no remote requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'isolated-projects-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tempDir, dataDir, first, second, third, regularFile, child, baseUrl;

function writeData(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
}

function readData(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

async function freePort() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer({ noGit = false } = {}) {
  const port = await freePort();
  writeData('config.json', {
    port, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true,
  });
  // Prevent startup refresh; empty agents/keys mean background checks have no targets.
  writeData('snapshot.json', {
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  });
  const env = { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tempDir, 'empty-gitconfig') };
  for (const key of Object.keys(env)) {
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT'].includes(key)) delete env[key];
    if (noGit && key.toLowerCase() === 'path') delete env[key];
  }
  if (noGit) env.PATH = tempDir;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null) throw new Error(`Server failed: ${spawnError || output}`);
    // The server can increment its port if another process claimed the reservation.
    baseUrl = `http://127.0.0.1:${readData('config.json').port}`;
    if (output.includes('AgentHub aktif')) {
      try {
        const res = await request('/api/projects');
        if (res.ok) { await res.json(); return; }
        await res.body?.cancel();
      } catch { /* still starting */ }
    }
    await sleep(50);
  }
  throw new Error(`Server did not start: ${output}`);
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  if (current.exitCode !== null || current.signalCode !== null) return;
  const closed = once(current, 'close');
  current.kill();
  await closed;
}

function request(route, { method = 'GET', body, rawBody, auth = true, signal } = {}) {
  return fetch(`${baseUrl}${route}`, {
    method, signal: signal || AbortSignal.timeout(10000),
    headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json' },
    body: rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody,
  });
}

async function json(route, options = {}, status = 200) {
  const res = await request(route, options);
  const body = await res.json();
  assert.equal(res.status, status, `${options.method || 'GET'} ${route}: ${JSON.stringify(body)}`);
  if (status >= 400) assert.equal(typeof body.error, 'string');
  return body;
}

const create = (body) => json('/api/projects', { method: 'POST', body });
const patch = (id, body) => json(`/api/projects/${id}`, { method: 'POST', body });
const remove = (id) => json(`/api/projects/${id}`, { method: 'DELETE' });
const bookmark = (body) => json('/api/environments', { method: 'POST', body });
const removeBookmark = (id) => json(`/api/environments/${id}`, { method: 'DELETE' });

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-projects-'));
  fs.writeFileSync(path.join(tempDir, 'empty-gitconfig'), '');
  dataDir = path.join(tempDir, 'data');
  first = path.join(tempDir, 'Folder A & B');
  second = path.join(tempDir, 'Folder Two');
  third = path.join(tempDir, 'Folder Three');
  for (const dir of [dataDir, first, second, third]) fs.mkdirSync(dir);
  regularFile = path.join(first, 'keep.txt');
  fs.writeFileSync(regularFile, 'Project files must survive metadata deletion');
  await startServer();
});

test.after(async () => {
  await stopServer();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('new routes use normal auth; empty collections appear in state and status', async () => {
  for (const [route, method] of [
    ['/api/projects', 'GET'], ['/api/projects', 'POST'], ['/api/projects/missing', 'POST'],
    ['/api/projects/missing', 'DELETE'], ['/api/projects/missing/context', 'GET'],
    ['/api/environments', 'GET'], ['/api/environments', 'POST'], ['/api/environments/missing', 'DELETE'],
  ]) await json(route, { method, auth: false }, 401);
  assert.deepEqual(await json('/api/projects'), []);
  assert.deepEqual(await json('/api/environments'), []);
  const state = await json('/api/state');
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.environments, []);
  const status = await json('/api/status');
  assert.equal(status.projects, 0);
  assert.equal(status.environments, 0);
});

test('projects normalize/dedupe folders, select primary, and patch only mutable fields', async () => {
  const folders = [first, `${first}${path.sep}.`, `${first}${path.sep}`, second];
  if (process.platform === 'win32') folders.push(first.toUpperCase().replaceAll('\\', '/'));
  const created = await create({ name: '  Example  ', folders, primaryFolder: `${second}${path.sep}.` });
  assert.match(created.id, /^[a-f0-9]{16}$/);
  assert.equal(created.name, 'Example');
  assert.deepEqual(created.folders, [first, second]);
  assert.equal(created.primaryFolder, second);
  assert.equal(typeof created.createdAt, 'number');
  assert.equal(created.updatedAt, created.createdAt);
  assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'folders', 'id', 'name', 'primaryFolder', 'updatedAt']);
  assert.deepEqual(await json(`/api/projects/${created.id}/context`), { branch: null, cwd: second, changes: null });

  const renamed = await patch(created.id, { name: '  Renamed  ', id: 'overwrite', createdAt: 1, arbitrary: true });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.createdAt, created.createdAt);
  assert.ok(renamed.updatedAt >= created.updatedAt);
  assert.deepEqual(renamed.folders, created.folders);
  assert.equal(renamed.primaryFolder, second);
  assert.equal(renamed.arbitrary, undefined);

  const selected = await patch(created.id, {
    primaryFolder: process.platform === 'win32' ? first.toUpperCase().replaceAll('\\', '/') : first,
  });
  assert.equal(selected.primaryFolder, first);
  await json(`/api/projects/${created.id}`, { method: 'POST', body: { folders: [second, third] } }, 400);
  assert.deepEqual(await json('/api/projects'), [selected], 'failed patch must not persist any change');
  const moved = await patch(created.id, { folders: [second, third], primaryFolder: third });
  assert.deepEqual(moved.folders, [second, third]);
  assert.equal(moved.primaryFolder, third);
  assert.deepEqual((await json('/api/state')).projects, [moved]);
  assert.equal((await json('/api/status')).projects, 1);
  await remove(created.id);

  const defaultPrimary = await create({ name: `  ${'x'.repeat(100)}  `, folders: [first, second] });
  assert.equal(defaultPrimary.name.length, 100);
  assert.equal(defaultPrimary.primaryFolder, first);
  await remove(defaultPrimary.id);
});

test('invalid project names, paths, primary folders, and JSON fail with 400 without writes', async () => {
  const valid = { name: 'Valid', folders: [first] };
  const cases = [
    null, [], 'text', {}, { ...valid, name: null }, { ...valid, name: 12 },
    { ...valid, name: '' }, { ...valid, name: ' \n ' }, { ...valid, name: 'x'.repeat(101) },
    { name: 'Missing folders' }, { ...valid, folders: [] }, { ...valid, folders: first },
    { ...valid, folders: null }, { ...valid, folders: [null] }, { ...valid, folders: [12] },
    { ...valid, folders: ['.'] }, { ...valid, folders: ['relative/folder'] },
    { ...valid, folders: [path.join(tempDir, 'missing')] }, { ...valid, folders: [regularFile] },
    { ...valid, folders: [first, regularFile] }, { ...valid, folders: [`${first}\0`] },
    { ...valid, primaryFolder: second }, { ...valid, primaryFolder: 'relative' },
    { ...valid, primaryFolder: null }, { ...valid, primaryFolder: 12 },
  ];
  if (process.platform === 'win32') {
    cases.push({ ...valid, folders: ['C:relative'] }, { ...valid, folders: ['\\Windows'] });
  }
  for (const body of cases) await json('/api/projects', { method: 'POST', body }, 400);
  await json('/api/projects', { method: 'POST', rawBody: '{' }, 400);
  assert.deepEqual(await json('/api/projects'), []);

  const created = await create(valid);
  for (const body of [null, [], { name: '' }, { folders: [] }, { primaryFolder: third }]) {
    await json(`/api/projects/${created.id}`, { method: 'POST', body }, 400);
  }
  await json(`/api/projects/${created.id}`, { method: 'POST', rawBody: '{' }, 400);
  assert.deepEqual(await json('/api/projects'), [created]);
  await remove(created.id);
  for (const id of ['missing', created.id]) {
    await json(`/api/projects/${id}`, { method: 'POST', body: valid }, 404);
    await json(`/api/projects/${id}`, { method: 'DELETE' }, 404);
    await json(`/api/projects/${id}/context`, {}, 404);
  }
});

test('context reads a local branch, tolerates missing git/folders, and does not mutate the repository', async (t) => {
  try { execFileSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }); }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('git is not installed'); return; }
    throw error;
  }
  const repo = path.join(tempDir, 'Git folder & no shell');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--initial-branch=feature/project-context', repo], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tempDir, 'empty-gitconfig') },
  });
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const created = await create({ name: 'Git context', folders: [first, nested], primaryFolder: nested });
  const headPath = path.join(repo, '.git', 'HEAD');
  const configPath = path.join(repo, '.git', 'config');
  const head = fs.readFileSync(headPath, 'utf8');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.deepEqual(await json(`/api/projects/${created.id}/context`), { branch: 'feature/project-context', cwd: nested, changes: 0 });
  assert.equal(fs.readFileSync(headPath, 'utf8'), head);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'index.lock')), false);

  await stopServer();
  await startServer({ noGit: true });
  assert.deepEqual(await json(`/api/projects/${created.id}/context`), { branch: null, cwd: nested, changes: null });
  await stopServer();
  await startServer();
  // A detached HEAD needs no commit for symbolic-ref to report no branch.
  fs.writeFileSync(headPath, `${'a'.repeat(40)}\n`);
  assert.deepEqual(await json(`/api/projects/${created.id}/context`), { branch: null, cwd: nested, changes: null });
  fs.rmSync(nested, { recursive: true });
  assert.deepEqual(await json(`/api/projects/${created.id}/context`), { branch: null, cwd: nested, changes: null });
  await remove(created.id);
});

test('environment bookmarks support create/update/delete and never contact their URLs', async () => {
  let visits = 0;
  const remote = http.createServer((_req, res) => { visits += 1; res.end('must not be contacted'); });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  try {
    const url = `http://127.0.0.1:${remote.address().port}`;
    const created = await bookmark({ name: '  Local bookmark  ', url: `${url}/`, token: 'never-persist-me', ssh: 'ignored' });
    assert.deepEqual(Object.keys(created).sort(), ['id', 'name', 'url']);
    assert.equal(created.name, 'Local bookmark');
    assert.equal(created.url, url);
    const renamed = await bookmark({ id: created.id, name: 'Updated' });
    assert.deepEqual(renamed, { ...created, name: 'Updated' });
    assert.deepEqual((await json('/api/state')).environments, [renamed]);
    assert.equal((await json('/api/status')).environments, 1);
    assert.equal(fs.readFileSync(path.join(dataDir, 'environments.json'), 'utf8').includes('never-persist-me'), false);
    await sleep(50);
    assert.equal(visits, 0);
    const changed = await bookmark({ id: created.id, url: '  HTTPS://LOCALHOST:443/  ' });
    assert.equal(changed.url, 'https://localhost');
    assert.deepEqual(await json('/api/environments'), [changed]);
    await removeBookmark(created.id);
    assert.deepEqual(await json('/api/environments'), []);
    await json(`/api/environments/${created.id}`, { method: 'DELETE' }, 404);
    await json('/api/environments/missing', { method: 'DELETE' }, 404);
    await json('/api/environments', { method: 'POST', body: { id: 'missing', name: 'X', url } }, 404);
  } finally {
    await new Promise((resolve) => remote.close(resolve));
  }
});

test('environment URLs reject tokens/credentials/paths and non-http protocols rather than stripping them', async () => {
  const invalidUrls = [
    '', null, 7, {}, 'not-a-url', '//localhost', 'https:localhost', 'ssh://localhost',
    'file:///tmp', 'javascript:alert(1)', 'ftp://localhost', 'https://user@localhost',
    'https://user:password@localhost', 'https://@localhost', 'https://:@localhost',
    'https://localhost?token=secret', 'https://localhost/?token=secret', 'https://localhost?',
    'https://localhost/#secret', 'https://localhost#', 'https://localhost/api',
    'https://localhost//', 'https://localhost/.', 'https://localhost/a/..', 'https://localhost/%2e',
    'https://localhost/%2f', 'https://localhost\\', 'https://localhost\\@evil.invalid',
    'https://local\nhost', 'https://localhost:99999',
  ];
  for (const url of invalidUrls) {
    await json('/api/environments', { method: 'POST', body: { name: 'Test', url } }, 400);
  }
  for (const body of [null, [], {}, { name: 'Missing URL' }, { name: '', url: 'http://localhost' },
    { name: '  ', url: 'http://localhost' }, { name: 'x'.repeat(101), url: 'http://localhost' },
    { id: '', name: 'Test', url: 'http://localhost' }]) {
    await json('/api/environments', { method: 'POST', body }, 400);
  }
  await json('/api/environments', { method: 'POST', rawBody: '{' }, 400);
  assert.deepEqual(await json('/api/environments'), []);
  const valid = await bookmark({ name: 'IPv6', url: 'http://[::1]:7788/' });
  assert.equal(valid.url, 'http://[::1]:7788');
  await json('/api/environments', {
    method: 'POST', body: { id: valid.id, name: 'Must not change', url: 'http://localhost/?token=secret' },
  }, 400);
  assert.deepEqual(await json('/api/environments'), [valid]);
  await removeBookmark(valid.id);
});

test('persisted metadata survives restart; removing the last project preserves folders/tasks/threads', async () => {
  const created = await create({ name: 'Persist', folders: [first, second], primaryFolder: second });
  const updated = await patch(created.id, { name: 'Persisted project' });
  const env = await bookmark({ name: 'Persist', url: 'http://localhost:7788' });
  const savedEnv = await bookmark({ id: env.id, name: 'Persisted bookmark' });
  const thread = await json('/api/threads', { method: 'POST', body: { title: 'Keep thread', projectId: created.id } });
  const task = await json('/api/tasks', { method: 'POST', body: { title: 'Keep task', projectId: created.id, threadId: thread.id } });
  const threadsBefore = fs.readFileSync(path.join(dataDir, 'threads.json'), 'utf8');
  const tasksBefore = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  assert.deepEqual(readData('projects.json'), [updated]);
  assert.deepEqual(readData('environments.json'), [savedEnv]);
  await stopServer();
  await startServer();
  assert.deepEqual(await json('/api/projects'), [updated]);
  assert.deepEqual(await json('/api/environments'), [savedEnv]);
  assert.deepEqual(await remove(created.id), { ok: true });
  assert.deepEqual(await removeBookmark(env.id), { ok: true });
  assert.equal(fs.readFileSync(path.join(dataDir, 'threads.json'), 'utf8'), threadsBefore);
  assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'), tasksBefore);
  assert.equal(fs.readFileSync(regularFile, 'utf8'), 'Project files must survive metadata deletion');
  assert.ok(fs.statSync(first).isDirectory());
  assert.ok(fs.statSync(second).isDirectory());
  await stopServer();
  await startServer();
  assert.deepEqual(await json('/api/projects'), []);
  assert.deepEqual(await json('/api/environments'), []);
  assert.deepEqual(await json(`/api/threads/${thread.id}`), thread);
  assert.deepEqual(await json('/api/tasks'), [task]);
  const status = await json('/api/status');
  assert.equal(status.projects, 0);
  assert.equal(status.environments, 0);
  assert.equal(status.threads, 1);
  assert.equal(status.tasks, 1);
});

test('successful metadata mutations broadcast the existing all SSE scope', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let reader;
  try {
    const res = await request('/api/events', { signal: controller.signal });
    assert.equal(res.status, 200);
    reader = res.body.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    async function nextEvent() {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6));
        } else {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
        }
      }
    }
    assert.equal((await nextEvent()).scope, 'hello');
    const project = await create({ name: 'SSE', folders: [first] });
    assert.equal((await nextEvent()).scope, 'all');
    await patch(project.id, { name: 'SSE updated' });
    assert.equal((await nextEvent()).scope, 'all');
    await remove(project.id);
    assert.equal((await nextEvent()).scope, 'all');
    const env = await bookmark({ name: 'SSE', url: 'http://localhost' });
    assert.equal((await nextEvent()).scope, 'all');
    await bookmark({ id: env.id, name: 'SSE updated' });
    assert.equal((await nextEvent()).scope, 'all');
    await removeBookmark(env.id);
    assert.equal((await nextEvent()).scope, 'all');
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    controller.abort();
  }
});
