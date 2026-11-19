// lib/update.js — cek pembaruan dari GitHub Releases.
//
// Pembanding versi = fungsi murni (dites tanpa jaringan). Pengambilan rilis
// dibungkus agar bisa diinjeksi saat uji. Prinsip jujur: gagal jaringan/rate
// limit dilaporkan apa adanya — tidak pernah mengarang versi baru.
import { spawn as nodeSpawn } from 'node:child_process';

const RELEASE_API = 'https://api.github.com/repos/khadijahcollege-afk/AgentHub/releases/latest';

// "v1.6.2-beta.1" → { major: 1, minor: 6, patch: 2, pre: 'beta.1' } | null
export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

// true bila `latest` lebih baru daripada `current`. Rilis dengan suffix
// prerelease dianggap LEBIH LAMA dari rilis final dengan nomor yang sama.
export function isNewer(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // sama sampai patch: current prerelease & latest final → latest lebih baru
  if (!b.pre && a.pre) return false;
  if (b.pre && !a.pre) return true;
  return false;
}

// Ambil rilis terbaru dari GitHub API (publik, tanpa auth; wajib User-Agent).
export async function fetchLatestRelease(fetchImpl = fetch, api = RELEASE_API) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetchImpl(api, {
      headers: { 'user-agent': 'AgentHub-update-check', accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const j = await res.json();
    return {
      tag: String(j.tag_name || ''),
      name: String(j.name || ''),
      url: String(j.html_url || 'https://github.com/khadijahcollege-afk/AgentHub/releases/latest'),
      publishedAt: String(j.published_at || ''),
      notes: String(j.body || '').slice(0, 600),
    };
  } finally {
    clearTimeout(t);
  }
}

// Gabungan: info pembaruan untuk UI. `release` boleh null (offline).
export function updateInfo(current, release, { error } = {}) {
  if (error || !release?.tag) {
    return { ok: false, current, error: error || 'Tidak bisa mengambil info rilis' };
  }
  const hasUpdate = isNewer(release.tag, current);
  return {
    ok: true,
    current,
    latest: release.tag,
    hasUpdate,
    url: release.url,
    name: release.name,
    publishedAt: release.publishedAt,
    notes: release.notes,
  };
}

// ---------- auto-update: unduh & pasang dari GitHub Releases ----------

// Aset rilis per platform (nama persis seperti di .github/workflows/release.yml).
export function assetFor(platform = process.platform) {
  if (platform === 'win32') return { name: 'AgentHub-Setup.exe', kind: 'installer' };
  if (platform === 'darwin') return { name: 'AgentHub-macOS.dmg', kind: 'dmg' };
  return { name: 'AgentHub-linux.AppImage', kind: 'appimage' };
}

// URL unduhan "latest" — bisa dioverride untuk uji (AGENTHUB_UPDATE_DOWNLOAD).
export function downloadUrl(assetName, base = process.env.AGENTHUB_UPDATE_DOWNLOAD) {
  return (base || 'https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download')
    .replace(/\/$/, '') + '/' + assetName;
}

// Berkas checksum yang dihasilkan `release.yml` (`sha256sum ... > SHA256SUMS.txt`).
// Namanya sengaja satu konstanta: CI dan verifikasi harus menyebut berkas yang
// sama, dan salah ketik di salah satunya berarti verifikasi diam-diam mati.
export const CHECKSUM_ASSET = 'SHA256SUMS.txt';

// Ambil isi SHA256SUMS.txt untuk rilis yang sama dengan asetnya. Gagal apa pun
// (404 karena rilis lama belum punya berkas ini, jaringan, rate limit)
// mengembalikan null — bukan melempar — karena tidak terverifikasi adalah
// keadaan yang sah dan harus dilaporkan sebagai `unverified`, bukan error.
export async function fetchChecksums(assetName, {
  fetchImpl = fetch, base = process.env.AGENTHUB_UPDATE_DOWNLOAD, timeoutMs = 8000,
} = {}) {
  const url = downloadUrl(CHECKSUM_ASSET, base);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'AgentHub-update-check' }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { ok: true, url, text, checksums: text };
  } catch (e) {
    return { ok: false, url, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Info pembaruan + aset yang cocok untuk platform ini.
export function fullUpdateInfo(current, release, { error, platform } = {}) {
  const base = updateInfo(current, release, { error });
  if (!base.ok) return base;
  const asset = assetFor(platform);
  return {
    ...base,
    asset: { ...asset, url: downloadUrl(asset.name) },
  };
}

// Unduh aset ke file dengan progres. Zero-dependency: reader stream dari
// fetch → file. Gagal jaringan/ukuran aneh dibatalkan dengan pesan jelas.
export async function downloadAsset(url, dest, {
  fetchImpl = fetch, onProgress = null, timeoutMs = 10 * 60 * 1000, maxBytes = 400 * 1024 * 1024,
} = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'AgentHub-auto-update' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} saat mengunduh ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (total && total > maxBytes) throw new Error(`Berkas terlalu besar: ${total} byte`);
    const tmp = dest + '.part';
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const handle = await fs.promises.open(tmp, 'w');
    let bytes = 0;
    let lastTold = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`Unduhan melebihi batas ${maxBytes} byte`);
        await handle.write(chunk);
        if (onProgress && total && bytes - lastTold > 512 * 1024) {
          lastTold = bytes;
          onProgress({ bytes, total, pct: Math.round((bytes / total) * 100) });
        }
      }
      await handle.close();
    } catch (e) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
    if (!bytes) throw new Error('Unduhan kosong — dibatalkan');
    // atomik: .part → final supaya tak ada berkas setengah jadi yang "siap"
    await fs.promises.rename(tmp, dest);
    return { path: dest, bytes };
  } finally {
    clearTimeout(timer);
  }
}

