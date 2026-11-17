// lib/tools.js — tool yang boleh dipakai agent, dengan gerbang izin dan hook.
//
// Kenapa di server, bukan di prompt: model hanya boleh menyentuh berkas dan
// perintah yang benar-benar diizinkan oleh mode yang dipilih pengguna. Prompt
// tidak bisa menegakkan itu — model bisa saja mengabaikan instruksi. Jadi
// definisi tool, pemeriksaan path, dan keputusan izin semuanya ada di sini.
//
// Mode izin mengikuti semantik ZCode:
//   plan    → hanya baca; tulis/perintah ditolak
//   build   → tulis & perintah butuh persetujuan pengguna
//   edit    → tulis bebas, perintah butuh persetujuan
//   guarded → tulis bebas, perintah bebas kecuali yang berbahaya
//   yolo    → semua bebas (tetap bisa diblokir hook)
//
// "Butuh persetujuan" berarti run benar-benar berhenti dan bertanya lewat
// `ctx.approvals` (lib/approvals.js). Tanpa klien — delegate, CLI, tes — `ask`
// tetap berarti ditolak dengan alasan, bukan menunggu selamanya; itu yang
// membuat jalur headless tidak pernah menggantung.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as mcp from './mcp.js';
import * as hooks from './hooks.js';
import { agentTypes } from './agent-profiles.js';
import { allowedByRule } from './approvals.js';
import { ASK_TOOL, validateQuestions, normalizeAnswers, normalizeAnnotations, formatAnswerText } from './ask-question.js';
import {
  ENTER_PLAN_TOOL, EXIT_PLAN_TOOL, isPlanTool, planTransitionVerdict, normalizePlan, normalizeAllowedPrompts,
  writePlanFile, planFileRelPath, approvedNotice, rejectedNotice, noClientNotice,
} from './plan.js';

const MAX_WRITE_BYTES = 2000000;
const MAX_LIST = 500;
const MAX_OUTPUT = 60000;
const CMD_TIMEOUT = 120000;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'vendor', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj']);

export class ToolError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ToolError';
    this.statusCode = statusCode;
  }
}

export const PERMISSION_MODES = ['plan', 'build', 'edit', 'yolo', 'guarded'];

// Mode lama di UI AgentHub tetap diterima supaya localStorage pengguna yang
// sudah ada tidak tiba-tiba berubah arti.
export function normalizeMode(value) {
  const v = String(value || '').toLowerCase();
  if (PERMISSION_MODES.includes(v)) return v;
  if (v === 'ask') return 'build';
  if (v === 'edits') return 'edit';
  if (v === 'full') return 'yolo';
  return 'yolo';
}

// ---------- path ----------
// Semua path tool relatif terhadap folder kerja thread. Path absolut yang
// menunjuk ke luar folder kerja ditolak: agent tidak boleh menyentuh berkas
// pribadi pengguna hanya karena ia bisa menulis path.
function resolveInside(cwd, rel) {
  if (!cwd) throw new ToolError('Thread ini belum punya folder kerja', 409);
  const raw = String(rel || '').trim();
  if (!raw) throw new ToolError('Path wajib diisi');
  if (raw.includes('\0')) throw new ToolError('Path mengandung karakter tidak sah');
  const full = path.resolve(cwd, raw);
  const check = path.relative(cwd, full);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new ToolError(`Path di luar folder kerja: ${raw}`, 403);
  }
  if (check.split(path.sep).includes('.git')) {
    throw new ToolError('Folder .git tidak boleh disentuh tool', 403);
  }
  return full;
}

