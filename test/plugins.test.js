// test/plugins.test.js — plugin sebagai paket skill + perintah + hook + MCP.
// Yang diuji di sini adalah batas keamanannya, bukan hanya "bisa dipasang":
// manifest yang menunjuk ke luar folder, hook yang belum dipercaya, dan server
// MCP plugin yang tidak boleh bocor ke konfigurasi pengguna.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-'));
process.env.AGENTHUB_DATA = dataDir;

const plugins = await import('../lib/plugins.js');
const skills = await import('../lib/skills.js');
const hooks = await import('../lib/hooks.js');
const mcp = await import('../lib/mcp.js');

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-outside-'));
const market = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-market-'));

function writePlugin(dir, manifest, files = {}) {
  fs.mkdirSync(path.join(dir, '.agenthub-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agenthub-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// Plugin contoh lengkap: satu skill, satu perintah, satu hook, satu server MCP.
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-src-'));
writePlugin(src, {
  name: 'contoh-plugin',
  version: '0.1.0',
  description: 'Contoh paket uji',
  skills: 'skills',
  commands: 'commands',
  hooks: { events: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: 'guard.mjs', args: ['--deny'] }] }] } },
  mcp: { servers: { echo: { type: 'stdio', command: 'node', args: ['-e', '0'] } } },
}, {
  'skills/greet/SKILL.md': '---\nname: greet\ndescription: Sapa pengguna dengan satu kalimat.\n---\nSapa dengan satu kalimat.\n',
  'commands/hello.md': '---\ndescription: Sapaan singkat\nargument-hint: "[nama]"\n---\nSapa $ARGUMENTS dengan hangat.\n',
  'guard.mjs': 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "diblokir plugin" } }));\n',
});

