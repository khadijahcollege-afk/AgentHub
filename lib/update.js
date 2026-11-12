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
