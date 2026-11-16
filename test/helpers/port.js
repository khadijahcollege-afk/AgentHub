// test/helpers/port.js — pilih port yang benar-benar bisa didengarkan.
//
// Kenapa perlu: tes menjalankan server sungguhan di port acak dalam rentang
// tetap. Kalau port itu kebetulan dipakai proses lain (di mesin ini port 8890
// dipakai server proyek tetangga), spawn gagal bind, server langsung keluar,
// dan tes gagal dengan pesan "server harus hidup" — seolah kode yang rusak.
// Menguji port dengan benar-benar mendengarkannya menghilangkan tebakan itu.
import net from 'node:net';

function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    // Dengarkan di 0.0.0.0, sama persis seperti server.js. Menguji lewat `::`
    // (default Node) TIDAK cukup di Windows: socket IPv6-only bisa bind ke port
    // yang sudah dipakai di IPv4, sehingga port terpakai terlihat "bebas".
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

export async function pickFreePort(start, span = 20) {
  const offset = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = start + ((offset + i) % span);
    if (await canListen(port)) return port;
  }
  // Seluruh kandidat terpakai: minta port ephemeral dari OS (juga di 0.0.0.0,
  // supaya jaminan "bisa didengarkan" yang sama berlaku).
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
