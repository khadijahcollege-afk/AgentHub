import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { record as recordUsage } from './stats.js';

export function discoverSkills(cwd, home = os.homedir()) {
  const roots = [['OpenCode', '.config/opencode/skills'], ['OpenCode', '.config/opencode/skill'], ['Claude', '.claude/skills'], ['Codex', '.codex/skills'], ['Agents', '.agents/skills']].map(([source, dir]) => [source, path.join(home, dir)]);
  if (cwd && path.isAbsolute(cwd)) for (const dir of ['.agents/skills', '.claude/skills', '.opencode/skills']) roots.push(['Proyek', path.join(cwd, dir)]);

  // Pembaca frontmatter sederhana: menangani bentuk satu baris
  // (`description: "..."`) DAN blok YAML (`description: >` atau `|` diikuti
  // baris menjorok). Tanpa dukungan blok, deskripsi skill yang ditulis
  // multi-baris terbaca sebagai ">" saja sehingga skill itu tidak pernah bisa
  // dicocokkan dengan permintaan apa pun.
  function parseSkill(text, fallbackName, file, source, id) {
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const field = (key) => {
      const raw = front?.[1] || '';
      const m = raw.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
      if (!m) return '';
      const first = m[1].trim();
      const after = raw.slice(raw.indexOf(m[0]) + m[0].length);
      if (/^[>|][+-]?$/.test(first)) {
        const lines = [];
        for (const line of after.split(/\r?\n/)) {
          if (!line.trim()) { lines.push(''); continue; }
          if (!/^\s/.test(line)) break;
          lines.push(line.trim());
        }
        // `|` mempertahankan baris baru; `>` melipatnya jadi spasi.
        return lines.join(first.startsWith('|') ? '\n' : ' ').replace(/[ \t]+/g, ' ').trim();
      }
      // Nilai satu baris, mungkin berlanjut ke baris menjorok berikutnya.
      let value = first;
      for (const line of after.split(/\r?\n/)) {
        if (!line.trim() || !/^\s/.test(line)) break;
        value += ' ' + line.trim();
      }
      return value.replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim();
    };
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').slice(0, 2500);
    return {
      id,
      name: field('name') || fallbackName,
      description: field('description'),
      // `when_to_use` dan isi SKILL.md memuat kata yang benar-benar dipakai
      // user ("stutter", "crash", "exploit", "game"). Tanpa keduanya,
      // pencocokan hanya melihat satu kalimat deskripsi sehingga permintaan
      // nyata tidak pernah cocok.
      whenToUse: field('when_to_use') || field('when-to-use') || '',
      body,
      source,
      path: file,
    };
  }

  const found = new Map();
  // Satu direktori bisa berisi satu SKILL.md (tata letak biasa) atau
  // sub-folder berisi banyak skill (tata letak katalog/hub). Keduanya dibaca
  // supaya skill yang dibundel di dalam hub tidak dianggap tidak terpasang.
  function scanDir(source, dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const own = entries.find((e) => e.name === 'SKILL.md' && e.isFile());
    if (own) {
      const file = path.join(dir, 'SKILL.md');
      const id = path.basename(dir).toLowerCase();
      try {
        if (fs.statSync(file).size > 200000) return;
        if (!found.has(id) || source === 'Proyek') {
          found.set(id, parseSkill(fs.readFileSync(file, 'utf8'), path.basename(dir), file, source, id));
        }
      } catch { /* tidak terbaca */ }
      // Sebagian skill adalah hub yang membundel skill lain di dalam `skills/`.
      // Skill bundel itu nyata dan bisa dipakai, jadi tetap didaftarkan.
      const nested = entries.find((e) => e.name === 'skills' && e.isDirectory());
      if (nested) {
        let subs = [];
        try { subs = fs.readdirSync(path.join(dir, nested.name), { withFileTypes: true }); } catch { subs = []; }
        for (const sub of subs.slice(0, 300)) {
          if (sub.isDirectory() && !sub.name.startsWith('.')) scanDir(source, path.join(dir, nested.name, sub.name), 0);
        }
      }
      return;
    }
    if (depth <= 0) return;
    for (const entry of entries.slice(0, 300)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      scanDir(source, path.join(dir, entry.name), depth - 1);
    }
  }

  for (const [source, root] of roots) scanDir(source, root, 1);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Pilih skill yang relevan dengan permintaan — TANPA user memilih manual.
//
// Versi lama hanya cocok bila id skill muncul harfiah di prompt ("roblox-gui"
// atau "/skill roblox-gui"), jadi skill tidak pernah aktif untuk permintaan
// biasa seperti "buatkan menu shop di Roblox". Sekarang pencocokan memakai
// nama + deskripsi + bagian id, dengan skor: makin banyak kata kunci yang
// cocok, makin tinggi. Skill yang id-nya disebut eksplisit selalu menang.
const STOP = new Set(['the', 'and', 'for', 'with', 'yang', 'dan', 'untuk', 'dari', 'pada', 'atau', 'ini', 'itu', 'adalah', 'use', 'when', 'skill', 'dengan', 'agar', 'bisa', 'juga', 'akan', 'tidak', 'bila', 'jika', 'dalam', 'ke', 'di', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'it', 'as', 'by', 'or', 'be']);

// Kata dasar: buang awalan/akhiran yang umum dipakai user Indonesia, supaya
// "diexploit", "mengexploit", "exploitasi" sama-sama bertemu "exploit", dan
// "lagging"/"lag" bertemu "lag". Tanpa ini, permintaan berbahasa Indonesia
// hampir tidak pernah cocok dengan deskripsi skill berbahasa Inggris.
const ID_PREFIX = ['memper', 'menge', 'meny', 'meng', 'mem', 'men', 'ber', 'ter', 'pen', 'pem', 'per', 'di', 'ke', 'se'];
const ID_SUFFIX = ['kannya', 'annya', 'nya', 'kan', 'an', 'i'];
function stem(word) {
  let w = word;
  for (const p of ID_PREFIX) {
    // Awalan 2 huruf ("di", "ke", "se") hanya dilepas pada kata yang cukup
    // panjang; tanpa syarat ini "keyword" jadi "yword" dan "kecil" jadi "cil".
    const minLen = p.length <= 2 ? 7 : 5;
    if (w.length >= minLen && w.startsWith(p) && w.length - p.length >= 4) { w = w.slice(p.length); break; }
  }
  for (const s of ID_SUFFIX) {
    if (w.length - s.length >= 4 && w.endsWith(s)) { w = w.slice(0, -s.length); break; }
  }
  return w;
}

// Istilah Indonesia sehari-hari yang sering dipakai untuk hal teknis berbahasa
// Inggris. Tanpa peta ini, "game saya patah-patah" atau "hp kentang" tidak
// pernah cocok dengan deskripsi skill ("stutter", "slow phones").
const SYNONYM = {
  kentang: 'phones slow', hp: 'phones mobile', ponsel: 'phones mobile',
  patah: 'stutter', patahpatah: 'stutter', ngelag: 'lag', ngeleg: 'lag', lemot: 'slow',
  berat: 'performance', lambat: 'performance',
  tampilan: 'gui ui', layar: 'gui ui', antarmuka: 'gui ui', menu: 'gui ui', ui: 'gui ui',
  kepotong: 'cut off', potong: 'cut off',
  meluber: 'overlaps', tumpang: 'overlaps', miring: 'misplaced',
  tombol: 'input button', sentuh: 'touch input', kontrol: 'input controls',
  suara: 'audio sound', bunyi: 'audio sound', musik: 'audio music', audio: 'audio sound',
  cahaya: 'lighting', pencahayaan: 'lighting', bayangan: 'shadow lighting', gelap: 'lighting',
  animasi: 'animation', gerakan: 'animation motion', kaku: 'animation blend',
  efek: 'vfx effects',
  kamera: 'camera', ketiga: 'third person', tembus: 'clip through', dinding: 'wall',
  jaringan: 'networking network',
  aman: 'security exploit', celah: 'exploit vulnerability', curang: 'exploit cheater',
  hacker: 'exploit', hack: 'exploit', bobol: 'exploit',
  struktur: 'structure layout', rapi: 'clean layout',
  dipisah: 'split refactor', pecah: 'split refactor',
  publikasi: 'publish release',
  perpendek: 'compress shorter', pendek: 'shorter', ringkas: 'compress shorter',
  hemat: 'reduce tokens',
  tugas: 'task', papan: 'board', catatan: 'notes', jadwal: 'schedule',
  simpan: 'datastore save', muat: 'load', peta: 'map building', bangun: 'building',
  performa: 'performance', memori: 'memory', kuota: 'rate limit',
  // Dompet & on-chain: kata Indonesia yang tidak akan pernah muncul di
  // deskripsi skill berbahasa Inggris.
  dompet: 'wallet', transaksi: 'transaction swap', koin: 'token swap', tukar: 'swap',
  saldo: 'balance', setor: 'deposit', tarik: 'withdraw', bayar: 'payment',
  unduh: 'download', pasang: 'install',
  analitik: 'analytics', statistik: 'analytics', retensi: 'retention', pemain: 'player',
};

// Kata pendek yang tetap bermakna di domain ini (biasanya singkatan). Tanpa
// daftar ini, "UI kepotong" tidak pernah cocok karena "ui" hanya dua huruf.
const SHORT_OK = new Set(['ui', 'hp', 'pc', 'tv', 'ai', 'db', 'os', 'id', 'vr', 'ar']);

function keywords(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    const st0 = stem(raw);
    const syn = SYNONYM[raw] || SYNONYM[st0];
    // Singkatan & istilah yang punya padanan tetap diizinkan walau pendek.
    if (STOP.has(raw)) continue;
    if (raw.length <= 2 && !syn && !SHORT_OK.has(raw)) continue;
    out.add(raw);
    if (st0.length > 2) out.add(st0);
    if (syn) for (const s of syn.split(' ')) out.add(s);
  }
  return out;
}

