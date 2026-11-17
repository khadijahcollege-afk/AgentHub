// lib/terminal.js — terminal proyek: tab per workspace, satu perintah satu proses.
//
// Bukan PTY: setiap perintah membuka proses baru lalu selesai. Itu memang
// batasnya (program interaktif belum didukung), dan tab di bawah tidak
// mengubahnya. Yang diambil dari ZCode (docs/ui/terminal-sessions.md) adalah
// kontrak TAB-nya, karena itulah yang membuat terminal berguna dipakai
// berjam-jam:
//
//   • Tab adalah sesi terpisah, bukan tampilan dari satu sesi. Tab kedua tidak
//     menimpa keluaran tab pertama, dan menutup satu tab tidak menyentuh yang
//     lain.
//   • Nomor tab stabil dan memakai nomor terkecil yang bebas. Tab pertama
//     tampil tanpa nomor ("proyek"), tab berikutnya "proyek 2", "proyek 3".
//     Setelah "proyek 2" ditutup, tab baru memakai nomor 2 lagi, dan tab yang
//     sudah ada TIDAK pernah diganti nama — nama yang berubah-ubah membuat
//     pengguna kehilangan jejak tab mana yang sedang ia lihat.
//   • Identifier workspace hanya untuk memisahkan tab. Folder kerja tetap
//     dipakai apa adanya sebagai cwd proses.
//   • Menutup panel tidak membunuh sesi; hanya menutup tab yang membunuh.
//     Menutup panel lalu membukanya lagi harus mengembalikan keluaran yang
//     sama, bukan terminal kosong.
//
// Kenapa tab disimpan di SERVER, bukan di memori halaman: perintah yang masih
// berjalan tetap berjalan walau tab browser ditutup atau workspace diganti.
// Kalau daftar tab hanya ada di klien, memuat ulang halaman kehilangan
// prosesnya — pengguna melihat terminal kosong sementara `npm test` masih
// jalan di latar belakang. Dengan registry di sini, daftar itu bisa dibaca
// ulang kapan saja.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const win = process.platform === 'win32';

const MAX_ACTIVE = 4;            // proses bersamaan, seperti sebelumnya
const MAX_TABS = 8;              // tab tersimpan per workspace
const MAX_RUNS_PER_TAB = 40;     // riwayat perintah per tab
const MAX_OUTPUT = 200000;       // karakter keluaran per perintah
const MAX_TRANSCRIPT = 400000;   // karakter gabungan per tab
const IDLE_TTL_MS = 30 * 60 * 1000;

const tabs = new Map();   // tabId -> tab
const runs = new Map();   // runId -> run (proses + keluaran satu perintah)

function tabRuns(tab) {
  return tab.runIds.map((id) => runs.get(id)).filter(Boolean);
}

function newestRun(tab) {
  const list = tabRuns(tab);
  return list.length ? list[list.length - 1] : null;
}

function workspaceTabs(workspaceKey) {
  const key = String(workspaceKey || '');
  return [...tabs.values()].filter((t) => t.workspaceKey === key).sort((a, b) => a.tab - b.tab);
}

