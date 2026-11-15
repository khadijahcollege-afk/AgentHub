import test from 'node:test';
import assert from 'node:assert/strict';
import { findFreeEngine } from '../public/model-access.js';

test('model access locates identical model across OpenRouter and OpenCode IDs', () => {
  const engine = { id: 'opencode-free-deepseek-v4.1-flash-free', available: true, model: 'opencode/deepseek-v4.1-flash-free' };
  assert.equal(findFreeEngine([engine], 'deepseek/deepseek-v4.1-flash:free'), engine);
  assert.equal(findFreeEngine([engine], 'deepseek/deepseek-v4.1:free'), null);
  assert.equal(findFreeEngine([{ ...engine, available: false }], engine.model), null);
  assert.equal(findFreeEngine([engine], ''), null);
});
