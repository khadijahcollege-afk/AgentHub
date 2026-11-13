// AgentHub — UI kontrol-plane ala Kybern (vanilla JS, ESM)
// Studio chat multi-engine + delegation + papan tugas + monitoring.
//
// Semua status yang dulu berupa string lepas / boolean sekarang mengikuti
// mesin di /public/machines.js (dihasilkan dari lib/machines.js). Satu mesin,
// tiga konsumen: server (validasi), UI (label & tombol), agent (kontrak API).
import {
  TASK_STATUSES, TASK_LABELS, TASK_MACHINE, taskCanMove, taskNext,
  RUN_MACHINE, CONNECTION_MACHINE, PROMO_MACHINE, PROMO_PASS_MACHINE, UI_MACHINE,
  STEP_MACHINE, DELEGATION_MACHINE, NOTE_EDITOR_MACHINE,
  VIEWS, UI_LAYERS, SSE_SCOPES, scopeSlices, canTransition, allowedNext,
  RULE_FILES, CHANGE_STATUSES,
} from './machines.js';

// Kontrak mesin juga tersedia di runtime browser: agent yang mengemudikan UI
// lewat CDP bisa membaca aturan yang sama tanpa menebak tombol mana yang ada.
window.__ahMachines = {
  tasks: TASK_MACHINE, run: RUN_MACHINE, connection: CONNECTION_MACHINE,
  promo: PROMO_MACHINE, promoPass: PROMO_PASS_MACHINE, ui: UI_MACHINE, step: STEP_MACHINE,
  delegation: DELEGATION_MACHINE, noteEditor: NOTE_EDITOR_MACHINE,
  views: VIEWS, sse: SSE_SCOPES,
  workspace: { ruleFiles: RULE_FILES, changeStatuses: CHANGE_STATUSES },
};

