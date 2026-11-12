// Regresi: shell tidak boleh menempel ke UI lama hanya karena port-nya hidup.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { probeServer } = require('../desktop/server-connection.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await callback(server.address().port); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('desktop: server lama tanpa versi ditolak, tanpa mengirim token', async () => {
  const routes = [];
  await withServer((req, res) => {
    routes.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    json(res, 200, { ok: true, name: 'AgentHub' });
  }, async (port) => {
    const result = await probeServer({ port, token: 'fixture-token', version });
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /lama/);
    assert.deepEqual(routes, ['/healthz']);
  });
});

test('desktop: versi cocok tetapi token salah tetap ditolak', async () => {
  await withServer((req, res) => {
    if (req.url === '/healthz') json(res, 200, { ok: true, name: 'AgentHub', version });
    else json(res, 401, { error: 'Token salah' });
  }, async (port) => {
    assert.equal((await probeServer({ port, token: 'wrong', version })).state, 'blocked');
  });
});

test('desktop: server dengan versi, port, dan token cocok diterima', async () => {
  await withServer((req, res) => {
    if (req.url === '/healthz') json(res, 200, { ok: true, name: 'AgentHub', version });
    else {
      assert.equal(req.headers.authorization, 'Bearer fixture-token');
      json(res, 200, { version, port: req.socket.localPort });
    }
  }, async (port) => {
    assert.deepEqual(await probeServer({ port, token: 'fixture-token', version }), { state: 'ready', port });
  });
});

test('desktop: HTTP 200 dari aplikasi lain bukan AgentHub', async () => {
  await withServer((req, res) => json(res, 200, { ok: true, name: 'Other' }), async (port) => {
    assert.equal((await probeServer({ port, version })).state, 'blocked');
  });
});

test('desktop: koneksi yang menggantung punya batas waktu', async () => {
  await withServer(() => {}, async (port) => {
    const start = Date.now();
    assert.equal((await probeServer({ port, version, timeoutMs: 70 })).state, 'blocked');
    assert.ok(Date.now() - start < 3000);
  });
});

test('UI: ID unik, textarea terpisah, elemen composer tersedia', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'ID HTML tidak boleh duplikat');
  for (const id of ['hero-continue', 'chat-top', 'composer', 'composer-input', 'hero-composer-slot', 'bottom-composer-slot']) {
    assert.ok(ids.includes(id), `${id} wajib tersedia`);
  }
  assert.match(html, /<textarea\b[^>]*id="composer-input"/);
});

