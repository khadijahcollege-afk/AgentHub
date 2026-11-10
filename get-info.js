// Helper untuk file .bat/.vbs: cetak PORT dan URL (token termasuk) dari config tersimpan.
// Mencari config di folder data app, lalu %APPDATA%\AgentHub (mode terinstall).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)));
const candidates = [
  path.join(appDir, 'data', 'config.json'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AgentHub', 'config.json'),
];

let cfg = { port: 7788, token: '' };
for (const p of candidates) {
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    break;
  } catch { /* coba lokasi berikutnya */ }
}

console.log('PORT=' + cfg.port);
console.log('URL=' + (cfg.token ? `http://127.0.0.1:${cfg.port}/?token=${cfg.token}` : `http://127.0.0.1:${cfg.port}`));
