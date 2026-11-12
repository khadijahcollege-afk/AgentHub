// Tunnel internet opsional: menjembatani AgentHub ke internet lewat
// `cloudflared` (quick tunnel Cloudflare — gratis, tanpa akun). Hasilnya satu
// URL publik terenkripsi yang bisa dibuka dari data seluler.
//
// Keamanan: satu-satunya gerbang tetap token AgentHub (sama seperti LAN).
// Tunnel tidak pernah aktif sendiri — hanya lewat tombol di Pengaturan.
import { spawn } from 'node:child_process';

let proc = null;
let status = 'stopped'; // stopped | starting | online | error
let url = null;
let error = null;

export function tunnelStatus() {
  return { status, url, error };
}

// cloudflared mencetak URL quick tunnel di outputnya:
//   https://<acak>.trycloudflare.com
export function parseTunnelUrl(line) {
  const m = String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

export function startTunnel({ port, cloudflaredPath }) {
  if (proc) return tunnelStatus();
  status = 'starting';
  url = null;
  error = null;
  const cmd = String(cloudflaredPath || 'cloudflared').trim() || 'cloudflared';
  try {
    proc = spawn(cmd, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    proc = null;
    status = 'error';
    error = `${cmd} tidak bisa dijalankan — ${e.message}`;
    return tunnelStatus();
  }
  const onData = (buf) => {
    const found = parseTunnelUrl(buf.toString());
    if (found && status !== 'online') {
      status = 'online';
      url = found;
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', (e) => {
    proc = null;
    status = 'error';
    error = e.code === 'ENOENT'
      ? `${cmd} tidak ditemukan — pasang cloudflared dulu (lihat bantuan di Pengaturan)`
      : `${cmd}: ${e.message}`;
  });
  proc.on('exit', () => {
    proc = null;
    if (status !== 'error') {
      status = 'stopped';
      url = null;
    }
  });
  return tunnelStatus();
}

export function stopTunnel() {
  if (proc) {
    try { proc.kill(); } catch { /* sudah mati */ }
  }
  proc = null;
  status = 'stopped';
  url = null;
  error = null;
  return tunnelStatus();
}
