// lib/instructions.js — instruksi tetap yang masuk ke setiap prompt.
//
// Kenapa modul sendiri: ada tiga sumber instruksi yang dulu tersimpan tetapi
// tidak pernah dipakai, dan masing-masing punya cakupan berbeda:
//   • AGENTS.md level user  → berlaku untuk semua thread di komputer ini
//   • aturan proyek         → AGENTS.md/CLAUDE.md di folder kerja
//   • systemPrompt thread   → instruksi khusus satu percakapan
//
// Urutannya sengaja user → proyek → thread, sama seperti ZCode: yang lebih
// spesifik datang belakangan, sehingga bila keduanya bertentangan instruksi
// thread yang menang (model cenderung mengikuti yang terakhir dibaca).
//
// Batas ukuran penting: tanpa batas, satu repo bisa menyuntikkan ratusan KB ke
// setiap pesan dan menghabiskan kuota tanpa terlihat. Isi yang dipotong diberi
// keterangan eksplisit supaya model tahu ada bagian yang tidak dilihatnya.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { RULE_FILES } from './machines.js';

const MAX_USER_BYTES = 16 * 1024;
const MAX_PROJECT_BYTES = 48 * 1024;
const MAX_THREAD_BYTES = 4000;

// Satu-satunya nama berkas instruksi level user. Sengaja hanya satu: membaca
// semua file aturan dari direktori data akan mencampur catatan lain milik
// aplikasi (config, memori) ke dalam prompt tanpa disadari.
export const USER_INSTRUCTION_FILE = 'AGENTS.md';

function readCapped(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > maxBytes) {
      return { text: `${raw.slice(0, maxBytes)}\n… (dipotong; berkas ${raw.length} karakter)`, truncated: true, bytes: st.size };
    }
    return { text: raw, truncated: false, bytes: st.size };
  } catch {
    return null;
  }
}

export function userInstructionsPath() {
  return path.join(DATA_DIR, USER_INSTRUCTION_FILE);
}

// Aturan proyek: dibaca dari RULE_FILES, tapi hanya yang benar-benar ada.
// Berkas kosong (hanya whitespace) dilewati — blok judul tanpa isi hanya
// menambah token dan membuat model mengira ada aturan yang tidak terbaca.
export function projectInstructions(dir) {
  if (!dir) return null;
  const parts = [];
  let truncated = false;
  for (const name of RULE_FILES) {
    const found = readCapped(path.join(dir, name), MAX_PROJECT_BYTES);
    if (!found || !found.text.trim()) continue;
    truncated = truncated || found.truncated;
    parts.push({ file: name, text: found.text });
  }
  if (!parts.length) return null;
  return { files: parts.map((p) => p.file), truncated, text: parts.map((p) => p.text).join('\n\n') };
}

export function buildInstructions({ cwd = null, systemPrompt = null } = {}) {
  const blocks = [];

  const user = readCapped(userInstructionsPath(), MAX_USER_BYTES);
  if (user && user.text.trim()) {
    blocks.push({
      source: 'user',
      label: `Instruksi pengguna (${USER_INSTRUCTION_FILE})`,
      text: user.text.trim(),
      truncated: user.truncated,
    });
  }

  const project = projectInstructions(cwd);
  if (project) {
    blocks.push({
      source: 'project',
      label: `Aturan proyek (${project.files.join(', ')})`,
      text: project.text.trim(),
      truncated: project.truncated,
    });
  }

  const thread = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  if (thread) {
    blocks.push({
      source: 'thread',
      label: 'Instruksi thread',
      text: thread.slice(0, MAX_THREAD_BYTES),
      truncated: thread.length > MAX_THREAD_BYTES,
    });
  }

  if (!blocks.length) return { text: '', sources: [] };

  // Dibungkus penanda jelas: tanpa itu, model memperlakukan aturan proyek sebagai
  // bagian dari pertanyaan pengguna dan bisa mengira pengguna yang menuliskannya.
  const text = [
    'Instruksi berikut berlaku untuk percakapan ini. Patuhi selama tidak bertentangan dengan permintaan eksplisit pengguna.',
    ...blocks.map((b) => `### ${b.label}\n${b.text}`),
  ].join('\n\n');

  return { text, sources: blocks.map((b) => ({ source: b.source, label: b.label, truncated: b.truncated })) };
}

// Ringkasan untuk UI: apa yang akan dikirim, tanpa membocorkan isinya.
export function instructionsSummary({ cwd = null, systemPrompt = null } = {}) {
  const { sources } = buildInstructions({ cwd, systemPrompt });
  return {
    sources,
    userFile: userInstructionsPath(),
    userPresent: fs.existsSync(userInstructionsPath()),
    projectPresent: sources.some((s) => s.source === 'project'),
    threadPresent: sources.some((s) => s.source === 'thread'),
    bytes: buildInstructions({ cwd, systemPrompt }).text.length,
  };
}

export function writeUserInstructions(content) {
  const body = typeof content === 'string' ? content : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_USER_BYTES) {
    const e = new Error(`Instruksi pengguna maksimal ${MAX_USER_BYTES} byte`);
    e.statusCode = 400;
    throw e;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(userInstructionsPath(), body, 'utf8');
  return { file: USER_INSTRUCTION_FILE, bytes: Buffer.byteLength(body, 'utf8') };
}

export function readUserInstructions() {
  const found = readCapped(userInstructionsPath(), MAX_USER_BYTES);
  return { file: USER_INSTRUCTION_FILE, text: found ? found.text : '', present: !!found };
}