// Argumen installer NSIS untuk pembaruan senyap, disusun di satu tempat.
//
// `--updated` dan `--force-run` BUKAN hiasan:
//   `--updated`   memberi tahu NSIS bahwa ini pembaruan, bukan pemasangan baru.
//                 Template assisted-installer memakainya untuk melewati halaman,
//                 menutup aplikasi yang sedang berjalan (`CHECK_APP_RUNNING`
//                 memakai jalur "sleep lalu kill" khusus `isUpdated`), dan
//                 meneruskan `--updated` ke aplikasi yang dijalankan ulang.
//   `--force-run` membuat aplikasi DIJALANKAN LAGI sesudah pemasangan senyap.
//                 Tanpa ini `installSection.nsh` hanya menjalankan ulang bila
//                 `${isForceRun}` — jadi `/S` saja berarti: terpasang, lalu
//                 tidak ada yang hidup kembali. Persis "sudah diunduh tapi
//                 tidak terjadi apa-apa".
// Ini juga daftar argumen yang dipakai `electron-updater` resmi (NsisUpdater):
// `["--updated", "/S", "--force-run"]`.
export function installerArgs({ silent = true, forceRun = true } = {}) {
  const args = ['--updated'];
  if (silent) args.push('/S');
  if (forceRun) args.push('--force-run');
  return args;
}

