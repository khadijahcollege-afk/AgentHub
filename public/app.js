// AgentHub — logika UI (vanilla JS, tanpa framework)
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
  let view = 'dashboard';
  let promoTab = 'live';
  let promoQuery = '';

  const fmtCtx = (n) => (n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : n);
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    try { await api('/api/state'); localStorage.setItem('ah_token', token); showGate(); location.reload(); }
    catch { $('#gate-err').classList.remove('hidden'); }
  });
  $('#gate-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-btn').click(); });

  // ---------- navigasi ----------
  function go(v) {
    view = v;
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
    $$('.nav-btn, .bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    if (v === 'alerts') markReadSoon();
  }
  $$('.nav-btn, .bottom-nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto);
  });

  // ---------- render ----------
  function renderAll() {
    renderDash();
    renderPromo();
    renderKeys();
    renderGateway();
    renderAgents();
    renderAlerts();
    renderSettings();
    renderBadges();
    renderConn();
  }

  function renderConn() {
    // ditangani SSE event
  }

  function renderBadges() {
    const unread = state.alerts.filter((a) => !a.read).length;
    const badge = $('#badge-alerts');
    badge.classList.toggle('hidden', unread === 0);
    badge.textContent = unread > 9 ? '9+' : unread;
    $('#badge-promo').classList.add('hidden');
  }

  function renderDash() {
    const models = state.snapshot?.sources?.openrouter?.models || [];
    const keys = state.keys;
    const agents = state.agents;
    const unread = state.alerts.filter((a) => !a.read).length;
    $('#card-models').querySelector('.stat-num').textContent = models.length;
    $('#card-models-foot').textContent = state.snapshot?.lastRefresh ? `update ${fmtTime(state.snapshot.lastRefresh)}` : 'belum ada data';
    $('#card-keys').querySelector('.stat-num').textContent = keys.filter((k) => k.status === 'valid').length + '/' + keys.length;
    $('#card-keys-foot').textContent = keys.length ? 'terakhir dicek otomatis' : 'belum ada key tersimpan';
    $('#card-agents').querySelector('.stat-num').textContent = agents.filter((a) => a.status === 'online').length + '/' + agents.length;
    $('#card-agents-foot').textContent = agents.length ? 'health check otomatis aktif' : 'sambungkan agent pertama Anda';
    $('#card-alerts').querySelector('.stat-num').textContent = unread;
    $('#card-alerts-foot').textContent = unread ? 'buka tab Notifikasi' : 'semua sudah dibaca';

    const top = models.slice(0, 6);
    $('#dash-models').innerHTML = top.length
      ? top.map((m) => `<div class="mini-item"><a href="${esc(m.page)}" target="_blank" rel="noreferrer">${esc(m.name)}</a><span class="ctx">ctx ${fmtCtx(m.context)} · ${esc(m.provider)}</span></div>`).join('')
      : '<p class="muted">Belum ada data — klik Refresh atau tunggu sinkronisasi.</p>';

    const info = state.server;
    $('#phone-url').textContent = info.phoneUrl;
    $('#qr-box').innerHTML = '';
    try {
      new QRCode($('#qr-box'), { text: info.phoneUrl, width: 132, height: 132, correct: QRCode.CorrectLevel.M });
    } catch { /* QR gagal — URL tetap tampil */ }
  }

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

    $('#promo-catalog').innerHTML = `<div class="cat-grid">${state.catalog.map((c) => `
      <div class="cat-card">
        <b>${esc(c.name)}</b>
        <p>${esc(c.free)}</p>
        <p class="small">${esc(c.note || '')}</p>
        <div class="tags">${(c.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        <a class="btn primary tiny" href="${esc(c.url)}" target="_blank" rel="noreferrer">Daftar ↗</a>
      </div>`).join('')}</div>`;

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
      return;
    }
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
          <button class="btn tiny ${k.status === 'valid' ? 'ghost' : ''}" data-act="pool-toggle">Keluar</button>
        </div>
      </div>`).join('');
  }

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

  // ---------- pool: input prioritas & model default ----------
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

  // ---------- gateway: tes rotasi & salin ----------
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
    $('#agent-body-label').classList.toggle('hidden', !openai && $('#agent-method').value === 'GET');
    $('#agent-body-label').classList.toggle('webhook-only', true);
  });
  $('#agent-method').addEventListener('change', () => {
    if (agentType.value !== 'openai') $('#agent-body-label').classList.toggle('hidden', $('#agent-method').value === 'GET');
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

  // ---------- promo ----------
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

  // ---------- misc ----------
  $('#btn-refresh-all').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/api/promo/refresh', { method: 'POST' }); toast('Semua sumber diperbarui'); await loadState(); }
    catch (err) { toast('Gagal: ' + err.message); }
    finally { e.target.disabled = false; }
  });
  $('#btn-copy-url').addEventListener('click', () => navigator.clipboard?.writeText($('#phone-url').textContent).then(() => toast('URL HP disalin')));
  $('#btn-copy-token').addEventListener('click', () => navigator.clipboard?.writeText(state?.token || '').then(() => toast('Token disalin')));

  // ---------- SSE ----------
  function connectSSE() {
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.onopen = () => { $('#conn-dot').className = 'dot ok'; $('#conn-text').textContent = 'tersambung'; };
    es.onerror = () => { $('#conn-dot').className = 'dot err'; $('#conn-text').textContent = 'terputus — mencoba lagi'; };
    es.onmessage = (ev) => {
      try {
        const { scope } = JSON.parse(ev.data);
        if (scope === 'hello') return;
        loadState();
        if (scope === 'promo') toast('🎁 Data promo diperbarui otomatis');
      } catch { /* noop */ }
    };
    es.addEventListener = es.addEventListener; // noop guard
  }

  // ---------- init ----------
  fillPresets();
  loadState().then(() => { fillPresets(); connectSSE(); });
})();
