// Live smoke test, opt-in: contacts the explicitly selected free model.
// Artifacts and isolated AgentHub data are retained for inspection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'orchestra-free-'));
process.env.AGENTHUB_DATA = path.join(root, 'data');
fs.mkdirSync(process.env.AGENTHUB_DATA);
const modelArg = process.argv.find(arg => arg.startsWith('--model='));
const model = modelArg ? modelArg.slice('--model='.length) : 'opencode/big-pickle';
const parallel = process.argv.includes('--parallel');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'sum.cjs'), 'module.exports = (a, b) => a - b;\n');
fs.writeFileSync(path.join(repo, 'sum.test.cjs'), `const test = require('node:test');
const assert = require('node:assert/strict');
const sum = require('./sum.cjs');
test('sum handles positive, negative, zero and decimal inputs', () => {
  for (const [a,b,result] of [[2,3,5],[-4,2,-2],[0,8,8],[1.5,2.25,3.75]]) assert.equal(sum(a,b), result);
});
`);
if (parallel) {
  fs.writeFileSync(path.join(repo, 'multiply.cjs'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'multiply.test.cjs'), `const test = require('node:test');
const assert = require('node:assert/strict');
const multiply = require('./multiply.cjs');
test('multiply handles positive, negative, zero and decimal inputs', () => {
  for (const [a,b,result] of [[2,3,6],[-4,2,-8],[0,8,0],[1.5,2,3]]) assert.equal(multiply(a,b), result);
});
`);
}
function git(args) {
  return execFileSync('git', ['-c', 'user.name=AgentHub', '-c', 'user.email=agenthub@localhost', ...args], { cwd: repo, encoding: 'utf8' });
}
git(['init']); git(['add', '.']); git(['commit', '-m', 'Smoke fixture']);
const orch = await import('../lib/orchestra.js');
const { runEngine, listEngines } = await import('../lib/harness.js');
const available = await listEngines(true);
const engine = available.find(e => e.optIn && e.available && (e.model === model || (model === 'opencode/big-pickle' && e.id === 'opencode-free')));
assert.ok(engine, 'Model harus tersedia sebagai engine gratis dari katalog OpenCode');
const entry = orch.createOrchestration({ name: 'Live free model smoke',
  prompt: 'Fix sum.cjs to correctly add two numbers. Edit only sum.cjs. Read sum.test.cjs and run node --test sum.test.cjs to verify. Do not delegate. Do not commit. Keep the response brief.',
  agents: parallel ? [engine.id, engine.id] : [engine.id], baseDir: repo, testCommand: 'node --test sum.test.cjs' });
console.log(JSON.stringify({ root, model, orchestrationId: entry.id }));
try {
  orch.prepareOrchestration(entry.id);
  const worktrees = orch.prepareWorktrees(entry.id);
  orch.patchOrchestration(entry.id, { state: 'running' });
  const started = Date.now();
  const results = await Promise.allSettled(worktrees.map(async (cwd, index) => {
  const target = index === 0 ? 'sum' : 'multiply';
  const prompt = index === 0 ? entry.prompt : 'Fix multiply.cjs to correctly multiply two numbers. Edit only multiply.cjs. Read multiply.test.cjs and run node --test multiply.test.cjs to verify. Do not delegate. Do not commit. Keep the response brief.';
  const result = await runEngine(engine.id, prompt, { cwd, signal: AbortSignal.timeout(180000) });
  fs.writeFileSync(path.join(root, `model-output-${index}.txt`), result.text);
  assert.equal(result.exitCode, 0, `CLI failed: ${result.text.slice(-1500)}`);
  assert.equal(orch.commitAgent(entry.id, index).ok, true);
  const out = execFileSync(process.execPath, ['--test', `${target}.test.cjs`], { cwd, encoding: 'utf8' });
  const ci = { ok: true, out, code: 0 };
  const diff = orch.branchDiff(entry.id, index);
  fs.writeFileSync(path.join(root, `ci-${index}.txt`), out);
  const changed = execFileSync('git', ['diff', '--name-only', `base-${entry.id.slice(0, 6)}...HEAD`], { cwd, encoding: 'utf8' }).trim();
  assert.equal(changed, `${target}.cjs`, 'agent must change only its assigned file');
  const readNormalized = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(readNormalized(path.join(cwd, 'sum.test.cjs')), readNormalized(path.join(repo, 'sum.test.cjs')));
  orch.updateAgent(entry.id, index, { status: 'ok', diff, ci });
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') orch.updateAgent(entry.id, index, { status: 'error', error: result.reason.message });
  });
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  orch.patchOrchestration(entry.id, { state: 'reviewing' });
  assert.deepEqual(orch.mergeOrchestration(entry.id).merged, entry.agents.map(a => a.engineId));
  const mirror = orch.getOrchestration(entry.id).mirror;
  const mergedTests = execFileSync(process.execPath, ['--test', 'sum.test.cjs', ...(parallel ? ['multiply.test.cjs'] : [])], { cwd: mirror, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'ci-merged.txt'), mergedTests);
  const patch = orch.exportPatch(entry.id);
  assert.match(patch, /sum\.cjs/);
  if (parallel) assert.match(patch, /multiply\.cjs/);
  fs.writeFileSync(path.join(root, 'result.patch'), patch + '\n');
  console.log(JSON.stringify({ ok: true, model, agents: worktrees.length, ms: Date.now() - started, root, patch: path.join(root, 'result.patch') }));
} catch (error) {
  orch.patchOrchestration(entry.id, { state: 'error' });
  console.error(error.message);
  console.error(`Artifacts: ${root}`);
  process.exitCode = 1;
}