function clampOutput(text) {
  const s = String(text || '');
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (dipotong ${s.length - MAX_OUTPUT} karakter)` : s;
}

// ---------- klasifikasi untuk izin ----------
const DANGEROUS = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
  /\bdel\s+\/[fsq]/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\bdiskpart\b/i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|powershell)/i,
  /\breg\s+(add|delete)\b/i,
  /\bSet-ItemProperty\b[^\n]*HKLM/i,
  /\bnpm\s+publish\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs\b/i,
];

export function isDangerous(command) {
  const text = String(command || '');
  return DANGEROUS.some((re) => re.test(text));
}

function category(name) {
  if (name.startsWith('mcp__')) return 'mcp';
  // `EnterPlanMode`/`ExitPlanMode` mengubah izin, bukan berkas. Ia punya
  // aturannya sendiri (lib/plan.js) karena `ExitPlanMode` butuh persetujuan
  // manusia yang bentuknya berbeda dari izin tool biasa: yang disetujui adalah
  // rencana, bukan satu pemanggilan.
  if (isPlanTool(name)) return 'plan';
  // `Agent` hanya mengatur: ia sendiri tidak menulis berkas, menjalankan
  // perintah, atau menghubungi jaringan. Semua efek samping terjadi di tool
  // milik anak, dan tool itu diperiksa dengan mode anak — bukan mode induk.
  // Karena itu ia boleh dipanggil di plan mode, sama seperti ZCode.
  if (name === 'Agent') return 'agent';
  // Bertanya bukan tindakan: tidak ada berkas atau perintah yang tersentuh.
  // Tetap dipisah dari 'read' karena ia satu-satunya tool yang berhenti
  // menunggu manusia.
  if (name === ASK_TOOL) return 'ask';
  if (['read_file', 'list_files', 'grep_files', 'workspace_info'].includes(name)) return 'read';
  if (['write_file', 'edit_file', 'delete_file'].includes(name)) return 'write';
  if (name === 'run_command') return 'exec';
  return 'unknown';
}

// MCP di mode plan: hanya tool yang jelas-jelas membaca informasi. Ini bukan
// jaminan keamanan — nama tool ditentukan server MCP — tetapi mencegah plan
// mode yang tanpa sengaja memicu aksi tulis.
const MCP_READ_HINT = /^(read|get|list|search|find|query|describe|status|fetch|show|lookup|resolve)/i;

function mcpToolAllowedInPlan(name) {
  const bare = name.replace(/^mcp__[A-Za-z0-9._-]+__/, '');
  return MCP_READ_HINT.test(bare);
}

// Keputusan izin murni (tanpa I/O) supaya bisa diuji langsung.
//
// `allow: false` + `decision: 'ask'` berarti "butuh persetujuan", bukan
// "ditolak". executeTool yang memutuskan apakah ada manusia untuk ditanya;
// `decide` tetap murni supaya aturan mode bisa diperiksa tanpa server.
export function decide(name, args = {}, mode = 'yolo', runtime = {}) {
  const m = normalizeMode(mode);
  const kind = category(name);
  // Transisi mode punya aturannya sendiri: masuk plan selalu boleh, keluar dari
  // plan selalu bertanya. Ditaruh sebelum cabang lain supaya `plan` tidak
  // tertangkap aturan "plan mode tidak mengizinkan perubahan" di bawah — tool
  // ini justru satu-satunya yang boleh dipanggil untuk KELUAR dari plan.
  if (kind === 'plan') {
    return planTransitionVerdict(name, { mode: m, planActive: !!runtime.planActive });
  }
  // `AskUserQuestion` TIDAK PERNAH otomatis diizinkan, termasuk di yolo.
  // Tool ini satu-satunya yang tidak punya efek samping tetapi juga tidak
  // punya jawaban tanpa manusia: menjalankannya berarti menunggu pengguna.
  // Melewatinya di yolo akan membuat run menunggu 10 menit lalu gagal dengan
  // pesan yang salah.
  if (kind === 'ask') {
    return { allow: false, decision: 'ask', reason: 'Pertanyaan untuk pengguna', alwaysAsk: true };
  }
  if (kind === 'read') return { allow: true, decision: 'allow' };
  if (kind === 'agent') return { allow: true, decision: 'allow' };
  if (kind === 'unknown') return { allow: false, decision: 'deny', reason: `Tool "${name}" tidak dikenal` };
  if (kind === 'mcp') {
    if (m === 'plan') {
      return mcpToolAllowedInPlan(name)
        ? { allow: true, decision: 'allow' }
        : { allow: false, decision: 'deny', reason: 'Plan mode hanya mengizinkan tool MCP yang membaca data' };
    }
    return { allow: true, decision: 'allow' };
  }
  if (m === 'plan') {
    return { allow: false, decision: 'deny', reason: 'Plan mode tidak mengizinkan perubahan berkas atau perintah' };
  }
  if (kind === 'write') {
    if (m === 'build') {
      return { allow: false, decision: 'ask', reason: `Mode build memerlukan persetujuan untuk ${name === 'edit_file' ? 'mengubah' : 'menulis'} berkas` };
    }
    return { allow: true, decision: 'allow' };
  }
  // exec
  if (m === 'build' || m === 'edit') {
    return { allow: false, decision: 'ask', reason: `Mode ${m} memerlukan persetujuan untuk menjalankan perintah` };
  }
  if (m === 'guarded' && isDangerous(args.command)) {
    return { allow: false, decision: 'ask', reason: 'Perintah ini berbahaya; mode guarded meminta persetujuan' };
  }
  return { allow: true, decision: 'allow' };
}

// ---------- definisi tool untuk model ----------
const DEFS = [
  {
    name: 'read_file',
    description: 'Baca isi berkas teks di folder kerja. Pakai offset/limit untuk berkas besar.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relatif terhadap folder kerja' },
        offset: { type: 'integer', description: 'Baris awal (1-based)' },
        limit: { type: 'integer', description: 'Jumlah baris maksimum' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Tulis berkas (membuat atau menimpa seluruh isi). Untuk perubahan kecil pakai edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relatif terhadap folder kerja' },
        content: { type: 'string', description: 'Isi berkas lengkap' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Ganti potongan teks di dalam berkas. `old` harus muncul tepat satu kali kecuali replaceAll=true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string', description: 'Teks yang dicari' },
        new: { type: 'string', description: 'Teks pengganti' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  {
    name: 'list_files',
    description: 'Daftar berkas di folder kerja (maksimal 500, folder berat dilewati).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subfolder, default akar folder kerja' },
        pattern: { type: 'string', description: 'Saringan sederhana, mis. .js atau test' },
      },
    },
  },
  {
    name: 'grep_files',
    description: 'Cari teks atau pola regex di berkas folder kerja. Mengembalikan path:baris.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Subfolder, default akar' },
        include: { type: 'string', description: 'Saringan nama berkas, mis. .js' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Jalankan perintah shell di folder kerja. Keluaran digabung stdout+stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', description: 'Batas waktu, maksimal 120000' },
      },
      required: ['command'],
    },
  },
  {
    name: ASK_TOOL,
    description: [
      'Ajukan 1–4 pertanyaan pilihan ganda kepada pengguna, lalu tunggu jawabannya.',
      'Pakai untuk mengumpulkan preferensi, menghilangkan keraguan, atau meminta keputusan yang memang milik pengguna (mis. "Postgres atau SQLite?").',
      'Jangan pakai untuk meminta izin menjalankan tool — izin sudah ditanyakan sendiri oleh sistem. Jangan pakai untuk menanyakan "apakah rencanaku boleh dijalankan".',
      'Setiap pertanyaan punya 2–4 opsi; UI selalu menambahkan pilihan bebas "Lainnya", jadi jangan menyediakannya sendiri.',
      'Letakkan opsi yang kamu rekomendasikan di urutan pertama dan akhiri labelnya dengan " (Recommended)".',
      'Isi `multiSelect: true` bila lebih dari satu pilihan boleh dipilih sekaligus.',
      'Pengguna boleh melewati sebagian atau semua pertanyaan. Kalau itu terjadi, lanjutkan dengan asumsi terbaikmu dan sebutkan asumsinya.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1 sampai 4 pertanyaan.',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'Pertanyaan lengkap dan spesifik, diakhiri tanda tanya.' },
              header: { type: 'string', description: 'Label sangat pendek (maksimal 12 karakter), mis. "Database".' },
              multiSelect: { type: 'boolean', description: 'true bila lebih dari satu opsi boleh dipilih.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Teks pilihan, 1–5 kata.' },
                    description: { type: 'string', description: 'Arti atau konsekuensi pilihan ini.' },
                    preview: { type: 'string', description: 'Opsional: cuplikan markdown/HTML fragmen untuk ditampilkan saat opsi ini disorot.' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: ENTER_PLAN_TOOL,
    description: [
      'Masuk plan mode sebelum mengerjakan tugas yang mengubah banyak berkas atau punya beberapa jalan yang sama masuk akal.',
      'Pakai saat: permintaan menyentuh lebih dari satu berkas, ada dua cara yang konsekuensinya berbeda, atau kamu belum yakin apa yang sebenarnya diinginkan.',
      'Jangan pakai untuk pertanyaan biasa, bacaan saja, atau perubahan satu baris yang sudah jelas.',
      'Setelah masuk, susun rencana dengan membaca berkas yang relevan, lalu panggil ExitPlanMode.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: EXIT_PLAN_TOOL,
    description: [
      'Ajukan rencana yang sudah kamu susun, lalu tunggu pengguna menyetujuinya.',
      'Rencana harus menyebut: apa yang akan diubah (berkas dan bagiannya), urutan langkahnya, dan apa yang TIDAK akan disentuh.',
      'Jangan memanggil ini untuk meminta izin satu perintah — izin sudah ditanyakan sendiri oleh sistem.',
      'Bila pengguna menolak, jangan mengubah berkas: tanyakan bagian mana yang perlu diubah, lalu ajukan rencana baru.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'Rencana lengkap dalam markdown: berkas yang disentuh, langkah berurutan, dan batasannya.',
        },
        allowedPrompts: {
          type: 'array',
          description: 'Opsional: kategori tindakan yang akan dibutuhkan, mis. "run tests". Hanya keterangan untuk pengguna, bukan izin otomatis.',
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Tool yang terlibat, mis. run_command.' },
              prompt: { type: 'string', description: 'Deskripsi singkat tindakannya.' },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['plan'],
    },
  },
];

// Tool yang tidak masuk akal untuk mode tertentu disembunyikan dari model:
// menawarkan tool lalu menolaknya membuat model mencoba berulang kali.
//
// Hanya `plan` yang masih menyembunyikan tool. Dulu `build` juga menyembunyikan
// tulis dan `edit` menyembunyikan perintah, karena `ask` mustahil dijawab dan
// tool itu pasti gagal. Sekarang `ask` benar-benar bertanya, jadi menyembunyikan
// tool berarti agent tidak bisa meminta — pengguna harus menebak sendiri bahwa
// mode itu membatasi sesuatu.
function defsForMode(mode) {
  const m = normalizeMode(mode);
  if (m === 'plan') {
    // Bertanya tetap tersedia di plan: justru saat menyusun rencana pengguna
    // perlu ikut memilih arah sebelum apa pun diubah. `ExitPlanMode` juga:
    // tanpa itu agent bisa masuk plan lalu tidak punya jalan keluar selain
    // menunggu pengguna mengganti chip akses sendiri.
    return DEFS.filter((d) => ['read', 'ask', 'plan'].includes(category(d.name)));
  }
  // Di luar plan, `EnterPlanMode` tetap ditawarkan (agent boleh memutuskan
  // menyusun rencana lebih dulu), tetapi `ExitPlanMode` tidak: ia hanya sah
  // saat plan aktif, dan menawarkannya di mode lain berarti menawarkan satu
  // panggilan yang pasti ditolak.
  return DEFS.filter((d) => d.name !== EXIT_PLAN_TOOL);
}

// Deskripsi `Agent` dirakit dari profil yang benar-benar terpasang: model
// memilih `subagent_type` dari daftar ini, jadi daftar yang salah membuat model
// meminta agent yang tidak ada. Tool ini tidak masuk DEFS statis karena isinya
// bergantung pada folder kerja (profil proyek bisa menambah atau menimpa).
function agentToolDef(cwd) {
  const types = agentTypes({ cwd });
  if (!types.length) return null;
  const catalog = types.map((t) => `- ${t.type}: ${t.whenToUse || t.description}${t.readOnly ? ' (baca-saja)' : ''}`).join('\n');
  return {
    name: 'Agent',
    description: [
      'Jalankan subagent: agent terpisah dengan percakapan sendiri yang menyelesaikan satu tugas lalu melapor.',
      'Pakai bila pekerjaan butuh banyak langkah tool yang hasil antaranya tidak perlu dilihat pengguna, atau saat tugas bisa berjalan sambil kamu mengerjakan hal lain.',
      'Jangan pakai untuk hal yang bisa kamu jawab sendiri dalam satu-dua tool: setiap subagent adalah percakapan model tambahan, jadi ia menambah biaya dan waktu.',
      'Tulis prompt yang lengkap dan mandiri — subagent tidak melihat percakapan ini dan tidak bisa bertanya balik.',
      '',
      'Tipe yang tersedia:',
      catalog,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Deskripsi 3–5 kata untuk ditampilkan di UI' },
        prompt: { type: 'string', description: 'Tugas lengkap untuk subagent; sebutkan path dan batasan yang relevan' },
        subagent_type: { type: 'string', description: `Salah satu: ${types.map((t) => t.type).join(', ')}. Default general-purpose.` },
      },
      required: ['description', 'prompt'],
    },
  };
}

export async function toolDefinitions({
  cwd, mode = 'yolo', includeMcp = true, force = false, allowSubagents = true, toolPolicy = null,
} = {}) {
  // Tool berkas tanpa folder kerja pasti gagal. Menawarkannya hanya membuat
  // model mencoba, gagal, lalu mencoba lagi — jadi tidak ditawarkan sama sekali.
  // `AskUserQuestion` dikecualikan: ia tidak menyentuh folder kerja, dan
  // bertanya justru cara paling masuk akal untuk memutuskan folder mana yang
  // dipakai.
  const base = defsForMode(mode);
  const usable = cwd ? base : base.filter((d) => category(d.name) === 'ask');
  const defs = usable.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));

  // `Agent` hanya untuk induk. Child yang mendapat tool ini akan memanggilnya
  // lagi, dan satu permintaan bisa bercabang tanpa batas.
  if (allowSubagents && cwd) {
    const agentDef = agentToolDef(cwd);
    if (agentDef) {
      defs.push({
        type: 'function',
        function: { name: agentDef.name, description: agentDef.description, parameters: agentDef.parameters },
      });
    }
  }

  // Penyaringan milik subagent: profil mempersempit daftar, dan `Agent` selalu
  // dibuang dari child berapa pun isi profilnya.
  const narrowed = toolPolicy ? narrow(defs, toolPolicy) : defs;

  if (!includeMcp) return narrowed;
  // MCP hanya ditawarkan bila thread punya folder kerja? Tidak — server MCP
  // tidak butuh folder. Yang butuh cwd hanya tool bawaan.
  try {
    const mcpDefs = await mcp.toolDefinitions({ force });
    const filtered = normalizeMode(mode) === 'plan'
      ? mcpDefs.filter((d) => mcpToolAllowedInPlan(d.function?.name || ''))
      : mcpDefs;
    return toolPolicy ? narrow([...narrowed, ...filtered], toolPolicy) : [...narrowed, ...filtered];
  } catch {
    return narrowed;
  }
}

// Daftar nama yang boleh dilihat anak. `tools: null` berarti "semua yang sah",
// yang tetap berarti tanpa `Agent`: profil boleh mempersempit, tidak boleh
// membuka jalan rekursif.
function narrow(defs, policy) {
  const allow = Array.isArray(policy?.tools) ? new Set(policy.tools.map(String)) : null;
  const deny = new Set((policy?.disallowedTools || []).map(String));
  deny.add('Agent');
  return defs.filter((d) => {
    const name = d.function?.name || '';
    if (deny.has(name)) return false;
    if (!allow) return true;
    // MCP tidak disebut di daftar profil, jadi ia hanya ikut bila profil
    // menyebutnya eksplisit. Membiarkannya lolos diam-diam akan membuat
    // "baca-saja" bocor lewat server MCP yang punya tool tulis.
    if (allow.has(name)) return true;
    return false;
  });
}

// ---------- implementasi tool ----------
function readFile(cwd, { path: rel, offset, limit }) {
  const full = resolveInside(cwd, rel);
  let st;
  try { st = fs.statSync(full); } catch { throw new ToolError(`Berkas tidak ditemukan: ${rel}`, 404); }
  if (!st.isFile()) throw new ToolError(`Bukan berkas: ${rel}`);
  if (st.size > 8 * 1024 * 1024) throw new ToolError('Berkas terlalu besar untuk dibaca tool');
  const raw = fs.readFileSync(full, 'utf8');
  const lines = raw.split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.min(4000, Math.max(1, Number(limit) || 2000));
  const slice = lines.slice(start - 1, start - 1 + count);
  const numbered = slice.map((line, i) => `${start + i}: ${line}`).join('\n');
  const note = start + count - 1 < lines.length ? `\n… (${lines.length} baris total; minta offset berikutnya)` : '';
  return clampOutput(numbered + note);
}

function writeFile(cwd, { path: rel, content }) {
  const full = resolveInside(cwd, rel);
  const text = String(content ?? '');
  if (text.length > MAX_WRITE_BYTES) throw new ToolError('Isi berkas melebihi 2 MB');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return `Ditulis: ${rel} (${text.length} karakter)`;
}

function editFile(cwd, { path: rel, old, new: next, replaceAll }) {
  const full = resolveInside(cwd, rel);
  const from = String(old ?? '');
  if (!from) throw new ToolError('Teks `old` tidak boleh kosong');
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); } catch { throw new ToolError(`Berkas tidak ditemukan: ${rel}`, 404); }
  const parts = raw.split(from);
  if (parts.length === 1) throw new ToolError(`Teks tidak ditemukan di ${rel}`, 409);
  if (parts.length > 2 && !replaceAll) {
    throw new ToolError(`Teks muncul ${parts.length - 1} kali di ${rel}; perjelas atau pakai replaceAll=true`, 409);
  }
  const out = replaceAll ? parts.join(String(next ?? '')) : raw.replace(from, () => String(next ?? ''));
  if (out.length > MAX_WRITE_BYTES) throw new ToolError('Hasil edit melebihi 2 MB');
  fs.writeFileSync(full, out, 'utf8');
  return `Diubah: ${rel} (${replaceAll ? parts.length - 1 : 1} penggantian)`;
}

function listFiles(cwd, { path: rel, pattern }) {
  const base = rel ? resolveInside(cwd, rel) : cwd;
  let st;
  try { st = fs.statSync(base); } catch { throw new ToolError(`Folder tidak ditemukan: ${rel || '.'}`, 404); }
  if (!st.isDirectory()) throw new ToolError(`Bukan folder: ${rel}`);
  const needle = String(pattern || '').toLowerCase();
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_LIST || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_LIST) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const r = path.relative(cwd, full).split(path.sep).join('/');
        if (needle && !r.toLowerCase().includes(needle)) continue;
        out.push(r);
      }
    }
  };
  walk(base, 0);
  return out.length ? clampOutput(out.sort().join('\n')) : '(tidak ada berkas yang cocok)';
}

function grepFiles(cwd, { pattern, path: rel, include }) {
  const needle = String(pattern || '');
  if (!needle) throw new ToolError('pattern wajib diisi');
  let re;
  try { re = new RegExp(needle, 'i'); } catch { re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const base = rel ? resolveInside(cwd, rel) : cwd;
  const inc = String(include || '').toLowerCase();
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= 200 || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= 200) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const r = path.relative(cwd, full).split(path.sep).join('/');
      if (inc && !r.toLowerCase().includes(inc)) continue;
      let text;
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        if (re.test(lines[i])) hits.push(`${r}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  };
  walk(base, 0);
  return hits.length ? clampOutput(hits.join('\n')) : '(tidak ada yang cocok)';
}

