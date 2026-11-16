// public/i18n.js — antarmuka dua bahasa (Indonesia ⇄ English).
//
// Kenapa kamus + penjelajah DOM, bukan menulis ulang 600+ pemanggilan:
//   • Teks UI tersebar di index.html (statis) DAN di template string app.js
//     (dirender ulang tiap kali state berubah). Mengganti satu per satu berarti
//     menyentuh ratusan tempat dan mudah ada yang terlewat.
//   • Kamus dengan kunci = teks Indonesia asli membuat terjemahan bisa
//     diperiksa langsung: kalau sebuah string tidak ada di kamus, ia tampil apa
//     adanya — tidak pernah kosong, tidak pernah jadi "[object Object]".
//
// Kenapa teks asli DISIMPAN saat diterjemahkan:
//   Berganti bahasa harus dua arah. Kalau teks Indonesia ditimpa tanpa dicatat,
//   kembali ke Indonesia hanya mungkin dengan memuat ulang halaman. Dengan
//   menyimpan nilai asli per node/atribut, ganti bahasa bolak-balik tidak
//   kehilangan apa pun dan tidak perlu reload.
//
// Keamanan terjemahan:
//   • Isi percakapan user/agent, kode, dan nilai input TIDAK PERNAH diterjemahkan.
//   • Idempoten: teks Inggris hasil terjemahan tidak ada di kamus, jadi
//     menjalankannya berulang tidak mengubah apa pun.
//   • MutationObserver menangani konten yang dirender setelah bahasa dipilih.

export const LANGS = [
  { id: 'id', label: 'Indonesia' },
  { id: 'en', label: 'English' },
];

// Pilihan bahasa balasan agent (disimpan di server, bukan per-perangkat).
export const REPLY_LANGS = [
  { id: 'auto', label: 'Ikuti bahasa pesan saya', labelEn: 'Match the language of my message' },
  { id: 'id', label: 'Indonesia', labelEn: 'Indonesian' },
  { id: 'en', label: 'English', labelEn: 'English' },
  { id: 'ja', label: 'Jepang', labelEn: 'Japanese' },
  { id: 'zh', label: 'Mandarin', labelEn: 'Chinese' },
  { id: 'es', label: 'Spanyol', labelEn: 'Spanish' },
  { id: 'ar', label: 'Arab', labelEn: 'Arabic' },
];

// Bagian DOM yang isinya milik user atau kode: jangan disentuh.
const SKIP_SELECTOR = [
  '.msg-body', '.bubble', '.resp',
  'pre', 'code', 'kbd', 'samp',
  'textarea', 'input', 'select', 'option',
  '[contenteditable="true"]',
  '[data-no-i18n]',
  '.term-out', '.terminal-out', '#term-out', '#term-body',
  '.diff-body', '.patch-body',
].join(',');

// Atribut yang terlihat user. `value` sengaja tidak ikut: itu isi input.
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

let lang = 'id';
let dict = {};
let observer = null;
let applying = false;

// Nilai asli (Indonesia) yang telah ditimpa, supaya bisa dikembalikan.
const origText = new Map();   // Text node  -> string asli
const origAttr = new Map();   // Element    -> Map(attr -> nilai asli)

export function currentLang() {
  return lang;
}

export function isEnabled() {
  return lang !== 'id';
}

// Terjemahkan satu string. Mengembalikan input apa adanya bila tidak ada padanan,
// supaya pemanggil bisa memakainya tanpa pengecekan cabang.
export function t(text) {
  if (lang === 'id' || !text) return text;
  const raw = String(text);
  if (raw in dict) return dict[raw];
  // Teks dengan spasi di ujung (dipakai untuk menggabung) tetap dicocokkan
  // lewat bentuk tanpa spasi, lalu spasi aslinya dipulihkan.
  const trimmed = raw.trim();
  if (trimmed !== raw && trimmed in dict) {
    const lead = raw.match(/^\s*/)[0];
    const tail = raw.match(/\s*$/)[0];
    return lead + dict[trimmed] + tail;
  }
  return raw;
}

