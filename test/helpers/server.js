// Helper boot server untuk tes.
//
// Kenapa ada: 28 berkas tes menjalankan `server.js` sungguhan dengan pola yang
// sama, dan semuanya memakai `stdio: 'ignore'`. Akibatnya ketika boot gagal —
// port bentrok, config tidak terbaca, modul error — satu-satunya yang terlihat
// adalah `assert.equal(await waitUp(), true, 'server harus hidup')` setelah
// menunggu 20 detik. Pesan itu tidak menyebut SEBABNYA, sehingga kegagalan
// nyata (bug di server) tidak bisa dibedakan dari gangguan lingkungan (port
// dipakai proses lain). Itu yang membuat flake mahal: harus dijalankan ulang
// berulang kali untuk menebak.
//
// Helper ini menangkap stderr/stdout proses anak, menyimpannya, dan
// menyertakannya di pesan kegagalan. Satu perubahan di sini memperbaiki
// diagnosa 28 berkas sekaligus.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CAPTURE = 8000;

// Kode keluar Windows yang perlu disebut namanya.
//
// Tanpa ini, `code=3221226505` tidak berarti apa pun bagi yang membaca laporan,
// dan orang berikutnya akan menebak "port bentrok" untuk kegagalan yang
// sebenarnya adalah proses yang mati di level sistem operasi.
const EXIT_NAMES = {
  3221226505: '0xC0000409 (STATUS_STACK_BUFFER_OVERRUN — fast-fail Windows, proses berhenti paksa)',
  3221225725: '0xC00000FD (STATUS_STACK_OVERFLOW)',
  3221225477: '0xC0000005 (ACCESS_VIOLATION)',
  3221225479: '0xC0000008 (INVALID_HANDLE)',
  // Node memetakan abort()/assert native menjadi 128+SIGABRT, sehingga kode
  // yang terlihat bisa 134 alih-alih NTSTATUS mentah. Keduanya berarti hal
  // yang sama: proses berhenti di level sistem, bukan `process.exit` biasa.
  134: '134 (SIGABRT — proses berhenti paksa, biasanya abort/assert native)',
};

function describeExit({ code, signal }) {
  if (signal) return `dihentikan sinyal ${signal}`;
  const named = EXIT_NAMES[code];
  return named
    ? `keluar dengan ${named}`
    : `keluar dengan kode ${code}`;
}

// Jalankan server.js untuk tes dan tunggu sampai /healthz menjawab.
// Mengembalikan { child, log, alive } — pemanggil tetap memiliki `child`
// supaya bisa mematikannya di `test.after`.
export async function startTestServer({
  root, port, dataDir, env = {}, waitMs = 20000, healthPath = '/healthz', script = 'server.js',
} = {}) {
  let log = '';
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      AGENTHUB_DATA: dataDir,
      AGENTHUB_NO_TOAST: '1',
      // Tanpa ini, server yang menemukan portnya terpakai akan pindah ke
      // port+1 dan tes menunggu port aslinya sampai timeout. Tes harus gagal
      // cepat dengan sebab yang benar, bukan menggantung.
      AGENTHUB_STRICT_PORT: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const take = (d) => {
    log += String(d);
    if (log.length > MAX_CAPTURE) log = log.slice(-MAX_CAPTURE);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);

  // Exit dini = boot gagal. Tanpa ini, tes menunggu 20 detik penuh untuk
  // proses yang sudah mati sejak milidetik pertama.
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });

  const t0 = Date.now();
  let alive = false;
  while (Date.now() - t0 < waitMs) {
    if (exited) break;
    try {
      // Timeout wajib di sini. Tanpa itu, bila port dipegang proses lain yang
      // menerima sambungan tetapi tidak pernah menjawab, `fetch` menggantung
      // SELAMANYA — seluruh berkas tes ikut menggantung alih-alih gagal dengan
      // pesan. Ini yang membuat flake terasa seperti "tes berhenti".
      const r = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) { alive = true; break; }
    } catch { /* belum siap, atau port dijawab proses lain */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    child,
    alive,
    log,
    exited,
    // Pesan yang menyebut SEBAB, bukan hanya gejalanya.
    //
    // Versi pertama fungsi ini menulis "biasanya port sudah dipakai" untuk
    // SETIAP kematian dini. Itu keliru: pada satu kegagalan nyata, log justru
    // menunjukkan banner "AgentHub aktif" — server sempat hidup, lalu mati
    // karena crash 0xC0000409. Menyebut sebab yang salah lebih buruk daripada
    // tidak menyebut sebab, karena mengarahkan orang berikutnya untuk
    // memeriksa hal yang tidak bersalah. Karena itu penyebab sekarang
    // disimpulkan dari BUKTI di log, bukan dari dugaan.
    failure() {
      let why;
      if (!exited) {
        why = `server tidak menjawab ${healthPath} dalam ${waitMs} ms di port ${port}`
          + ' — proses masih hidup, jadi kemungkinan besar sibuk atau menggantung';
      } else if (/sudah dipakai dan AGENTHUB_STRICT_PORT/.test(log)) {
        why = `port ${port} sudah dipakai proses lain (server menolak pindah port)`;
      } else if (/AgentHub aktif/.test(log)) {
        why = `server sempat hidup di port ${port} lalu ${describeExit(exited)}`
          + ' — ini crash setelah boot, bukan masalah port';
      } else if (/Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError/.test(log)) {
        why = `server gagal memuat kode: ${describeExit(exited)}`;
      } else if (/EADDRINUSE/.test(log)) {
        why = `port ${port} bentrok (EADDRINUSE) dan ${describeExit(exited)}`;
      } else {
        why = `server ${describeExit(exited)} sebelum sempat menjawab ${healthPath} di port ${port}`;
      }
      return `${why}\n--- keluaran server ---\n${log.trim() || '(kosong)'}`;
    },
  };
}

// Hentikan proses anak dan tunggu benar-benar mati.
//
// `child.kill()` hanya MENGIRIM sinyal; proses masih memegang portnya selama
// beberapa milidetik sesudahnya. Tes berikutnya yang memilih port dari rentang
// bertumpuk bisa mendapat port yang masih dipegang proses lama. Menunggu event
// `exit` menutup celah itu.
export function stopTestServer(child, { timeoutMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } done(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); done(); });
    try { child.kill(); } catch { clearTimeout(t); done(); }
  });
}

// Hapus folder data setelah server benar-benar berhenti.
//
// Windows menolak menghapus folder yang berkasnya masih terbuka (EPERM/EBUSY).
// `maxRetries` bawaan `rmSync` sudah menangani sebagian, tetapi tidak bila
// prosesnya baru saja dimatikan. Ini memberi jeda lalu mencoba lagi.
export function removeDir(dir, { attempts = 12, delayMs = 50 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* coba lagi */ }
    const until = Date.now() + delayMs;
    while (Date.now() < until) { /* jeda sinkron singkat */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* menyerah: bukan alasan menggagalkan tes */ }
}
