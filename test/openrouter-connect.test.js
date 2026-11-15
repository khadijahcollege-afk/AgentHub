import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-oauth-test-'));
process.env.AGENTHUB_DATA = dataDir;
const { connectOpenRouter, connectionStatus } = await import('../lib/openrouter-connect.js');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('OpenRouter rejects paid models before starting authorization', async () => {
  await assert.rejects(connectOpenRouter('vendor/paid'), { statusCode: 400 });
});

test('OpenRouter PKCE rejects wrong state and stores exchanged credential server-side', async () => {
  const originalFetch = globalThis.fetch;
  const connection = await connectOpenRouter('openrouter/free');
  const auth = new URL(connection.url);
  assert.equal(auth.origin, 'https://openrouter.ai');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(auth.searchParams.get('callback_url'));
  assert.equal(callback.searchParams.get('state'), connection.id);
  callback.searchParams.set('state', 'incorrect');
  callback.searchParams.set('code', 'test-code');
  assert.equal((await originalFetch(callback)).status, 400);
  assert.equal(connectionStatus(connection.id).status, 'pending');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(options.body);
    assert.equal(body.code, 'test-code');
    assert.equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
    return Response.json({ key: 'test-credential-never-returned' });
  };
  try {
    callback.searchParams.set('state', connection.id);
    const response = await originalFetch(callback);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('test-credential'));
    assert.deepEqual(connectionStatus(connection.id), { status: 'connected' });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8'));
    assert.equal(stored[0].poolModel, 'openrouter/free');
    assert.equal(stored[0].key, 'test-credential-never-returned');
  } finally { globalThis.fetch = originalFetch; }
});
