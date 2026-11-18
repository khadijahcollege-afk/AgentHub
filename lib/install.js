// lib/install.js — pemasangan terverifikasi: preflight, checksum, sumber
// berantai, deteksi intersepsi proxy, siklus hidup, dan bundel diagnostik.
//
// Kenapa modul ini ada: `lib/update.js` tahu CARA mengunduh, tetapi tidak tahu
// apakah yang diunduh benar-benar installer yang dimaksud. Bug nyata yang
// mendorong ini: `release.yml` menghasilkan `SHA256SUMS.txt` sejak lama, tetapi
// tidak seorang pun membacanya — unduhan yang terpotong proxy atau berkas HTML
// dari captive portal akan lolos dan "berhasil" tersimpan sebagai
// `AgentHub-Setup.exe`.
//
// Pembanding dengan Claude Setup (Anthropic, Go 1.25, win32-bootstrapper):
// bootstrapper itu memisahkan EMPAT hal yang AgentHub campur jadi satu:
//   - kelayakan mesin  (`checkPrereqs`, `detectArch`, `detectWindowsVersion`)
//   - kesahihan berkas (`Download complete ... SHA256`, `verifyInstallerSignature`)
//   - sumber cadangan   (`Version lookup on %s failed; trying %s`)
//   - laporan kegagalan (`proxyNotInstaller`, `logSavedTo`)
// Yang diambil di sini adalah pemisahan itu, bukan MSIX/Appx API-nya: AgentHub
// memasang NSIS lewat electron-builder, jadi yang relevan adalah pemeriksaan
// sebelum dan sesudah unduhan, bukan cara memasang paket.
//
// Semua fungsi di berkas ini MURNI kecuali yang jelas berurusan dengan disk
// atau jaringan; masing-masing menerima dependensinya sebagai argumen supaya
// bisa diuji tanpa menyentuh mesin sungguhan.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------- checksum ----------

// Parse isi `SHA256SUMS.txt` (format `sha256sum`: "<64 hex><spasi><nama>").
// Baris kosong, komentar, dan baris rusak dilewati — berkas itu dihasilkan
// `sha256sum` di CI, tetapi bisa juga disunting tangan, dan satu baris aneh
// tidak boleh membatalkan seluruh verifikasi.
export function parseChecksums(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // bentuk longgar: hash dulu, lalu spasi, lalu nama (boleh berawalan `*`
    // untuk mode biner)
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    out.set(path.basename(m[2].trim()), m[1].toLowerCase());
  }
  return out;
}