function runCommand(cwd, { command, timeoutMs }, signal) {
  if (!cwd) throw new ToolError('Thread ini belum punya folder kerja', 409);
  const cmd = String(command || '').trim();
  if (!cmd) throw new ToolError('command wajib diisi');
  if (cmd.length > 8000) throw new ToolError('Perintah terlalu panjang');
  const win = process.platform === 'win32';
  const timeout = Math.min(CMD_TIMEOUT, Math.max(1000, Number(timeoutMs) || CMD_TIMEOUT));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(win ? 'powershell.exe' : '/bin/sh',
        win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd] : ['-c', cmd],
        { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, text: `Gagal menjalankan: ${error.message}`, code: null });
      return;
    }
    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => { try { child.kill(); } catch { /* sudah mati */ } finish({ ok: false, text: 'Perintah dihentikan', code: null }); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* sudah mati */ }
      finish({ ok: false, text: `Perintah melewati batas ${Math.round(timeout / 1000)} detik`, code: null });
    }, timeout);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const push = (d) => { if (out.length < MAX_OUTPUT * 2) out += d.toString('utf8'); };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => finish({ ok: false, text: `Gagal menjalankan: ${error.message}`, code: null }));
    child.on('close', (code) => finish({ ok: code === 0, text: out.trim() || '(tanpa keluaran)', code }));
  });
}

