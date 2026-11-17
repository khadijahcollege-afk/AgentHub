// lib/plugins.js — plugin: paket yang membawa skill, perintah slash, hook, dan
// server MCP sekaligus.
//
// REA ZCode apps/zcode-cli/docs/usage/10-plugins.md. Kenapa plugin, bukan empat
// fitur terpisah: satu paket kerja ("review PR", "deploy Roblox") biasanya butuh
// skill (cara berpikir), perintah (pemicu), dan hook (pemeriksaan otomatis).
// Kalau pengguna harus menaruh tiap bagian di tempat berbeda, paket seperti itu
// tidak pernah lengkap dan tidak bisa dibagikan.
//
// Batas keamanan yang dipilih sadar:
//   • Skill dan perintah hanya teks — tidak menambah izin apa pun. Isinya tetap
//     tunduk pada mode izin tool yang sedang aktif.
//   • Hook dan server MCP adalah kode yang benar-benar dijalankan. Karena itu
//     keduanya wajib dipercaya lebih dulu, dan kepercayaan diikat ke digest
//     deklarasi + isi skrip yang dirujuk. Mengubah satu argumen atau satu baris
//     skrip membuat izin lama gugur.
//   • Manifest divalidasi ketat dan semua path wajib berada di dalam folder
//     plugin: plugin tidak boleh menunjuk ke C:\Windows atau ke folder data
//     AgentHub sendiri.
//
// Install menyalin isi plugin ke DATA_DIR/plugins/<nama>, bukan menautkan folder
// sumber. Marketplace bisa diperbarui atau dihapus tanpa mematahkan instalasi,
// dan uninstall benar-benar menghapus kode yang pernah dijalankan.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJson } from './store.js';

const FILE = 'plugins.json';
const ROOT = path.join(DATA_DIR, 'plugins');
const DATA_KEEP = path.join(DATA_DIR, 'plugin-data');

// ZCode memakai `.zcode-plugin/plugin.json`; AgentHub menerima keduanya supaya
// plugin dari ekosistem ZCode bisa dicoba tanpa diubah.
const MANIFEST_DIRS = ['.agenthub-plugin', '.zcode-plugin'];
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PLUGINS = 50;

export class PluginError extends Error {
  constructor(message, { statusCode = 400, code = 'PLUGIN_ERROR' } = {}) {
    super(message);
    this.name = 'PluginError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------- konfigurasi ----------
// Bentuk: { enabled, dirs: [path absolut], disabled: [nama], installed: {nama:
//   {marketplace, version, sourceDir, installedAt, scope}}, marketplaces: [{name, path}] }
export function readConfig() {
  const data = readJson(FILE, null);
  const cfg = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    enabled: cfg.enabled !== false,
    dirs: Array.isArray(cfg.dirs) ? cfg.dirs.filter((d) => typeof d === 'string' && d.trim()) : [],
    disabled: Array.isArray(cfg.disabled) ? cfg.disabled.filter((d) => typeof d === 'string') : [],
    installed: cfg.installed && typeof cfg.installed === 'object' && !Array.isArray(cfg.installed) ? cfg.installed : {},
    marketplaces: Array.isArray(cfg.marketplaces)
      ? cfg.marketplaces.filter((m) => m && typeof m.name === 'string' && typeof m.path === 'string')
      : [],
  };
}

function writeConfig(cfg) {
  writeJson(FILE, {
    enabled: cfg.enabled !== false,
    dirs: cfg.dirs.slice(0, MAX_PLUGINS),
    disabled: cfg.disabled,
    installed: cfg.installed,
    marketplaces: cfg.marketplaces,
  });
}

export function setEnabled(enabled) {
  const cfg = readConfig();
  cfg.enabled = !!enabled;
  writeConfig(cfg);
  return { enabled: cfg.enabled };
}

export function setPluginEnabled(name, enabled) {
  const cfg = readConfig();
  const clean = String(name || '').trim();
  if (!clean) throw new PluginError('Nama plugin wajib diisi');
  const exists = listPlugins().some((p) => p.name === clean);
  if (!exists) throw new PluginError(`Plugin "${clean}" tidak terpasang`, { statusCode: 404, code: 'PLUGIN_MISSING' });
  const set = new Set(cfg.disabled);
  if (enabled) set.delete(clean); else set.add(clean);
  cfg.disabled = [...set];
  writeConfig(cfg);
  return listPlugins().find((p) => p.name === clean);
}

// ---------- manifest ----------
function manifestFile(dir) {
  for (const sub of MANIFEST_DIRS) {
    const file = path.join(dir, sub, 'plugin.json');
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch { /* coba berikutnya */ }
  }
  return null;
}

// Semua path di manifest harus tetap di dalam folder plugin. Tanpa pemeriksaan
// ini, plugin bisa menyuruh AgentHub membaca keras-keras berkas di luar dirinya
// (mis. folder data pengguna) dan mengirim isinya ke model.
function resolveInside(base, rel, field) {
  const raw = String(rel || '').trim();
  if (!raw) throw new PluginError(`${field} wajib diisi`);
  const full = path.resolve(base, raw);
  const back = path.relative(base, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new PluginError(`${field} harus berada di dalam folder plugin`);
  }
  return full;
}

function countFiles(dir, state) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state.files >= MAX_FILES || state.bytes >= MAX_BYTES) return;
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { countFiles(full, state); continue; }
    try {
      state.files += 1;
      state.bytes += fs.statSync(full).size;
    } catch { /* berkas hilang saat dipindai */ }
  }
}