// sha256 sebuah berkas tanpa menahan seluruh isinya di memori. Installer
// Electron bisa 100+ MB; `readFileSync` untuk itu berarti lonjakan memori
// yang tidak perlu di server yang juga melayani semua thread.
export function hashFile(filePath, { chunkSize = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Bandingkan hash berkas dengan yang tercatat. `expected` boleh null (tidak ada
// SHA256SUMS.txt di rilis) — hasilnya `unverified`, BUKAN `ok`: berpura-pura
// terverifikasi saat tidak ada pembanding adalah kebohongan yang sama
// berbahayanya dengan menerima berkas rusak.
export async function verifyFile(filePath, expected, { hash = hashFile } = {}) {
  if (!expected) {
    return { ok: false, status: 'unverified', expected: null, actual: null, reason: 'checksum tidak tersedia' };
  }
  const atual = await hash(filePath);
  const norm = String(expected).toLowerCase();
  if (atual === norm) return { ok: true, status: 'ok', expected: norm, actual: atual, reason: null };
  return { ok: false, status: 'mismatch', expected: norm, actual: atual, reason: 'checksum tidak cocok' };
}

// ---------- deteksi intersepsi proxy ----------

// Content-Type yang TIDAK mungkin untuk installer biner. Ini yang membedakan
// "GitHub mengembalikan HTML login/captive portal" dari "unduhan sungguhan".
const NON_BINARY_TYPES = [
  'text/html', 'text/xml', 'application/xml', 'application/json',
  'text/plain', 'text/csv', 'application/xhtml+xml',
];

// Tebak apakah respons HTTP adalah halaman perantara, bukan berkas installer.
// `expectedBytes` dari content-length ikut diperiksa: proxy yang memotong
// unduhan menghasilkan berkas pendek yang tetap terlihat "berhasil".
// Mengembalikan null bila tidak ada kejanggalan.
export function detectInterception({ contentType = '', bytes = 0, expectedBytes = 0, magic = null } = {}) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (NON_BINARY_TYPES.includes(ct)) {
    return {
      kind: 'content-type',
      detail: `menerima ${bytes} byte ${ct || 'tanpa tipe'} — bukan paket installer`,
      hint: 'biasanya proxy/firewall kantor atau portal login Wi-Fi yang mengembalikan halaman',
    };
  }
  if (expectedBytes && bytes && bytes !== expectedBytes) {
    return {
      kind: 'short-body',
      detail: `menerima ${bytes} dari ${expectedBytes} byte`,
      hint: 'unduhan terpotong — ulangi, atau unduh manual dari halaman rilis',
    };
  }
  // Berkas yang mengaku biner tetapi tidak punya tanda tangan PE di awal:
  // ini yang paling sering terjadi saat proxy mengganti isi tanpa mengubah
  // header. Diperiksa hanya bila `magic` benar-benar dibaca dari disk.
  if (magic && ct && !NON_BINARY_TYPES.includes(ct) && !magic.startsWith('MZ')) {
    return {
      kind: 'not-pe',
      detail: `berkas tidak diawali MZ (${magic.slice(0, 4) || '?'}) — bukan executable Windows`,
      hint: 'isi berkas diganti di tengah jalan; unduh ulang dari halaman rilis',
    };
  }
  return null;
}

// Baca 2 byte pertama supaya `detectInterception` punya bukti nyata, bukan
// dugaan dari nama berkas.
export function readMagic(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(2);
      const n = fs.readSync(fd, buf, 0, 2, 0);
      return buf.subarray(0, n).toString('latin1');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// ---------- preflight ----------

// Periksa kelayakan mesin SEBELUM mengunduh 100 MB. Setiap temuan punya
// `level`: `error` menghentikan pemasangan, `warn` hanya dilaporkan.
// `env` diinjeksi supaya bisa diuji: mesin Windows 8, disk penuh, dan folder
// baca-saja tidak bisa dibuat-buat di mesin uji.
export function preflight({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  freeBytes = null,
  minFreeBytes = 300 * 1024 * 1024,
  dataWritable = true,
  dataDir = '',
  distWritable = true,
  distDir = '',
} = {}) {
  const checks = [];
  const push = (id, level, detail) => checks.push({ id, level, detail });

  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    push('platform', 'error', `Platform ${platform} tidak punya installer AgentHub`);
  } else {
    push('platform', 'ok', `${platform} didukung`);
  }

  if (!['x64', 'arm64'].includes(arch)) {
    push('arch', 'error', `Arsitektur ${arch} tidak didukung — perlu x64 atau arm64`);
  } else {
    push('arch', 'ok', `${arch} didukung`);
  }

  const major = Number(String(nodeVersion).split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    push('node', 'error', `Node ${nodeVersion} terlalu lama — perlu 18 atau lebih baru`);
  } else {
    push('node', 'ok', `Node ${nodeVersion}`);
  }

  if (freeBytes == null) {
    push('disk', 'warn', 'ruang disk tidak bisa dibaca — lanjut tanpa pemeriksaan');
  } else if (freeBytes < minFreeBytes) {
    push('disk', 'error', `ruang disk ${Math.round(freeBytes / 1048576)} MB, perlu ${Math.round(minFreeBytes / 1048576)} MB`);
  } else {
    push('disk', 'ok', `${Math.round(freeBytes / 1048576)} MB tersedia`);
  }

  if (!dataWritable) {
    push('data', 'error', `folder data tidak bisa ditulis${dataDir ? `: ${dataDir}` : ''}`);
  } else {
    push('data', 'ok', 'folder data bisa ditulis');
  }

  // Folder unduhan diperiksa TERPISAH dari folder data. Keduanya bisa berbeda
  // dan di instalasi per-machine memang berbeda: config ada di %APPDATA%
  // (selalu bisa ditulis) sedangkan dist/ berada di samping server.js, yaitu di
  // Program Files. Tanpa pemeriksaan ini, preflight menyatakan "lolos" lalu
  // unduhan 78 MB gagal di byte terakhir — tepat setelah user menunggu.
  if (!distWritable) {
    push('dist', 'error', `folder unduhan tidak bisa ditulis${distDir ? `: ${distDir}` : ''}`);
  } else {
    push('dist', 'ok', 'folder unduhan bisa ditulis');
  }

  const failed = checks.filter((c) => c.level === 'error');
  return { ok: failed.length === 0, checks, failed: failed.map((c) => c.id) };
}

// Jumlah byte bebas di volume tempat `dir` berada. Dipisah karena `statfs`
// tidak ada di semua platform; null berarti "tidak diketahui", bukan nol.
export function freeSpace(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

// Apakah folder bisa ditulis. `accessSync` saja TIDAK cukup: di Windows ia
// hanya memeriksa atribut read-only berkas, bukan ACL yang menolak. Folder
// `Program Files` lolos pemeriksaan itu lalu gagal saat benar-benar ditulis
// (`EPERM`) — persis kegagalan yang membuat 78 MB terunduh sia-sia. Satu-satunya
// bukti yang sah adalah menulis lalu menghapus satu berkas kecil.
//
// Biayanya satu berkas beberapa byte; preflight dipanggil hanya saat user
// membuka pane atau menekan tombol, bukan di jalur panas.
export function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch { return false; }
  const probe = path.join(dir, `.agenthub-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    // Berkas percobaan bisa tertinggal kalau penulisan berhasil tetapi
    // penghapusan gagal; itu bukan alasan menyatakan folder tidak bisa ditulis.
    try { fs.unlinkSync(probe); } catch { /* tidak ada */ }
    return false;
  }
}

// Pilih folder unduhan pertama yang benar-benar bisa ditulis.
//
// Kenapa perlu: default-nya `dist/` di samping `server.js`, dan di instalasi
// per-machine folder itu ada di `Program Files` — read-only untuk user biasa.
// Sebelum ini, server tetap mencoba menulis ke sana: preflight menyatakan
// "lolos" (hanya folder data yang diperiksa), lalu unduhan 78 MB gagal di byte
// terakhir. Kandidat terakhir selalu ada di folder data, yang pasti bisa
// ditulis karena config sudah ditulis ke sana saat boot.
//
// `io` diinjeksi agar urutannya bisa diuji tanpa menyentuh izin folder asli.
export function pickWritableDir(candidates, io = {}) {
  const mkdir = io.mkdir || ((d) => fs.mkdirSync(d, { recursive: true }));
  const writable = io.writable || canWrite;
  const tried = [];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      mkdir(dir);
    } catch (e) {
      tried.push({ dir, ok: false, reason: 'tidak bisa dibuat: ' + String(e?.code || e?.message || e) });
      continue;
    }
    if (!writable(dir)) {
      tried.push({ dir, ok: false, reason: 'tidak bisa ditulis' });
      continue;
    }
    tried.push({ dir, ok: true, reason: null });
    return { dir, tried };
  }
  // Tidak ada yang bisa ditulis. Kembalikan kandidat pertama supaya pesan galat
  // menyebut path yang memang diharapkan, bukan folder acak.
  return { dir: candidates.find(Boolean) || null, tried };
}

// ---------- sumber berantai + retry ----------

// Coba beberapa sumber berurutan sampai satu berhasil. Padanan langsung dari
// `Version lookup on %s failed; trying %s` di Claude Setup: satu host yang
// diblokir kantor tidak boleh membuat cek pembaruan mati total.
// `sources` = [{ label, fn }]; `fn` mengembalikan nilai atau melempar.
export async function firstSuccess(sources, { onFallback = null } = {}) {
  const errors = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    try {
      const value = await s.fn();
      return { ok: true, value, source: s.label, errors };
    } catch (e) {
      errors.push({ source: s.label, error: String(e?.message || e) });
      if (onFallback && i + 1 < sources.length) {
        try { onFallback({ from: s.label, to: sources[i + 1].label, error: String(e?.message || e) }); } catch { /* laporan gagal bukan alasan berhenti */ }
      }
    }
  }
  return { ok: false, value: null, source: null, errors };
}

// Retry dengan backoff eksponensial + jitter. Jitter penting: tanpa itu,
// semua instance AgentHub yang hidup bersamaan menabrak host yang sama pada
// milidetik yang sama setelah gangguan jaringan.
export async function retry(fn, {
  attempts = 3, baseMs = 400, maxMs = 8000, jitter = 0.25, sleep = null, shouldRetry = null,
} = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, value: await fn(i), attempts: i + 1 };
    } catch (e) {
      lastError = e;
      if (shouldRetry && !shouldRetry(e, i)) break;
      if (i + 1 >= attempts) break;
      const raw = Math.min(maxMs, baseMs * 2 ** i);
      const spread = raw * jitter;
      await wait(Math.round(raw - spread + Math.random() * spread * 2));
    }
  }
  return { ok: false, value: null, error: String(lastError?.message || lastError), attempts };
}

// ---------- siklus hidup: sudah terpasang? ----------

// Apakah versi yang berjalan sudah sama dengan yang ditawarkan rilis.
// Bedanya dengan `isNewer`: di sini yang ditanya "perlu memasang?", bukan
// "mana yang lebih baru" — dan prarilis lokal tidak dianggap perlu dipasang
// ulang dengan versi final yang nomornya sama.
export function installDecision({ current, latest, hasUpdate, downloadStatus }) {
  if (!latest) return { action: 'none', why: 'versi terbaru belum diketahui' };
  if (!hasUpdate) return { action: 'none', why: 'sudah versi terbaru' };
  if (downloadStatus === 'downloading') return { action: 'wait', why: 'unduhan sedang berjalan' };
  if (downloadStatus === 'verifying') return { action: 'wait', why: 'checksum sedang diperiksa' };
  if (downloadStatus === 'installing') return { action: 'wait', why: 'installer sedang berjalan' };
  if (downloadStatus === 'ready') return { action: 'install', why: 'installer siap dipasang' };
  if (downloadStatus === 'error') return { action: 'retry', why: 'unduhan terakhir gagal' };
  return { action: 'download', why: 'versi baru tersedia' };
}

// Boleh memasang SEKARANG, tunda, atau tolak? Diambil sebagai fungsi murni
// karena aturannya dipakai dua pintu yang berbeda — tombol "Pasang sekarang"
// dan rantai otomatis sesudah unduhan selesai — dan kedua pintu itu tidak boleh
// punya aturan penolakan yang berbeda. Bug yang dicegah: checksum yang tidak
// cocok lolos lewat jalur otomatis karena hanya endpoint HTTP yang memeriksanya.
//
// `defer` khusus untuk pemasangan otomatis: memasang berarti aplikasi ditutup,
// dan run agent yang sedang berjalan akan mati di tengah pekerjaan. Pemasangan
// yang diminta user secara eksplisit tidak pernah ditunda — ia yang memutuskan.
export function installGate({
  ready = false, installing = false, verifyStatus = 'none',
  preflightFailed = null, activeRuns = 0, auto = false,
} = {}) {
  if (installing) return { action: 'skip', code: 'INSTALLING', why: 'installer sedang berjalan' };
  if (!ready) return { action: 'skip', code: 'NOT_READY', why: 'berkas installer belum siap diunduh' };
  if (verifyStatus === 'mismatch') {
    return {
      action: 'refuse',
      code: 'CHECKSUM_MISMATCH',
      why: 'checksum tidak cocok dengan SHA256SUMS.txt rilis',
    };
  }
  if (preflightFailed && preflightFailed.length) {
    return {
      action: 'refuse',
      code: 'PREFLIGHT_FAILED',
      why: `pemasangan dihalangi: ${preflightFailed.join(', ')}`,
    };
  }
  if (auto && activeRuns > 0) {
    return {
      action: 'defer',
      code: 'DEFERRED',
      why: `menunggu ${activeRuns} run selesai`,
      activeRuns,
    };
  }
  return { action: 'install', code: 'OK', why: 'installer siap dipasang' };
}

// Perintah uninstall per platform. Dikembalikan sebagai data, bukan dijalankan
// di sini: pemanggil yang memutuskan, supaya modul ini tetap bisa diuji.
export function uninstallPlan({
  platform = process.platform, root = '', startupDir = '', dataDir = '',
} = {}) {
  if (platform === 'win32') {
    return {
      platform,
      steps: [
        { id: 'autostart', label: 'Hapus entri autostart', path: path.join(startupDir || '', 'agenthub-server.vbs') },
        { id: 'data', label: 'Hapus folder data (thread, key, catatan)', path: dataDir },
        { id: 'app', label: 'Jalankan uninstaller bawaan installer', path: root },
      ],
      note: 'Langkah app dijalankan oleh uninstaller NSIS; dua langkah pertama dikerjakan AgentHub sendiri.',
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      steps: [
        { id: 'data', label: 'Hapus folder data', path: dataDir },
        { id: 'app', label: 'Pindahkan AgentHub.app ke Trash', path: root },
      ],
      note: null,
    };
  }
  return {
    platform,
    steps: [
      { id: 'data', label: 'Hapus folder data', path: dataDir },
      { id: 'app', label: 'Hapus AppImage / paket deb', path: root },
    ],
    note: null,
  };
}

// ---------- bundel diagnostik ----------

// Kumpulkan fakta yang benar-benar dipakai saat melaporkan bug — bukan
// dump lingkungan. Setiap kunci di sini pernah dibutuhkan untuk menjawab
// satu pertanyaan nyata ("kenapa unduhan gagal?", "kenapa engine tidak
// terdeteksi?"). Rahasia (token, API key) TIDAK PERNAH ikut; nilainya
// diganti penanda supaya keberadaannya tetap terlihat tanpa membocorkannya.
const SECRET_KEYS = ['token', 'apiKey', 'key', 'secret', 'password', 'authorization'];

export function redact(value, depth = 0) {
  if (depth > 6) return '[terlalu dalam]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))
        ? (v ? '[disembunyikan]' : v)
        : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

// Susun bundel. `parts` diinjeksi pemanggil (versi app, update, kunci,
// engine, log terakhir) supaya modul ini tidak perlu mengimpor setengah
// server dan tetap bisa diuji dengan objek kecil.
export function diagnosticsBundle({
  appVersion = '', platform = process.platform, arch = process.arch,
  nodeVersion = process.versions.node, uptimeMs = 0, parts = {}, logs = [],
  now = () => new Date(),
} = {}) {
  return {
    app: 'agenthub-diagnostics',
    version: 1,
    generatedAt: now().toISOString(),
    runtime: {
      appVersion, platform, arch, nodeVersion,
      uptimeMs: Math.round(uptimeMs),
      execPath: process.execPath,
      dataDir: parts.dataDir || null,
    },
    sections: redact(parts),
    logs: logs.slice(-200).map((l) => String(l).slice(0, 400)),
  };
}

// Bentuk teks dari bundel: satu berkas yang bisa ditempel ke laporan bug.
// JSON dipakai untuk bagian mesin, tetapi ringkasan di atasnya membuat berkas
// ini tetap terbaca manusia tanpa alat bantu.
export function bundleToText(bundle) {
  const b = bundle || {};
  const lines = [
    `AgentHub diagnostics — ${b.generatedAt || '?'}`,
    `versi ${b.runtime?.appVersion || '?'} · ${b.runtime?.platform || '?'}/${b.runtime?.arch || '?'} · Node ${b.runtime?.nodeVersion || '?'}`,
    `uptime ${Math.round((b.runtime?.uptimeMs || 0) / 1000)} dtk · data ${b.runtime?.dataDir || '?'}`,
    '',
    '--- bagian ---',
    JSON.stringify(b.sections || {}, null, 2),
  ];
  if (b.logs?.length) {
    lines.push('', '--- log terakhir ---', ...b.logs);
  }
  return lines.join('\n');
}
