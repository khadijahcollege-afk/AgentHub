// Notifikasi Windows (balloon toast) via PowerShell — tanpa dependency.
import { spawn } from 'node:child_process';

let lastToast = 0;

export function toast(title, message) {
  // Jangan spam: minimal jeda 5 detik antar toast
  const now = Date.now();
  if (now - lastToast < 5000) return;
  lastToast = now;

  const esc = (s) => String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.BalloonTipTitle = '${esc(title)}'
$n.BalloonTipText = '${esc(message)}'
$n.ShowBalloonTip(6000)
Start-Sleep -Seconds 7
$n.Dispose()
`;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    p.on('error', () => {});
    p.unref();
  } catch {
    // notifikasi bersifat opsional — abaikan kegagalan
  }
}