function translateTextNode(node) {
  const value = node.nodeValue;
  if (!value || !/\S/.test(value)) return;
  const base = origText.has(node) ? origText.get(node) : value;
  const next = t(base);
  if (next === value) return;
  if (!origText.has(node)) origText.set(node, base);
  node.nodeValue = next;
}

function restoreTextNode(node) {
  if (!origText.has(node)) return;
  node.nodeValue = origText.get(node);
  origText.delete(node);
}

function translateElement(el) {
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    const cur = el.getAttribute(attr);
    let store = origAttr.get(el);
    const base = store && store.has(attr) ? store.get(attr) : cur;
    const next = t(base);
    if (next === cur) continue;
    if (!store) { store = new Map(); origAttr.set(el, store); }
    if (!store.has(attr)) store.set(attr, base);
    el.setAttribute(attr, next);
  }
}

function restoreElement(el) {
  const store = origAttr.get(el);
  if (!store) return;
  for (const [attr, value] of store) el.setAttribute(attr, value);
  origAttr.delete(el);
}

function isSkipped(el) {
  return !!(el.closest && el.closest(SKIP_SELECTOR));
}

// Elemen form dilindungi karena ISI-nya (value) milik user, bukan teks UI.
// Tapi placeholder/title/aria-label-nya tetap teks UI dan harus ikut bahasa.
function isFormControl(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

// Telusuri seluruh cabang, lewati area milik user/kode.
function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    const parent = root.parentElement;
    if (parent && !isSkipped(parent)) translateTextNode(root);
    return;
  }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    if (isSkipped(root)) {
      if (isFormControl(root)) translateElement(root);
      return;
    }
    translateElement(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    if (n.nodeType === 3) {
      const parent = n.parentElement;
      if (parent && !isSkipped(parent)) translateTextNode(n);
      n = walker.nextNode();
      continue;
    }
    if (isSkipped(n)) {
      // Form control: atributnya diterjemahkan, isinya tidak. Lalu lanjut ke
      // saudara berikutnya (tidak perlu menelusuri anak-anaknya).
      if (isFormControl(n)) translateElement(n);
      const skip = n;
      let next = walker.nextNode();
      while (next && skip.contains(next)) next = walker.nextNode();
      n = next;
      continue;
    }
    translateElement(n);
    n = walker.nextNode();
  }
}

// Kembalikan seluruh teks ke bahasa sumber (Indonesia).
function restoreAll() {
  disconnectObserver();
  for (const [node, value] of origText) {
    if (node.isConnected) node.nodeValue = value;
  }
  origText.clear();
  for (const [el, store] of origAttr) {
    if (!el.isConnected) continue;
    for (const [attr, value] of store) el.setAttribute(attr, value);
  }
  origAttr.clear();
}

// Terapkan bahasa ke seluruh dokumen + konten yang muncul kemudian.
export function applyLanguage(next) {
  if (!LANGS.some((l) => l.id === next)) next = 'id';
  const changed = next !== lang;

  if (next === 'id') {
    lang = 'id';
    document.documentElement.lang = 'id';
    restoreAll();
    return changed;
  }

  lang = next;
  document.documentElement.lang = 'en';
  // Terapkan ulang dari bahasa sumber supaya ganti ID→EN→ID→EN tetap konsisten.
  applying = true;
  try { walk(document.body); } finally { applying = false; }
  observe();
  return changed;
}

function observe() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (applying || lang === 'id') return;
    applying = true;
    try {
      for (const r of records) {
        if (r.type === 'characterData') {
          const parent = r.target.parentElement;
          if (parent && !isSkipped(parent)) translateTextNode(r.target);
          continue;
        }
        for (const node of r.addedNodes) {
          if (node.nodeType === 1 && isSkipped(node)) {
            if (isFormControl(node)) translateElement(node);
            continue;
          }
          walk(node);
        }
      }
    } finally { applying = false; }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function disconnectObserver() {
  if (observer) { observer.disconnect(); observer = null; }
}

// Daftarkan kamus. Dipisah dari modul ini supaya berkas kamus bisa tumbuh
// tanpa menyentuh logika di atas.
export function loadDict(map) {
  dict = { ...dict, ...map };
  return Object.keys(dict).length;
}

export function dictSize() {
  return Object.keys(dict).length;
}
