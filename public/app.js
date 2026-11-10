// AgentHub — logika UI (vanilla JS, tanpa framework)
// Studio chat multi-engine + papan tugas + monitoring.
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- token ----------
  let token = localStorage.getItem('ah_token') || '';
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    token = urlToken;
    localStorage.setItem('ah_token', token);
    history.replaceState(null, '', location.pathname);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
    if (res.status === 401) throw new Error('AUTH');
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ---------- state ----------
  let state = null;
  let engines = [];
  let view = 'studio';
  let promoTab = 'live';
  let promoQuery = '';
  let curThread = null;   // thread aktif (objek penuh)
  let threadSearch = '';
  let cwd = localStorage.getItem('ah_cwd') || '';
  let sending = false;

  const fmtCtx = (n) => (n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : n);
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // render teks asisten: code fence, inline code, bold, baris baru
  function md(s) {
    let out = esc(s);
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre class="codeblock">${code}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }

  function toast(msg, ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function loadState() {
    try {
      state = await api('/api/state');
      $('#gate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      renderAll();
    } catch (e) {
      if (e.message === 'AUTH') showGate();
      else toast('Gagal memuat: ' + e.message);
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
  function go(v) {
    view = v;
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
    $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#threadbar').classList.toggle('hidden', v !== 'studio');
    if (v === 'studio') { renderThreads(); if (curThread) renderChat(); }
    if (v === 'tasks') renderTasks();
    if (v === 'alerts') markReadSoon();
  }
  $$('.rail-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto);
  });

  // ---------- render utama ----------
  function renderAll() {
    renderThreads();
    renderEngines();
    renderPromo();
    renderKeys();
    renderGateway();
    renderAgents();
    renderAlerts();
    renderSettings();
    renderBadges();
    if (curThread) renderChat();
  }

  function renderBadges() {
    const unread = state.alerts.filter((a) => !a.read).length;
    const badge = $('#badge-alerts');
    badge.classList.toggle('hidden', unread === 0);
    badge.textContent = unread > 9 ? '9+' : unread;
  }

  // ---------- studio: engines ----------
  async function renderEngines() {
    try { engines = await api('/api/engines'); } catch { engines = engines || []; }
    const sel = $('#engine-select');
    sel.innerHTML = engines.map((e) => `<option value="${esc(e.id)}" ${e.available ? '' : 'disabled'}>${esc(e.label)}${e.available ? '' : ' — ' + esc(e.note)} </option>`).join('');
    const saved = localStorage.getItem('ah_engine');
    if (saved && engines.some((e) => e.id === saved && e.available)) sel.value = saved;
    updateEngineUI();
    renderDelegationEngines();
  }

  function updateEngineUI() {
    const id = $('#engine-select').value;
    localStorage.setItem('ah_engine', id);
    $('#chat-model').classList.toggle('hidden', id !== 'pool');
    const e = engines.find((x) => x.id === id);
    $('#cwd-hint')?.remove();
  }

  $('#engine-select').addEventListener('change', updateEngineUI);

  // folder kerja CLI
  function refreshCwd() {
    $('#btn-cwd').textContent = cwd ? '📁 ' + (cwd.split(/[\\/]/).pop() || cwd) : '📁 This PC';
  }
  $('#btn-cwd').addEventListener('click', () => {
    const v = prompt('Folder kerja untuk agent CLI (kosongkan = home):', cwd);
    if (v !== null) { cwd = v.trim(); localStorage.setItem('ah_cwd', cwd); refreshCwd(); }
  });
  refreshCwd();

  // ---------- studio: threads ----------
  async function renderThreads() {
    let list;
    try { list = await api('/api/threads'); } catch { return; }
    const q = threadSearch.toLowerCase();
    const filtered = q ? list.filter((t) => (t.title + ' ' + t.preview).toLowerCase().includes(q)) : list;
    $('#thread-list').innerHTML = filtered.length
      ? filtered.map((t) => `
        <div class="thread-item ${curThread?.id === t.id ? 'active' : ''}" data-id="${t.id}">
          <div class="ti-main"><b>${esc(t.title)}</b><span class="muted small">${esc((t.preview || '').slice(0, 46))}</span></div>
          <div class="ti-meta"><span class="chip tiny-chip">${esc(engineLabel(t.engine))}</span>${t.kind === 'delegation' ? '<span class="chip tiny-chip">🎯</span>' : ''}${t.running ? '<span class="chip tiny-chip run">⏳</span>' : ''}<span class="muted tiny-chip">${fmtTime(t.updatedAt)}</span></div>
        </div>`).join('')
      : '<p class="muted small" style="padding:8px">Belum ada thread.</p>';
    $$('#thread-list .thread-item').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.id)));
  }
  $('#thread-search').addEventListener('input', (e) => { threadSearch = e.target.value; renderThreads(); });

  function engineLabel(id) {
    return engines.find((e) => e.id === id)?.label || id || 'pool';
  }

  $('#btn-new-chat').addEventListener('click', async () => {
    try {
      const t = await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: $('#engine-select').value }) });
      curThread = t;
      go('studio');
      renderThreads();
      renderChat();
      $('#composer').focus();
    } catch (e) { toast('Gagal: ' + e.message); }
  });

  async function openThread(id) {
    try {
      curThread = await api(`/api/threads/${id}`);
      renderThreads();
      renderChat();
    } catch (e) { toast('Gagal: ' + e.message); }
  }

  $('#btn-chat-del').addEventListener('click', async () => {
    if (!curThread || !confirm('Hapus thread ini?')) return;
    await api(`/api/threads/${curThread.id}`, { method: 'DELETE' });
    curThread = null;
    renderThreads();
    renderChat();
  });

  // ---------- studio: render chat ----------
  function renderChat() {
    const empty = !curThread || !curThread.messages?.length;
    $('#chat-empty').classList.toggle('hidden', !empty);
    $('.chat').classList.toggle('empty', empty);
    $('#chat-messages').classList.toggle('hidden', empty);
    $('#btn-chat-del').classList.toggle('hidden', !curThread);
    $('#chat-title').textContent = curThread ? curThread.title : 'Studio';
    const badge = $('#chat-engine-badge');
    badge.classList.toggle('hidden', !curThread);
    if (curThread) badge.textContent = engineLabel(curThread.engine);
    $('#chat-running').classList.toggle('hidden', !(curThread?.running));

    if (empty) return;
    const msgs = curThread.messages.filter((m) => m.role !== 'system');
    let html = '';
    let subruns = null; // kumpulkan subrun delegation → satu kartu pohon

    const flushSubruns = () => {
      if (!subruns || !subruns.length) return;
      const working = subruns.filter((s) => (s.status || 'working') === 'working').length;
      const rows = subruns.map((s) => {
        const st = s.status || 'working';
        const stat = st === 'done' ? `✓ ${Math.round((s.ms || 0) / 100) / 10}s`
          : st === 'error' ? '✗ gagal' : `${Math.round((Date.now() - (s.ts || Date.now())) / 1000)}s Working`;
        const body = st === 'working' ? '' : `<div class="deleg-out">${esc((s.content || '').slice(0, 4000))}</div>`;
        return `<details class="deleg-row"><summary class="deleg-row-top">
          <b>${esc(engineLabel(s.engine))}</b><span class="deleg-sub">${esc((s.content || '').replace(/\s+/g, ' ').slice(0, 90))}</span>
          <span class="grow">${esc(stat)}</span></summary>${body}</details>`;
      }).join('');
      html += `<div class="msg assistant"><div class="deleg-card">
        <div class="deleg-head"><span class="chip">🎯 delegated</span><b>${subruns.length} agent</b><span class="muted small">${working} working</span><span class="caret">▼</span></div>
        ${rows}
      </div></div>`;
      subruns = null;
    };

    for (const m of msgs) {
      if (m.role === 'user') { flushSubruns(); html += `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`; continue; }
      if (m.subrun) { (subruns = subruns || []).push(m); continue; }
      flushSubruns();
      html += `<div class="msg assistant">
        <div class="msg-meta"><span class="chip">${esc(engineLabel(m.engine))}</span>${m.servedBy ? `<span>via ${esc(m.servedBy)}</span>` : ''}${m.ms ? `<span>Worked for ${Math.round(m.ms / 100) / 10}s</span>` : ''}</div>
        <div class="msg-body">${md(m.content || '')}</div>
      </div>`;
    }
    flushSubruns();
    $('#chat-messages').innerHTML = html;
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
  }

  // ---------- studio: kirim (SSE streaming) ----------
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
    if (sending) return;
    const prompt = $('#composer').value.trim();
    if (!prompt) return;
    sending = true;
    $('#btn-send').disabled = true;

    try {
      if (!curThread) {
        curThread = await api('/api/threads', { method: 'POST', body: JSON.stringify({ engine: $('#engine-select').value }) });
      }
      const engineId = $('#engine-select').value;
      // pesan user langsung tampil
      curThread.messages = [...(curThread.messages || []), { id: 'tmp-u', role: 'user', content: prompt, ts: Date.now() }];
      curThread.messages = [...curThread.messages, { id: 'tmp-a', role: 'assistant', engine: engineId, content: '', status: 'working' }];
      renderThreads();
      renderChat();
      const streamingEl = $('#chat-messages .msg.assistant:last-child .msg-body');
      if (streamingEl) streamingEl.innerHTML = '<span class="cursor">▍</span>';

      const res = await fetch(`/api/threads/${curThread.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, engine: engineId, model: $('#chat-model').value || undefined, cwd: cwd || undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      let acc = '';
      await parseSSE(res, (ev) => {
        if (ev.type === 'delta') {
          acc += ev.text;
          const el = $('#chat-messages .msg.assistant:last-child .msg-body');
          if (el) { el.innerHTML = md(acc); $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }
        } else if (ev.type === 'done') {
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = acc; meta.ms = ev.ms; meta.servedBy = ev.servedBy; meta.status = 'done';
        } else if (ev.type === 'error') {
          const meta = curThread.messages[curThread.messages.length - 1];
          meta.content = '⚠️ ' + ev.message; meta.status = 'error';
        }
      });
      curThread = await api(`/api/threads/${curThread.id}`);
      renderChat();
      renderThreads();
    } catch (e) {
      toast('Gagal: ' + e.message);
      if (curThread) { curThread = await api(`/api/threads/${curThread.id}`).catch(() => curThread); renderChat(); }
    } finally {
      sending = false;
      $('#btn-send').disabled = false;
      $('#composer').value = '';
      $('#composer').focus();
    }
  }
  $('#btn-send').addEventListener('click', sendPrompt);
  $('#composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });

  // ---------- delegation ----------
  function renderDelegationEngines() {
    $('#del-engines').innerHTML = engines.map((e) => `
      <label class="switch-row del-engine ${e.available ? '' : 'off'}">
        <input type="checkbox" value="${esc(e.id)}" data-del ${e.available ? '' : 'disabled'}>
        <span>${esc(e.label)} <span class="muted small">${esc(e.note || '')}</span></span>
      </label>`).join('');
  }

  $('#btn-delegate').addEventListener('click', () => {
    $('#delegate-overlay').classList.remove('hidden');
    $('#del-progress').classList.add('hidden');
    $('#del-progress').innerHTML = '';
    $('#del-prompt').focus();
  });
  $('#btn-del-cancel').addEventListener('click', () => $('#delegate-overlay').classList.add('hidden'));

  $('#btn-del-start').addEventListener('click', async () => {
    const prompt = $('#del-prompt').value.trim();
    const selected = $$('#del-engines input[data-del]:checked').map((i) => i.value);
    if (!prompt || !selected.length) return toast('Isi prompt & pilih minimal 1 engine');
    $('#btn-del-start').disabled = true;
    $('#del-progress').classList.remove('hidden');
    $('#del-progress').innerHTML = selected.map((id) => `
      <div class="del-run" data-engine="${esc(id)}"><span class="chip">${esc(engineLabel(id))}</span> <span class="del-status">⏳ mulai…</span><div class="del-out"></div></div>`).join('');

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
          if (row) row.textContent = ev.status === 'done' ? `✓ selesai ${Math.round((ev.ms || 0) / 100) / 10}s` : ev.status === 'error' ? '✗ gagal' : '⏳ bekerja…';
        } else if (ev.type === 'subdelta') {
          const out = $(`#del-progress .del-run[data-engine="${ev.engine}"] .del-out`);
          if (out) { out.textContent = (out.textContent + ev.text).slice(-800); out.classList.add('live'); }
        }
      });
      toast('Delegation selesai — hasil di thread & papan Tugas');
      curThread = null;
      await loadState();
      if (threadId) { await openThread(threadId); go('studio'); }
      $('#delegate-overlay').classList.add('hidden');
    } catch (e) {
      toast('Delegation gagal: ' + e.message);
    } finally {
      $('#btn-del-start').disabled = false;
    }
  });

  // ---------- tasks kanban ----------
  const TASK_COLS = [
    ['inbox', '📥 Inbox'], ['todo', '○ To do'], ['running', '⏳ Running'], ['review', '👁 Needs review'], ['done', '✅ Done'],
  ];

  async function renderTasks() {
    let list;
    try { list = await api('/api/tasks'); } catch { return; }
    $('#kanban').innerHTML = TASK_COLS.map(([key, label]) => {
      const cards = list.filter((t) => t.status === key);
      return `
      <div class="kcol" data-status="${key}">
        <div class="kcol-head"><b>${label}</b> <span class="count">${cards.length}</span>
          <button class="add" data-add="${key}" title="Tambah tugas">＋</button>
        </div>
        <div class="kcol-body">
          <input class="knew hidden" placeholder="Tulis judul, Enter" data-status="${key}">
          ${cards.map((t) => `
          <div class="kcard" data-id="${t.id}">
            <div class="kcard-title">${esc(t.title)}</div>
            <div class="kcard-actions">
              ${key !== 'inbox' ? `<button class="btn tiny ghost" data-move="-1" title="Mundur">←</button>` : ''}
              ${key !== 'done' ? `<button class="btn tiny ghost" data-move="1" title="Maju">→</button>` : ''}
              <button class="btn tiny danger" data-del-task="1" title="Hapus">🗑</button>
            </div>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('');

    $$('#kanban .kcol-head .add').forEach((btn) => btn.addEventListener('click', () => {
      const col = btn.closest('.kcol');
      const inp = col.querySelector('.knew');
      inp.classList.toggle('hidden');
      if (!inp.classList.contains('hidden')) inp.focus();
    }));
    $$('#kanban .knew').forEach((inp) => inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && inp.value.trim()) {
        await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: inp.value.trim(), status: inp.dataset.status }) });
        renderTasks();
      }
      if (e.key === 'Escape') inp.classList.add('hidden');
    }));
    $$('#kanban .kcard [data-move]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.closest('.kcard').dataset.id;
      const idx = TASK_COLS.findIndex(([k]) => k === btn.closest('.kcol').dataset.status);
      const next = TASK_COLS[Math.min(TASK_COLS.length - 1, Math.max(0, idx + Number(btn.dataset.move)))][0];
      await api(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify({ status: next }) });
      renderTasks();
    }));
    $$('#kanban .kcard [data-del-task]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Hapus task?')) return;
      await api(`/api/tasks/${btn.closest('.kcard').dataset.id}`, { method: 'DELETE' });
      renderTasks();
    }));
  }

  // ---------- promo ----------
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
            ${m.modality && m.modality !== 'text->text' ? `<span class="chip">${esc(m.modality)}</span>` : ''}
          </div>
          <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Detail ↗</a>
        </div>`).join('')}</div>`
      : '<p class="muted">Tidak ada model yang cocok.</p>';

    const cross = state.snapshot?.sources?.cross?.models || [];
    const crossFiltered = q ? cross.filter((m) => (m.name + ' ' + m.id + ' ' + m.provider).toLowerCase().includes(q)) : cross;
    $('#promo-cross').innerHTML = crossFiltered.length
      ? `<p class="muted small" style="margin-bottom:12px">${cross.length} model gratis lintas provider — sumber: <a href="https://models.dev" target="_blank" rel="noreferrer">models.dev</a> (registry terbuka)</p>
        <div class="model-grid">${crossFiltered.slice(0, 120).map((m) => `
        <div class="model-card">
          <b title="${esc(m.name)}">${esc(m.name)}</b>
          <div class="id">${esc(m.id)}</div>
          <div class="meta">
            <span class="chip free">GRATIS</span>
            ${m.context ? `<span class="chip">ctx ${fmtCtx(m.context)}</span>` : ''}
            <span class="chip">${esc(m.provider)}</span>
          </div>
          <a class="visit" href="${esc(m.page)}" target="_blank" rel="noreferrer">Provider ↗</a>
        </div>`).join('')}</div>
        ${crossFiltered.length > 120 ? `<p class="muted small" style="margin-top:12px">Menampilkan 120 dari ${crossFiltered.length} — gunakan pencarian.</p>` : ''}`
      : '<p class="muted">Sumber models.dev belum tersinkron — klik "Cek sekarang" (perlu internet).</p>';

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
      : '<p class="muted">Sumber GitHub belum tersinkron — klik "Cek sekarang" (perlu internet).</p>';
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
          <button class="btn tiny ${k.pool ? 'primary' : 'ghost'}" data-act="key-pool" title="Ikut rotasi gateway">${k.pool ? '✓ Pool' : '+ Pool'}</button>
          <button class="btn tiny ghost" data-act="key-check">⟳ Cek</button>
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