// ---------- AskUserQuestion ----------
// Satu-satunya tool yang hasilnya adalah suara manusia, bukan data. Karena itu
// jalurnya berbeda: validasi dulu (supaya kesalahan bentuk dilaporkan sebagai
// schema error, bukan "ditolak"), lalu tunggu jawaban, lalu kembalikan ringkasan.
async function runAskTool({ toolName, input, client, cwd, onEvent, started, pre }) {
  const checked = validateQuestions(input);
  if (!checked.ok) {
    const text = `Pertanyaan tidak sah: ${checked.error}`;
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    onEvent?.({ type: 'tool_result', name: toolName, ok: false, text, ms: Date.now() - started });
    return { ok: false, text, decision: 'allow', error: 'SCHEMA', hook: post?.results };
  }

  if (!client) {
    const text = 'AskUserQuestion tidak tersedia di jalur ini: tidak ada pengguna yang bisa menjawab (delegate, CLI, atau API langsung). Ambil keputusan sendiri dan sebutkan asumsinya.';
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    onEvent?.({ type: 'tool_result', name: toolName, ok: false, text, ms: Date.now() - started });
    return { ok: false, text, decision: 'deny', error: 'NO_CLIENT', hook: post?.results };
  }

  const answer = await client.askQuestion({ tool: toolName, questions: checked.questions });
  if (answer.decision !== 'answered') {
    const text = `Pertanyaan tidak dijawab: ${answer.reason || 'pengguna menolak menjawab'}. Lanjutkan dengan asumsi terbaikmu dan sebutkan asumsi itu.`;
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    onEvent?.({ type: 'tool_result', name: toolName, ok: false, text, ms: Date.now() - started });
    return { ok: false, text, decision: 'deny', error: answer.timedOut ? 'TIMEOUT' : 'REJECTED', hook: post?.results };
  }

  // Jawaban klien diperiksa lagi di sini: kunci yang tidak dikenal (kartu basi
  // dari tab lain) harus jadi kesalahan yang jelas, bukan jawaban hantu yang
  // masuk ke konteks model.
  const normalized = normalizeAnswers(checked.questions, answer.answers);
  if (!normalized.ok) {
    const text = `Jawaban tidak sah: ${normalized.error}`;
    onEvent?.({ type: 'tool_result', name: toolName, ok: false, text, ms: Date.now() - started });
    return { ok: false, text, decision: 'allow', error: 'SCHEMA' };
  }
  const annotations = normalizeAnnotations(checked.questions, answer.annotations);
  const text = formatAnswerText(checked.questions, normalized.answers, annotations);
  const post = await hooks.runEvent('PostToolUse', {
    tool_name: toolName, tool_input: input, tool_response: text, cwd,
  }, { cwd }).catch(() => null);
  onEvent?.({ type: 'tool_result', name: toolName, ok: true, text, ms: Date.now() - started });
  return {
    ok: true,
    text,
    decision: 'allow',
    answers: normalized.answers,
    annotations,
    hook: [...(pre.results || []), ...(post?.results || [])],
  };
}

