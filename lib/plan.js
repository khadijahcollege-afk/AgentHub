// lib/plan.js — plan mode yang dipimpin agent: masuk, menyusun rencana,
// meminta persetujuan, lalu keluar.
//
// Masalah yang diselesaikan: mode `plan` di AgentHub hanya bisa dipilih
// pengguna dari chip akses. Agent tidak bisa memutuskan "pekerjaan ini
// sebaiknya direncanakan dulu", dan tidak ada dokumen rencana yang bisa
// disetujui — jadi "setuju" berarti tidak ada yang disetujui, dan setelah
// persetujuan tidak ada jejak apa yang sudah disepakati.
//
// Tiga aturan yang dipegang:
//   • Masuk plan boleh tanpa izin, keluar butuh manusia. `EnterPlanMode`
//     hanya MENGURANGI kemampuan (tidak menulis, tidak menjalankan perintah),
//     jadi menanyakannya hanya menambah klik. `ExitPlanMode` membuka kembali
//     kemampuan menulis, jadi ia selalu bertanya — termasuk di yolo.
//   • Rencana adalah teks yang dilihat manusia sebelum apa pun berubah.
//     Tanpa teks, "setujui" tidak berarti apa-apa; karena itu plan kosong
//     ditolak sebagai kesalahan schema, bukan diterima sebagai rencana hampa.
//   • Rencana disimpan ke berkas di folder kerja, bukan hanya di percakapan.
//     Ringkasan konteks (`compact`) membuang pesan lama; berkas rencana tidak
//     ikut terbuang, jadi keputusan di awal thread tetap bisa dibaca model
//     setelah percakapan diringkas.
//
// Isi modul ini murni: tidak ada I/O model, tidak ada jaringan. Penulisan
// berkas ada di `writePlanFile` yang dipanggil server, supaya aturan bentuk
// rencana bisa diuji tanpa folder kerja.
import fs from 'node:fs';
import path from 'node:path';

export const ENTER_PLAN_TOOL = 'EnterPlanMode';
export const EXIT_PLAN_TOOL = 'ExitPlanMode';

// Sama dengan ZCode (PLAN_MODE_MAX_PLAN_CHARS). Rencana yang lebih panjang dari
// ini bukan rencana lagi, ia dokumen — dan dokumen sepanjang itu tidak dibaca
// siapa pun sebelum menekan setujui.
export const MAX_PLAN_CHARS = 20000;

// Folder kerja bisa punya `.git` sendiri; `.agenthub` sengaja dipisah supaya
// rencana tidak pernah tercampur dengan berkas proyek yang di-commit.
export const PLAN_DIR = '.agenthub';
export const PLAN_SUBDIR = 'plans';

// Keputusan yang boleh datang dari kartu persetujuan rencana.
export const PLAN_DECISIONS = ['approve', 'reject'];

function bad(error) { return { ok: false, error }; }

// Id thread dipakai sebagai nama berkas: hanya karakter yang aman di semua
// platform, dan tidak pernah berupa `.`/`..` yang bisa keluar folder.
export function sanitizeName(value) {
  const s = String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return s.slice(0, 80) || 'plan';
}

export function planFilePath(cwd, threadId) {
  if (!cwd) return null;
  return path.join(cwd, PLAN_DIR, PLAN_SUBDIR, `plan-${sanitizeName(threadId)}.md`);
}

// Path relatif untuk ditampilkan ke pengguna dan disebut model. Path absolut
// folder pengguna tidak perlu muncul di UI.
export function planFileRelPath(threadId) {
  return `${PLAN_DIR}/${PLAN_SUBDIR}/plan-${sanitizeName(threadId)}.md`;
}

// ---------- transisi mode ----------
// Mode "sebelum plan" diingat supaya keluar dari plan mengembalikan pengguna ke
// mode yang ia pilih sendiri, bukan ke bawaan. Agent yang masuk plan dari yolo
// lalu keluar ke build akan diam-diam memperketat run berikutnya.
export function nextPrePlanMode(mode, previous = null) {
  const m = String(mode || '').trim();
  if (m && m !== 'plan') return m;
  return previous || 'build';
}