// Nomor terkecil yang belum dipakai di workspace ini. 1 = tab dasar (tanpa
// nomor di UI), karena itu tidak pernah "dipakai ulang" secara visual.
function nextTabNumber(workspaceKey) {
  const used = new Set(workspaceTabs(workspaceKey).map((t) => t.tab));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

// Label tab: nama folder + nomor. Nomor 1 tidak ditampilkan supaya tab pertama
// terbaca sebagai "terminal proyek ini", bukan "terminal nomor satu".
export function tabLabel(cwd, tab) {
  const base = path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || 'terminal';
  return tab > 1 ? `${base} ${tab}` : base;
}

function trimTab(tab) {
  while (tab.runIds.length > MAX_RUNS_PER_TAB) {
    const old = tab.runIds.shift();
    runs.delete(old);
  }
  if (tab.transcript.length > MAX_TRANSCRIPT) {
    tab.transcript = tab.transcript.slice(-MAX_TRANSCRIPT);
    tab.truncated = true;
  }
}

function pruneWorkspace(workspaceKey) {
  // Tab yang semua perintahnya sudah selesai dibuang lebih dulu; kalau masih
  // penuh, yang paling tua. Tab yang sedang berjalan tidak pernah dibuang.
  const list = workspaceTabs(workspaceKey);
  if (list.length <= MAX_TABS) return;
  const idle = list
    .filter((t) => !['running', 'stopping'].includes(newestRun(t)?.status || ''))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (workspaceTabs(workspaceKey).length > MAX_TABS && idle.length) {
    const victim = idle.shift();
    for (const id of victim.runIds) runs.delete(id);
    tabs.delete(victim.id);
  }
}

export function runView(run) {
  if (!run) return null;
  const { child, ...rest } = run;
  return rest;
}

export function tabView(tab, { transcript = false } = {}) {
  const cur = newestRun(tab);
  return {
    id: tab.id,
    tab: tab.tab,
    label: tab.label,
    cwd: tab.cwd,
    workspaceKey: tab.workspaceKey,
    createdAt: tab.createdAt,
    runCount: tab.runIds.length,
    status: cur?.status || 'idle',
    exitCode: cur?.exitCode ?? null,
    activeRunId: cur && ['running', 'stopping'].includes(cur.status) ? cur.id : null,
    truncated: !!tab.truncated,
    ...(transcript ? { transcript: tab.transcript } : {}),
    runs: tabRuns(tab).map((r) => ({
      id: r.id, command: r.command, status: r.status, exitCode: r.exitCode,
      truncated: !!r.truncated, createdAt: r.createdAt, endedAt: r.endedAt,
    })),
  };
}

function findTab(tabId) {
  const tab = tabs.get(String(tabId || ''));
  if (!tab) throw Object.assign(Error('Tab terminal tidak ditemukan'), { statusCode: 404 });
  return tab;
}

// Tab kosong. Tombol "+" harus membuka tab tanpa harus menjalankan perintah
// dulu: pengguna sering menyiapkan tab untuk folder lain sebelum mengetik.
export function createTerminalTab({ cwd, workspaceKey } = {}) {
  let valid = false;
  try { valid = typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory(); } catch { /* invalid folder */ }
  if (!valid) throw Object.assign(Error('Pilih folder proyek yang valid terlebih dahulu'), { statusCode: 400 });
  const key = typeof workspaceKey === 'string' && workspaceKey.trim() ? workspaceKey.trim().slice(0, 300) : '';
  if (workspaceTabs(key).length >= MAX_TABS) {
    throw Object.assign(Error(`Maksimal ${MAX_TABS} tab terminal per workspace`), { statusCode: 409 });
  }
  const number = nextTabNumber(key);
  const tab = {
    id: crypto.randomBytes(16).toString('hex'),
    workspaceKey: key,
    tab: number,
    label: tabLabel(cwd, number),
    cwd,
    createdAt: Date.now(),
    runIds: [],
    transcript: '',
    truncated: false,
  };
  tabs.set(tab.id, tab);
  return tabView(tab, { transcript: true });
}

// Jalankan satu perintah. Tanpa `tabId`, tab baru dibuat: perintah pertama di
// sebuah workspace membuka tab pertama, persis seperti terminal yang dibuka
// untuk pertama kali.
export function startTerminal({ command, cwd, workspaceKey, tabId } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw Object.assign(Error('Perintah wajib diisi (maksimal 8000 karakter)'), { statusCode: 400 });

  let tab = null;
  if (tabId) tab = findTab(tabId);

  let valid = false;
  try { valid = typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory(); } catch { /* invalid folder */ }
  if (!valid && tab) valid = fs.existsSync(tab.cwd);
  if (!valid) throw Object.assign(Error('Pilih folder proyek yang valid terlebih dahulu'), { statusCode: 400 });
  const dir = tab ? (cwd && fs.existsSync(cwd) ? cwd : tab.cwd) : cwd;

  const busy = tab ? tabRuns(tab).filter((r) => ['running', 'stopping'].includes(r.status)) : [];
  if (busy.length) throw Object.assign(Error('Tab ini masih menjalankan perintah — tunggu selesai atau tekan Stop'), { statusCode: 409 });
  if ([...runs.values()].filter((r) => ['running', 'stopping'].includes(r.status)).length >= MAX_ACTIVE) {
    throw Object.assign(Error(`Maksimal ${MAX_ACTIVE} proses terminal aktif`), { statusCode: 409 });
  }

  // Kunci workspace dipakai HANYA untuk memisahkan tab antar-workspace. Nilai
  // aneh dari klien tidak boleh membuat tab tak terlihat, jadi ia dibatasi
  // panjangnya dan disimpan apa adanya.
  const key = tab ? tab.workspaceKey : (typeof workspaceKey === 'string' && workspaceKey.trim() ? workspaceKey.trim().slice(0, 300) : '');
  if (!tab) {
    const number = nextTabNumber(key);
    tab = {
      id: crypto.randomBytes(16).toString('hex'),
      workspaceKey: key,
      tab: number,
      label: tabLabel(dir, number),
      cwd: dir,
      createdAt: Date.now(),
      runIds: [],
      transcript: '',
      truncated: false,
    };
    tabs.set(tab.id, tab);
    pruneWorkspace(key);
  }
  if (tab.cwd !== dir) tab.cwd = dir;

  const id = crypto.randomBytes(16).toString('hex');
  // Exit code harus diteruskan. `powershell.exe -Command "<skrip>"` hanya
  // melaporkan 1 untuk SETIAP kegagalan di dalam skrip, jadi `node x.js` yang
  // keluar dengan 3 terlihat seperti 1 — dan terminal yang melaporkan exit 1
  // untuk semua kegagalan tidak berguna justru saat dipakai membaca CI.
  // `exit $LASTEXITCODE` mengembalikan kode asli perintah native terakhir;
  // bila perintahnya cmdlet PowerShell (tidak menyetel $LASTEXITCODE), yang
  // dipakai $? — 1 bila gagal, 0 bila berhasil.
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' + command
    + '; $c = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif (-not $?) { 1 } else { 0 }; exit $c';
  const child = spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] : ['-c', command], { cwd: dir, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { id, tabId: tab.id, command, cwd: dir, status: 'running', output: '', exitCode: null, child, truncated: false, createdAt: Date.now(), endedAt: null };
  runs.set(id, run);
  tab.runIds.push(id);
  tab.transcript += `$ ${command}\n`;
  trimTab(tab);

  const append = (text) => {
    run.output += text;
    if (run.output.length > MAX_OUTPUT) { run.output = run.output.slice(-MAX_OUTPUT); run.truncated = true; }
    // Transkrip tab adalah riwayat yang dibaca ulang setelah panel ditutup,
    // jadi ia menerima aliran yang sama — bukan salinan yang dibuat belakangan.
    tab.transcript += text;
    if (tab.transcript.length > MAX_TRANSCRIPT) { tab.transcript = tab.transcript.slice(-MAX_TRANSCRIPT); tab.truncated = true; }
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk) => append(decoder.write(chunk)));
    stream.on('end', () => append(decoder.end()));
  }
  child.on('error', (error) => { append(error.message); run.status = 'error'; });
  const timer = setTimeout(() => stopTerminal(id), 10 * 60 * 1000); timer.unref();
  child.on('close', (code) => {
    clearTimeout(timer);
    run.exitCode = code;
    run.endedAt = Date.now();
    // status 'error' bisa sudah diset handler 'error' (spawn gagal); jangan
    // ditimpa jadi 'done' hanya karena close juga terpanggil.
    if (run.status === 'stopping') run.status = 'stopped';
    else if (run.status === 'running') run.status = code === 0 ? 'done' : 'error';
    tab.transcript += `\n[${run.status === 'done' ? 'Selesai' : run.status === 'stopped' ? 'Dihentikan' : 'Gagal'}${code != null ? ' · exit ' + code : ''}]\n\n`;
    trimTab(tab);
    const cleanup = setTimeout(() => { runs.delete(id); tab.runIds = tab.runIds.filter((x) => x !== id); }, IDLE_TTL_MS);
    cleanup.unref();
  });

  return { ...runView(run), tabId: tab.id, tab: tab.tab, label: tab.label };
}