// ---------- EnterPlanMode / ExitPlanMode ----------
// Dua tool ini tidak menyentuh berkas: ia mengubah MODE. Karena itu hasilnya
// harus sampai ke loop agent, bukan hanya ke model — tanpa itu gerbang tool
// berikutnya masih memakai mode lama, dan agent yang baru "disetujui" tetap
// ditolak saat menulis berkas.
async function runPlanTool({ toolName, input, verdict, client, cwd, onEvent, started, pre, planRuntime, mode }) {
  const finish = (result, hookUsed = null) => {
    const post = hookUsed;
    onEvent?.({ type: 'tool_result', name: toolName, ok: result.ok, text: result.text, ms: Date.now() - started });
    return { ...result, decision: result.decision || 'allow', hook: [...(pre.results || []), ...(post?.results || [])] };
  };

  if (toolName === ENTER_PLAN_TOOL) {
    // Masuk plan hanya mengurangi kemampuan, jadi tidak ada yang perlu
    // ditanyakan. Mode sebelumnya dicatat supaya keluar nanti tidak jatuh ke
    // bawaan dan diam-diam memperketat run berikutnya.
    const previous = planRuntime ? (planRuntime.pre || (mode === 'plan' ? 'build' : mode)) : mode;
    if (planRuntime) {
      planRuntime.active = true;
      planRuntime.pre = previous === 'plan' ? (planRuntime.pre || 'build') : previous;
      planRuntime.mode = 'plan';
    }
    const text = [
      'Plan mode aktif: kamu boleh membaca dan mencari, tetapi belum boleh mengubah berkas atau menjalankan perintah.',
      'Susun rencana yang konkret — berkas mana, bagian mana, urutan langkahnya — lalu panggil ExitPlanMode untuk meminta persetujuan.',
    ].join('\n');
    const post = await hooks.runEvent('PostToolUse', { tool_name: toolName, tool_input: input, tool_response: text, cwd }, { cwd }).catch(() => null);
    return finish({ ok: true, text, mode: 'plan', previousMode: previous }, post);
  }

  // ExitPlanMode
  if (!verdict?.planApproval) {
    // Ditolak karena tidak sedang di plan (atau hook menolak sebelumnya).
    const text = verdict?.reason || 'ExitPlanMode hanya bisa dipakai saat plan mode aktif';
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    return finish({ ok: false, text, decision: 'deny', code: verdict?.code || 'DENIED' }, post);
  }

  const checked = normalizePlan(input);
  if (!checked.ok) {
    // Rencana kosong bukan "hampir benar": menyetujuinya berarti menyetujui
    // apa pun yang nanti dikerjakan. Model harus memperbaiki bentuknya dulu.
    const text = `Rencana tidak sah: ${checked.error}`;
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    return finish({ ok: false, text, decision: 'allow', error: 'SCHEMA' }, post);
  }
  const allowedPrompts = normalizeAllowedPrompts(input.allowedPrompts);

  if (!client?.askPlan) {
    // Jalur tanpa manusia: tetap di plan mode, dan model diberi tahu harus
    // menyampaikan rencananya sebagai jawaban akhir. Menggantung sampai batas
    // waktu hanya menghasilkan kegagalan yang membingungkan.
    const text = noClientNotice();
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    return finish({ ok: false, text, decision: 'deny', error: 'NO_CLIENT', plan: checked.plan }, post);
  }

  const answer = await client.askPlan({ plan: checked.plan, allowedPrompts, cwd });
  if (answer?.decision !== 'approve') {
    const text = rejectedNotice({ reason: answer?.reason });
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: input, error: text, cwd }, { cwd }).catch(() => null);
    // Mode TIDAK berubah: penolakan berarti tetap di plan. Mengubahnya di sini
    // akan membuat "tolak" sama saja dengan "setuju" untuk gerbang tool.
    return finish({ ok: false, text, decision: 'deny', error: answer?.timedOut ? 'TIMEOUT' : 'REJECTED' }, post);
  }

  // Disetujui: simpan rencananya ke berkas, ubah mode run, lalu beri tahu
  // model. Berkas ditulis SEBELUM mode berubah: kalau penulisan gagal, model
  // masih di plan mode dan tidak bisa mengubah apa pun berdasarkan rencana yang
  // tidak tersimpan.
  const nextMode = planRuntime?.pre && planRuntime.pre !== 'plan' ? planRuntime.pre : 'build';
  let file = null;
  const relPath = planFileRelPath(planRuntime?.threadId || null);
  try {
    file = writePlanFile({ cwd, threadId: planRuntime?.threadId || null, plan: checked.plan, approvedAt: Date.now() });
  } catch (error) {
    const text = `Rencana disetujui tetapi berkas rencana gagal ditulis: ${error.message}. Tetap di plan mode.`;
    return finish({ ok: false, text, decision: 'deny', error: 'PLAN_FILE' });
  }
  if (planRuntime) {
    planRuntime.active = false;
    planRuntime.mode = nextMode;
    planRuntime.approved = true;
    planRuntime.plan = checked.plan;
    planRuntime.planFile = file;
    planRuntime.planFileRel = relPath;
  }
  const text = [approvedNotice({ mode: nextMode }), `Rencana disimpan di ${relPath}.`].join('\n');
  const post = await hooks.runEvent('PostToolUse', { tool_name: toolName, tool_input: input, tool_response: text, cwd }, { cwd }).catch(() => null);
  return finish({ ok: true, text, decision: 'allow', mode: nextMode, plan: checked.plan, planFile: file }, post);
}

