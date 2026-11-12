// AgentHub Desktop — jendela dan tray dengan server internal.
// Server yang sudah hidup hanya dipakai jika versi dan token lokal cocok.
const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { probeServer } = require('./server-connection.cjs');
const VERSION = require('./package.json').version;

const startHidden = process.argv.includes('--hidden') || process.argv.includes('--silent');
let win = null;
let tray = null;
let serverProc = null;
let serverPort = 7788;
let quitting = false;
let ready = false;
let opening = false;

app.setName('AgentHub');
if (process.platform === 'win32') app.setAppUserModelId('tech.agenthub.desktop');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (ready) showWindow().catch(failStartup); });
  app.whenReady().then(bootstrap).catch(failStartup);
}

function serverEntry() {
  const packed = path.join(process.resourcesPath, 'server', 'server.js');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'server.js');
}
function trayIconPath() {
  const packed = path.join(process.resourcesPath, 'icon.ico');
  return fs.existsSync(packed) ? packed : path.join(__dirname, 'build', 'icon.ico');
}
function dataDir() {
  return app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..', 'data');
}
function localConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) {
      throw new Error('Port konfigurasi tidak valid.');
    }
    return cfg;
  } catch (error) {
    if (error.code === 'ENOENT') return { port: 7788, token: '' };
    throw error;
  }
}
function probe() {
  const cfg = localConfig();
  serverPort = cfg.port;
  return probeServer({ port: cfg.port, token: cfg.token, version: VERSION });
}
function startServer() {
  const entry = serverEntry();
  fs.mkdirSync(dataDir(), { recursive: true });
  const log = fs.openSync(path.join(dataDir(), 'desktop-server.log'), 'a');
  try {
    const proc = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_DATA: dataDir() },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    serverProc = proc;
    proc.on('error', (error) => { if (!quitting) failStartup(error); });
    proc.on('exit', () => { if (serverProc === proc) serverProc = null; });
  } finally { fs.closeSync(log); }
}
async function waitServer() {
  const deadline = Date.now() + 30000;
  while (!quitting && Date.now() < deadline) {
    const result = await probe();
    if (result.state === 'ready') return;
    if (result.state === 'blocked') throw new Error(result.reason);
    if (!serverProc) throw new Error('Server berhenti sebelum siap. Periksa desktop-server.log di folder data aplikasi.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server belum siap setelah 30 detik. Periksa desktop-server.log.');
}
function failStartup(error) {
  if (quitting) return;
  dialog.showErrorBox('AgentHub belum dapat dibuka', `${error.message}\n\nTutup AgentHub lama melalui tray → Keluar, lalu buka kembali versi ini. Tidak ada proses lain atau data yang dihapus.`);
  quitting = true;
  app.quit();
}

// Tetap gunakan jendela sendiri; tautan web biasa dibuka di browser pilihan user.
function openExternal(url) {
  try {
    const target = new URL(url);
    if (target.protocol === 'https:' || target.protocol === 'http:') {
      shell.openExternal(target.href).catch(() => {});
    }
  } catch { /* URL tidak valid tidak dibuka */ }
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 420, minHeight: 560,
    backgroundColor: '#0d0f13', autoHideMenuBar: true,
    icon: trayIconPath(), title: `AgentHub ${VERSION}`, show: false,
    webPreferences: { spellcheck: false, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === `http://127.0.0.1:${serverPort}`) return;
    } catch { /* batalkan navigasi yang tidak valid */ }
    event.preventDefault();
    openExternal(url);
  });
  win.on('close', (event) => {
    if (!quitting) { event.preventDefault(); win.hide(); }
  });
}
async function showWindow() {
  if (opening || quitting) return;
  opening = true;
  try {
    if (!win || win.isDestroyed()) createWindow();
    if (!win.webContents.getURL()) {
      const result = await probe();
      if (result.state !== 'ready') throw new Error(result.reason || 'Server tidak tersedia.');
      const cfg = localConfig();
      await win.loadURL(`http://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(cfg.token)}`);
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } finally { opening = false; }
}
function createTray() {
  tray = new Tray(trayIconPath());
  tray.setToolTip(`AgentHub ${VERSION}`);
  tray.setContextMenu(trayTemplate());
  tray.on('click', () => showWindow().catch(failStartup));
}

// ---------- cek pembaruan (GitHub Releases) ----------
// Sama seperti /api/update-check di server, tapi di sisi shell: versi lebih
// baru diumumkan lewat notifikasi Windows dan menu tray menyediakan tautan
// langsung ke halaman rilis. Cek otomatis sekali saat boot + tiap 6 jam.
let updateMenuUrl = null;
let updateChecking = false;
function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}
function isNewer(latest, current) {
  const a = semver(latest), b = semver(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  return !!(b.pre && !a.pre);
}
async function checkForUpdates(manual = false) {
  if (updateChecking) return;
  updateChecking = true;
  try {
    const res = await fetch('https://api.github.com/repos/khadijahcollege-afk/AgentHub/releases/latest', {
      headers: { 'user-agent': 'AgentHub-desktop-update-check', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const rel = await res.json();
    const tag = String(rel.tag_name || '');
    if (isNewer(tag, VERSION)) {
      updateMenuUrl = String(rel.html_url || 'https://github.com/khadijahcollege-afk/AgentHub/releases/latest');
      rebuildTrayMenu();
      const note = new Notification('AgentHub', {
        body: `Versi baru ${tag} tersedia — buka menu tray untuk mengunduh.`,
        silent: !manual,
      });
      note.on('click', () => { shell.openExternal(updateMenuUrl); });
      note.show();
    } else if (manual) {
      const note = new Notification('AgentHub', { body: `Sudah versi terbaru (${VERSION}).` });
      note.show();
    }
  } catch (e) {
    if (manual) {
      dialog.showErrorBox('Cek pembaruan gagal', String(e.message || e) + '\n\nCek koneksi internet, lalu coba lagi.');
    }
  } finally {
    updateChecking = false;
  }
}
function trayTemplate() {
  const template = [
    { label: 'Buka AgentHub', click: () => showWindow().catch(failStartup) },
    { type: 'separator' },
    {
      label: 'Jalankan saat PC menyala', type: 'checkbox',
      checked: app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--hidden'] }),
    },
    { label: 'Cek pembaruan', click: () => checkForUpdates(true) },
  ];
  if (updateMenuUrl) {
    template.push({ label: 'Unduh versi baru', click: () => shell.openExternal(updateMenuUrl) });
  }
  template.push(
    { type: 'separator' },
    { label: `Versi ${VERSION} · port ${serverPort}`, enabled: false },
    { label: 'Keluar', click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(template);
}
function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(trayTemplate());
}
function scheduleUpdateChecks() {
  setTimeout(() => checkForUpdates(false), 15_000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}
async function bootstrap() {
  const status = await probe();
  if (status.state === 'blocked') throw new Error(status.reason);
  if (status.state === 'absent') { startServer(); await waitServer(); }
  ready = true;
  createTray();
  if (!startHidden) await showWindow();
  scheduleUpdateChecks();
}
app.on('before-quit', () => {
  quitting = true;
  try { serverProc?.kill(); } catch { /* hanya proses server milik shell ini */ }
});
app.on('window-all-closed', () => { /* monitoring tetap berjalan di tray */ });