// Varian kata yang HANYA muncul lewat penerjemahan — kata yang benar-benar
// diketik user tidak pernah masuk sini. Bobotnya dikurangi: "simpan" memang
// menandakan datastore, tapi tidak sekuat user yang menulis "datastore" sendiri.
// Tanpa pembedaan ini, terjemahan kata umum ("pemain", "simpan") bisa
// mengalahkan kata teknis yang tepat sasaran.
function translatedWords(text) {
  const literal = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    literal.add(raw);
    const st = stem(raw);
    if (st.length > 2) literal.add(st);
  }
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const st = stem(raw);
    const syn = SYNONYM[raw] || SYNONYM[st];
    if (!syn) continue;
    for (const s of syn.split(' ')) if (!literal.has(s)) out.add(s);
  }
  return out;
}

// Dua kata dianggap sama bila bentuknya hanya berbeda pada akhiran umum
// (menu/menus, shop/shops, animate/animation, exploit/exploits/exploitation).
// Daftar akhiran eksplisit dipakai — bukan sekadar "awalan sama" — karena cara
// itu juga menyamakan "game" dengan "gamepad" dan "lag" dengan "lagging-anim",
// yang menghasilkan skill tidak relevan ikut aktif.
const EN_SUFFIX = ['ations', 'ation', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 's', 'ly', 'ment', 'ments', 'ion', 'ions', 'al', 'ive', 'ity', 'ness'];
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || !long.startsWith(short)) return false;
  const tail = long.slice(short.length);
  if (!EN_SUFFIX.includes(tail)) return false;
  // "game"+"s" sah; "game"+"pad" tidak (tail "pad" bukan akhiran).
  return true;
}

