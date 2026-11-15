import http from 'node:http';
import crypto from 'node:crypto';
import { addKey } from './keys.js';

const sessions = new Map();
export function connectionStatus(id) {
  const session = sessions.get(id);
  return session ? { status: session.status } : { status: 'expired' };
}

// A private loopback callback receives only the authorization code. The key
// exchange and storage stay on the server; no credential is returned to UI.
export async function connectOpenRouter(model) {
  if (typeof model !== 'string' || !(model.endsWith(':free') || model === 'openrouter/free') || model.length > 120) {
    throw Object.assign(new Error('Koneksi otomatis ini hanya untuk model OpenRouter :free'), { statusCode: 400 });
  }
  if ([...sessions.values()].filter(s => s.status === 'pending').length >= 8) {
    throw Object.assign(new Error('Terlalu banyak login tertunda. Selesaikan login yang sudah dibuka atau tunggu hingga kedaluwarsa.'), { statusCode: 429 });
  }
  const id = crypto.randomBytes(24).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const session = { status: 'pending' };
  sessions.set(id, session);
  let processing = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== id || !url.searchParams.get('code') || processing) {
      res.writeHead(400); res.end('Invalid authorization callback'); return;
    }
    processing = true;
    try {
      const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: url.searchParams.get('code'), code_verifier: verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw Error('Authorization exchange failed');
      const data = await response.json();
      if (typeof data.key !== 'string' || !data.key) throw Error('Missing credential');
      addKey({ preset: 'openrouter', name: 'OpenRouter · login otomatis', key: data.key, pool: true, poolModel: model });
      session.status = 'connected';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OpenRouter terhubung. API key sudah dipasang otomatis. Tutup tab ini dan kembali ke AgentHub.');
    } catch {
      session.status = 'error'; res.writeHead(502); res.end('Login gagal. Kembali ke AgentHub untuk mencoba lagi.');
    } finally { server.close(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { server.close(); sessions.delete(id); }, 10 * 60 * 1000);
  timer.unref();
  const auth = new URL('https://openrouter.ai/auth');
  auth.searchParams.set('callback_url', `http://127.0.0.1:${server.address().port}/callback?state=${id}`);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', id);
  auth.searchParams.set('key_label', 'AgentHub free models');
  return { id, url: auth.href };
}