function cleanName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new PluginError('Nama plugin hanya boleh huruf, angka, titik, garis bawah, dan strip (maks 64)');
  }
  return name;
}

// Membaca dan memvalidasi manifest. Mengembalikan diagnostics, bukan melempar,
// supaya panel Plugin bisa menampilkan apa yang salah tanpa membuat seluruh
// daftar gagal dimuat.
export function readManifest(dir) {
  const errors = [];
  const warnings = [];
  const file = manifestFile(dir);
  if (!file) {
    return { present: false, errors: ['manifest tidak ditemukan (.agenthub-plugin/plugin.json)'], warnings, manifest: null, dir };
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    return { present: true, errors: [`manifest bukan JSON yang sah: ${error.message}`], warnings, manifest: null, dir, file };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { present: true, errors: ['manifest harus berupa objek JSON'], warnings, manifest: null, dir, file };
  }

  let name = '';
  try { name = cleanName(raw.name); } catch (error) { errors.push(error.message); }

  const manifest = {
    name: name || path.basename(dir),
    version: typeof raw.version === 'string' ? raw.version.slice(0, 40) : null,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
    author: typeof raw.author === 'string' ? raw.author.slice(0, 120) : null,
    skills: null,
    commands: null,
    hooks: null,
    mcp: null,
  };

  const dirField = (key) => {
    if (raw[key] === undefined || raw[key] === null) return null;
    if (typeof raw[key] !== 'string') { errors.push(`${key} harus berupa path relatif`); return null; }
    try {
      const full = resolveInside(dir, raw[key], key);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
        errors.push(`${key}: folder "${raw[key]}" tidak ada`);
        return null;
      }
      return full;
    } catch (error) { errors.push(error.message); return null; }
  };

  manifest.skills = dirField('skills');
  manifest.commands = dirField('commands');

  // Hook/MCP boleh inline (objek) atau menunjuk berkas JSON di dalam plugin.
  const objectField = (key) => {
    if (raw[key] === undefined || raw[key] === null) return null;
    if (typeof raw[key] === 'object' && !Array.isArray(raw[key])) return raw[key];
    if (typeof raw[key] === 'string') {
      try {
        const full = resolveInside(dir, raw[key], key);
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push(`${key}: berkas harus berisi objek JSON`);
          return null;
        }
        return { ...parsed, __file: full };
      } catch (error) {
        errors.push(`${key}: ${error.message}`);
        return null;
      }
    }
    errors.push(`${key} harus berupa objek atau path ke berkas JSON`);
    return null;
  };

  manifest.hooks = objectField('hooks');
  manifest.mcp = objectField('mcp');

  if (manifest.hooks) {
    const events = manifest.hooks.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      errors.push('hooks.events harus berupa objek');
    } else {
      const known = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
      for (const key of Object.keys(events)) {
        if (!known.has(key)) warnings.push(`hooks: event "${key}" tidak dikenal dan diabaikan`);
      }
    }
  }
  if (manifest.mcp) {
    const servers = manifest.mcp.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      errors.push('mcp.servers harus berupa objek');
    }
  }
  if (!manifest.skills && !manifest.commands && !manifest.hooks && !manifest.mcp) {
    warnings.push('plugin tidak membawa skill, perintah, hook, maupun server MCP');
  }

  return { present: true, errors, warnings, manifest, dir, file };
}