export function terminalStatus(id) {
  const run = runs.get(String(id || ''));
  if (!run) throw Object.assign(Error('Sesi terminal tidak ditemukan'), { statusCode: 404 });
  const tab = tabs.get(run.tabId);
  return { ...runView(run), tabId: run.tabId, tab: tab?.tab ?? null, label: tab?.label ?? null };
}

// Daftar tab untuk satu workspace. Dipakai UI saat panel dibuka dan setelah
// halaman dimuat ulang: perintah yang masih berjalan di server tetap terlihat.
export function listTerminals(workspaceKey) {
  return { tabs: workspaceTabs(workspaceKey).map((t) => tabView(t)) };
}

export function getTerminalTab(tabId) {
  return tabView(findTab(tabId), { transcript: true });
}

export function stopTerminal(id) {
  const run = runs.get(String(id || ''));
  if (!run || run.status !== 'running') return;
  run.status = 'stopping';
  if (!run.child.pid) return;
  if (win) {
    const killer = spawn('taskkill', ['/pid', String(run.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => run.child.kill());
  } else { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { run.child.kill(); } }
}

// Tutup tab: hentikan perintah yang masih jalan, lalu lepas sesinya. Berbeda
// dari menutup panel — panel hanya menyembunyikan, tab benar-benar melepas.
export function closeTerminal(tabId) {
  const tab = tabs.get(String(tabId || ''));
  if (!tab) return false;
  for (const id of tab.runIds) {
    stopTerminal(id);
    runs.delete(id);
  }
  tabs.delete(tab.id);
  return true;
}
