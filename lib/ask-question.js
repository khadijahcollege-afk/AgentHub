// lib/ask-question.js — kontrak `AskUserQuestion`: validasi pertanyaan dan
// penyusunan jawaban. Murni, tanpa I/O.
//
// REA ZCode: docs/design/v2/tool/06-ask-user-question.md.
//
// Kenapa validasinya ketat dan terpisah dari tool-nya: pertanyaan ini dirender
// menjadi tombol di UI pengguna. Model bisa mengirim `questions` yang bentuknya
// hampir benar — 5 opsi, label ganda, dua pertanyaan sama — dan tanpa
// pemeriksaan di sini UI harus menebak mana yang ditampilkan. Menolak dengan
// pesan yang tepat membuat model memperbaiki sekali, lalu pengguna menerima
// kartu yang pasti bisa diklik.
//
// Yang TIDAK dilakukan di sini: menyimpan apa pun, memanggil model, atau
// menyentuh berkas. Tool ini tidak punya efek samping — ia hanya bertanya.

export const ASK_TOOL = 'AskUserQuestion';

export const LIMITS = {
  maxQuestions: 4,
  maxOptions: 4,
  minOptions: 2,
  maxHeader: 12,
  maxQuestion: 400,
  maxLabel: 60,
  maxLabelWords: 5,
  maxDescription: 300,
  maxPreview: 4000,
  maxAnswer: 2000,
};

// UI selalu menambahkan tombol "Lainnya" sendiri. Kalau model memakai satu slot
// opsi untuk itu, pengguna melihat dua jalan yang sama dan satu pilihan nyata
// hilang dari daftar.
const OTHER_LABEL = /^(other|lainnya|lain|another|custom|isi sendiri)$/i;

function bad(error) { return { ok: false, error }; }

// Sebuah `preview` yang berbentuk dokumen HTML utuh tidak boleh masuk: ia akan
// dirender di dalam halaman ini, dan `<script>` di dalamnya bukan sekadar teks
// yang jelek — ia kode. Preview ditampilkan sebagai teks biasa, jadi bentuk
// yang lolos pun tidak dieksekusi; pemeriksaan ini menjaga kontraknya tetap
// jujur dan menolak masukan yang jelas-jelas bukan fragmen.
function previewProblem(text) {
  const s = String(text);
  if (/<!doctype/i.test(s)) return 'preview tidak boleh memuat <!DOCTYPE>';
  if (/<\s*html[\s>]/i.test(s)) return 'preview tidak boleh memuat <html>';
  if (/<\s*head[\s>]/i.test(s)) return 'preview tidak boleh memuat <head>';
  if (/<\s*body[\s>]/i.test(s)) return 'preview tidak boleh memuat <body>';
  if (/<\s*script[\s>]/i.test(s)) return 'preview tidak boleh memuat <script>';
  if (/<\s*style[\s>]/i.test(s)) return 'preview tidak boleh memuat <style>';
  if (/\son[a-z]+\s*=/i.test(s)) return 'preview tidak boleh memuat atribut event (on*)';
  // Markdown biasa (tanpa tag) selalu sah — termasuk teks seperti "1 < 5" yang
  // mengandung `<` tetapi bukan tag. Komentar HTML saja juga bukan fragmen yang
  // bisa dirender; menampilkannya hanya memperlihatkan teks mentah.
  if (s.includes('<!--')) {
    const withoutComments = s.replace(/<!--[\s\S]*?-->/g, '');
    if (!/<[a-z][\s\S]*>/i.test(withoutComments)) {
      return 'preview hanya berisi komentar HTML, tanpa tag yang bisa dirender';
    }
  }
  return null;
}

