// lib/update.js — cek pembaruan dari GitHub Releases.
//
// Pembanding versi = fungsi murni (dites tanpa jaringan). Pengambilan rilis
// dibungkus agar bisa diinjeksi saat uji. Prinsip jujur: gagal jaringan/rate
// limit dilaporkan apa adanya — tidak pernah mengarang versi baru.
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

// Jalankan installer yang sudah diunduh (Windows NSIS: /S = senyap,
// electron-builder menata ulang & menjalankan ulang aplikasi setelahnya).
export function launchInstaller(installerPath, platform = process.platform, spawnImpl = null) {
  const spawn = spawnImpl || (async (...args) => (await import('node:child_process')).spawn(...args));
  if (platform === 'win32') {
    const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return { launched: true, mode: 'silent' };
  }
  // AppImage/dmg: tak bisa dipasang senyap dari sini — buka saja agar user
  // menyelesaikan langkah terakhir (jujur, bukan pura-pura otomatis).
  const child = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { launched: true, mode: 'open' };
}