test('UI: pemilih proyek, editor proyek, katalog model, dan effort tersedia', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  for (const id of [
    'engine-chip', 'engine-label', 'effort-chip', 'effort-label',
    'engine-pop', 'engine-rows', 'model-pop', 'model-search', 'model-rows',
    'effort-pop', 'effort-rows',
    'access-chip', 'access-label', 'access-pop', 'access-rows',
    'composer-branch', 'git-pop', 'git-rows', 'git-open-projects',
    'sb-menu-btn', 'sb-menu-pop',
    'sbm-projects', 'sbm-new-project', 'sbm-usage', 'sbm-gateway', 'sbm-settings',
    'project-overlay', 'project-search', 'project-rows',
    'project-edit-overlay', 'project-edit-title', 'project-edit-name',
    'project-edit-folders', 'project-add-folder', 'project-edit-save',
    'project-edit-delete', 'project-edit-cancel', 'adopt-hint',
    'btn-tunnel-toggle', 'tunnel-status', 'tunnel-body', 'set-cloudflared',
    'btn-cloudflared-save', 'qr-tunnel-section', 'qr-tunnel-body', 'btn-copy-url-pop',
    'palette-pop', 'palette-input', 'palette-rows',
    'search-pop', 'search-input', 'search-rows',
    'mention-pop', 'mention-rows',
    'btn-pwa-install', 'pwa-hint',
    'btn-settings-back', 'settings-search', 'settings-nav',
    'btn-session-info', 'session-pop', 'session-kv',
    'pwa-hint-ios', 'set-desktop-mac', 'set-desktop-linux',
    'sched-name', 'sched-prompt', 'sched-engine', 'sched-mode',
    'sched-interval', 'sched-daily', 'sched-rows',
    'btn-backup-download', 'btn-restore-pick', 'backup-file', 'restore-status',
    'sb-account', 'account-pop', 'account-host', 'account-id',
    'btn-account-copy-id', 'account-themes', 'account-zoom',
    'sbm-integrations', 'integrations-overlay', 'intg-search', 'intg-body',
    'btn-tools', 'tools-pop', 'tool-attach', 'tool-schedule',
    'shortcuts-overlay', 'shortcuts-rows', 'btn-sc-close',
    'connector-pulse', 'btn-pulse-all', 'pulse-status',
    'update-panel', 'btn-update-check', 'update-status', 'update-current',
    'onboard-card', 'find-bar', 'find-input', 'find-count', 'find-close',
    'theme-cards', 'acct-theme', 'acct-theme-label',
    'tool-research', 'tool-prompts', 'tool-delegate', 'sbm-schedules',
  ]) {
    assert.ok(ids.includes(id), `${id} wajib tersedia`);
  }
  // settings kini shell dengan navigasi kategori — setiap pane wajib ada
  for (const pane of ['providers', 'models', 'connectors', 'projects', 'billing', 'preferences',
    'appearance', 'notifications', 'privacy', 'shortcuts', 'phone', 'server', 'desktop', 'about']) {
    assert.ok(html.includes(`data-pane="${pane}"`), `pane settings ${pane} wajib ada`);
  }
  // chip engine kini menu custom, bukan <select> native yang tidak mengikuti tema
  assert.ok(!ids.includes('engine-select'), 'select native engine harus sudah diganti menu custom');
  // elemen dinamis tunnel dirender oleh app.js saat tunnel online
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  for (const id of ['qr-box-tunnel', 'btn-copy-tunnel', 'qr-box-tunnel-pop', 'btn-copy-tunnel-pop']) {
    assert.ok(app.includes(id), `${id} harus dirender renderTunnel()`);
  }
  // layer baru wajib bagian dari mesin UI yang sama (satu sumber kebenaran)
  const machines = fs.readFileSync(path.join(ROOT, 'lib/machines.js'), 'utf8');
  for (const layer of ['project', 'projectEdit', 'models', 'effort', 'engines', 'access', 'git', 'sbMenu', 'prompts', 'session', 'account', 'integrations', 'tools']) {
    assert.match(machines, new RegExp(`'${layer}'`), `layer ${layer} harus bagian dari UI_MACHINE`);
  }
  // "This PC" harus bisa ganti folder bebas lewat picker, bukan hanya proyek.
  assert.match(app, /data-cwd="1"/, 'picker This PC harus punya aksi ganti folder');
  assert.match(app, /\/api\/workspace\/check/, 'setCwd harus memvalidasi folder ke server');
});

