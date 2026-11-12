// Preview terisolasi: tidak membaca token, key, atau thread pengguna.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ui-check-'));
const port = 7798;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  port, token: 'local-ui-test-only', notify: false,
  refreshHours: 168, agentCheckMinutes: 1440, keyCheckHours: 168,
  baselined: true,
}));
fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
  sources: { openrouter: { models: [] }, cross: { models: [] }, list: { providers: [] } },
  knownIds: [], lastRefresh: Date.now(),
}));
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root, env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
  windowsHide: true, stdio: 'inherit',
});
console.log(`Preview: http://127.0.0.1:${port}/?token=local-ui-test-only`);
console.log(`Data uji: ${dataDir}`);
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
