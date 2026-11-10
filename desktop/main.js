// AgentHub Desktop — shell Electron: jendela aplikasi asli + tray, tanpa browser.
// Server Node berjalan sebagai proses anak (ELECTRON_RUN_AS_NODE) dan menyala
// otomatis saat aplikasi dibuka; ditutup saat aplikasi keluar.
// Bila sudah ada server AgentHub yang hidup di port ini (mis. dari versi lain),
// shell hanya "menempel" dan tidak menyalakan server kedua.
const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 7788;
const startHidden = process.argv.includes('--hidden') || process.argv.includes('--silent');
let win = null;
let tray = null;
let serverProc = null; // hanya terisi bila shell inilah yang menyalakan server
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(bootstrap);
}

// ---------- jalur ----------
function serverEntry() {
  // mode build: resources/server/server.js ; mode dev: ../server.js
  const packed = path.join(process.resourcesPath, 'server', 'server.js');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'server.js');
}
function trayIconPath() {
  const packed = path.join(process.resourcesPath, 'icon.ico');
  return fs.existsSync(packed) ? packed : path.join(__dirname, 'build', 'icon.ico');
}
function dataDir() {
  // build: %APPDATA%\AgentHub (dipakai bersama versi install klasik) ; dev: <repo>/data
  return app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..', 'data');
}

// ---------- server internal ----------
function startServer() {
  const entry = serverEntry();
  const proc = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_DATA: dataDir() },
    stdio: 'ignore',
    windowsHide: true,
  });
  serverProc = proc;
  proc.on('exit', () => { if (serverProc === proc) serverProc = null; });
}

function healthOk(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await healthOk(1500)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function readToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    return cfg.token || '';
  } catch {
    return '';
  }
}

// ---------- jendela ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#0b0f1a',
    autoHideMenuBar: true,
    icon: trayIconPath(),
    title: 'AgentHub',
    show: false,
    webPreferences: { spellcheck: false },
  });

  // link eksternal (mis. detail model OpenRouter) dibuka di browser bawaan
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // tutup jendela = sembunyikan ke tray (kontrol plane tetap jalan)
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

async function showWindow() {
  if (!win) createWindow();
  await waitServer(15000);
  const token = readToken();
  const url = `http://127.0.0.1:${PORT}/` + (token ? `?token=${token}` : '');
  win.loadURL(url);
  win.show();
  win.focus();
}

// ---------- tray ----------
function autostartEnabled() {
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin
    || app.getLoginItemSettings().openAtLogin;
}

function createTray() {
  tray = new Tray(trayIconPath());
  tray.setToolTip('AgentHub — pantau agent & promo API');
  const menu = Menu.buildFromTemplate([
    { label: 'Buka AgentHub', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Jalankan saat PC menyala',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: ['--hidden'],
        });
      },
    },
    { type: 'separator' },
    { label: 'Server berjalan di port ' + PORT, enabled: false },
    { label: 'Keluar', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

// ---------- siklus hidup ----------
async function bootstrap() {
  createTray();
  // bila sudah ada server AgentHub hidup (versi lain), cukup menempel
  if (!(await healthOk(2000))) {
    startServer();
    await waitServer();
  }
  if (startHidden) {
    if (!win) createWindow();
    const token = readToken();
    win.loadURL(`http://127.0.0.1:${PORT}/` + (token ? `?token=${token}` : ''));
  } else {
    await showWindow();
  }
}

app.on('before-quit', () => {
  quitting = true;
  try { if (serverProc) serverProc.kill(); } catch { /* abaikan */ }
});

app.on('window-all-closed', () => {
  // tetap hidup di tray; keluar hanya lewat tray > Keluar
});
