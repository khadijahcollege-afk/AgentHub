// test/helpers/port.js — pilih port yang benar-benar bisa didengarkan.
//
// Kenapa perlu: tes menjalankan server sungguhan di port acak dalam rentang
// tetap. Kalau port itu kebetulan dipakai proses lain (di mesin ini port 8890
// dipakai server proyek tetangga), spawn gagal bind, server langsung keluar,
// dan tes gagal dengan pesan "server harus hidup" — seolah kode yang rusak.
// Menguji port dengan benar-benar mendengarkannya menghilangkan tebakan itu.
//
// Kenapa harus MENGHUBUNGI port itu, bukan hanya mencoba bind: di Windows,
// proses lain bisa mendengarkan di `::` saja, sehingga bind IPv4 ke `0.0.0.0`
// di port yang sama TETAP berhasil. Server uji lalu hidup, tetapi setiap
// permintaan ke 127.0.0.1:<port> dijawab proses lain itu — `/healthz` tidak
// pernah 200 dan tes gagal dengan pesan yang menyesatkan. Karena itu port
// dianggap terpakai bila ada yang menjawab sambungan, sebelum bind dicoba.
import net from 'node:net';

function isAnswering(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(300, () => done(false)); // tidak ada yang menjawab = bebas
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

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
    if (await isAnswering(port)) continue;   // dipakai proses lain (walau bind "berhasil")
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
