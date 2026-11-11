// AgentHub — UI kontrol-plane ala Kybern (vanilla JS, ESM)
// Studio chat multi-engine + delegation + papan tugas + monitoring.
//
// Semua status yang dulu berupa string lepas / boolean sekarang mengikuti
// mesin di /public/machines.js (dihasilkan dari lib/machines.js). Satu mesin,
// tiga konsumen: server (validasi), UI (label & tombol), agent (kontrak API).
import {
  TASK_STATUSES, TASK_LABELS, TASK_MACHINE, taskCanMove, taskNext,
  RUN_MACHINE, CONNECTION_MACHINE, PROMO_MACHINE, UI_MACHINE,
  VIEWS, UI_LAYERS, SSE_SCOPES, scopeSlices,
} from './machines.js';

// Kontrak mesin juga tersedia di runtime browser: agent yang mengemudikan UI
// lewat CDP bisa membaca aturan yang sama tanpa menebak tombol mana yang ada.
window.__ahMachines = {
  tasks: TASK_MACHINE, run: RUN_MACHINE, connection: CONNECTION_MACHINE,
  promo: PROMO_MACHINE, ui: UI_MACHINE, views: VIEWS, sse: SSE_SCOPES,
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
  let curThread = null;
  let threadSearch = '';
  let cwd = localStorage.getItem('ah_cwd') || '';
  let taskFilter = 'all';
  let taskSearch = '';

  // --- mesin: run & koneksi ---
  // runStatus: idle | running | done | error | stopped (RUN_MACHINE)
  let runStatus = 'idle';
  let runCtrl = null;          // AbortController run aktif
  let conn = 'connecting';     // CONNECTION_MACHINE
  let promoStatus = 'idle';    // PROMO_MACHINE
  let layer = null;            // UI_MACHINE — hanya satu overlay aktif

  const runActive = () => runStatus === 'running';

  function setRun(next) {
    if (next !== runStatus) {
      const allowed = RUN_MACHINE.transitions[runStatus] || [];
      if (!allowed.includes(next)) {
        // transisi ilegal = bug pemanggil, bukan kondisi user. Jangan diam-diam.
        console.warn(`[run] transisi ${runStatus} → ${next} tidak sah (boleh: ${allowed.join(', ') || '—'})`);
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

  const ENGINE_ICON = { pool: '🆓', claude: '✳️', codex: '🔷', opencode: '🟦', gemini: '✨', echo: '🔁' };
  const svgIco = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
  const SPARK_SVG = svgIco('<path d="M12 3.6l1.9 6.5 6.5 1.9-6.5 1.9-1.9 6.5-1.9-6.5L3.6 12l6.5-1.9z"/>');
  const FOLDER_SVG = svgIco('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>');
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
  const icon = (id) => ENGINE_ICON[id] || '🤖';
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
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, code) => `<pre class="codeblock">${code}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }

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
  };

  function setLayer(next) {
    if (next && !UI_LAYERS.includes(next)) return;
    const allowed = UI_MACHINE.transitions[layer] || [];
    if (next && !allowed.includes(next)) console.warn(`[ui] layer ${layer} → ${next} tidak sah`);
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
  });

  // Klik di luar popover menutupnya — tapi klik pada pemicu bukan "di luar".
  // Tanpa daftar ini, klik #rail-usage membuka lalu langsung menutup popover
  // dalam event yang sama (bug halus yang tidak terlihat di kode).
  const LAYER_TRIGGERS = ['#rail-usage', '#rail-env', '#env-open', '#env-pair', '[data-open-delegate]', '#btn-note-new', '.note-cell', '.adopt-btn'];
  const LAYER_TRIGGER_SEL = LAYER_TRIGGERS.join(',');

  document.addEventListener('click', (e) => {
    if (!layer) return;
    if (e.target.closest(Object.values(LAYER_EL).join(','))) return;
    if (e.target.closest(LAYER_TRIGGER_SEL)) return;
    if (layer === 'delegate' || layer === 'note' || layer === 'adopt') return; // overlay modal: hanya tombol tutup/Esc
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
  async function renderEngines() {
    try { engines = await api('/api/engines'); } catch { engines = engines || []; }
    const sel = $('#engine-select');
    sel.innerHTML = engines.map((e) => `<option value="${esc(e.id)}" ${e.available ? '' : 'disabled'}>${esc(e.label)}${e.available ? '' : ' — ' + esc(e.note)}</option>`).join('');
    const saved = localStorage.getItem('ah_engine');
    if (saved && engines.some((e) => e.id === saved && e.available)) sel.value = saved;
    updateEngineUI();
    renderDelegationEngines();
  }

  function updateEngineUI() {
    const id = $('#engine-select').value;
    localStorage.setItem('ah_engine', id);
    $('#chat-model').classList.toggle('hidden', id !== 'pool');
  }

  $('#engine-select').addEventListener('change', updateEngineUI);

  function setCwd(v) {
    cwd = v.trim();
    localStorage.setItem('ah_cwd', cwd);
    $('#cwd-name').textContent = cwdBase();
    const hero = $('#hero-project-name');
    if (hero) hero.textContent = cwdBase();
  }
  $('#composer-cwd').addEventListener('click', () => {
    const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
    if (v !== null) setCwd(v);
  });
  $('#btn-cwd').addEventListener('click', () => {
    const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
    if (v !== null) setCwd(v);
  });
  $('#cwd-name').textContent = cwdBase();

  // ---------- studio: sidebar ----------
  let threadCache = [];
  let railProjects = [];

  // Ruang cepat di rail, seperti tile proyek berwarna di Kybern.
  function renderRailSpaces() {
    const host = $('#rail-spaces');
    if (!host) return;
    host.innerHTML = railProjects.slice(0, 4).map((p) => `
      <button class="space-tile" data-space="${esc(p)}" title="${esc(projectLabel(p))}"
        style="background:${projectColor(p)}">${esc(projectInitials(projectLabel(p)))}</button>`).join('') +
      `<button class="space-tile add" id="rail-add-space" title="Proyek baru / ganti folder">＋</button>`;
    $$('#rail-spaces [data-space]').forEach((btn) => btn.addEventListener('click', () => {
      taskProject = btn.dataset.space;
      taskGlobal = false;
      go('tasks');
    }));
    $('#rail-add-space')?.addEventListener('click', () => {
      const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
      if (v !== null) { setCwd(v); renderSidebar(); }
    });
  }

  async function renderSidebar() {
    try { threadCache = await api('/api/threads'); } catch { return; }
    let taskList = [];
    try { taskList = await api('/api/tasks'); } catch { /* opsional */ }
    railProjects = [...new Set(taskList.map((t) => t.projectId || 'default'))];
    renderRailSpaces();

    const q = threadSearch.toLowerCase();
    const list = q ? threadCache.filter((t) => (t.title + ' ' + t.preview).toLowerCase().includes(q)) : threadCache;

    // Recents di sidebar
    $('#sb-recents').innerHTML = list.length
      ? list.map((t) => `
        <div class="recent-item ${curThread?.id === t.id ? 'active' : ''}" data-id="${t.id}" title="${esc(t.title)}">
          ${spark(t.running ? 'var(--accent)' : '#7d7d85')}
          <span class="r-title">${esc(t.title)}</span>
          <span class="r-time">${t.running ? 'Working' : fmtWhen(t.updatedAt)}</span>
        </div>`).join('')
      : '<p class="muted small" style="padding:6px 9px">Belum ada thread.</p>';
    $$('#sb-recents .recent-item').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.id)));

    // Project rows: folder kerja aktif + proyek dari papan tugas
    const rows = [{ key: '__cwd', label: cwdBase(), folder: true }];
    for (const p of railProjects) {
      if (p === 'default') continue;
      rows.push({ key: p, label: p, color: projectColor(p) });
    }
    $('#sb-projects').innerHTML = rows.map((r) => `
      <div class="project-row" ${r.key === '__cwd' ? 'data-cwd="1"' : `data-project="${esc(r.key)}"`} title="${esc(r.label)}">
        ${r.folder ? `<span class="p-ico">${FOLDER_SVG}</span>` : `<span class="p-dot" style="background:${r.color}"></span>`}
        <span class="p-name">${esc(r.label)}</span>
        <span class="p-ext" title="Ganti folder kerja"><svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg></span>
      </div>`).join('');
    $$('#sb-projects .project-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.p-ext')) {
          const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
          if (v !== null) { setCwd(v); renderSidebar(); }
          return;
        }
        if (row.dataset.cwd) {
          const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
          if (v !== null) { setCwd(v); renderSidebar(); }
        } else {
          taskProject = row.dataset.project;
          taskGlobal = false;
          go('tasks');
        }
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
    const heroTitle = $('#hero-project-name');
    if (heroTitle) heroTitle.textContent = cwdBase();
    const sbTitle = $('#sb-title');
    if (sbTitle) sbTitle.textContent = 'AgentHub';
    $('#env-note').textContent = 'server jalan';
  }
  $('#sb-search-btn').addEventListener('click', () => {
    const v = prompt('Cari thread:');
    if (v !== null) { threadSearch = v; renderSidebar(); }
  });
  $('#btn-filter-projects').addEventListener('click', () => {
    const v = prompt('Filter thread (kosongkan = semua):', threadSearch);
    if (v !== null) { threadSearch = v; renderSidebar(); }
  });
  $('#btn-resume').addEventListener('click', () => {
    const t = threadCache[0];
    if (t) openThread(t.id); else toast('Belum ada sesi tersimpan');
  });

  async function openThread(id) {
    try {
      curThread = await api(`/api/threads/${id}`);
      view = 'studio';
      $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-studio'));
      $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === 'studio'));
      sidebarOpen = window.innerWidth > 900;
      applySidebar();
      syncRoute('studio', curThread.id);
      renderSidebar();
      placeComposer();
      renderChat();
    } catch (e) { toast('Gagal: ' + e.message); }
  }

  $('#btn-new-chat').addEventListener('click', async () => {
    try {
      const t = await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: $('#engine-select').value }) });
      curThread = t;
      placeComposer();
      renderChat();
      renderSidebar();
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
    const top = $('#chat-top');
    if (top) top.classList.toggle('ghost-top', empty);
  }

  $('#btn-chat-del').addEventListener('click', async () => {
    if (!curThread || !confirm('Hapus thread ini?')) return;
    await api(`/api/threads/${curThread.id}`, { method: 'DELETE' });
    curThread = null;
    renderSidebar();
    placeComposer();
    renderChat();
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
    if (curThread) badge.textContent = `${icon(curThread.engine)} ${engineLabel(curThread.engine)}`;
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
      const working = subruns.filter((s) => (s.status || 'working') === 'working').length;
      const maxMs = Math.max(0, ...subruns.map((s) => s.ms || 0));
      const rows = subruns.map((s) => {
        const st = s.status || 'working';
        const stat = st === 'done' ? `${Math.round((s.ms || 0) / 100) / 10}s Done`
          : st === 'error' ? 'Failed'
          : `${Math.max(1, Math.round((Date.now() - (s.ts || Date.now())) / 1000))}s Working`;
        const meta = `${st === 'error' ? 'Error' : 'Review'} · ${esc(s.engine)} · ${esc(cwdBase())}`;
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

    for (const m of msgs) {
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) { html += daySep(m.ts); lastDay = day; }
      if (m.role === 'user') { flushSubruns(); html += `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`; continue; }
      if (m.subrun) { (subruns = subruns || []).push(m); continue; }
      flushSubruns();
      html += `<div class="msg assistant">
        <div class="msg-body">${md(m.content || '')}</div>
        <div class="msg-foot"><span>${esc(engineLabel(m.engine))}</span>${m.servedBy ? `<span class="mf-sep">·</span><span>via ${esc(m.servedBy)}</span>` : ''}${m.ms ? `<span class="mf-sep">·</span><span>${Math.round(m.ms / 100) / 10}s</span>` : ''}<span class="mf-sep">·</span><span>${fmtClock(m.ts)}</span></div>
      </div>`;
    }
    flushSubruns();
    $('#chat-messages').innerHTML = html;
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
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

  async function sendPrompt() {
    if (runActive()) return;
    const prompt = $('#composer-input').value.trim();
    if (!prompt) return;
    setRun('running');
    runCtrl = new AbortController();

    try {
      if (!curThread) {
        curThread = await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: $('#engine-select').value }) });
        syncRoute('studio', curThread.id);
      }
      const engineId = $('#engine-select').value;
      curThread.messages = [...(curThread.messages || []), { id: 'tmp-u', role: 'user', content: prompt, ts: Date.now() }];
      curThread.messages = [...curThread.messages, { id: 'tmp-a', role: 'assistant', engine: engineId, content: '', status: 'working' }];
      placeComposer();
      renderSidebar();
      renderChat();
      const streamingEl = $('#chat-messages .msg.assistant:last-child .msg-body');
      if (streamingEl) streamingEl.innerHTML = '<span class="cursor">▍</span>';

      const res = await fetch(`/api/threads/${curThread.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, engine: engineId, model: $('#chat-model').value || undefined, cwd: cwd || undefined }),
        signal: runCtrl.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
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
          meta.content = acc || '⏹️ Dihentikan.'; meta.status = 'stopped';
        } else if (ev.type === 'error') {
          outcome = 'error';
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = '⚠️ ' + ev.message; meta.status = 'error';
        }
      });
      setRun(outcome);
      curThread = await api(`/api/threads/${curThread.id}`);
      renderChat();
      renderSidebar();
    } catch (e) {
      const aborted = e.name === 'AbortError' || runCtrl?.signal.aborted;
      setRun(aborted ? 'stopped' : 'error');
      if (!aborted) toast(e.message === 'OFFLINE' ? 'Server tidak terjangkau — coba lagi' : 'Gagal: ' + e.message);
      if (curThread) { curThread = await api(`/api/threads/${curThread.id}`).catch(() => curThread); renderChat(); }
    } finally {
      runCtrl = null;
      $('#composer-input').value = '';
      $('#composer-input').focus();
      // kembali ke idle setelah terminal state terlihat sebentar
      setTimeout(() => { if (!runActive()) setRun('idle'); }, 400);
    }
  }
  $('#btn-send').addEventListener('click', sendPrompt);
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
    $('#del-progress').classList.add('hidden');
    $('#del-progress').innerHTML = '';
  }));
  $('#btn-del-cancel').addEventListener('click', () => setLayer(null));

  $('#btn-del-start').addEventListener('click', async () => {
    const prompt = $('#del-prompt').value.trim();
    const selected = $$('#del-engines input[data-del]:checked').map((i) => i.value);
    if (!prompt || !selected.length) return toast('Isi prompt & pilih minimal 1 engine');
    $('#btn-del-start').disabled = true;
    $('#del-progress').classList.remove('hidden');
    $('#del-progress').innerHTML = selected.map((id) => `
      <div class="del-run" data-engine="${esc(id)}"><span class="chip">${icon(id)} ${esc(engineLabel(id))}</span> <span class="del-status">⏳ mulai…</span><div class="del-out"></div></div>`).join('');

    try {
      const res = await fetch('/api/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, engines: selected, cwd: cwd || undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      let threadId = null;
      await parseSSE(res, (ev) => {
        if (ev.type === 'start') threadId = ev.threadId;
        const row = $(`#del-progress .del-run[data-engine="${ev.engine}"] .del-status`);
        if (ev.type === 'sub') {
          if (row) row.textContent = ev.status === 'done' ? `✓ ${Math.round((ev.ms || 0) / 100) / 10}s` : ev.status === 'error' ? '✗ gagal' : '⏳ bekerja…';
        } else if (ev.type === 'subdelta') {
          const out = $(`#del-progress .del-run[data-engine="${ev.engine}"] .del-out`);
          if (out) { out.textContent = (out.textContent + ev.text).slice(-800); out.classList.add('live'); }
        }
      });
      toast('Delegation selesai — hasil di thread & papan Tugas');
      curThread = null;
      await loadState();
      if (threadId) await openThread(threadId);
      setLayer(null);
    } catch (e) {
      toast('Delegation gagal: ' + e.message);
    } finally {
      $('#btn-del-start').disabled = false;
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
  let taskProject = 'all';
  let taskGlobal = false;
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

    $('#task-project-name').textContent = taskProject === 'all' ? cwdBase() : projectLabel(taskProject);

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
                ${t.threadId ? `<button class="icon-btn" data-open-thread="${t.threadId}" title="Buka thread">⤢</button>` : ''}
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
          await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: inp.value.trim(), status: inp.dataset.status }) });
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
      if (!confirm('Hapus task?')) return;
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
    setLayer('note');
    setTimeout(() => $('#note-title').focus(), 50);
  }

  $('#btn-note-new').addEventListener('click', () => openNoteEditor(null));
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
    try {
      if (editingNoteId) await api(`/api/notes/${editingNoteId}`, { method: 'POST', body: JSON.stringify(payload) });
      else await api('/api/notes', { method: 'POST', body: JSON.stringify(payload) });
      toast(editingNoteId ? 'Catatan disimpan' : 'Catatan dibuat');
      setLayer(null);
      await loadState();
    } catch (e) { toast('Gagal: ' + e.message); }
    finally { btn.disabled = false; }
  });
  $('#btn-note-del').addEventListener('click', async () => {
    if (!editingNoteId || !confirm('Hapus catatan ini?')) return;
    try {
      await api(`/api/notes/${editingNoteId}`, { method: 'DELETE' });
      toast('Catatan dihapus');
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
    syncAdoptPreset();
    if (name) {
      const short = name.replace(/\s*\(free\)\s*/i, '').slice(0, 60);
      $('#adopt-name').value = `${state.keyPresets[sel.value]?.label || 'Custom'} · ${short}`.slice(0, 80);
    }
    $('#adopt-key').value = '';
    $('#adopt-pool').checked = state.config?.autoPool !== false;
    $('#adopt-result').classList.add('hidden');
    $('#adopt-result').innerHTML = '';
    $('#btn-adopt-start').disabled = false;
    setLayer('adopt');
    setTimeout(() => $('#adopt-key').focus(), 60);
  }

  $('#adopt-preset').addEventListener('change', syncAdoptPreset);
  $('#btn-adopt-cancel').addEventListener('click', () => setLayer(null));
  $('#btn-adopt-start').addEventListener('click', async () => {
    const key = $('#adopt-key').value.trim();
    if (!key) return toast('Tempel API key promo dulu');
    const btn = $('#btn-adopt-start');
    btn.disabled = true;
    $('#adopt-result').classList.add('hidden');
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
      const title = bad ? '⚠️ Key ditolak provider'
        : unverified ? '⚠️ Key tersimpan, belum terverifikasi'
        : '✓ Siap dipakai agent';
      const note = bad ? 'Periksa kembali key promo Anda — model belum masuk rotasi.'
        : unverified ? 'Provider tidak menjawab saat validasi. Key tetap masuk pool dan dicek ulang otomatis.'
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
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.adopt-btn');
    if (!b) return;
    openAdopt(b.dataset.model, b.dataset.preset, b.dataset.name);
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
            <button class="btn tiny primary adopt-btn" data-model="${esc(m.id)}" data-preset="openrouter" data-name="${esc(m.name)}">Pakai di agent</button>
            <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Detail ↗</a>
          </div>
        </div>`).join('')}</div>`
      : '<p class="muted">Tidak ada model yang cocok.</p>';

    const cross = state.snapshot?.sources?.cross?.models || [];
    const crossFiltered = q ? cross.filter((m) => (m.name + ' ' + m.id + ' ' + m.provider).toLowerCase().includes(q)) : cross;
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
            <button class="btn tiny primary adopt-btn" data-model="${esc(m.id)}" data-preset="${esc(presetForProvider(m.provider))}" data-name="${esc(m.name)}">Pakai di agent</button>
            <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Provider ↗</a>
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
        <a class="btn primary tiny" href="${esc(c.url)}" target="_blank" rel="noreferrer">Daftar ↗</a>
      </div>`).join('')}</div>`;

    const prov = state.snapshot?.sources?.list?.providers || [];
    $('#promo-list').innerHTML = prov.length
      ? prov.map((p) => `
        <div class="ftl-card">
          <h4>${esc(p.name)} <a href="${esc(p.url)}" target="_blank" rel="noreferrer">situs ↗</a></h4>
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
          ${k.pool ? '<span class="chip pool-chip">🔀 pool</span>' : ''}<br>
          <span class="status ${esc(k.status)}">● ${esc(k.statusText || 'belum dicek')}</span>
          <div class="meta">${esc(k.baseUrl)} · key <code>${esc(k.keyMask)}</code>${k.latency ? ' · ' + k.latency + ' ms' : ''} · dicek ${fmtTime(k.lastChecked)}</div>
        </div>
        <div class="actions">
          <button class="btn tiny ${k.pool ? 'primary' : ''}" data-act="key-pool">${k.pool ? '✓ Pool' : '+ Pool'}</button>
          <button class="btn tiny" data-act="key-check">⟳ Cek</button>
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
          ${k.cooling ? '<span class="chip cool-chip">❄️ cooldown</span>' : ''}
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
          <button class="btn tiny" data-act="agent-check">⟳ Cek</button>
          <button class="btn tiny" data-act="agent-trigger">⚡ Tes kirim</button>
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
  function renderSettings() {
    const c = state.config;
    $('#set-refresh').value = c.refreshHours;
    $('#set-agent').value = c.agentCheckMinutes;
    $('#set-keys').value = c.keyCheckHours;
    $('#set-notify').checked = !!c.notify;
    $('#set-autopool').checked = c.autoPool !== false;
    $('#set-token').textContent = state.token;
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
    try { new QRCode($('#qr-box'), { text: s.phoneUrl, width: 132, height: 132, correct: QRCode.CorrectLevel.M }); } catch { }
    $('#qr-box-pop').innerHTML = '';
    try { new QRCode($('#qr-box-pop'), { text: s.phoneUrl, width: 148, height: 148, correct: QRCode.CorrectLevel.M }); } catch { }
  }

  // ---------- aksi list ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.item')?.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'key-check') { btn.disabled = true; await api(`/api/keys/${id}/check`, { method: 'POST' }); toast('Key diperiksa'); }
      if (act === 'key-del') { if (confirm('Hapus API key ini?')) await api(`/api/keys/${id}`, { method: 'DELETE' }); }
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
      if (act === 'agent-del') { if (confirm('Hapus agent ini?')) await api(`/api/agents/${id}`, { method: 'DELETE' }); }
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
    promoStatus = 'refreshing';
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.dataset.label ??= btn.textContent;
    btn.textContent = PROMO_MACHINE.states.refreshing;
    try {
      await api('/api/promo/refresh', { method: 'POST' });
      promoStatus = 'ready';
      toast('Sumber promo diperbarui');
      await loadState();
    } catch (err) {
      promoStatus = 'error';
      toast('Gagal: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = btn.dataset.label;
      setTimeout(() => { if (promoStatus === 'ready') promoStatus = 'idle'; }, 1500);
    }
  });
  $('#promo-search').addEventListener('input', (e) => {
    promoQuery = e.target.value;
    if (state) renderPromo();
  });
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
    if (!confirm('Token baru menggantikan yang lama — HP harus scan ulang QR. Lanjut?')) return;
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
        ? `<p>✅ Dilayani oleh <b>${esc(r.servedBy)}</b> dengan model <code>${esc(r.model)}</code></p><div class="resp">${esc(r.preview)}</div>`
        : `<p class="err">❌ Semua anggota gagal:</p><div class="resp">${esc(JSON.stringify(r.attempts, null, 1))}</div>`;
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
        if (scope === 'promo') toast('🎁 Data promo diperbarui otomatis');
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
})();
