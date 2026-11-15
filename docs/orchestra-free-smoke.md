# Uji Orchestra dengan model gratis

AgentHub membaca `opencode models opencode --verbose --pure` saat memperbarui
daftar engine dan menyimpan katalog selama satu jam. Model provider OpenCode
yang aktif, mendukung tool, dan secara eksplisit memiliki biaya input/output
nol ditambahkan sebagai pilihan engine gratis. Biaya cache yang dilaporkan
juga harus nol. Setiap pilihan mengunci model tertentu tanpa fallback.
Status CLI tersedia berarti executable terdeteksi, bukan bukti model berhasil
melayani permintaan. Big Pickle sudah diuji dengan tugas nyata; pilihan hasil
penemuan lainnya belum otomatis diuji melalui inference.

Di Settings → Orchestrator, pilih engine **OpenCode · Big Pickle (gratis)**.
Pilihan ini muncul ketika CLI OpenCode terdeteksi di PATH dan tidak dicentang
secara otomatis. Untuk menjalankan hanya model gratis, kosongkan pilihan
engine lain sebelum membuat tim. Deteksi CLI belum menjamin provider sedang
tersedia. Engine ini mengunci model ke `opencode/big-pickle` tanpa fallback.

Jalankan dari direktori AgentHub:

```sh
node tools/smoke-orchestra-free.mjs
```

Untuk dua agen dengan model yang sama pada worktree terpisah:

```sh
node tools/smoke-orchestra-free.mjs --parallel
```

Pilih model lain yang terdeteksi dalam katalog gratis:

```sh
node tools/smoke-orchestra-free.mjs --model=opencode/flint-40b-free
```

Argumen `--model` bisa digabung dengan `--parallel`. Model yang tidak tersedia
sebagai engine gratis ditolak sebelum inference dimulai.

Mode paralel memberi tugas penjumlahan dan perkalian pada agen berbeda.
Skrip memeriksa bahwa setiap agen hanya mengubah file tugasnya, lalu menjalankan
kedua tes kembali pada hasil merge.

Di UI, klik **Tambah agen dengan tugas khusus** untuk setiap anggota tim.
Pilih engine dan tulis tugasnya, misalnya file yang boleh diedit. Engine yang
sama dapat dipilih pada beberapa baris. Prompt tim menjadi konteks bersama,
sedangkan tugas khusus ditambahkan pada prompt masing-masing agen. Menambah
baris pertama mengosongkan centang engine awal; pilihan tersebut masih bisa
dicentang kembali jika dibutuhkan. Pembatasan file dalam tugas merupakan
instruksi model, bukan pembatasan akses filesystem.

Uji ini memanggil model sungguhan melalui CLI `opencode`, sehingga memerlukan
akses jaringan, Git, Node.js, dan OpenCode yang tersedia di PATH. Model dipilih
secara eksplisit: `opencode/big-pickle`. Katalog CLI saat penyiapan melaporkan
biaya input/output nol. Periksa ketersediaan dan harga sebelum menjalankannya
lagi dengan `opencode models opencode --verbose`; ketentuan provider bisa berubah.

Skrip membuat repo percobaan dan data AgentHub terpisah, lalu menggunakan
modul Orchestra untuk membuat mirror dan worktree. Model diminta memperbaiki
`sum.cjs`, menjalankan tes, dan membiarkan berkas tes tetap sama. Verifikasi
lokal memeriksa exit code CLI, menjalankan tes lagi, memeriksa diff dan isi
berkas tes dengan normalisasi CRLF/LF, lalu menggabungkan cabang dan mengekspor
patch. Uji ini tidak mencakup UI atau rute HTTP Orchestra.

Pemanggilan model dibatasi tiga menit. Prompt dikirim melalui stdin agar
tidak bergantung pada pengutipan prompt sebagai argumen shell Windows.
`--auto` mengizinkan CLI melakukan pekerjaan di repo percobaan tanpa dialog;
`--pure` menonaktifkan plugin eksternal. Tidak ada fallback model berbayar.

Folder hasil dicetak sebagai `root`. Di Windows, folder berada di
`%LOCALAPPDATA%\Temp\opencode\orchestra-free-*`. Artefak dipertahankan:

- `model-output-<index>.txt`: respons CLI per agen.
- `ci-<index>.txt`: hasil verifikasi tes lokal per agen.
- `ci-merged.txt`: hasil tes pada cabang gabungan.
- `result.patch`: patch hasil merge, hanya dibuat setelah verifikasi berhasil.
- `data/`: konfigurasi dan status Orchestra terisolasi.
- `repo` beserta mirror/worktree: repo percobaan dan perubahan model.

Keberhasilan lengkap ditandai keluaran JSON `"ok": true` dan exit code 0.
Jika gagal, skrip mencetak penyebab serta folder artefak dan keluar dengan kode 1.
Uji jaringan ini sengaja terpisah dari `npm test` agar tes regresi tidak
bergantung pada ketersediaan provider atau kuota model gratis.
