// test/machines.test.js — node:test, tanpa dependency.
// Menjaga kontrak state machine supaya perubahan aturan tidak diam-diam
// merusak UI (tombol yang salah) atau agent (transisi yang ditolak).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATUSES, TASK_MACHINE, taskCanMove, taskNext, TASK_LABELS,
  RUN_MACHINE, CONNECTION_MACHINE, KEY_MACHINE, AGENT_MACHINE,
  PROMO_MACHINE, VIEWS, UI_LAYERS, UI_MACHINE, SSE_SCOPES, scopeSlices,
} from '../lib/machines.js';

test('task: rantai linear persis inbox→todo→running→review→done', () => {
  assert.deepEqual(TASK_STATUSES, ['inbox', 'todo', 'running', 'review', 'done']);
  for (let i = 0; i < TASK_STATUSES.length; i++) {
    const from = TASK_STATUSES[i];
    const to = TASK_STATUSES[i + 1];
    assert.deepEqual(TASK_MACHINE.transitions[from], to ? [to] : [], `transisi dari ${from}`);
  }
});

test('task: lompatan kolom ditolak', () => {
  assert.equal(taskCanMove('inbox', 'running'), false);
  assert.equal(taskCanMove('inbox', 'done'), false);
  assert.equal(taskCanMove('todo', 'review'), false);
  assert.equal(taskCanMove('done', 'review'), false);
  assert.equal(taskCanMove('review', 'done'), true);
  assert.equal(taskCanMove('inbox', 'todo'), true);
});

test('task: setiap status punya label, label unik', () => {
  const labels = TASK_STATUSES.map((s) => TASK_LABELS[s]);
  assert.ok(labels.every(Boolean));
  assert.equal(new Set(labels).size, labels.length);
});

test('task: taskNext konsisten dengan transitions', () => {
  for (const s of TASK_STATUSES) {
    const next = taskNext(s, 1);
    if (next) assert.equal(taskCanMove(s, next), true, `${s}→${next}`);
    else assert.deepEqual(TASK_MACHINE.transitions[s], []);
    const prev = taskNext(s, -1);
    if (prev) assert.equal(taskCanMove(prev, s), true, `${prev}→${s}`);
  }
  assert.equal(taskNext('done', 1), null);
  assert.equal(taskNext('inbox', -1), null);
});

test('semua mesin: transisi hanya menunjuk state yang dikenal', () => {
  const machines = {
    task: TASK_MACHINE, run: RUN_MACHINE, connection: CONNECTION_MACHINE,
    key: KEY_MACHINE, agent: AGENT_MACHINE, promo: PROMO_MACHINE,
  };
  for (const [name, m] of Object.entries(machines)) {
    const states = new Set(Object.keys(m.states));
    for (const [from, tos] of Object.entries(m.transitions)) {
      assert.ok(states.has(from), `${name}: state asal ${from} tidak dikenal`);
      for (const to of tos) assert.ok(states.has(to), `${name}: target ${to} tidak dikenal`);
    }
    // setiap state harus muncul sebagai kunci transitions
    for (const s of states) assert.ok(m.transitions[s], `${name}: ${s} tidak punya transitions`);
    // initial harus state nyata
    if (m.initial) assert.ok(states.has(m.initial), `${name}: initial ${m.initial}`);
  }
});

test('run: state akhir hanya bisa direset ke idle atau dijalankan ulang', () => {
  for (const t of RUN_MACHINE.terminal) {
    assert.deepEqual([...RUN_MACHINE.transitions[t]].sort(), ['idle', 'running'], `${t}`);
  }
  assert.ok(RUN_MACHINE.transitions.running.includes('stopped'));
  assert.deepEqual(RUN_MACHINE.transitions.idle, ['running']);
});

test('connection: tidak bisa langsung unauthorized→offline (harus lewat connecting)', () => {
  assert.equal(CONNECTION_MACHINE.transitions.unauthorized.includes('offline'), false);
  assert.equal(CONNECTION_MACHINE.transitions.live.includes('degraded'), true);
});

test('ui: hanya satu layer aktif, dan bisa ditutup dari mana saja', () => {
  for (const l of UI_LAYERS) {
    assert.ok(UI_MACHINE.transitions[l].includes(null), `${l} harus bisa ditutup`);
    assert.deepEqual(UI_MACHINE.transitions[l].filter(Boolean).sort(), UI_LAYERS.filter((x) => x !== l).sort());
  }
});

test('scope SSE: setiap scope punya pemetaan slice', () => {
  for (const s of Object.keys(SSE_SCOPES)) {
    assert.ok(Array.isArray(scopeSlices(s)), s);
  }
  assert.deepEqual(scopeSlices('tasks'), ['tasks']);
  assert.deepEqual(scopeSlices('keys').sort(), ['keys', 'pool']);
  assert.deepEqual(scopeSlices('tidak-dikenal'), ['all']);
  assert.deepEqual(scopeSlices('hello'), []);
});

test('views: minimal satu view per tombol rail, studio sebagai awal', () => {
  assert.ok(VIEWS.includes('studio'));
  assert.equal(new Set(VIEWS).size, VIEWS.length);
});