// Apakah tool ini boleh dipanggil tanpa bertanya. Keduanya sengaja sempit:
// hanya dua nama itu, bukan awalan, supaya tool lain tidak bisa menyamar.
export function isPlanTool(name) {
  return name === ENTER_PLAN_TOOL || name === EXIT_PLAN_TOOL;
}

// Aturan izin transisi mode. Mengembalikan `undefined` bila tool bukan tool
// rencana, supaya pemanggil bisa melanjutkan ke aturan biasa.
//
// `ExitPlanMode` dijawab `ask` di sini — bukan `allow` — walaupun nanti
// persetujuannya lewat jalur rencana, bukan jalur izin tool. Gerbang `ask`
// adalah satu-satunya yang menjamin tidak ada jalur (termasuk yolo) yang
// melewatinya tanpa manusia.
export function planTransitionVerdict(name, { mode = 'yolo', planActive = false } = {}) {
  if (name === ENTER_PLAN_TOOL) {
    // Masuk plan saat sudah di plan: tidak ada yang berubah, dan meminta izin
    // untuk tidak berubah hanya mengganggu.
    if (planActive || mode === 'plan') {
      return { allow: true, decision: 'allow', reason: 'Sudah di plan mode' };
    }
    return { allow: true, decision: 'allow', reason: 'Plan mode hanya mengurangi kemampuan' };
  }
  if (name === EXIT_PLAN_TOOL) {
    if (!planActive && mode !== 'plan') {
      return {
        allow: false,
        decision: 'deny',
        reason: 'ExitPlanMode hanya bisa dipakai saat plan mode aktif',
        code: 'NOT_IN_PLAN_MODE',
      };
    }
    return {
      allow: false,
      decision: 'ask',
      reason: 'Rencana perlu disetujui sebelum agent boleh mengubah berkas',
      alwaysAsk: true,
      planApproval: true,
    };
  }
  return undefined;
}

// ---------- bentuk rencana ----------
// `plan` bisa datang sebagai string atau (dari provider yang membungkusnya)
// objek. Keduanya dinormalkan, lalu diperiksa: kosong, terlalu panjang, atau
// bukan teks berarti model salah bentuk dan harus memperbaikinya sekali.
export function normalizePlan(input) {
  const raw = input && typeof input === 'object' ? input.plan : input;
  if (typeof raw !== 'string') return bad('`plan` wajib berupa teks rencana.');
  const text = raw.replace(/\r\n/g, '\n').trim();  if (!text) return bad('`plan` tidak boleh kosong: tulis rencananya, bukan judulnya saja.');
  if (text.length > MAX_PLAN_CHARS) {
    return bad(`Rencana terlalu panjang: ${text.length} karakter, maksimal ${MAX_PLAN_CHARS}. Ringkas menjadi rencana, bukan dokumen.`);
  }
  return { ok: true, plan: text };
}

// `allowedPrompts` dari ZCode: kategori tindakan yang akan dibutuhkan rencana,
// mis. "run tests". Di sini ia hanya keterangan untuk pengguna — TIDAK dipakai
// untuk membuka izin. Izin tetap satu per satu lewat kartu persetujuan;
// kategori yang disetujui di muka adalah janji kosong yang tidak bisa
// diverifikasi, dan satu kategori longgar ("install dependencies") bisa
// menutupi perintah apa pun.
export function normalizeAllowedPrompts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  // Batas diterapkan SETELAH membuang yang hampa. Memotong lebih dulu berarti
  // delapan entri kosong di awal menghabiskan kuota dan kategori yang benar-benar
  // dibutuhkan hilang dari kartu.
  for (const item of list) {
    const tool = String(item?.tool || '').trim();
    const prompt = String(item?.prompt || '').trim().replace(/\s+/g, ' ');
    if (!prompt) continue;
    out.push({ tool: tool || 'run_command', prompt: prompt.slice(0, 200) });
    if (out.length >= 8) break;
  }
  return out;
}