test.after(() => {
  for (const d of [dataDir, outside, market, src]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

test('manifest: folder tanpa manifest dilaporkan, bukan dianggap plugin sah', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-empty-'));
  try {
    const read = plugins.readManifest(empty);
    assert.equal(read.present, false);
    assert.match(read.errors[0], /manifest tidak ditemukan/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('manifest: path yang keluar dari folder plugin ditolak', () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-bad-'));
  try {
    writePlugin(bad, { name: 'jahat', skills: '../../..' });
    const read = plugins.readManifest(bad);
    assert.equal(read.errors.some((e) => /di dalam folder plugin/.test(e)), true, read.errors.join('; '));
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

test('manifest: nama dengan karakter aneh ditolak', () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-bad2-'));
  try {
    writePlugin(bad, { name: '../esc' });
    const read = plugins.readManifest(bad);
    assert.equal(read.errors.some((e) => /Nama plugin hanya boleh/.test(e)), true);
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

test('install: menyalin ke folder data, plugin muncul dan aktif', () => {
  const installed = plugins.installPlugin(src);
  assert.equal(installed.name, 'contoh-plugin');
  assert.equal(installed.version, '0.1.0');
  assert.equal(installed.enabled, true);
  assert.equal(installed.diagnostics.errors.length, 0);
  // Disalin, bukan ditautkan: folder sumber boleh dihapus tanpa mematahkan plugin.
  assert.notEqual(path.resolve(installed.dir), path.resolve(src));
  assert.equal(fs.existsSync(path.join(installed.dir, 'skills', 'greet', 'SKILL.md')), true);
});

test('install: plugin dengan nama sama ditolak, bukan menimpa', () => {
  assert.throws(() => plugins.installPlugin(src), /sudah terpasang/);
});

test('skill dan perintah dari plugin ikut terbaca', () => {
  const list = skills.discoverSkills(null);
  const greet = list.find((s) => s.id === 'greet');
  assert.ok(greet, 'skill plugin harus muncul di katalog');
  assert.match(greet.source, /Plugin: contoh-plugin/);
  assert.match(greet.description, /Sapa pengguna/);

  const commands = plugins.listCommands();
  const hello = commands.find((c) => c.name === 'hello');
  assert.ok(hello);
  assert.equal(hello.plugin, 'contoh-plugin');
});

test('perintah plugin diperluas dengan $ARGUMENTS', () => {
  const r = plugins.expandCommand('/hello Rina');
  assert.ok(r);
  assert.equal(r.plugin, 'contoh-plugin');
  assert.match(r.body, /Sapa Rina dengan hangat/);
  assert.equal(plugins.expandCommand('/tidak-ada'), null);
  assert.equal(plugins.expandCommand('bukan perintah'), null);
});

test('hook dan MCP plugin tidak jalan sebelum dipercaya', async () => {
  const status = plugins.trustStatus('contoh-plugin');
  assert.equal(status.needsTrust, true);
  assert.equal(status.trusted, false);

  // Hook belum dipercaya: tidak ada deklarasi plugin yang masuk.
  assert.equal(Object.keys(plugins.pluginHookEvents()).length, 0);
  // Server MCP belum dipercaya: tidak muncul di konfigurasi mcp.
  assert.equal(Object.keys(plugins.pluginMcpServers()).length, 0);
  assert.equal(mcp.listServers().some((s) => s.managedBy), false);
});

test('setelah dipercaya, hook plugin berjalan dan bisa menolak tool', async () => {
  const status = plugins.trustStatus('contoh-plugin');
  await plugins.grantTrust('contoh-plugin', status.digest);
  assert.equal(plugins.trustStatus('contoh-plugin').trusted, true);

  const events = plugins.pluginHookEvents();
  assert.equal(events.PreToolUse?.[0]?.source, 'plugin:contoh-plugin');

  // Plugin dinonaktifkan secara global: tidak ada lagi yang berjalan.
  plugins.setEnabled(true);
  const r = await hooks.runEvent('PreToolUse', { tool_name: 'run_command' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /diblokir plugin/);
  assert.equal(r.results.some((x) => String(x.source).startsWith('plugin:')), true);
});

test('setelah dipercaya, server MCP plugin muncul sebagai kelola-plugin', () => {
  const servers = mcp.listServers();
  const echo = servers.find((s) => s.name === 'contoh-plugin-echo');
  assert.ok(echo, 'server MCP plugin harus terdaftar dengan awalan nama plugin');
  assert.equal(echo.managedBy, 'plugin:contoh-plugin');
  // Server plugin tidak boleh disimpan ke mcp.json pengguna.
  assert.throws(() => mcp.removeServer('contoh-plugin-echo'), /disediakan oleh/);
});

test('digest berubah bila isi skrip hook berubah', async () => {
  const before = plugins.trustStatus('contoh-plugin');
  const entry = plugins.listPlugins({ includeAll: true }).find((p) => p.name === 'contoh-plugin');
  fs.writeFileSync(path.join(entry.dir, 'guard.mjs'), 'process.exit(0);\n');
  const after = plugins.trustStatus('contoh-plugin');
  assert.notEqual(after.digest, before.digest, 'isi skrip ikut menentukan digest');
  assert.equal(after.trusted, false, 'izin lama gugur saat skrip berubah');
});

test('menonaktifkan plugin mencabut skill, perintah, hook, dan MCP-nya', () => {
  plugins.setPluginEnabled('contoh-plugin', false);
  assert.equal(skills.discoverSkills(null).some((s) => s.id === 'greet'), false);
  assert.equal(plugins.listCommands().some((c) => c.name === 'hello'), false);
  assert.equal(Object.keys(plugins.pluginHookEvents()).length, 0);
  assert.equal(mcp.listServers().some((s) => s.managedBy), false);

  plugins.setPluginEnabled('contoh-plugin', true);
  assert.equal(skills.discoverSkills(null).some((s) => s.id === 'greet'), true);
});

test('marketplace: tambah, daftar plugin tersedia, install dari sana', () => {
  const pdir = path.join(market, 'paket-uji');
  writePlugin(pdir, { name: 'paket-uji', version: '1.0.0', description: 'Dari marketplace' });
  fs.writeFileSync(path.join(market, 'marketplace.json'), JSON.stringify({
    name: 'uji-market',
    plugins: [{ name: 'paket-uji', path: 'paket-uji', version: '1.0.0' }],
  }));

  const added = plugins.addMarketplace(market);
  assert.equal(added.name, 'uji-market');
  assert.equal(added.available, 1);
  assert.throws(() => plugins.addMarketplace(market), /sudah ditambahkan/);

  const available = plugins.availablePlugins();
  const item = available.find((p) => p.name === 'paket-uji');
  assert.ok(item);
  assert.equal(item.installed, false);

  const installed = plugins.installPlugin('paket-uji', { marketplace: 'uji-market' });
  assert.equal(installed.installedAt > 0, true);
  assert.equal(plugins.availablePlugins().find((p) => p.name === 'paket-uji').installed, true);

  plugins.uninstallPlugin('paket-uji');
  assert.equal(fs.existsSync(installed.dir), false);
  assert.equal(plugins.removeMarketplace('uji-market').ok, true);
  assert.throws(() => plugins.removeMarketplace('uji-market'), /tidak ditemukan/);
});

test('marketplace: indeks rusak dilaporkan, bukan membuat server crash', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plugins-broken-'));
  try {
    fs.writeFileSync(path.join(broken, 'marketplace.json'), '{ bukan json');
    assert.throws(() => plugins.addMarketplace(broken), /marketplace\.json tidak bisa dibaca/);
    assert.equal(fs.existsSync(path.join(dataDir, 'plugins.json')), true);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test('uninstall menyimpan data plugin secara bawaan', () => {
  const dir = plugins.listPlugins({ includeAll: true }).find((p) => p.name === 'contoh-plugin').dir;
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'setelan.json'), '{"tema":"gelap"}');
  const r = plugins.uninstallPlugin('contoh-plugin', { keepData: true });
  assert.equal(r.keptData, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(plugins.listPlugins({ includeAll: true }).some((p) => p.name === 'contoh-plugin'), false);

  // Install ulang memulihkan data yang disimpan.
  const again = plugins.installPlugin(src);
  assert.equal(fs.readFileSync(path.join(again.dir, 'data', 'setelan.json'), 'utf8'), '{"tema":"gelap"}');
});

test('validate melaporkan kontribusi tanpa memasang apa pun', () => {
  const r = plugins.validatePlugin(src);
  assert.equal(r.ok, true);
  assert.equal(r.contributes.skills, true);
  assert.equal(r.contributes.commands, 1);
  assert.deepEqual(r.contributes.hookEvents, ['PreToolUse']);
  assert.deepEqual(r.contributes.mcpServers, ['echo']);
});
