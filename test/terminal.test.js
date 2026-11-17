// test/terminal.test.js — kontrak tab terminal (REA ZCode
// docs/ui/terminal-sessions.md). Yang diuji adalah aturan yang membuat terminal
// berguna dipakai berjam-jam: tab terpisah, nomor stabil dengan nomor terkecil
// yang bebas, nama tab tidak pernah berubah, menutup panel tidak membunuh sesi,
// dan menutup tab benar-benar melepasnya.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-term-'));
process.env.AGENTHUB_DATA = dataDir;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-term-work-'));
const workB = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-term-workb-'));

const term = await import('../lib/terminal.js');

test.after(() => {
  for (const d of [dataDir, work, workB]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// Perintah cepat yang keluarannya bisa diperiksa. Skrip ditulis ke berkas dan
// dijalankan lewat `node <berkas>`: tanda kutip bersarang tidak selamat melewati
// PowerShell, dan perintah yang gagal karena kutip akan mengaburkan yang diuji.
// `node` dipakai dari PATH, bukan path absolut: PowerShell memperlakukan path
// berkutip-spasi sebagai perintah tanpa operator `&`, dan itu aturan PowerShell
// — bukan yang sedang diuji di sini.
const OUT = (text) => {
  const file = path.join(work, `say-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)}.cjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(text)});\n`);
  return file;
};
const say = (text) => `node "${OUT(text)}"`;
const slow = `node "${path.join(work, 'slow.cjs')}"`;
const FAIL = path.join(work, 'fail.cjs');
fs.writeFileSync(path.join(work, 'slow.cjs'), 'setTimeout(() => {}, 30000);\n');
fs.writeFileSync(FAIL, 'process.exit(3);\n');

// Tunggu dengan timer sungguhan, bukan busy-wait: proses anak butuh event loop
// yang bebas untuk menyelesaikan I/O-nya. Busy-wait membuat perintah yang
// seharusnya selesai dalam 100 ms terlihat "running" selamanya.
async function waitDone(id, ms = 25000) {
  const deadline = Date.now() + ms;
  let run = term.terminalStatus(id);
  while (['running', 'stopping'].includes(run.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    run = term.terminalStatus(id);
  }
  return run;
}

test('tab pertama tanpa nomor, tab berikutnya memakai nomor 2 dan 3', async () => {
  const a = term.startTerminal({ command: say('satu'), cwd: work, workspaceKey: 'ws-nomor' });
  const b = term.startTerminal({ command: say('dua'), cwd: work, workspaceKey: 'ws-nomor' });
  const c = term.startTerminal({ command: say('tiga'), cwd: work, workspaceKey: 'ws-nomor' });
  assert.equal(a.tab, 1);
  assert.equal(b.tab, 2);
  assert.equal(c.tab, 3);
  // Nomor 1 tidak ditampilkan: tab dasar terbaca sebagai nama foldernya saja.
  const base = path.basename(work);
  assert.equal(a.label, base);
  assert.equal(b.label, `${base} 2`);
  assert.equal(c.label, `${base} 3`);
  await waitDone(a.id); await waitDone(b.id); await waitDone(c.id);
  for (const x of [a, b, c]) term.closeTerminal(x.tabId);
});

test('menutup tab bernomor membuat nomornya dipakai lagi, nama tab lain tidak berubah', async () => {
  const a = term.startTerminal({ command: say('a'), cwd: work, workspaceKey: 'ws-reuse' });
  const b = term.startTerminal({ command: say('b'), cwd: work, workspaceKey: 'ws-reuse' });
  assert.equal(b.tab, 2);
  await waitDone(a.id); await waitDone(b.id);
  assert.equal(term.closeTerminal(b.tabId), true, 'tab 2 ditutup');

  const c = term.startTerminal({ command: say('c'), cwd: work, workspaceKey: 'ws-reuse' });
  assert.equal(c.tab, 2, 'nomor terkecil yang bebas dipakai lagi, bukan 3');
  assert.equal(c.label, `${path.basename(work)} 2`);

  // Tab pertama TIDAK berganti nama menjadi "2" hanya karena tab 2 dibuat lagi.
  const tabs = term.listTerminals('ws-reuse').tabs;
  const first = tabs.find((t) => t.id === a.tabId);
  assert.equal(first.tab, 1);
  assert.equal(first.label, path.basename(work));
  await waitDone(c.id);
  for (const x of [a, c]) term.closeTerminal(x.tabId);
});

test('tab terpisah: perintah di tab lain tidak menimpa transkrip tab pertama', async () => {
  const a = term.startTerminal({ command: say('keluaran-A'), cwd: work, workspaceKey: 'ws-pisah' });
  await waitDone(a.id);
  const b = term.startTerminal({ command: say('keluaran-B'), cwd: work, workspaceKey: 'ws-pisah', tabId: a.tabId });
  await waitDone(b.id);
  const tab = term.getTerminalTab(a.tabId);
  assert.match(tab.transcript, /keluaran-A/, 'keluaran perintah pertama tetap ada');
  assert.match(tab.transcript, /keluaran-B/, 'keluaran perintah kedua ikut');
  assert.equal(tab.runs.length, 2, 'dua perintah dalam satu tab tercatat terpisah');
  assert.equal(tab.tab, 1, 'menjalankan perintah lagi tidak membuat tab baru');
  term.closeTerminal(a.tabId);
});

test('tab baru bisa dibuat kosong, dan nomornya ikut aturan yang sama', () => {
  const t1 = term.createTerminalTab({ cwd: work, workspaceKey: 'ws-kosong' });
  const t2 = term.createTerminalTab({ cwd: work, workspaceKey: 'ws-kosong' });
  assert.equal(t1.tab, 1);
  assert.equal(t2.tab, 2);
  assert.equal(t1.transcript, '');
  assert.equal(t1.status, 'idle');
  term.closeTerminal(t1.id);
  term.closeTerminal(t2.id);
});

test('workspace berbeda tidak berbagi tab dan nomornya mulai dari 1 lagi', async () => {
  const a = term.startTerminal({ command: say('ws-a'), cwd: work, workspaceKey: 'ws-A' });
  const b = term.startTerminal({ command: say('ws-b'), cwd: workB, workspaceKey: 'ws-B' });
  assert.equal(a.tab, 1);
  assert.equal(b.tab, 1, 'workspace lain punya penomoran sendiri');
  const listA = term.listTerminals('ws-A').tabs;
  assert.equal(listA.length, 1, 'daftar tab workspace A hanya miliknya');
  assert.equal(listA[0].cwd, work, 'tab workspace A tetap di foldernya');
  await waitDone(a.id); await waitDone(b.id);
  term.closeTerminal(a.tabId); term.closeTerminal(b.tabId);
});

test('menutup tab menghentikan proses dan melepas sesinya', async () => {
  const tab = term.createTerminalTab({ cwd: work, workspaceKey: 'ws-tutup' });
  const t = term.startTerminal({ command: slow, cwd: work, workspaceKey: 'ws-tutup', tabId: tab.id });
  assert.equal(term.terminalStatus(t.id).status, 'running');
  assert.equal(term.closeTerminal(tab.id), true);
  assert.equal(term.listTerminals('ws-tutup').tabs.length, 0, 'tab benar-benar hilang');
  assert.throws(() => term.terminalStatus(t.id), /tidak ditemukan/, 'run-nya ikut dilepas');
});

test('tab yang masih berjalan menolak perintah kedua, bukan menimpanya', () => {
  const tab = term.createTerminalTab({ cwd: work, workspaceKey: 'ws-sibuk' });
  const t = term.startTerminal({ command: slow, cwd: work, workspaceKey: 'ws-sibuk', tabId: tab.id });
  assert.throws(
    () => term.startTerminal({ command: say('tabrak'), cwd: work, workspaceKey: 'ws-sibuk', tabId: tab.id }),
    (err) => err.statusCode === 409,
    'perintah kedua di tab yang sama harus 409',
  );
  term.closeTerminal(tab.id);
});

test('batas proses aktif tetap berlaku lintas tab', () => {
  const tabs = [];
  for (let i = 0; i < 4; i++) tabs.push(term.createTerminalTab({ cwd: work, workspaceKey: 'ws-batas' }));
  const runs = tabs.map((t) => term.startTerminal({ command: slow, cwd: work, workspaceKey: 'ws-batas', tabId: t.id }));
  assert.equal(runs.length, 4);
  const extra = term.createTerminalTab({ cwd: work, workspaceKey: 'ws-batas' });
  assert.throws(
    () => term.startTerminal({ command: say('lima'), cwd: work, workspaceKey: 'ws-batas', tabId: extra.id }),
    (err) => err.statusCode === 409 && /Maksimal/.test(err.message),
  );
  for (const t of tabs) term.closeTerminal(t.id);
  term.closeTerminal(extra.id);
});

test('folder yang tidak ada ditolak, bukan membuat tab dengan cwd palsu', () => {
  assert.throws(() => term.createTerminalTab({ cwd: 'relatif', workspaceKey: 'ws-x' }), (e) => e.statusCode === 400);
  assert.throws(() => term.createTerminalTab({ cwd: path.join(work, 'tidak-ada'), workspaceKey: 'ws-x' }), (e) => e.statusCode === 400);
  assert.throws(() => term.startTerminal({ command: '', cwd: work }), (e) => e.statusCode === 400);
});

test('transkrip memuat perintah dan status penutupnya', async () => {
  const t = term.startTerminal({ command: say('selesai-ok'), cwd: work, workspaceKey: 'ws-transkrip' });
  const run = await waitDone(t.id);
  assert.equal(run.status, 'done');
  assert.equal(run.exitCode, 0);
  const tab = term.getTerminalTab(t.tabId);
  assert.match(tab.transcript, /\$\s/, 'perintah dicatat dengan penanda prompt');
  assert.match(tab.transcript, /selesai-ok/, 'keluaran ikut tersimpan');
  assert.match(tab.transcript, /Selesai/, 'baris penutup menyebut statusnya');
  term.closeTerminal(t.tabId);
});

test('keluaran gagal tetap tersimpan di tab, bukan membuang sesinya', async () => {
  // Perintah yang keluar dengan kode != 0: tab harus tetap ada supaya pengguna
  // bisa membaca pesan errornya.
  const t = term.startTerminal({ command: `node "${FAIL}"`, cwd: work, workspaceKey: 'ws-gagal' });
  const run = await waitDone(t.id);
  assert.equal(run.status, 'error');
  assert.equal(run.exitCode, 3);
  const tabs = term.listTerminals('ws-gagal').tabs;
  assert.equal(tabs.length, 1, 'tab tidak hilang saat perintahnya gagal');
  assert.equal(tabs[0].status, 'error');
  term.closeTerminal(t.tabId);
});