export function validateQuestions(input) {
  const raw = input && typeof input === 'object' ? input.questions : null;
  if (!Array.isArray(raw) || !raw.length) {
    return bad('`questions` wajib berisi 1 sampai 4 pertanyaan.');
  }
  if (raw.length > LIMITS.maxQuestions) {
    return bad(`Maksimal ${LIMITS.maxQuestions} pertanyaan sekali panggil, diterima ${raw.length}.`);
  }

  const questions = [];
  const seenQuestions = new Set();
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    const at = `pertanyaan #${i + 1}`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return bad(`${at} harus berupa objek.`);

    const question = String(q.question ?? '').trim();
    if (!question) return bad(`${at} tidak punya teks \`question\`.`);
    if (question.length > LIMITS.maxQuestion) {
      return bad(`${at} terlalu panjang (${question.length} karakter, maksimal ${LIMITS.maxQuestion}).`);
    }
    const key = question.toLowerCase();
    if (seenQuestions.has(key)) {
      return bad(`Pertanyaan "${question.slice(0, 60)}" muncul lebih dari sekali; gabungkan jadi satu pertanyaan.`);
    }
    seenQuestions.add(key);

    const header = String(q.header ?? '').trim();
    if (!header) {
      return bad(`${at} wajib punya \`header\` singkat (maksimal ${LIMITS.maxHeader} karakter), mis. "Database".`);
    }
    if (header.length > LIMITS.maxHeader) {
      return bad(`\`header\` ${at} panjangnya ${header.length} karakter; maksimal ${LIMITS.maxHeader}.`);
    }

    const multiSelect = q.multiSelect === true;
    const rawOpts = Array.isArray(q.options) ? q.options : null;
    if (!rawOpts) return bad(`${at} wajib punya \`options\` berisi 2 sampai 4 pilihan.`);
    if (rawOpts.length < LIMITS.minOptions) {
      return bad(`${at} hanya punya ${rawOpts.length} opsi; minimal ${LIMITS.minOptions}.`);
    }
    if (rawOpts.length > LIMITS.maxOptions) {
      return bad(`${at} punya ${rawOpts.length} opsi; maksimal ${LIMITS.maxOptions}.`);
    }

    const options = [];
    const seenLabels = new Set();
    for (let j = 0; j < rawOpts.length; j++) {
      const o = rawOpts[j];
      const oat = `opsi #${j + 1} ${at}`;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return bad(`${oat} harus berupa objek.`);
      const label = String(o.label ?? '').replace(/\s+/g, ' ').trim();
      if (!label) return bad(`${oat} tidak punya \`label\`.`);
      if (label.length > LIMITS.maxLabel) {
        return bad(`\`label\` ${oat} ${label.length} karakter; maksimal ${LIMITS.maxLabel}.`);
      }
      if (label.split(' ').length > LIMITS.maxLabelWords) {
        return bad(`\`label\` ${oat} lebih dari ${LIMITS.maxLabelWords} kata; ringkas jadi frasa pendek.`);
      }
      if (OTHER_LABEL.test(label)) {
        return bad(`${oat} memakai label "${label}". Jangan sediakan opsi itu: UI sudah menambahkan "Lainnya" untuk jawaban bebas.`);
      }
      const lkey = label.toLowerCase();
      if (seenLabels.has(lkey)) return bad(`\`label\` "${label}" muncul lebih dari sekali di ${at}.`);
      seenLabels.add(lkey);

      const description = String(o.description ?? '').replace(/\s+/g, ' ').trim();
      if (!description) return bad(`${oat} tidak punya \`description\`; jelaskan arti atau konsekuensi pilihan itu.`);
      if (description.length > LIMITS.maxDescription) {
        return bad(`\`description\` ${oat} ${description.length} karakter; maksimal ${LIMITS.maxDescription}.`);
      }

      const entry = { label, description };
      if (o.preview !== undefined && o.preview !== null && o.preview !== '') {
        if (multiSelect) return bad(`${oat} memakai \`preview\` pada pertanyaan multi-pilih; preview hanya untuk pilihan tunggal.`);
        const preview = String(o.preview);
        if (preview.length > LIMITS.maxPreview) {
          return bad(`\`preview\` ${oat} ${preview.length} karakter; maksimal ${LIMITS.maxPreview}.`);
        }
        const problem = previewProblem(preview);
        if (problem) return bad(`${oat}: ${problem}`);
        entry.preview = preview;
      }
      options.push(entry);
    }

    questions.push({ question, header, multiSelect, options });
  }
  return { ok: true, questions };
}

