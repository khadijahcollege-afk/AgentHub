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
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file(name));
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
  baselined: false,      // snapshot pertama tanpa alert
  createdAt: Date.now(),
};

export function loadConfig() {
  const cfg = readJson('config.json', null);
  if (cfg) return { ...DEFAULT_CONFIG, ...cfg };
  const fresh = { ...DEFAULT_CONFIG };
  writeJson('config.json', fresh);
  return fresh;
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