// Baris argumen untuk `Start-Process -ArgumentList`.
//
// PENTING — ini pernah salah dan akibatnya nyata di 1.9.12: `/S` TIDAK BOLEH
// dikutip. NSIS mengenali mode senyap dengan aturan ini
// (`Source/exehead/Main.c`, NSISWinMainNOCRT):
//
//     #define END_OF_ARG(c) (c == _T(' ') || c == _T('\0'))
//     if (cmdline[0] == _T('S') && END_OF_ARG(cmdline[1]))
//       g_exec_flags.silent = 1;
//
// Karakter sesudah `S` harus spasi atau akhir baris. Kalau argumennya dikirim
// sebagai `"/S"`, karakter itu adalah tanda kutip, `END_OF_ARG` gagal, dan
// flag senyap DIABAIKAN — installer lalu menampilkan wizard yang menunggu klik.
// Itulah "sudah diunduh tapi tidak dipasang": prosesnya hidup dan menunggu
// halaman "Choose Installation Options".
//
// Jadi hanya argumen yang benar-benar mengandung spasi atau kutip yang dikutip.
// Tidak ada satu pun argumen kita yang butuh itu, tapi fungsinya tetap benar
// untuk path yang kelak berisi spasi.
export function startProcessArgLine(args = installerArgs()) {
  return args
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

// Jalankan installer yang sudah diunduh.
//
// Dua jalur, karena Windows punya dua jenis pemasangan dan keduanya berperilaku
// berbeda saat diminta senyap:
//
//   per-user      (mis. %LOCALAPPDATA%\Programs) — bisa ditulis user biasa,
//                 `/S` benar-benar senyap dan selesai tanpa dialog apa pun.
//   per-machine   (mis. C:\Program Files)        — NSIS membaca
//                 `HKLM\Software\<GUID>\InstallLocation`, menyimpulkan mode "all
//                 users", lalu memanggil UAC_RunElevated DI TENGAH pemasangan.
//
// Bug nyata yang diperbaiki di sini: jalur per-machine diluncurkan dengan
// `windowsHide: true`. UAC tetap muncul (consent.exe), tetapi tidak ada yang
// memberi tahu user bahwa ia harus menyetujuinya, dan proses installer menunggu
// jawaban itu selamanya. Dari sisi user: "sudah diunduh, tapi tidak dipasang".
// Karena itu permintaan elevasi sekarang dibuat di DEPAN lewat
// `Start-Process -Verb RunAs`, yang memang cara Windows meminta izin ke user,
// dan hasilnya dilaporkan sebagai `mode: 'elevated'` — bukan `'silent'` palsu.
//
// `onError` penting: `spawn` bisa GAGAL SECARA ASINKRON (berkas hilang di antara
// pemeriksaan dan eksekusi, atau diblokir antivirus). Tanpa pendengar `error`,
// Node melempar `error` yang tidak tertangani dan mematikan server — tepat pada
// momen yang paling buruk, sesudah user menekan "pasang".
export function launchInstaller(installerPath, platform = process.platform, spawnImpl = null, {
  onError = null, needsElevation = false, onExit = null,
} = {}) {
  // Kebijakan yang sah, bukan hanya untuk tes: ada mesin (kios, lab, komputer
  // bersama) di mana installer boleh diunduh & diverifikasi tetapi TIDAK boleh
  // dijalankan sendiri. Tanpa kunci ini, satu-satunya cara mematikan perilaku
  // itu adalah mematikan autoUpdate sepenuhnya — yang juga mematikan unduhan.
  if (process.env.AGENTHUB_NO_LAUNCH_INSTALLER === '1') {
    return { launched: false, suppressed: true, mode: 'dry-run' };
  }
  // `spawn` diimpor statis. Sebelumnya ia diambil lewat `import()` dinamis:
  // fungsi itu mengembalikan Promise, sehingga `child.pid` SELALU undefined dan
  // pendengar `error` tidak pernah terpasang — kegagalan spawn jadi tidak
  // terlihat sampai server mati.
  const spawn = spawnImpl || nodeSpawn;
  const watch = (child) => {
    if (!child || typeof child.on !== 'function') return child;
    child.on('error', (e) => {
      try { onError?.(e); } catch { /* pelapor gagal bukan alasan melempar */ }
    });
    child.on('exit', (code) => {
      try { onExit?.(code); } catch { /* pelapor gagal bukan alasan melempar */ }
    });
    child.unref?.();
    return child;
  };
  if (platform === 'win32') {
    if (needsElevation) {
      // `Start-Process -Verb RunAs` meminta izin administrator lewat jalur resmi
      // Windows. Shell PowerShell sendiri disembunyikan; yang terlihat hanya
      // dialog UAC, yang memang harus dilihat user.
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      // Kutip tunggal di-escape dengan menggandakannya: path seperti
      // `C:\O'Brien\setup.exe` tidak boleh memecah perintah.
      const quoted = String(installerPath).replace(/'/g, "''");
      // `startProcessArgLine` mengutip hanya yang perlu. `"/S"` yang dikutip
      // mematikan mode senyap di NSIS (lihat komentar fungsinya).
      const argList = startProcessArgLine();
      const script = `Start-Process -FilePath '${quoted}' -ArgumentList '${argList}' -Verb RunAs`;
      const child = watch(spawn(ps, [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
      ], { detached: true, stdio: 'ignore', windowsHide: true }));
      return { launched: true, mode: 'elevated', pid: child?.pid ?? null, needsElevation: true };
    }
    const child = watch(spawn(installerPath, installerArgs(), { detached: true, stdio: 'ignore', windowsHide: true }));
    return { launched: true, mode: 'silent', pid: child?.pid ?? null, needsElevation: false };
  }
  // AppImage/dmg: tak bisa dipasang senyap dari sini — buka saja agar user
  // menyelesaikan langkah terakhir (jujur, bukan pura-pura otomatis).
  const child = watch(spawn(installerPath, [], { detached: true, stdio: 'ignore' }));
  return { launched: true, mode: 'open', pid: child?.pid ?? null, needsElevation: false };
}
