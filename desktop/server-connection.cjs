// Handshake desktop: jangan menempel ke server lama atau data pengguna lain.
const http = require('node:http');

function readJson(port, route, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: route,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) req.destroy(new Error('Respons terlalu besar'));
      });
      res.on('error', () => finish({ occupied: true }));
      res.on('end', () => {
        try { finish({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { finish({ occupied: true }); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Timeout')), timeoutMs);
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    req.on('error', (error) => finish({ absent: error.code === 'ECONNREFUSED' }));
  });
}

async function probeServer({ port, token, version, timeoutMs }) {
  const health = await readJson(port, '/healthz', '', timeoutMs);
  if (health.absent) return { state: 'absent' };
  if (health.status !== 200 || health.body?.ok !== true || health.body?.name !== 'AgentHub') {
    return { state: 'blocked', reason: `Port ${port} digunakan layanan lain atau tidak merespons.` };
  }
  if (health.body.version !== version) {
    return {
      state: 'blocked',
      reason: `Server AgentHub ${health.body.version || 'lama (tanpa versi)'} masih berjalan di port ${port}. Aplikasi ini membutuhkan versi ${version}.`,
    };
  }
  if (!token) return { state: 'blocked', reason: 'Token konfigurasi lokal belum tersedia.' };
  const info = await readJson(port, '/api/serverinfo', token, timeoutMs);
  if (info.status !== 200 || info.body?.version !== version || info.body?.port !== port) {
    return { state: 'blocked', reason: 'Server tidak cocok dengan konfigurasi pengguna aplikasi ini.' };
  }
  return { state: 'ready', port };
}

module.exports = { probeServer };