function hit(word, set) {
  if (set.has(word)) return true;
  for (const w of set) if (sameWord(word, w)) return true;
  return false;
}

export function skillsForPrompt(prompt, skills) {
  return pickSkills(rankSkills(prompt, skills)).map((s) => s.skill);
}

// Skor mentah per skill — dipisah dari pemilihan akhir supaya ambang batas bisa
// diuji dan disetel tanpa menebak-nebak, dan supaya UI bisa menampilkan alasan.
export function rankSkills(prompt, skills) {
  const raw = String(prompt || '').toLowerCase();
  const words = keywords(raw);
  const translated = translatedWords(raw);
  const list = Array.isArray(skills) ? skills : [];

  // Setiap skill jadi satu "dokumen": kata dari id + nama + deskripsi. Bobot
  // kata dihitung dari seberapa khas kata itu (IDF). "roblox" muncul di hampir
  // semua skill Roblox → hampir tidak membedakan, sedangkan "menu", "lag",
  // "networking" sangat khas. Tanpa IDF, satu kata "roblox" menyalakan semua
  // skill sekaligus dan prompt jadi bengkak tanpa manfaat.
  const docs = list.map((s) => ({
    id: keywords(String(s.id || '').replace(/[-_]/g, ' ')),
    name: keywords(s.name),
    when: keywords(s.whenToUse),
    desc: keywords(s.description),
    body: keywords(s.body),
  }));
  const df = new Map();
  for (const d of docs) for (const w of new Set([...d.id, ...d.name, ...d.when, ...d.desc, ...d.body])) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + list.length / (df.get(w) || list.length));

  // Skill "katalog" meringkas skill lain: deskripsinya memuat banyak id skill
  // yang terpasang. Karena itu ia hampir selalu ikut cocok — bukan karena
  // relevan, tapi karena memuat semua kata kunci. Beri penalti supaya skill
  // spesifik yang benar-benar cocok tidak kalah oleh ringkasannya.
  const catalogPenalty = list.map((s) => {
    const text = `${s.description} ${s.whenToUse} ${s.body}`.toLowerCase();
    let refs = 0;
    for (const other of list) {
      if (other.id === s.id) continue;
      if (text.includes(other.id)) refs++;
    }
    return refs >= 5 ? 0.45 : 1;
  });

  // Cari kata di set mana pun, kembalikan kata aslinya (bisa beda bentuk).
  const find = (word, set) => {
    if (set.has(word)) return word;
    for (const w of set) if (sameWord(word, w)) return w;
    return null;
  };

  // id paling menentukan, lalu nama, lalu `when_to_use`, lalu deskripsi, lalu
  // isi SKILL.md. Urutan ini membuat kata khas di judul lebih kuat daripada
  // kata umum di badan teks.
  const FIELDS = [['id', 3.2], ['name', 2.4], ['when', 1.6], ['desc', 1], ['body', 0.5]];

  const scored = [];
  list.forEach((skill, i) => {
    // Panggilan eksplisit selalu dipakai, apa pun isi deskripsinya.
    if (raw.includes('$' + skill.id) || raw.includes('/skill ' + skill.id) || raw.includes(skill.id)) {
      scored.push({ skill, score: 1000 });
      return;
    }
    const d = docs[i];
    let score = 0;
    const matched = new Set();
    let bestSingle = 0;
    for (const w of words) {
      // Kata terjemahan tetap dihitung, tapi dengan bobot lebih rendah.
      const viaTranslation = translated.has(w);
      for (const [field, mult] of FIELDS) {
        const hitWord = find(w, d[field]);
        if (!hitWord) continue;
        const gain = mult * idf(hitWord) * (viaTranslation ? 0.55 : 1);
        score += gain;
        if (gain > bestSingle) bestSingle = gain;
        matched.add(hitWord);
        break;
      }
    }
    // Dua kata berbeda harus cocok — kecuali satu kata itu benar-benar khas
    // (mis. "metamask" hanya muncul di satu skill). Tanpa pengecualian ini,
    // permintaan pendek yang tepat sasaran justru tidak menyalakan apa pun.
    score *= catalogPenalty[i];
    const enough = matched.size >= 2 || (matched.size === 1 && bestSingle >= 2.2);
    if (enough && score >= 1.2) scored.push({ skill, score, hits: matched.size });
  });
  return scored.sort((a, b) => b.score - a.score);
}

