// lib/backup.js — ekspor & pulihkan semua data AgentHub dalam satu berkas
// JSON. Tujuannya migrasi antar mesin (Windows → macOS dsb.) dan cadangan
// sebelum eksperimen. `config.json` sengaja tidak ikut: berisi token akses &
// port yang sebaiknya diatur ulang di mesin tujuan, bukan dibawa-bawa.
import { readJson, writeJson } from './store.js';

export const BACKUP_STORES = [
  'keys.json',
  'agents.json',
  'tasks.json',
  'notes.json',
  'threads.json',
  'projects.json',
  'prompts.json',
  'schedules.json',
  'environments.json',
  'promo-pass.json',
];

export function backupBundle(now = new Date()) {
  const bundle = {
    app: 'agenthub-backup',
    version: 1,
    exportedAt: now.toISOString(),
    stores: {},
  };
  for (const file of BACKUP_STORES) {
    const data = readJson(file, null);
    if (data !== null) bundle.stores[file] = data;
  }
  return bundle;
}

export function restoreBackup(bundle) {
  if (!bundle || bundle.app !== 'agenthub-backup' || !bundle.stores || typeof bundle.stores !== 'object') {
    const e = new Error('Berkas bukan cadangan AgentHub (penanda app/version tidak cocok)');
    e.statusCode = 400;
    throw e;
  }
  const unknown = Object.keys(bundle.stores).filter((f) => !BACKUP_STORES.includes(f));
  if (unknown.length) {
    const e = new Error(`Berkas tidak dikenal dalam cadangan: ${unknown.join(', ')}`);
    e.statusCode = 400;
    throw e;
  }
  let restored = [];
  for (const [file, data] of Object.entries(bundle.stores)) {
    if (data === null || typeof data !== 'object') continue;
    writeJson(file, data);
    restored.push(file);
  }
  return { restored };
}