(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- token ----------
  let token = localStorage.getItem('ah_token') || '';
  const urlParams = new URLSearchParams(location.search);
  const urlToken = urlParams.get('token');
  const urlView = urlParams.get('view');
  const urlThread = urlParams.get('thread');
  let deepLinkDone = false;
  if (urlToken) {
    token = urlToken;
    localStorage.setItem('ah_token', token);
    history.replaceState(null, '', location.pathname);
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        ...opts,
        headers: {
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
        },
      });
    } catch (e) {
      // fetch gagal = transport, bukan HTTP. Ini satu-satunya cara UI tahu
      // server mati; sebelumnya error ini hilang sebagai "Gagal: Failed to fetch".
      setConn('offline', 'server tidak merespons');
      const err = new Error('OFFLINE');
      err.cause = e;
      throw err;
    }
    if (res.status === 401) { setConn('unauthorized'); throw new Error('AUTH'); }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = j;
      throw err;
    }
    if (conn !== 'live') setConn('live');
    return res.json();
  }

  // ---------- state ----------
  let state = null;
  let engines = [];
  let view = 'studio';
  let promoTab = 'live';
  let promoQuery = '';
  let promoPane = localStorage.getItem('ah_promo_pane') === 'free' ? 'free' : 'pass';
  let curThread = null;
  let threadSearch = '';
  let tagFilter = null; // tag aktif untuk filter sidebar (null = semua)
  let cwd = localStorage.getItem('ah_cwd') || '';
  let taskFilter = 'all';
  let taskSearch = '';
  // dideklarasikan di sini supaya pembaruan chip proyek (yang jalan saat modul
  // dimuat) tidak menghantam Temporal Dead Zone deklarasi di bagian tasks.
  let taskProject = 'all';
  let taskGlobal = false;
  // proyek aktif: null = "This PC" (folder kerja bebas)
  let projectCache = [];
  let activeProject = null;
  let editingProject = null;
  let editFolders = [];
  let editPrimary = '';
  // katalog model & effort
  let modelChoices = [];
  let selectedModel = localStorage.getItem('ah_model') || 'auto';
  let effort = localStorage.getItem('ah_effort') || 'default';
  let currentEngine = localStorage.getItem('ah_engine') || 'claude';
  let permission = localStorage.getItem('ah_permission') || 'full';
  // Lampiran yang sudah diunggah tetapi belum terkirim. Setelah send, id-nya
  // menempel di pesan dan file tetap ada untuk dibuka lagi dari riwayat.
  let pendingAttachments = [];
  const MAX_ATTACH_CLIENT = 5;
  const attachObjectUrls = new Map();

  // --- mesin: run & koneksi ---
  // runStatus: idle | running | done | error | stopped (RUN_MACHINE)
  let runStatus = 'idle';
  let runCtrl = null;          // AbortController run aktif
  let conn = 'connecting';     // CONNECTION_MACHINE
  let promoStatus = 'idle';    // PROMO_MACHINE
  let layer = null;            // UI_MACHINE — hanya satu overlay aktif
  let delegationStatus = 'idle'; // DELEGATION_MACHINE
  let delCtrl = null;
  let delThreadId = null;
  let noteEditorState = 'closed'; // NOTE_EDITOR_MACHINE
  let changesOpen = false;        // drawer Perubahan (layout lokal, bukan overlay)
  let workspaceInfo = null;       // ringkasan workspace thread aktif
  let diffInfo = null;            // laporan perubahan lengkap

  const runActive = () => runStatus === 'running';

  function setRun(next) {
    if (next !== runStatus) {
      if (!canTransition(RUN_MACHINE, runStatus, next)) {
        // transisi ilegal = bug pemanggil, bukan kondisi user. Jangan diam-diam.
        console.warn(`[run] transisi ${runStatus} → ${next} tidak sah (boleh: ${allowedNext(RUN_MACHINE, runStatus).join(', ') || '—'})`);
      }
      runStatus = next;
    }
    const btn = $('#btn-send');
    if (btn) btn.disabled = next === 'running';
    const stop = $('#btn-stop');
    if (stop) stop.classList.toggle('hidden', next !== 'running');
    const chip = $('#chat-running');
    if (chip) chip.classList.toggle('hidden', next !== 'running');
  }

  // Server adalah sumber kebenaran untuk run yang sedang berjalan. Saat thread
  // dibuka / direfresh, UI tidak boleh menebak dari boolean `running` lama.
  function syncRunFromThread(thread, { notify = true } = {}) {
    if (!thread) { setRun('idle'); return; }
    const next = thread.runState || (thread.running ? 'running' : 'idle');
    if (next === 'running') { setRun('running'); return; }
    if (next === 'error' && thread.runError && notify) {
      toast('Run terakhir terputus — ' + thread.runError, 4500);
    }
    setRun('idle');
  }

  function setDelegation(next) {
    if (!canTransition(DELEGATION_MACHINE, delegationStatus, next)) {
      console.warn(`[delegation] transisi ${delegationStatus} → ${next} tidak sah`);
    }
    delegationStatus = next;
    const busy = next === 'starting' || next === 'running';
    const start = $('#btn-del-start');
    if (start) start.disabled = busy;
    const cancel = $('#btn-del-cancel');
    if (cancel) cancel.textContent = busy ? 'Hentikan' : 'Batal';
  }

  function setPromo(next) {
    if (!canTransition(PROMO_MACHINE, promoStatus, next)) {
      console.warn(`[promo] transisi ${promoStatus} → ${next} tidak sah`);
    }
    promoStatus = next;
  }

  function setConn(next, detail) {
    conn = next;
    const banner = $('#conn-banner');
    if (!banner) return;
    const label = CONNECTION_MACHINE.states[next] || next;
    const show = next === 'degraded' || next === 'offline' || next === 'unauthorized';
    banner.classList.toggle('hidden', !show);
    banner.dataset.state = next;
    const txt = $('#conn-text');
    if (txt) txt.textContent = detail ? `${label} — ${detail}` : label;
  }

  const svgIco = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
  const SPARK_SVG = svgIco('<path d="M12 3.6l1.9 6.5 6.5 1.9-6.5 1.9-1.9 6.5-1.9-6.5L3.6 12l6.5-1.9z"/>');
  const FOLDER_SVG = svgIco('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>');
  // Satu set ikon SVG stroke untuk seluruh UI — tanpa emoji bawaan platform.
  const ICON_PATHS = {
    pool: '<path d="M13 2.5 4.5 13.5H11l-1 8L18.5 10H12z"/>',
    claude: '<path d="M12 5v14M6 7.5l12 9M18 7.5l-12 9"/>',
    codex: '<path d="M12 4l8 8-8 8-8-8z"/>',
    opencode: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
    gemini: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
    echo: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    robot: '<rect x="6" y="7" width="12" height="11" rx="3"/><path d="M9 7V4M15 7V4M9 18v2M15 18v2M3 11h3M3 14h3M18 11h3M18 14h3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8L18.5 10H12z"/>',
    shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>',
    snow: '<path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
    pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
    external: '<path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/><path d="M13 4h7v7"/><path d="M20 4 11 13"/>',
    check: '<path d="M8.4 12.2l2.5 2.5 4.7-4.9"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/>',
    pin: '<path d="M12 3v7M8.5 10h7l1.5 5h-10z"/><path d="M12 15v6"/>',
    spark: '<path d="M12 3.6l1.9 6.5 6.5 1.9-6.5 1.9-1.9 6.5-1.9-6.5L3.6 12l6.5-1.9z"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',
    paperclip: '<path d="M8.5 12.5l6.2-6.2a3 3 0 0 1 4.2 4.2l-7.6 7.6a5 5 0 0 1-7.1-7.1l7-7"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9.5 12l1.8 1.8 3.2-3.6"/>',
    tag: '<path d="M3.5 12.5 11 5h6.5V11.5L10 19z"/><circle cx="14.5" cy="8.5" r="1"/>',
  };
  const icon = (id) => `<svg class="ico" viewBox="0 0 24 24">${ICON_PATHS[id] || ICON_PATHS.robot}</svg>`;
  const fmtCtx = (n) => (n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : n);
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');
  const fmtWhen = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtClock(ts);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cwdBase = () => (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : 'This PC');
  const projectLabel = (p) => (!p || p === 'default' ? cwdBase() : p);
  const hueOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  // Palet proyek yang tenang (bukan hue acak): oranye, biru, hijau, violet.
  const PROJECT_HUES = [24, 208, 152, 266, 40, 190];
  const projectColor = (p) => (!p || p === 'default'
    ? '#ef7d45'
    : `hsl(${PROJECT_HUES[hueOf(p) % PROJECT_HUES.length]} 42% 60%)`);
  const projectInitials = (p) => {
    const parts = String(p || 'AH').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(parts[0] || 'AH').slice(0, 2)).toUpperCase();
  };
  const spark = (color) => `<span class="r-ico" style="color:${color}">${SPARK_SVG}</span>`;

  function md(s) {
    let out = esc(s);
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, code) => `<div class="code-wrap"><button class="code-copy" title="Salin kode">${copyIco}</button><pre class="codeblock">${code}</pre></div>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }
  const copyIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  // tombol salin pada blok kode — delegasi global supaya bekerja untuk pesan
  // yang dirender ulang maupun sedang streaming
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.parentElement?.querySelector('pre')?.textContent || '';
    navigator.clipboard?.writeText(code)
      .then(() => {
        btn.textContent = 'tersalin';
        setTimeout(() => { btn.innerHTML = copyIco; }, 1200);
      })
      .catch(() => toast('Gagal menyalin kode'));
  });

  function daySep(ts) {
    const d = new Date(ts);
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    const s = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
    return `<div class="day-sep">${same ? 'Today' : 'Earlier'} · ${s}</div>`;
  }

  // Toast: satu pesan = satu elemen. Dulu event SSE beruntun menumpuk toast
  // kembar dan menutupi UI.
  const toastSeen = new Map();
  function toast(msg, ms = 3500) {
    const key = String(msg);
    const now = Date.now();
    const prev = toastSeen.get(key);
    if (prev && now - prev < 1500) return;   // debounce pesan yang sama
    toastSeen.set(key, now);
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(() => { el.remove(); if (toastSeen.get(key) === now) toastSeen.delete(key); }, ms);
  }

  async function loadState({ slices, silent = false } = {}) {
    try {
      state = await api('/api/state');
      $('#gate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      renderAll(slices);
      if (slices) {
        // render selektif: papan tugas & tampilan aktif tetap ikut segar
        if (slices.includes('tasks') && view === 'tasks') renderTasks();
        if (slices.includes('notes') && view === 'notes') renderNotes();
        return;
      }
      if (!deepLinkDone) {
        deepLinkDone = true;
        if (urlThread) openThread(urlThread);
        else if (urlView && document.getElementById(`view-${urlView}`)) go(urlView, { silentRoute: true });
      }
    } catch (e) {
      if (e.message === 'AUTH') { showGate(); return; }
      if (e.message === 'OFFLINE') { if (!silent) setConn('offline'); return; }
      if (!silent) toast('Gagal memuat: ' + e.message);
    }
  }

  function showGate() {
    $('#app').classList.add('hidden');
    $('#gate').classList.remove('hidden');
  }

  $('#gate-btn').addEventListener('click', async () => {
    token = $('#gate-token').value.trim();
    localStorage.setItem('ah_token', token);
    try { await api('/api/state'); location.reload(); }
    catch { $('#gate-err').classList.remove('hidden'); }
  });
  $('#gate-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-btn').click(); });

  // ---------- navigasi ----------
  let sidebarOpen = window.innerWidth > 900;
  function applySidebar() {
    const show = view === 'studio' && sidebarOpen;
    $('#sidebar').classList.toggle('hidden', !show);
    const backdrop = $('#sb-backdrop');
    if (backdrop) backdrop.classList.toggle('hidden', !(show && window.innerWidth <= 900));
  }

  // URL adalah bagian dari state, bukan efek samping. Tanpa ini, refresh /
  // bookmark / share selalu mendarat di Studio dan user kehilangan konteks.
  function syncRoute(v, threadId) {
    const q = new URLSearchParams(location.search);
    q.delete('token');
    if (v && v !== 'studio') q.set('view', v); else q.delete('view');
    if (threadId) q.set('thread', threadId); else q.delete('thread');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  function go(v, { silentRoute = false } = {}) {
    if (!VIEWS.includes(v)) v = 'studio';
    view = v;
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
    $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    applySidebar();
    if (!silentRoute) syncRoute(v, curThread?.id);
    if (v === 'studio') { renderSidebar(); placeComposer(); if (curThread) renderChat(); }
    if (v === 'tasks') renderTasks();
    if (v === 'notes') renderNotes();
    if (v === 'alerts') markReadSoon();
  }
  $('#btn-side-toggle').addEventListener('click', () => { sidebarOpen = !sidebarOpen; applySidebar(); });
  $('#sb-backdrop').addEventListener('click', () => { sidebarOpen = false; applySidebar(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 900) sidebarOpen = true; applySidebar(); });
  $$('.rail-btn[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-view]');
    if (g && !g.classList.contains('rail-btn')) go(g.dataset.view);
  });

  // ---------- dialog in-app ----------
  // Dialog native confirm/prompt diblokir di Electron & webview, dan tidak bisa
  // dikemudikan agent lewat CDP. Semua konfirmasi memakai overlay ini; promise
  // membuat call-site tetap linear dan antrean mencegah dua dialog bertumpuk.
  let dialogActive = null;
  const dialogQueue = [];
  let dialogReturnFocus = null;

  function askDialog(opts = {}) {
    return new Promise((resolve) => {
      dialogQueue.push({ opts, resolve });
      pumpDialog();
    });
  }

  function askConfirm(message, opts = {}) {
    return askDialog({
      title: opts.title || 'Konfirmasi',
      message,
      okLabel: opts.okLabel || 'Lanjut',
      cancelLabel: opts.cancelLabel || 'Batal',
      danger: !!opts.danger,
    });
  }

  function askPrompt(message, value = '', opts = {}) {
    return askDialog({
      title: opts.title || 'Masukkan nilai',
      message,
      input: true,
      value,
      placeholder: opts.placeholder || '',
      okLabel: opts.okLabel || 'Simpan',
      cancelLabel: opts.cancelLabel || 'Batal',
      danger: !!opts.danger,
      requireValue: opts.requireValue !== false,
    });
  }

  // ---------- dialog tag thread ----------
  let tagDialogThread = null;
  let tagDialogTags = [];
  function renderTagDialog() {
    const host = $('#tag-current');
    if (!host) return;
    host.innerHTML = tagDialogTags.length
      ? tagDialogTags.map((tg, i) => `
        <span class="tag-edit" title="Klik untuk hapus">
          ${icon('tag')}<b>${esc(tg)}</b><i class="tag-x" data-tag-x="${i}">${icon('x')}</i>
        </span>`).join('')
      : '<span class="muted small">Belum ada tag.</span>';
    $$('#tag-current [data-tag-x]').forEach((x) => x.addEventListener('click', () => {
      tagDialogTags.splice(Number(x.dataset.tagX), 1);
      renderTagDialog();
    }));
  }
  function openTagDialog(id) {
    const t = threadCache.find((x) => x.id === id);
    if (!t) return;
    tagDialogThread = t;
    tagDialogTags = [...(t.tags || [])];
    renderTagDialog();
    const input = $('#tag-input');
    input.value = '';
    $('#tag-dialog').classList.remove('hidden');
    input.focus();
  }
  function closeTagDialog() {
    $('#tag-dialog').classList.add('hidden');
    tagDialogThread = null;
    tagDialogTags = [];
  }
  function addTagDialog() {
    const input = $('#tag-input');
    const v = input.value.trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!v) return;
    if (tagDialogTags.some((x) => x.toLowerCase() === v.toLowerCase())) { input.value = ''; return; }
    if (tagDialogTags.length >= 8) { toast('Maksimal 8 tag'); return; }
    tagDialogTags.push(v);
    input.value = '';
    renderTagDialog();
    input.focus();
  }
  $('#tag-add').addEventListener('click', addTagDialog);
  $('#tag-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTagDialog(); } });
  $('#tag-cancel').addEventListener('click', closeTagDialog);
  $('#tag-dialog').addEventListener('click', (e) => { if (e.target.id === 'tag-dialog') closeTagDialog(); });
  $('#tag-save').addEventListener('click', async () => {
    if (!tagDialogThread) return closeTagDialog();
    const id = tagDialogThread.id;
    const tags = [...tagDialogTags];
    closeTagDialog();
    try {
      await api(`/api/threads/${id}`, { method: 'POST', body: JSON.stringify({ tags }) });
      toast('Tag disimpan');
      await loadState({ slices: ['threads'], silent: true });
    } catch (e) { toast('Gagal: ' + e.message); }
  });

  function pumpDialog() {
    if (dialogActive || !dialogQueue.length) return;
    dialogActive = dialogQueue.shift();
    renderDialog(dialogActive.opts);
  }

  function renderDialog(opts) {
    dialogReturnFocus = document.activeElement;
    $('#dialog-title').textContent = opts.title || 'Konfirmasi';
    const msg = $('#dialog-message');
    msg.textContent = opts.message || '';
    msg.classList.toggle('hidden', !opts.message);
    const input = $('#dialog-input');
    input.classList.toggle('hidden', !opts.input);
    input.value = opts.input ? (opts.value || '') : '';
    input.placeholder = opts.placeholder || '';
    const ok = $('#dialog-ok');
    ok.textContent = opts.okLabel || 'Lanjut';
    ok.classList.toggle('primary', !opts.danger);
    ok.classList.toggle('danger', !!opts.danger);
    $('#dialog-cancel').textContent = opts.cancelLabel || 'Batal';
    const overlay = $('#dialog-overlay');
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    syncDialogOk();
    const target = opts.input ? input : ok;
    setTimeout(() => { target.focus(); if (opts.input) input.select(); }, 30);
  }

  function syncDialogOk() {
    const ok = $('#dialog-ok');
    if (!ok) return;
    const opts = dialogActive?.opts;
    ok.disabled = !!(opts?.requireValue && !$('#dialog-input').value.trim());
  }

  function closeDialog(ok) {
    if (!dialogActive) return;
    const active = dialogActive;
    dialogActive = null;
    const value = active.opts.input ? $('#dialog-input').value : '';
    $('#dialog-overlay').classList.add('hidden');
    $('#dialog-overlay').setAttribute('aria-hidden', 'true');
    const back = dialogReturnFocus;
    dialogReturnFocus = null;
    if (back?.isConnected && !back.closest('#dialog-overlay')) back.focus();
    active.resolve(active.opts.input ? (ok ? value : null) : !!ok);
    pumpDialog();
  }

  function dialogFocusables() {
    return $$('#dialog-overlay button, #dialog-overlay input')
      .filter((el) => !el.classList.contains('hidden') && !el.disabled);
  }

  $('#dialog-ok').addEventListener('click', () => closeDialog(true));
  $('#dialog-cancel').addEventListener('click', () => closeDialog(false));
  $('#dialog-input').addEventListener('input', syncDialogOk);
  $('#dialog-overlay').addEventListener('click', (e) => {
    if (e.target === $('#dialog-overlay')) closeDialog(false);
  });

  // Listener ini sengaja dipasang sebelum shortcut global di bawah supaya
  // Escape/Enter/Tab milik dialog menang, dan shortcut aplikasi tidak jalan
  // saat modal terbuka.
  document.addEventListener('keydown', (e) => {
    if (!dialogActive) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeDialog(false); return; }
    if (e.key === 'Tab') {
      const items = dialogFocusables();
      if (items.length) {
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Enter') {
      const tag = e.target?.tagName;
      e.stopImmediatePropagation();
      if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (!$('#dialog-ok').disabled) closeDialog(true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) e.stopImmediatePropagation();
  });

  // ---------- overlay: satu layer aktif pada satu waktu ----------
  // Dulu tiap handler menutup popover lain secara manual (dan overlay delegasi
  // tidak menutup apa pun). Sekarang ada satu pemilik state.
  const LAYER_EL = {
    usage: '#usage-pop',
    env: '#env-pop',
    qr: '#qr-pop',
    delegate: '#delegate-overlay',
    note: '#note-overlay',
    adopt: '#adopt-overlay',
    promoClaim: '#promo-claim-overlay',
    project: '#project-overlay',
    projectEdit: '#project-edit-overlay',
    models: '#model-pop',
    effort: '#effort-pop',
    engines: '#engine-pop',
    access: '#access-pop',
    git: '#git-pop',
    sbMenu: '#sb-menu-pop',
    palette: '#palette-pop',
    search: '#search-pop',
    mention: '#mention-pop',
    prompts: '#prompts-pop',
    session: '#session-pop',
    account: '#account-pop',
    integrations: '#integrations-overlay',
    tools: '#tools-pop',
    shortcuts: '#shortcuts-overlay',
  };

  async function setLayer(next) {
    if (next && !UI_LAYERS.includes(next)) return;
    // Catatan yang belum disimpan tidak boleh hilang karena Esc / klik luar.
    if (layer === 'note' && next !== 'note' && noteEditorState === 'dirty') {
      const discard = await askConfirm('Catatan belum disimpan. Tutup tanpa menyimpan?', {
        title: 'Tutup catatan?',
        okLabel: 'Tutup tanpa simpan',
        cancelLabel: 'Kembali',
        danger: true,
      });
      if (!discard) return;
      if (layer !== 'note') return;
      noteEditorState = 'closed';
    }
    if (next && !canTransition(UI_MACHINE, layer, next)) console.warn(`[ui] layer ${layer} → ${next} tidak sah`);
    layer = next || null;
    for (const [name, sel] of Object.entries(LAYER_EL)) {
      const el = $(sel);
      if (!el) continue;
      el.classList.toggle('hidden', layer !== name);
      el.setAttribute('aria-hidden', layer === name ? 'false' : 'true');
    }
    if (layer === 'delegate') $('#del-prompt')?.focus();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && layer) { setLayer(null); }
    // Ctrl+8 toggle sidebar (ala shortcut overlay aplikasi agent)
    if ((e.ctrlKey || e.metaKey) && e.key === '8') {
      e.preventDefault();
      $('#btn-side-toggle').click();
      return;
    }
    // Ctrl+F: pencarian dalam thread (menggantikan find bawaan browser)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      toggleFind();
      return;
    }
    // Ctrl+/ membuka daftar pintasan yang bisa diklik
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      openShortcuts();
      return;
    }
    // shortcut nyata ala aplikasi agent populer: Ctrl+K palet, Alt+N chat baru
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openPalette();
    }
    if (e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      $('#btn-new-chat').click();
    }
  });

  // Klik di luar popover menutupnya — tapi klik pada pemicu bukan "di luar".
  // Tanpa daftar ini, klik #rail-usage membuka lalu langsung menutup popover
  // dalam event yang sama (bug halus yang tidak terlihat di kode).
  const LAYER_TRIGGERS = ['#rail-usage', '#rail-env', '#env-open', '#env-pair', '[data-open-delegate]', '#btn-note-new', '.note-cell', '.adopt-btn', '#engine-chip', '#effort-chip', '#access-chip', '#composer-branch', '#sb-menu-btn', '#btn-cwd', '#composer-cwd', '#sb-search-btn', '#btn-filter-projects', '#btn-prompts', '#btn-session-info', '#sb-account', '#btn-tools'];
  const LAYER_TRIGGER_SEL = LAYER_TRIGGERS.join(',');

  document.addEventListener('click', (e) => {
    if (!layer) return;
    if (e.target.closest(Object.values(LAYER_EL).join(','))) return;
    if (e.target.closest(LAYER_TRIGGER_SEL)) return;
    if (layer === 'delegate' || layer === 'note' || layer === 'adopt' || layer === 'projectEdit' || layer === 'promoClaim') return; // overlay modal: hanya tombol tutup/Esc
    setLayer(null);
  });

  // ---------- render utama ----------
  // slices: undefined = semua. SSE memanggil dengan daftar slice yang berubah,
  // jadi event `tasks` tidak lagi me-render ulang chat/promo/keys.
  function renderAll(slices) {
    const want = (s) => !slices || slices.includes('all') || slices.includes(s);
    if (want('threads')) renderSidebar();
    if (want('engines')) renderEngines();
    if (want('notes')) renderNotes();
    if (want('promo') || want('snapshot')) renderPromo();
    if (want('promoPass') || want('promo')) renderPromoPass();
    if (want('promoPass') || want('promo')) setPromoPane(promoPane, { silent: true });
    if (want('keys')) renderKeys();
    if (want('pool') || want('keys')) renderGateway();
    if (want('agents')) renderAgents();
    if (want('alerts')) renderAlerts();
    if (want('config') || want('server')) renderSettings();
    if (want('alerts')) renderBadges();
    if (want('threads') && curThread) renderChat({ preserveStream: runActive() });
    if (want('threads') || want('engines')) placeComposer();
  }

  function renderBadges() {
    const unread = state.alerts.filter((a) => !a.read).length;
    const badge = $('#badge-alerts');
    badge.classList.toggle('hidden', unread === 0);
    badge.textContent = unread > 9 ? '9+' : unread;
  }

  function engineLabel(id) {
    return engines.find((e) => e.id === id)?.label || id || 'pool';
  }

  // ---------- studio: engines ----------
  // Menu engine custom bergaya UI gelap — select native tidak bisa mengikuti tema.
  async function renderEngines(force = false) {
    try { engines = await api('/api/engines' + (force ? '?refresh=1' : '')); } catch { engines = engines || []; }
    const saved = localStorage.getItem('ah_engine');
    if (saved && engines.some((e) => e.id === saved && e.available)) {
      currentEngine = saved;
    } else if (!engines.some((e) => e.id === currentEngine && e.available)) {
      currentEngine = engines.find((e) => e.available)?.id || currentEngine;
    }
    applyEngine();
    renderDelegationEngines();
  }

  function engineShort(id) {
    if (id === 'pool') return 'Gateway';
    return engines.find((e) => e.id === id)?.label || id;
  }

  function applyEngine() {
    localStorage.setItem('ah_engine', currentEngine);
    const label = $('#engine-label');
    if (label) {
      let text = engineShort(currentEngine);
      if (currentEngine === 'pool' && selectedModel && selectedModel !== 'auto') {
        text += ' · ' + String(selectedModel).split('/').pop().slice(0, 22);
      }
      label.textContent = text;
    }
    // model kini tampil di chip engine — input ini tersembunyi dan hanya
    // menyimpan nilai terpilih untuk dikirim ke /send
    $('#chat-model').classList.add('hidden');
    if (currentEngine === 'pool') $('#chat-model').value = selectedModel === 'auto' ? '' : selectedModel;
  }

  // popover ditempel ke chip pemicunya — bukan melayang di pojok layar
  function positionPop(popSel, triggerSel) {
    const pop = $(popSel);
    const trigger = $(triggerSel);
    if (!pop || !trigger) return;
    pop.style.left = 'auto'; pop.style.right = 'auto'; pop.style.top = 'auto'; pop.style.bottom = 'auto';
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth || 330;
    const ph = pop.offsetHeight || 180;
    let x = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 10);
    let y = r.top - ph - 10;
    if (y < 8) y = r.bottom + 10;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, window.innerHeight - ph - 8);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
  }

  function renderEngineMenu() {
    const host = $('#engine-rows');
    if (!host) return;
    host.innerHTML = engines.map((e) => `
      <div class="pick-row ${currentEngine === e.id ? 'active' : ''}" data-engine="${esc(e.id)}" ${e.available ? '' : 'data-off="1"'} title="${esc(e.note || '')}">
        <span class="pick-ico">${icon(e.id)}</span>
        <span class="pick-main"><b>${esc(e.label)}</b><small>${esc(e.note || '')}</small></span>
        ${currentEngine === e.id ? '<span class="pick-check">✓</span>' : ''}
      </div>`).join('');
    $$('#engine-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      if (row.dataset.off) return toast('Engine tidak tersedia — ' + (engines.find((x) => x.id === row.dataset.engine)?.note || ''));
      currentEngine = row.dataset.engine;
      applyEngine();
      setLayer(null);
    }));
    if (currentEngine === 'pool') {
      const pick = document.createElement('div');
      pick.className = 'pick-row add';
      pick.innerHTML = `<span class="pick-ico">${icon('spark')}</span><span class="pick-main"><b>Pilih model gateway…</b><small>${esc(selectedModel === 'auto' ? 'auto — default per provider' : selectedModel)}</small></span>`;
      pick.addEventListener('click', () => { setLayer(null); setTimeout(() => openModelPop(), 60); });
      host.appendChild(pick);
    }
  }
  $('#engine-chip').addEventListener('click', () => {
    if (layer === 'engines') setLayer(null);
    else { setLayer('engines'); renderEngineMenu(); positionPop('#engine-pop', '#engine-chip'); }
  });

  // Folder bebas untuk "This PC" (tanpa proyek). Server memvalidasi path yang
  // sama dengan yang nanti dipakai thread, jadi folder salah tidak sempat
  // tersimpan di localStorage dan baru gagal saat run dimulai.
  async function setCwd(v) {
    const next = (v || '').trim();
    if (next) {
      try {
        const r = await api(`/api/workspace/check?cwd=${encodeURIComponent(next)}`);
        cwd = r.cwd;
      } catch (e) {
        toast('Folder tidak bisa dipakai: ' + e.message, 4000);
        return false;
      }
    } else {
      cwd = '';
    }
    if (cwd) localStorage.setItem('ah_cwd', cwd);
    else localStorage.removeItem('ah_cwd');
    updateProjectChips();
    refreshBranch();
    return true;
  }

  // ---------- proyek aktif ----------
  // Proyek menyimpan {id, name, folders[], primaryFolder}. Proyek aktif menentukan
  // folder kerja agent, filter papan tugas, dan branch yang ditampilkan.
  const activeCwd = () => (activeProject ? activeProject.primaryFolder : (cwd || undefined));
  const activeLabel = () => (activeProject ? activeProject.name : cwdBase());

  function updateProjectChips() {
    const label = activeLabel();
    const chip = $('#cwd-name');
    if (chip) chip.textContent = label;
    const hero = $('#hero-project-name');
    if (hero) hero.textContent = label;
    $('#task-project-name').textContent = taskProject === 'all' ? label : taskProject;
  }

  function syncActiveProject() {
    const stored = localStorage.getItem('ah_project');
    if (!stored) {
      if (activeProject) { activeProject = null; updateProjectChips(); refreshBranch(); }
      return;
    }
    const p = (state.projects || []).find((x) => x.id === stored) || null;
    if ((p?.id || null) !== (activeProject?.id || null)) {
      activeProject = p;
      if (!p) localStorage.removeItem('ah_project');
      updateProjectChips();
      refreshBranch();
    }
  }

  function setActiveProject(p) {
    activeProject = p || null;
    if (p) localStorage.setItem('ah_project', p.id);
    else localStorage.removeItem('ah_project');
    taskProject = p ? p.id : 'all';
    updateProjectChips();
    renderSidebar();
    if (view === 'tasks') renderTasks();
    refreshBranch();
  }

  // branch git folder aktif — dari server (read-only), bukan tebakan UI.
  async function refreshBranch() {
    const el = $('#cwd-branch');
    if (!el) return;
    const q = activeProject
      ? `projectId=${encodeURIComponent(activeProject.id)}`
      : `cwd=${encodeURIComponent(cwd || '')}`;
    try {
      const c = await api(`/api/context?${q}`);
      el.textContent = c.branch || '—';
    } catch { el.textContent = '—'; }
  }

  $('#composer-cwd').addEventListener('click', () => { renderProjectPicker(); setLayer('project'); });
  $('#btn-cwd').addEventListener('click', () => { renderProjectPicker(); setLayer('project'); });
  updateProjectChips();

  // ---------- studio: sidebar ----------
  let threadCache = [];
  let railProjects = [];

  // Ruang cepat di rail, seperti tile proyek berwarna di Kybern.
  function renderRailSpaces() {
    const host = $('#rail-spaces');
    if (!host) return;
    const tiles = [
      ...projectCache.slice(0, 4).map((p) => ({ key: p.id, label: p.name })),
      ...railProjects.filter((p) => p !== 'default' && !projectCache.some((x) => x.id === p)).slice(0, 2)
        .map((p) => ({ key: p, label: p, task: true })),
    ];
    host.innerHTML = tiles.map((t) => `
      <button class="space-tile" data-space="${esc(t.key)}" data-task="${t.task ? '1' : ''}" title="${esc(t.label)}"
        style="background:${projectColor(t.label)}">${esc(projectInitials(t.label))}</button>`).join('') +
      `<button class="space-tile add" id="rail-add-space" title="Proyek baru">＋</button>`;
    $$('#rail-spaces [data-space]').forEach((btn) => btn.addEventListener('click', () => {
      const p = projectCache.find((x) => x.id === btn.dataset.space);
      if (p) { setActiveProject(p); go('studio'); return; }
      taskProject = btn.dataset.space;
      taskGlobal = false;
      go('tasks');
    }));
    $('#rail-add-space')?.addEventListener('click', () => openProjectEditor(null));
  }

  async function renderSidebar() {
    try { threadCache = await api('/api/threads'); } catch { return; }
    let taskList = [];
    try { taskList = await api('/api/tasks'); } catch { /* opsional */ }
    try { projectCache = await api('/api/projects'); } catch { projectCache = projectCache || []; }
    syncActiveProject();
    railProjects = [...new Set(taskList.map((t) => t.projectId || 'default'))];
    renderRailSpaces();

    const q = threadSearch.toLowerCase();
    // semua tag yang dipakai (untuk baris filter di atas daftar)
    const allTags = [...new Set(threadCache.flatMap((t) => t.tags || []))].sort();
    let list = q ? threadCache.filter((t) => (t.title + ' ' + t.preview).toLowerCase().includes(q)) : threadCache;
    if (tagFilter) list = list.filter((t) => (t.tags || []).some((x) => x.toLowerCase() === tagFilter.toLowerCase()));

    // baris filter tag (tampil hanya bila ada tag)
    const tagRow = $('#sb-tagrow');
    if (tagRow) {
      tagRow.innerHTML = allTags.length
        ? allTags.map((tg) => `<button class="tag-chip ${tagFilter === tg ? 'active' : ''}" data-tagfilter="${esc(tg)}">${esc(tg)}</button>`).join('')
          + (tagFilter ? '<button class="tag-chip clear" data-tagclear title="Hapus filter">✕</button>' : '')
        : '';
    }

    // Recents di sidebar
    $('#sb-recents').innerHTML = list.length
      ? list.map((t) => `
        <div class="recent-item ${curThread?.id === t.id ? 'active' : ''}" data-id="${t.id}" title="${esc(t.title)}">
          ${spark(t.running ? 'var(--accent)' : '#7d7d85')}
          <span class="r-title">${esc(t.title)}</span>
          ${(t.tags || []).length ? `<span class="r-tags">${(t.tags || []).slice(0, 3).map((tg) => `<i class="tag-mini" title="${esc(tg)}">${esc(tg)}</i>`).join('')}${(t.tags || []).length > 3 ? `<i class="tag-mini">+${(t.tags || []).length - 3}</i>` : ''}</span>` : ''}
          <span class="r-acts">
            <button class="icon-btn r-act" data-th-pin="${t.id}" title="${t.pinned ? 'Lepas pin' : 'Sematkan'}">${icon('pin')}</button>
            <button class="icon-btn r-act" data-th-tag="${t.id}" title="Tag">${icon('tag')}</button>
            <button class="icon-btn r-act" data-th-rename="${t.id}" title="Ganti nama">${icon('pencil')}</button>
            <button class="icon-btn r-act" data-th-export="${t.id}" title="Export .md">${icon('external')}</button>
          </span>
          <span class="r-time">${t.running ? 'Working' : fmtWhen(t.updatedAt)}</span>
        </div>`).join('')
      : '<p class="muted small" style="padding:6px 9px">Belum ada thread.</p>';
    $$('#sb-recents .recent-item').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('.r-act')) return;
      openThread(el.dataset.id);
    }));
    // filter tag
    $$('#sb-tagrow [data-tagfilter]').forEach((b) => b.addEventListener('click', () => {
      tagFilter = tagFilter === b.dataset.tagfilter ? null : b.dataset.tagfilter;
      renderSidebar();
    }));
    const tagClear = $('#sb-tagrow [data-tagclear]');
    if (tagClear) tagClear.addEventListener('click', () => { tagFilter = null; renderSidebar(); });
    const threadAct = async (id, patch, msg) => {
      try {
        await api(`/api/threads/${id}`, { method: 'POST', body: JSON.stringify(patch) });
        toast(msg);
        await loadState({ slices: ['threads'], silent: true });
      } catch (e) { toast('Gagal: ' + e.message); }
    };
    $$('#sb-recents [data-th-pin]').forEach((b) => b.addEventListener('click', () => {
      const t = threadCache.find((x) => x.id === b.dataset.thPin);
      threadAct(b.dataset.thPin, { pinned: !t?.pinned }, t?.pinned ? 'Pin dilepas' : 'Thread disematkan');
    }));
    $$('#sb-recents [data-th-tag]').forEach((b) => b.addEventListener('click', () => openTagDialog(b.dataset.thTag)));
    $$('#sb-recents [data-th-rename]').forEach((b) => b.addEventListener('click', async () => {
      const t = threadCache.find((x) => x.id === b.dataset.thRename);
      const v = await askPrompt('Judul baru untuk thread ini.', t?.title || '', {
        title: 'Ganti judul thread',
        placeholder: 'Judul thread',
        requireValue: false,
      });
      if (v && v.trim()) threadAct(b.dataset.thRename, { title: v.trim() }, 'Judul diubah');
    }));
    $$('#sb-recents [data-th-export]').forEach((b) => b.addEventListener('click', () => {
      window.open(`/api/threads/${b.dataset.thExport}/export`, '_blank');
    }));

    // Project rows: This PC (tanpa proyek) + proyek tersimpan + proyek dari tugas
    const rows = [{ id: '', label: 'This PC', folder: true, check: !activeProject, sub: 'Tanpa proyek — folder kerja bebas' }];
    for (const p of projectCache) {
      rows.push({ id: p.id, label: p.name, color: projectColor(p.name), check: activeProject?.id === p.id, sub: p.primaryFolder, proj: p });
    }
    for (const p of railProjects) {
      if (p === 'default' || projectCache.some((x) => x.id === p)) continue;
      rows.push({ id: p, label: p, color: projectColor(p), check: false, sub: 'dari papan tugas' });
    }
    $('#sb-projects').innerHTML = rows.map((r) => `
      <div class="project-row ${r.check ? 'active' : ''}" data-pid="${esc(r.id)}" title="${esc(r.label)}">
        ${r.folder ? `<span class="p-ico">${FOLDER_SVG}</span>` : `<span class="p-dot" style="background:${r.color}"></span>`}
        <span class="p-name">${esc(r.label)}</span>
        ${r.proj ? `<span class="p-ext" title="Edit proyek"><svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg></span>` : ''}
        ${r.check ? '<span class="p-check">✓</span>' : ''}
      </div>`).join('');
    $$('#sb-projects .project-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.p-ext')) {
          const p = projectCache.find((x) => x.id === row.dataset.pid);
          if (p) openProjectEditor(p);
          return;
        }
        const p = projectCache.find((x) => x.id === row.dataset.pid);
        setActiveProject(p || null);
        refreshBranch();
      });
    });

    // Continue di hero
    const hero = $('#hero-recent');
    if (hero) {
      hero.innerHTML = list.slice(0, 4).map((t) => `
        <div class="recent-item" data-id="${t.id}" title="${esc(t.title)}">
          ${spark(t.running ? 'var(--accent)' : '#7d7d85')}
          <span class="r-title">${esc(t.title)}</span>
          <span class="r-time">${t.running ? 'Working' : fmtWhen(t.updatedAt)}</span>
        </div>`).join('') || '<p class="muted small" style="padding:4px 9px">Belum ada sesi — kirim prompt pertama.</p>';
      $$('#hero-recent .recent-item').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.id)));
    }
    renderOnboarding();
    const heroTitle = $('#hero-project-name');
    if (heroTitle) heroTitle.textContent = activeLabel();
    const sbTitle = $('#sb-title');
    if (sbTitle) sbTitle.textContent = 'AgentHub';
    $('#env-note').textContent = activeProject ? activeProject.primaryFolder : 'server jalan';
  }

  // ---------- onboarding: 4 langkah pertama untuk instalasi baru ----------
  // Hanya tampil saat belum ada key & thread dan belum ditutup. Setiap
  // langkah memantau state nyata — dicentang otomatis saat langkah selesai.
  function onboardSteps() {
    const hasKey = (state.keys || []).length > 0;
    const pool = state.pool || { total: 0 };
    const hasThread = (threadCache || []).length > 0;
    const steps = [
      { n: 1, label: 'Tambah key API gratis', done: hasKey, act: () => { go('keys'); }, actLabel: 'Buka API Keys' },
      { n: 2, label: 'Masukkan ke pool gateway', done: (pool.total || 0) > 0, act: () => { go('gateway'); }, actLabel: 'Buka Gateway' },
      { n: 3, label: 'Jalankan agent pertama', done: hasThread, act: () => { go('studio'); $('#composer-input')?.focus(); }, actLabel: 'Tulis prompt' },
      { n: 4, label: 'Hubungkan HP (QR)', done: localStorage.getItem('ah_onboard_hp') === '1', act: () => { localStorage.setItem('ah_onboard_hp', '1'); renderOnboarding(); renderSettings(); setTimeout(() => setLayer('qr'), 0); }, actLabel: 'Tampilkan QR' },
    ];
    return steps;
  }
  function renderOnboarding() {
    const host = $('#onboard-card');
    if (!host) return;
    const dismissed = localStorage.getItem('ah_onboard_done') === '1';
    const fresh = !(state.keys || []).length && !(threadCache || []).length;
    if (dismissed || !fresh) { host.classList.add('hidden'); return; }
    const steps = onboardSteps();
    const doneCount = steps.filter((s) => s.done).length;
    host.innerHTML = `
      <div class="ob-head">
        <b>Mulai dalam 4 langkah</b>
        <span class="muted small">${doneCount}/4 selesai</span>
        <span class="grow"></span>
        <button class="icon-btn" id="btn-onboard-close" title="Sembunyikan">${icon('x')}</button>
      </div>
      ${steps.map((s) => `
        <div class="ob-step ${s.done ? 'done' : ''}">
          <span class="ob-check">${s.done ? icon('check') : String(s.n)}</span>
          <span class="ob-label">${esc(s.label)}</span>
          ${s.done ? '' : `<button class="btn tiny" data-ob="${s.n}">${esc(s.actLabel)}</button>`}
        </div>`).join('')}`;
    host.classList.remove('hidden');
    $('#btn-onboard-close').addEventListener('click', () => {
      localStorage.setItem('ah_onboard_done', '1');
      renderOnboarding();
    });
    $$('[data-ob]').forEach((b) => b.addEventListener('click', () => {
      const s = onboardSteps().find((x) => String(x.n) === b.dataset.ob);
      s?.act();
    }));
  }
  // ---------- pencarian global ----------
  // Kotak cari sidebar mencari di empat sumber sekaligus lewat /api/search.
  // Kueri < 2 huruf tidak dikirim ke server (terlalu banyak hasil) — yang
  // ditampilkan saat kosong adalah sesi terbaru, seperti sebelumnya.
  let searchSeq = 0;
  let searchTimer = null;
  const SEARCH_ICON = {
    task: svgIco('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'),
    note: svgIco('<path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/>'),
    project: FOLDER_SVG,
  };
  const searchGroup = (label, rows) => rows.length
    ? `<div class="search-group-label">${esc(label)}</div>${rows.join('')}` : '';

  function searchRow({ kind, id, title, sub, meta, active = false, titleAttr = '' }) {
    const ico = kind === 'thread' ? spark(active ? 'var(--accent)' : '#7d7d85') : SEARCH_ICON[kind];
    return `<div class="pick-row ${active ? 'active' : ''}" data-kind="${esc(kind)}" data-id="${esc(id)}" data-title="${esc(titleAttr)}">
      <span class="pick-ico">${ico}</span>
      <span class="pick-main"><b>${esc(title)}</b><small>${esc(sub || '')}</small></span>
      ${meta ? `<span class="r-time">${esc(meta)}</span>` : ''}
    </div>`;
  }

  function bindSearchRows() {
    $$('#search-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      setLayer(null);
      if (kind === 'thread') return openThread(id);
      if (kind === 'task') {
        taskFilter = 'all';
        taskProject = 'all';
        taskGlobal = true;
        taskSearch = row.dataset.title || '';
        const input = $('#task-search');
        if (input) input.value = taskSearch;
        return go('tasks');
      }
      if (kind === 'note') { go('notes'); return openNoteEditor(id); }
      if (kind === 'project') {
        const p = projectCache.find((x) => x.id === id);
        if (p) { setActiveProject(p); go('studio'); }
        return undefined;
      }
      return undefined;
    }));
  }

  function renderRecentSearch() {
    const host = $('#search-rows');
    if (!host) return;
    const list = threadCache.slice(0, 12);
    host.innerHTML = `<div class="search-group-label">Sesi terbaru</div>${list.map((t) => searchRow({
      kind: 'thread', id: t.id, title: t.title, sub: (t.preview || '').slice(0, 70),
      meta: t.running ? 'Working' : fmtWhen(t.updatedAt), active: curThread?.id === t.id,
    })).join('') || '<p class="muted small" style="padding:8px">Belum ada sesi.</p>'}`;
    bindSearchRows();
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    const host = $('#search-rows');
    if (!host) return;
    host.innerHTML = '<p class="muted small" style="padding:8px">Mencari…</p>';
    let r;
    try { r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=6`); }
    catch (e) {
      if (seq !== searchSeq) return;
      host.innerHTML = `<p class="muted small" style="padding:8px">${esc(e.message)}</p>`;
      return;
    }
    if (seq !== searchSeq) return; // kueri lebih baru sudah menang
    if (!r.total) {
      host.innerHTML = `<p class="muted small" style="padding:8px">Tidak ada yang cocok dengan “${esc(q)}”.</p>`;
      return;
    }
    const g = r.groups;
    const html = [
      searchGroup('Thread', (g.threads || []).map((t) => searchRow({
        kind: 'thread', id: t.id, title: t.title,
        sub: `${t.where} · ${t.snippet}`,
        meta: fmtWhen(t.updatedAt), active: curThread?.id === t.id,
      }))),
      searchGroup('Tugas', (g.tasks || []).map((t) => searchRow({
        kind: 'task', id: t.id, title: t.title,
        sub: `${TASK_LABELS[t.status] || t.status} · ${t.snippet}`,
        meta: fmtWhen(t.updatedAt), titleAttr: t.title,
      }))),
      searchGroup('Catatan', (g.notes || []).map((n) => searchRow({
        kind: 'note', id: n.id, title: n.title, sub: `${n.where} · ${n.snippet}`,
        meta: fmtWhen(n.updatedAt),
      }))),
      searchGroup('Proyek', (g.projects || []).map((p) => searchRow({
        kind: 'project', id: p.id, title: p.name, sub: p.snippet,
      }))),
    ].join('');
    host.innerHTML = html || '<p class="muted small" style="padding:8px">Tidak ada yang cocok.</p>';
    bindSearchRows();
  }

  function renderSearch({ immediate = false } = {}) {
    const host = $('#search-rows');
    if (!host) return;
    const q = ($('#search-input').value || '').trim();
    clearTimeout(searchTimer);
    if (q.length < 2) {
      searchSeq += 1; // batalkan hasil lama yang mungkin masih dalam perjalanan
      renderRecentSearch();
      return;
    }
    if (immediate) { runSearch(q); return; }
    searchTimer = setTimeout(() => runSearch(q), 220);
  }
  $('#sb-search-btn').addEventListener('click', () => {
    if (layer === 'search') setLayer(null);
    else { setLayer('search'); $('#search-input').value = ''; renderSearch(); positionPop('#search-pop', '#sb-search-btn'); }
  });
  $('#search-input').addEventListener('input', () => renderSearch());
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderSearch({ immediate: true }); }
  });
  $('#btn-filter-projects').addEventListener('click', () => {
    if (layer === 'search') setLayer(null);
    else { setLayer('search'); $('#search-input').value = ''; renderSearch(); positionPop('#search-pop', '#btn-filter-projects'); }
  });

  // ---------- palet perintah (Ctrl+K) ----------
  function paletteActions() {
    const nav = VIEWS.map((v) => ({
      label: `Buka ${v[0].toUpperCase() + v.slice(1)}`,
      hint: 'navigasi',
      run: () => go(v),
    }));
    return [
      { label: 'Chat baru', hint: 'Alt+N', run: () => $('#btn-new-chat').click() },
      ...nav,
      { label: 'Proyek baru', hint: 'folder sumber', run: () => openProjectEditor(null) },
      { label: 'Ganti folder / proyek', hint: 'pemilih proyek', run: () => { renderProjectPicker(); setLayer('project'); } },
      { label: 'Cari semua…', hint: 'thread · tugas · catatan · proyek', run: () => { setLayer('search'); $('#search-input').value = ''; renderSearch(); positionPop('#search-pop', '#sb-search-btn'); } },
      { label: 'Pilih model gateway', hint: 'katalog model', run: () => openModelPop() },
      { label: 'Export thread ini (.md)', hint: curThread ? curThread.title : 'belum ada thread', run: () => { if (curThread) window.open(`/api/threads/${curThread.id}/export`, '_blank'); } },
      { label: 'Hentikan run', hint: 'stop agent', run: () => stopRun() },
    ];
  }
  function renderPalette() {
    const host = $('#palette-rows');
    if (!host) return;
    const q = ($('#palette-input').value || '').toLowerCase();
    const actions = paletteActions().filter((a) => !q || a.label.toLowerCase().includes(q));
    host.innerHTML = actions.map((a, i) => `
      <div class="pick-row" data-pi="${i}">
        <span class="pick-main"><b>${esc(a.label)}</b><small>${esc(a.hint || '')}</small></span>
      </div>`).join('') || '<p class="muted small" style="padding:8px">Tidak ada perintah.</p>';
    $$('#palette-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      const a = actions[+row.dataset.pi];
      setLayer(null);
      a?.run();
    }));
  }
  $('#palette-input').addEventListener('input', renderPalette);

  // ---------- @ mention file/folder ----------
  let mentionTimer = null;
  async function renderMention(q) {
    const host = $('#mention-rows');
    if (!host) return;
    if (!activeCwd()) {
      host.innerHTML = '<p class="muted small" style="padding:8px">Pilih folder kerja dulu (chip folder di atas).</p>';
      return;
    }
    host.innerHTML = '<p class="muted small" style="padding:8px">Membaca folder…</p>';
    let rows = [];
    try {
      const r = await api(`/api/files?cwd=${encodeURIComponent(activeCwd())}&q=${encodeURIComponent(q || '')}`);
      rows = r.entries || [];
    } catch (e) {
      host.innerHTML = `<p class="muted small" style="padding:8px">${esc(e.message)}</p>`;
      return;
    }
    host.innerHTML = rows.map((f) => `
      <div class="pick-row" data-rel="${esc(f.rel)}" data-dir="${f.dir ? '1' : ''}">
        <span class="pick-ico">${f.dir ? FOLDER_SVG : svgIco('<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/>')}</span>
        <span class="pick-main"><b>${esc(f.name)}${f.dir ? '/' : ''}</b><small>${esc(f.rel)}</small></span>
      </div>`).join('') || '<p class="muted small" style="padding:8px">Tidak cocok.</p>';
    $$('#mention-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      const ta = $('#composer-input');
      const insert = `@${row.dataset.rel}${row.dataset.dir ? '/' : ''} `;
      ta.value = ta.value.replace(/@([^\s@]*)$/, insert);
      setLayer(null);
      ta.focus();
    }));
    positionPop('#mention-pop', '#composer');
  }
  $('#composer-input').addEventListener('input', (e) => {
    const ta = e.target;
    const m = ta.value.match(/@([^\s@]*)$/);
    clearTimeout(mentionTimer);
    if (m) {
      mentionTimer = setTimeout(() => {
        setLayer('mention');
        renderMention(m[1]);
      }, 180);
    } else if (layer === 'mention') setLayer(null);
  });
  $('#btn-resume').addEventListener('click', () => {
    const t = threadCache[0];
    if (t) openThread(t.id); else toast('Belum ada sesi tersimpan');
  });

  // ---------- prompt library: simpan & pakai ulang prompt ----------
  let promptCache = [];
  async function renderPrompts() {
    const host = $('#prompts-rows');
    if (!host) return;
    try { promptCache = await api('/api/prompts'); } catch { promptCache = []; }
    const ta = $('#composer-input');
    $('#btn-prompt-save').disabled = !(ta.value || '').trim();
    host.innerHTML = promptCache.map((p) => `
      <div class="pick-row" data-prompt="${esc(p.id)}">
        <span class="pick-ico">${icon('file')}</span>
        <span class="pick-main"><b>${esc(p.title)}</b><small>${esc(p.body.split('\n')[0].slice(0, 90))}</small></span>
        <button class="icon-btn pick-edit ${p.pinned ? 'on' : ''}" data-pin="${esc(p.id)}" title="${p.pinned ? 'Lepas pin' : 'Pin agar di atas'}">${icon('pin')}</button>
        <button class="icon-btn pick-edit" data-del="${esc(p.id)}" title="Hapus prompt">${icon('x')}</button>
      </div>`).join('') || '<p class="muted small" style="padding:8px">Belum ada prompt tersimpan. Tulis prompt di composer lalu simpan.</p>';
    $$('#prompts-rows .pick-row').forEach((row) => row.addEventListener('click', async (e) => {
      const pinId = e.target.closest('[data-pin]')?.dataset.pin;
      const delId = e.target.closest('[data-del]')?.dataset.del;
      if (pinId) {
        const p = promptCache.find((x) => x.id === pinId);
        if (p) await api(`/api/prompts/${pinId}`, { method: 'POST', body: JSON.stringify({ pinned: !p.pinned }) });
        renderPrompts();
        return;
      }
      if (delId) {
        await api(`/api/prompts/${delId}`, { method: 'DELETE' });
        renderPrompts();
        return;
      }
      const p = promptCache.find((x) => x.id === row.dataset.prompt);
      if (!p) return;
      const ta = $('#composer-input');
      // Variabel {{nama}} → dialog isi satu per satu; batal = sisipkan mentah.
      const vars = [...new Set([...p.body.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()))].filter(Boolean);
      let body = p.body;
      for (const v of vars) {
        const val = await askPrompt('Isi variabel "' + v + '" untuk prompt "' + (p.title || 'tanpa judul') + '"', '', { title: 'Variabel prompt' });
        if (val == null) { setLayer(null); ta.focus(); return; }
        body = body.split('{{' + v + '}}').join(val);
      }
      ta.value = body;
      setLayer(null);
      ta.focus();
    }));
  }
  $('#btn-prompts').addEventListener('click', () => {
    setLayer('prompts');
    renderPrompts();
    positionPop('#prompts-pop', '#btn-prompts');
  });
  $('#btn-prompt-save').addEventListener('click', async () => {
    const ta = $('#composer-input');
    const body = (ta.value || '').trim();
    if (!body) return;
    try {
      await api('/api/prompts', { method: 'POST', body: JSON.stringify({ title: ($('#prompt-save-title').value || '').trim(), body }) });
      $('#prompt-save-title').value = '';
      toast('Prompt tersimpan');
      renderPrompts();
    } catch (e) { toast(e.message); }
  });

  // ---------- voice input (dikte) ----------
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec) $('#btn-voice').classList.remove('hidden');
  let recognition = null;
  let voiceBase = '';
  $('#btn-voice').addEventListener('click', () => {
    if (!SpeechRec) return;
    if (recognition) { recognition.stop(); return; }
    recognition = new SpeechRec();
    recognition.lang = 'id-ID';
    recognition.interimResults = true;
    const ta = $('#composer-input');
    voiceBase = ta.value ? `${ta.value.replace(/\s+$/, '')} ` : '';
    recognition.onresult = (e) => {
      let finalTxt = '';
      let interim = '';
      for (const res of e.results) {
        if (res.isFinal) finalTxt += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (finalTxt) voiceBase = `${voiceBase}${finalTxt} `.replace(/\s+/g, ' ');
      ta.value = `${voiceBase}${interim}`.trimEnd();
    };
    recognition.onend = () => {
      recognition = null;
      $('#btn-voice').classList.remove('listening');
    };
    recognition.onerror = (e) => {
      toast(e.error === 'not-allowed' ? 'Izin mikrofon ditolak browser' : `Dikte gagal: ${e.error}`);
    };
    $('#btn-voice').classList.add('listening');
    try { recognition.start(); } catch { recognition = null; $('#btn-voice').classList.remove('listening'); }
  });

  // ---------- pemilih proyek & editor ----------
  function renderProjectPicker() {
    const host = $('#project-rows');
    if (!host) return;
    const q = ($('#project-search').value || '').toLowerCase();
    const matched = projectCache.filter((p) => !q
      || p.name.toLowerCase().includes(q)
      || p.folders.some((f) => f.toLowerCase().includes(q)));
    const pcIco = svgIco('<rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M9 21h6M12 17v4"/>');
    const rows = [{ pick: '', label: 'This PC', sub: cwd || 'Tanpa proyek — folder kerja bebas', check: !activeProject, ico: pcIco, free: true }]
      .concat(matched.map((p) => ({
        pick: p.id, label: p.name, sub: p.primaryFolder, check: activeProject?.id === p.id, ico: FOLDER_SVG, proj: p,
      })));
    host.innerHTML = rows.map((r) => `
      <div class="pick-row ${r.check ? 'active' : ''}" data-pick="${esc(r.pick)}">
        <span class="pick-ico">${r.ico}</span>
        <span class="pick-main"><b>${esc(r.label)}</b><small>${esc(r.sub || '')}</small></span>
        ${r.free ? `<button class="icon-btn pick-edit" data-cwd="1" title="Ganti folder kerja bebas">${icon('pencil')}</button>` : ''}
        ${r.proj ? `<button class="icon-btn pick-edit" data-edit="${esc(r.proj.id)}" title="Edit proyek">${icon('pencil')}</button>` : ''}
        ${r.check ? '<span class="pick-check">✓</span>' : ''}
      </div>`).join('') +
      `<div class="pick-row add" data-new="1">
        <span class="pick-ico">＋</span>
        <span class="pick-main"><b>Buat proyek baru</b><small>Pilih folder sumber untuk agent</small></span>
      </div>`;
    $$('#project-rows .pick-row').forEach((row) => row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-cwd]')) {
        const v = await askPrompt('Folder kerja untuk sesi tanpa proyek.', cwd || '', {
          title: 'Folder kerja bebas',
          placeholder: 'C:\\Users\\nama\\proyek',
          okLabel: 'Pakai folder',
          requireValue: false,
        });
        if (v == null) return;
        if (await setCwd(v)) setLayer(null);
        return;
      }
      if (e.target.closest('[data-edit]')) {
        const p = projectCache.find((x) => x.id === e.target.closest('[data-edit]').dataset.edit);
        if (p) openProjectEditor(p);
        return;
      }
      if (row.dataset.new) { openProjectEditor(null); return; }
      const p = projectCache.find((x) => x.id === row.dataset.pick);
      setActiveProject(p || null);
      setLayer(null);
    }));
  }
  $('#project-search').addEventListener('input', renderProjectPicker);

  function openProjectEditor(p) {
    editingProject = p || null;
    editFolders = p ? [...p.folders] : (cwd ? [cwd] : []);
    editPrimary = p ? p.primaryFolder : (editFolders[0] || '');
    $('#project-edit-title').textContent = p ? 'Edit proyek' : 'Proyek baru';
    $('#project-edit-name').value = p ? p.name : '';
    $('#project-edit-err').classList.add('hidden');
    $('#project-edit-delete').classList.toggle('hidden', !p);
    renderEditFolders();
    setLayer('projectEdit');
    setTimeout(() => $('#project-edit-name').focus(), 50);
  }

  function renderEditFolders() {
    $('#project-edit-folders').innerHTML = editFolders.map((f, i) => `
      <div class="folder-row">
        <span class="pick-ico">${FOLDER_SVG}</span>
        <span class="pick-main"><b>${esc(f)}</b></span>
        ${f === editPrimary ? '<span class="chip">Primary</span>' : ''}
        <button class="icon-btn" data-primary="${i}" title="Jadikan folder utama">${icon('star')}</button>
        <button class="icon-btn" data-remove="${i}" title="Hapus dari daftar">✕</button>
      </div>`).join('');
    $$('#project-edit-folders [data-remove]').forEach((btn) => btn.addEventListener('click', () => {
      editFolders.splice(+btn.dataset.remove, 1);
      if (editPrimary && !editFolders.includes(editPrimary)) editPrimary = editFolders[0] || '';
      renderEditFolders();
    }));
    $$('#project-edit-folders [data-primary]').forEach((btn) => btn.addEventListener('click', () => {
      editPrimary = editFolders[+btn.dataset.primary] || '';
      renderEditFolders();
    }));
  }
  $('#project-add-folder').addEventListener('click', async () => {
    const v = await askPrompt('Path absolut folder proyek yang ada di komputer ini.', '', {
      title: 'Tambah folder',
      placeholder: 'C:\\Users\\nama\\proyek',
      okLabel: 'Tambah',
    });
    if (!v || !v.trim()) return;
    const resolved = v.trim().replace(/\//g, '\\');
    if (editFolders.some((f) => f.toLowerCase() === resolved.toLowerCase())) return toast('Folder sudah ada di daftar');
    editFolders.push(resolved);
    if (!editPrimary) editPrimary = resolved;
    renderEditFolders();
  });
  const editErr = (msg) => { const el = $('#project-edit-err'); el.textContent = msg; el.classList.remove('hidden'); };
  $('#project-edit-save').addEventListener('click', async () => {
    const name = $('#project-edit-name').value.trim();
    if (!name) return editErr('Nama proyek wajib diisi');
    if (!editFolders.length) return editErr('Minimal satu folder sumber');
    const body = { name, folders: editFolders, primaryFolder: editPrimary || editFolders[0] };
    const btn = $('#project-edit-save');
    btn.disabled = true;
    try {
      const saved = editingProject
        ? await api(`/api/projects/${editingProject.id}`, { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
      projectCache = await api('/api/projects');
      const wasNew = !editingProject;
      editingProject = null;
      setLayer(null);
      setActiveProject(saved);
      toast(wasNew ? 'Proyek dibuat' : 'Proyek disimpan');
    } catch (e) { editErr(e.message); }
    finally { btn.disabled = false; }
  });
  $('#project-edit-delete').addEventListener('click', async () => {
    if (!editingProject) return;
    const ok = await askConfirm(`Hapus proyek "${editingProject.name}"? Folder & tugas tidak ikut terhapus.`, {
      title: 'Hapus proyek?',
      okLabel: 'Hapus proyek',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${editingProject.id}`, { method: 'DELETE' });
      projectCache = await api('/api/projects');
      const wasActive = activeProject?.id === editingProject.id;
      editingProject = null;
      setLayer(null);
      if (wasActive) setActiveProject(null);
      renderSidebar();
      toast('Proyek dihapus');
    } catch (e) { toast('Gagal: ' + e.message); }
  });
  $('#project-edit-cancel').addEventListener('click', () => setLayer(null));
  $('#btn-project-edit-close').addEventListener('click', () => setLayer(null));

  // ---------- katalog model gateway ----------
  // Model dengan key tersimpan langsung aktif tanpa membuka situs provider.
  async function openModelPop() {
    setLayer('models');
    $('#model-search').value = '';
    renderModelRows();
    positionPop('#model-pop', '#engine-chip');
    try { modelChoices = (await api('/api/models')).models; } catch { modelChoices = []; }
    renderModelRows();
    positionPop('#model-pop', '#engine-chip');
  }
  // Favorit & terakhir dipakai (ala pemilih model Kybern) — disimpan lokal.
  const modelFavs = () => { try { return JSON.parse(localStorage.getItem('ah_model_favs') || '[]'); } catch { return []; } };
  const modelRecents = () => { try { return JSON.parse(localStorage.getItem('ah_model_recent') || '[]'); } catch { return []; } };
  function toggleModelFav(modelId) {
    const favs = modelFavs();
    const i = favs.indexOf(modelId);
    if (i >= 0) favs.splice(i, 1);
    else favs.unshift(modelId);
    localStorage.setItem('ah_model_favs', JSON.stringify(favs.slice(0, 20)));
  }
  function pushModelRecent(modelId) {
    if (!modelId || modelId === 'auto') return;
    const recents = modelRecents().filter((m) => m !== modelId);
    recents.unshift(modelId);
    localStorage.setItem('ah_model_recent', JSON.stringify(recents.slice(0, 5)));
  }
  function renderModelRows() {
    const host = $('#model-rows');
    if (!host) return;
    const q = ($('#model-search').value || '').toLowerCase();
    const all = modelChoices
      .filter((m) => !q || (m.label + ' ' + m.id).toLowerCase().includes(q))
      .slice(0, 60);
    const favs = modelFavs();
    const recents = modelRecents();
    const byModel = new Map(all.map((m) => [m.model, m]));
    const favList = favs.map((id) => byModel.get(id)).filter(Boolean).slice(0, 6);
    const recentList = modelRecents().map((id) => byModel.get(id)).filter(Boolean).filter((m) => !favList.includes(m)).slice(0, 5);
    const main = all.filter((m) => !favList.includes(m) && !recentList.includes(m));
    const row = (m) => `
      <div class="pick-row ${selectedModel === m.model ? 'active' : ''}"
        data-model="${esc(m.model)}" data-preset="${esc(m.preset || '')}" data-key="${esc(m.keyId || '')}"
        title="${esc(m.reason || '')}">
        <span class="pick-ico">${m.available ? icon('spark') : icon('lock')}</span>
        <span class="pick-main"><b>${esc(m.label)}</b><small>${esc(m.reason || '')}</small></span>
        <button class="pick-fav ${favs.includes(m.model) ? 'on' : ''}" data-fav="${esc(m.model)}" title="${favs.includes(m.model) ? 'Hapus dari favorit' : 'Favoritkan'}">${icon('star')}</button>
        ${selectedModel === m.model ? '<span class="pick-check">✓</span>' : ''}
      </div>`;
    host.innerHTML =
      (favList.length ? `<div class="intg-label">Favorit</div>` + favList.map(row).join('') : '') +
      (recentList.length ? `<div class="intg-label">Terakhir dipakai</div>` + recentList.map(row).join('') : '') +
      `<div class="intg-label">Semua model</div>` +
      (main.map(row).join('') || '<p class="muted small" style="padding:8px">Tidak ada model.</p>');
    $$('#model-rows .pick-row').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-fav]')) {
        toggleModelFav(row.dataset.model);
        renderModelRows();
        return;
      }
      pickModel({ model: row.dataset.model, preset: row.dataset.preset, keyId: row.dataset.key || undefined });
    }));
  }
  async function pickModel({ model, preset, keyId }) {
    if (model === 'auto') {
      selectedModel = 'auto';
      localStorage.setItem('ah_model', 'auto');
      $('#chat-model').value = '';
      setLayer(null);
      applyEngine();
      return;
    }
    try {
      await api('/api/models/activate', { method: 'POST', body: JSON.stringify({ preset, model, keyId }) });
      selectedModel = model;
      localStorage.setItem('ah_model', model);
      pushModelRecent(model);
      $('#chat-model').value = model;
      // memilih model = ingin memakainya: engine langsung pindah ke Gateway
      currentEngine = 'pool';
      localStorage.setItem('ah_engine', 'pool');
      toast('Model aktif di pool — engine pindah ke Gateway');
      setLayer(null);
      await renderEngines(true);
      await loadState({ silent: true });
    } catch (e) {
      if (e.status === 409 || e.status === 404) {
        // belum ada key provider itu → alur tempel key (satu kali, lalu aktif otomatis)
        openAdopt(model, preset, model);
      } else toast('Gagal: ' + e.message);
    }
  }
  $('#model-search').addEventListener('input', renderModelRows);

  // ---------- effort ----------
  // 'default' = ikuti aturan engine (tidak mengirim flag). Server hanya
  // menerima low/medium/high, jadi 'default' dikirim sebagai undefined.
  const EFFORT_OPTS = [
    ['default', 'Default'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ];
  const effortLabel = (v) => (EFFORT_OPTS.find(([k]) => k === v) || EFFORT_OPTS[0])[1];

  function renderEffortRows() {
    $('#effort-rows').innerHTML = EFFORT_OPTS.map(([v, l]) => `
      <div class="pick-row ${effort === v ? 'active' : ''}" data-effort="${v}">
        <span class="pick-main"><b>${l}</b></span>
        ${effort === v ? '<span class="pick-check">✓</span>' : ''}
      </div>`).join('');
    $$('#effort-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      effort = row.dataset.effort;
      localStorage.setItem('ah_effort', effort);
      $('#effort-label').textContent = effortLabel(effort);
      setLayer(null);
    }));
  }
  $('#effort-chip').addEventListener('click', () => {
    if (layer === 'effort') setLayer(null);
    else { renderEffortRows(); setLayer('effort'); positionPop('#effort-pop', '#effort-chip'); }
  });
  $('#effort-label').textContent = effortLabel(effort);

  // ---------- mode izin (chip Full access) ----------
  // 4 tingkat ala aplikasi agent populer; flag CLI-nya dipetakan di harness.
  const PERMISSION_LABELS = { ask: 'Minta persetujuan', edits: 'Setujui edit', plan: 'Plan mode', full: 'Full access' };
  function renderAccessMenu() {
    const opts = [
      ['ask', 'Minta persetujuan', 'Selalu tanya sebelum mengedit berkas atau menjalankan perintah'],
      ['edits', 'Setujui edit', 'Edit berkas bebas; perintah tetap dikonfirmasi'],
      ['plan', 'Plan mode', 'Baca & rencana saja — Claude/Codex/Gemini masuk mode baca'],
      ['full', 'Full access', 'Akses tanpa batas ke internet dan berkas komputer Anda'],
    ];
    $('#access-rows').innerHTML = opts.map(([v, l, d]) => `
      <div class="pick-row ${permission === v ? 'active' : ''}" data-perm="${v}">
        <span class="pick-main"><b>${l}</b><small>${d}</small></span>
        ${permission === v ? '<span class="pick-check">✓</span>' : ''}
      </div>`).join('');
    $$('#access-rows .pick-row').forEach((row) => row.addEventListener('click', () => {
      permission = row.dataset.perm;
      localStorage.setItem('ah_permission', permission);
      $('#access-label').textContent = PERMISSION_LABELS[permission] || 'Full access';
      setLayer(null);
    }));
  }
  $('#access-chip').addEventListener('click', () => {
    if (layer === 'access') setLayer(null);
    else { renderAccessMenu(); setLayer('access'); positionPop('#access-pop', '#access-chip'); }
  });
  $('#access-label').textContent = PERMISSION_LABELS[permission] || 'Full access';

  // ---------- info git (chip branch) ----------
  async function renderGitMenu() {
    const host = $('#git-rows');
    if (!host) return;
    const q = activeProject ? `projectId=${encodeURIComponent(activeProject.id)}` : `cwd=${encodeURIComponent(cwd || '')}`;
    let c = { branch: null, cwd: activeProject?.primaryFolder || cwd || '', changes: null };
    try { c = await api(`/api/context?${q}`); } catch { /* tampilkan apa adanya */ }
    host.innerHTML = `
      <div class="git-row"><span>Branch</span><b>${esc(c.branch || 'bukan repo git')}</b></div>
      <div class="git-row"><span>Perubahan</span><b>${c.changes === null || c.changes === undefined ? '—' : `${c.changes} file`}</b></div>
      <div class="git-row"><span>Folder</span><b class="git-path" title="${esc(c.cwd || '')}">${esc(c.cwd || '—')}</b></div>`;
    positionPop('#git-pop', '#composer-branch');
  }
  $('#composer-branch').addEventListener('click', () => {
    if (layer === 'git') setLayer(null);
    else { setLayer('git'); renderGitMenu(); }
  });
  $('#git-open-projects').addEventListener('click', () => { setLayer(null); renderProjectPicker(); setLayer('project'); });

  // ---------- drawer Perubahan (workspace thread) ----------
  // Satu thread = satu folder kerja. Drawer menampilkan apa yang benar-benar
  // berubah di folder itu (git status/diff) dan hanya mengubah file saat user
  // menekan tombol revert — tidak ada "auto-undo" diam-diam setelah run.
  const STATUS_MARK = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!' };
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

  function setChanges(open) {
    changesOpen = !!open;
    const el = $('#changes-drawer');
    if (el) {
      el.classList.toggle('hidden', !changesOpen);
      el.setAttribute('aria-hidden', changesOpen ? 'false' : 'true');
    }
    if (changesOpen) { renderWorkspace(); refreshWorkspace(); refreshDiff(); }
  }

  function updateChangesButton() {
    const btn = $('#btn-changes');
    if (!btn) return;
    btn.classList.toggle('hidden', !curThread);
    const n = workspaceInfo?.repo ? workspaceInfo.changes : 0;
    const badge = $('#changes-count');
    if (badge) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.classList.toggle('hidden', n === 0);
    }
    btn.title = !curThread ? 'Perubahan'
      : workspaceInfo?.repo ? `${n} perubahan di ${baseName(workspaceInfo.cwd)}`
      : 'Bukan repo git — aturan proyek tetap bisa disimpan';
  }

  async function refreshWorkspace() {
    if (!curThread) { workspaceInfo = null; diffInfo = null; updateChangesButton(); return; }
    try { workspaceInfo = await api(`/api/threads/${curThread.id}/workspace`); }
    catch { workspaceInfo = null; }
    updateChangesButton();
    if (changesOpen) { renderWorkspace(); renderRules(); }
  }

  function renderWorkspace() {
    const host = $('#cd-workspace');
    const br = $('#cd-branch');
    if (!host) return;
    if (!curThread) { host.innerHTML = '<span class="muted">Buka thread dulu.</span>'; br.classList.add('hidden'); return; }
    if (!workspaceInfo) { host.innerHTML = '<span class="muted">Membaca workspace…</span>'; br.classList.add('hidden'); return; }
    if (!workspaceInfo.cwd) {
      host.innerHTML = '<span class="muted">Belum ada folder kerja.</span> <button class="link-btn" id="cd-pick">Pilih proyek</button>';
      $('#cd-pick')?.addEventListener('click', (e) => {
        e.stopPropagation();
        renderProjectPicker();
        setLayer('project');
      });
      br.classList.add('hidden');
      return;
    }
    host.innerHTML = `<div class="cd-path-line" title="${esc(workspaceInfo.cwd)}"><b>${esc(baseName(workspaceInfo.cwd))}</b> <span class="muted">${esc(workspaceInfo.cwd)}</span></div>`;
    br.classList.toggle('hidden', !workspaceInfo.branch);
    if (workspaceInfo.branch) br.textContent = workspaceInfo.branch;
  }

  function colorPatch(text) {
    return String(text || '').split('\n').map((line) => {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del'
        : line.startsWith('@@') ? 'hunk' : '';
      return `<span${cls ? ` class="${cls}"` : ''}>${esc(line)}</span>`;
    }).join('\n');
  }

  async function refreshDiff() {
    if (!curThread) { diffInfo = null; renderDiff(); return; }
    try { diffInfo = await api(`/api/threads/${curThread.id}/diff`); }
    catch (e) { diffInfo = { error: e.message }; }
    renderDiff();
  }

  function renderDiff() {
    const host = $('#cd-files');
    if (!host) return;
    if (!diffInfo) { host.innerHTML = '<p class="cd-empty">Memuat perubahan…</p>'; return; }
    if (diffInfo.error) { host.innerHTML = `<p class="cd-empty">${esc(diffInfo.error)}</p>`; return; }
    if (!diffInfo.cwd) { host.innerHTML = '<p class="cd-empty">Pilih folder kerja untuk melihat perubahan.</p>'; return; }
    if (!diffInfo.repo) {
      host.innerHTML = '<p class="cd-empty">Folder ini bukan repo git. Revert otomatis tidak tersedia, tetapi aturan proyek tetap bisa disimpan.</p>';
      return;
    }
    if (!diffInfo.files?.length) { host.innerHTML = '<p class="cd-empty">Tidak ada perubahan. Workspace bersih.</p>'; return; }

    const rows = diffInfo.files.map((f) => {
      const mark = STATUS_MARK[f.status] || 'M';
      const stat = f.added == null && f.removed == null ? ''
        : `<span class="cd-add">+${f.added ?? 0}</span> <span class="cd-del">−${f.removed ?? 0}</span>`;
      return `<div class="cd-file" data-path="${esc(f.path)}">
        <div class="cd-file-head">
          <span class="cd-status ${esc(f.status)}" title="${esc(f.status)}">${mark}</span>
          <span class="cd-path" title="${esc(f.path)}">${esc(f.path)}</span>
          <span class="cd-stat">${stat}</span>
          <span class="cd-actions">
            ${f.status === 'untracked' ? `<button class="icon-btn" data-del="${esc(f.path)}" title="Hapus file baru">${icon('x')}</button>` : ''}
            ${f.revertable && f.status !== 'untracked' ? `<button class="icon-btn" data-revert="${esc(f.path)}" title="Kembalikan ke HEAD">${icon('refresh')}</button>` : ''}
          </span>
        </div>
      </div>`;
    }).join('');

    const patchBlock = diffInfo.patch
      ? `<details class="cd-patch-wrap"><summary>Patch lengkap${diffInfo.truncated ? ' (dipotong)' : ''}</summary><pre class="cd-patch">${colorPatch(diffInfo.patch)}</pre></details>`
      : '';
    host.innerHTML = rows + patchBlock;

    $$('#cd-files [data-revert]').forEach((b) => b.addEventListener('click', () => revertFile(b.dataset.revert, false)));
    $$('#cd-files [data-del]').forEach((b) => b.addEventListener('click', () => revertFile(b.dataset.del, true)));
  }

  async function revertFile(path, deleteUntracked) {
    if (!curThread) return;
    const msg = deleteUntracked
      ? `Hapus file baru "${path}"? Tindakan ini permanen.`
      : `Kembalikan "${path}" ke kondisi HEAD? Perubahan pada file ini akan hilang.`;
    const ok = await askConfirm(msg, {
      title: deleteUntracked ? 'Hapus file?' : 'Kembalikan file?',
      okLabel: deleteUntracked ? 'Hapus file' : 'Kembalikan',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/api/threads/${curThread.id}/revert`, {
        method: 'POST',
        body: JSON.stringify({ paths: [path], deleteUntracked }),
      });
      const done = (r.reverted?.length || 0) + (r.deleted?.length || 0);
      toast(done ? `Dikembalikan: ${path}` : (r.skipped?.[0]?.reason || 'Tidak ada yang diubah'));
      await refreshWorkspace();
      await refreshDiff();
    } catch (e) { toast('Gagal: ' + e.message); }
  }

  function renderRules() {
    const sel = $('#cd-rule-file');
    if (!sel) return;
    if (!sel.options.length) {
      sel.innerHTML = RULE_FILES.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    }
    const rules = workspaceInfo?.rules || [];
    const file = sel.value || RULE_FILES[0];
    const found = rules.find((r) => r.file === file);
    const ta = $('#cd-rule-text');
    if (ta) ta.value = found?.content || '';
    const status = $('#cd-rule-status');
    if (status) {
      status.textContent = !workspaceInfo?.cwd ? 'Pilih folder kerja dulu'
        : found ? `${found.bytes} byte${found.truncated ? ' (dipotong)' : ''}` : 'belum ada — akan dibuat';
    }
    const save = $('#cd-rule-save');
    if (save) save.disabled = !workspaceInfo?.cwd;
  }

  $('#btn-changes').addEventListener('click', () => setChanges(!changesOpen));
  $('#cd-close').addEventListener('click', () => setChanges(false));
  $('#cd-refresh').addEventListener('click', async () => {
    await refreshWorkspace();
    await refreshDiff();
  });
  $('#cd-rule-file').addEventListener('change', renderRules);
  $('#cd-rules').addEventListener('toggle', () => { if ($('#cd-rules').open) renderRules(); });
  $('#cd-rule-save').addEventListener('click', async () => {
    if (!curThread || !workspaceInfo?.cwd) return toast('Pilih folder kerja dulu');
    const btn = $('#cd-rule-save');
    btn.disabled = true;
    try {
      const r = await api(`/api/threads/${curThread.id}/rules`, {
        method: 'POST',
        body: JSON.stringify({ file: $('#cd-rule-file').value, content: $('#cd-rule-text').value }),
      });
      workspaceInfo.rules = r.rules || [];
      renderRules();
      toast('Aturan proyek disimpan');
    } catch (e) { toast('Gagal: ' + e.message); }
    finally { btn.disabled = false; }
  });

  // ---------- menu ruang kerja (judul AgentHub) ----------
  $('#sb-menu-btn').addEventListener('click', () => {
    if (layer === 'sbMenu') setLayer(null);
    else { setLayer('sbMenu'); positionPop('#sb-menu-pop', '#sb-menu-btn'); }
  });
  $('#sbm-projects').addEventListener('click', () => { setLayer(null); renderProjectPicker(); setLayer('project'); });
  $('#sbm-new-project').addEventListener('click', () => { setLayer(null); openProjectEditor(null); });
  $('#sbm-usage').addEventListener('click', () => { setLayer(null); $('#rail-usage').click(); });
  $('#sbm-gateway').addEventListener('click', () => { setLayer(null); go('gateway'); });
  $('#sbm-settings').addEventListener('click', () => { setLayer(null); go('settings'); });
  $('#sbm-schedules').addEventListener('click', () => { setLayer(null); go('settings'); activateSettingsPane('schedules'); });

  async function openThread(id) {
    try {
      curThread = await api(`/api/threads/${id}`);
      // Thread lama tanpa workspace mewarisi folder aktif sekali, supaya drawer
      // dan run berikutnya tidak diam-diam jatuh ke home directory.
      if (!curThread.cwd && activeCwd()) {
        curThread = await api(`/api/threads/${id}`, {
          method: 'POST', body: JSON.stringify({ cwd: activeCwd() }),
        }).catch(() => curThread);
      }
      if (!runActive()) syncRunFromThread(curThread);
      view = 'studio';
      $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-studio'));
      $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === 'studio'));
      sidebarOpen = window.innerWidth > 900;
      applySidebar();
      syncRoute('studio', curThread.id);
      renderSidebar();
      placeComposer();
      renderChat();
      await refreshWorkspace();
      if (changesOpen) await refreshDiff();
    } catch (e) { toast('Gagal: ' + e.message); }
  }

  $('#btn-new-chat').addEventListener('click', async () => {
    try {
      const t = await api('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ engine: currentEngine, projectId: activeProject?.id, cwd: activeCwd() }),
      });
      curThread = t;
      placeComposer();
      renderChat();
      renderSidebar();
      await refreshWorkspace();
      $('#composer-input').focus();
    } catch (e) { toast('Gagal: ' + e.message); }
  });

  // ---------- composer placement ----------
  function placeComposer() {
    const empty = !curThread || !curThread.messages?.length;
    const slot = empty ? $('#hero-composer-slot') : $('#bottom-composer-slot');
    const c = $('#composer');
    if (c.parentElement !== slot) slot.appendChild(c);
    const hide = (sel, on) => { const el = $(sel); if (el) el.classList.toggle('hidden', on); };
    hide('#chat-empty', !empty);
    hide('#chat-messages', empty);
    hide('#hero-continue', !empty);
    hide('#btn-chat-del', !curThread);
    hide('#btn-session-info', !curThread);
    const top = $('#chat-top');
    if (top) top.classList.toggle('ghost-top', empty);
  }

  $('#btn-chat-del').addEventListener('click', async () => {
    if (!curThread) return;
    const ok = await askConfirm('Hapus thread ini?', {
      title: 'Hapus thread?',
      okLabel: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/threads/${curThread.id}`, { method: 'DELETE' });
    curThread = null;
    setChanges(false);
    workspaceInfo = null;
    diffInfo = null;
    updateChangesButton();
    renderSidebar();
    placeComposer();
    renderChat();
  });

  // ---------- lampiran (file/gambar) ----------
  const ATTACH_SVG = svgIco('<path d="M8.5 12.5l6.2-6.2a3 3 0 0 1 4.2 4.2l-7.6 7.6a5 5 0 0 1-7.1-7.1l7-7"/><path d="M6.5 17.5l7.2-7.2"/>');
  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);
  const isImageAttachment = (a) => String(a?.type || '').startsWith('image/');

  // Satu URL blob per lampiran, dipakai ulang oleh chip composer dan pesan.
  // Fetch memakai header Authorization; <img src="/api/uploads/..."> tidak bisa.
  function attachmentUrl(id) {
    if (attachObjectUrls.has(id)) return attachObjectUrls.get(id);
    const p = (async () => {
      const r = await fetch(`/api/uploads/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return URL.createObjectURL(await r.blob());
    })();
    attachObjectUrls.set(id, p);
    p.catch(() => attachObjectUrls.delete(id));
    return p;
  }

  function attachmentsHtml(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return `<div class="msg-attachments">${list.map((a) => `
      <span class="msg-attach" data-attach-open="${esc(a.id)}" data-attach-name="${esc(a.name)}" data-attach-type="${esc(a.type)}" title="Buka ${esc(a.name)}">
        ${isImageAttachment(a) ? `<img data-attach-id="${esc(a.id)}" alt="">` : `<span class="pick-ico">${ATTACH_SVG}</span>`}
        <span class="attach-name">${esc(a.name)}</span>
        <span class="attach-size">${esc(fmtBytes(a.bytes))}</span>
      </span>`).join('')}</div>`;
  }

  async function hydrateAttachments() {
    $$('#chat-messages img[data-attach-id], #composer-attachments img[data-chip-id]').forEach(async (img) => {
      const id = img.dataset.attachId || img.dataset.chipId;
      try {
        const url = await attachmentUrl(id);
        if (img.isConnected) img.src = url;
      } catch { img.remove(); }
    });
  }

  function renderComposerAttachments() {
    const host = $('#composer-attachments');
    if (!host) return;
    host.classList.toggle('hidden', pendingAttachments.length === 0);
    host.innerHTML = pendingAttachments.map((a) => `
      <span class="attach-chip">
        ${isImageAttachment(a) ? `<img data-chip-id="${esc(a.id)}" alt="">` : ATTACH_SVG}
        <span class="attach-name">${esc(a.name)}</span>
        <span class="attach-size">${esc(fmtBytes(a.bytes))}</span>
        <button class="icon-btn" data-attach-remove="${esc(a.id)}" title="Hapus lampiran">${icon('x')}</button>
      </span>`).join('');
    hydrateAttachments();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('Gagal membaca file'));
      reader.readAsDataURL(file);
    });
  }

  async function addAttachments(files) {
    const list = [...files];
    if (!list.length) return;
    if (pendingAttachments.length + list.length > MAX_ATTACH_CLIENT) {
      return toast(`Maksimal ${MAX_ATTACH_CLIENT} lampiran per pesan`);
    }
    for (const file of list) {
      if (file.size > 8 * 1024 * 1024) { toast(`${file.name} lebih dari 8 MB`); continue; }
      try {
        const data = await fileToBase64(file);
        const meta = await api('/api/uploads', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, type: file.type, data }),
        });
        pendingAttachments.push(meta);
        renderComposerAttachments();
      } catch (e) { toast(`Gagal melampirkan ${file.name}: ${e.message}`); }
    }
  }

  $('#btn-attach').addEventListener('click', () => $('#attach-input').click());
  $('#attach-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addAttachments(files);
  });
  const composerEl = $('#composer');
  composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drag'); });
  composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drag'));
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    composerEl.classList.remove('drag');
    addAttachments(e.dataTransfer?.files || []);
  });
  $('#composer-input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addAttachments(files);
  });

  // Klik chip lampiran: gambar dibuka, file lain diunduh. Memakai URL blob yang
  // sudah terautentikasi — tidak pernah menaruh token di URL.
  document.addEventListener('click', async (e) => {
    const remove = e.target.closest('[data-attach-remove]');
    if (remove) {
      const id = remove.dataset.attachRemove;
      pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
      renderComposerAttachments();
      api(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => { /* sudah hilang */ });
      return;
    }
    const chip = e.target.closest('[data-attach-open]');
    if (!chip) return;
    try {
      const url = await attachmentUrl(chip.dataset.attachOpen);
      if (isImageAttachment({ type: chip.dataset.attachType })) {
        window.open(url, '_blank', 'noopener');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = chip.dataset.attachName || 'lampiran';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch { toast('Lampiran tidak bisa dibuka'); }
  });

  // ---------- render chat ----------
  // preserveStream: jangan sentuh DOM pesan saat stream sedang menulis ke sana
  // (SSE `threads` bisa datang di tengah run; render ulang akan menghapus kursor
  // dan teks yang sedang tumbuh).
  function renderChat({ preserveStream = false } = {}) {
    const empty = !curThread || !curThread.messages?.length;
    $('#chat-title').textContent = curThread ? curThread.title : '';
    const badge = $('#chat-engine-badge');
    badge.classList.toggle('hidden', !curThread);
    if (curThread) badge.innerHTML = `${icon(curThread.engine)}<span>${esc(engineLabel(curThread.engine))}</span>`;
    $('#chat-running').classList.toggle('hidden', !(curThread?.running || runActive()));
    $('#btn-stop').classList.toggle('hidden', !(curThread?.running || runActive()));
    placeComposer();
    if (empty) return;
    if (preserveStream) return;

    const msgs = curThread.messages.filter((m) => m.role !== 'system');
    let html = '';
    let lastDay = '';
    let subruns = null;

    const flushSubruns = () => {
      if (!subruns || !subruns.length) return;
      const working = subruns.filter((s) => (s.status || STEP_MACHINE.initial) === 'working').length;
      const maxMs = Math.max(0, ...subruns.map((s) => s.ms || 0));
      const rows = subruns.map((s) => {
        const st = s.status || STEP_MACHINE.initial;
        const stat = st === 'done' ? `${Math.round((s.ms || 0) / 100) / 10}s Done`
          : st === 'error' ? 'Failed'
          : st === 'stopped' ? 'Dihentikan'
          : `${Math.max(1, Math.round((Date.now() - (s.ts || Date.now())) / 1000))}s Working`;
        const meta = `${st === 'error' ? 'Error' : st === 'stopped' ? 'Dihentikan' : 'Review'} · ${esc(s.engine)} · ${esc(cwdBase())}`;
        const body = st === 'working' ? '' : `<div class="deleg-out">${esc((s.content || '').slice(0, 4000))}</div>`;
        return `<details class="deleg-row"><summary>
          <span class="d-ico" style="background:${projectColor(s.engine)}">${icon(s.engine)}</span>
          <span class="d-main"><b>${esc(engineLabel(s.engine))}</b><span class="deleg-sub">${meta}</span></span>
          <span class="d-stat">${esc(stat)} ›</span></summary>${body}</details>`;
      }).join('');
      html += `<div class="msg assistant"><div class="deleg-card">
        <div class="deleg-head"><span class="r-ico" style="color:#8d8d94">${svgIco('<circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="17" cy="9" r="2.2"/><path d="M16 14c2.6 0 4.5 1.6 4.5 4"/>')}</span><b>${subruns.length} delegated agent${subruns.length === 1 ? '' : 's'}</b> <span class="muted small">${subruns.length - working} done · ${working} working</span><span class="grow"></span><span class="caret">▾</span></div>
        ${rows}
      </div>
      ${maxMs ? `<div class="worked-row"><span class="r-ico" style="color:#8d8d94">${svgIco('<path d="M13 2.5 4.5 13.5H11l-1 8L18.5 10H12z"/>')}</span> Worked for ${Math.round(maxMs / 100) / 10}s <span class="grow"></span><span class="caret right">›</span></div>` : ''}
      </div>`;
      subruns = null;
    };

    const lastAssistant = [...msgs].reverse().find((x) => x.role === 'assistant');
    for (const m of msgs) {
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) { html += daySep(m.ts); lastDay = day; }
      if (m.role === 'user') { flushSubruns(); html += `<div class="msg user" data-mid="${m.id}"><div class="bubble">${esc(m.content)}${attachmentsHtml(m.attachments)}</div></div>`; continue; }
      if (m.subrun) { (subruns = subruns || []).push(m); continue; }
      flushSubruns();
      const canRegen = m === lastAssistant && !runActive() && msgs.some((x) => x.role === 'user');
      html += `<div class="msg assistant" data-mid="${m.id}">
        <div class="msg-body">${md(m.content || '')}</div>
        <div class="msg-foot">
          <span>${esc(engineLabel(m.engine))}</span>
          ${m.servedBy ? `<span class="mf-sep">·</span><span>via ${esc(m.servedBy)}</span>` : ''}
          ${m.tokens ? `<span class="mf-sep">·</span><span>${m.tokens >= 1000 ? Math.round(m.tokens / 100) / 10 + 'K' : m.tokens} tok</span>` : ''}
          ${m.ms ? `<span class="mf-sep">·</span><span>${Math.round(m.ms / 100) / 10}s</span>` : ''}
          <span class="mf-sep">·</span><span>${fmtClock(m.ts)}</span>
          <button class="icon-btn mf-act" data-copy-msg="${m.id}" title="Salin pesan">${icon('copy')}</button>
          ${canRegen ? `<button class="icon-btn mf-act" data-regen="${m.id}" title="Ulangi prompt terakhir">${icon('refresh')}</button>` : ''}
        </div>
      </div>`;
    }
    flushSubruns();
    $('#chat-messages').innerHTML = html;
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
    hydrateAttachments();
  }

  // ---------- streaming ----------
  function parseSSE(res, onEvent) {
    return new Promise((resolve, reject) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      reader.read().then(function pump({ done, value }) {
        if (done) return resolve();
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (line.startsWith('data: ')) {
            try { onEvent(JSON.parse(line.slice(6))); } catch { /* abaikan */ }
          }
        }
        reader.read().then(pump);
      }).catch(reject);
    });
  }

  // ---------- info sesi: statistik thread aktif ----------
  async function openSessionInfo() {
    if (!curThread) return;
    let s;
    try { s = await api(`/api/threads/${curThread.id}/stats`); } catch (e) { toast(e.message); return; }
    const row = (label, value) => `<div class="sk"><span>${esc(label)}</span><b>${value}</b></div>`;
    const dash = '<span class="muted">—</span>';
    const num = (v) => (v == null ? dash : esc(fmtNum(v)));
    const date = (ts) => (ts ? esc(new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) : dash);
    const engineLabels = { pool: 'Free tokens (Gateway)', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', echo: 'Echo' };
    // Blok konteks ala panel "Context windows": hanya muncul bila ada run pool
    // yang melaporkan usage nyata; tanpa itu tidak ada angka palsu.
    const ctx = s.context;
    const ctxPctOfLimit = (tokens) => (ctx?.limit ? ` (${Math.round((tokens / ctx.limit) * 1000) / 10}%)` : '');
    const ctxHtml = ctx ? `
      <div class="ctx-block">
        <div class="ctx-head"><span>Konteks</span><b>${fmtNum(ctx.input)}${ctx.limit ? ` / ${fmtNum(ctx.limit)}` : ''}${ctx.usagePct != null ? ` (${ctx.usagePct}%)` : ''}</b></div>
        <div class="ctx-bar"><i style="width:${Math.min(100, ctx.usagePct ?? 0)}%"></i></div>
        <div class="ctx-rows">
          ${row('Riwayat pesan (perkiraan)', num(ctx.historyTokens) + ctxPctOfLimit(ctx.historyTokens))}
          ${row('Prompt terakhir', num(ctx.promptTokens) + ctxPctOfLimit(ctx.promptTokens))}
          ${ctx.cacheHitRate != null ? row('Cache hit rate', `${esc(ctx.cacheHitRate)}%`) : ''}
        </div>
      </div>` : '';
    $('#session-kv').innerHTML = ctxHtml + [
      row('Sesi', esc(s.title || '—')),
      row('Engine', esc(engineLabels[s.engine] || s.engine || '—')),
      row('Model', s.model ? esc(s.model) : dash),
      row('Pesan', num(s.messages)),
      row('Pesan user', num(s.userMessages)),
      row('Pesan asisten', num(s.assistantMessages)),
      row('Total token', num(s.totalTokens)),
      row('Token input', num(s.inputTokens)),
      row('Token output', num(s.outputTokens)),
      row('Token reasoning', num(s.reasoningTokens)),
      row('Token cache (baca)', num(s.cachedTokens)),
      row('Dibuat', date(s.createdAt)),
      row('Aktivitas terakhir', date(s.updatedAt)),
    ].join('');
    setLayer('session');
    positionPop('#session-pop', '#btn-session-info');
  }
  $('#btn-session-info').addEventListener('click', () => {
    if (layer === 'session') setLayer(null);
    else openSessionInfo();
  });

  // ---------- perintah slash nyata ----------
  const SLASH_COMMANDS = '/new chat baru · /export unduh .md · /engine ganti engine · /model katalog model · /prompt prompt tersimpan · /save simpan prompt composer · /stats info sesi · /tasks /notes /promo /gateway /settings navigasi · /help daftar perintah';

  function handleSlash(cmd, arg) {
    switch (cmd) {
      case 'new': $('#btn-new-chat').click(); return true;
      case 'export': if (curThread) window.open(`/api/threads/${curThread.id}/export`, '_blank'); else toast('Belum ada thread untuk diekspor'); return true;
      case 'engine': setLayer('engines'); renderEngineMenu(); positionPop('#engine-pop', '#engine-chip'); return true;
      case 'model': if (currentEngine === 'pool') openModelPop(); else toast('Pilih engine Gateway dulu (/engine)'); return true;
      case 'prompt': setLayer('prompts'); renderPrompts(); positionPop('#prompts-pop', '#composer'); return true;
      case 'stats': openSessionInfo(); return true;
      case 'save': {
        const body = ($('#composer-input').value || '').trim();
        if (!body) { toast('Composer kosong — tidak ada yang bisa disimpan'); return true; }
        api('/api/prompts', { method: 'POST', body: JSON.stringify({ title: arg, body }) })
          .then(() => toast('Prompt tersimpan — /prompt untuk melihat'))
          .catch((e) => toast(e.message));
        return true;
      }
      case 'tasks': case 'notes': case 'promo': case 'gateway': case 'settings': go(cmd); return true;
      case 'help': toast(SLASH_COMMANDS, 6000); return true;
      default: return false;
    }
  }

  async function sendPrompt(directPrompt) {
    if (runActive()) return;
    const typed = $('#composer-input').value.trim();
    // slash command hanya saat diketik di composer, bukan saat regenerate
    if (!directPrompt && typed.startsWith('/')) {
      const [cmd, ...rest] = typed.slice(1).split(/\s+/);
      if (handleSlash(cmd, rest.join(' '))) {
        $('#composer-input').value = '';
        return;
      }
      toast(`Perintah /${cmd} tidak dikenal — /help untuk daftar`);
      return;
    }
    // Lampiran saja (tanpa teks) tetap boleh dikirim: file sering jadi prompt.
    // Regenerate tidak membawa chip composer supaya tidak mengirim file dua kali.
    const sending = directPrompt ? [] : pendingAttachments.slice();
    const prompt = (directPrompt ?? typed).trim();
    if (!prompt && !sending.length) return;
    setRun('running');
    runCtrl = new AbortController();

    try {
      if (!curThread) {
        curThread = await api('/api/threads', {
          method: 'POST',
          body: JSON.stringify({ engine: currentEngine, projectId: activeProject?.id, cwd: activeCwd() }),
        });
        syncRoute('studio', curThread.id);
      }
      const engineId = currentEngine;
      curThread.messages = [...(curThread.messages || []), {
        id: 'tmp-u',
        role: 'user',
        content: prompt,
        ts: Date.now(),
        ...(sending.length ? { attachments: sending } : {}),
      }];
      curThread.messages = [...curThread.messages, { id: 'tmp-a', role: 'assistant', engine: engineId, content: '', status: 'working' }];
      placeComposer();
      renderSidebar();
      renderChat();
      const streamingEl = $('#chat-messages .msg.assistant:last-child .msg-body');
      if (streamingEl) streamingEl.innerHTML = '<span class="cursor">▍</span>';

      const res = await fetch(`/api/threads/${curThread.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt,
          ...(sending.length ? { attachments: sending.map((a) => a.id) } : {}),
          engine: engineId,
          model: $('#chat-model').value || undefined,
          cwd: activeCwd(),
          effort: effort !== 'default' ? effort : undefined,
          permission: permission !== 'full' ? permission : undefined,
        }),
        signal: runCtrl.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      // Server sudah menerima lampiran: chip composer tidak boleh terkirim lagi
      // pada pesan berikutnya. Bila request gagal, chip tetap ada untuk retry.
      if (sending.length) {
        pendingAttachments = [];
        renderComposerAttachments();
      }
      let acc = '';
      let outcome = 'done';
      await parseSSE(res, (ev) => {
        if (ev.type === 'delta') {
          acc += ev.text;
          const el = $('#chat-messages .msg.assistant:last-child .msg-body');
          if (el) { el.innerHTML = md(acc); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }
        } else if (ev.type === 'done') {
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = acc; meta.ms = ev.ms; meta.servedBy = ev.servedBy; meta.status = 'done';
        } else if (ev.type === 'stopped') {
          outcome = 'stopped';
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = acc || 'Dihentikan.'; meta.status = 'stopped';
        } else if (ev.type === 'error') {
          outcome = 'error';
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = 'Gagal: ' + ev.message; meta.status = 'error';
        }
      });
      setRun(outcome);
      curThread = await api(`/api/threads/${curThread.id}`);
      renderChat();
      renderSidebar();
      // Run selesai = saat paling berguna untuk melihat apa yang berubah.
      await refreshWorkspace();
      if (changesOpen) await refreshDiff();
    } catch (e) {
      const aborted = e.name === 'AbortError' || runCtrl?.signal.aborted;
      setRun(aborted ? 'stopped' : 'error');
      if (!aborted) toast(e.message === 'OFFLINE' ? 'Server tidak terjangkau — coba lagi' : 'Gagal: ' + e.message);
      if (curThread) { curThread = await api(`/api/threads/${curThread.id}`).catch(() => curThread); renderChat(); }
    } finally {
      runCtrl = null;
      if (!directPrompt) $('#composer-input').value = '';
      $('#composer-input').focus();
      // kembali ke idle setelah terminal state terlihat sebentar
      setTimeout(() => { if (!runActive()) setRun('idle'); }, 400);
    }
  }
  $('#btn-send').addEventListener('click', () => sendPrompt());
  $('#composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });

  // Hentikan run: batalkan fetch lokal DAN minta server mematikan proses CLI.
  // Tanpa ini, menutup tab meninggalkan proses 10 menit dan thread "running" selamanya.
  async function stopRun() {
    const id = curThread?.id;
    try { runCtrl?.abort(); } catch { /* noop */ }
    if (id) { try { await api(`/api/threads/${id}/stop`, { method: 'POST' }); } catch { /* sudah berhenti */ } }
    setRun('stopped');
    toast('Run dihentikan');
    if (id) {
      curThread = await api(`/api/threads/${id}`).catch(() => curThread);
      renderChat();
      renderSidebar();
    }
    setTimeout(() => { if (!runActive()) setRun('idle'); }, 400);
  }
  $('#btn-stop').addEventListener('click', stopRun);

  // aksi pesan: salin & ulangi (regenerate) — ala aplikasi agent populer
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-msg]');
    if (copyBtn) {
      const body = copyBtn.closest('.msg')?.querySelector('.msg-body');
      if (body) navigator.clipboard?.writeText(body.innerText).then(() => toast('Pesan disalin'));
      return;
    }
    const regenBtn = e.target.closest('[data-regen]');
    if (regenBtn) {
      if (!curThread || runActive()) return;
      const lastUser = [...(curThread.messages || [])].reverse().find((x) => x.role === 'user');
      if (!lastUser) return;
      sendPrompt(String(lastUser.content));
    }
  });

  // ---------- delegation ----------
  function renderDelegationEngines() {
    // jangan buang pilihan user saat SSE memicu render ulang
    const checked = new Set($$('#del-engines input[data-del]:checked').map((i) => i.value));
    $('#del-engines').innerHTML = engines.map((e) => `
      <label class="switch-row del-engine ${e.available ? '' : 'off'}">
        <input type="checkbox" value="${esc(e.id)}" data-del ${e.available ? '' : 'disabled'} ${checked.has(e.id) ? 'checked' : ''}>
        <span>${icon(e.id)} ${esc(e.label)} <span class="muted small">${esc(e.note || '')}</span></span>
      </label>`).join('');
  }

  $$('[data-open-delegate]').forEach((b) => b.addEventListener('click', () => {
    setLayer('delegate');
    if (!(delegationStatus === 'starting' || delegationStatus === 'running')) {
      setDelegation('idle');
      $('#del-progress').classList.add('hidden');
      $('#del-progress').innerHTML = '';
    }
  }));
  $('#btn-del-cancel').addEventListener('click', async () => {
    if (delegationStatus === 'starting' || delegationStatus === 'running') {
      try { delCtrl?.abort(); } catch { /* sudah selesai */ }
      if (delThreadId) {
        try { await api(`/api/threads/${delThreadId}/stop`, { method: 'POST' }); } catch { /* sudah berhenti */ }
      }
      setDelegation('stopped');
      toast('Delegation dihentikan');
      return;
    }
    setLayer(null);
  });

  $('#btn-del-start').addEventListener('click', async () => {
    if (delegationStatus === 'starting' || delegationStatus === 'running') return;
    const prompt = $('#del-prompt').value.trim();
    const selected = $$('#del-engines input[data-del]:checked').map((i) => i.value);
    if (!prompt || !selected.length) return toast('Isi prompt & pilih minimal 1 engine');
    setDelegation('starting');
    delThreadId = null;
    delCtrl = new AbortController();
    $('#del-progress').classList.remove('hidden');
    $('#del-progress').innerHTML = selected.map((id) => `
      <div class="del-run" data-engine="${esc(id)}"><span class="chip">${icon(id)} ${esc(engineLabel(id))}</span> <span class="del-status">⏳ mulai…</span><div class="del-out"></div></div>`).join('');

    try {
      const res = await fetch('/api/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, engines: selected, cwd: activeCwd(), effort: effort !== 'default' ? effort : undefined, permission: permission !== 'full' ? permission : undefined, projectId: activeProject?.id }),
        signal: delCtrl.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      let outcome = 'done';
      await parseSSE(res, (ev) => {
        if (ev.type === 'start') { delThreadId = ev.threadId; setDelegation('running'); }
        const row = $(`#del-progress .del-run[data-engine="${ev.engine}"] .del-status`);
        if (ev.type === 'sub') {
          const st = ev.status || 'working';
          if (row) row.textContent = st === 'done' ? `✓ ${Math.round((ev.ms || 0) / 100) / 10}s`
            : st === 'error' ? '× gagal'
            : st === 'stopped' ? 'dihentikan'
            : '⏳ bekerja…';
        } else if (ev.type === 'subdelta') {
          const out = $(`#del-progress .del-run[data-engine="${ev.engine}"] .del-out`);
          if (out) { out.textContent = (out.textContent + ev.text).slice(-800); out.classList.add('live'); }
        } else if (ev.type === 'done') {
          outcome = ev.outcome || 'done';
        }
      });
      setDelegation(outcome);
      if (outcome === 'stopped') toast('Delegation dihentikan');
      else if (outcome === 'error') toast('Delegation gagal — periksa hasil per engine');
      else toast('Delegation selesai — hasil di thread & papan Tugas');
      curThread = null;
      await loadState();
      if (delThreadId && layer === 'delegate') await openThread(delThreadId);
      if (layer === 'delegate') setLayer(null);
    } catch (e) {
      const aborted = e.name === 'AbortError' || delCtrl?.signal.aborted;
      setDelegation(aborted ? 'stopped' : 'error');
      if (!aborted) toast('Delegation gagal: ' + e.message);
    } finally {
      delCtrl = null;
    }
  });

  // ---------- tasks ----------
  const KICON = {
    all: svgIco('<path d="M4 7h16M4 12h16M4 17h10"/>'),
    inbox: svgIco('<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5.5 5h13l2.5 8v6H3v-6z"/>'),
    todo: svgIco('<circle cx="12" cy="12" r="8.5"/>'),
    running: svgIco('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    review: svgIco('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6"/>'),
    done: svgIco('<circle cx="12" cy="12" r="8.5"/><path d="M8.4 12.2l2.5 2.5 4.7-4.9"/>'),
    global: svgIco('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5z"/>'),
  };
  const TASK_COLS = TASK_STATUSES.map((s) => [s, TASK_LABELS[s]]);
  // satu input "tambah tugas" yang terbuka pada satu waktu
  let openCol = null;
  let newTaskDraft = '';   // draft bertahan walau SSE memicu render ulang

  // Kode pendek ala "DIW-6": inisial proyek + nomor urut pembuatan.
  function taskCode(t, all) {
    const project = t.projectId || 'default';
    const base = (project === 'default' ? cwdBase() : project).replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'AH';
    const peers = all.filter((x) => (x.projectId || 'default') === project)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const n = peers.findIndex((x) => x.id === t.id) + 1;
    return `${base}-${n || 1}`;
  }

  async function renderTasks() {
    let list;
    try { list = await api('/api/tasks'); } catch { return; }
    railProjects = [...new Set(list.map((t) => t.projectId || 'default'))];
    renderRailSpaces();
    const q = taskSearch.toLowerCase();
    const inProject = (t) => taskProject === 'all' || (t.projectId || 'default') === taskProject;
    const filtered = list.filter((t) => inProject(t)
      && (taskFilter === 'all' || t.status === taskFilter)
      && (!q || t.title.toLowerCase().includes(q)));

    const rows = [['all', 'All tasks'], ...TASK_COLS, ['global', 'Global']];
    $('#task-filters').innerHTML = rows.map(([k, l]) => {
      const base = list.filter(inProject);
      const n = k === 'all' || k === 'global' ? base.length : base.filter((t) => t.status === k).length;
      const active = k === 'global' ? taskGlobal : (taskFilter === k && !taskGlobal);
      return `<div class="filter-row ${active ? 'active' : ''}" data-filter="${k}"><span class="kico">${KICON[k]}</span><span class="grow">${l}</span><span class="muted small">${n}</span></div>`;
    }).join('');
    $$('#task-filters .filter-row').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.filter;
      if (k === 'global') { taskFilter = 'all'; taskProject = 'all'; taskGlobal = true; }
      else { taskFilter = k; taskGlobal = false; }
      renderTasks();
    }));

    const projects = [...new Set(list.map((t) => t.projectId || 'default'))];
    $('#task-projects').innerHTML = projects.map((p) => `
      <div class="filter-row ${taskProject === p ? 'active' : ''}" data-project="${esc(p)}">
        <span class="p-dot" style="background:${projectColor(p)}"></span>
        <span class="grow">${esc(projectLabel(p))}</span>
        <span class="muted small">${list.filter((t) => (t.projectId || 'default') === p).length}</span>
      </div>`).join('');
    $$('#task-projects .filter-row').forEach((el) => el.addEventListener('click', () => {
      taskProject = el.dataset.project;
      taskGlobal = false;
      renderTasks();
    }));

    $('#task-project-name').textContent = taskProject === 'all'
      ? activeLabel()
      : (projectCache.find((p) => p.id === taskProject)?.name || projectLabel(taskProject));

    $('#kanban').innerHTML = TASK_COLS.map(([key, label]) => {
      const cards = filtered.filter((t) => t.status === key);
      const nextStatus = taskNext(key, 1);
      const prevStatus = taskNext(key, -1);
      return `
      <div class="kcol" data-status="${key}">
        <div class="kcol-head"><span class="kico">${KICON[key]}</span><b>${label}</b> <span class="count">${cards.length}</span>
          <button class="add" data-add="${key}" title="Tambah tugas">＋</button>
        </div>
        <div class="kcol-body">
          <input class="knew${openCol === key ? '' : ' hidden'}" placeholder="Tulis judul, Enter" data-status="${key}" value="${openCol === key ? esc(newTaskDraft) : ''}">
          ${cards.map((t) => {
            // Tombol hanya untuk transisi yang sah menurut TASK_MACHINE.
            const canPrev = prevStatus && taskCanMove(key, prevStatus);
            const canNext = nextStatus && taskCanMove(key, nextStatus);
            return `
          <div class="kcard" data-id="${t.id}">
            <div class="kcard-top"><span class="id-chip">${esc(taskCode(t, list))}</span>
              <span class="kcard-acts">
                ${t.threadId ? `<button class="icon-btn" data-open-thread="${t.threadId}" title="Buka thread">${icon('external')}</button>` : ''}
                <button class="icon-btn" data-del-task="1" title="Hapus">✕</button>
              </span>
            </div>
            <div class="kcard-title">${esc(t.title)}</div>
            <div class="kcard-foot">
              ${canPrev ? `<button class="icon-btn" data-to="${prevStatus}" title="Kembali ke ${TASK_LABELS[prevStatus]}">←</button>` : ''}
              ${canNext ? `<button class="icon-btn" data-to="${nextStatus}" title="Lanjut ke ${TASK_LABELS[nextStatus]}">→</button>` : ''}
            </div>
          </div>`;
          }).join('') || '<div class="kcol-empty"></div>'}
        </div>
      </div>`;
    }).join('');

    $$('#kanban .kcol-head .add').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.add;
      openCol = openCol === key ? null : key;
      $$('#kanban .knew').forEach((inp) => inp.classList.toggle('hidden', inp.dataset.status !== openCol));
      const inp = $(`#kanban .knew[data-status="${key}"]`);
      if (inp && openCol === key) inp.focus();
    }));
    $$('#kanban .knew').forEach((inp) => {
      inp.addEventListener('input', () => { if (inp.dataset.status === openCol) newTaskDraft = inp.value; });
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && inp.value.trim()) {
          await api('/api/tasks', { method: 'POST', body: JSON.stringify({
            title: inp.value.trim(),
            status: inp.dataset.status,
            projectId: taskProject !== 'all' ? taskProject : activeProject?.id || undefined,
          }) });
          openCol = null;
          newTaskDraft = '';
          renderTasks();
        }
        if (e.key === 'Escape') { openCol = null; newTaskDraft = ''; inp.classList.add('hidden'); }
      });
    });
    // satu handler untuk semua perpindahan; target diambil dari tombol, bukan ±1
    $$('#kanban [data-to]').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.kcard');
      const from = btn.closest('.kcol').dataset.status;
      const to = btn.dataset.to;
      if (!taskCanMove(from, to)) return toast(`Tidak bisa ${from} → ${to}`, 2500);
      try {
        await api(`/api/tasks/${card.dataset.id}`, { method: 'POST', body: JSON.stringify({ status: to }) });
        renderTasks();
      } catch (e) {
        // server menolak transisi (409) — tampilkan alasannya, jangan diam
        if (e.status === 409) {
          toast(e.message, 4000);
          renderTasks();
        } else toast('Gagal: ' + e.message);
      }
    }));
    $$('#kanban [data-del-task]').forEach((btn) => btn.addEventListener('click', async () => {
      const ok = await askConfirm('Hapus task?', {
        title: 'Hapus task?',
        okLabel: 'Hapus',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/tasks/${btn.closest('.kcard').dataset.id}`, { method: 'DELETE' });
      renderTasks();
    }));
    $$('#kanban [data-open-thread]').forEach((btn) => btn.addEventListener('click', () => openThread(btn.dataset.openThread)));
  }
  $('#task-search').addEventListener('input', (e) => { taskSearch = e.target.value; renderTasks(); });
  $('#btn-task-display').addEventListener('click', () => {
    const board = $('#kanban');
    board.classList.toggle('compact');
    toast(board.classList.contains('compact') ? 'Tampilan ringkas' : 'Tampilan normal', 1500);
  });
  $('#btn-task-panel').addEventListener('click', () => $('#btn-task-display').click());
  $('#btn-task-new').addEventListener('click', () => {
    openCol = openCol === 'inbox' ? null : 'inbox';
    newTaskDraft = '';
    renderTasks();
    setTimeout(() => $(`#kanban .knew[data-status="inbox"]`)?.focus(), 60);
  });
  $('#btn-task-sidebar').addEventListener('click', () => {
    const side = $('.task-side');
    side.classList.toggle('hidden');
    if (side.classList.contains('hidden')) toast('Sidebar disembunyikan — klik ikon lagi untuk menampilkan', 2200);
  });

  // ---------- notes ----------
  let noteFilter = 'all';
  let noteQuery = '';
  let editingNoteId = null;
  let noteBaseline = '';   // isi saat editor dibuka, untuk deteksi perubahan

  function setNoteEditor(next) {
    if (!canTransition(NOTE_EDITOR_MACHINE, noteEditorState, next)) {
      console.warn(`[noteEditor] transisi ${noteEditorState} → ${next} tidak sah`);
    }
    noteEditorState = next;
    const status = $('#note-status');
    if (!status) return;
    if (next === 'dirty') status.textContent = 'Belum disimpan ●';
    if (next === 'saving') status.textContent = NOTE_EDITOR_MACHINE.states.saving;
  }

  function noteSnapshot() {
    return [$('#note-title').value, $('#note-body').value, $('#note-project').value, $('#note-pinned').checked].join('\u0000');
  }

  function markNoteDirty() {
    if (noteEditorState !== 'editing') return;
    if (noteSnapshot() === noteBaseline) return;
    setNoteEditor('dirty');
  }

  const noteProjectLabel = (p) => (!p || p === 'global' ? 'Global' : projectLabel(p));
  const noteProjects = () => {
    const ids = new Set(['global', 'default']);
    for (const n of state?.notes || []) ids.add(n.projectId || 'global');
    for (const p of railProjects) ids.add(p);
    return [...ids];
  };
  const noteDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');

  function noteCard(n) {
    const body = String(n.body || '').trim();
    return `<div class="note-cell" data-note="${n.id}">
      <div class="note-preview ${body ? '' : 'empty'}">${body ? esc(body.slice(0, 900)) : 'No text yet'}</div>
      <div class="note-name">${esc(n.title || 'Untitled')}</div>
      <div class="note-sub"><span>${noteDate(n.updatedAt)}</span><span class="p-dot" style="background:${projectColor(n.projectId || 'global')}"></span><span>${esc(noteProjectLabel(n.projectId))}</span></div>
    </div>`;
  }

  function renderNotes() {
    if (!state) return;
    const all = state.notes || [];
    const q = noteQuery.toLowerCase();
    const filtered = all.filter((n) => {
      const project = n.projectId || 'global';
      const inFilter = noteFilter === 'all' || project === noteFilter;
      const hay = `${n.title || ''} ${n.body || ''} ${noteProjectLabel(project)}`.toLowerCase();
      return inFilter && (!q || hay.includes(q));
    });

    const projects = noteProjects();
    const pills = [['all', 'All'], ...projects.map((p) => [p, noteProjectLabel(p)])];
    $('#note-filters').innerHTML = pills.map(([k, label]) => `
      <button class="note-pill ${noteFilter === k ? 'active' : ''}" data-note-filter="${esc(k)}">
        ${k === 'all' ? '' : `<span class="p-dot" style="background:${projectColor(k)}"></span>`}${esc(label)}
      </button>`).join('');
    $$('#note-filters .note-pill').forEach((btn) => btn.addEventListener('click', () => {
      noteFilter = btn.dataset.noteFilter;
      renderNotes();
    }));

    const pinned = filtered.filter((n) => n.pinned);
    const recent = filtered.filter((n) => !n.pinned);
    $('#notes-pinned').innerHTML = pinned.length
      ? `<h4>Pinned</h4><div class="notes-grid pinned">${pinned.map(noteCard).join('')}</div>`
      : '';
    $('#notes-recent').innerHTML = recent.length
      ? `<h4>Recent</h4><div class="notes-grid recent">${recent.map(noteCard).join('')}</div>`
      : pinned.length ? ''
        : `<div class="notes-empty"><b>Belum ada catatan</b><span>Simpan insight, potongan kode, atau keputusan proyek di sini.</span><button class="btn tiny primary" id="notes-empty-new">New note</button></div>`;

    $$('#notes-recent .note-cell, #notes-pinned .note-cell').forEach((el) => el.addEventListener('click', () => openNoteEditor(el.dataset.note)));
    $('#notes-empty-new')?.addEventListener('click', () => openNoteEditor(null));
  }

  function openNoteEditor(id) {
    const n = id ? (state?.notes || []).find((x) => x.id === id) : null;
    editingNoteId = n?.id || null;
    $('#note-overlay-title').textContent = n ? 'Edit catatan' : 'Catatan baru';
    $('#note-title').value = n?.title || '';
    $('#note-body').value = n?.body || '';
    $('#note-pinned').checked = !!n?.pinned;
    const sel = $('#note-project');
    const ids = noteProjects();
    sel.innerHTML = ids.map((p) => `<option value="${esc(p)}">${esc(noteProjectLabel(p))}</option>`).join('');
    sel.value = n?.projectId || (taskProject !== 'all' ? taskProject : 'global');
    $('#btn-note-del').classList.toggle('hidden', !n);
    $('#note-status').textContent = n ? `Diubah ${fmtTime(n.updatedAt)}` : 'Belum disimpan';
    noteBaseline = noteSnapshot();
    setNoteEditor('editing');
    setLayer('note');
    setTimeout(() => $('#note-title').focus(), 50);
  }

  $('#btn-note-new').addEventListener('click', () => openNoteEditor(null));
  ['#note-title', '#note-body'].forEach((sel) => {
    $(sel).addEventListener('input', markNoteDirty);
  });
  ['#note-pinned', '#note-project'].forEach((sel) => {
    $(sel).addEventListener('change', markNoteDirty);
  });
  $('#btn-note-cancel').addEventListener('click', () => setLayer(null));
  $('#note-search').addEventListener('input', (e) => { noteQuery = e.target.value; renderNotes(); });
  $('#btn-note-display').addEventListener('click', () => {
    $('.notes-body').classList.toggle('compact');
    toast($('.notes-body').classList.contains('compact') ? 'Catatan ringkas' : 'Catatan normal', 1400);
  });
  $('#btn-note-trash').addEventListener('click', () => toast('Catatan yang dihapus tidak bisa dikembalikan', 2600));
  $('#btn-note-save').addEventListener('click', async () => {
    const title = $('#note-title').value.trim();
    const body = $('#note-body').value;
    if (!title && !body.trim()) return toast('Isi judul atau catatan dulu');
    const payload = { title: title || 'Untitled', body, projectId: $('#note-project').value, pinned: $('#note-pinned').checked };
    const btn = $('#btn-note-save');
    btn.disabled = true;
    setNoteEditor('saving');
    try {
      if (editingNoteId) await api(`/api/notes/${editingNoteId}`, { method: 'POST', body: JSON.stringify(payload) });
      else await api('/api/notes', { method: 'POST', body: JSON.stringify(payload) });
      toast(editingNoteId ? 'Catatan disimpan' : 'Catatan dibuat');
      setNoteEditor('closed');
      setLayer(null);
      await loadState();
    } catch (e) { setNoteEditor('dirty'); toast('Gagal: ' + e.message); }
    finally { btn.disabled = false; }
  });
  $('#btn-note-del').addEventListener('click', async () => {
    if (!editingNoteId) return;
    const ok = await askConfirm('Hapus catatan ini?', {
      title: 'Hapus catatan?',
      okLabel: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/notes/${editingNoteId}`, { method: 'DELETE' });
      toast('Catatan dihapus');
      setNoteEditor('closed');
      setLayer(null);
      await loadState();
    } catch (e) { toast('Gagal: ' + e.message); }
  });

  // ---------- promo ----------
  const PRESET_FOR_PROVIDER = {
    openrouter: 'openrouter', groq: 'groq', 'google-ai-studio': 'gemini', google: 'gemini', gemini: 'gemini',
    'github-models': 'github', github: 'github', mistral: 'mistral', 'mistral-ai': 'mistral',
    'together-ai': 'together', together: 'together', deepseek: 'deepseek', 'x-ai': 'xai', xai: 'xai',
    zhipuai: 'glm', zhipu: 'glm', 'z-ai': 'glm', huggingface: 'hf', 'hugging-face': 'hf', hf: 'hf',
  };
  function presetForProvider(provider) {
    const key = String(provider || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return PRESET_FOR_PROVIDER[key] || 'custom';
  }
  // Deteksi preset dari ID model lengkap (bukan hanya provider). Model yang
  // jalannya lewat OpenRouter (mis. "kilo/openrouter/auto") → preset openrouter.
  function presetForModel(modelId, provider) {
    const id = String(modelId || '').toLowerCase();
    if (id.includes('openrouter')) return 'openrouter';
    if (id.includes('groq')) return 'groq';
    if (id.includes('gemini') || id.includes('google')) return 'gemini';
    if (id.includes('cerebras')) return 'cerebras';
    if (id.includes('mistral')) return 'mistral';
    if (id.includes('deepseek')) return 'deepseek';
    if (id.includes('together')) return 'together';
    if (id.includes('github')) return 'github';
    if (id.includes('bigmodel') || id.includes('glm')) return 'glm';
    if (id.includes('huggingface') || id.includes('hf/')) return 'hf';
    if (id.includes('xai') || id.includes('grok')) return 'xai';
    const p = presetForProvider(provider);
    if (p !== 'custom') return p;
    // fallback: prefix pertama model ID serupa nama preset
    const first = id.split('/')[0];
    if (PRESET_FOR_PROVIDER[first]) return PRESET_FOR_PROVIDER[first];
    return 'custom';
  }
  function gatewayEnvText() {
    const s = state?.server;
    const gw = `${(s?.lanUrl || 'http://127.0.0.1:7788').replace(/\/+$/, '')}/v1`;
    return `OPENAI_BASE_URL=${gw}\nOPENAI_API_KEY=${state?.token || ''}\nOPENAI_MODEL=auto`;
  }

  let adoptModelId = '';
  function syncAdoptPreset() {
    const preset = $('#adopt-preset').value;
    const p = state.keyPresets[preset] || {};
    $('#adopt-base').value = p.baseUrl || '';
    const short = String(adoptModelId).split('/').pop().replace(/:free$/, '').slice(0, 48);
    $('#adopt-name').value = `${p.label || 'Custom'} · ${short}`.slice(0, 80);
    const a = $('#adopt-signup');
    if (p.signup) { a.href = p.signup; a.classList.remove('hidden'); } else a.classList.add('hidden');
  }
  function openAdopt(modelId, preset, name) {
    adoptModelId = String(modelId || '');
    $('#adopt-model').textContent = adoptModelId;
    const sel = $('#adopt-preset');
    sel.innerHTML = Object.entries(state.keyPresets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    sel.value = state.keyPresets[preset] ? preset : 'custom';
    // dispatch change agar dropdown custom memperbarui label tombolnya
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    syncAdoptPreset();
    if (name) {
      const short = name.replace(/\s*\(free\)\s*/i, '').slice(0, 60);
      $('#adopt-name').value = `${state.keyPresets[sel.value]?.label || 'Custom'} · ${short}`.slice(0, 80);
    }
    // Jangan pernah mengisi input kredensial dengan key tersamarkan —
    // nilai itu kalau dikirim akan tersimpan sebagai "key" palsu.
    $('#adopt-key').value = '';
    $('#adopt-pool').checked = state.config?.autoPool !== false;
    $('#adopt-result').classList.add('hidden');
    $('#adopt-result').innerHTML = '';
    $('#btn-adopt-start').disabled = false;
    renderAdoptHint();
    setLayer('adopt');
    setTimeout(() => $('#adopt-key').focus(), 60);
  }

  // Info jujur: kalau provider ini sudah punya key yang bisa dipakai, model
  // langsung aktif tanpa key baru dan tanpa membuka situs provider.
  function renderAdoptHint() {
    const preset = $('#adopt-preset').value;
    const k = (state.keys || []).find((x) => x.preset === preset && x.keyMask && x.status !== 'invalid');
    const hint = $('#adopt-hint');
    if (!hint) return;
    hint.classList.toggle('hidden', !k);
    if (k) {
      hint.textContent = `Key tersimpan (${k.keyMask}) untuk provider ini akan dipakai otomatis — biarkan kolom API Key kosong.`;
    }
  }

  $('#adopt-preset').addEventListener('change', () => { syncAdoptPreset(); renderAdoptHint(); });
  $('#btn-adopt-cancel').addEventListener('click', () => setLayer(null));
  $('#btn-adopt-start').addEventListener('click', async () => {
    const key = $('#adopt-key').value.trim();
    const btn = $('#btn-adopt-start');
    btn.disabled = true;
    $('#adopt-result').classList.add('hidden');
    // Kolom key kosong + key provider tersimpan → aktifkan langsung, tanpa web.
    if (!key) {
      try {
        await api('/api/models/activate', {
          method: 'POST',
          body: JSON.stringify({ preset: $('#adopt-preset').value, model: adoptModelId }),
        });
        selectedModel = adoptModelId;
        localStorage.setItem('ah_model', selectedModel);
        currentEngine = 'pool';
        localStorage.setItem('ah_engine', 'pool');
        await renderEngines(true);
        await loadState({ silent: true });
        const gw = `${(state.server.lanUrl || state.server.localUrl).replace(/\/+$/, '')}/v1`;
        $('#adopt-result').classList.remove('hidden');
        $('#adopt-result').innerHTML = `
          <b>✓ Siap dipakai agent — memakai key tersimpan</b><br>
          Model <code>${esc(adoptModelId)}</code> sudah aktif di pool. Arahkan agent ke endpoint ini:
          <div class="url-row" style="margin-top:8px"><code>${esc(gw)}</code></div>
          <div class="form-actions"><button class="btn tiny primary" id="adopt-copy">Salin env agent</button><button class="btn tiny" id="adopt-open-gw">Buka gateway</button></div>`;
        $('#adopt-copy').addEventListener('click', () => navigator.clipboard?.writeText(gatewayEnvText()).then(() => toast('Env agent disalin')));
        $('#adopt-open-gw').addEventListener('click', () => { setLayer(null); go('gateway'); });
        toast('Model gratis aktif di pool (key tersimpan)');
        return;
      } catch (e) {
        if (e.status === 409 || e.status === 404) { toast('Belum ada key untuk provider ini — tempel key dulu'); return; }
        toast('Gagal: ' + e.message);
        return;
      } finally { btn.disabled = false; }
    }
    try {
      const r = await api('/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          preset: $('#adopt-preset').value,
          name: $('#adopt-name').value.trim(),
          baseUrl: $('#adopt-base').value.trim(),
          key,
          pool: $('#adopt-pool').checked,
          poolModel: adoptModelId,
        }),
      });
      await loadState();
      const status = r.entry?.status || 'unknown';
      const bad = status === 'invalid';
      const unverified = !bad && status !== 'valid';
      const inPool = !!r.entry?.pool;
      if (inPool && !bad) {
        // model baru saja masuk pool — engine langsung memakainya
        selectedModel = adoptModelId;
        localStorage.setItem('ah_model', selectedModel);
        currentEngine = 'pool';
        localStorage.setItem('ah_engine', 'pool');
        await renderEngines(true);
      }
      const title = bad ? 'Key ditolak provider'
        : unverified ? 'Key tersimpan, belum terverifikasi'
        : inPool ? '✓ Siap dipakai agent'
        : '✓ Key tersimpan';
      const note = bad ? 'Periksa kembali key promo Anda — model belum masuk rotasi.'
        : unverified && inPool ? 'Provider tidak menjawab saat validasi. Key tetap masuk pool dan dicek ulang otomatis.'
        : !inPool ? `Key tersimpan. Aktifkan lewat tab API Keys (tombol "+ Pool") atau pemilih model untuk memakainya.`
        : `Model <code>${esc(adoptModelId)}</code> sudah masuk pool. Arahkan agent ke endpoint ini:`;
      const gw = `${(state.server.lanUrl || state.server.localUrl).replace(/\/+$/, '')}/v1`;
      $('#adopt-result').classList.remove('hidden');
      $('#adopt-result').innerHTML = `
        <b>${title}</b><br>${note}
        <div class="url-row" style="margin-top:8px"><code>${esc(gw)}</code></div>
        <div class="url-row"><code>${esc(state.token)}</code></div>
        <div class="form-actions"><button class="btn tiny primary" id="adopt-copy">Salin env agent</button><button class="btn tiny" id="adopt-open-gw">Buka gateway</button></div>`;
      $('#adopt-copy').addEventListener('click', () => navigator.clipboard?.writeText(gatewayEnvText()).then(() => toast('Env agent disalin')));
      $('#adopt-open-gw').addEventListener('click', () => { setLayer(null); go('gateway'); });
      toast(bad ? 'Key ditolak provider' : unverified ? 'Key masuk pool (belum terverifikasi)' : 'Model gratis aktif di pool');
    } catch (e) {
      toast('Gagal: ' + e.message);
    } finally { btn.disabled = false; }
  });
  // key provider yang sudah tersimpan & belum ditolak → model bisa aktif
  // satu tap, tanpa mencari/tempel API key lagi. UI hanya menerima keyMask
  // (key utuh tidak pernah dikirim server ke browser).
  const usableKeyFor = (preset) => (state.keys || []).some((k) => k.preset === preset && k.keyMask && k.status !== 'invalid');
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.adopt-btn');
    if (!b) return;
    if (b.dataset.quick || usableKeyFor(b.dataset.preset)) {
      // key tersimpan (ceklah saat klik, bukan hanya saat render kartu) → langsung aktif
      b.disabled = true;
      try {
        await api('/api/models/activate', {
          method: 'POST',
          body: JSON.stringify({ preset: b.dataset.preset, model: b.dataset.model }),
        });
        selectedModel = b.dataset.model;
        localStorage.setItem('ah_model', selectedModel);
        // memilih model di promo = langsung pakai: engine pindah ke Gateway
        currentEngine = 'pool';
        localStorage.setItem('ah_engine', 'pool');
        await renderEngines(true);
        await loadState({ silent: true });
        toast(`${b.dataset.name || 'Model'} aktif — engine pindah ke Gateway`);
      } catch (err) { toast('Gagal: ' + err.message); }
      finally { b.disabled = false; }
      return;
    }
    openAdopt(b.dataset.model, b.dataset.preset, b.dataset.name);
  });

  // ---------- promo pass (kartu klaim → Start Plan) ----------
  let passAddOpen = false;
  let ppRenaming = '';
  const passState = () => state?.promoPass || null;
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const ppTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
  const ppShort = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ppPlanDate = (ts) => `${ppShort(ts)}, ${ppTime(ts)}`;
  const ppTicketDate = (ts) => new Date(ts).toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const ppLongDate = (ts) => `${ppShort(ts)}, ${new Date(ts).getFullYear()} ${ppTime(ts)}`;
  const ppDayLabel = (ts) => {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString() ? 'Today' : ppShort(ts);
  };

  const PASS_PHASE_TEXT = { available: 'Available', pending: 'Pending', active: 'Active', expired: 'Expired' };

  function passStatusLine(p) {
    if (p.phase === 'available') {
      return `${fmtNum(p.headlineTokens)} token · klaim untuk membuka Start Plan`;
    }
    if (p.phase === 'pending') {
      return `Pending ${ppDayLabel(p.startsAt)} ${ppTime(p.startsAt)} · Expires ${ppPlanDate(p.ticketValidUntil)}`;
    }
    if (p.phase === 'active') {
      return `Active now · Expires ${ppPlanDate(p.ticketValidUntil)}`;
    }
    return `Expired ${ppPlanDate(p.planExpiresAt)}`;
  }

  async function passRequest(action, body) {
    const r = await api(`/api/promo/pass/${action}`, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r?.pass && state) state.promoPass = r.pass;
    renderPromoPass();
    return r;
  }

  function renderSbPromo(p) {
    const host = $('#sb-promo');
    if (!host) return;
    if (!p || p.dismissed) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    if (!p.claimed) {
      host.innerHTML = `
        <div class="sb-promo-card" role="button" tabindex="0" data-pp-act="open-plan" aria-label="Buka promo AgentHub Global Build">
          <div class="spc-head">
            <span class="spc-logo">A</span><b>AGENTHUB</b><span class="spc-series">GLOBAL BUILD</span>
            <button class="spc-x" data-pp-act="dismiss" title="Sembunyikan kartu promo" aria-label="Sembunyikan kartu promo">✕</button>
          </div>
          <div class="spc-tokens"><b>${fmtNum(p.headlineTokens)}</b><span>tokens</span></div>
          <div class="spc-foot">
            <span>GLM-5.3-Flash quota</span>
            <button class="spc-claim" data-pp-act="claim">Claim</button>
          </div>
        </div>`;
      return;
    }
    host.innerHTML = `
      <div class="sb-promo-card is-claimed" role="button" tabindex="0" data-pp-act="open-plan" aria-label="Buka Start Plan">
        <div class="spc-head">
          <span class="spc-logo">A</span><b>AGENTHUB</b><span class="spc-series">GLOBAL BUILD</span>
          <button class="spc-x" data-pp-act="dismiss" title="Sembunyikan kartu promo" aria-label="Sembunyikan kartu promo">✕</button>
        </div>
        <div class="spc-tokens"><b>${p.phase === 'expired' ? '0' : fmtCtx(p.headlineTokens)}</b><span>tokens</span></div>
        <div class="spc-foot">
          <span class="spc-phase ${esc(p.phase)}"><i></i>${esc(PASS_PHASE_TEXT[p.phase] || p.phase)} · ${esc(ppShort(p.planExpiresAt))}</span>
          <button class="spc-claim" data-pp-act="open-plan">Lihat</button>
        </div>
      </div>`;
  }

  function passBalanceCard(m, p) {
    return `<div class="pp-balance">
      <div class="pp-bal-name" title="${esc(m.label)}">${esc(m.label)}</div>
      <div class="pp-bal-pct"><b>${m.pct}%</b><span>terpakai · reset ${esc(p.resetLabel)}</span></div>
      <div class="pp-bal-bar"><i style="width:${m.pct}%"></i></div>
      <div class="pp-bal-used">${fmtNum(m.used)} / ${fmtNum(m.quota)}</div>
      ${m.pct === 0 ? '<div class="pp-bal-hint">belum dipakai — kirim prompt GLM via gateway</div>' : ''}
    </div>`;
  }

  function passModelRow(m) {
    const renaming = ppRenaming === m.id;
    return `<div class="pp-model-row ${m.enabled ? '' : 'is-off'}" data-model="${esc(m.id)}">
      ${renaming
        ? `<input class="pp-rename" id="pp-rename-input" data-model="${esc(m.id)}" value="${esc(m.label)}" maxlength="40" aria-label="Nama tampilan model">`
        : `<span class="pp-model-name">${esc(m.label)}</span>`}
      <span class="pp-chip">${esc(m.context)}</span>
      ${m.vision ? '<span class="pp-chip vision">Vision</span>' : ''}
      <span class="grow"></span>
      ${renaming
        ? `<button class="pp-model-ico" data-pp-act="save-rename" data-model="${esc(m.id)}" title="Simpan nama">${icon('check')}</button>
           <button class="pp-model-ico" data-pp-act="cancel-rename" title="Batal">${icon('x')}</button>`
        : `<button class="pp-model-ico" data-pp-act="usage" data-model="${esc(m.id)}" title="Lihat pemakaian model">${svgIco('<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M4.5 17a9 9 0 1 1 15 0"/><path d="M12 12l3.5-2.5"/>')}</button>
           <button class="pp-model-ico" data-pp-act="rename" data-model="${esc(m.id)}" title="Ubah nama tampilan">${svgIco('<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>')}</button>`}
      <button class="pp-toggle ${m.enabled ? 'on' : ''}" role="switch" aria-checked="${m.enabled ? 'true' : 'false'}"
        data-pp-act="toggle" data-model="${esc(m.id)}" title="${m.enabled ? 'Matikan model' : 'Aktifkan model'}"><i></i></button>
    </div>`;
  }

  // Panel "Benefit plan" — daftar benefit Start Plan ala kartu plan; angka
  // dinamis (kuota %, tugas idle/hari) datang dari publicPass(), bukan hardcode.
  function renderPlanBenefits(p) {
    if (!p.benefits) return '';
    const core = (p.benefits.core || []).map((b) => `<li>${esc(b)}</li>`).join('');
    const items = ((p.benefits.exclusive || {}).items || []).map((b) => `
      <li>${esc(b.text)}${b.mark ? `<em class="pp-benefit-mark">${esc(b.mark)}</em>` : ''}</li>`).join('');
    const included = (p.benefits.included || []).map((b) => `
      <li>${icon('check')}<span>${esc(b)}</span></li>`).join('');
    if (!core && !items && !included) return '';
    return `
      <div class="pp-benefits">
        <div class="pp-benefits-title">Benefit plan</div>
        <ul class="pp-blist">${core}</ul>
        <div class="pp-blist-group">${esc((p.benefits.exclusive || {}).label || '')}</div>
        <ul class="pp-blist sub">${items}</ul>
        ${included ? `
          <div class="pp-blist-group">Semua yang termasuk</div>
          <ul class="pp-checklist">${included}</ul>` : ''}
      </div>`;
  }

  function renderPromoPassView() {
    const host = $('#promo-pass-view');
    if (!host) return;
    const p = passState();
    if (!p) { host.innerHTML = '<p class="muted">Memuat promo…</p>'; return; }

    if (!p.claimed) {
      host.innerHTML = `
        <div class="pp-claim-hero">
          <div class="pp-hero-copy">
            <span class="pp-kicker">PROMO PASS</span>
            <h3>${fmtNum(p.headlineTokens)} token untuk agent Anda</h3>
            <p>Klaim tiket AgentHub Global Build dan dapatkan kuota harian <b>GLM-5.3</b> + <b>GLM-5.3-Flash</b>. Model langsung masuk pool gateway saat tiket aktif.</p>
            <div class="pp-hero-actions">
              <button class="pp-btn light" data-pp-act="claim">Claim ${fmtCtx(p.headlineTokens)} tokens</button>
              <button class="btn" data-pp-act="open-free">Lihat model gratis</button>
            </div>
            <p class="muted small">Tiket baru aktif ${ppDayLabel(p.startsAt)} ${ppTime(p.startsAt)} — tidak ada biaya, tanpa kartu kredit.</p>
          </div>
          <div class="pp-hero-ticket">${ticketHtml(p)}</div>
        </div>
        <div class="pp-feature-grid">
          <div class="pp-feature"><b>1 tiket, dua model</b><span>Saldo terpisah untuk GLM-5.3 dan GLM-5.3-Flash, reset tiap hari pukul ${esc(p.resetLabel)}.</span></div>
          <div class="pp-feature"><b>Langsung ke agent</b><span>Kuota dipakai lewat gateway <code>/v1</code>. Tidak perlu menempel API key berkali-kali.</span></div>
          <div class="pp-feature"><b>Vision siap pakai</b><span>GLM-5.3-Flash menerima gambar; lampirkan file di composer seperti biasa.</span></div>
        </div>`;
      return;
    }

    const addMenu = passAddOpen && p.addable.length
      ? `<div class="pp-add-menu" role="menu">
          ${p.addable.map((m) => `<button class="pp-add-item" role="menuitem" data-pp-act="add" data-model="${esc(m.id)}">
            <span>${esc(m.label)}</span><small>${esc(m.context)}${m.vision ? ' · Vision' : ''}</small></button>`).join('')}
        </div>`
      : '';
    host.innerHTML = `
      <div class="pp-page-head">
        <span class="pp-page-logo">A</span>
        <h3>Start Plan</h3>
        <span class="grow"></span>
        ${p.dismissed ? '<button class="btn tiny" data-pp-act="restore">Tampilkan kartu promo</button>' : ''}
        <button class="btn tiny" data-pp-act="show-ticket">Lihat tiket</button>
      </div>

      <div class="pp-campaign">
        <div class="pp-campaign-main">
          <b>${esc(p.brand)} ${esc(p.series)}</b>
          <div class="pp-status ${esc(p.phase)}"><i></i><span>${esc(passStatusLine(p))}</span></div>
        </div>
        <div class="pp-campaign-actions">
          <button class="pp-upgrade" data-pp-act="upgrade" ${p.boosts >= 4 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>
            Upgrade <span class="pp-quota">${esc(p.quotaLabel)}</span>
          </button>
          <span class="pp-info" title="Upgrade menambah 50% saldo harian per tingkat (maksimal 4x).">i</span>
        </div>
      </div>

      <div class="pp-plan">
        <div class="pp-plan-head">
          <b>${esc(p.planName)}</b>
          <div class="pp-expiry">Expires ${ppPlanDate(p.planExpiresAt)}</div>
        </div>
        <div class="pp-divider"></div>
        <div class="pp-balance-label">Pemakaian hari ini</div>
        <div class="pp-balances">${p.models.map((m) => passBalanceCard(m, p)).join('')}</div>
      </div>

      ${renderPlanBenefits(p)}

      <div class="pp-models-head">
        <span>Model list</span>
        <div class="pp-add-wrap">
          <button class="btn tiny" data-pp-act="addmenu" ${p.addable.length ? '' : 'disabled'}>+ Add model</button>
          ${addMenu}
        </div>
      </div>
      <div class="pp-models">${p.models.map(passModelRow).join('')}</div>
      <p class="muted small pp-foot-note">Kuota dipakai bersama agent lewat gateway. Pemakaian dihitung dari <code>usage.total_tokens</code> upstream saat model cocok.</p>`;
  }

  function renderPromoPass() {
    const p = passState();
    renderSbPromo(p);
    renderPromoPassView();
    if (layer === 'promoClaim' && p) renderTicket(p);
  }

  function ticketHtml(p) {
    return `<div class="pp-ticket-inner">
      <div class="pp-ticket-top">
        <span class="pp-mark">A</span><b>${esc(p.brand.toUpperCase())}</b>
        <span class="pp-ticket-series">${esc(p.series)}</span>
      </div>
      <div class="pp-ticket-tokens"><b>${fmtNum(p.headlineTokens)}</b> <span>Tokens</span></div>
      <div class="pp-ticket-model">
        <svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>
        GLM-5.3-Flash · ${fmtNum(p.headlineTokens)} Tokens
      </div>
      <div class="pp-ticket-cut" aria-hidden="true"><i></i><i></i></div>
      <div class="pp-ticket-valid">Valid until <span>${ppTicketDate(p.ticketValidUntil)}</span></div>
    </div>`;
  }

  function renderTicket(p) {
    const ticket = $('#pp-ticket');
    if (ticket) ticket.innerHTML = ticketHtml(p);
    const plan = $('#pp-claim-plan');
    if (plan) plan.textContent = `${p.brand} ${p.series}`;
    const avail = $('#pp-claim-avail');
    if (avail) {
      avail.innerHTML = p.phase === 'pending'
        ? `<b>GLM-5.3-Flash</b> will be available on <b>${ppLongDate(p.startsAt)}</b>.`
        : p.phase === 'active'
          ? `<b>GLM-5.3-Flash</b> is available now. Kuota aktif sampai <b>${ppPlanDate(p.planExpiresAt)}</b>.`
          : `<b>GLM-5.3-Flash</b> quota has ended on <b>${ppPlanDate(p.planExpiresAt)}</b>.`;
    }
    const shareBtn = $('#pp-claim-share');
    if (shareBtn) shareBtn.textContent = p.sharedAt ? 'Shared ✓' : 'Share';
  }

  async function claimAndOpenTicket() {
    try {
      const r = await passRequest('claim');
      const p = r?.pass || passState();
      if (p) renderTicket(p);
      setLayer('promoClaim');
      setTimeout(() => $('#pp-claim-got')?.focus(), 60);
    } catch (e) {
      toast('Gagal klaim promo: ' + e.message);
    }
  }

  async function sharePromoPass() {
    const p = passState();
    if (!p) return;
    let text = `Saya klaim ${p.brand} ${p.series} — ${fmtNum(p.headlineTokens)} token untuk GLM-5.3-Flash.`;
    try { const r = await passRequest('share'); if (r?.text) text = r.text; } catch { /* tetap bagikan teks lokal */ }
    if (navigator.share) {
      try {
        await navigator.share({ title: `${p.brand} ${p.series}`, text });
        toast('Promo dibagikan');
        return;
      } catch { /* pengguna membatalkan / tidak didukung */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Teks promo disalin — tempel ke chat');
    } catch {
      toast(text, 6000);
    }
  }

  function setPromoPane(pane, { silent = false } = {}) {
    promoPane = pane === 'free' ? 'free' : 'pass';
    localStorage.setItem('ah_promo_pane', promoPane);
    const passPane = $('#promo-pane-pass');
    const freePane = $('#promo-pane-free');
    if (passPane) passPane.classList.toggle('hidden', promoPane !== 'pass');
    if (freePane) freePane.classList.toggle('hidden', promoPane !== 'free');
    $$('.seg-btn[data-pane]').forEach((b) => {
      const on = b.dataset.pane === promoPane;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!silent && state) {
      if (promoPane === 'pass') renderPromoPass(); else renderPromo();
    }
  }

  // Satu listener untuk semua aksi promo pass (kartu, plan, tiket). Delegasi
  // membuat render ulang tidak perlu memasang ulang handler.
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-pp-act]');
    if (!el) {
      if (passAddOpen && !e.target.closest('.pp-add-wrap')) { passAddOpen = false; renderPromoPass(); }
      return;
    }
    const act = el.dataset.ppAct;
    const model = el.dataset.model || '';
    try {
      if (act === 'claim') { await claimAndOpenTicket(); return; }
      if (act === 'dismiss') {
        await passRequest('dismiss', { dismissed: true });
        toast('Kartu promo disembunyikan — buka lagi dari Promo Pass');
        return;
      }
      if (act === 'restore') {
        await passRequest('dismiss', { dismissed: false });
        toast('Kartu promo ditampilkan lagi');
        return;
      }
      if (act === 'open-plan') { setPromoPane('pass', { silent: true }); go('promo'); setLayer(null); return; }
      if (act === 'open-free') { setPromoPane('free'); return; }
      if (act === 'show-ticket') {
        const p = passState();
        if (p) { renderTicket(p); setLayer('promoClaim'); }
        return;
      }
      if (act === 'toggle') {
        const enabled = el.getAttribute('aria-checked') === 'true';
        await passRequest('toggle', { model, enabled: !enabled });
        return;
      }
      if (act === 'upgrade') {
        const r = await passRequest('upgrade');
        toast(`Kuota promo dinaikkan — sekarang ${r?.pass?.quotaLabel || ''}`);
        return;
      }
      if (act === 'addmenu') { passAddOpen = !passAddOpen; ppRenaming = ''; renderPromoPass(); return; }
      if (act === 'add') {
        passAddOpen = false;
        await passRequest('add-model', { model });
        toast('Model ditambahkan ke Start Plan');
        return;
      }
      if (act === 'rename') { ppRenaming = model; passAddOpen = false; renderPromoPass(); setTimeout(() => $('#pp-rename-input')?.select(), 40); return; }
      if (act === 'cancel-rename') { ppRenaming = ''; renderPromoPass(); return; }
      if (act === 'save-rename') {
        const input = $('#pp-rename-input');
        const label = input ? input.value : '';
        ppRenaming = '';
        await passRequest('rename', { model, label });
        toast('Nama model diperbarui');
        return;
      }
      if (act === 'usage') {
        const p = passState();
        const m = p?.models.find((x) => x.id === model);
        if (m) toast(`${m.label}: ${fmtNum(m.used)} / ${fmtNum(m.quota)} token hari ini (${m.pct}%)`);
        return;
      }
    } catch (err) {
      toast('Promo gagal: ' + err.message);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target?.id === 'pp-rename-input') {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.querySelector('[data-pp-act="save-rename"]')?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ppRenaming = '';
        renderPromoPass();
      }
    }
    if (e.key === 'Enter' && e.target?.classList?.contains('sb-promo-card')) {
      e.preventDefault();
      document.querySelector('#sb-promo [data-pp-act="open-plan"]')?.click();
    }
  });

  $('#pp-claim-close').addEventListener('click', () => setLayer(null));
  $('#pp-claim-got').addEventListener('click', () => {
    setLayer(null);
    setPromoPane('pass', { silent: true });
    go('promo');
    toast('Selamat — Start Plan aktif di Promo Pass');
  });
  $('#pp-claim-share').addEventListener('click', sharePromoPass);
  $('#pp-claim-reopen').addEventListener('click', () => {
    const p = passState();
    if (p) { renderTicket(p); toast('Tiket diperbarui'); }
  });

  function renderPromo() {
    const models = state.snapshot?.sources?.openrouter?.models || [];
    const q = promoQuery.toLowerCase();
    const filtered = q ? models.filter((m) => (m.name + ' ' + m.id + ' ' + m.provider).toLowerCase().includes(q)) : models;
    $('#promo-live').innerHTML = filtered.length
      ? `<div class="model-grid">${filtered.map((m) => `
        <div class="model-card">
          <b title="${esc(m.name)}">${esc(m.name)}</b>
          <div class="id">${esc(m.id)}</div>
          <div class="meta">
            <span class="chip free">GRATIS</span>
            <span class="chip">ctx ${fmtCtx(m.context)}</span>
            <span class="chip">${esc(m.provider)}</span>
          </div>
          <div class="model-actions">
            <button class="btn tiny primary adopt-btn" data-model="${esc(m.id)}" data-preset="openrouter" data-name="${esc(m.name)}" ${usableKeyFor('openrouter') ? 'data-quick="1"' : ''}>${usableKeyFor('openrouter') ? 'Pakai langsung' : 'Pakai di agent'}</button>
            <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Detail ${icon('external')}</a>
          </div>
        </div>`).join('')}</div>`
      : '<p class="muted">Tidak ada model yang cocok.</p>';

    const cross = state.snapshot?.sources?.cross?.models || [];
    const crossFiltered = q ? cross.filter((m) => (m.name + ' ' + m.id + ' ' + m.provider).toLowerCase().includes(q)) : cross;
    const crossPreset = (m) => presetForModel(m.id, m.provider);
    $('#promo-cross').innerHTML = crossFiltered.length
      ? `<p class="muted small" style="margin-bottom:12px">${cross.length} model gratis lintas provider — sumber: <a href="https://models.dev" target="_blank" rel="noreferrer">models.dev</a></p>
        <div class="model-grid">${crossFiltered.slice(0, 120).map((m) => `
        <div class="model-card">
          <b title="${esc(m.name)}">${esc(m.name)}</b>
          <div class="id">${esc(m.id)}</div>
          <div class="meta">
            <span class="chip free">GRATIS</span>
            ${m.context ? `<span class="chip">ctx ${fmtCtx(m.context)}</span>` : ''}
            <span class="chip">${esc(m.provider)}</span>
          </div>
          <div class="model-actions">
            <button class="btn tiny primary adopt-btn" data-model="${esc(m.id)}" data-preset="${esc(crossPreset(m))}" data-name="${esc(m.name)}" ${usableKeyFor(crossPreset(m)) ? 'data-quick="1"' : ''}>${usableKeyFor(crossPreset(m)) ? 'Pakai langsung' : 'Pakai di agent'}</button>
            <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Provider ${icon('external')}</a>
          </div>
        </div>`).join('')}</div>
        ${crossFiltered.length > 120 ? `<p class="muted small" style="margin-top:12px">Menampilkan 120 dari ${crossFiltered.length} — gunakan pencarian.</p>` : ''}`
      : '<p class="muted">Sumber models.dev belum tersinkron — klik "Cek sekarang".</p>';

    $('#promo-catalog').innerHTML = `<div class="cat-grid">${state.catalog.map((c) => `
      <div class="cat-card">
        <b>${esc(c.name)}</b>
        <p>${esc(c.free)}</p>
        <p class="small">${esc(c.note || '')}</p>
        <div class="tags">${(c.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        <a class="btn primary tiny" href="${esc(c.url)}" target="_blank" rel="noreferrer">Daftar ${icon('external')}</a>
      </div>`).join('')}</div>`;

    const prov = state.snapshot?.sources?.list?.providers || [];
    $('#promo-list').innerHTML = prov.length
      ? prov.map((p) => `
        <div class="ftl-card">
          <h4>${esc(p.name)} <a href="${esc(p.url)}" target="_blank" rel="noreferrer">situs ${icon('external')}</a></h4>
          ${p.limits ? `<p class="small"><b>Limit:</b> ${esc(p.limits)}</p>` : ''}
          ${(p.notes || []).map((n) => `<p class="muted small">${esc(n)}</p>`).join('')}
          ${p.models.length ? `<div class="ftl-models">${p.models.map((m) => `<a href="${esc(m.url)}" target="_blank" rel="noreferrer">${esc(m.name)}</a>`).join('')}</div>` : ''}
          ${p.rows.length ? `<table class="ftl-table">${p.rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>` : ''}
        </div>`).join('')
      : '<p class="muted">Sumber GitHub belum tersinkron — klik "Cek sekarang".</p>';
  }

  // ---------- keys ----------
  function renderKeys() {
    const list = $('#keys-list');
    if (!state.keys.length) {
      list.innerHTML = '<div class="item"><div class="info muted">Belum ada API key. Tambahkan di atas — mis. Groq atau OpenRouter (gratis).</div></div>';
      return;
    }
    list.innerHTML = state.keys.map((k) => `
      <div class="item" data-id="${k.id}">
        <div class="info">
          <b>${esc(k.name)}</b> <span class="chip">${esc(k.preset)}</span>
          ${k.pool ? `<span class="chip pool-chip">${icon('shuffle')} pool</span>` : ''}<br>
          <span class="status ${esc(k.status)}">● ${esc(k.statusText || 'belum dicek')}</span>
          <div class="meta">${esc(k.baseUrl)} · key <code>${esc(k.keyMask)}</code>${k.latency ? ' · ' + k.latency + ' ms' : ''} · dicek ${fmtTime(k.lastChecked)}</div>
        </div>
        <div class="actions">
          <button class="btn tiny ${k.pool ? 'primary' : ''}" data-act="key-pool">${k.pool ? '✓ Pool' : '+ Pool'}</button>
          <button class="btn tiny" data-act="key-check">${icon('refresh')} Cek</button>
          <button class="btn tiny danger" data-act="key-del">Hapus</button>
        </div>
      </div>`).join('');
  }

  // ---------- gateway ----------
  function renderGateway() {
    const pool = state.pool || { members: [], active: 0, total: 0 };
    const members = pool.members || [];
    const totalReq = members.reduce((a, k) => a + (k.stats?.req || 0), 0);
    const totalErr = members.reduce((a, k) => a + (k.stats?.err || 0), 0);
    $('#pool-active').textContent = pool.active;
    $('#pool-active-foot').textContent = pool.total ? `dari ${pool.total} anggota pool` : 'belum ada anggota — aktifkan key → pool';
    $('#pool-req').textContent = totalReq;
    $('#pool-err').textContent = totalErr;

    const s = state.server;
    const gw = `${s.lanUrl.replace(/\/$/, '')}/v1`;
    $('#gw-url').textContent = gw;
    $('#gw-key').textContent = state.token;
    $('#gw-example').textContent =
`# curl
curl ${s.localUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${state.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"halo"}]}'

# env untuk agent CLI / SDK
OPENAI_BASE_URL=${gw}
OPENAI_API_KEY=${state.token}
OPENAI_MODEL=auto

# n8n / OpenAI SDK / agent lain
Base URL : ${gw}
API Key  : ${state.token}
Model    : auto  (atau groq/llama-3.3-70b-versatile, dst)`;

    const list = $('#pool-list');
    if (!members.length) {
      list.innerHTML = '<div class="item"><div class="info muted">Pool masih kosong. Buka tab API Keys → tombol "+ Pool" pada key yang valid.</div></div>';
    } else {
      list.innerHTML = members.map((k) => `
      <div class="item" data-id="${k.id}">
        <div class="info">
          <b>${esc(k.name)}</b> <span class="chip">${esc(k.preset)}</span>
          <span class="status ${esc(k.status)}">● ${esc(k.status)}</span>
          ${k.cooling ? `<span class="chip cool-chip">${icon('snow')} cooldown</span>` : ''}
          <div class="meta">model default: <code>${esc(k.poolModel || state.defaultModels?.[k.preset] || 'auto')}</code> · ${k.stats?.req || 0} req · ${k.stats?.err || 0} gagal · terakhir ${fmtTime(k.stats?.lastUsed)}</div>
        </div>
        <div class="actions pool-actions">
          <input class="prio-input" type="number" min="1" max="99" value="${k.priority}" title="Prioritas (kecil = didahulukan)">
          <input class="model-input" type="text" placeholder="model default" value="${esc(k.poolModel || '')}">
          <button class="btn tiny" data-act="pool-toggle">Keluar</button>
        </div>
      </div>`).join('');
    }

    api('/api/usage').then((usage) => {
      $('#usage-list').innerHTML = usage.map((u) => `
        <div class="mini-item"><span>${icon(u.id)} <b>${esc(u.label)}</b> <span class="muted small">${u.runs} run · ${u.failed} gagal${u.ok ? ' · avg ' + Math.round(u.avgMs / 100) / 10 + 's' : ''}</span></span><span class="chip">${u.type === 'pool' ? 'gateway' : 'CLI'}</span></div>`).join('');
    }).catch(() => {});
  }

  // ---------- agents ----------
  function renderAgents() {
    const list = $('#agents-list');
    if (!state.agents.length) {
      list.innerHTML = '<div class="item"><div class="info muted">Belum ada agent tersambung. Contoh: webhook n8n, endpoint LLM custom, atau API internal Anda.</div></div>';
      return;
    }
    list.innerHTML = state.agents.map((a) => {
      const hist = (a.history || []).slice(-20).map((h) => `<i class="${h.ok ? 'ok' : 'bad'}" title="${fmtTime(h.ts)} · ${h.ms} ms"></i>`).join('');
      return `
      <div class="item" data-id="${a.id}">
        <div class="info">
          <b>${esc(a.name)}</b> <span class="chip">${a.type === 'openai' ? 'LLM' : esc(a.method || 'GET')}</span>
          <span class="status ${esc(a.status)}">● ${esc(a.statusText || 'belum dicek')}</span>
          <div class="meta">${esc(a.type === 'openai' ? a.baseUrl : a.url)}</div>
          ${hist ? `<div class="hist">${hist}</div>` : ''}
          ${a.lastResponse && a.type === 'openai' ? `<div class="resp">${esc(a.lastResponse)}</div>` : ''}
          <div class="meta small">dicek ${fmtTime(a.lastChecked)}</div>
        </div>
        <div class="actions">
          <button class="btn tiny" data-act="agent-check">${icon('refresh')} Cek</button>
          <button class="btn tiny" data-act="agent-trigger">${icon('bolt')} Tes kirim</button>
          <button class="btn tiny danger" data-act="agent-del">Hapus</button>
        </div>
      </div>`;
    }).join('');
  }

  // ---------- alerts ----------
  function renderAlerts() {
    const list = $('#alerts-list');
    list.innerHTML = state.alerts.length
      ? state.alerts.map((a) => `
        <div class="alert-item ${a.read ? '' : 'unread'}">
          <time>${fmtTime(a.ts)}</time>
          <div class="t">${esc(a.title)}</div>
          <div class="d">${esc(a.detail || '')}</div>
        </div>`).join('')
      : '<p class="muted">Belum ada notifikasi.</p>';
  }

  // ---------- settings ----------
  // Shell ala halaman settings aplikasi agent: navigasi kategori di kiri
  // (dengan pencarian) + satu panel konten di kanan. Semua kategori berisi
  // data nyata dari state — tidak ada menu mati.
  const SETTINGS_SECTIONS = [
    ['providers', 'Penyedia', '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 8h.01M7 17h.01"/>'],
    ['models', 'Models', '<path d="M12 3.6l1.9 6.5 6.5 1.9-6.5 1.9-1.9 6.5-1.9-6.5L3.6 12l6.5-1.9z"/>'],
    ['connectors', 'Konektor', '<rect x="6" y="7" width="12" height="11" rx="3"/><path d="M9 7V4M15 7V4M3 11h3M18 11h3"/>'],
    ['projects', 'Proyek', '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>'],
    ['billing', 'Penagihan', '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/><path d="M7 15h4"/>'],
    ['preferences', 'Preferensi', '<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>'],
    ['appearance', 'Tampilan', '<path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3-3.5 3H16a2 2 0 0 0-2 2c0 1.5-.5 4-2 4z"/><circle cx="8.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/>'],
    ['notifications', 'Notifikasi', '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>'],
    ['privacy', 'Privasi', '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9.5 12l1.8 1.8 3.2-3.6"/>'],
    ['shortcuts', 'Pintasan', '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>'],
    ['phone', 'Ponsel', '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'],
    ['schedules', 'Jadwal', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'],
    ['server', 'Server', '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>'],
    ['desktop', 'Aplikasi desktop', '<rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M9 21h6M12 17v4"/>'],
    ['orchestra', 'Orchestrator', '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
    ['about', 'Tentang', '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'],
  ];
  let settingsPane = localStorage.getItem('ah_settings_pane') || 'preferences';
  // Kelompok nav ala halaman settings Kybern: Pribadi / Agent / Sistem.
  const SETTINGS_GROUPS = [
    ['Pribadi', ['preferences', 'appearance', 'notifications', 'privacy', 'shortcuts']],
    ['Agent', ['providers', 'models', 'connectors', 'projects', 'billing', 'schedules', 'orchestra']],
    ['Sistem', ['phone', 'server', 'desktop', 'about']],
  ];

  function renderSettingsNav(filter = '') {
    const host = $('#settings-nav');
    if (!host) return;
    const q = filter.trim().toLowerCase();
    const button = ([id, label, svg]) => `
      <button class="set-nav-item ${settingsPane === id ? 'active' : ''}" data-set-nav="${id}">
        ${svgIco(svg)}<span>${esc(label)}</span>
      </button>`;
    const grouped = SETTINGS_GROUPS.map(([group, ids]) => {
      const rows = SETTINGS_SECTIONS
        .filter(([id, label]) => ids.includes(id) && (!q || label.toLowerCase().includes(q)))
        .map(button).join('');
      return rows ? `<div class="set-group-label">${group}</div>${rows}` : '';
    }).join('');
    const rest = SETTINGS_SECTIONS
      .filter(([id, label]) => !SETTINGS_GROUPS.some(([, ids]) => ids.includes(id)) && (!q || label.toLowerCase().includes(q)))
      .map(button).join('');
    host.innerHTML = (grouped + (rest ? `<div class="set-group-label">Lainnya</div>${rest}` : ''))
      || '<p class="muted small" style="padding:6px 8px">Tidak ada bagian yang cocok.</p>';
    $$('#settings-nav .set-nav-item').forEach((b) => b.addEventListener('click', () => activateSettingsPane(b.dataset.setNav)));
  }

  function activateSettingsPane(id) {
    if (!SETTINGS_SECTIONS.some(([k]) => k === id)) return;
    settingsPane = id;
    localStorage.setItem('ah_settings_pane', id);
    $$('#view-settings .settings-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== id));
    $$('#settings-nav .set-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.setNav === id));
    if (id === 'schedules') renderSchedules();
    if (id === 'desktop') checkUpdates(true);
  }

  // ---------- dropdown custom untuk semua <select> ----------
  // Popup native tidak bisa mengikuti tema (aturan UI: kontrol memakai tema
  // sendiri). Select aslinya tetap di DOM (tersembunyi) supaya .value dan
  // event 'change' tetap bekerja untuk seluruh kode lama.
  let ddOutsideBound = false;
  function upgradeSelects() {
    for (const sel of $$('select')) {
      if (sel.dataset.dd) continue;
      sel.dataset.dd = '1';
      sel.classList.add('visually-hidden');
      const wrap = document.createElement('span');
      wrap.className = 'dd';
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dd-btn';
      const pop = document.createElement('div');
      pop.className = 'dd-pop hidden';
      wrap.appendChild(btn);
      wrap.appendChild(pop);
      const render = () => {
        const opts = [...sel.options].map((o) => ({ v: o.value, l: o.textContent }));
        const cur = opts.find((o) => o.v === sel.value);
        btn.innerHTML = (cur ? esc(cur.l) : esc(sel.value || '—')) + ' <span class="caret">▾</span>';
        pop.innerHTML = opts.map((o) => `
          <div class="dd-item ${o.v === sel.value ? 'active' : ''}" data-v="${esc(o.v)}">${esc(o.l)}</div>`).join('');
      };
      render();
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pop.classList.contains('hidden');
        $$('.dd-pop').forEach((p) => { if (p !== pop) p.classList.add('hidden'); });
        if (open) {
          render(); // opsi bisa berubah dinamis (engine/aturan/proyek)
          pop.classList.remove('hidden');
          const r = btn.getBoundingClientRect();
          const pw = Math.max(r.width, 250);
          pop.style.width = pw + 'px';
          pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 10)) + 'px';
          pop.style.top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - 340)) + 'px';
        }
      });
      pop.addEventListener('click', (e) => {
        const item = e.target.closest('.dd-item');
        if (!item) return;
        e.stopPropagation();
        sel.value = item.dataset.v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        render();
        pop.classList.add('hidden');
      });
      sel.addEventListener('change', render);
    }
    if (!ddOutsideBound) {
      ddOutsideBound = true;
      document.addEventListener('click', () => {
        $$('.dd-pop').forEach((p) => p.classList.add('hidden'));
      });
    }
  }
  upgradeSelects();

  // ---------- tema: Gelap / Terang / Sistem ----------
  const THEMES = [
    ['dark', 'Gelap', '<div class="theme-prev dark"><i></i><u></u></div>'],
    ['light', 'Terang', '<div class="theme-prev light"><i></i><u></u></div>'],
    ['system', 'Sistem', '<div class="theme-prev system"><i></i><u></u></div>'],
  ];
  function sysLight() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }
  function applyTheme() {
    const pref = localStorage.getItem('ah_theme') || 'dark';
    const eff = pref === 'system' ? (sysLight() ? 'light' : 'dark') : pref;
    document.documentElement.dataset.theme = eff;
    $$('#theme-cards .theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === pref));
    $$('#acct-theme-label').forEach((el) => { el.textContent = pref === 'system' ? 'Sistem' : (pref === 'light' ? 'Terang' : 'Gelap'); });
  }
  function renderThemeCards() {
    const host = $('#theme-cards');
    if (!host) return;
    const pref = localStorage.getItem('ah_theme') || 'dark';
    host.innerHTML = THEMES.map(([id, label, prev]) => `
      <button class="theme-card ${pref === id ? 'active' : ''}" data-theme-set="${id}">
        ${prev}<span>${label}</span>
      </button>`).join("");
    $$('#theme-cards .theme-card').forEach((b) => b.addEventListener('click', () => {
      localStorage.setItem('ah_theme', b.dataset.themeSet);
      applyTheme();
    }));
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
    applyTheme();
  }
  applyTheme();
  const ACCENTS = [
    ['#ef7d45', 'Oranye (bawaan)'],
    ['#4f8cff', 'Biru'],
    ['#3ecf8e', 'Hijau'],
    ['#a78bfa', 'Ungu'],
    ['#f5567b', 'Merah'],
  ];
  function applyAccent(color) {
    if (color) document.documentElement.style.setProperty('--accent', color);
    else document.documentElement.style.removeProperty('--accent');
    $$('#accent-swatches .accent-dot').forEach((d) => d.classList.toggle('active', d.dataset.accent === (color || '')));
  }

  function renderSettingsSummaries() {
    const kvRow = (a, b) => `<span>${esc(a)}</span><span>${esc(String(b))}</span>`;
    const keys = state.keys || [];
    const valid = keys.filter((k) => k.status === 'valid').length;
    const err = keys.filter((k) => k.status === 'error').length;
    $('#set-providers').innerHTML = [
      kvRow('Key tersimpan', keys.length),
      kvRow('Valid', valid),
      kvRow('Bermasalah', err),
      kvRow('Auto-pool', state.config?.autoPool !== false ? 'aktif' : 'mati'),
    ].join('');
    const pool = state.pool || { members: [], active: 0, total: 0 };
    $('#set-models').innerHTML = [
      kvRow('Provider di pool', pool.total ?? 0),
      kvRow('Siap dipakai', pool.active ?? 0),
      kvRow('Model default', state.config?.poolModel || 'auto'),
    ].join('');
    const agents = state.agents || [];
    const agentsOk = agents.filter((a) => a.status === 'ok').length;
    $('#set-connectors').innerHTML = [
      kvRow('Konektor tersimpan', agents.length),
      kvRow('Sehat', agentsOk),
      kvRow('Jadwal cek', `${state.config?.agentCheckMinutes ?? 15} menit`),
    ].join('');
    const projects = state.projects || [];
    $('#set-projects').innerHTML = projects.length
      ? projects.slice(0, 6).map((p) => kvRow(p.name, (p.folders || [])[0] || '')).join('') + (projects.length > 6 ? kvRow(`+${projects.length - 6} lain`, '') : '')
      : kvRow('Belum ada proyek', 'buat dari composer atau tombol Kelola');
    const pass = state?.promoPass || null;
    const phaseLabel = { available: 'bisa diklaim', pending: 'menunggu jadwal', active: 'aktif', expired: 'berakhir' };
    $('#set-billing').innerHTML = pass ? [
      kvRow('Plan', pass.planName),
      kvRow('Status', phaseLabel[pass.phase] || pass.phase),
      kvRow('Kuota', pass.quotaLabel),
      kvRow('Tingkat upgrade', `${pass.boosts || 0} × 50%`),
      kvRow('Reset harian', `pukul ${pass.resetLabel}`),
    ].join('')
      : kvRow('Plan', 'belum diklaim');
    $('#set-privacy').innerHTML = [
      kvRow('Penyimpanan', 'folder data lokal — tanpa cloud'),
      kvRow('Token akses', state.token ? 'aktif — semua /api/* terlindungi' : 'belum diatur'),
      kvRow('Key API di UI', 'selalu di-mask; nilai ber-mask ditolak saat dikirim'),
      kvRow('Cache offline', 'hanya kerangka UI — API tidak pernah di-cache'),
      kvRow('Telemetri', 'tidak ada'),
      kvRow('Tunnel publik', 'bawaan mati; satu klik untuk berhenti'),
    ].join('');
    $('#set-desktop').innerHTML = [
      kvRow('Mode jendela', 'Electron native + ikon tray'),
      kvRow('Menutup jendela', 'tidak menghentikan pemantauan'),
      kvRow('Jalankan saat PC menyala', 'dari menu tray'),
    ].join('');
    renderConnectorPulse();
  }

  // ---------- pulse konektor: denyut hidup per konektor ----------
  // Denyut = riwayat health check nyata (maks 60 entri per konektor):
  // titik status + sparkline latensi + tombol kirim pulse manual.
  function renderConnectorPulse() {
    const host = $('#connector-pulse');
    if (!host) return;
    const list = state.agents || [];
    if (!list.length) {
      host.innerHTML = '<p class="muted small" style="padding:8px 2px">Belum ada konektor. Tambahkan di tab Agent — denyut status & latensinya akan tampil di sini.</p>';
      return;
    }
    host.innerHTML = list.map((a) => {
      const hist = (a.history || []).slice(-20);
      const maxMs = Math.max(1, ...hist.map((h) => Number(h.ms) || 0));
      const bars = hist.map((h) => {
        const hpx = Math.max(4, Math.round(((Number(h.ms) || 0) / maxMs) * 18));
        return `<i class="${h.ok ? 'ok' : 'err'}" style="height:${hpx}px" title="${esc(new Date(h.ts).toLocaleString('id-ID'))} · ${h.ms} ms"></i>`;
      }).join('');
      const dot = (a.status === 'ok' || a.status === 'online') ? 'ok' : a.status === 'error' ? 'err' : 'idle';
      const when = a.lastChecked ? fmtScheduleWhen(a.lastChecked) : 'belum pernah';
      const latency = a.status === 'ok' && a.latency != null ? `${a.latency} ms` : (a.statusText || a.status || '—');
      return `
        <div class="pulse-row" data-agent="${esc(a.id)}">
          <span class="pulse-dot ${dot}" title="status: ${esc(a.status || 'unknown')}"></span>
          <div class="pulse-main">
            <b>${esc(a.name)}</b>
            <small>${esc(a.type)} · ${esc(String(latency))} · cek terakhir ${esc(when)}</small>
            <div class="pulse-spark">${bars || '<span class="muted small" style="padding:2px 0">belum ada riwayat pulse</span>'}</div>
          </div>
          <button class="pp-model-ico" data-pulse="${esc(a.id)}" title="Kirim pulse sekarang">${icon('bolt')}</button>
        </div>`;
    }).join('');
    $$('#connector-pulse [data-pulse]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/agents/${b.dataset.pulse}/check`, { method: 'POST' });
        toast('Pulse terkirim — hasil muncul saat probe selesai');
      } catch (e) { toast('Pulse gagal: ' + e.message); }
      b.disabled = false;
    }));
  }
  $('#btn-pulse-all').addEventListener('click', async () => {
    const chip = $('#pulse-status');
    try {
      const r = await api('/api/agents/check-all', { method: 'POST' });
      if (r.count) {
        chip?.classList.remove('hidden');
        if (chip) chip.textContent = `pulse dikirim ke ${r.count} konektor…`;
        toast(`Pulse dikirim ke ${r.count} konektor`);
        setTimeout(() => chip?.classList.add('hidden'), 6000);
      } else toast('Belum ada konektor untuk dipulse');
    } catch (e) { toast('Gagal: ' + e.message); }
  });

  // ---------- orchestrator: tim agent paralel ----------
  let orchCache = [];
  async function renderOrchestra() {
    const host = $('#orch-list');
    if (!host) return;
    try { orchCache = await api('/api/orchestra'); } catch { orchCache = []; }
    host.innerHTML = orchCache.map((o) => {
      const stCls = { running: 'run', reviewing: '', done: 'ok-chip', error: 'err-chip', idle: '', merging: 'run' }[o.state] || '';
      const agents = (o.agents || []).map((a) => {
        const cls = { ok: 'ok-chip', 'ci-failed': 'err-chip', error: 'err-chip', running: 'run', conflict: 'err-chip' }[a.status] || '';
        return `<div class="orch-agent"><span class="chip ${cls}">${esc(a.engineId)} · ${esc(a.status)}</span>${a.error ? `<small class="err-text">${esc(a.error)}</small>` : ''}</div>`;
      }).join("");
      const canMerge = o.state === 'reviewing' && (o.agents || []).some((a) => a.status === 'ok');
      return `<div class="orch-card" data-orch="${esc(o.id)}">
        <div class="orch-head"><b>${esc(o.name)}</b><span class="chip ${stCls}">${esc(o.state)}</span><span class="grow"></span>
          <button class="icon-btn" data-orch-del="${esc(o.id)}" title="Hapus">${icon('x')}</button></div>
        <div class="orch-agents">${agents}</div>
        <div class="orch-actions">
          ${o.state !== 'running' && o.state !== 'reviewing' ? `<button class="btn tiny primary" data-orch-run="${esc(o.id)}">Jalankan tim</button>` : ''}
          ${canMerge ? `<button class="btn tiny primary" data-orch-merge="${esc(o.id)}">Merge</button>` : ''}
          ${o.state === 'done' ? `<a class="btn tiny" href="/api/orchestra/${esc(o.id)}/patch?token=${esc(token)}" download>Unduh patch</a>` : ''}
        </div>
      </div>`;
    }).join("") || '<p class="muted small" style="padding:8px 2px">Belum ada orkestrasi. Buat di form di atas.</p>';
    $('#orch-list [data-orch-run]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/api/orchestra/${b.dataset.orchRun}/run`, { method: 'POST' }); toast('Tim agent dijalankan — pantau status di sini'); }
      catch (e) { toast(e.message); b.disabled = false; }
      renderOrchestra();
    }));
    $('#orch-list [data-orch-merge]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api(`/api/orchestra/${b.dataset.orchMerge}/merge`, { method: 'POST' }); toast('Digabung: ' + (r.merged || []).join(', ')); }
      catch (e) { toast(e.message); }
      renderOrchestra();
    }));
    $('#orch-list [data-orch-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/orchestra/${b.dataset.orchDel}`, { method: 'DELETE' });
      renderOrchestra();
    }));
  }
  $('#btn-orch-create').addEventListener('click', async () => {
    try {
      await api('/api/orchestra', { method: 'POST', body: JSON.stringify({
        name: $('#orch-name').value.trim(),
        prompt: $('#orch-prompt').value.trim(),
        agents: (engines || []).filter((e) => e.type === 'cli' && e.available).map((e) => e.id),
        baseDir: $('#orch-basedir').value.trim(),
        testCommand: $('#orch-ci').value.trim(),
      }) });
      toast('Orkestrasi dibuat');
      renderOrchestra();
    } catch (e) { toast(e.message); }
  });

  function renderSettings() {
    const c = state.config;
    $('#set-refresh').value = c.refreshHours;
    $('#set-agent').value = c.agentCheckMinutes;
    $('#set-keys').value = c.keyCheckHours;
    $('#set-notify').checked = !!c.notify;
    $('#set-autopool').checked = c.autoPool !== false;
    $('#set-token').textContent = state.token;
    const cf = $('#set-cloudflared');
    if (cf && document.activeElement !== cf) cf.value = c.cloudflaredPath || '';
    const s = state.server;
    $('#server-info').innerHTML = `
      <span>Nama host</span><span>${esc(s.hostname)}</span>
      <span>OS</span><span>${esc(s.platform)}</span>
      <span>Port</span><span>${s.port}</span>
      <span>URL lokal</span><span>${esc(s.localUrl)}</span>
      <span>URL LAN/HP</span><span>${esc(s.lanUrl)}</span>
      <span>Uptime</span><span>${Math.floor(s.uptimeMs / 60000)} menit</span>`;
    $('#phone-url').textContent = s.phoneUrl;
    $('#phone-url-pop').textContent = s.phoneUrl;
    $('#qr-box').innerHTML = '';
    try { new QRCode($('#qr-box'), { text: s.phoneUrl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.H }); } catch { }
    $('#qr-box-pop').innerHTML = '';
    try { new QRCode($('#qr-box-pop'), { text: s.phoneUrl, width: 190, height: 190, correctLevel: QRCode.CorrectLevel.H }); } catch { }
    renderSettingsSummaries();
    fillAbout();
    renderTunnel();
    $('#account-name').textContent = s.hostname || 'AgentHub';
  }

  // ---------- tunnel internet (data seluler) ----------
  function tunnelChipLabel(status) {
    return { stopped: 'tidak aktif', starting: 'menghubungkan…', online: 'aktif', error: 'gagal' }[status] || status;
  }

  function makeTunnelQr(host, boxSel, size) {
    const box = $(boxSel);
    if (!box) return;
    box.innerHTML = '';
    try { new QRCode(box, { text: `${host}/?token=${state.token}`, width: size, height: size, correctLevel: QRCode.CorrectLevel.H }); } catch { }
  }

  async function renderTunnel() {
    let t;
    try { t = await api('/api/tunnel'); } catch { return; }
    const chip = $('#tunnel-status');
    if (chip) {
      chip.textContent = tunnelChipLabel(t.status);
      chip.className = 'chip' + (t.status === 'online' ? ' ok-chip' : t.status === 'error' ? ' err-chip' : '');
    }
    const btn = $('#btn-tunnel-toggle');
    if (btn) btn.textContent = t.status === 'stopped' || t.status === 'error' ? 'Aktifkan tunnel' : 'Matikan tunnel';

    const body = $('#tunnel-body');
    if (body) {
      if (t.url) {
        body.innerHTML = `
          <div class="url-row"><code>${esc(t.url)}/?token=${esc(state.token)}</code><button class="btn tiny" id="btn-copy-tunnel">Salin</button></div>
          <div class="qr-frame"><div id="qr-box-tunnel"></div></div>`;
        makeTunnelQr(t.url, '#qr-box-tunnel', 160);
        $('#btn-copy-tunnel')?.addEventListener('click', () => navigator.clipboard?.writeText(`${t.url}/?token=${state.token}`).then(() => toast('Link internet disalin')));
      } else if (t.error) {
        body.innerHTML = `<p class="err small" style="margin-top:8px">${esc(t.error)}</p>`;
      } else if (t.status === 'starting') {
        body.innerHTML = '<p class="muted small" style="margin-top:8px">Menghubungkan ke Cloudflare…</p>';
      } else {
        body.classList.add('hidden');
      }
      if (t.url || t.error || t.status === 'starting') body.classList.remove('hidden');
    }

    const tb = $('#qr-tunnel-body');
    if (tb) {
      if (t.url) {
        tb.innerHTML = `
          <div class="qr-frame"><div id="qr-box-tunnel-pop"></div></div>
          <div class="url-row" style="margin-top:8px"><code>${esc(t.url)}/?token=${esc(state.token)}</code><button class="btn tiny" id="btn-copy-tunnel-pop">Salin</button></div>`;
        makeTunnelQr(t.url, '#qr-box-tunnel-pop', 148);
        $('#btn-copy-tunnel-pop')?.addEventListener('click', () => navigator.clipboard?.writeText(`${t.url}/?token=${state.token}`).then(() => toast('Link internet disalin')));
      } else if (t.status === 'starting') {
        tb.innerHTML = '<p class="muted small">Menghubungkan tunnel…</p>';
      } else {
        tb.innerHTML = '<p class="muted small">Belum aktif — nyalakan di Pengaturan untuk akses via data seluler.</p>';
      }
    }
    return t;
  }

  async function toggleTunnel(enable) {
    try {
      await api('/api/tunnel', { method: 'POST', body: JSON.stringify({ enabled: enable }) });
    } catch (e) { toast('Gagal: ' + e.message); }
    await renderTunnel();
    if (enable) {
      // tunggu URL tunnel muncul (maks ~25 detik)
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 1600));
        const t = await renderTunnel();
        if (!t || t.status === 'online' || t.status === 'error' || t.status === 'stopped') break;
      }
    }
  }
  $('#btn-tunnel-toggle').addEventListener('click', () => {
    const enabling = $('#btn-tunnel-toggle').textContent.startsWith('Aktifkan');
    toggleTunnel(enabling);
  });
  $('#btn-cloudflared-save').addEventListener('click', async () => {
    try {
      await api('/api/tunnel', { method: 'POST', body: JSON.stringify({ enabled: false, cloudflaredPath: $('#set-cloudflared').value.trim() }) });
      toast('Path cloudflared disimpan');
    } catch (e) { toast('Gagal: ' + e.message); }
  });
  $('#btn-copy-url-pop').addEventListener('click', () => navigator.clipboard?.writeText($('#phone-url-pop').textContent).then(() => toast('URL HP disalin')));

  // ---------- PWA: instal ke layar utama (Android & iOS) ----------
  // iPhone tidak punya beforeinstallprompt — jalannya lewat "Tambahkan ke
  // Layar Utama" di Safari, jadi hint-nya ditukar berdasarkan platform.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIos) {
    $('#pwa-hint')?.classList.add('hidden');
    $('#pwa-hint-ios')?.classList.remove('hidden');
  }
  let pwaPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pwaPrompt = e;
    $('#btn-pwa-install')?.classList.remove('hidden');
    const hint = $('#pwa-hint');
    if (hint) hint.textContent = 'Pasang AgentHub seperti aplikasi biasa — ikon di layar utama, mode fullscreen.';
  });
  $('#btn-pwa-install').addEventListener('click', async () => {
    if (!pwaPrompt) return;
    pwaPrompt.prompt();
    const { outcome } = await pwaPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome === 'accepted') toast('AgentHub dipasang di layar utama');
    pwaPrompt = null;
    $('#btn-pwa-install').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    $('#btn-pwa-install')?.classList.add('hidden');
    toast('AgentHub terpasang sebagai aplikasi');
  });

  // ---------- aksi list ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.item')?.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'key-check') { btn.disabled = true; await api(`/api/keys/${id}/check`, { method: 'POST' }); toast('Key diperiksa'); }
      if (act === 'key-del') {
        const ok = await askConfirm('Hapus API key ini?', { title: 'Hapus API key?', okLabel: 'Hapus', danger: true });
        if (ok) await api(`/api/keys/${id}`, { method: 'DELETE' });
      }
      if (act === 'key-pool') {
        const k = state.keys.find((x) => x.id === id);
        await api(`/api/keys/${id}/pool`, { method: 'POST', body: JSON.stringify({ pool: !k.pool }) });
        toast(k.pool ? 'Key dikeluarkan dari pool' : 'Key masuk pool gateway');
      }
      if (act === 'pool-toggle') { await api(`/api/keys/${id}/pool`, { method: 'POST', body: JSON.stringify({ pool: false }) }); toast('Key dikeluarkan dari pool'); }
      if (act === 'agent-check') { btn.disabled = true; await api(`/api/agents/${id}/check`, { method: 'POST' }); toast('Agent diperiksa'); }
      if (act === 'agent-trigger') {
        btn.disabled = true;
        const r = await api(`/api/agents/${id}/trigger`, { method: 'POST' });
        toast('Tes: ' + (r.statusText || r.status));
      }
      if (act === 'agent-del') {
        const ok = await askConfirm('Hapus agent ini?', { title: 'Hapus agent?', okLabel: 'Hapus', danger: true });
        if (ok) await api(`/api/agents/${id}`, { method: 'DELETE' });
      }
      await loadState();
    } catch (err) {
      toast(err.message === 'AUTH' ? 'Sesi habis' : 'Gagal: ' + err.message);
    } finally { btn.disabled = false; }
  });

  document.addEventListener('change', async (e) => {
    const item = e.target.closest('.pool-actions');
    if (!item) return;
    const id = item.closest('.item')?.dataset.id;
    const patch = {};
    if (e.target.classList.contains('prio-input')) patch.priority = +e.target.value;
    if (e.target.classList.contains('model-input')) patch.poolModel = e.target.value;
    if (Object.keys(patch).length === 0) return;
    try { await api(`/api/keys/${id}/pool`, { method: 'POST', body: JSON.stringify(patch) }); }
    catch (err) { toast('Gagal: ' + err.message); }
  });

  // ---------- form: key ----------
  const presetSel = $('#key-preset');
  function fillPresets() {
    if (!state) return;
    const cur = presetSel.value;
    presetSel.innerHTML = Object.entries(state.keyPresets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    if (cur) presetSel.value = cur;
  }
  presetSel.addEventListener('change', () => {
    const p = state.keyPresets[presetSel.value];
    $('#key-url').value = p.baseUrl || '';
    $('#key-name').value = p.label === 'Custom (OpenAI-compatible)' ? '' : p.label;
    const a = $('#key-signup');
    if (p.signup) { a.href = p.signup; a.classList.remove('hidden'); } else a.classList.add('hidden');
  });
  $('#form-key').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { preset: presetSel.value, name: $('#key-name').value.trim(), baseUrl: $('#key-url').value.trim(), key: $('#key-value').value.trim() };
    if (!body.key) return toast('Isi API key-nya dulu');
    try {
      $('#form-key .primary').disabled = true;
      await api('/api/keys', { method: 'POST', body: JSON.stringify(body) });
      $('#key-value').value = '';
      toast('Key disimpan & divalidasi');
      await loadState();
    } catch (err) { toast('Gagal: ' + err.message); }
    finally { $('#form-key .primary').disabled = false; }
  });

  // ---------- form: agent ----------
  const agentType = $('#agent-type');
  agentType.addEventListener('change', () => {
    const openai = agentType.value === 'openai';
    $$('.webhook-only').forEach((el) => el.classList.toggle('hidden', openai));
    $$('.openai-only').forEach((el) => el.classList.toggle('hidden', !openai));
  });
  $('#form-agent').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('#agent-name').value.trim(),
      type: agentType.value,
      url: $('#agent-url').value.trim(),
      baseUrl: $('#agent-base').value.trim(),
      method: $('#agent-method').value,
      body: $('#agent-body').value.trim(),
      key: $('#agent-key').value.trim(),
      model: $('#agent-model').value.trim(),
    };
    try {
      $('#form-agent .primary').disabled = true;
      await api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Agent tersambung');
      await loadState();
    } catch (err) { toast('Gagal: ' + err.message); }
    finally { $('#form-agent .primary').disabled = false; }
  });

  // ---------- promo aksi ----------
  $('#btn-promo-refresh').addEventListener('click', async (e) => {
    if (promoStatus === 'refreshing') return;
    setPromo('refreshing');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.dataset.label ??= btn.textContent;
    btn.textContent = PROMO_MACHINE.states.refreshing;
    try {
      const r = await api('/api/promo/refresh', { method: 'POST' });
      setPromo(r?.state === 'error' ? 'error' : 'ready');
      toast(r?.shared ? 'Refresh yang sama sedang berjalan — memakai hasilnya' : 'Sumber promo diperbarui');
      await loadState();
    } catch (err) {
      setPromo('error');
      toast('Gagal: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = btn.dataset.label;
      setTimeout(() => { if (promoStatus === 'ready') setPromo('idle'); }, 1500);
    }
  });
  $('#promo-search').addEventListener('input', (e) => {
    promoQuery = e.target.value;
    if (state) renderPromo();
  });
  $$('.seg-btn[data-pane]').forEach((b) => b.addEventListener('click', () => setPromoPane(b.dataset.pane)));
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    promoTab = t.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    ['live', 'cross', 'catalog', 'list'].forEach((name) => {
      const el = $(`#promo-${name}`);
      if (el) el.classList.toggle('hidden', promoTab !== name);
    });
  }));

  // ---------- alerts ----------
  let readTimer = null;
  function markReadSoon() { clearTimeout(readTimer); readTimer = setTimeout(() => api('/api/alerts/read', { method: 'POST' }).then(loadState).catch(() => {}), 1200); }
  $('#btn-read-all').addEventListener('click', () => markReadSoon());

  // ---------- settings ----------
  // shell navigasi settings
  $('#settings-search').addEventListener('input', (e) => renderSettingsNav(e.target.value));
  $('#btn-settings-back').addEventListener('click', () => go('studio'));
  $$('[data-settings-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.settingsGo)));
  $('#set-open-projects').addEventListener('click', () => { renderProjectPicker(); setLayer('project'); });

  // tampilan: swatch aksen
  $('#accent-swatches').innerHTML = ACCENTS.map(([color, label]) => `
    <button class="accent-dot" data-accent="${color}" title="${esc(label)}" aria-label="Aksen ${esc(label)}" style="background:${color}"></button>`).join('');
  $$('#accent-swatches .accent-dot').forEach((b) => b.addEventListener('click', () => {
    localStorage.setItem('ah_accent', b.dataset.accent);
    applyAccent(b.dataset.accent);
  }));
  applyAccent(localStorage.getItem('ah_accent') || '');

  // notifikasi: toggle langsung simpan + tes toast
  $('#set-notify').addEventListener('change', async (e) => {
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ notify: e.target.checked }) });
      toast(e.target.checked ? 'Notifikasi aktif' : 'Notifikasi dimatikan');
    } catch { e.target.checked = !e.target.checked; }
  });
  $('#btn-test-toast').addEventListener('click', () => toast('Tes notifikasi — ini tampilannya.', 4000));

  // tentang: versi aplikasi + versi kontrak mesin
  let machinesVersion = null;
  function fillAbout() {
    const el = $('#set-about');
    if (!el || !machinesVersion) return;
    el.innerHTML = `
      <span>Aplikasi</span><span>AgentHub v${esc(state?.server?.version || '?')}</span>
      <span>Kontrak mesin</span><span>v${esc(machinesVersion)}</span>
      <span>Lisensi</span><span>MIT</span>`;
  }
  api('/api/version').then((v) => {
    machinesVersion = v.machines;
    fillAbout();
  }).catch((e) => {
    const el = $('#set-about');
    if (el) el.innerHTML = `<span></span><span class="muted small">Info versi gagal dimuat: ${esc(e.message)}</span>`;
  });

  // aktifkan pane tersimpan saat boot
  renderSettingsNav();
  renderThemeCards();
  activateSettingsPane(settingsPane);

  // ---------- jadwal (scheduled runs) ----------
  let schedCache = [];
  const fmtScheduleWhen = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const schedModeLabel = (s) => (s.mode === 'daily' ? `harian ${s.dailyAt}` : `tiap ${s.intervalMinutes} menit`);

  function fillScheduleEngines() {
    const sel = $('#sched-engine');
    if (!sel || sel.options.length) return;
    sel.innerHTML = engines.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join('');
  }

  async function renderSchedules() {
    const host = $('#sched-rows');
    if (!host) return;
    fillScheduleEngines();
    try { schedCache = await api('/api/schedules'); } catch { schedCache = []; }
    host.innerHTML = schedCache.map((s) => `
      <div class="sched-row ${s.enabled ? '' : 'off'}" data-sched="${esc(s.id)}">
        <div class="sched-main">
          <b>${esc(s.name)}</b>
          <small>${esc(s.engine)} · ${esc(schedModeLabel(s))} · ${s.enabled ? `berikutnya ${esc(fmtScheduleWhen(s.nextRunAt))}` : 'nonaktif'}</small>
          ${s.lastStatus === 'error' ? `<small class="sched-err">terakhir gagal: ${esc(s.lastError || '?')}</small>` : ''}
        </div>
        <div class="sched-acts">
          ${s.threadId ? `<button class="pp-model-ico" data-sact="open" title="Buka thread hasil">${icon('external')}</button>` : ''}
          <button class="pp-model-ico" data-sact="run" title="Jalankan sekarang">${icon('bolt')}</button>
          <button class="pp-model-ico ${s.enabled ? 'on' : ''}" data-sact="toggle" title="${s.enabled ? 'Nonaktifkan' : 'Aktifkan'}">${icon('check')}</button>
          <button class="pp-model-ico" data-sact="del" title="Hapus jadwal">${icon('x')}</button>
        </div>
      </div>`).join('') || '<p class="muted small" style="padding:6px 2px">Belum ada jadwal. Buat lewat form di atas.</p>';
    $$('#sched-rows [data-sact]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.closest('[data-sched]').dataset.sched;
      const act = b.dataset.sact;
      if (act === 'open') {
        const s = schedCache.find((x) => x.id === id);
        if (s?.threadId) { go('studio'); openThread(s.threadId); }
        return;
      }
      if (act === 'del') {
        await api(`/api/schedules/${id}`, { method: 'DELETE' });
        toast('Jadwal dihapus');
      } else if (act === 'toggle') {
        const s = schedCache.find((x) => x.id === id);
        await api(`/api/schedules/${id}`, { method: 'POST', body: JSON.stringify({ enabled: !s.enabled }) });
      } else if (act === 'run') {
        await api(`/api/schedules/${id}/run`, { method: 'POST' });
        toast('Jadwal dijalankan — cek thread hasilnya');
      }
      renderSchedules();
    }));
  }
  $('#sched-mode').addEventListener('change', (e) => {
    $('#sched-interval-wrap').classList.toggle('hidden', e.target.value === 'daily');
    $('#sched-daily-wrap').classList.toggle('hidden', e.target.value !== 'daily');
  });
  $('#form-schedule').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#sched-name').value.trim(),
          prompt: $('#sched-prompt').value.trim(),
          engine: $('#sched-engine').value,
          mode: $('#sched-mode').value,
          intervalMinutes: +$('#sched-interval').value || 60,
          dailyAt: $('#sched-daily').value || '09:00',
        }),
      });
      $('#sched-name').value = '';
      $('#sched-prompt').value = '';
      toast('Jadwal dibuat — server akan menjalankannya otomatis');
      renderSchedules();
    } catch (err) { toast(err.message); }
  });
  $('#btn-sched-refresh').addEventListener('click', renderSchedules);

  // ---------- cadangan & pulihkan ----------
  $('#btn-backup-download').href = `/api/backup?token=${encodeURIComponent(token)}`;
  $('#btn-restore-pick').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let bundle;
    try { bundle = JSON.parse(await file.text()); } catch { toast('Berkas bukan JSON valid'); e.target.value = ''; return; }
    const ok = await askConfirm('Pulihkan menimpa key, thread, tugas, catatan, proyek, dan jadwal dengan isi berkas cadangan. Lanjut?', {
      title: 'Pulihkan cadangan?',
      okLabel: 'Pulihkan',
      danger: true,
    });
    if (!ok) { e.target.value = ''; return; }
    try {
      const r = await api('/api/restore', { method: 'POST', body: JSON.stringify(bundle) });
      $('#restore-status').textContent = `Berhasil dipulihkan: ${r.restored.join(', ')}`;
      toast('Cadangan dipulihkan');
      await loadState();
    } catch (err) { toast('Gagal pulihkan: ' + err.message); }
    e.target.value = '';
  });

  // ---------- menu akun: profil perangkat, tema, zoom, pintasan ----------
  const ZOOMS = [90, 100, 125, 150];
  function applyZoom(pct) {
    // zoom CSS bekerja di Chromium (shell desktop) & Firefox modern;
    // fallback font-size untuk engine tanpa zoom.
    const root = document.documentElement;
    root.style.zoom = pct === 100 ? '' : String(pct / 100);
    root.style.fontSize = pct === 100 ? '' : `${16 * (pct / 100)}px`;
    $$('#account-zoom .zoom-opt').forEach((b) => b.classList.toggle('active', Number(b.dataset.zoom) === pct));
  }
  function renderAccount() {
    const srv = state?.server || {};
    $('#account-host').textContent = srv.hostname || 'AgentHub';
    $('#account-id').textContent = srv.instanceId || '…';
    $('#account-themes').innerHTML = ACCENTS.map(([color, label]) => `
      <button class="accent-dot" data-accent="${color}" title="${esc(label)}" aria-label="Aksen ${esc(label)}" style="background:${color}"></button>`).join('');
    $$('#account-themes .accent-dot').forEach((b) => b.addEventListener('click', () => {
      localStorage.setItem('ah_accent', b.dataset.accent);
      applyAccent(b.dataset.accent);
    }));
    const current = Number(localStorage.getItem('ah_zoom')) || 100;
    $('#account-zoom').innerHTML = ZOOMS.map((z) => `
      <button class="zoom-opt ${current === z ? 'active' : ''}" data-zoom="${z}">${z}%</button>`).join('');
    $$('#account-zoom .zoom-opt').forEach((b) => b.addEventListener('click', () => {
      const z = Number(b.dataset.zoom);
      localStorage.setItem('ah_zoom', String(z));
      applyZoom(z);
    }));
    applyAccent(localStorage.getItem('ah_accent') || '');
    applyZoom(current);
  }
  $('#sb-account').addEventListener('click', () => {
    if (layer === 'account') setLayer(null);
    else { renderAccount(); setLayer('account'); positionPop('#account-pop', '#sb-account'); }
  });
  $('#btn-account-copy-id').addEventListener('click', () => {
    const id = $('#account-id').textContent;
    navigator.clipboard?.writeText(id)
      .then(() => toast('ID perangkat disalin'))
      .catch(() => toast(`ID perangkat: ${id}`, 6000));
  });
  $('#acct-theme').addEventListener('click', () => {
    const order = ['dark', 'light', 'system'];
    const cur = localStorage.getItem('ah_theme') || 'dark';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    localStorage.setItem('ah_theme', next);
    applyTheme();
    toast('Mode tampilan: ' + (next === 'system' ? 'ikuti sistem' : next === 'light' ? 'terang' : 'gelap'));
  });
  $('#acct-usage').addEventListener('click', () => { setLayer(null); $('#rail-usage').click(); });
  $('#acct-upgrade').addEventListener('click', () => { setLayer(null); go('promo'); });
  $('#acct-share').addEventListener('click', () => { setLayer(null); sharePromoPass(); });
  $('#acct-disconnect').addEventListener('click', () => {
    setLayer(null);
    go('settings');
    activateSettingsPane('server');
    toast('Putuskan perangkat lain: regenerate token akses di pane Server');
  });

  // ---------- cek pembaruan (GitHub Releases) ----------
  function renderUpdateStatus(u) {
    const host = $('#update-status');
    const open = $('#btn-update-open');
    if (!host) return;
    $('#update-current').textContent = u.current || '…';
    if (!u.ok) {
      host.innerHTML = `Gagal memeriksa: ${esc(u.error)} — coba lagi nanti (GitHub API berbagi batas 60 permintaan/jam per IP).`;
      open?.classList.add('hidden');
      return;
    }
    if (u.hasUpdate) {
      const when = u.publishedAt ? new Date(u.publishedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      host.innerHTML = `<b style="color:var(--accent)">Versi baru tersedia: ${esc(u.latest)}</b> — Anda di ${esc(u.current)}${when ? ` · rilis ${esc(when)}` : ''}.`
        + (u.notes ? `<div class="muted small" style="margin-top:4px;white-space:pre-wrap">${esc(u.notes.slice(0, 300))}${u.notes.length > 300 ? '…' : ''}</div>` : '');
      open?.classList.remove('hidden');
      if (open) open.href = u.url || 'https://github.com/khadijahcollege-afk/AgentHub/releases/latest';
    } else {
      host.innerHTML = `Sudah versi terbaru (${esc(u.current)}).`;
      open?.classList.add('hidden');
    }
  }
  async function checkUpdates(silent = false) {
    const btn = $('#btn-update-check');
    if (btn) { btn.disabled = true; btn.textContent = 'Memeriksa…'; }
    const host = $('#update-status');
    if (!silent && host) host.textContent = 'Memeriksa GitHub Releases…';
    try {
      const u = await api('/api/update-check');
      renderUpdateStatus(u);
    } catch (e) {
      renderUpdateStatus({ ok: false, current: state?.server?.version, error: e.message });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Cek pembaruan'; }
    }
  }
  $('#btn-update-check').addEventListener('click', () => checkUpdates(false));

  // ---------- integrasi: satu tempat melihat & menghubungkan layanan ----------
  // "Terhubung" dihitung dari state nyata: key tersimpan (badge = mask key),
  // engine CLI yang terdeteksi di PATH, konektor, dan tunnel. "Populer" =
  // preset yang belum punya key — klik langsung membawa ke form key dengan
  // preset terpilih. Setiap baris punya aksi sungguhan.
  let intgActions = [];
  function intgSection(title, list) {
    const rows = list.map((r, i) => {
      const idx = intgActions.push(r.action) - 1;
      return `
        <button class="intg-row" data-intg-act="${idx}">
          <span class="intg-mark">${esc((r.name || '?')[0].toUpperCase())}</span>
          <span class="intg-name">${esc(r.name)}</span>
          ${r.badge ? `<span class="intg-badge">${esc(r.badge)}</span>` : ''}
          ${r.hint ? `<span class="intg-hint">${esc(r.hint)}</span>` : ''}
        </button>`;
    }).join('');
    return rows ? `<div class="intg-section"><div class="intg-label">${title}</div>${rows}</div>` : '';
  }
  function intgMatches(q, ...fields) {
    if (!q) return true;
    return fields.some((f) => String(f || '').toLowerCase().includes(q));
  }
  function intgBuild(filter = '') {
    const q = filter.trim().toLowerCase();
    intgActions = [];
    const keysByPreset = new Map();
    for (const k of state.keys || []) {
      keysByPreset.set(k.preset, [...(keysByPreset.get(k.preset) || []), k]);
    }
    const connected = [
      ...[...keysByPreset.entries()].map(([presetId, keys]) => ({
        name: state.keyPresets?.[presetId]?.label || presetId,
        badge: keys.length === 1 ? (keys[0].keyMask || keys[0].name || 'key') : `${keys.length} key`,
        action: () => { setLayer(null); go('keys'); },
      })),
      ...(engines || []).filter((e) => e.type === 'cli' && e.available).map((e) => ({
        name: e.label, badge: 'CLI terpasang',
        action: () => { setLayer(null); go('gateway'); },
      })),
      ...(state.agents || []).map((a) => ({
        name: a.name || 'Konektor', badge: a.status === 'ok' ? 'sehat' : String(a.status || 'webhook'),
        action: () => { setLayer(null); go('agents'); },
      })),
    ].filter((r) => intgMatches(q, r.name, r.badge));
    const popular = [
      ...Object.entries(state.keyPresets || {})
        .filter(([presetId]) => !keysByPreset.has(presetId))
        .map(([presetId, p]) => ({
          name: p.label, badge: '', hint: 'tambah key',
          action: () => {
            setLayer(null);
            go('keys');
            const sel = $('#key-preset');
            if (sel) { sel.value = presetId; sel.dispatchEvent(new Event('change')); }
            $('#key-value')?.focus();
          },
        })),
      ...(engines || []).filter((e) => e.type === 'cli' && !e.available).map((e) => ({
        name: e.label, badge: 'CLI tidak ada di PATH', hint: '',
        action: () => toast(`Pasang ${e.label} lalu pastikan perintahnya ada di PATH`),
      })),
    ].filter((r) => intgMatches(q, r.name, r.badge, r.hint));
    const tunnelLabel = { stopped: 'mati', starting: 'menyala…', online: 'online', error: 'gagal' }[state.tunnel?.status] || 'mati';
    const services = [
      { name: 'Tunnel internet (data seluler)', badge: tunnelLabel, action: () => { setLayer(null); go('settings'); activateSettingsPane('phone'); } },
      { name: 'Bookmark environment', badge: `${(state.environments || []).length} tersimpan`, action: () => { setLayer(null); $('#rail-env')?.click(); } },
    ].filter((r) => intgMatches(q, r.name, r.badge));
    const html = [
      intgSection('Terhubung', connected),
      intgSection('Populer', popular),
      intgSection('Layanan', services),
    ].join('') || '<p class="muted small" style="padding:10px 4px">Tidak ada layanan yang cocok.</p>';
    $('#intg-body').innerHTML = html;
    $$('#intg-body .intg-row').forEach((row) => row.addEventListener('click', () => {
      const fn = intgActions[Number(row.dataset.intgAct)];
      fn?.();
    }));
  }
  function openIntegrations() {
    $('#intg-search').value = '';
    intgBuild('');
    setLayer('integrations');
    setTimeout(() => $('#intg-search').focus(), 60);
  }
  $('#sbm-integrations').addEventListener('click', () => { setLayer(null); openIntegrations(); });
  $('#btn-intg-close').addEventListener('click', () => setLayer(null));
  $('#intg-search').addEventListener('input', (e) => intgBuild(e.target.value));

  // ---------- menu alat composer ----------
  // Hanya alat yang benar-benar ada: lampiran, jadwal (menyuntikkan prompt
  // composer ke form jadwal), template riset, pustaka prompt, delegation.
  const RESEARCH_TEMPLATE = `Riset mendalam di folder kerja ini:
1. Kumpulkan fakta dari berkas relevan (@sebutkan folder/file penting).
2. Susun ringkasan bertingkat: poin utama → detail → risiko/keputusan.
3. Tandai setiap klaim dengan sumber berkasnya.
Jangan mengarang — bila data tidak ada di folder, katakan tidak ada.`;
  $('#btn-tools').addEventListener('click', () => {
    if (layer === 'tools') setLayer(null);
    else { setLayer('tools'); positionPop('#tools-pop', '#btn-tools'); }
  });
  $('#tool-attach').addEventListener('click', () => { setLayer(null); $('#attach-input').click(); });
  $('#tool-prompts').addEventListener('click', () => { setLayer('prompts'); renderPrompts(); positionPop('#prompts-pop', '#composer'); });
  $('#tool-research').addEventListener('click', () => {
    const ta = $('#composer-input');
    ta.value = RESEARCH_TEMPLATE;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setLayer(null);
    ta.focus();
    toast('Template riset mendalam dimuat — sesuaikan @folder lalu kirim');
  });
  $('#tool-schedule').addEventListener('click', () => {
    const prompt = ($('#composer-input').value || '').trim();
    setLayer(null);
    go('settings');
    activateSettingsPane('schedules');
    if (prompt) {
      $('#sched-prompt').value = prompt;
      if (!$('#sched-name').value) $('#sched-name').value = prompt.split('\n')[0].slice(0, 60);
    }
    $('#sched-prompt')?.focus();
    toast(prompt ? 'Prompt composer disuntik ke form jadwal' : 'Isi prompt jadwal di form');
  });
  $('#tool-delegate').addEventListener('click', () => {
    setLayer(null);
    document.querySelector('[data-open-delegate]')?.click();
  });

  // ---------- pintasan keyboard: Ctrl+/ daftar yang bisa diklik ----------
  function openPalette() {
    if (layer === 'palette') { setLayer(null); return; }
    setLayer('palette');
    renderPalette();
    const pop = $('#palette-pop');
    if (pop) {
      pop.style.right = 'auto'; pop.style.bottom = 'auto';
      pop.style.left = `${Math.max(8, Math.round((window.innerWidth - pop.offsetWidth) / 2))}px`;
      pop.style.top = '56px';
    }
    $('#palette-input')?.focus();
  }
  function focusComposerWith(ch) {
    const ta = $('#composer-input');
    if (!ta) return;
    ta.focus();
    if (ch && !ta.value.endsWith(ch)) ta.value += ch;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const SHORTCUTS = [
    { keys: 'Ctrl K', label: 'Palet perintah', run: () => { setLayer(null); openPalette(); } },
    { keys: 'Ctrl 8', label: 'Toggle sidebar', run: () => $('#btn-side-toggle').click() },
    { keys: 'Ctrl F', label: 'Cari di thread', run: () => toggleFind() },
    { keys: 'Alt N', label: 'Chat baru', run: () => $('#btn-new-chat').click() },
    { keys: '@', label: 'Sisipkan file / folder kerja', run: () => focusComposerWith('@') },
    { keys: '/', label: 'Perintah slash', run: () => focusComposerWith('/') },
    { keys: 'Ctrl /', label: 'Daftar pintasan ini', run: () => {} },
    { keys: 'Esc', label: 'Tutup popover / overlay', run: () => setLayer(null) },
  ];
  function openShortcuts() {
    $('#shortcuts-rows').innerHTML = SHORTCUTS.map((s, i) => `
      <button class="sc-row" data-sc="${i}"><kbd>${esc(s.keys)}</kbd><span>${esc(s.label)}</span></button>`).join('');
    $$('#shortcuts-rows .sc-row').forEach((b) => b.addEventListener('click', () => {
      const s = SHORTCUTS[Number(b.dataset.sc)];
      setLayer(null);
      s.run?.();
    }));
    setLayer('shortcuts');
  }
  $('#btn-sc-close').addEventListener('click', () => setLayer(null));

  // ---------- pencarian dalam thread (Ctrl+F) ----------
  let findHits = [];
  let findIdx = 0;
  function toggleFind() {
    const bar = $('#find-bar');
    if (!bar) return;
    const opening = bar.classList.contains('hidden');
    bar.classList.toggle('hidden', !opening);
    if (opening) {
      $('#find-input')?.focus();
      renderFind();
    } else clearFindHits();
  }
  function clearFindHits() {
    findHits = [];
    $('#find-count').textContent = '';
    $('#chat-messages .msg.find-hit').forEach((el) => el.classList.remove('find-hit'));
  }
  function renderFind() {
    const q = ($('#find-input').value || '').trim().toLowerCase();
    const msgs = (curThread?.messages || []).filter((m) => !m.subrun);
    findHits = q ? msgs.filter((m) => String(m.content || '').toLowerCase().includes(q)).map((m) => m.id) : [];
    findIdx = 0;
    $('#find-count').textContent = q ? (findHits.length ? `${findIdx + 1}/${findHits.length} pesan` : 'tidak ada') : '';
    if (q) jumpToHit(); else clearFindHits();
  }
  function jumpToHit() {
    $$('#chat-messages .msg.find-hit').forEach((el) => el.classList.remove('find-hit'));
    if (!findHits.length) return;
    const id = findHits[findIdx % findHits.length];
    const el = document.querySelector(`#chat-messages .msg[data-mid="${id}"]`);
    if (el) {
      el.classList.add('find-hit');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  $('#find-input').addEventListener('input', renderFind);
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findIdx++; jumpToHit(); renderFindCount(); }
    if (e.key === 'Escape') { toggleFind(); }
  });
  function renderFindCount() {
    $('#find-count').textContent = findHits.length ? `${((findIdx - 1) % findHits.length + findHits.length) % findHits.length + 1}/${findHits.length} pesan` : 'tidak ada';
  }
  $('#find-close').addEventListener('click', () => toggleFind());

  $('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          notify: $('#set-notify').checked,
          autoPool: $('#set-autopool').checked,
          refreshHours: +$('#set-refresh').value,
          agentCheckMinutes: +$('#set-agent').value,
          keyCheckHours: +$('#set-keys').value,
        }),
      });
      toast('Pengaturan disimpan');
      await loadState();
    } catch (err) { toast('Gagal: ' + err.message); }
  });
  $('#btn-regen').addEventListener('click', async () => {
    const ok = await askConfirm('Token baru menggantikan yang lama — HP harus scan ulang QR. Lanjut?', {
      title: 'Perbarui token?',
      okLabel: 'Perbarui token',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api('/api/settings/regenerate-token', { method: 'POST' });
      localStorage.setItem('ah_token', r.token);
      token = r.token;
      await loadState();
      toast('Token diperbarui');
    } catch (err) { toast('Gagal: ' + err.message); }
  });

  // ---------- gateway aksi ----------
  $('#btn-pool-test').addEventListener('click', async (e) => {
    e.target.disabled = true;
    $('#pool-test-result').classList.remove('hidden');
    $('#pool-test-body').innerHTML = '<p class="muted">mengirim permintaan lewat rotasi…</p>';
    try {
      const r = await api('/api/pool/test', { method: 'POST' });
      $('#pool-test-body').innerHTML = r.ok
        ? `<p class="t-ok">${icon('check')} Dilayani oleh <b>${esc(r.servedBy)}</b> dengan model <code>${esc(r.model)}</code></p><div class="resp">${esc(r.preview)}</div>`
        : `<p class="err">${icon('x')} Semua anggota gagal:</p><div class="resp">${esc(JSON.stringify(r.attempts, null, 1))}</div>`;
      await loadState();
    } catch (err) {
      $('#pool-test-body').innerHTML = `<p class="err">Gagal: ${esc(err.message)}</p>`;
    } finally { e.target.disabled = false; }
  });
  $('#btn-copy-gw').addEventListener('click', () => navigator.clipboard?.writeText($('#gw-url').textContent).then(() => toast('Endpoint gateway disalin')));
  $('#btn-copy-gwkey').addEventListener('click', () => navigator.clipboard?.writeText($('#gw-key').textContent).then(() => toast('API key gateway disalin')));
  $('#btn-copy-env').addEventListener('click', () => navigator.clipboard?.writeText(gatewayEnvText()).then(() => toast('Env agent disalin')));
  $('#btn-promo-gateway').addEventListener('click', () => go('gateway'));
  $('#btn-copy-url').addEventListener('click', () => navigator.clipboard?.writeText($('#phone-url').textContent).then(() => toast('URL HP disalin')));
  $('#btn-copy-token').addEventListener('click', () => navigator.clipboard?.writeText(state?.token || '').then(() => toast('Token disalin')));

  // ---------- popover usage ----------
  $('#rail-usage').addEventListener('click', async () => {
    if (layer === 'usage') return setLayer(null);
    setLayer('usage');
    $('#usage-csv').href = '/api/usage.csv?token=' + encodeURIComponent(token);
    let usage;
    try { usage = await api('/api/usage'); } catch { return toast('Gagal memuat pemakaian'); }
    const max = Math.max(1, ...usage.map((u) => u.runs));
    $('#usage-rows').innerHTML = usage.map((u) => {
      const pct = Math.round((u.runs / max) * 100);
      return `<div class="usage-row">
        <div class="u-top"><span class="u-name"><span class="u-ico">${icon(u.id)}</span><b>${esc(u.label)}</b></span><span class="u-num">${u.runs} run</span></div>
        <div class="u-bar"><i style="width:${pct}%"></i></div>
        <div class="u-sub"><span>${u.ok} ok · ${u.failed} gagal</span><span>${u.ok ? 'avg ' + Math.round(u.avgMs / 100) / 10 + 's' : '—'}</span></div>
      </div>`;
    }).join('');
  });
  $('#usage-manage').addEventListener('click', () => {
    setLayer(null);
    go('gateway');
  });

  // ---------- popover environment ----------
  $('#rail-env').addEventListener('click', () => {
    setLayer(layer === 'env' ? null : 'env');
    const note = $('#env-note');
    if (note) note.textContent = 'server jalan';
  });
  $('#env-open').addEventListener('click', () => setLayer(layer === 'env' ? null : 'env'));
  $('#env-manage').addEventListener('click', () => { setLayer(null); go('settings'); });
  $('#env-pair').addEventListener('click', () => {
    renderSettings(); // pastikan QR terisi
    setLayer('qr');
  });

  // ---------- SSE ----------
  // Dulu: setiap event → loadState() penuh (fetch /api/state ~200 KB + render
  // semua view). Sekarang: event digabung (coalesce) dan hanya slice yang
  // berubah yang di-render. `loadState` tetap dipakai saat reconnect/penuh.
  let sseTimer = null;
  let ssePending = new Set();
  let sse = null;
  let retry = 0;

  function flushSse() {
    const scopes = [...ssePending];
    ssePending.clear();
    sseTimer = null;
    if (!scopes.length) return;
    // event yang butuh data baru: ambil state sekali, render slice yang relevan
    loadState({ slices: scopes.flatMap((s) => scopeSlices(s)), silent: true });
  }

  function onScope(scope) {
    if (scope === 'hello' || scope === 'ping') return;
    ssePending.add(scope);
    if (sseTimer) return;
    sseTimer = setTimeout(flushSse, 120); // jendela 120 ms: N event → 1 render
  }

  function connectSSE() {
    try { sse?.close(); } catch { /* noop */ }
    setConn(retry ? 'degraded' : 'connecting');
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    sse = es;

    es.onopen = () => {
      const wasDown = conn !== 'live';
      retry = 0;
      setConn('live');
      // setelah putus, state bisa basi (run selesai / task pindah saat offline)
      if (wasDown) loadState();
    };

    es.onmessage = (ev) => {
      try {
        const { scope } = JSON.parse(ev.data);
        if (scope === 'promo') toast('Data promo diperbarui otomatis');
        if (scope === 'schedules') renderSchedules();
        if (scope === 'agents' && view === 'settings') renderConnectorPulse();
        // perubahan berkas di folder kerja → segarkan drawer Perubahan bila terbuka
        if (scope === 'workspace' && !document.querySelector('#changes-drawer')?.classList.contains('hidden') && curThread) {
          refreshWorkspace();
          refreshDiff();
        }
        onScope(scope);
      } catch { /* noop */ }
    };

    es.onerror = () => {
      // EventSource otomatis reconnect; kita hanya memberi tahu user bahwa
      // data yang terlihat mungkin sudah tidak segar.
      if (es.readyState === EventSource.CLOSED) {
        retry += 1;
        setConn('offline', 'mencoba menyambung ulang…');
        const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
        setTimeout(connectSSE, wait);
      } else {
        setConn('degraded');
      }
    };
  }

  $('#conn-retry')?.addEventListener('click', async () => {
    setConn('connecting');
    await loadState().catch(() => {});
    connectSSE();
  });

  // ---------- init ----------
  loadState().then(async () => {
    fillPresets();
    await renderEngines();
    syncActiveProject();
    refreshBranch();
    applyEngine();
    api('/api/models').then((r) => { modelChoices = r.models || []; applyEngine(); }).catch(() => {});
    connectSSE();
    setRun('idle');
    // pulihkan tampilan run yang masih berjalan di server (mis. setelah refresh)
    try {
      const st = await api('/api/status');
      if (st.runningThreads?.length) {
        const mine = curThread && st.runningThreads.some((t) => t.id === curThread.id);
        if (mine) setRun('running');
        else toast(`${st.runningThreads.length} run masih berjalan di server`, 3000);
      }
    } catch { /* status opsional */ }
    if (!urlThread && !urlView) go('studio', { silentRoute: true });
  });

  // Snapshot runtime untuk agent (AX): state aktif tanpa perlu menebak DOM.
  // Kontrak transisinya ada di window.__ahMachines / GET /api/machines.
  window.__ahState = () => ({
    view,
    layer,
    connection: conn,
    run: runStatus,
    promo: promoStatus,
    delegation: delegationStatus,
    noteEditor: noteEditorState,
    // Dialog aktif (AX): agent bisa menunggu/mengisi modal tanpa menebak DOM.
    dialog: dialogActive ? {
      title: $('#dialog-title')?.textContent || '',
      kind: dialogActive.opts.input ? 'prompt' : 'confirm',
      value: dialogActive.opts.input ? $('#dialog-input')?.value || '' : undefined,
    } : null,
    changes: changesOpen,
    workspace: workspaceInfo ? {
      cwd: workspaceInfo.cwd,
      repo: !!workspaceInfo.repo,
      branch: workspaceInfo.branch || null,
      changes: workspaceInfo.changes || 0,
    } : null,
    thread: curThread?.id || null,
    threadRunState: curThread?.runState || (curThread?.running ? 'running' : 'idle'),
  });
})();