// Pilih maksimal tiga skill dari daftar berperingkat.
// - Panggilan eksplisit (`$id`, `/skill id`, atau id apa adanya) selalu menang.
// - Kecocokan yang jauh lebih lemah dari yang teratas dibuang: itulah sisa
//   kebetulan satu-dua kata, dan menyertakannya membuat prompt bengkak serta
//   mengaburkan skill yang benar-benar relevan.
function pickSkills(scored) {
  const explicit = scored.filter((s) => s.score === 1000);
  const inferred = scored.filter((s) => s.score !== 1000);
  const best = inferred[0]?.score || 0;
  const keep = inferred.filter((s) => s.score >= best * 0.75);
  return [...explicit, ...keep].slice(0, 3);
}

// Nama skill yang akan aktif untuk prompt ini — dipakai UI untuk menampilkan
// "skill aktif otomatis" sebelum pesan dikirim, bukan daftar yang harus dipilih.
export function activeSkillIds(prompt, cwd) {
  return skillsForPrompt(prompt, discoverSkills(cwd)).map((s) => s.id);
}

export function augmentWithSkills(prompt, cwd) {
  const skills = discoverSkills(cwd);
  if (!skills.length) return prompt;
  const catalog = skills.map(s => `- ${s.id}: ${s.description.slice(0, 220)} (file: ${s.path})`).join('\n');
  const picked = skillsForPrompt(prompt, skills);
  const instructions = picked.map(s => {
    try { return `<installed_skill name=${JSON.stringify(s.id)} path=${JSON.stringify(s.path)}>\n${fs.readFileSync(s.path, 'utf8').slice(0, 20000)}\n</installed_skill>`; } catch { return ''; }
  }).join('\n');
  // Skill yang terdeteksi relevan disebut eksplisit supaya agent tahu ia sudah
  // aktif dan tidak perlu diminta memilih: "aktif otomatis" bukan sekadar label
  // di UI, melainkan isi prompt yang benar-benar dikirim.
  const activeNote = picked.length
    ? `\nAuto-activated skills for THIS request (already relevant — apply them): ${picked.map(s => s.id).join(', ')}.`
    : '';
  // Statistik fitur: yang dicatat adalah skill yang BENAR-BENAR aktif untuk
  // permintaan ini, bukan sekadar panel Skills dibuka. Jadi angka "Skills"
  // berarti "berapa kali skill otomatis dipakai", bukan "berapa kali dilihat".
  if (picked.length) recordUsage('skills');
  return `${prompt}\n\n<available_local_skills>${activeNote}\nInstalled skills available for this task. Use relevant skills; user instructions take precedence. If file tools are available, read the listed SKILL.md when relevant and resolve references relative to its directory. Do not claim tool capabilities you do not have.\n${catalog}\n</available_local_skills>\n${instructions}`;
}