// ---------- kepercayaan ----------
// Digest mencakup deklarasi hook/MCP DAN isi berkas yang dirujuk skrip hook.
// Kalau hanya deklarasi yang di-hash, plugin bisa dipercaya sekali lalu skripnya
// ditukar dengan isi lain tanpa izin baru.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => k !== '__file').map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function scriptHashes(dir, hooks) {
  const hashes = [];
  const events = hooks?.events || {};
  for (const event of Object.keys(events).sort()) {
    for (const decl of Array.isArray(events[event]) ? events[event] : []) {
      for (const hook of Array.isArray(decl?.hooks) ? decl.hooks : []) {
        const cmd = String(hook?.command || '');
        // Skrip relatif di dalam plugin ikut di-hash; perintah sistem (`node`,
        // `python`) tidak, karena isinya di luar kendali plugin.
        if (!cmd || path.isAbsolute(cmd)) continue;
        try {
          const full = resolveInside(dir, cmd, 'hook.command');
          if (!fs.statSync(full).isFile()) continue;
          hashes.push(`${event}:${cmd}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
        } catch { /* bukan berkas di dalam plugin */ }
      }
    }
  }
  return hashes;
}

export function trustDigest(entry) {
  // `entry.manifest` dari listPlugins() adalah bentuk RINGKAS (hooks: true/false),
  // bukan isi deklarasi. Memakai bentuk itu membuat digest tidak pernah berubah
  // ketika perintah hook atau isi skripnya ditukar — izin lama akan berlaku untuk
  // kode yang sama sekali berbeda. Jadi manifest dibaca ulang dari disk di sini.
  const full = readManifest(entry.dir).manifest || {};
  const parts = [canonical(full.hooks || null), canonical(full.mcp || null)];
  if (full.mcp?.__file) {
    try { parts.push(crypto.createHash('sha256').update(fs.readFileSync(full.mcp.__file)).digest('hex')); } catch { /* hilang */ }
  }
  parts.push(...scriptHashes(entry.dir, full.hooks));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function trustStore() {
  const data = readJson('plugins-trust.json', null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function trustStatus(name) {
  const entry = listPlugins({ includeAll: true }).find((p) => p.name === name);
  if (!entry) throw new PluginError(`Plugin "${name}" tidak terpasang`, { statusCode: 404, code: 'PLUGIN_MISSING' });
  const needsTrust = !!(entry.manifest?.hooks || entry.manifest?.mcp);
  const digest = needsTrust ? trustDigest(entry) : null;
  const granted = trustStore()[entry.name] || null;
  return {
    name: entry.name,
    needsTrust,
    trusted: !needsTrust || (!!granted && granted.digest === digest),
    digest,
  };
}

export function grantTrust(name, digest) {
  const status = trustStatus(name);
  if (!status.needsTrust) return { ...status, trusted: true };
  if (!digest || digest !== status.digest) {
    throw new PluginError('Digest plugin berubah — muat ulang daftar plugin lalu setujui lagi', { code: 'PLUGIN_TRUST_DIGEST' });
  }
  const store = trustStore();
  store[name] = { digest, at: Date.now() };
  writeJson('plugins-trust.json', store);
  return trustStatus(name);
}

export function revokeTrust(name) {
  const store = trustStore();
  if (!store[name]) return { ok: false };
  delete store[name];
  writeJson('plugins-trust.json', store);
  return { ok: true };
}

// ---------- daftar plugin ----------
function dirsOnDisk() {
  const cfg = readConfig();
  const out = [];
  const push = (dir) => {
    if (!dir || out.includes(dir)) return;
    try {
      if (fs.statSync(dir).isDirectory()) out.push(path.resolve(dir));
    } catch { /* langsung dilewati */ }
  };
  for (const dir of cfg.dirs) push(dir);
  // Plugin hasil install selalu berada di folder data; tetap dipindai walau
  // catatan dirs hilang, supaya instalasi tidak "lenyap" karena satu baris rusak.
  try {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true }).slice(0, MAX_PLUGINS)) {
      if (entry.isDirectory()) push(path.join(ROOT, entry.name));
    }
  } catch { /* folder belum ada */ }
  return out;
}

export function listPlugins({ includeAll = false } = {}) {
  const cfg = readConfig();
  const seen = new Set();
  const out = [];
  for (const dir of dirsOnDisk()) {
    const read = readManifest(dir);
    const name = read.manifest?.name || path.basename(dir);
    if (seen.has(name)) continue;
    seen.add(name);
    const enabled = cfg.enabled && !cfg.disabled.includes(name) && read.errors.length === 0;
    if (!includeAll && !cfg.enabled) {
      // Tetap didaftar (dengan enabled:false) supaya UI bisa menjelaskan bahwa
      // plugin dimatikan global, bukan hilang.
    }
    const meta = cfg.installed[name] || null;
    out.push({
      name,
      version: read.manifest?.version || null,
      description: read.manifest?.description || '',
      author: read.manifest?.author || null,
      dir,
      source: meta ? 'marketplace' : 'lokal',
      marketplace: meta?.marketplace || null,
      installedAt: meta?.installedAt || null,
      enabled,
      globalEnabled: cfg.enabled,
      disabled: cfg.disabled.includes(name),
      diagnostics: { errors: read.errors, warnings: read.warnings },
      manifest: read.manifest ? {
        name: read.manifest.name,
        version: read.manifest.version,
        description: read.manifest.description,
        author: read.manifest.author,
        skills: read.manifest.skills ? path.basename(read.manifest.skills) : null,
        commands: read.manifest.commands ? path.basename(read.manifest.commands) : null,
        hooks: !!read.manifest.hooks,
        mcp: !!read.manifest.mcp,
        hookEvents: read.manifest.hooks ? Object.keys(read.manifest.hooks.events || {}) : [],
        mcpServers: read.manifest.mcp ? Object.keys(read.manifest.mcp.servers || {}) : [],
      } : null,
      // Manifest mentah tidak dikirim ke klien: berisi path absolut dan isi
      // deklarasi hook. UI hanya butuh ringkasannya.
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function activeEntries() {
  const cfg = readConfig();
  if (!cfg.enabled) return [];
  return listPlugins({ includeAll: true }).filter((p) => p.enabled && p.diagnostics.errors.length === 0);
}

export function summary() {
  const cfg = readConfig();
  const plugins = listPlugins();
  return {
    enabled: cfg.enabled,
    count: plugins.length,
    active: plugins.filter((p) => p.enabled).length,
    marketplaces: cfg.marketplaces.length,
    needsTrust: plugins.filter((p) => p.manifest?.hooks || p.manifest?.mcp).length,
  };
}

// ---------- kontribusi: skill ----------
// Dipakai lib/skills.js. Urutan dipilih supaya aturan proyek tetap menang:
// plugin berada di antara skill pengguna dan skill proyek.
export function pluginSkillRoots() {
  const out = [];
  for (const entry of activeEntries()) {
    if (!entry.manifest?.skills) continue;
    const read = readManifest(entry.dir);
    if (!read.manifest?.skills) continue;
    out.push({ plugin: entry.name, dir: read.manifest.skills });
  }
  return out;
}

// ---------- kontribusi: perintah slash ----------
// ZCode: `commands/hello.md` dengan frontmatter `description` + `argument-hint`,
// isi memakai `$ARGUMENTS`. Perintah diperluas menjadi instruksi sebelum dikirim
// ke model — bukan perintah lokal yang hanya mencetak teks.
function parseCommandFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (raw.length > 60000) return null;
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const field = (key) => {
    const m = (front?.[1] || '').match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  return {
    description: field('description'),
    argumentHint: field('argument-hint') || field('argument_hint'),
    body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim(),
  };
}

export function listCommands() {
  const out = [];
  for (const entry of activeEntries()) {
    const read = readManifest(entry.dir);
    if (!read.manifest?.commands) continue;
    let files = [];
    try { files = fs.readdirSync(read.manifest.commands, { withFileTypes: true }); } catch { continue; }
    for (const f of files.slice(0, 100)) {
      if (!f.isFile() || !/\.md$/i.test(f.name)) continue;
      const parsed = parseCommandFile(path.join(read.manifest.commands, f.name));
      if (!parsed) continue;
      out.push({
        name: f.name.replace(/\.md$/i, '').toLowerCase(),
        plugin: entry.name,
        description: parsed.description.slice(0, 200),
        argumentHint: parsed.argumentHint.slice(0, 80),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Perluas `/nama argumen` menjadi isi perintah. Mengembalikan null bila bukan
// perintah plugin, sehingga pemanggil bisa melanjutkan alur biasa.
export function expandCommand(text) {
  const raw = String(text || '');
  if (!raw.startsWith('/')) return null;
  const m = raw.match(/^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  for (const entry of activeEntries()) {
    const read = readManifest(entry.dir);
    if (!read.manifest?.commands) continue;
    let files = [];
    try { files = fs.readdirSync(read.manifest.commands, { withFileTypes: true }); } catch { continue; }
    const hit = files.find((f) => f.isFile() && f.name.replace(/\.md$/i, '').toLowerCase() === name);
    if (!hit) continue;
    const parsed = parseCommandFile(path.join(read.manifest.commands, hit.name));
    if (!parsed) continue;
    // `$ARGUMENTS` adalah bentuk resmi ZCode. `$1`…`$9` diterima juga karena
    // banyak perintah Markdown yang beredar memakai bentuk itu.
    const words = args ? args.split(/\s+/) : [];
    const body = parsed.body
      .replace(/\$ARGUMENTS/g, args)
      .replace(/\$([1-9])/g, (_, n) => words[Number(n) - 1] || '')
      .trim();
    return { name, plugin: entry.name, args, body, description: parsed.description };
  }
  return null;
}

// ---------- kontribusi: hook ----------
// Hanya plugin yang lulus trust yang menjalankan hook: ini kode nyata di mesin
// pengguna, jadi menyetujui plugin harus jadi tindakan sadar.
export function pluginHookEvents() {
  const out = {};
  for (const entry of activeEntries()) {
    if (!entry.manifest?.hooks) continue;
    const trust = trustStatus(entry.name);
    if (!trust.trusted) continue;
    const read = readManifest(entry.dir);
    const events = read.manifest?.hooks?.events || {};
    for (const [event, declarations] of Object.entries(events)) {
      if (!Array.isArray(declarations)) continue;
      const list = out[event] || (out[event] = []);
      for (const decl of declarations.slice(0, 10)) {
        const hooks = Array.isArray(decl?.hooks) ? decl.hooks : [];
        // `command` relatif diresolusi ke folder plugin: hook harus bisa
        // memanggil skrip bawaannya sendiri tanpa path absolut di manifest.
        const resolved = hooks.slice(0, 10).map((h) => {
          const cmd = String(h?.command || '');
          if (!cmd || path.isAbsolute(cmd)) return { ...h, command: cmd };
          try {
            const full = resolveInside(read.dir, cmd, 'hook.command');
            // Node/Python: skrip relatif dijalankan lewat runtime yang sama
            // dengan proses ini, supaya tidak bergantung pada bit executable.
            if (/\.(mjs|cjs|js)$/i.test(full)) return { type: 'process', command: process.execPath, args: [full, ...(Array.isArray(h.args) ? h.args : [])], timeoutMs: h.timeoutMs, async: h.async };
            return { ...h, command: full };
          } catch { return { ...h, command: cmd }; }
        }).filter((h) => h.command);
        if (!resolved.length) continue;
        list.push({
          matcher: typeof decl?.matcher === 'string' ? decl.matcher : '*',
          hooks: resolved,
          source: `plugin:${entry.name}`,
        });
      }
    }
  }
  return out;
}

// ---------- kontribusi: server MCP ----------
// Nama diberi awalan nama plugin supaya dua plugin yang sama-sama punya server
// "github" tidak saling menimpa. Server plugin bersifat baca-saja di UI: ia
// hidup-mati bersama pluginnya, bukan entri konfigurasi pengguna.
export function pluginMcpServers() {
  const out = {};
  for (const entry of activeEntries()) {
    if (!entry.manifest?.mcp) continue;
    const trust = trustStatus(entry.name);
    if (!trust.trusted) continue;
    const read = readManifest(entry.dir);
    const servers = read.manifest?.mcp?.servers || {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const key = `${entry.name}-${name}`.slice(0, 48);
      out[key] = { ...cfg, enabled: cfg.enabled !== false, plugin: entry.name };
    }
  }
  return out;
}

// ---------- marketplace ----------
// Bentuk indeks (didokumentasikan di README): 
//   { "name": "contoh-market", "plugins": [ { "name", "path", "version", "description" } ] }
// Array polos juga diterima, karena itu bentuk yang paling mudah ditulis tangan.
function readIndex(dir) {
  const file = path.join(dir, 'marketplace.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new PluginError(`marketplace.json tidak bisa dibaca: ${error.message}`, { code: 'MARKETPLACE_INVALID' });
  }
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.plugins) ? raw.plugins : []);
  const name = (!Array.isArray(raw) && typeof raw?.name === 'string' && raw.name.trim())
    ? raw.name.trim().slice(0, 64)
    : path.basename(dir);
  const plugins = [];
  const errors = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    try {
      const pluginName = cleanName(item.name);
      const rel = String(item.path || pluginName).trim();
      const full = path.resolve(dir, rel);
      const back = path.relative(dir, full);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) {
        errors.push(`${pluginName}: path keluar dari folder marketplace`);
        continue;
      }
      plugins.push({
        name: pluginName,
        path: full,
        version: typeof item.version === 'string' ? item.version.slice(0, 40) : null,
        description: typeof item.description === 'string' ? item.description.slice(0, 300) : '',
        present: fs.existsSync(full),
      });
    } catch (error) { errors.push(error.message); }
  }
  return { name, plugins, errors };
}

export function listMarketplaces() {
  const cfg = readConfig();
  return cfg.marketplaces.map((m) => {
    let info = null;
    let error = null;
    try { info = readIndex(m.path); } catch (e) { error = e.message; }
    return {
      name: m.name,
      path: m.path,
      addedAt: m.addedAt || null,
      available: info ? info.plugins.length : 0,
      error,
      errors: info?.errors || [],
    };
  });
}

export function addMarketplace(dirOrName) {
  const raw = String(dirOrName || '').trim();
  if (!raw) throw new PluginError('Path marketplace wajib diisi');
  const dir = path.resolve(raw);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new PluginError(`Folder marketplace tidak ditemukan: ${dir}`, { statusCode: 404 }); }
  if (!stat.isDirectory()) throw new PluginError('Marketplace harus berupa folder');
  const index = readIndex(dir); // melempar bila indeks rusak
  const cfg = readConfig();
  if (cfg.marketplaces.some((m) => m.path === dir)) {
    throw new PluginError('Marketplace ini sudah ditambahkan', { statusCode: 409, code: 'MARKETPLACE_EXISTS' });
  }
  const existing = new Set(cfg.marketplaces.map((m) => m.name));
  let name = index.name;
  let n = 2;
  while (existing.has(name)) name = `${index.name}-${n++}`;
  cfg.marketplaces.push({ name, path: dir, addedAt: Date.now() });
  writeConfig(cfg);
  return listMarketplaces().find((m) => m.name === name);
}

export function removeMarketplace(name) {
  const cfg = readConfig();
  const before = cfg.marketplaces.length;
  cfg.marketplaces = cfg.marketplaces.filter((m) => m.name !== name);
  if (cfg.marketplaces.length === before) {
    throw new PluginError(`Marketplace "${name}" tidak ditemukan`, { statusCode: 404, code: 'MARKETPLACE_MISSING' });
  }
  writeConfig(cfg);
  return { ok: true };
}

export function availablePlugins() {
  const cfg = readConfig();
  const out = [];
  for (const m of cfg.marketplaces) {
    let index;
    try { index = readIndex(m.path); } catch { continue; }
    for (const p of index.plugins) {
      out.push({ ...p, marketplace: m.name });
    }
  }
  const installed = new Set(listPlugins({ includeAll: true }).map((p) => p.name));
  return out.map((p) => ({ ...p, installed: installed.has(p.name) }));
}

// ---------- install / update / uninstall ----------
function copyTree(from, to, state = { files: 0, bytes: 0 }) {
  fs.mkdirSync(to, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return state; }
  for (const e of entries) {
    if (state.files >= MAX_FILES || state.bytes >= MAX_BYTES) {
      throw new PluginError(`Plugin terlalu besar (lebih dari ${MAX_FILES} berkas atau ${Math.round(MAX_BYTES / 1048576)} MB)`);
    }
    if (e.name === 'data' && from === state.root) continue; // data pengguna tidak ikut ditimpa
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { copyTree(src, dst, state); continue; }
    if (!e.isFile()) continue;
    const size = fs.statSync(src).size;
    state.files += 1;
    state.bytes += size;
    fs.copyFileSync(src, dst);
  }
  return state;
}

export function installPlugin(name, { marketplace = null, scope = 'user' } = {}) {
  if (!['user', 'project'].includes(scope)) throw new PluginError('scope harus "user" atau "project"');
  // `name` berarti nama plugin HANYA bila datang dari marketplace. Tanpa
  // marketplace, argumen ini adalah path folder — dan path absolut tidak akan
  // lolos cleanName, jadi validasi nama tidak boleh dijalankan lebih dulu.
  const clean = marketplace ? cleanName(name) : null;
  // Sumber: dari marketplace bernama, atau folder lokal langsung.
  let sourceDir = null;
  let market = null;
  if (marketplace) {
    const cfg = readConfig();
    const m = cfg.marketplaces.find((x) => x.name === marketplace);
    if (!m) throw new PluginError(`Marketplace "${marketplace}" tidak ditemukan`, { statusCode: 404, code: 'MARKETPLACE_MISSING' });
    const index = readIndex(m.path);
    const item = index.plugins.find((p) => p.name === clean);
    if (!item) throw new PluginError(`Plugin "${clean}" tidak ada di marketplace "${marketplace}"`, { statusCode: 404, code: 'PLUGIN_MISSING' });
    sourceDir = item.path;
    market = marketplace;
  } else {
    sourceDir = path.resolve(name);
  }

  let st;
  try { st = fs.statSync(sourceDir); } catch { throw new PluginError(`Folder plugin tidak ditemukan: ${sourceDir}`, { statusCode: 404 }); }
  if (!st.isDirectory()) throw new PluginError('Plugin harus berupa folder');

  const read = readManifest(sourceDir);
  if (!read.present) throw new PluginError(read.errors[0] || 'manifest tidak ditemukan', { code: 'PLUGIN_MANIFEST' });
  if (read.errors.length) throw new PluginError(`Manifest tidak sah: ${read.errors.join('; ')}`, { code: 'PLUGIN_MANIFEST' });
  const pluginName = read.manifest.name;

  const cfg = readConfig();
  const target = path.join(ROOT, pluginName);
  if (fs.existsSync(target)) {
    throw new PluginError(`Plugin "${pluginName}" sudah terpasang di ${target}`, { statusCode: 409, code: 'PLUGIN_EXISTS' });
  }

  const state = { files: 0, bytes: 0, root: sourceDir };
  copyTree(sourceDir, target, state);

  // Data yang sengaja disimpan saat uninstall dikembalikan di sini, supaya
  // install ulang tidak kehilangan setelan plugin.
  const kept = path.join(DATA_KEEP, pluginName);
  if (fs.existsSync(kept)) {
    try { copyTree(kept, path.join(target, 'data'), { files: 0, bytes: 0 }); } catch { /* data hilang bukan alasan gagal install */ }
  }

  cfg.dirs = [...new Set([...cfg.dirs, target])].slice(0, MAX_PLUGINS);
  cfg.disabled = cfg.disabled.filter((n) => n !== pluginName);
  cfg.installed[pluginName] = {
    marketplace: market,
    version: read.manifest.version,
    sourceDir,
    scope,
    installedAt: Date.now(),
    files: state.files,
    bytes: state.bytes,
  };
  writeConfig(cfg);

  return listPlugins({ includeAll: true }).find((p) => p.name === pluginName) || null;
}

export function updatePlugin(name) {
  const clean = cleanName(name);
  const cfg = readConfig();
  const entry = listPlugins({ includeAll: true }).find((p) => p.name === clean);
  if (!entry) throw new PluginError(`Plugin "${clean}" tidak terpasang`, { statusCode: 404, code: 'PLUGIN_MISSING' });
  const meta = cfg.installed[clean];
  const source = meta?.sourceDir;
  if (!source || !fs.existsSync(source)) {
    throw new PluginError('Sumber plugin tidak tersedia lagi — install ulang dari marketplace', { code: 'PLUGIN_SOURCE_MISSING' });
  }
  const read = readManifest(source);
  if (read.errors.length) throw new PluginError(`Manifest sumber tidak sah: ${read.errors.join('; ')}`, { code: 'PLUGIN_MANIFEST' });
  // Data pengguna di dalam plugin tidak boleh ikut terhapus saat pembaruan.
  const dataDir = path.join(entry.dir, 'data');
  const stash = fs.existsSync(dataDir) ? path.join(DATA_DIR, `plugins-update-${clean}.tmp`) : null;
  if (stash) {
    try {
      fs.rmSync(stash, { recursive: true, force: true });
      copyTree(dataDir, stash, { files: 0, bytes: 0 });
    } catch { /* lanjut tanpa data */ }
  }
  fs.rmSync(entry.dir, { recursive: true, force: true });
  copyTree(source, entry.dir, { files: 0, bytes: 0, root: source });
  if (stash) {
    try {
      copyTree(stash, path.join(entry.dir, 'data'), { files: 0, bytes: 0 });
      fs.rmSync(stash, { recursive: true, force: true });
    } catch { /* data dilewati */ }
  }
  meta.version = read.manifest.version;
  meta.updatedAt = Date.now();
  cfg.installed[clean] = meta;
  writeConfig(cfg);
  // Kepercayaan lama tidak otomatis berlaku untuk isi baru.
  revokeTrust(clean);
  return listPlugins({ includeAll: true }).find((p) => p.name === clean) || null;
}

export function uninstallPlugin(name, { keepData = true } = {}) {
  const clean = cleanName(name);
  const cfg = readConfig();
  const entry = listPlugins({ includeAll: true }).find((p) => p.name === clean);
  if (!entry) throw new PluginError(`Plugin "${clean}" tidak terpasang`, { statusCode: 404, code: 'PLUGIN_MISSING' });
  const dataDir = path.join(entry.dir, 'data');
  if (keepData && fs.existsSync(dataDir)) {
    try {
      fs.rmSync(path.join(DATA_KEEP, clean), { recursive: true, force: true });
      copyTree(dataDir, path.join(DATA_KEEP, clean), { files: 0, bytes: 0 });
    } catch { /* gagal menyimpan data tidak boleh menggagalkan uninstall */ }
  }
  fs.rmSync(entry.dir, { recursive: true, force: true });
  cfg.dirs = cfg.dirs.filter((d) => path.resolve(d) !== path.resolve(entry.dir));
  cfg.disabled = cfg.disabled.filter((n) => n !== clean);
  delete cfg.installed[clean];
  writeConfig(cfg);
  revokeTrust(clean);
  return { ok: true, keptData: keepData && fs.existsSync(path.join(DATA_KEEP, clean)) };
}

// Validasi tanpa memasang — `zcode plugins validate`. Hanya memeriksa struktur;
// tidak membuktikan plugin aman.
export function validatePlugin(dirOrName) {
  const raw = String(dirOrName || '').trim();
  if (!raw) throw new PluginError('Path atau nama plugin wajib diisi');
  let dir = path.resolve(raw);
  if (!fs.existsSync(dir)) {
    const entry = listPlugins({ includeAll: true }).find((p) => p.name === raw);
    if (!entry) throw new PluginError(`Plugin tidak ditemukan: ${raw}`, { statusCode: 404, code: 'PLUGIN_MISSING' });
    dir = entry.dir;
  }
  const read = readManifest(dir);
  const commands = read.manifest?.commands ? (() => {
    try {
      return fs.readdirSync(read.manifest.commands).filter((f) => /\.md$/i.test(f)).length;
    } catch { return 0; }
  })() : 0;
  return {
    ok: read.present && read.errors.length === 0,
    dir,
    name: read.manifest?.name || null,
    version: read.manifest?.version || null,
    errors: read.errors,
    warnings: read.warnings,
    contributes: {
      skills: !!read.manifest?.skills,
      commands,
      hookEvents: read.manifest?.hooks ? Object.keys(read.manifest.hooks.events || {}) : [],
      mcpServers: read.manifest?.mcp ? Object.keys(read.manifest.mcp.servers || {}) : [],
    },
    trusted: read.manifest ? trustStatus(read.manifest.name).trusted : false,
  };
}