// Tingkat risiko hanya untuk ditampilkan: pengguna perlu tahu apakah yang
// diminta adalah menulis satu berkas atau menghapus seluruh isi folder.
function kindOfRisk(tool, input = {}) {
  if (tool === 'run_command') return isDangerous(input.command) ? 'high' : 'medium';
  if (tool === 'write_file' || tool === 'edit_file') return 'medium';
  if (tool === 'delete_file') return 'high';
  return 'low';
}

// ---------- pemanggilan ----------
// Urutan yang tidak boleh ditukar: hook → izin → eksekusi → hook hasil.
// Hook dulu supaya guard punya kesempatan menolak sebelum keputusan izin dibuat,
// dan supaya `updatedInput` sudah berlaku saat izin diperiksa.
export async function executeTool(name, args, {
  cwd = null,
  mode = 'yolo',
  signal = null,
  onEvent = null,
  // Klien persetujuan untuk run ini (lib/approvals.js). Tanpa klien, `ask`
  // berarti ditolak: itulah jalur delegate/CLI/tes, yang tidak punya manusia
  // untuk ditanya dan tidak boleh menunggu.
  client = null,
  // Status plan mode milik RUN ini. `active` menandai agent sudah masuk plan,
  // `pre` menyimpan mode sebelumnya supaya keluar dari plan mengembalikan mode
  // yang dipilih pengguna, bukan bawaan. Objek ini dipakai bersama dengan loop
  // agent: `ExitPlanMode` mengubah `mode` di sini, dan loop membaca `mode`
  // terkini untuk gerbang tool berikutnya.
  planRuntime = null,
} = {}) {
  const toolName = String(name || '');
  const input = args && typeof args === 'object' ? args : {};
  const started = Date.now();
  // Mode efektif milik run, bukan hanya nilai dari pemanggil: setelah
  // ExitPlanMode disetujui, gerbang tool berikutnya harus memakai mode baru
  // dalam run yang sama. Tanpa ini agent yang baru disetujui tetap ditolak
  // saat menulis berkas, dan rencananya mustahil dijalankan.
  const effectiveMode = planRuntime?.mode || mode;

  let pre;
  try {
    pre = await hooks.runEvent('PreToolUse', { tool_name: toolName, tool_input: input, cwd }, { cwd });
  } catch (error) {
    pre = { decision: 'allow', results: [{ error: error.message }] };
  }
  if (pre.denied) {
    return { ok: false, text: `Ditolak hook: ${pre.reason || 'tanpa alasan'}`, decision: 'deny', hook: pre.results };
  }
  const finalInput = pre.updatedInput && typeof pre.updatedInput === 'object' ? pre.updatedInput : input;

  const verdict = decide(toolName, finalInput, effectiveMode, { planActive: !!planRuntime?.active });
  onEvent?.({ type: 'tool_start', name: toolName, input: finalInput, decision: verdict.decision, reason: verdict.reason || null });

  // `AskUserQuestion` bukan izin: jawabannya bukan allow/deny, dan hook
  // `PermissionRequest` tidak punya wewenang menjawab pertanyaan. Karena itu ia
  // ditangani sebelum gerbang izin — bentuk input yang salah jadi kesalahan
  // schema, bukan "ditolak pengguna".
  if (category(toolName) === 'ask') {
    return runAskTool({ toolName, input: finalInput, client, cwd, onEvent, started, pre });
  }

  // Transisi plan mode, juga sebelum gerbang izin biasa: yang disetujui di sini
  // adalah RENCANA (teks panjang dengan kartu sendiri), bukan satu pemanggilan
  // tool. Menyalurkannya lewat `askPermission` akan menampilkan "Butuh izin
  // ExitPlanMode" tanpa isi rencananya — persetujuan yang tidak bisa dinilai.
  if (category(toolName) === 'plan') {
    return runPlanTool({
      toolName, input: finalInput, verdict, client, cwd, onEvent, started, pre, planRuntime, mode,
    });
  }

  // PermissionRequest: dipanggil tepat ketika keputusan izin adalah "ask".
  // Ini kesempatan bagi kebijakan lokal (allowlist perintah, izin tim) untuk
  // menjawab pertanyaan. Hook hanya bisa MEMBUKA yang tadinya butuh izin —
  // tidak bisa membuka yang sudah ditolak mode (plan) dan tidak bisa menambah
  // penolakan baru, karena penolakan sudah terjadi lebih awal lewat PreToolUse.
  let permission = verdict;
  if (verdict.decision === 'ask') {
    let asked = null;
    try {
      asked = await hooks.runEvent('PermissionRequest', {
        tool_name: toolName, tool_input: finalInput, reason: verdict.reason, mode: normalizeMode(effectiveMode), cwd,
      }, { cwd });
    } catch { asked = null; }
    if (asked?.decision === 'allow' && asked.answered) {
      permission = { allow: true, decision: 'allow', reason: `disetujui hook${asked.reason ? `: ${asked.reason}` : ''}` };
    } else if (asked?.denied) {
      permission = { allow: false, decision: 'deny', reason: asked.reason || 'ditolak hook' };
    }
    if (asked?.results?.length) permission = { ...permission, hook: asked.results };
  }

  // Aturan "selalu bolehkan di folder ini" hanya berlaku untuk tool tulis:
  // satu klik "selalu" pada `run_command` sama saja memindahkan mode ke yolo.
  if (permission.decision === 'ask' && !verdict.alwaysAsk && client && cwd) {
    if (allowedByRule(cwd, toolName)) {
      permission = { allow: true, decision: 'allow', reason: 'Disetujui sebelumnya untuk folder ini' };
    }
  }

  // `ask` yang tidak bisa dijawab tetap berarti ditolak — dengan alasan yang
  // menyebut kenapa, supaya model tidak mengulanginya dan pengguna tahu harus
  // memakai mode lain.
  if (permission.decision === 'ask') {
    if (!client) {
      permission = {
        allow: false,
        decision: 'deny',
        reason: `${verdict.reason}. Tidak ada klien persetujuan pada jalur ini (delegate, CLI, atau API langsung); pakai mode yolo bila memang ingin bebas.`,
      };
    } else {
      const answer = await client.askPermission({
        tool: toolName,
        input: finalInput,
        reason: verdict.reason,
        mode: normalizeMode(effectiveMode),
        cwd,
        risk: kindOfRisk(toolName, finalInput),
      });
      permission = answer.decision === 'allow'
        ? { allow: true, decision: 'allow', reason: answer.reason || 'disetujui pengguna' }
        : { allow: false, decision: 'deny', reason: answer.reason || 'ditolak pengguna' };
    }
  }

  if (!permission.allow) {
    const text = `${permission.decision === 'ask' ? 'Butuh persetujuan' : 'Ditolak'}: ${permission.reason}`;
    const post = await hooks.runEvent('PostToolUseFailure', { tool_name: toolName, tool_input: finalInput, error: text, cwd }, { cwd }).catch(() => null);
    onEvent?.({ type: 'tool_result', name: toolName, ok: false, text, decision: permission.decision, ms: Date.now() - started });
    return { ok: false, text, decision: permission.decision, reason: permission.reason, hook: post?.results };
  }

  let result;
  try {
    if (toolName.startsWith('mcp__')) {
      const r = await mcp.callTool(toolName, finalInput);
      result = { ok: !r.isError, text: r.text };
    } else {
      switch (toolName) {
        case 'read_file': result = { ok: true, text: readFile(cwd, finalInput) }; break;
        case 'write_file': result = { ok: true, text: writeFile(cwd, finalInput) }; break;
        case 'edit_file': result = { ok: true, text: editFile(cwd, finalInput) }; break;
        case 'list_files': result = { ok: true, text: listFiles(cwd, finalInput) }; break;
        case 'grep_files': result = { ok: true, text: grepFiles(cwd, finalInput) }; break;
        case 'run_command': result = await runCommand(cwd, finalInput, signal); break;
        // `Agent` dijalankan oleh loop, bukan di sini: ia butuh mode, model, dan
        // anggaran milik run yang sedang berjalan. Pesan ini menjaga jalur lain
        // (pemanggil langsung) tidak diam-diam dianggap "tool tidak dikenal".
        case 'Agent': result = { ok: false, text: 'Tool Agent hanya tersedia di dalam loop agent.' }; break;
        default: result = { ok: false, text: `Tool "${toolName}" tidak dikenal` };
      }
    }
  } catch (error) {
    result = { ok: false, text: `Gagal: ${error.message}` };
  }

  const extra = pre.additionalContext ? `\n\n[konteks tambahan dari hook]\n${pre.additionalContext}` : '';
  const final = { ...result, text: (result.text || '') + extra };
  const post = await hooks.runEvent(result.ok ? 'PostToolUse' : 'PostToolUseFailure', {
    tool_name: toolName,
    tool_input: finalInput,
    tool_response: final.text,
    ...(result.ok ? {} : { error: final.text }),
    cwd,
  }, { cwd }).catch(() => null);
  if (post?.additionalContext) final.text += `\n\n[konteks tambahan dari hook]\n${post.additionalContext}`;
  onEvent?.({ type: 'tool_result', name: toolName, ok: result.ok, text: clampOutput(final.text), ms: Date.now() - started });
  return {
    ...final,
    decision: 'allow',
    hook: [...(pre.results || []), ...(permission.hook || []), ...(post?.results || [])],
  };
}

// Ringkasan tool yang tersedia — dipakai UI untuk menampilkan kemampuan agent
// tanpa harus memanggil model.
export async function toolSummary({ cwd, mode = 'yolo' } = {}) {
  const defs = await toolDefinitions({ cwd, mode });
  const builtin = defs.filter((d) => !d.function.name.startsWith('mcp__')).map((d) => d.function.name);
  const mcpNames = defs.filter((d) => d.function.name.startsWith('mcp__')).map((d) => d.function.name);
  return { mode: normalizeMode(mode), builtin, mcp: mcpNames, total: defs.length };
}
