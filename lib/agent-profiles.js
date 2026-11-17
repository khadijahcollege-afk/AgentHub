// lib/agent-profiles.js — daftar subagent yang boleh dipanggil model.
//
// REA ZCode: docs/design/v2/tool/07-subagent.md, bagian "Agent 定义契约".
//
// Kenapa profil, bukan satu subagent saja: dua pekerjaan berbeda butuh batas
// berbeda. "Cari di mana fungsi ini dipakai" tidak butuh tulis berkas dan tidak
// butuh shell — membiarkan keduanya tersedia hanya menambah risiko tanpa
// menambah kemampuan. Profil membuat batas itu bisa diperiksa dari daftar
// tool, bukan dari kalimat di prompt yang bisa dilawan teks dari berkas.
//
// Sumber: built-in (kode), pengguna (DATA_DIR/agents), proyek
// (<cwd>/.agenthub/agents). Yang lebih dekat ke pekerjaan saat ini menang,
// karena aturan proyek memang lebih spesifik daripada preferensi umum.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const MAX_PROFILE_BYTES = 64 * 1024;
const DEFAULT_CHILD_TURNS = 8;
const READ_TOOLS = ['read_file', 'list_files', 'grep_files'];

// Urutan dari paling ketat ke paling longgar, sama seperti ZCode. Dipakai untuk
// mengambil yang lebih ketat antara mode induk dan mode yang diminta profil.
export const MODE_RANK = ['plan', 'build', 'edit', 'guarded', 'yolo'];

// Alias lama tetap diterima di berkas profil: orang menulis "ask"/"full".
const MODE_ALIAS = { ask: 'build', edits: 'edit', full: 'yolo' };

export function canonicalMode(value) {
  const v = String(value || '').trim().toLowerCase();
  const mapped = MODE_ALIAS[v] || v;
  return MODE_RANK.includes(mapped) ? mapped : null;
}

// Mode anak tidak pernah lebih longgar dari induk. Berkas profil proyek berasal
// dari repo orang lain; bila ia bisa menaikkan mode ke yolo, satu panggilan
// `Agent` cukup untuk melewati seluruh gerbang izin induk.
export function stricterMode(parent, wanted) {
  const p = canonicalMode(parent) || 'yolo';
  const w = canonicalMode(wanted);
  if (!w) return p;
  return MODE_RANK.indexOf(w) < MODE_RANK.indexOf(p) ? w : p;
}

const BUILTIN = {
  'general-purpose': {
    type: 'general-purpose',
    description: 'Agent serba bisa untuk tugas mandiri: menelusuri kode, menjalankan pemeriksaan, lalu melapor.',
    whenToUse: 'tugas yang butuh banyak langkah tool dan hasilnya cukup diringkas, atau pekerjaan yang tidak perlu mengotori percakapan utama',
    prompt: [
      'Kamu subagent yang bekerja untuk agent lain, bukan untuk pengguna langsung.',
      'Selesaikan tugas yang diberikan, lalu laporkan hasilnya secara ringkas dan konkret.',
      'Kamu tidak bisa bertanya balik ke pengguna: bila informasi kurang, ambil keputusan paling masuk akal, sebutkan asumsinya, dan lanjut.',
      'Jangan menyalin berkas utuh ke laporan. Sebutkan path, nomor baris, dan kesimpulan.',
      'Akhiri dengan jawaban akhir yang bisa dipakai langsung oleh agent pemanggil.',
    ].join('\n'),
    tools: null,
    disallowedTools: [],
    model: null,
    maxTurns: DEFAULT_CHILD_TURNS,
    injectAgentsMd: true,
    source: 'built-in',
  },
  Explore: {
    type: 'Explore',
    description: 'Penelusur baca-saja: mencari berkas, simbol, dan pemakaian, lalu melapor path:baris.',
    whenToUse: 'pertanyaan "di mana", "apa saja", atau "bagaimana X dipakai" yang jawabannya ada di isi repo',
    prompt: [
      'Kamu subagent penelusur. Tugasmu membaca dan mencari, bukan mengubah.',
      'Kamu tidak punya tool tulis dan tidak bisa menjalankan perintah; jangan mengaku sudah melakukannya.',
      'Jawab dengan daftar temuan: path, nomor baris, dan satu kalimat mengapa baris itu relevan.',
      'Bila tidak ada yang cocok, katakan tidak ada — jangan mengarang path.',
    ].join('\n'),
    // ZCode memberi Explore akses Bash dan menegakkan read-only lewat prompt.
    // Di sini janji "hanya membaca" harus bisa diperiksa dari daftar tool:
    // teks dari dalam repo tidak boleh bisa mengubah subagent baca-saja menjadi
    // subagent yang menjalankan perintah.
    tools: [...READ_TOOLS],
    disallowedTools: [],
    model: null,
    maxTurns: 6,
    injectAgentsMd: false,
    source: 'built-in',
  },
};