// Isi berkas rencana. Kepala yang tetap (thread, folder, waktu persetujuan)
// membuat berkas terbaca sebagai rencana bila dibuka di editor, bukan teks
// mentah tanpa konteks — dan menyebut folder kerjanya supaya rencana lama tidak
// tertukar dengan pekerjaan di folder lain.
export function renderPlanFile({ plan, threadId, cwd, approvedAt = null }) {
  const when = new Date(approvedAt || Date.now()).toISOString();
  const head = [
    '# Rencana',
    '',
    `- Thread: ${threadId || '-'}`,
    `- Folder: ${cwd || '-'}`,
    `- Disetujui: ${approvedAt ? when : 'belum'}`,
    '',
    '---',
    '',
  ];
  return `${head.join('\n')}\n${String(plan || '').trim()}\n`;
}

// Ditulis atomik seperti penyimpanan lain: berkas setengah jadi yang terbaca
// setelah crash akan membuat model menyusun rencana di atas teks yang terpotong.
export function writePlanFile({ cwd, threadId, plan, approvedAt = null }) {
  const file = planFilePath(cwd, threadId);
  if (!file) throw new Error('Folder kerja belum ada');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, renderPlanFile({ plan, threadId, cwd, approvedAt }), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readPlanFile({ cwd, threadId }) {
  const file = planFilePath(cwd, threadId);
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function planFileExists({ cwd, threadId }) {
  const file = planFilePath(cwd, threadId);
  if (!file) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Pengingat setelah ringkasan konteks. Ringkasan bisa membuang pesan yang
// memuat rencana; tanpa pengingat ini model mengira belum ada rencana lalu
// menyusun ulang dari nol — atau lebih buruk, mengubah berkas yang sudah
// disepakati dengan rencana yang berbeda. Hanya path yang disebut: isi berkas
// masih bisa dibaca dengan `read_file`, jadi tidak perlu disalin ke prompt.
export function planReminder({ cwd, threadId, approved = false }) {
  const rel = planFileRelPath(threadId);
  if (!cwd || !planFileExists({ cwd, threadId })) return null;
  return [
    `Berkas rencana ada di: ${rel}`,
    approved
      ? 'Rencana ini sudah disetujui pengguna. Ikuti rencananya; kalau situasinya berubah sehingga rencana itu tidak lagi benar, katakan terus terang alih-alih diam-diam menyimpang.'
      : 'Rencana ini BELUM disetujui. Jangan mengubah berkas sebelum pengguna setuju.',
  ].join('\n');
}

// Hasil yang dibaca model setelah rencana disetujui. Kalimatnya menyebut mode
// baru secara eksplisit: model perlu tahu ia kini boleh menulis, karena
// instruksi system sebelumnya berkata sebaliknya.
export function approvedNotice({ mode }) {
  return [
    'Rencana disetujui pengguna. Kamu sekarang boleh mengubah berkas sesuai rencana itu.',
    `Mode saat ini: ${mode}.`,
    'Kerjakan rencananya langkah demi langkah. Kalau menemukan hal yang membuat rencana tidak bisa dijalankan seperti tertulis, berhenti dan jelaskan — jangan mengubah arah tanpa memberi tahu.',
  ].join('\n');
}

export function rejectedNotice({ reason }) {
  return [
    `Rencana ditolak pengguna${reason ? `: ${reason}` : ''}.`,
    'Jangan mengubah berkas. Tetap di plan mode, tanyakan bagian mana yang perlu diubah, lalu susun ulang rencananya.',
  ].join('\n');
}

// Untuk jalur tanpa manusia (delegate, CLI, API langsung). Tanpa ini tool akan
// menggantung sampai batas waktu lalu gagal dengan pesan yang salah; dengan
// ini model tahu harus berhenti dan menyampaikan rencananya sebagai jawaban.
export function noClientNotice() {
  return [
    'Tidak ada pengguna yang bisa menyetujui rencana di jalur ini (delegate, CLI, atau API langsung).',
    'Kamu tetap di plan mode. Sampaikan rencananya sebagai jawaban akhir, lalu berhenti tanpa mengubah berkas.',
  ].join('\n');
}