// Jawaban dari UI tidak pernah dipercaya begitu saja: kunci harus salah satu
// pertanyaan yang benar-benar ditanyakan, dan nilainya harus salah satu opsi
// (atau teks bebas dari "Lainnya"). Ini bukan pertahanan terhadap model —
// model tidak menulis jawaban — melainkan terhadap klien yang basi: kartu yang
// tertinggal di tab lain bisa mengirim jawaban untuk pertanyaan yang sudah
// tidak ada, dan tanpa pemeriksaan ini model menerima jawaban hantu.
export function normalizeAnswers(questions, answers) {
  if (answers === undefined || answers === null) return { ok: true, answers: {} };
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    return bad('`answers` harus berupa objek berisi pasangan pertanyaan → jawaban.');
  }
  const byText = new Map(questions.map((q) => [q.question.toLowerCase(), q]));
  const out = {};
  for (const [key, value] of Object.entries(answers)) {
    const q = byText.get(String(key).trim().toLowerCase());
    if (!q) return bad(`Jawaban diberikan untuk pertanyaan yang tidak ditanyakan: "${String(key).slice(0, 80)}".`);
    const text = String(value ?? '').trim();
    // Pertanyaan yang dilewati tidak ditulis sama sekali: nilai kosong akan
    // terbaca model sebagai "pengguna memilih jawaban kosong", bukan "tidak
    // dijawab".
    if (!text) continue;
    if (text.length > LIMITS.maxAnswer) {
      return bad(`Jawaban untuk "${q.question.slice(0, 40)}" terlalu panjang (maksimal ${LIMITS.maxAnswer} karakter).`);
    }
    if (!q.multiSelect) {
      const known = q.options.some((o) => o.label.toLowerCase() === text.toLowerCase());
      if (!known && text.length > LIMITS.maxLabel) {
        return bad(`Jawaban untuk "${q.question.slice(0, 40)}" bukan salah satu opsi dan terlalu panjang untuk jawaban bebas.`);
      }
    }
    out[q.question] = text;
  }
  return { ok: true, answers: out };
}

export function normalizeAnnotations(questions, annotations) {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return {};
  const byText = new Map(questions.map((q) => [q.question.toLowerCase(), q]));
  const out = {};
  for (const [key, value] of Object.entries(annotations)) {
    const q = byText.get(String(key).trim().toLowerCase());
    if (!q || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = {};
    const notes = String(value.notes ?? '').trim();
    if (notes) entry.notes = notes.slice(0, LIMITS.maxAnswer);
    const preview = String(value.preview ?? '').trim();
    if (preview) entry.preview = preview.slice(0, LIMITS.maxPreview);
    if (Object.keys(entry).length) out[q.question] = entry;
  }
  return out;
}

// Bentuk yang dilihat model. Setiap jawaban ditulis `"pertanyaan"="jawaban"`
// supaya pasangan mana milik pertanyaan mana tidak bisa tertukar saat model
// membaca beberapa pertanyaan sekaligus.
export function formatAnswerText(questions, answers, annotations = {}) {
  const answered = questions.filter((q) => Object.prototype.hasOwnProperty.call(answers, q.question));
  if (!answered.length) {
    return [
      'Pengguna mengirim jawaban kosong: tidak ada pertanyaan yang dijawab.',
      'Lanjutkan dengan asumsi terbaikmu berdasarkan konteks yang sudah ada, dan sebutkan asumsi itu di jawabanmu.',
    ].join('\n');
  }
  const lines = ['Pengguna sudah menjawab pertanyaan berikut. Lanjutkan berdasarkan jawaban ini.', ''];
  for (const q of answered) {
    lines.push(`${q.header}: "${q.question}"="${answers[q.question]}"`);
    const ann = annotations[q.question];
    if (ann?.preview) lines.push(`  preview dipilih: ${ann.preview.split('\n')[0].slice(0, 200)}`);
    if (ann?.notes) lines.push(`  catatan pengguna: ${ann.notes}`);
  }
  const skipped = questions.length - answered.length;
  if (skipped > 0) {
    lines.push('', `${skipped} pertanyaan dilewati tanpa jawaban; jangan mengarang jawabannya.`);
  }
  return lines.join('\n');
}
