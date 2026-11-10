// Pasang autostart: buat agenthub-server.vbs di folder Startup Windows
// yang memanggil agenthub-autostart.vbs milik app (server tersembunyi saat PC menyala).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbs = path.join(startup, 'agenthub-server.vbs');
const target = path.join(here, 'agenthub-autostart.vbs');

const content = `CreateObject("Wscript.Shell").Run """${target}""", 0, False\n`;

fs.writeFileSync(vbs, content, 'utf8');
console.log('Autostart terpasang: ' + vbs);
