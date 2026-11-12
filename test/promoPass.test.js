// test/promoPass.test.js — kartu promo, tiket klaim, dan Start Plan.
// Bagian murni menguji jadwal/saldo tanpa jam mesin; bagian HTTP menguji
// kontrak route yang dipakai UI dan agent (validasi, idempotensi, persistensi).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PASS_PLAN, campaignWindow, billingDay, nextResetAt, passPhase,
  quotaFor, matchPassModel, publicPass, isPassModel,
} from '../lib/promoPass.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8240 + Math.floor(Math.random() * 60);
const TOKEN = 'promopass0123456789abcdef';
const API = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;

const api = (p, opts = {}) => fetch(API + p, {
  ...opts,
  headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
});

const action = (name, body) => api(`/api/promo/pass/${name}`, {
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${API}/healthz`); if (r.ok) return true; } catch { /* belum */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-promopass-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT, token: TOKEN, notify: false, refreshHours: 168,
    agentCheckMinutes: 1440, keyCheckHours: 168, baselined: true, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    sources: { openrouter: { models: [] }, list: { providers: [] }, cross: { models: [] } },
    knownIds: [], lastRefresh: Date.now(),
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_DATA: dataDir, AGENTHUB_NO_TOAST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  assert.equal(await waitUp(), true, 'server harus hidup');
});

test.after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------- murni ----------
test('jadwal: drop 22:00, tiket 10 jam, plan 3 hari sampai 22:59', () => {
  const now = new Date(2026, 10, 12, 18, 29, 0).getTime();
  const w = campaignWindow(now);
  assert.equal(new Date(w.startsAt).getHours(), 22);
  assert.equal(new Date(w.startsAt).getMinutes(), 0);
  assert.equal(new Date(w.startsAt).getDate(), 12);
  assert.equal(new Date(w.ticketValidUntil).getDate(), 13);
  assert.equal(new Date(w.ticketValidUntil).getHours(), 8);
  assert.equal(new Date(w.planExpiresAt).getDate(), 15);
  assert.equal(new Date(w.planExpiresAt).getHours(), 22);
  assert.equal(new Date(w.planExpiresAt).getMinutes(), 59);
});

test('jadwal: klaim setelah 22:00 langsung aktif', () => {
  const now = new Date(2026, 10, 12, 23, 15, 0).getTime();
  const w = campaignWindow(now);
  assert.equal(w.startsAt, now);
});

test('fase: available → pending → active → expired', () => {
  const now = new Date(2026, 10, 12, 18, 29, 0).getTime();
  const w = campaignWindow(now);
  const base = { claimed: false, window: w };
  assert.equal(passPhase(base, now), 'available');
  assert.equal(passPhase({ ...base, claimed: true }, now), 'pending');
  assert.equal(passPhase({ ...base, claimed: true }, w.startsAt + 1000), 'active');
  assert.equal(passPhase({ ...base, claimed: true }, w.planExpiresAt), 'expired');
});

test('saldo: upgrade menambah 50% per tingkat', () => {
  const model = PASS_PLAN.models.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(quotaFor({ boosts: 0 }, model), 5_000_000);
  assert.equal(quotaFor({ boosts: 1 }, model), 7_500_000);
  assert.equal(quotaFor({ boosts: 2 }, model), 10_000_000);
});

test('hari penagihan berganti pukul 22:59, bukan tengah malam', () => {
  assert.equal(billingDay(new Date(2026, 10, 12, 18, 29).getTime()), '2026-11-12');
  assert.equal(billingDay(new Date(2026, 10, 12, 22, 58).getTime()), '2026-11-12');
  assert.equal(billingDay(new Date(2026, 10, 12, 22, 59).getTime()), '2026-11-13');
  assert.equal(billingDay(new Date(2026, 10, 13, 2, 0).getTime()), '2026-11-13');
  const next = nextResetAt(new Date(2026, 10, 12, 18, 29).getTime());
  assert.equal(new Date(next).getHours(), 22);
  assert.equal(new Date(next).getMinutes(), 59);
});

test('pencocokan model gateway longgar tapi tidak salah model', () => {
  assert.equal(matchPassModel('zhipu/GLM-5.3-Flash'), 'glm-5.3-flash');
  assert.equal(matchPassModel('glm-5.3'), 'glm-5.3');
  assert.equal(matchPassModel('glm-5.2'), null);
  assert.equal(matchPassModel(''), null);
  assert.equal(isPassModel('glm-5.3-flash'), true);
  assert.equal(isPassModel('gpt-4'), false);
});

test('publicPass: model, visi, kuota, dan label awal konsisten', () => {
  const now = new Date(2026, 10, 12, 18, 29).getTime();
  const pub = publicPass({ claimed: false }, now);
  assert.equal(pub.claimed, false);
  assert.equal(pub.phase, 'available');
  assert.equal(pub.models.length, 2);
  assert.equal(pub.models[1].vision, true);
  assert.equal(pub.models[1].quota, 5_000_000);
  assert.equal(pub.models[0].enabled, true);
  assert.equal(pub.quotaLabel, '100% Quota');
  assert.equal(pub.headlineTokens, 300_000_000);
});

test('publicPass: daftar benefit plan dengan kuota dinamis mengikuti boost', () => {
  const now = new Date(2026, 10, 12, 18, 29).getTime();
  const base = publicPass({ claimed: false }, now);
  assert.ok(Array.isArray(base.benefits.core) && base.benefits.core.length >= 3, 'benefit inti ada');
  assert.equal(base.benefits.exclusive.label, 'Benefit eksklusif ZCode');
  assert.ok(Array.isArray(base.benefits.included) && base.benefits.included.length >= 10, 'checklist "semua yang termasuk" ada');
  const idle = base.benefits.exclusive.items.find((b) => b.text.includes('idle-time'));
  assert.match(idle.text, /5\/hari/, 'tugas idle 5 per hari');
  const quota0 = base.benefits.exclusive.items.find((b) => /% kuota/.test(b.text));
  assert.match(quota0.text, /100%/, 'tanpa boost = 100%');
  assert.match(quota0.mark, /upgrade/, 'ajakan upgrade saat masih 100%');

  const boosted = publicPass({ claimed: true, boosts: 1 }, now);
  const quota1 = boosted.benefits.exclusive.items.find((b) => /% kuota/.test(b.text));
  assert.match(quota1.text, /150%/, 'satu boost = 150%');
  assert.match(quota1.mark, /diskon/, 'label diskon saat >100%');
});

// ---------- HTTP ----------
test('state: promo pass tersedia dan kontrak mesin naik', async () => {
  const state = await (await api('/api/state')).json();
  assert.equal(state.promoPass.claimed, false);
  assert.equal(state.promoPass.phase, 'available');
  assert.equal(state.promoPass.models.length, 2);
  assert.equal(state.machines.promoPass.id, 'promoPass');

  const version = await (await api('/api/version')).json();
  assert.ok(version.machines >= 4);
});

test('klaim: idempoten dan mengisi jendela kampanye', async () => {
  const first = await action('claim');
  assert.equal(first.status, 200);
  const p1 = (await first.json()).pass;
  assert.equal(p1.claimed, true);
  assert.ok(['pending', 'active'].includes(p1.phase));
  assert.ok(p1.ticketValidUntil > p1.startsAt);
  assert.ok(p1.planExpiresAt > p1.startsAt);

  const second = await action('claim');
  const p2 = (await second.json()).pass;
  assert.equal(p2.claimedAt, p1.claimedAt, 'klaim ulang tidak menggeser jadwal');
});

test('toggle: validasi model dan persistensi', async () => {
  const off = await action('toggle', { model: 'glm-5.3-flash', enabled: false });
  assert.equal(off.status, 200);
  const p = (await off.json()).pass;
  const flash = p.models.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(flash.enabled, false);

  const state = await (await api('/api/state')).json();
  assert.equal(state.promoPass.models.find((m) => m.id === 'glm-5.3-flash').enabled, false);

  const bad = await action('toggle', { model: 'tidak-ada', enabled: true });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'MODEL_UNKNOWN');
});

test('add model: hanya katalog addable, idempoten, langsung punya toggle', async () => {
  const add = await action('add-model', { model: 'glm-5.2' });
  assert.equal(add.status, 200);
  const p = (await add.json()).pass;
  assert.equal(p.models.length, 3);
  assert.equal(p.models.some((m) => m.id === 'glm-5.2' && m.enabled), true);
  assert.equal(p.addable.some((m) => m.id === 'glm-5.2'), false);

  const again = await action('add-model', { model: 'glm-5.2' });
  assert.equal((await again.json()).pass.models.length, 3);

  const bad = await action('add-model', { model: 'glm-5.3' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'MODEL_NOT_ADDABLE');
});

test('rename: label tampilan berubah, kosong mengembalikan nama bawaan', async () => {
  const renamed = await action('rename', { model: 'glm-5.2', label: '  GLM   Kerja  ' });
  assert.equal(renamed.status, 200);
  const p = (await renamed.json()).pass;
  assert.equal(p.models.find((m) => m.id === 'glm-5.2').label, 'GLM Kerja');
  assert.equal(p.models.find((m) => m.id === 'glm-5.2').baseLabel, 'GLM-5.2');

  const reset = await action('rename', { model: 'glm-5.2', label: '' });
  const p2 = (await reset.json()).pass;
  assert.equal(p2.models.find((m) => m.id === 'glm-5.2').label, 'GLM-5.2');

  const bad = await action('rename', { model: 'tidak-ada', label: 'X' });
  assert.equal(bad.status, 400);
});

test('upgrade: +50% kuota dan batas tingkat aman', async () => {
  const r = await action('upgrade');
  assert.equal(r.status, 200);
  const p = (await r.json()).pass;
  assert.equal(p.quotaLabel, '150% Quota');
  assert.equal(p.models.find((m) => m.id === 'glm-5.3-flash').quota, 7_500_000);

  for (let i = 0; i < 3; i++) await action('upgrade');
  const max = await action('upgrade');
  assert.equal(max.status, 409);
  assert.equal((await max.json()).code, 'QUOTA_MAX');
});

test('dismiss/restore: kartu bisa disembunyikan tanpa menghapus tiket', async () => {
  const hide = await action('dismiss', { dismissed: true });
  assert.equal((await hide.json()).pass.dismissed, true);
  const state = await (await api('/api/state')).json();
  assert.equal(state.promoPass.dismissed, true);
  assert.equal(state.promoPass.claimed, true);

  const show = await action('dismiss', { dismissed: false });
  assert.equal((await show.json()).pass.dismissed, false);
});

test('share: teks membawa brand dan kuota, waktu bagikan tersimpan', async () => {
  const r = await action('share');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.text, /AgentHub GLOBAL BUILD/);
  assert.match(j.text, /300,000,000/);
  assert.ok(j.pass.sharedAt > 0);
});

test('aksi tidak dikenal dan JSON rusak ditolak rapi', async () => {
  const unknown = await action('tidak-ada');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'ACTION_UNKNOWN');

  const broken = await api('/api/promo/pass/toggle', {
    method: 'POST', body: '{bukan json',
  });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).code, 'BAD_JSON');
});