test('UI: konfirmasi memakai dialog in-app, bukan confirm/prompt native', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  for (const id of ['dialog-overlay', 'dialog-title', 'dialog-message', 'dialog-input', 'dialog-cancel', 'dialog-ok']) {
    assert.ok(ids.includes(id), `${id} wajib tersedia`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const native = [];
  for (const match of app.matchAll(/(?<![.\w])(confirm|prompt|alert)\s*\(/g)) {
    native.push(`${match[1]}() baris ${app.slice(0, match.index).split('\n').length}`);
  }
  for (const match of app.matchAll(/\bwindow\.(confirm|prompt|alert)\s*\(/g)) {
    native.push(`window.${match[1]}()`);
  }
  assert.deepEqual(native, [], `dialog native tidak boleh dipakai: ${native.join(', ')}`);
  // dialog harus bisa dikendalikan keyboard & agent, bukan bergantung browser
  assert.match(app, /function askConfirm\(/);
  assert.match(app, /function askPrompt\(/);
  assert.match(app, /stopImmediatePropagation\(\)/);
  assert.match(app, /dialog: dialogActive \?/);
});

test('UI: tanpa ikon emoji bawaan platform — semua ikon SVG', () => {
  // Glyph tipografis (✓ ✕ → ⌘ ●) sengaja dipakai; yang dilarang adalah emoji
  // yang tampil berwarna/warisan platform dan merusak konsistensi UI gelap.
  const forbidden = [...'🆓✳🔷🟦✨🔁🤖🎁⚡🔒🎯⚠⏹🔀❄✅❌⟳⤢★✎↗✗🖥️📱📋💬🔔⚙️🔑'];
  for (const rel of ['public/index.html', 'public/app.js', 'server.js', 'lib/notify.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const ch of forbidden) {
      assert.ok(!src.includes(ch), `${rel} masih memakai emoji "${ch}" — ganti dengan ikon SVG`);
    }
  }
  // semua pemanggilan ikon engine menghasilkan SVG, bukan karakter
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(app.includes('ICON_PATHS'), 'set ikon SVG harus ada di app.js');
});

test('desktop: paket berisi modul handshake dan versi server yang sama', () => {
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json')));
  assert.equal(desktop.version, version);
  assert.ok(desktop.build.files.includes('server-connection.cjs'));
  assert.ok(desktop.build.extraResources.some((entry) => entry.from === '../package.json' && entry.to === 'server/package.json'));
});

test('release: CI membangun installer untuk Windows, macOS, dan Linux', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  // tiga runner OS berbeda supaya dmg/AppImage dibangun di OS aslinya
  assert.match(wf, /runs-on: windows-latest/, 'job Windows ada');
  assert.match(wf, /runs-on: macos-latest/, 'job macOS ada — dmg tidak bisa dibangun di Windows');
  assert.match(wf, /runs-on: ubuntu-latest/, 'job Linux ada');
  assert.match(wf, /--mac dmg zip/, 'target mac dmg + zip');
  assert.match(wf, /--linux AppImage deb/, 'target linux AppImage + deb');
  // semua installer masuk satu release yang sama lewat job publish
  assert.match(wf, /needs:\s*\[build-windows, build-macos, build-linux\]/, 'publish menunggu ketiga build');
  assert.match(wf, /AgentHub-macOS\.dmg/, 'nama file mac stabil untuk link unduhan');
  assert.match(wf, /AgentHub-linux\.AppImage/, 'nama file linux stabil untuk link unduhan');
  // konfigurasi builder memang punya target mac & linux dengan ikon yang ada
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json')));
  assert.ok(desktop.build.mac.target.some((t) => t.target === 'dmg'), 'mac target dmg');
  assert.ok(desktop.build.linux.target.includes('AppImage'), 'linux target AppImage');
  assert.ok(fs.existsSync(path.join(ROOT, 'desktop/build/icon.png')), 'ikon png untuk mac/linux');
  // pwa iOS: meta apple sudah ada agar "Tambahkan ke Layar Utama" berfungsi
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
});

test('ui: tema terang via inversi terkendali + kartu tema tersimpan', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /html\[data-theme="light"\] body \{\s*filter: invert/, 'mekanisme inversi ada');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(app.includes('function applyTheme('), 'applyTheme ada');
  assert.ok(app.includes('ah_theme'), 'preferensi tema tersimpan');
  assert.ok(app.includes('prefers-color-scheme: light'), 'mode Sistem mengikuti OS');
});

test('ui: semua select native diganti dropdown custom bertema', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(app.includes('function upgradeSelects'), 'fungsi upgradeSelects ada');
  assert.ok(app.includes('visually-hidden'), 'select asli disembunyikan, bukan dihapus');
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.ok(css.includes('.dd-pop'), 'gaya popup dropdown ada');
});

test('ui: pencarian dalam thread terikat Ctrl+F', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(app.includes("e.key === 'f' || e.key === 'F'"), 'binding Ctrl+F ada');
  assert.ok(app.includes('toggleFind'), 'fungsi toggleFind ada');
  assert.ok(app.includes('data-mid'), 'elemen pesan membawa data-mid untuk lompatan');
});

test('desktop: tray punya cek pembaruan + unduh versi baru', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8');
  assert.ok(main.includes('checkForUpdates'), 'fungsi cek pembaruan ada');
  assert.ok(main.includes('/repos/khadijahcollege-afk/AgentHub/releases/latest'), 'sumber rilis GitHub');
  assert.ok(main.includes('rebuildTrayMenu'), 'menu tray dibangun ulang saat versi baru ditemukan');
  assert.ok(main.includes('scheduleUpdateChecks'), 'cek otomatis terjadwal');
  assert.ok(main.includes('Unduh versi baru'), 'tautan unduh di menu tray');
});

test('docs: dokumen GitHub bebas emoji dan ikonnya berasal dari UI', () => {
  // Glyph tipografis yang dipakai UI (✓ ✕ → ⇄ ⌘ ● ×) diizinkan;
  // yang dilarang adalah emoji berwarna per-platform.
  const allowed = new Set([..."✓✕→⇄⌘●×▍·"].map((c) => c.codePointAt(0)));
  const ranges = [[0x1F300, 0x1FAFF], [0x2600, 0x26FF], [0x2B00, 0x2BFF], [0xFE00, 0xFE0F]];
  const files = ['README.md', 'README.id.md', 'CHANGELOG.md', 'STATE-MACHINES.md', 'docs/BENCHMARK.md'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const bad = ranges.some(([a, b]) => cp >= a && cp <= b) && !allowed.has(cp);
      assert.ok(!bad, `${rel} memakai emoji "${ch}" (U+${cp.toString(16)}) — pakai ikon UI dari assets/icons`);
    }
  }
  // setiap ikon yang dirujuk README harus ada asetnya (hasil tools/export-doc-icons.mjs)
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/assets\/icons\/(\w+)\.svg/g)].map((m) => m[1]);
  assert.ok(refs.length >= 10, 'README memakai ikon UI, bukan emoji');
  for (const name of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/icons/' + name + '.svg')), 'ikon hilang: ' + name);
  }
});
