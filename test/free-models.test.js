import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFreeModels, freeModelEngine } from '../lib/free-models.js';

test('free catalog requires explicit zero cost, active status and tool support', () => {
  const base = { id: 'candidate', providerID: 'opencode', status: 'active', cost: { input: 0, output: 0 }, capabilities: { toolcall: true } };
  const candidates = [base, { ...base, id: 'glm-5.3-flash-free' },
    { ...base, id: 'paid', cost: { input: 0, output: 1 } },
    { ...base, id: 'unknown', cost: {} },
    { ...base, id: 'cached-paid', cost: { input: 0, output: 0, cache: { read: 1 } } },
    { ...base, id: 'retired', status: 'deprecated' },
    { ...base, id: 'chat-only', capabilities: { toolcall: false } },
  ];
  const catalog = candidates.map(m => `opencode/${m.id}\n${JSON.stringify(m, null, 2)}`).join('\n');
  assert.deepEqual(parseFreeModels(catalog), [{ id: 'candidate', name: 'candidate' }, { id: 'glm-5.3-flash-free', name: 'glm-5.3-flash-free' }]);
  assert.deepEqual(parseFreeModels('opencode/broken\n{'), []);
});

test('free engine pins exact model and preserves existing Big Pickle engine ID', () => {
  const engine = freeModelEngine({ id: 'example-free', name: 'Example' });
  assert.equal(engine.args[engine.args.indexOf('--model') + 1], 'opencode/example-free');
  assert.equal(engine.stdin, true);
  assert.equal(engine.optIn, true);
  assert.equal(freeModelEngine({ id: 'big-pickle', name: 'Big Pickle' }).id, 'opencode-free');
});
