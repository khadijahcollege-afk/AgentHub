// test/machines.test.js — node:test, tanpa dependency.
// Menjaga kontrak state machine supaya perubahan aturan tidak diam-diam
// merusak UI (tombol yang salah) atau agent (transisi yang ditolak).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATUSES, TASK_MACHINE, taskCanMove, taskNext, TASK_LABELS,
  RUN_MACHINE, CONNECTION_MACHINE, KEY_MACHINE, AGENT_MACHINE,
  PROMO_MACHINE, PROMO_PASS_MACHINE, VIEWS, UI_LAYERS, UI_MACHINE, SSE_SCOPES, scopeSlices,
  STEP_MACHINE, DELEGATION_MACHINE, NOTE_EDITOR_MACHINE,
  canTransition, allowedNext, transitionError, MACHINE_VERSION,
  KEY_POOL_CANDIDATE, KEY_POOL_ACTIVE, KEY_MODEL_VISIBLE,
  keyPoolCandidate, keyPoolActive, keyModelVisible, noteEditorCanLeave,
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
    promoPass: PROMO_PASS_MACHINE,
    step: STEP_MACHINE, delegation: DELEGATION_MACHINE, noteEditor: NOTE_EDITOR_MACHINE,
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

test('helper transisi: state yang sama selalu sah, error membawa allowed', () => {
  assert.equal(canTransition(RUN_MACHINE, 'running', 'running'), true);
  assert.equal(canTransition(RUN_MACHINE, 'idle', 'done'), false);
  assert.deepEqual(allowedNext(RUN_MACHINE, 'idle'), ['running']);
  const err = transitionError(RUN_MACHINE, 'idle', 'done');
  assert.equal(err.code, 'ILLEGAL_TRANSITION');
  assert.equal(err.machine, 'run');
  assert.deepEqual(err.allowed, ['running']);
});

test('step: subrun dimulai working dan berakhir di satu state terminal', () => {
  assert.equal(STEP_MACHINE.initial, 'working');
  for (const target of STEP_MACHINE.terminal) {
    assert.equal(canTransition(STEP_MACHINE, 'working', target), true, target);
    assert.deepEqual(STEP_MACHINE.transitions[target], ['working'], `retry dari ${target}`);
  }
  assert.equal(canTransition(STEP_MACHINE, 'working', 'idle'), false);
});

test('delegation: hanya bisa mulai dari idle dan berhenti di terminal', () => {
  assert.deepEqual(DELEGATION_MACHINE.transitions.idle, ['starting']);
  for (const t of DELEGATION_MACHINE.terminal) {
    assert.equal(canTransition(DELEGATION_MACHINE, 'running', t), true, t);
    assert.ok(DELEGATION_MACHINE.transitions[t].includes('starting'), `${t} bisa diulang`);
  }
  assert.equal(canTransition(DELEGATION_MACHINE, 'done', 'running'), false);
});

test('note editor: dirty tidak boleh ditutup diam-diam', () => {
  assert.equal(noteEditorCanLeave('dirty'), false);
  assert.equal(noteEditorCanLeave('saving'), true);
  assert.equal(noteEditorCanLeave('closed'), true);
  assert.equal(canTransition(NOTE_EDITOR_MACHINE, 'editing', 'dirty'), true);
  assert.equal(canTransition(NOTE_EDITOR_MACHINE, 'dirty', 'saving'), true);
});

test('promo pass: tersedia bisa langsung aktif atau menunggu jadwal, lalu final', () => {
  assert.equal(PROMO_PASS_MACHINE.initial, 'available');
  assert.deepEqual(PROMO_PASS_MACHINE.transitions.available, ['pending', 'active']);
  assert.deepEqual(PROMO_PASS_MACHINE.transitions.pending, ['active', 'expired']);
  assert.deepEqual(PROMO_PASS_MACHINE.transitions.active, ['expired']);
  assert.deepEqual(PROMO_PASS_MACHINE.transitions.expired, []);
});

test('pool: himpunan status eksplisit dan konsisten', () => {
  assert.deepEqual(KEY_POOL_CANDIDATE, ['valid', 'unknown', 'error', 'checking']);
  assert.deepEqual(KEY_POOL_ACTIVE, ['valid']);
  assert.deepEqual(KEY_MODEL_VISIBLE, ['valid', 'unknown']);
  // setiap status pool harus dikenal mesin key
  for (const s of [...KEY_POOL_CANDIDATE, ...KEY_POOL_ACTIVE, ...KEY_MODEL_VISIBLE]) {
    assert.ok(KEY_MACHINE.states[s], `status ${s}`);
  }
  assert.equal(keyPoolCandidate('invalid'), false);
  assert.equal(keyPoolCandidate('error'), true);
  assert.equal(keyPoolActive('unknown'), false);
  assert.equal(keyModelVisible('unknown'), true);
  assert.ok(MACHINE_VERSION >= 2);
});