# n8n / OpenAI SDK / agent lain
Base URL : ${gw}
API Key  : ${state.token}
Model    : auto  (atau groq/llama-3.3-70b-versatile, dst)`;

    const list = $('#pool-list');
    if (!members.length) {
      list.innerHTML = '<div class="item"><div class="info muted">Pool masih kosong. Buka tab API Keys → tombol "+ Pool" pada key yang valid. Agent Anda lalu cukup menunjuk ke endpoint di atas.</div></div>';
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
          <button class="btn tiny ghost" data-act="pool-toggle">Keluar</button>
        </div>
      </div>`).join('');
    }

    // pemakaian engine studio
    api('/api/usage').then((usage) => {
      $('#usage-list').innerHTML = usage.map((u) => `
        <div class="mini-item"><span><b>${esc(u.label)}</b> <span class="muted small">${u.runs} run · ${u.failed} gagal${u.ok ? ' · rata-rata ' + Math.round(u.avgMs / 100) / 10 + 's' : ''}</span></span><span class="chip">${u.type === 'pool' ? 'gateway' : 'CLI'}</span></div>`).join('');
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
          <button class="btn tiny ghost" data-act="agent-check">⟳ Cek</button>
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
    $('#qr-box').innerHTML = '';
    try { new QRCode($('#qr-box'), { text: s.phoneUrl, width: 132, height: 132, correct: QRCode.CorrectLevel.M }); } catch { /* QR gagal */ }
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
    e.target.disabled = true;
    try {
      await api('/api/promo/refresh', { method: 'POST' });
      toast('Sumber promo diperbarui');
      await loadState();
    } catch (err) { toast('Gagal: ' + err.message); }
    finally { e.target.disabled = false; }
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
  $('#btn-copy-url').addEventListener('click', () => navigator.clipboard?.writeText($('#phone-url').textContent).then(() => toast('URL HP disalin')));
  $('#btn-copy-token').addEventListener('click', () => navigator.clipboard?.writeText(state?.token || '').then(() => toast('Token disalin')));

  // ---------- SSE ----------
  function connectSSE() {
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.onerror = () => { document.title = 'AgentHub — reconnecting…'; };
    es.onopen = () => { document.title = 'AgentHub — Studio Agent & Promo API'; };
    es.onmessage = (ev) => {
      try {
        const { scope } = JSON.parse(ev.data);
        if (scope === 'hello') return;
        loadState();
        if (scope === 'promo') toast('🎁 Data promo diperbarui otomatis');
        if (scope === 'threads') renderThreads();
        if (scope === 'tasks' && view === 'tasks') renderTasks();
      } catch { /* noop */ }
    };
  }

  // ---------- popover pemakaian engine ----------
  $('#rail-usage').addEventListener('click', async () => {
    const pop = $('#usage-pop');
    if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
    let usage;
    try { usage = await api('/api/usage'); } catch { return toast('Gagal memuat pemakaian'); }
    const max = Math.max(1, ...usage.map((u) => u.runs));
    $('#usage-rows').innerHTML = usage.map((u) => {
      const pct = Math.round((u.runs / max) * 100);
      return `<div class="usage-row">
        <div class="u-top"><b>${esc(u.label)}</b><span>${u.runs} run</span></div>
        <div class="u-bar"><i style="width:${pct}%"></i></div>
        <div class="u-sub"><span>${u.ok} ok · ${u.failed} gagal</span><span>${u.ok ? 'avg ' + Math.round(u.avgMs / 100) / 10 + 's' : '—'}</span></div>
      </div>`;
    }).join('');
    pop.classList.remove('hidden');
  });
  $('#usage-close').addEventListener('click', () => $('#usage-pop').classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#usage-pop') && !e.target.closest('#rail-usage')) {
      $('#usage-pop')?.classList.add('hidden');
    }
  });

  // ---------- init ----------
  loadState().then(() => { fillPresets(); renderEngines(); connectSSE(); go('studio'); });
})();
