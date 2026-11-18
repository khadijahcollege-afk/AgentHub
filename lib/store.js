// Penyimpanan JSON sederhana dengan penulisan atomik (tmp -> rename).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Cari folder data yang bisa ditulis:
//  1) override via env AGENTHUB_DATA
//  2) terinstall di Program Files → %APPDATA%\AgentHub
//  3) <app>/data (mode source / portable), fallback %APPDATA%\AgentHub
function resolveDataDir() {
  if (process.env.AGENTHUB_DATA) {
    fs.mkdirSync(process.env.AGENTHUB_DATA, { recursive: true });
    return process.env.AGENTHUB_DATA;
  }
  const local = path.join(ROOT, '..', 'data');
  const installed = /Program Files/i.test(ROOT);
  if (!installed) {
    try {
      fs.mkdirSync(local, { recursive: true });
      fs.accessSync(local, fs.constants.W_OK);
      return local;
    } catch { /* jatuh ke APPDATA */ }
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(appData, 'AgentHub');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const DATA_DIR = resolveDataDir();

function file(name) {
  return path.join(DATA_DIR, name);
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file(name), 'utf8')));
  } catch {
    return fallback;
  }
}

// Buang BOM di awal berkas sebelum JSON.parse.
//
// Kenapa perlu: BOM (U+FEFF) adalah hal biasa di Windows — Notepad, dan
// `Set-Content -Encoding utf8` di PowerShell 5.1, menuliskannya. `JSON.parse`
// MENOLAK BOM dengan "Unexpected token", sehingga `readJson` mengembalikan
// fallback. Pada `config.json` akibatnya bukan kosmetik: `loadConfig()`
// menyimpulkan "belum ada config", membuat config baru dengan token acak dan
// port 7788, lalu MENIMPA berkas pengguna. Token akses dan port yang sudah
// diatur hilang tanpa satu pun peringatan, dan gejalanya menyesatkan — server
// hidup di port lain dengan token lain, seolah pengaturannya diabaikan.
//
// Ditemukan lewat uji paket portable: config uji ditulis dengan BOM oleh
// PowerShell, dan server mengabaikannya sepenuhnya. BOM tidak pernah valid di
// dalam JSON (RFC 8259), jadi membuangnya di pembaca adalah penanganan yang
// benar dan tidak mengubah arti berkas yang sah.
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function writeJson(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameWithRetry(tmp, file(name));
}

// Rename atomik dengan percobaan ulang.
//
// Di Windows, `rename` bisa gagal `EPERM`/`EBUSY` sesaat setelah berkasnya
// ditulis: antivirus dan Windows Search membuka berkas baru untuk dipindai,
// dan selama pemindaian itu handle-nya memblokir rename. Kegagalan ini
// transien — beberapa milidetik kemudian berkas yang sama bisa diganti.
// Di POSIX penyebabnya lain (mis. NFS atau direktori yang sedang di-scan),
// tetapi sifatnya sama: sementara.
//
// Tanpa retry, satu pemindaian antivirus yang kebetulan bersamaan membuat
// penyimpanan config gagal dan (di server) dapat meninggalkan berkas .tmp
// yang menumpuk. Retry singkat menghilangkan seluruh kelas kegagalan ini.
//
// Sengaja TIDAK dibatasi `process.platform === 'win32'`: percobaan ulang hanya
// terjadi ketika rename benar-benar gagal, jadi jalur sukses tidak menambah
// biaya apa pun, dan membatasi per platform berarti perilakunya berbeda di
// mesin yang menjalankan tes.
function renameWithRetry(from, to, { attempts = 8, delayMs = 25 } = {}) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || i + 1 >= attempts) throw e;
      // Jeda sinkron yang nyata. `writeJson` dipanggil dari kode sinkron di
      // seluruh server, jadi tidur async bukan pilihan; busy-wait membakar CPU
      // pada disk yang sedang dipindai antivirus. `Atomics.wait` menidurkan
      // thread ini tanpa keduanya.
      sleepSync(delayMs * (i + 1));
    }
  }
}

// Tidur sinkron singkat. Node membolehkan `Atomics.wait` di thread utama
// (tidak seperti di browser), dan `SharedArrayBuffer` sengaja dibuat baru
// setiap panggilan supaya tidak ada state bersama.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* fallback: platform tanpa Atomics.wait */ }
  }
}

// ---------- Config ----------
const DEFAULT_CONFIG = {
  port: 7788,
  token: crypto.randomBytes(20).toString('hex'),
  notify: true,          // toast Windows
  refreshHours: 6,       // interval refresh sumber promo
  agentCheckMinutes: 15, // interval health-check agent
  keyCheckHours: 12,     // interval re-validasi API key
  autoPool: true,        // key baru langsung masuk pool gateway (siap dipakai agent)
  // Pembaruan otomatis: periksa, unduh, verifikasi, lalu PASANG tanpa ditanya.
  // Dulu nilai ini hanya hidup sebagai `config.autoUpdate !== false`, jadi
  // pengguna yang tidak pernah menulis key ini selalu dianggap memilih "ya"
  // tanpa pernah melihat pilihannya. Sekarang ia nilai sungguhan yang tersimpan.
  autoUpdate: true,
  baselined: false,      // snapshot pertama tanpa alert
  cloudflaredPath: '',   // path opsional cloudflared.exe untuk tunnel internet
  replyLang: 'auto',     // bahasa balasan agent: auto | id | en | ja | zh | es | ar
  createdAt: Date.now(),
};

export function loadConfig() {
  const cfg = readJson('config.json', null);
  if (cfg) return { ...DEFAULT_CONFIG, ...cfg };
  // Belum ada config → buat baru. Tetapi bila berkasnya ADA dan gagal dibaca,
  // itu bukan "belum ada": itu config yang rusak. Menimpanya langsung berarti
  // token dan port pengguna hilang tanpa jejak, dan satu-satunya bukti yang
  // bisa dipakai untuk memulihkannya ikut terhapus. Simpan dulu sebagai
  // .rusak-<waktu>, baru tulis yang baru.
  salvageBroken('config.json');
  const fresh = { ...DEFAULT_CONFIG };
  writeJson('config.json', fresh);
  return fresh;
}

// Sisihkan berkas yang ada tetapi tidak bisa diurai, supaya isinya masih bisa
// diperiksa orang kemudian. Diam-diam menghapus data pengguna bukan perbaikan.
function salvageBroken(name) {
  const src = file(name);
  if (!fs.existsSync(src)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(src, `${src}.rusak-${stamp}`);
  } catch { /* bila gagal, biarkan: menulis config baru tetap lebih baik daripada tidak jalan */ }
}

export function saveConfig(cfg) {
  writeJson('config.json', cfg);
}

// ---------- Koleksi generik ----------
export function loadCollection(name, fallback = []) {
  const data = readJson(name, null);
  if (Array.isArray(data)) return data;
  writeJson(name, fallback);
  return fallback;
}

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}
