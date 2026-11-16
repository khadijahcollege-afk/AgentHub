// lib/lang.js — instruksi bahasa balasan untuk agent.
//
// Kenapa di prompt, bukan parameter API: setiap engine punya bentuk berbeda
// (CLI menerima satu string, pool menerima messages), dan tidak semuanya punya
// field "language". Satu instruksi teks bekerja untuk semuanya — pola yang sama
// dipakai fitur skill.
//
// "auto" sengaja tidak mengirim apa pun: agent yang baik sudah mengikuti bahasa
// pesan user, dan menambahkan instruksi hanya menambah token tanpa manfaat.

export const REPLY_LANGS = ['auto', 'id', 'en', 'ja', 'zh', 'es', 'ar'];

const INSTRUCTION = {
  id: 'Answer in Indonesian (Bahasa Indonesia).',
  en: 'Answer in English.',
  ja: 'Answer in Japanese (日本語).',
  zh: 'Answer in Simplified Chinese (简体中文).',
  es: 'Answer in Spanish (Español).',
  ar: 'Answer in Arabic (العربية).',
};

export function normalizeReplyLang(value) {
  return REPLY_LANGS.includes(value) ? value : 'auto';
}

// Kembalikan prompt apa adanya bila tidak ada instruksi yang perlu ditambahkan.
export function withReplyLanguage(prompt, lang) {
  const id = normalizeReplyLang(lang);
  if (id === 'auto') return prompt;
  const line = INSTRUCTION[id];
  if (!line) return prompt;
  return `${prompt}\n\n<reply_language>\n${line} Keep code, commands, file paths, and identifiers unchanged.\n</reply_language>`;
}