// Hanya berkas .md langsung di folder `agents`, tanpa menelusuri subfolder:
// folder berisi catatan lain tidak boleh tiba-tiba menjadi agent.
function agentDirs(cwd) {
  const out = [{ dir: path.join(DATA_DIR, 'agents'), source: 'user' }];
  if (typeof cwd === 'string' && cwd && path.isAbsolute(cwd)) {
    out.push({ dir: path.join(cwd, '.agenthub', 'agents'), source: 'project' });
  }
  return out;
}

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const raw = m ? m[1] : '';
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const hit = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (!hit) continue;
    fields[hit[1].toLowerCase().replace(/-/g, '_')] = hit[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { fields, body: String(text || '').slice(m ? m[0].length : 0).trim() };
}

// `tools: [a, b]`, `tools: a, b`, dan daftar berbaris (`- a`) semuanya
// diterima; ketiganya muncul di contoh YAML yang beredar.
function parseList(value, listed = []) {
  const raw = String(value || '').trim();
  if (listed.length) return listed;
  if (!raw) return null;
  if (raw === '*') return null;
  if (raw.startsWith('[')) {
    return raw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const inline = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return inline.length ? inline : null;
}

function readProfileFile(file, source) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_PROFILE_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  const { fields, body } = parseFrontmatter(text);
  const fallback = path.basename(file).replace(/\.(md|markdown)$/i, '');
  const type = String(fields.name || fallback).trim().slice(0, 60);
  if (!type) return null;

  // Daftar berbaris: `tools:` lalu `  - read_file`. Frontmatter di atas hanya
  // menyimpan nilai satu baris, jadi baris menjorok dibaca terpisah.
  //
  // Hanya bagian frontmatter yang dipindai: penanda penutup `---` bisa terbaca
  // sebagai butir daftar (`- --`) kalau pemindaian berjalan sampai ke isi prompt.
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const scan = frontmatter ? frontmatter[1] : '';
  const listed = (key) => {
    const m = scan.match(new RegExp(`^${key}\\s*:\\s*$`, 'm'));
    if (!m) return [];
    const tail = scan.slice(scan.indexOf(m[0]) + m[0].length);
    const out = [];
    for (const line of tail.split(/\r?\n/)) {
      const item = line.match(/^\s*-\s+(.+)$/);
      if (!item) { if (line.trim()) break; continue; }
      out.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    return out;
  };

  const prompt = body.slice(0, 12000).trim();
  if (!prompt) return null;
  return {
    type,
    description: String(fields.description || '').slice(0, 200),
    whenToUse: String(fields.when_to_use || '').slice(0, 300),
    prompt,
    tools: parseList(fields.tools, listed('tools')),
    disallowedTools: parseList(fields.disallowed_tools, listed('disallowed_tools')) || [],
    model: fields.model && fields.model !== 'inherit' ? fields.model : null,
    // Mode hanya dihormati dari profil pengguna. Profil proyek datang dari repo
    // yang bisa saja bukan milik orang yang menjalankan agent.
    permissionMode: source === 'user' ? canonicalMode(fields.permission_mode) : null,
    maxTurns: Math.min(16, Math.max(2, Number(fields.max_turns) || DEFAULT_CHILD_TURNS)),
    injectAgentsMd: fields.inject_agents_md === undefined
      ? true
      : String(fields.inject_agents_md).toLowerCase() !== 'false',
    source,
    file,
  };
}

export function agentProfiles({ cwd = null } = {}) {
  const found = new Map();
  for (const profile of Object.values(BUILTIN)) found.set(profile.type.toLowerCase(), profile);
  for (const { dir, source } of agentDirs(cwd)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
      const profile = readProfileFile(path.join(dir, entry.name), source);
      if (profile) found.set(profile.type.toLowerCase(), profile);
    }
  }
  return [...found.values()];
}

// Bentuk ringkas untuk schema tool: model butuh nama dan kapan memakainya,
// bukan isi prompt-nya.
export function agentTypes({ cwd = null } = {}) {
  return agentProfiles({ cwd }).map((p) => ({
    type: p.type,
    description: p.description,
    whenToUse: p.whenToUse || p.description,
    source: p.source,
    // Baca-saja dihitung dari daftar tool yang benar-benar dimiliki, bukan dari
    // label: label yang tidak cocok dengan kenyataan lebih buruk daripada tidak
    // ada label.
    readOnly: Array.isArray(p.tools) && p.tools.length > 0 && p.tools.every((t) => READ_TOOLS.includes(t)),
  }));
}

export function resolveAgentProfile(type, { cwd = null } = {}) {
  const want = String(type || '').trim();
  if (!want) return BUILTIN['general-purpose'];
  return agentProfiles({ cwd }).find((p) => p.type.toLowerCase() === want.toLowerCase()) || null;
}
