import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const sessions = new Map();
const win = process.platform === 'win32';
export function startTerminal({ command, cwd } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw Object.assign(Error('Perintah wajib diisi (maksimal 8000 karakter)'), { statusCode: 400 });
  let valid = false;
  try { valid = typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory(); } catch { /* invalid folder */ }
  if (!valid) throw Object.assign(Error('Pilih folder proyek yang valid terlebih dahulu'), { statusCode: 400 });
  if ([...sessions.values()].filter(s => ['running', 'stopping'].includes(s.status)).length >= 4) throw Object.assign(Error('Maksimal empat proses terminal aktif'), { statusCode: 409 });
  const id = crypto.randomBytes(16).toString('hex');
  const child = spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' + command] : ['-c', command], { cwd, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
  const session = { id, command, cwd, status: 'running', output: '', exitCode: null, child, truncated: false };
  sessions.set(id, session);
  const append = text => {
    session.output += text;
    if (session.output.length > 200000) { session.output = session.output.slice(-200000); session.truncated = true; }
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', chunk => append(decoder.write(chunk)));
    stream.on('end', () => append(decoder.end()));
  }
  child.on('error', error => { append(error.message); session.status = 'error'; });
  const timer = setTimeout(() => stopTerminal(id), 10 * 60 * 1000); timer.unref();
  child.on('close', code => {
    clearTimeout(timer);
    session.exitCode = code;
    if (session.status === 'stopping') session.status = 'stopped';
    else if (session.status === 'running') session.status = code === 0 ? 'done' : 'error';
    const cleanup = setTimeout(() => sessions.delete(id), 30 * 60 * 1000); cleanup.unref();
  });
  return terminalStatus(id);
}
export function terminalStatus(id) {
  const session = sessions.get(id);
  if (!session) throw Object.assign(Error('Sesi terminal tidak ditemukan'), { statusCode: 404 });
  const { child, ...result } = session;
  return result;
}
export function stopTerminal(id) {
  const session = sessions.get(id);
  if (!session || session.status !== 'running') return;
  session.status = 'stopping';
  if (!session.child.pid) return;
  if (win) {
    const killer = spawn('taskkill', ['/pid', String(session.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => session.child.kill());
  } else { try { process.kill(-session.child.pid, 'SIGKILL'); } catch { session.child.kill(); } }
}
