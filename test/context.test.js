// test/context.test.js — perkiraan jendela konteks (fungsi murni, tanpa server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelContextLimit, contextStats } from '../lib/context.js';

const snapshot = {
  sources: {
    openrouter: { models: [{ id: 'google/gemini-x:free', context: 1000000 }] },
    cross: { models: [{ id: 'zai/glm-5.3', context: 200000 }] },
    list: { models: [] },
  },
};

test('context: batas konteks dicari longgar di snapshot promo', () => {
  assert.equal(modelContextLimit('google/gemini-x:free', snapshot), 1000000);
  assert.equal(modelContextLimit('google/gemini-x', snapshot), 1000000, 'tanpa akhiran :free tetap ketemu');
  assert.equal(modelContextLimit('preset/zai/glm-5.3', snapshot), 200000, 'akhiran id cocok (gateway bisa mengubah prefiks)');
  assert.equal(modelContextLimit('model-tidak-dikenal', snapshot), null, 'model tak dikenal → null, bukan tebakan');
  assert.equal(modelContextLimit(null, snapshot), null);
});

test('context: statistik dari usage upstream nyata + riwayat perkiraan', () => {
  const msgs = [
    { role: 'user', content: 'a'.repeat(4000) }, // ≈ 1000 token (chars/4)
    { role: 'assistant', content: 'ok' },
    { role: 'assistant', content: 'x'.repeat(8000), runStatus: 'error' }, // tidak ikut riwayat
    { role: 'user', content: 'lanjut' },
    { role: 'assistant', content: 'b'.repeat(2000), usage: {
      prompt_tokens: 1200,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 600 },
    } },
  ];
  const s = contextStats({ model: 'zai/glm-5.3', msgs, snapshot });
  assert.equal(s.input, 1200);
  assert.equal(s.output, 30);
  assert.equal(s.limit, 200000);
  assert.equal(s.usagePct, 0.6);
  assert.equal(s.historyTokens, 1001, '4002 chars sebelum user terakhir ÷ 4, pesan error dikecualikan');
  assert.equal(s.promptTokens, 199, 'sisa input setelah riwayat');
  assert.equal(s.cacheHitRate, 50, 'cached 600 dari prompt 1200');
  assert.equal(s.estimated, true);
});

test('context: null bila tidak ada usage (engine CLI tidak melaporkan)', () => {
  assert.equal(contextStats({ model: 'claude-x', msgs: [{ role: 'user', content: 'hai' }], snapshot }), null);
  assert.equal(contextStats({ model: 'claude-x', msgs: [], snapshot }), null);
});
