// Fixture untuk test/helpers-server.test.js: meniru server yang SEMPAT boot
// lalu mati karena crash native Windows (0xC0000409), bukan karena port.
//
// Kenapa perlu: pada satu kegagalan nyata, helper boot melaporkan "biasanya
// port sudah dipakai" padahal log-nya sendiri berisi banner "AgentHub aktif" —
// server sempat hidup. Pesan yang menyebut sebab keliru lebih berbahaya
// daripada pesan yang tidak menyebut sebab, karena mengarahkan orang
// berikutnya untuk memeriksa hal yang tidak bersalah. Fixture ini membuat
// jalur itu bisa diuji tanpa bergantung pada crash yang kebetulan terjadi.
//
// `process.abort()` menghasilkan 0xC0000409 di Windows dan SIGABRT di POSIX,
// jadi tesnya tetap sah di kedua platform.
console.log('┌──────────────────────────────────────────────────┐');
console.log('│  AgentHub aktif                                  │');
console.log('└──────────────────────────────────────────────────┘');
// Beri waktu helper menangkap banner sebelum proses mati.
setTimeout(() => { process.abort(); }, 150);
