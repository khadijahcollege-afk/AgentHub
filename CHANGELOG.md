# Changelog

## 1.9.8 — 2026-11-18
Free Auto berhenti membuang model yang sehat hanya karena ia lambat.

Ambang "tanpa output" di rotasi model gratis adalah 30 detik. Saya ukur waktu
tunggu sungguhan di mesin ini: token pertama model gratis datang pada 11–39
detik. Jadi ambang itu lebih pendek daripada waktu jawab yang normal. Big Pickle
selalu dipotong di 30 detik padahal butuh 38,8 detik — lalu karena dianggap
gagal, ia dikarantina 10 menit. Rotasi otomatis kehilangan anggotanya sendiri,
dan catatannya berbunyi "gagal", padahal modelnya sehat.

- **Lambat bukan gagal** (`lib/freerot.js`) — `markSlow()` baru: model yang belum
  mengeluarkan apa pun sampai tenggat dijeda **3 menit**, bukan 10, dan hitungan
  gagalnya tidak naik. Model yang benar-benar error tetap dikarantina penuh.
- **Tenggat menyesuaikan kecepatan model** — `noteFirst()` mencatat waktu token
  pertama yang benar-benar teramati (rata-rata bergerak 60/40), dan
  `firstTimeoutFor()` memberi tenggat 2× kecepatan itu. Model yang terbukti butuh
  39 detik tidak dipotong di 30 detik lagi.
- **Ambang bawaan 75 detik** (`server.js`) — di atas puncak 39 detik yang terukur,
  masih jauh di bawah batas run 10 menit, jadi run yang benar-benar macet tetap
  berakhir.
- **Dua cacat ikut ditemukan saat menguji** — `markOk()` menulis objek baru tanpa
  `firstMs`, sehingga catatan kecepatan model yang justru **berhasil** menjawab
  langsung terhapus; dan waktu token pertama diukur saat run selesai, bukan saat
  token pertama keluar. Keduanya membatalkan penyesuaian tenggat.
- **Penjaga baru** (`test/freerot.test.js`) — 2 tes unit dan 1 tes server yang
  membaca `freerot.json` di disk, bukan kode. Diuji dengan 5 mutasi: 5/5 tertangkap.

Suite: 672 tes, hijau.

## 1.9.7 — 2026-11-18
Warna AgentHub bisa diganti sesuka hati, seperti di Discord.

Lima tema yang ada semuanya abu-abu netral: yang berubah hanya terang-gelap.
Bukan karena kurang pilihan, tetapi karena strukturnya: hampir seribu warna
ditulis langsung di tiap aturan (`.card { background: #19191c }`), sehingga
menambah palet berarti menulis ulang setiap aturan. Elemen baru yang memakai
warna harfiah langsung mematahkan semua palet — dan patahnya tidak terlihat
sebagai kesalahan, elemen itu hanya tetap abu-abu di tengah jendela berwarna.

- **Dua sumbu yang berdiri sendiri** (`public/app.js`, `public/style.css`) —
  tema mengatur terang-gelap, palet mengatur rona permukaan; bisa dikombinasikan.
  Palet hanya berlaku di tema gelap karena tema Terang memakai inversi.
- **Empat palet baru** — *Midnight*, *Aurora*, *Ungu*, *Senja*. Masing-masing
  mengisi 55 token: permukaan, kartu berlapis, garis, teks redup, dan sepuluh
  kanal warna permukaan kaca.
- **Satu kosakata token** — 169 warna netral menjadi variabel, dan
  `workspace.css` yang menimpa `:root` dengan definisinya sendiri kini memakai
  kosakata yang sama. Itu akar masalahnya: berkas itu dimuat setelah
  `style.css`, jadi palet kalah untuk `--bg`, `--side`, `--surface`.
- **Kaca ikut palet** — sebelas latar translusen diubah ke
  `rgb(var(--glass-*-rgb) / α)`.
- **Empat cacat diperbaiki sebelum rilis** — palet mematikan efek kaca (selector
  kini `:not([data-tl="1"])`); `--side` tertimpa nilai solid; palet *Ungu*
  kehilangan `--surface`/`--surface2`; `--muted2` 10px turun ke 3.05:1 lalu
  dinaikkan ke 4.6:1 (tema bawaan ikut 4.41 → 4.65).
- **17 penjaga tema baru** (`test/theme.test.js`) — kelengkapan token, keseragaman
  set, kontras WCAG, token ganda, kaca tetap translusen, dan larangan nilai kaca
  harfiah. Diuji dengan 7 mutasi: semuanya tertangkap.

## 1.9.6 — 2026-11-18
Gateway berhenti membuang key yang sah hanya karena aplikasinya ditolak.

Saat mencoba alur key sungguhan, sebuah gateway membalas HTTP 403
`client_not_allowed` — "hanya klien tertentu yang didukung". Key-nya sendiri
sah: `/models` menjawab 200 dengan key yang sama. Kode lama memperlakukan
**setiap** 401/403 sebagai key salah: ditandai `invalid`, dikeluarkan dari pool,
tidak pernah dicoba lagi. Key yang benar hilang tanpa jalan kembali, dan agent
melaporkan "key ditolak" padahal yang ditolak adalah identitas aplikasinya.

- **403 dibedakan menjadi dua** (`lib/pool.js`) — penolakan yang menyebut klien
  (`client_not_allowed`, `仅支持`, `unsupported client`, `third-party client`)
  tidak lagi mengubah status key.
- **Key yang ditolak kliennya dijeda 10 menit** (`lib/pool.js`) — tanpa jeda,
  setiap permintaan agent menabrak penolakan yang sama, dan gateway yang
  membatasi klien bisa membaca pola itu sebagai penyalahgunaan.
- **Penolakan yang tidak menyebut klien tetap `invalid`** — key yang salah harus
  berhenti dicoba. Menyamar sebagai klien lain sengaja tidak dilakukan.
- **Laporan menyebut sebab sebenarnya** — "klien ditolak gateway (403), key tidak
  diubah", bukan "key invalid".

## 1.9.5 — 2026-11-18
Preset Z.ai berhenti menagih dua kali.

Z.ai punya tiga pintu ke GLM dan tagihannya berbeda: Coding Plan lewat protokol
OpenAI (`api.z.ai/api/coding/paas/v4`), Coding Plan lewat protokol Anthropic
(`api.z.ai/api/anthropic`), dan API bayar-per-token (`api.z.ai/api/paas/v4`).
Sampai 1.9.4 hanya ada satu preset `zai` berlabel "Z.ai (GLM Plan)" yang
menunjuk pintu **ketiga**: key langganan yang ditempel di sana tidak pernah
menyentuh kuota plan, dan tidak ada tanda di UI bahwa itu yang terjadi.

- **Tiga preset, bukan satu** (`lib/keys.js`) — `zai` = Coding Plan OpenAI,
  `zai-anthropic` = Coding Plan Anthropic, `zai-api` = bayar per token dengan
  label yang menyebutnya.
- **Preset menentukan protokolnya** (`lib/keys.js`, `public/app.js`) —
  sebelumnya `addKey` selalu jatuh ke `chat_completions`, sehingga key lewat
  preset Anthropic mengirim body OpenAI ke `/messages` dan ditolak. Sekarang
  preset membawa `format`, dan UI mengikutinya saat dipilih.
- **Probe key membaca isi body, bukan hanya status HTTP** (`lib/keys.js`) —
  Z.ai membalas HTTP 200 dengan `{"code":1000,"success":false}` untuk key yang
  ditolak. Pemeriksaan lama hanya melihat `res.ok`, jadi hasilnya "Key valid ·
  0 model": key yang tidak bisa dipakai dilaporkan sehat. Sekarang kegagalan
  auth jadi `invalid` (dibuang dari pool), kegagalan lain jadi `error` (tetap
  dicoba).

## 1.9.4 — 2026-11-18
Pemeriksaan "folder bisa ditulis" sekarang menulis.

1.9.3 memindahkan unduhan ke folder yang bisa ditulis, dan memeriksanya sebelum
78 MB diambil. Pemeriksaannya memakai `accessSync(W_OK)`, yang di Windows hanya
membaca atribut read-only, bukan ACL yang menolak. Pada folder yang izinnya
dicabut — persis `Program Files` untuk akun pengguna biasa — pemeriksaan
menjawab "bisa ditulis", unduhan dimulai, lalu gagal di byte terakhir dengan
`EPERM`.

- **`canWrite` membuktikan dengan benar-benar menulis** (`lib/install.js`) — satu
  berkas kecil ditulis lalu dihapus. `accessSync` tetap dipakai sebagai saringan
  cepat, tetapi jawaban akhir datang dari percobaan tulis. Berkas percobaan tidak
  tertinggal, dan kegagalan menghapusnya tidak membuat folder dinyatakan
  read-only.
- **Pemilihan folder unduhan jadi lebih disiplin karenanya** — di instalasi
  per-machine, server benar-benar melewati `dist/` di `Program Files` dan memakai
  `dist/` di dalam folder data.

## 1.9.3 — 2026-11-18
Unduhan otomatis sekarang punya tempat menulis.

1.9.2 menyambung rantai cek → unduh → verifikasi → pasang, dan ujinya hijau.
Yang tidak ikut teruji: **dari mana** berkas 78 MB itu ditulis. Folder unduhan
adalah `dist/` di samping `server.js`; di instalasi per-machine folder itu ada
di `C:\Program Files\AgentHub` dan read-only untuk user biasa. Unduhan berjalan
sampai byte terakhir lalu gagal, sementara preflight menyatakan "lolos" karena
ia hanya memeriksa folder data di `%APPDATA%`. Satu-satunya keadaan yang
dilaporkan layak justru keadaan yang tidak bisa menyimpan hasil unduhannya.

- **Folder unduhan dipilih saat boot, bukan diasumsikan** (`server.js`) —
  `pickWritableDir` mencoba `AGENTHUB_DIST`, lalu `dist/` di samping server, lalu
  `dist/` di dalam folder data, dan memakai yang pertama bisa ditulis. Kandidat
  terakhir selalu berhasil karena config sudah ditulis ke folder yang sama saat
  boot.
- **Preflight memeriksa folder unduhan sebagai syarat sendiri**
  (`lib/install.js`) — `distWritable` terpisah dari `dataWritable`. Read-only di
  sini **menghentikan** pemasangan sebelum 78 MB diunduh, dengan pesan yang
  menyebut path persisnya, bukan sesudah user menunggu.
- **Diagnostik menyebut folder yang benar-benar dipakai** — laporan bug tidak
  lagi menunjuk folder yang tidak pernah disentuh.

## 1.9.2 — 2026-11-18
Cek pembaruan menyelesaikan pekerjaannya sendiri: cek → unduh → verifikasi →
pasang.

Sampai 1.9.1 tombol **Cek pembaruan** hanya memberi tahu bahwa ada versi baru.
Unduhannya berjalan sendiri, tetapi installer yang sudah terverifikasi tetap
menunggu satu klik pada **Pasang sekarang** — tombol yang tidak menambah
keputusan apa pun, karena checksum berkasnya sudah dicocokkan. Di shell desktop,
menu tray bahkan hanya membuka halaman rilis di browser, sehingga user
mengunduh 78 MB untuk kedua kalinya dengan tangan. Rilis ini menyambung rantai
itu, dan sekaligus memperbaiki tiga cacat yang muncul di jalan yang sama.

- **Rantai pemasangan otomatis** (`server.js`) — `startDownload` yang berakhir
  `ready` langsung memanggil `installNow()`. `autoInstall: 'unduhan selesai'`
  dipakai bersama `installGate`, jadi aturan penolakan tidak bisa berbeda antara
  tombol dan rantai.
- **Pemasangan ditunda selama ada run aktif** — installer menutup aplikasi, dan
  run yang berjalan akan mati di tengah pekerjaan. `installGate` mengembalikan
  `defer`; penundaan dipicu ulang dari `runs.onIdle`, sehingga semua akhir run
  (selesai, error, dihentikan, pemulihan crash) ikut memicunya. Pemasangan yang
  diminta user secara eksplisit tidak pernah ditunda.
- **Cek berkala tidak memasang sendiri** — `updateTick` menerima `autoInstall`
  hanya dari `?install=1`. Pemeriksaan latar tiap 6 jam tetap mengunduh dan
  memverifikasi, tetapi tidak menutup aplikasi tanpa diminta.
- **Tombol Cek tidak lagi dijawab dari cache** (`public/app.js`) — dulu ia
  memanggil `/api/update` (cache 30 menit), jadi user yang baru memperbaiki proxy
  tetap melihat jawaban lama dan menyimpulkan tombolnya rusak. Sekarang
  `/api/update-check?force=1&install=1`, lalu status dipantau lewat polling
  sampai rantai selesai — SSE bisa putus tepat saat installer menutup server.
- **`autoUpdate` menjadi nilai sungguhan** (`lib/store.js`) — key ini tidak ada
  di `DEFAULT_CONFIG`, dan seluruh kode memakai `config.autoUpdate !== false`.
  Artinya pengguna yang tidak pernah melihat pilihan itu selalu dianggap memilih
  "pasang otomatis", tanpa jalan mematikannya dari UI. Sekarang defaultnya
  tertulis di `config.json` dan sakelarnya ada di pane Desktop
  (`#set-autoupdate`), disimpan segera saat diubah.
- **Shell desktop memakai jalur server** (`desktop/main.js`) — "Cek pembaruan" di
  tray kini meminta server menjalankan rantai; GitHub API dipertahankan hanya
  sebagai jawaban cadangan bila server tidak bisa dihubungi. Label lama "Unduh
  versi baru" menjadi "Buka halaman rilis", karena mengunduh bukan lagi langkah
  yang perlu dilakukan user.
- **Kegagalan spawn installer tidak lagi mematikan server** (`lib/update.js`) —
  `spawn` bisa gagal asinkron (antivirus, berkas hilang di antara pemeriksaan dan
  eksekusi). Tanpa pendengar `error`, Node melempar error tak tertangani dan
  proses mati tepat setelah user menekan "pasang".
- **Kegagalan permanen tidak diulang selamanya** — satu checksum yang tidak
  cocok berarti 78 MB diunduh ulang setiap 6 jam dari proxy yang sama, dengan
  hasil yang sama. Kode kegagalan kini dicatat di `updateDl.code` dan dilewati
  sampai user meminta ulang.
- **`launchInstaller` bisa dilarang oleh kebijakan mesin**
  (`AGENTHUB_NO_LAUNCH_INSTALLER=1`) — unduhan dan verifikasi tetap berjalan,
  peluncuran dilaporkan sebagai ditahan. Tanpa kunci ini, satu-satunya cara
  mematikan pemasangan adalah mematikan `autoUpdate` sepenuhnya.

## 1.9.1 — 2026-11-18
Kegagalan yang menyebut sebabnya, dan penyimpanan config yang tidak lagi kalah
oleh antivirus.

Suite tes sesekali gagal di berkas yang berbeda-beda, selalu dengan pesan yang
sama: `server harus hidup`, setelah menunggu 20 detik. Pesan itu tidak menyebut
sebab apa pun, sehingga kegagalan nyata (bug di server) tidak bisa dibedakan dari
gangguan lingkungan (port dipakai proses lain) — dan satu-satunya cara memastikan
adalah menjalankan ulang seluruh suite. Ketika sebabnya akhirnya dilacak, ada
tiga cacat di balik gejala itu — satu di kode produksi — ditambah satu cacat
produksi lain yang ketahuan di jalan yang sama.

- **Server tidak lagi diam-diam pindah port** (`server.js`) — bila port yang
  dikonfigurasi terpakai, server memundurkan diri ke `port + 1` dan menyimpan port
  barunya. Untuk user itu benar: aplikasi tetap terbuka. Untuk tes itu salah total:
  tes menunggu port yang ia minta, server hidup di port lain, dan 20 detik kemudian
  tes melaporkan "server harus hidup" — padahal server hidup. `AGENTHUB_STRICT_PORT=1`
  mematikan pemunduran itu supaya kegagalannya cepat dan jujur. Kemunduran port
  tetap menjadi perilaku bawaan untuk pemakaian sehari-hari.
- **`AGENTHUB_STRICT_PORT` bukan tambalan tes, melainkan kontrak** — 28 berkas tes
  menjalankan `server.js` sungguhan, jadi flag ini diuji seperti perilaku server
  lainnya: port terpakai harus keluar dengan kode 1 dan menyebut portnya, bukan
  pindah diam-diam (`test/helpers-server.test.js`).
- **Helper boot yang membawa keluaran server** (`test/helpers/server.js`) — 29
  berkas tes memakai `stdio: 'ignore'`, sehingga kegagalan boot tidak meninggalkan
  bukti sama sekali. Helper menyimpan stdout/stderr proses anak, mendeteksi proses
  yang keluar lebih awal, dan menyertakan `Port 9123 sudah dipakai` di pesan
  kegagalan. Waktu tunggu untuk port yang bentrok turun dari 20 detik menjadi
  sekitar 1 detik.
- **`fetch` di loop tunggu diberi timeout** — bila port ternyata dijawab proses
  lain yang menerima sambungan tetapi tidak pernah membalas, `fetch` tanpa timeout
  menggantung selamanya dan seluruh berkas tes ikut menggantung. Kegagalan yang
  menggantung lebih mahal daripada kegagalan yang cepat, karena tidak ada yang
  memberi tahu bahwa ada masalah.
- **Blok port tes tidak lagi bertumpuk** — 16 pasang berkas tes memilih port dari
  rentang yang sama (mis. `mcp-api` 8760–8799 dan `threads-export` 8760–8779).
  Tes berjalan berurutan, tetapi `child.kill()` tidak seketika melepas port, jadi
  berkas berikutnya bisa mendapat port yang masih dipegang proses yang sedang mati.
  Setiap berkas kini punya blok 40 port sendiri (7900–9019), jadi kemungkinan itu
  hilang karena konstruksi, bukan karena retry.
- **`stopTestServer` menunggu `exit`, bukan sekadar mengirim sinyal** — `kill()`
  hanya mengirim sinyal; proses masih memegang portnya beberapa milidetik
  sesudahnya. Menunggu event `exit` menutup celah antara "sudah dimatikan" dan
  "port benar-benar bebas". Ke-28 berkas tes yang menjalankan server kini
  memakainya, dan 16 di antaranya sebelumnya memanggil `child?.kill()` lalu
  langsung `rmSync(dataDir)`: folder dihapus sementara server masih menulis, yang
  di Windows berarti `EPERM` yang ditelan `catch` dan menyisakan folder sampah.
- **Pesan diagnosa tidak boleh menuduh tanpa bukti** — versi pertama helper
  menulis "biasanya port sudah dipakai" untuk SETIAP kematian dini. Pada satu
  kegagalan nyata, log-nya justru berisi banner `AgentHub aktif` dan kode keluar
  `0xC0000409` (`STATUS_STACK_BUFFER_OVERRUN`) — server sempat hidup lalu crash
  di level sistem operasi. Menyebut sebab yang salah lebih berbahaya daripada
  tidak menyebut sebab, karena mengarahkan orang berikutnya memeriksa port yang
  tidak bersalah. Penyebab sekarang disimpulkan dari bukti di log: banner +
  crash dibedakan dari `EADDRINUSE`, kode Windows disebut namanya, dan jalur ini
  dikunci dengan fixture yang sengaja crash setelah boot (`process.abort()`).
  Crash `0xC0000409` itu sendiri **tidak** diklaim sudah diperbaiki: AgentHub
  tidak memakai satu pun dependensi native (`node_modules` kosong), jadi ia
  terjadi di dalam Node/libuv dan muncul sangat jarang. Yang diperbaiki adalah
  cara kegagalan itu dilaporkan, supaya bila muncul lagi laporannya langsung
  menunjuk ke sana.
- **`freerot.test.js` memakai port acak dalam rentang bersama** — `9030 +
  Math.random() * 30` bukan pilihan port, melainkan lotre: ia bisa bertabrakan
  dengan berkas lain yang memakai rentang sama, dan tabrakan itu hanya muncul
  sesekali. Diganti `pickFreePort(9060, 30)`.
- **Invarian blok port diuji, bukan hanya dijanjikan** — `port-helper.test.js`
  kini membaca setiap berkas tes dan gagal bila dua blok bertumpuk, karena
  invarian yang hanya ada di kepala orang akan hilang pada berkas tes
  berikutnya. Diverifikasi dengan sengaja menabrakkan dua berkas: penjaganya
  menyebut pasangan yang bertabrakan secara persis.
- **Penyimpanan config tahan `EPERM` antivirus** (`lib/store.js`) — `writeJson`
  menulis ke `.tmp` lalu me-rename, dan di Windows antivirus serta Windows Search
  membuka berkas yang baru ditulis untuk dipindai. Selama pemindaian itu handle-nya
  memblokir rename dan `renameSync` gagal `EPERM` — sesaat, tetapi cukup untuk
  membuat penyimpanan config gagal. Ini cacat produksi, bukan artefak tes: user
  sungguhan kehilangan setelan karena antivirus kebetulan bekerja pada milidetik
  yang sama. Rename kini dicoba ulang dengan jeda singkat (`Atomics.wait`, bukan
  busy-wait) untuk `EPERM`/`EBUSY`/`EACCES` saja; error permanen seperti `ENOSPC`
  tetap langsung dilaporkan, karena retry tidak boleh membuat tulisan yang gagal
  terlihat berhasil (`test/store.test.js`).
- **Catatan rilis mengikuti tag, bukan versi terakhir yang diedit** — `body_path`
  di `release.yml` dipatok ke `docs/releases/v1.9.0.md`, jadi rilis berikutnya akan
  menerbitkan catatan rilis LAMA tanpa ada langkah yang gagal — kesalahan yang
  tidak terlihat sampai orang membacanya. Berkasnya kini dicari dari nama tag,
  dengan peringatan eksplisit bila tidak ada.

Suite: 635 tes, hijau berulang.

## 1.9.0 — 2026-11-18
Pemasangan yang bisa membuktikan berkasnya benar — atau mengatakan dengan jujur
bahwa ia tidak bisa membuktikannya.

`release.yml` sudah lama menghasilkan `SHA256SUMS.txt` di setiap rilis, dan tidak
ada satu baris kode yang membacanya. Selama itu, updater mengunduh berkas lalu
menyebutnya "siap dipasang" hanya karena unduhannya selesai. Unduhan yang dipotong
proxy, atau halaman login Wi-Fi yang dikembalikan sebagai "installer", tersimpan
sebagai `AgentHub-Setup.exe` dan ditawarkan dengan tombol "Pasang sekarang".
Kegagalannya lalu terlihat seperti rilis yang rusak. Yang diambil dari Claude Setup
(`win32-bootstrapper`, Anthropic) adalah PEMISAHAN empat hal yang di AgentHub masih
dicampur: kelayakan mesin, kesahihan berkas, sumber cadangan, dan cara melaporkan
kegagalan. Yang tidak diambil adalah jalur MSIX/Appx-nya — AgentHub memasang NSIS
lewat electron-builder, jadi yang relevan adalah pemeriksaan sebelum dan sesudah
unduhan, bukan cara memasang paket.

- **Berkas tanpa pembanding TIDAK ditampilkan sebagai terverifikasi**
  (`lib/install.js`) — `verifyFile` mengembalikan tiga keadaan: `ok`, `mismatch`,
  `unverified`. Bila rilis tidak menyertakan `SHA256SUMS.txt`, panel menampilkan
  lencana peringatan "tanpa checksum", bukan centang hijau. Centang untuk berkas
  yang tidak pernah dibandingkan adalah kebohongan yang sama berbahayanya dengan
  menerima berkas rusak — dan lebih buruk, karena ia mengajari user untuk percaya
  pada centang itu.
- **Checksum yang beda DITOLAK, berkasnya tidak dihapus** — `POST
  /api/update/install` menjawab `409 CHECKSUM_MISMATCH`, dan panel menuliskan kedua
  hash (diharapkan versus berkas). Berkasnya sengaja dibiarkan di disk: menghapus
  bukti membuat laporan bug mustahil. Hanya unduhan yang diulang, dan hanya untuk
  gangguan jaringan — mengunduh ulang byte yang sama dari proxy yang sama hanya
  membuang waktu dan kuota.
- **Intersepsi proxy didiagnosis SEBELUM checksum** — `text/html`,
  `application/json`, atau body yang lebih pendek dari `content-length` dilaporkan
  sebagai proxy/portal login lengkap dengan jumlah byte diterima versus diharapkan;
  `.exe` yang tidak diawali `MZ` disebut apa adanya. Urutannya penting: halaman HTML
  tidak akan pernah cocok dengan hash apa pun, dan "checksum tidak cocok" akan
  membuat user mencari rilis yang rusak padahal masalahnya firewall kantor.
- **Preflight berjalan sebelum 100 MB diunduh** — platform, arsitektur, versi Node,
  ruang disk, dan apakah folder data bisa ditulis; masing-masing `ok`/`warn`/`error`.
  Ruang disk yang tidak terbaca adalah `warn`, bukan `error`: menolak pemasangan
  hanya karena `statfs` gagal di satu platform akan menghalangi mesin yang sehat.
  Pemeriksaan yang sama menjadi gerbang `POST /api/update/install`, karena endpoint
  itu bisa dipanggil agent atau `curl` tanpa UI sama sekali.
- **Dua sumber, lalu kegagalannya disebut satu per satu** — cek rilis mencoba
  GitHub API dengan retry (backoff eksponensial + jitter, supaya banyak instance
  tidak menabrak host yang sama pada milidetik yang sama), lalu host unduhan rilis.
  Bila semuanya gagal, panel mendaftar tiap sumber yang dicoba beserta sebabnya,
  bukan satu kata "gagal" yang membiarkan user menebak antara jaringan, firewall,
  dan batas laju GitHub.
- **Diagnostik dan uninstall adalah jawaban, bukan dokumentasi** — `GET
  /api/diagnostics` menghasilkan satu berkas untuk dilampirkan ke laporan bug:
  runtime, keadaan update, hasil verifikasi, temuan preflight, config yang sudah
  disaring, jumlah engine/thread, dan 200 baris log terakhir. Token dan API key
  diganti `[disembunyikan]`, tidak dihilangkan, supaya keberadaannya tetap terlihat
  tanpa bocor. `GET /api/install/uninstall-plan` mengembalikan persis apa yang
  dihapus saat uninstall: entri autostart, folder data, aplikasi. Keduanya tampil di
  panel — rencana yang hanya bisa dibaca di kode bukan rencana.
- **Siklus pemasangan adalah mesin yang dideklarasikan** — `checking → eligible →
  downloading → verifying → ready → installing`, dengan `blocked` dari `verifying`
  dan jalan keluar lagi. `installing` boleh kembali ke `ready` bila proses gagal
  dijalankan, karena state yang tidak bisa ditinggalkan UI adalah jalan buntu.
  Versi kontrak mesin **5**.

## 1.8.0 — 2026-11-17
Perintah yang berjalan lebih lama daripada run-nya sendiri, dengan keluarannya
tersimpan sebagai berkas sehingga bisa dibaca lagi kapan pun.

Sampai 1.7.5 setiap perintah berjalan di dalam satu run: `run_command` menunggu
sampai selesai, lalu membawa seluruh keluarannya ke konteks model. Itu bekerja
untuk `git status`, tetapi gagal untuk hal yang justru paling sering dikerjakan
agent: `npm install` yang mencetak puluhan ribu baris, `npm run dev` yang tidak
pernah selesai, dan seluruh suite tes yang butuh menit. Menahan semuanya di memori
berarti satu perintah bisa menghabiskan memori server yang dipakai semua thread;
membatasinya dengan timeout berarti pekerjaan yang sah dipotong di tengah jalan.
Yang diambil dari ZCode (`docs/background-command.md`,
`contracts/src/tools/background-command.ts`,
`core/src/tools/background-task-manager.ts`) adalah aturannya; yang tidak diambil
adalah kanal chat pihak ketiga yang ada di dokumen yang sama.

- **Tugas latar adalah TUGAS, bukan run** (`lib/background.js`,
  `lib/bg-runner.js`) — run boleh selesai sementara perintahnya masih hidup.
  Mengikat umur tugas ke umur run akan membunuh tepat perintah yang membuat fitur
  ini ada. Karena itu `lib/machines.js` mendapat mesin keempat yang berdiri
  sendiri: `running → done/error/stopped`, tanpa jalur balik.
- **Keluaran ditulis ke berkas, bukan ditahan di memori** — di
  `<cwd>/.agenthub/tasks/<id>.log`. Berkas bertahan saat run selesai, tab ditutup,
  bahkan server dimulai ulang. Yang dibaca kembali adalah EKOR berkas, dan
  `truncated` dilaporkan supaya model tidak mengira ia sudah membaca semuanya.
- **Satu id = satu proses; menjalankan ulang berarti id baru** — id lama tidak
  pernah dihidupkan kembali, sehingga transkrip lama tidak bisa terbaca sebagai
  keluaran perintah baru. `stopped` dan `done` adalah state akhir.
- **Batas yang menjaga mesin, bukan hanya percakapan** — 3 tugas aktif per thread,
  8 total, umur maksimum 1 jam, retensi 24 jam, 20 catatan per thread. Tugas yang
  masih berjalan TIDAK PERNAH dibuang oleh pembersihan: membuang catatan proses
  hidup membuatnya tidak bisa dihentikan lagi.
- **Catatan tugas disimpan, prosesnya tidak bisa dipulihkan** — setelah restart,
  tugas yang tercatat `running` diturunkan menjadi `error` dengan `recovered: true`
  dan berkas keluarannya tetap utuh. Tanpa catatan, yang tersisa hanya berkas
  `.log` tanpa nama perintah, dan agent akan mengulang `npm install` dari nol tanpa
  tahu instalasi sebelumnya sudah separuh jalan.
- **Tiga tool dengan pembagian yang tegas** — `start_background_command`,
  `check_background_command`, `stop_background_command`. Tidak ada tool "tunggu"
  keempat: menunggu adalah parameter `waitMs` pada `start`, karena tool tersendiri
  hanya akan dipakai model untuk berdiam lebih lama daripada yang dibutuhkan.
- **Izin mengikuti apa yang sebenarnya dilakukan** — `start` diperlakukan persis
  seperti `run_command` (`ask` di build/edit, pemeriksaan berbahaya di guarded,
  ditolak di plan); `check` masuk kelompok baca sehingga tetap tersedia di plan;
  `stop` mendapat kategori baru `bgctl` yang SELALU boleh, termasuk di plan, karena
  ia hanya mencabut izin yang sudah diberikan — tanpa itu perintah latar yang
  dimulai sebelum masuk plan tidak bisa dihentikan dari dalam plan.
- **Subagent mewarisi `threadId` induk** — tugas yang dimulai anak dicatat di
  percakapan induk, tempat ia akan dibaca dan dihentikan. Kalau dicatat atas nama
  anak, tugasnya hilang begitu anaknya selesai.
- **Panel perintah latar** (`#bg-panel`, tombol toolbar dengan lencana jumlah yang
  berjalan) — daftar di kiri, keluaran di kanan, tombol hentikan per baris. Dibaca
  dari rute yang sama dengan yang dipakai model, jadi yang dilihat pengguna dan
  yang dilihat agent tidak bisa berbeda. Panel memantau dirinya sendiri selama ada
  tugas berjalan, dan SSE `background` memberi tahu tab lain.
- **Rute HTTP** — `GET /api/background?thread=`, `GET /api/background/:id`
  (`?output=1` untuk isi), `DELETE /api/background/:id`. Batas yang berlaku
  dilaporkan server supaya panel tidak menebak angkanya sendiri.

## 1.7.5 — 2026-11-17
Agent yang berhenti untuk menyusun rencana, meminta persetujuan atas dokumennya,
lalu baru mengubah berkas.

Sampai 1.7.4, mode `plan` hanya bisa dipilih pengguna dari chip akses. Agent tidak
bisa memutuskan "pekerjaan ini sebaiknya direncanakan dulu", dan tidak ada dokumen
yang bisa disetujui — jadi "setuju" berarti tidak ada yang disetujui, dan setelah
persetujuan tidak ada jejak apa yang sudah disepakati. Yang diambil dari ZCode
(`docs/plan-slash-command.md`, `plan-mode-approval-boundary.md`,
`plan-mode-independent-state.md`, `plan-mode-plan-file-compact-continuity.md`,
`contracts/src/tools/plan-mode.ts`, `core/src/permission/plan-mode-policy.ts`)
adalah aturan transisinya; slash command `/plan` tidak diambil karena di sini
rencana dipimpin agent, bukan diketik sebagai perintah.

- **`EnterPlanMode` boleh tanpa bertanya, `ExitPlanMode` selalu bertanya**
  (`lib/plan.js`) — masuk plan hanya MENGURANGI kemampuan (tidak menulis, tidak
  menjalankan perintah), jadi menanyakannya hanya menambah klik yang membuat
  pengguna terbiasa menekan "izinkan". Keluar plan membuka kembali kemampuan
  menulis, jadi ia bertanya bahkan di `yolo`.
- **`ExitPlanMode` di luar plan ditolak `NOT_IN_PLAN_MODE`** — bukan kesalahan
  schema: bentuknya sah, tetapi tidak boleh. `allow` diam-diam akan membuat model
  mengira ia sudah punya persetujuan yang tidak pernah diberikan.
- **Rencana kosong adalah kesalahan schema, bukan rencana hampa** — spasi bukan
  rencana. Menerimanya berarti "setujui apa pun yang saya lakukan berikutnya",
  tepat hal yang kartu ini ada untuk mencegah. Batas `MAX_PLAN_CHARS = 20000`
  sama dengan ZCode: lebih dari itu bukan rencana lagi, melainkan dokumen yang
  tidak dibaca siapa pun sebelum menekan setujui.
- **Mode sebelum plan diingat** — keluar dari plan kembali ke mode yang dipilih
  pengguna, bukan ke bawaan. Agent yang masuk plan dari `yolo` lalu keluar ke
  `build` akan diam-diam memperketat setiap run berikutnya.
- **Rencana ditulis ke berkas SEBELUM mode berubah**
  (`<cwd>/.agenthub/plans/plan-<id>.md`, atomik) — kalau penulisan gagal, run
  tetap di plan mode. Kalau tidak, run boleh menulis berkas sementara rencananya
  — catatan yang disepakati — tidak ada.
- **Rencana diingat setelah ringkasan konteks** — `compact` membuang pesan lama,
  termasuk pesan yang memuat rencana. Tanpa pengingat ini model menyusun ulang
  rencana yang berbeda dari yang sudah disepakati, atau lupa bahwa ia sudah boleh
  menulis.
- **Daftar tool dibangun ulang saat mode berubah** — setelah disetujui, tool
  tulis harus MUNCUL kembali. Model yang hanya melihat tool baca menyimpulkan
  pekerjaannya mustahil dilanjutkan, padahal izinnya sudah ada.
- **Persetujuan rencana memakai `approve`/`reject`, bukan `allow`/`deny`** —
  menyetujui rencana bukan menyetujui satu pemanggilan tool. `reject` menyimpan
  run di plan mode: "tidak" tidak boleh berperilaku seperti "ya" untuk gerbang
  izin. `PLAN_TIMEOUT_MS = 900000` lebih panjang dari izin (3 menit) dan
  pertanyaan (10 menit) karena pengguna harus membaca dokumen.
- **`askPlan` tidak diwariskan ke subagent** — persetujuan rencana menaikkan izin
  tulis untuk sisa run; anak tidak boleh menaikkan plafonnya sendiri lewat kartu
  yang ditujukan untuk induk. Anak yang memanggil `ExitPlanMode` mendapat jalur
  tanpa-klien dan tetap di plan.
- **`allowedPrompts` hanya keterangan, bukan izin** — satu kategori longgar
  ("install dependencies") bisa menutupi perintah apa pun. Izin tetap satu kartu
  per pemanggilan.
- **UI: kartu rencana** — teks rencana dirender sebagai markdown sungguhan
  (judul dan daftar, bukan `##`/`-` mentah) dan digulung di dalam kartu, dengan
  jumlah karakter, daftar "akan membutuhkan", serta tombol **Minta revisi**
  (meminta alasan) dan **Setujui rencana**. Chip akses ikut berubah lewat event
  SSE `mode`; mode akhir run disimpan ke thread.
- **Satu bug nyata yang ditemukan audit UI, bukan tes** — kartu rencana memakai
  `max-height: 100%` dari aturan dasar `.ask-card`, dan persentase terhadap induk
  ber-tinggi `auto` diabaikan: isi rencana tumbuh melewati kartu, tertutup
  `overflow: hidden` di host, dan tombol Setujui tertimbun. Sekarang kartu punya
  batas `46vh` sendiri (44vh di layar ≤560px), sehingga `.ask-body` benar-benar
  menyusut dan menggulung.
- **Bug laten yang ikut diperbaiki: konteks `SessionStart` hilang di putaran
  kedua** — konteks hook dulu ditambahkan langsung ke `messages[0].content`,
  sementara system prompt kini disusun ulang setiap putaran (karena mode bisa
  berubah di tengah run). Instruksi yang diberikan di awal run lenyap tepat saat
  model mulai bekerja. Sekarang konteks itu disimpan sebagai bagian system yang
  ikut disusun ulang.
- Regresi: `plan` (20, murni + gerbang izin), `agent-loop` (+3: rencana disetujui
  di tengah run membuka tool tulis, penolakan tetap menutupnya, konteks
  `SessionStart` bertahan di putaran kedua), `approvals-api`
  (+3: kartu `kind: 'plan'` lewat SSE, alur setuju menyimpan berkas rencana dan
  menulis berkas yang direncanakan di run yang sama, `allow`/`deny` ditolak
  `BAD_DECISION`) — suite penuh 560 tes, semuanya lulus. Audit UI di
  1440/1024/390/320 dua bahasa: kartu di dalam layar, isi menggulung, tidak ada
  teks yang keluar wadah, tombol terjangkau, dan chip akses berubah setelah
  disetujui.

## 1.7.4 — 2026-11-17
Antrean pesan yang tidak pernah membuang ketikan, kiriman yang aman diulang, dan
muatan thread yang tidak lagi menenggelamkan HP.

Sampai 1.7.3, menekan kirim saat run masih berjalan berarti kehilangan teks.
Server menolak dengan `409 RUN_IN_PROGRESS` — benar bagi pemanggil API, tetapi bagi
pengguna itu pesan yang ia ketik lenyap tanpa jejak. Yang diambil dari ZCode
(`docs/web-remote-control-task-command-queue.md`,
`docs/web-remote-control/snapshot-byte-budget.md`) adalah semantiknya; kanal chat
pihak ketiga (Telegram/Feishu/Weixin), token bot, polling, dan kartu pesan tidak
diambil karena aplikasi ini tidak punya bot.

- **Antrean pesan milik server** (`lib/queue.js`, `GET|POST /api/threads/:id/queue`)
  — FIFO ketat, disimpan di `queue.json`, bertahan saat halaman dimuat ulang dan
  terlihat sama dari tab mana pun. Kirim saat run berjalan masuk antrean; pesan
  dijalankan sendiri begitu run sebelumnya selesai. Batas 20 pesan per thread dan
  16.000 karakter per pesan: antrean ini untuk beberapa pesan lanjutan, bukan
  tempat menumpuk pekerjaan semalam.
- **`reserve → mulai → commit`** — item TIDAK hilang saat diambil. Hanya setelah
  run-nya benar-benar dimulai (`runs.begin` berhasil) item dihapus lewat `commit`.
  Bila start gagal (thread hilang, validasi, hook menolak), `release` mengembalikan
  item ke posisinya dengan isi utuh. Menghapus di awal berarti kehilangan pesan
  yang tidak pernah dijalankan. Reservasi kedaluwarsa sendiri
  (`RESERVE_TTL_MS = 20000`), jadi tab yang mati di tengah pengambilan tidak
  membekukan antrean.
- **Penguras yang jalan dari SEMUA akhir run** — `runs.onIdle(fn)` dipanggil dari
  `finish()` setelah state ditulis, bukan dari empat tempat pemanggilan `finish`
  yang berbeda. Dengan begitu antrean tetap terkuras pada jalur `done`, `error`,
  `stopped`, dan pemulihan sesudah crash. Antrean yang tertinggal dari proses
  sebelumnya juga dikuras saat server mulai.
- **Idempotensi kiriman** (`lib/inputs.js`) — klien mengirim `clientCommandId`
  pada setiap `/send`, dan klaim disimpan SEBELUM run dimulai (`inputs.json`,
  TTL 24 jam, 2000 entri). Percobaan ulang menjawab dari catatan
  (`{ duplicate: true, userMessageId, ... }`) alih-alih menjalankan model dua kali.
  Klaim dilepas (`forget`) bila run tidak jadi mulai, supaya kiriman yang sudah
  diperbaiki bisa masuk lagi.
- **Anggaran byte thread untuk perangkat kecil** (`lib/snapshot.js`) —
  `?messageLimit=` dan `?byteBudget=` adalah parameter opsional; tanpa keduanya
  respons tetap penuh, jadi desktop tidak berubah. Pemotongan dimulai dari pesan
  assistant TERBESAR, tidak pernah menyentuh pesan user atau pesan subrun, dan
  menyisakan pratinjau minimal 2.000 karakter. `refId` menunjuk indeks pesan ASLI,
  jadi `GET …/message-body?refId=` tidak pernah salah pesan. Anggaran dijepit
  32 KB–2 MB dengan bawaan 200 KB.
- **UI: baris antrean di dalam composer** — pesan yang menunggu terlihat bersama
  tombol kirim, bukan sebagai toast yang hilang. Tombol kirim tidak pernah mati:
  saat run berjalan ia mengantre. Hapus satu item, kosongkan antrean, dan penanda
  "berjalan" hanya muncul untuk item yang benar-benar dipegang penguras.
- **Tiga bug nyata yang ditemukan audit UI, bukan tes** — (1) `/stop` memanggil
  `runs.finish` walaupun prosesnya masih hidup, sehingga `finish` berjalan dua kali
  dan panggilan kedua mendarat setelah penguras memulai run berikutnya: run yang
  baru berjalan normal tercatat `error`. Sekarang `/stop` hanya menyelesaikan state
  bila tidak ada proses hidup. (2) `renderChat` menggulung `#chat-messages`, yang
  tidak punya overflow (`scrollHeight === clientHeight`), sehingga thread panjang
  terbuka di paling atas dengan composer ±36.000 px di bawah layar; penggulung
  sebenarnya adalah `#chat-scroll`. (3) Tab yang tidak memulai run (dibuka ulang,
  atau run dijalankan dari perangkat lain) tidak tahu ada run aktif, jadi
  kirimannya ditolak `409` alih-alih masuk antrean — sekarang `RUN_IN_PROGRESS`
  dijawab dengan mengantrekan pesan itu.
- Regresi: `queue` (11, murni), `inputs` (10, murni), `snapshot` (11, murni),
  `queue-api` (7, HTTP sungguhan termasuk jalur `stopped`), `send-replay` (5, HTTP)
  — suite penuh 534 tes, semuanya lulus. Audit UI di 1440/1024/390/320 dua bahasa:
  baris antrean di dalam pill, tidak ada teks yang meluber, tombol kirim tetap
  hidup saat run berjalan, hapus/kosongkan sinkron ke server, thread panjang
  terbuka di akhir, dan isi lengkap bisa dimuat ulang dengan hash yang cocok.

## 1.7.3 — 2026-11-17
Grafik commit, pemindah cabang yang menolak membuang pekerjaan, dan patch per file
di drawer Perubahan.

Stage ini menjawab pertanyaan yang tidak dijawab drawer Perubahan: "dari mana kode
ini datang". Yang diambil dari ZCode (`docs/git/git-graph.md`,
`docs/ui/header-git-branch-switcher.md`, `docs/git-review-file-context-menu.md`)
adalah bentuk fiturnya; batasnya dibuat lebih ketat di sini — grafik read-only, dan
tidak ada commit/push/reset dari UI sama sekali.

- **Grafik commit read-only** — `GET /api/threads/:id/git/graph` membaca
  `git log --all --topo-order --date-order` dan mengembalikan commit beserta
  `lane` yang sudah dihitung, `edges`, `rails`, dan lebar pita. Tata letak adalah
  fungsi murni (`layoutGitGraph`) di server, sehingga klien hanya menggambar
  koordinat yang diberikan dan posisinya bisa diuji tanpa repo.
- **Orang tua yang sama memakai satu rel** — setiap merge tidak lagi menambah rel
  permanen. Tanpa aturan ini grafik melebar tanpa isi setelah beberapa merge.
- **Orang tua di luar halaman digambar putus-putus** — bukan dihilangkan; orang
  tua yang hilang membuat commit terlihat seperti akar repo.
- **Paging 50 commit** dengan tombol **Muat commit lain**, dan batas keras 200 dari
  server (klien tidak bisa meminta seluruh riwayat). Lane halaman kedua dihitung
  dari halaman itu sendiri: menyambung lane antar-halaman butuh konteks orang tua
  yang tidak ada di halaman baru, dan garis "penyambung" yang salah lebih buruk
  daripada grafik yang memulai relnya sendiri.
- **Pemindah cabang** di header drawer (`GET …/git/branches`,
  `POST …/git/checkout`). Tidak ada `--force` dan tidak ada stash otomatis: bila
  pemindahan akan menimpa perubahan yang belum disimpan, git menolak dan
  penolakan itu ditampilkan (`409 WORKTREE_DIRTY`, pesan git apa adanya). Pemindah
  cabang yang diam-diam membuang edit pengguna lebih buruk daripada yang berhenti.
  Pindah cabang menyiarkan SSE `workspace` + `threads` agar tab lain tidak
  menampilkan cabang lama.
- **Patch per file** — klik baris file membuka patch file itu saja (dari patch yang
  sudah ada di memori, tanpa permintaan tambahan), dengan `aria-expanded` yang ikut
  berubah. Klik-kanan menawarkan salin path relatif, salin path lengkap, dan
  tampilkan patch. Tidak ada "buka di editor" atau "tampilkan di file manager":
  aplikasi ini tidak punya keduanya, dan menu yang menawarkan hal yang tidak ada
  lebih buruk daripada menu pendek.
- **Bug tata letak yang ditemukan audit, bukan tes** — modal grafik sempat hanya
  setinggi 322px dari 748px yang tersedia (7 baris terlihat, bukan 23). Penyebabnya
  dua lapis: `flex: 1` membuat body menyusut ke basis 0, dan `workspace.css` memuat
  aturan `.pop` sesudah `style.css` yang menimpa `max-height`/`padding`/`overflow`.
  Ketiga popover sekarang memakai selektor id, dan `flex-basis: auto`.
- Regresi: `gitgraph` (12, murni), `gitgraph-repo` (9, git sungguhan),
  `gitgraph-api` (10, HTTP + SSE) — suite penuh 490 tes, semuanya lulus. Audit UI di
  1440/1024/390/320 dua bahasa: lane dan merge tergambar, node sejajar barisnya,
  popover cabang tidak meluber, pindah cabang berhasil saat bersih dan ditolak saat
  kotor (perubahan pengguna utuh), paging 50→67 commit, menu file menyalin path
  yang benar, dan tidak ada emoji.

## 1.7.2 — 2026-11-17
Tab terminal: satu tab satu sesi, dan perintah yang berjalan tidak mati hanya
karena halaman dimuat ulang.

Terminal AgentHub sejak awal adalah satu kotak perintah: jalankan, baca, lalu
kotaknya dipakai lagi untuk perintah berikutnya. Untuk `dir` itu cukup. Untuk kerja
nyata itu berarti setiap perintah baru menghapus keluaran perintah sebelumnya —
tepat ketika dua hal harus dijalankan berdampingan (uji di satu sisi, server di
sisi lain). Yang diambil dari ZCode (`docs/ui/terminal-sessions.md`) adalah
kontrak tab-nya, bukan PTY-nya: terminal ini tetap satu perintah satu proses, dan
program interaktif belum didukung.

- **Tab = sesi terpisah** — tab kedua tidak menimpa keluaran tab pertama, dan
  menutup satu tab tidak menyentuh tab lain. Riwayat perintah di dalam satu tab
  bersifat menumpuk (`MAX_RUNS_PER_TAB = 40`), jadi hasil sebelumnya masih bisa
  dibaca, bukan hanya perintah terakhir.
- **Nomor stabil, memakai nomor terkecil yang bebas** — tab pertama tampil tanpa
  nomor (`nama-folder`), berikutnya `nama-folder 2`, `nama-folder 3`. Nomor yang
  dilepas diberikan ke tab baru, dan tab yang sudah terbuka **tidak pernah**
  dinamai ulang: nama yang berubah-ubah membuat pengguna kehilangan jejak tab mana
  yang sedang ia lihat. `POST /api/terminal/tabs` membuat tab kosong, karena orang
  menyiapkan tab sebelum mengetik.
- **Tab disimpan di server** — `GET /api/terminal?workspace=` mengembalikan daftar
  tab beserta statusnya. Memuat ulang halaman atau berganti workspace menemukan
  perintah yang masih berjalan, bukan terminal kosong. Tanpa ini, tab hanya hidup
  di memori tab browser dan `npm test` yang sedang jalan hilang dari pandangan
  padahal prosesnya masih hidup di server.
- **Tutup panel ≠ tutup tab** — tombol Tutup hanya menyembunyikan panel; sesi dan
  perintahnya tetap berjalan. Hanya tombol tutup di tab yang melepas sesinya
  (`DELETE /api/terminal/tabs/:id`). `DELETE /api/terminal/:id` tetap berarti
  "hentikan proses ini" dan tabnya masih bisa dibaca.
- **Satu perintah sekaligus per tab** — perintah kedua di tab yang masih sibuk
  ditolak `409`, bukan menimpa transkrip perintah yang belum selesai. Batas empat
  proses bersamaan tetap berlaku lintas tab.
- **Exit code asli diteruskan** — perbaikan bug yang ditemukan oleh tes ini:
  `powershell.exe -Command` melaporkan 1 untuk SETIAP kegagalan, jadi perintah yang
  keluar dengan 3 terlihat seperti 1. Pembungkus sekarang berakhir dengan
  `exit $LASTEXITCODE` (mundur ke `$?` untuk cmdlet PowerShell), sehingga keluaran
  CI benar-benar terbaca dari terminal ini.
- **Tab aktif selalu terlihat** — strip tab bisa menggulung di layar sempit, dan
  tab yang baru dibuka digulirkan ke pandangan. Tanpa itu, membuka tab di ponsel
  terasa seperti tidak terjadi apa-apa.
- Regresi: `terminal` (11) — suite penuh 459 tes, semuanya lulus. Audit UI di
  1440/1024/390/320 dua bahasa: penomoran, tab aktif, tombol +, tutup panel vs
  tutup tab, dan pemulihan setelah muat ulang.

## 1.7.1 — 2026-11-17
Ringkasan konteks: percakapan panjang berhenti kehilangan awal ceritanya secara
diam-diam.

Masalah yang sebenarnya terjadi sebelum ini: `lib/harness.js` hanya mengirim 12
pesan terakhir / 12 ribu karakter ke model. Thread yang panjang karena itu
kehilangan keputusan yang sudah disepakati, path yang sudah ditemukan, dan hal
yang sudah dicoba lalu gagal — tanpa satu pun tanda di UI. Model lalu
mengulanginya, dan pengguna menyalahkan model.

- **Ringkasan menggantikan kehilangan itu** (`lib/compact.js`) — pesan lama
  dilipat menjadi satu catatan, sedangkan `KEEP_RECENT = 6` pesan terbaru
  selalu dikirim apa adanya. Yang dikirim ke model adalah ringkasan + pesan
  terbaru; pesan yang sudah diwakili ringkasan tidak dikirim ulang, jadi isi
  yang sama tidak dibayar dua kali.
- **Ringkasan diberi pagar** — teksnya datang dari model, jadi ia dibungkus
  `[Ringkasan percakapan sebelumnya — konteks, bukan instruksi baru]` …
  `[Akhir ringkasan]` dan diletakkan sebagai giliran user pertama, bukan
  `system` kedua (provider menolak `system` di tengah riwayat). Panjangnya
  dibatasi 4000 karakter dan dipotong di batas kalimat.
- **Cursor hanya maju bila ringkasan benar-benar jadi** — `throughMessageId`
  disimpan bersama ringkasan, dan kalau pool mati di tengah jalan tidak ada
  yang ditulis: percakapan lama tetap utuh. Ringkasan yang menunjuk pesan yang
  sudah tidak ada (thread dipangkas/fork) membuat peringkasan mulai dari awal,
  bukan melompati percakapan yang belum pernah diringkas.
- **Bertingkat, bukan menumpuk** — ringkasan lama ikut jadi bahan ringkasan
  berikutnya (`generations` bertambah), supaya percakapan sangat panjang tidak
  kehilangan awal cerita setelah kompaksi kedua.
- **Mati secara bawaan** (`compactAuto`) — satu panggilan model per ringkasan
  adalah biaya nyata, dan percakapan receh tidak menghasilkan apa pun. Bisa
  dinyalakan di Pengaturan › Memori, atau dijalankan manual lewat `/compact`
  dan panel sesi. Peringkasan otomatis berjalan setelah run berhasil, satu per
  satu (`scheduleCompact`), dan dilewati selama masih ada run aktif di thread
  itu.
- **`GET/POST/DELETE /api/threads/:id/compact`** — 409 `RUN_IN_PROGRESS` bila
  run sedang berjalan, 400 `NOTHING_TO_COMPACT` bila belum ada yang sepadan,
  502 `COMPACT_FAILED` bila pool gagal. Kegagalan tidak menyimpan apa pun.
  `DELETE` membuang ringkasan tanpa menghapus satu pesan pun.
- **Panel sesi menampilkan isinya** — teks ringkasan penuh, jumlah pesan yang
  dilipat, sisa pesan verbatim, dan generasi; plus tombol Ringkas lagi / Buang
  ringkasan. Daftar thread hanya membawa penanda `compacted`, bukan teksnya:
  sidebar tidak perlu membayar payload itu di setiap render.
- Regresi: `compact` (11), `compact-api` (10), `history` (7, dua di antaranya
  baru) — suite penuh 448 tes, semuanya lulus.

## 1.7.0 — 2026-11-17
Tujuh tahap hasil membaca ulang ZCode (Apache-2.0) dan menerapkan polanya ke
AgentHub. Yang diambil bukan tampilannya, melainkan kontrak yang membuat agent
aman dipakai: apa yang boleh dilakukan tanpa bertanya, apa yang harus
ditunggu, dan apa yang harus bisa dipulihkan setelah gagal.

- **Agent benar-benar bisa bertindak** — `lib/agent-loop.js` memanggil model,
  menjalankan tool, mengirim hasilnya balik, dan berhenti hanya ketika model
  selesai atau batas putaran tercapai. Delapan tool bawaan (baca, tulis, edit,
  hapus, daftar, cari, perintah, tanya) dengan keputusan izin per mode:
  `plan` hanya membaca, `build` bertanya sebelum menulis, `edit` menulis bebas
  tetapi bertanya untuk perintah, `guarded` hanya bertanya pada perintah
  berbahaya, `yolo` tidak bertanya. Batas waktu perintah, batas ukuran berkas,
  dan pembatalan lewat `AbortController` supaya satu run tidak bisa
  menggantung.
- **Persetujuan menggantikan penolakan** — dulu mode `build` menyembunyikan
  tool tulis karena `ask` mustahil dijawab; satu-satunya efeknya adalah agent
  yang diam-diam tidak bisa meminta izin. Sekarang `ask` benar-benar berhenti
  dan menunggu (`lib/approvals.js`): kartu muncul di atas composer, jawabannya
  `allow`/`deny`/`answered`, dan setiap permintaan pasti berakhir lewat
  jawaban, batas waktu (3 menit izin, 10 menit pertanyaan), pembatalan, atau
  tombol Stop. Aturan "selalu di folder ini" hanya tersedia untuk tool tulis —
  satu perintah yang tampak jinak tidak menjamin perintah berikutnya jinak.
- **`AskUserQuestion`** (`lib/ask-question.js`) — agent bisa menanyakan
  keputusan yang tidak boleh ditebak: 1–4 pertanyaan, 2–4 opsi, pilihan
  tunggal atau ganda, plus kotak jawaban bebas. Validasinya ketat karena kartu
  setengah jadi lebih membingungkan daripada galat yang jelas; pertanyaan yang
  tidak bisa dirender ditolak sebelum kartunya dibuat. Tool ini TIDAK PERNAH
  otomatis diizinkan, termasuk di `yolo`, karena tanpa manusia ia hanya
  menunggu sepuluh menit lalu gagal.
- **Run yang menunggu manusia bertahan dari refresh** — menutup tab atau
  memuat ulang halaman di tengah run tidak lagi membunuh pertanyaannya: server
  hanya membatalkan run yang tidak sedang menunggu jawaban, dan tab baru
  mengambil ulang kartunya lewat `GET /api/threads/:id/approvals`. Tab yang
  mewarisi status `running` dari server kini juga mengadopsi hasil akhirnya
  lewat broadcast `threads`, jadi chip "Working" tidak berputar selamanya di
  tab yang tidak memiliki stream.
- **Checkpoint berkas** — setiap putaran agent menyimpan salinan berkas yang
  akan berubah, sehingga satu langkah bisa dibatalkan tanpa menyentuh staging
  git dan tanpa menebak isi sebelumnya.
- **Hook (9 event)** — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `PermissionRequest`, `SessionStart`, `SessionEnd`, `SubagentStart`,
  `SubagentStop`, `Notification`. Hook proses bisa menolak, mengganti argumen
  (`updatedInput`), atau membuka `ask` menjadi `allow` — tetapi tidak pernah
  menutup `plan`. Hook yang rusak tidak menggagalkan run.
- **MCP** — server MCP eksternal digabung saat dibaca, dengan prefiks nama
  per plugin, dan tool MCP hanya ditawarkan di mode plan bila namanya jelas
  membaca (`read`/`get`/`list`/…). Rahasia tetap tertutup di status.
- **Instruksi tetap** — urutan tetap user → proyek → thread, supaya aturan
  yang lebih spesifik selalu menang dan tidak bergantung urutan berkas di
  disk.
- **Plugin** — satu paket berisi skill, perintah garis miring, hook, dan
  server MCP. Skill & perintah hanya teks (tidak menambah izin); hook dan MCP
  butuh persetujuan eksplisit yang terikat ke digest yang mencakup isi skrip
  yang dirujuk, bukan hanya manifest. Pemasangan menyalin ke
  `DATA_DIR/plugins/<name>` agar mencopot plugin benar-benar menghapus kode
  yang dijalankan. Server MCP milik plugin tidak pernah ditulis ke `mcp.json`
  dan hanya bisa dibaca dari API.
- **Memori yang tumbuh sendiri** — setelah run berhasil, fakta penting
  diekstrak dari pesan baru saja (bukan seluruh riwayat), maksimal 3 fakta per
  run, dan disaring keras terhadap pola instruksi/rahasia karena fakta itu
  disuntikkan ke setiap prompt. Mati secara bawaan (`memoryAutoExtract`).
- **Subagent** — tool `Agent` menjalankan anak dengan konteks bersih, mode
  tidak pernah lebih longgar dari induknya, dan laporannya kembali sebagai
  hand-back. `Explore` sengaja dibatasi oleh daftar tool (baca/daftar/cari),
  bukan janji di prompt. Maksimal 4 anak per run, dan anak tidak bisa
  memiliki anak.
- **Tautan baca-saja** — percakapan bisa dibagikan sebagai halaman publik
  tanpa token, dengan masa berlaku dan pencabutan; token akses tidak pernah
  ikut ke halaman itu.
- **`test/helpers/port.js` memeriksa sambungan, bukan hanya bind** — di
  Windows proses lain bisa mendengarkan `::` saja, sehingga bind IPv4 ke port
  yang sama tetap "berhasil" padahal setiap permintaan dijawab proses lain
  itu. Tes lalu gagal dengan "server harus hidup" seolah kode yang rusak.
- Regresi: `approval`, `approvals-api`, `ask-question`, `agent-loop`,
  `hook-wiring`, `subagents-api`, `checkpoints`, `plugin*`, `memory-extract`,
  `share`, `port-helper` — 424 tes, semuanya lulus.

## 1.6.14 — 2026-11-17
- **Marketplace & kartu toko berikon** — ikon folder untuk tiap marketplace,
  ikon huruf berwarna (hue dari nama) untuk tiap plugin tersedia & kartu
  toko, baris marketplace dirapikan (nama + jumlah plugin + path + hapus);
  return ganda di renderPlugins dibuang.
- **Fix toko plugin**: loadStore kini dijalankan saat pane Plugin dibuka
  (grid kartu sebelumnya kosong), toast pasang menampilkan nama plugin
  (bukan template mentah), dan kartu yang terpotong ditulis ulang utuh.
- **Toko Plugin bawaan (ala halaman Plugins Claude)** — folder store/ berisi
  10 plugin skill kurasi yang BENAR-BENAR BISA DIPASANG (Commit Master,
  Error Hunter, Weekly Report, PPT Outline, Web Research, Meeting Notes,
  SQL Helper, Regex Tamer, Translator ID, API Docs): marketplace bawaan
  terdaftar otomatis saat boot, kartu di pane Plugin dengan pencarian +
  filter, satu klik Pasang → skill aktif otomatis (tanpa izin tambahan —
  semua berkas teks). Install/uninstall nyata lewat pipeline plugin lama.
- **Rotasi juga menyapu model lambat** — di Free Auto, engine yang tidak
  mengeluarkan output sama sekali dalam 30 detik dianggap macet: dibunuh dan
  permintaan pindah otomatis ke model berikutnya (output yang sudah mengalir
  tidak pernah dibunuh). Batas bisa diatur lewat env
  AGENTHUB_FREE_FIRST_TIMEOUT_MS. Chat baru kini bawaan Free Auto saat
  Gateway pool kosong — sekali kirim, sistem carikan model gratis yang
  merespons.
- **Free Auto: rotasi model gratis otomatis** — engine virtual baru di daftar
  engine: memutar SELURUH model gratis opencode-free-* satu per satu; model
  kena limit/429/gagal ditandai cooldown 10 menit (freerot.json) dan
  permintaan pindah OTOMATIS ke model gratis berikutnya, maksimal 3
  percobaan; jawaban terdeteksi "kena limit" walau exit 0 (pola rate
  limit/quota/kuota/dll). Engine asli tercatat jujur di pesan.
- **Fallback publik tanpa key di Gateway** — pool kosong atau semua key
  kena 429: gateway otomatis memakai endpoint publik TANPA API key (Kilo
  Auto Free / Nemotron Lightning, LLM7 DeepSeek-V4-Flash; cooldown publik
  10 menit). Toggle di pane Gateway (config publicFallback, bawaan nyala).
  Header auth dilewati untuk endpoint tanpa key.
- **Katalog**: OVHcloud ditandai expired (endpoint kini menolak akses
  anonim — dicoba langsung). Riset live: Kilo 21 model :free tanpa key,
  LLM7 84 model anonim berbatas.
- **Statistik & glassy dipoles** — bar grafik, heatmap, legend, dan bar
  per-fitur kini ikut aksen biru (sebelumnya hijau hardcoded); view Statistik
  & Skills mendapat padding atas nyaman; kartu statistik, panel, set-card,
  dan seg filter ikut frosted saat Translucent; radius kartu 14px.
- **Tema glassy (frosted)** — saat Translucent aktif: composer mengambang
  overlay di dasar chat sehingga pesan ber scroll di balik kacanya
  (backdrop-blur 26px + saturasi), sidebar/rail/topbar memakai blur 14-22px,
  tepi atas permukaan diberi highlight 1px ala Acrylic; backdrop Mica/Acrylic
  tetap diteruskan ke Electron di Windows 11. Strip konteks pindah ke dalam
  kartu composer sehingga sudutnya membulat utuh (bukan slab lancip).
- **Tampilan depan ala ZCode + panel Translucensi ala Kybern + tray menu** —
  judul hero kini sapaan per jam (Pagi/Siang/Sore/Malam, kerja bagus hari
  ini) dengan 4 quick chips (Ringkasan mingguan, Perbaiki error, Riset web,
  Tugas terjadwal). Pane Tampilan dapat seksi Translucensi: Jendela
  Solid/Translucent, Hanya sidebar, opasitas sidebar/konten/permukaan
  (slider 30-100%), Backdrop Mica/Acrylic khusus desktop Windows 11 (IPC
  setBackgroundMaterial), Reset ke bawaan; kaca lewat variabel CSS. Tray
  ikon diperluas ala ZCode: Task baru, Buka folder kerja, Tentang,
  Ekspor log (diagnostik JSON). Fix: tiga forEach $ tunggal (guard error
  boot menangkapnya). SW cache v16, aset v1.8.4.
- **Bagikan percakapan sebagai tautan baca-saja (REA app ZCode 3.18.2,
  fitur conversationShare)** — tombol bagikan di header chat membuat tautan
  publik /share/<id> (pilih berlaku 7/30 hari via dialog), isi dibaca tanpa
  token dengan halaman gelap yang rapi (markdown, code block, noindex),
  bisa dicabut kapan saja (halaman langsung mati), satu tautan aktif per
  thread (perpanjang, bukan menumpuk). Kelola daftar tautan di Info sesi.
  REA dilakukan dengan membongkar app.asar ZCode (7.653 kunci i18n -> peta
  fitur); adopsi berikutnya yang tercatat: pairing kode kedaluwarsa untuk
  akses HP (pengganti token statis) dan sinkronisasi settings antar perangkat.
- **Model gratis GLM-5.3-Flash benar-benar dipakai (REA kartu Start Plan
  ZCode)** — kuota harian diperbarui sesuai kartu aslinya (300.000.000
  token/hari untuk GLM-5.3-Flash, 1M context, Vision). Tiap baris model di
  Promo Pass kini punya tombol "Pakai" yang mengaktifkan engine OpenCode
  gratis yang TEPAT (opencode-free-glm-5.3-flash-free), bukan pilihan acak;
  chat baru langsung terbuka siap pakai tanpa API key. Preset baru "Z.ai
  (GLM Plan)" di API keys untuk pemilik key plan GLM internasional
  (sumber kuota ZCode: zai-start-plan) — base URL https://api.z.ai/api/paas/v4.
- **Auto-update penuh dari GitHub Releases** — server memeriksa rilis latest
  segera setelah boot lalu tiap 6 jam. Versi baru diumumkan lewat banner
  melayang + toast di semua perangkat (PC/HP/PWA) via SSE scope "update",
  dan aset untuk platform ini (Setup.exe/dmg/AppImage) DIUNDUH OTOMATIS ke
  dist/ dengan progres %. Tombol "Pasang sekarang" menjalankan installer
  senyap (NSIS /S) yang memasang ulang & memulai ulang aplikasi. Unduhan
  atomik (.part → rename), sekali per versi, bisa dimatikan lewat
  Pengaturan (autoUpdate), dan seluruh alur diuji dengan fixture lokal
  (tanpa jaringan nyata).
- **Memori agent jangka panjang** — fakta tetap ("Nama panggilan user: X",
  "Bahasa favorit: Indonesia") disimpan lokal dan DISUNTIKKAN otomatis ke
  setiap prompt di server, semua jalur (UI, API, agent eksternal). Toggle
  per aplikasi di Pengaturan > Memori; blok konteks tercatat di modelContent
  sehingga bisa diaudit. Pesan yang dilihat user tetap bersih.
- **Riset web tanpa API key** — menu Alat > "Riset web" mencari via
  DuckDuckGo (endpoint html, zero-dependency), memasukkan hasil terformat
  (judul + URL + cuplikan) ke composer sebagai konteks agent. Parser offline
  diuji dengan fixture; gagal jaringan menghasilkan pesan jelas, bukan hasil
  kosong palsu.
- **Fork/cabang & edit ulang pesan** — hover pesan user memunculkan dua aksi:
  Edit ulang (fork tanpa pesan itu, teks lama kembali ke composer) dan
  Cabangkan (fork termasuk pesan itu). Thread asli tidak pernah tersentuh.
- **Bacakan (TTS)** — tombol speaker di tiap balasan memakai
  speechSynthesis (id-ID); klik lagi untuk berhenti.
- **Ekspor JSON** — /export sekarang menerima ?format=json (arsip lengkap:
  thread + metadata + pesan), di samping markdown yang lebih kaya (tag,
  folder, sub-run delegated agent).
- **Katalog promo diperluas 29 → 34 entri** dengan data terverifikasi
  (Nov 2026): Scaleway (1 juta token akun baru), Vercel AI Gateway ($5
  kredit/bulan), Synthetic.new (berbayar, privasi), plus peringatan pensiun:
  Chutes.ai (free tier dihapus), iFlow CLI (ditutup 17 Apr 2026). Entri lama
  diperkaya angka resmi (OpenRouter 17 model :free / 50→1.000 req/hari,
  Z AI GLM-4.5-Flash pensiun, LLM7 250 req/jam).
- **CI modern** — actions/checkout@v5 + setup-node@v5 di semua workflow
  (menghapus peringatan deprecation Node 20 pada runner).
- Statistik fitur bertambah: Riset web & Memori agent tampil di panel
  Pemakaian; SSE scope "memory" membuat semua tab ikut segar saat fakta
  berubah. Versi 1.6.14; 212 tes lulus.

## 1.6.13 — 2026-11-16
- Screenshot README diperbarui dari UI terbaru, termasuk statistik dan HP.
  Jalur artefak rilis Windows/macOS/Linux diperbaiki, paket portable menyertakan
  metadata modul Node.js, dan ikon tray PNG tersedia di macOS/Linux.
- Dashboard di localhost masuk otomatis tanpa mengetik token. Sesi otomatis
  dibatasi ke koneksi loopback langsung; akses jaringan/tunnel memakai token QR.
- Panduan Android/iPhone/web kini tersedia langsung di situs dan tab halaman
  unduh: akses QR bertoken, pemasangan PWA, kebutuhan server aktif dan HTTPS.
- Tes pengiriman prompt memakai fixture skill proyek agar tidak bergantung
  pada skill yang terpasang di komputer pengembang atau runner CI.
- **Prompt terpotong di Windows (bug lama, serius)** — `lib/harness.js`
  membungkus CLI lewat `cmd.exe` dengan escape `""`. Itu bukan escape yang sah
  untuk argv, jadi **setiap prompt yang mengandung spasi** sampai ke CLI sebagai
  beberapa token berisi tanda kutip harfiah. Karena prompt chat selalu memuat
  spasi, praktis semua permintaan rusak. Diganti pengutipan aturan MSVC C
  runtime (`winArg()`).
- **`cmd.exe` memotong newline dan command line 8191 karakter** — katalog skill
  saja ~6.700 karakter, jadi blok `<available_local_skills>` dan
  `<reply_language>` diam-diam hilang. Kini resolver (`resolveShim()`) membaca
  shim npm `.cmd`/`.bat` dan men-spawn executable aslinya langsung, tanpa shell.
  Terverifikasi untuk keempat CLI terpasang (claude → `claude.exe`,
  codex/gemini → `node …js`, opencode → `opencode.exe`) dan prompt 20.000
  karakter lewat utuh.
- Jalur `cmd.exe` tetap tersedia sebagai cadangan (harness yang sengaja memakai
  redirection `>`/pipe), dengan pengutipan benar dan newline diratakan.
- **Pengaturan bahasa** (`lib/lang.js`, `public/i18n.js`, `public/i18n-dict.js`)
  — bahasa antarmuka (ID ⇄ EN, 590 kunci kamus) dan bahasa balasan agent
  (7 pilihan, termasuk "ikuti bahasa pesan saya"). Keduanya terpisah: UI bisa
  Indonesia sambil agent menjawab Inggris. Teks user dan balasan agent tidak
  pernah ikut diterjemahkan.
- **Statistik pemakaian** (`lib/stats.js`, `GET /api/stats`) — heatmap 53×7,
  grafik batang 7/30/90 hari, rincian per fitur dan per engine, kartu ringkasan.
  Angka dihitung dari peristiwa nyata (bukan contoh), memakai hari lokal.
- **Halaman unduh dan situs** — tema gelap/oranye dan logo heksagon diselaraskan
  dengan aplikasi; ikon emoji diganti SVG, termasuk favicon situs. Layout
  unduhan menyesuaikan layar kecil dan teks privasi menjelaskan pengiriman
  API key ke provider yang digunakan.
- **Tab OS halaman unduh** — skrip dipindahkan ke `public/download.js` agar
  berjalan dengan CSP `script-src 'self'`; tab mendukung tombol panah,
  Home/End, fokus keyboard, dan relasi tab/panel untuk pembaca layar.
- Tes regresi: `harness.test.js` (pengutipan + resolver) dan
  `lang.test.js`, `stats.test.js`.

## 1.6.7 — 2026-11-16
- **Tab "Daftar Free-Tier" ikut disaring** — tab itu menampilkan salinan mentah
  dari repo pihak ketiga (free-llm-api-resources) yang tertinggal berbulan-bulan,
  sehingga masih menjanjikan **GitHub Models, Cerebras, Mistral La Plateforme,
  Hugging Face, Together AI, dan xAI** sebagai sumber gratis — provider yang
  baru saja dikeluarkan dari katalog karena dokumen resminya menyatakan
  sebaliknya. Dua daftar di aplikasi yang sama saling bertentangan.
- `lib/retired-providers.js` (baru) jadi satu sumber kebenaran: nama provider,
  alasan, dan URL dokumen resmi. Hanya yang sudah diverifikasi yang masuk —
  ragu berarti tidak dimasukkan.
- `getFreeTierProviders()` mengembalikan daftar tersaring **plus** daftar
  `hidden` berisi nama dan alasannya, jadi yang dibuang tetap bisa
  dipertanggungjawabkan alih-alih lenyap diam-diam.
- UI menampilkan satu baris catatan redup berisi provider yang disembunyikan,
  bukan menghapusnya tanpa penjelasan.
- `data/seed-freelist.md` sengaja tidak diedit: file itu hasil generate (kepala
  file melarang edit langsung), penyaringan terjadi saat dibaca.
- README (en/id): GitHub Models dibuang dari daftar preset, dan dijelaskan bahwa
  preset adalah daftar **endpoint**, bukan daftar promo.
- Tes: `retired-providers.test.js` (8 tes, termasuk pencocokan negatif agar
  penyaringan tidak kebablasan) + kontrak `/api/state` bahwa kept + hidden =
  jumlah provider di snapshot.

## 1.6.6 — 2026-11-15
- **Preset mati berhenti ditawarkan** — form "Tambah API key" masih
  menawarkan **GitHub Models**, padahal layanannya pensiun 30 Juli 2026 dan
  endpoint `models.inference.ai.azure.com` tidak lagi menjawab. Membersihkan
  katalog promo saja tidak cukup selama jalur pendaftaran key masih menawarkan
  provider yang sama.
- **Ditolak dengan alasan, bukan gagal diam-diam** — `addKey` menolak preset
  pensiun dengan 400 dan pesan yang menjelaskan sebabnya. Sebelumnya jalur
  `/api/keys` tidak punya penanganan error sehingga kegagalan berubah jadi 500.
- **Key lama tidak hilang** — `presetInfo()` tetap memberi label untuk preset
  pensiun, jadi key berpreset `github` masih tampil di daftar (bisa dihapus atau
  diedit) alih-alih muncul sebagai id mentah atau lenyap tanpa penjelasan.
- Preset aktif tetap lengkap: Cerebras, Mistral, Together, dan xAI dipertahankan
  karena endpoint-nya masih hidup meski free tier-nya sudah berbayar — preset
  adalah daftar endpoint, bukan daftar promo.
- Tes: `presets.test.js` (5 tes) plus kontrak `/api/keys` yang memastikan preset
  pensiun ditolak 400.

## 1.6.5 — 2026-11-15
- **Empat free tier ternyata sudah tiada** — audit ke dokumen resmi menemukan
  katalog masih menjanjikan layanan yang sudah berhenti:
  - **GitHub Models** pensiun total sejak 30 Juli 2026 (playground, katalog,
    inference API, BYOK "no longer available to any customer"). Entri lama
    menyuruh user memakai endpoint yang sudah mati.
  - **Mistral La Plateforme** — "Free mode ... doesn't include API access";
    tier Experiment gratis sudah dihapus dari dokumentasi.
  - **Cerebras** — "doesn't currently offer a no-cost tier that renews
    automatically"; akun baru hanya $5 kredit setelah menambah kartu, berlaku
    30 hari.
  - **Hugging Face Inference** — akun gratis tidak lagi dapat kredit bulanan
    ("Free Users: None"); PRO $2/bulan.
- **NVIDIA NIM dikoreksi** — staf NVIDIA menyatakan sistem kredit sudah tidak
  dipakai dan diganti rate limit, jadi angka "1.000 kredit" usang. Entri
  duplikat "NVIDIA NIM (update)" dihapus.
- Katalog: 29 entri sumber, **23 tampil**, 6 disembunyikan.

## 1.6.4 — 2026-11-15
- **Promo mati dibuang dari katalog** — Together AI dan xAI (Grok) tidak lagi
  menawarkan yang dijanjikan katalog. Dokumen resmi Together menyatakan
  "doesn't currently offer free trials" (akses butuh kredit minimum $15), dan
  program $150/bulan xAI berakhir 2025 dengan halaman resminya kini 404.
  Keduanya ditandai `expired` sehingga berhenti tampil sebagai promo berlaku.
- **Catatan kredit diperjelas** — Baseten (kredit hanya untuk workspace baru,
  tanpa free tier permanen) dan SambaNova ($5 developer tier berlaku 3 bulan
  sejak diberikan) kini menjelaskan batas waktunya sebagai durasi relatif,
  bukan tanggal karangan.
- **Katalog menyaring dua arah** — 30 entri sumber, 28 tampil, 2 disembunyikan:
  lewat `validUntil` (Tencent, 31 Des 2026) dan lewat penanda `expired` untuk
  program yang sudah dihentikan.
- **Tes katalog tidak lagi mengunci "expired 0"** — yang diuji adalah
  konsistensi: jumlah kedaluwarsa cocok dengan katalog sumber dan tidak satu
  pun ikut terkirim ke UI.

## 1.6.3 — 2026-11-15
- **Tanggal berlaku promo yang benar-benar terverifikasi** — Tencent Cloud
  TokenHub diberi `validUntil` 31 Desember 2026 sesuai halaman resmi "New User
  Free Trial Package". Ini membuat penyaringan promo akhirnya menyaring sesuatu,
  bukan sekadar mekanisme yang belum terpakai.
- **Fakta katalog diperbaiki** — Z AI hanya menulis "Limited-time Free" tanpa
  tanggal berakhir, Cohere hanya menyebut key "may have an expiration date",
  dan batas Qwen (90 hari) serta NVIDIA (30 hari) bergantung waktu aktivasi.
  Semuanya dijelaskan di catatan entri, bukan dikarang jadi tanggal tetap.
- **Tes katalog tidak lagi rapuh terhadap waktu** — kehadiran entri riset diuji
  pada katalog sumber, jadi entri yang kampanyenya berakhir (dan memang harus
  hilang dari UI) tidak membuat tes gagal sendiri. Ditambah tes yang memastikan
  setiap `validUntil` adalah tanggal sah dan menyebut sumbernya.

## 1.6.2 — 2026-11-15
- **Format API per key** — form "Tambah API key" kini punya pilihan
  Chat Completions, Anthropic Messages, dan Responses. Format disimpan per
  key; key lama tetap berjalan sebagai Chat Completions. Gateway tetap satu
  endpoint OpenAI-compatible untuk agent, tapi request dirutekan ke
  `/chat/completions`, `/v1/messages`, atau `/v1/responses` sesuai format key,
  lengkap dengan auth header, konversi body (riwayat tool-call, gambar,
  tool_choice, stop), normalisasi respons, dan konversi streaming SSE.
- **Promo hanya yang berlaku** — katalog disaring di server; entri yang sudah
  lewat tidak pernah dikirim ke UI. Entri tanpa tanggal berakhir ditandai
  "tanggal berakhir tidak diumumkan" (tidak dikarang), yang berakhir ≤7 hari
  diberi badge peringatan, dan saat tidak ada promo muncul alternatif nyata:
  model gratis OpenCode, login OpenRouter, atau tambah API key sendiri.
- **Jendela desktop frameless** — minimize, maximize/restore, dan close pindah
  ke dalam header UI; sudut luar jendela transparan dan area drag mengikuti
  header.
- **Skills, terminal proyek, koneksi OpenRouter** — penemuan skill otomatis,
  panel terminal per perintah, dan alur PKCE OpenRouter dengan pertukaran
  kredensial di sisi server.
- Uji lokal baru: `npm run smoke:formats` menguji ketiga format API
  end-to-end dengan upstream tiruan, tanpa API key sungguhan.

## Unreleased — 2026-11-13
- **CI hijau di GitHub Actions** — runner Windows checkout dengan
  `core.autocrlf=true`, jadi `lib/machines.js` dan `public/machines.js` ber-CRLF
  sementara hasil generate ber-LF; langkah `build-machines --check` gagal
  padahal isinya sama. `render()` dan `--check` kini menormalkan CRLF→LF, plus
  `.gitattributes` (`* text=auto eol=lf`) agar checkout konsisten di semua OS.
  Perintah git orkestra membawa identitas eksplisit (`user.name`/`user.email`)
  karena runner CI tidak punya identitas global. Asersi tes `@ mention` tidak
  lagi bergantung pada nama folder checkout.
- **Adopsi model: auto-aktif saat klik** — tombol Pakai di agent kini cek
  key tersimpan SAAT KLIK (bukan hanya saat render kartu), jadi setelah
  menambah key, semua kartu model provider itu langsung berubah jadi
  Pakai langsung tanpa perlu refresh halaman. Dialog adopt juga kini
  mendispatch event change saat set preset, sehingga dropdown custom
  menampilkan provider yang benar (bukan —).
- **Pengembangan berkelanjutan (batch 2)**:
- **Promo Pass 500M** — headline tokens dan kuota harian diperbarui ke 500M
  (sesuai ZCode Global Build terbaru): GLM-5.3 5M/hari, GLM-5.3-Flash 8M/hari.
  Semua referensi 300M hardcoded di UI (sidebar card, tombol claim, tiket)
  diganti nilai dinamis dari `headlineTokens`.
- **Deteksi provider dari model ID** — `presetForModel(modelId, provider)`
  mendeteksi provider dari pola ID model (openrouter, groq, gemini, cerebras,
  mistral, deepseek, github, glm, hf, xai) sehingga model seperti
  `kilo/openrouter/auto` terdeteksi sebagai openrouter (sebelumnya custom →
  Base URL kosong di dialog adopsi). Kartu model lintas provider kini pakai
  deteksi ini sehingga "Pakai langsung" bekerja untuk lebih banyak model.
- **Orchestrator** — tim agent AI bekerja paralel di cabang git sendiri,
  lalu hasilnya ditinjau, digabung, dan diekspor sebagai patch. Mekanisme:
  `lib/orchestra.js` (mirror repo + branch + worktree per agent, commit,
  CI per agent, merge no-ff, ekspor `git diff`). Rute
  `GET/POST /api/orchestra`, `POST /:id/run` (eksekusi paralel via
  `runEngine` dengan cwd = worktree agent), `POST /:id/merge`,
  `GET /:id/patch`. Pane di Settings dengan form + board status per agent.
  Hanya engine CLI (claude/codex/opencode/gemini) — pool tidak bisa mengedit
  berkas. Regresi `test/orchestra.test.js` (repo git sementara + harness
  penulis berkas; 130 tes total).
- **Pengembangan berkelanjutan (batch 2)**:
- **Tema terang (Light / Dark / Sistem)** — kartu tema di pane Tampilan + baris
  "Mode" di menu akun (siklus gelap→terang→sistem). Mekanisme: inversi
  terkendali (invert + hue-rotate 180) di body, media (img/svg/canvas/video)
  dibalik dua kali agar kembali benar; mode Sistem mengikuti
  prefers-color-scheme. Preferensi tersimpan localStorage.
- **Perbaikan bug kritis** —  (querySelector tunggal) dipanggil lalu
  .forEach() di applyTheme/renderThemeCards mengembalikan null → TypeError
  menghentikan seluruh module sebelum renderSettingsNav, sehingga nav
  settings & kartu tema kosong. Diperbaiki menjadi $ (querySelectorAll).
  Verifikasi visual menunggu browser stabil (IAB sedang dipakai pengguna).
- **Dropdown custom (pengganti select native)**: popup putih bawaan browser
  diganti popup bertema UI; select asli tetap di DOM (tersembunyi) sehingga
  .value & event change tetap bekerja.
- **Stabilitas suite**: npm test berjalan dengan --test-concurrency=4.
- **Pengembangan berkelanjutan (batch 2)**:
- **Semua select native diganti dropdown custom bertema** — popup putih bawaan
  browser (form Preset API key, provider adopt, aturan proyek, engine/mode
  jadwal, proyek catatan) tidak mengikuti tema; kini `upgradeSelects()`
  membungkus tiap select dengan tombol + popup bergaya UI. Select asli tetap
  di DOM (tersembunyi) supaya `.value` dan event `change` tetap bekerja —
  diverifikasi: pilih OpenRouter → baseUrl terisi otomatis, mode Harian →
  input jam muncul.
- **Stabilitas suite**: `npm test` berjalan dengan `--test-concurrency=4`
  (sebelumnya = jumlah core) — spawn server paralel yang terlalu banyak
  membuat beberapa tes flaky.
- **Pengembangan berkelanjutan (batch 2)**:
- **Pengembangan berkelanjutan (batch 2)**:
  - **Tombol salin pada blok kode** — setiap \`\`\` blok di pesan chat punya
    tombol salin (delegasi global, bekerja juga saat pesan streaming);
    umpan balik "tersalin" sebentar lalu kembali.
  - **Navigasi bawah di layar HP** — pada ≤560 px rail vertikal berubah jadi
    bar horizontal di bawah (safe-area aware), chat & view mengikuti tingginya;
    sidebar overlay penuh.
  - **Pencarian dalam thread (Ctrl+F)** — bar pencarian di header chat:
    hitungan "n/m pesan", Enter melompat ke kecocokan berikutnya dengan
    sorotan aksen; elemen pesan kini membawa data-mid.
  - Pesan kesalahan yang lebih jelas saat clipboard ditolak browser.
- **Pengembangan berkelanjutan (batch otomatis)**:
- **Pengembangan berkelanjutan (batch otomatis)**:
  - **Keamanan**: rate limiting percobaan token salah per IP — 12 kegagalan
    dalam 60 detik → 429; token sah tidak pernah diblokir dan menghapus
    hitungan. Tes baru di `test/api.test.js`.
  - **Workspace watcher**: folder kerja dipantau `fs.watch` (maks 8 folder)
    saat drawer Perubahan dibuka / thread dibuat; perubahan berkas → SSE scope
    `workspace` → drawer & badge menyegarkan sendiri. Diverifikasi end-to-end
    di `test/workspace.test.js`.
  - **Variabel prompt**: pustaka prompt mendukung `{{nama}}` — saat prompt
    disisipkan, dialog meminta tiap variabel (batal = sisipkan mentah).
  - **Ekspor CSV pemakaian**: `GET /api/usage.csv` + tombol Unduh CSV di
    popover usage (auth lewat parameter token, seperti backup).
  - **Tray desktop: cek pembaruan** — shell Electron memeriksa GitHub
    Releases saat boot (15 detik) & tiap 6 jam; versi baru → notifikasi
    Windows + menu tray "Unduh versi baru"; menu juga ada "Cek pembaruan"
    manual. Pembanding semver sama dengan /api/update-check.
  - **Onboarding 4 langkah** — kartu di hero untuk instalasi baru (tanpa key &
    thread): tambah key → pool → agent pertama → QR HP; tiap langkah memantau
    state nyata dan tercentang otomatis, bisa disembunyikan.
- **Cek pembaruan** — pane Aplikasi desktop kini punya tombol **Cek
  pembaruan**: membandingkan versi berjalan dengan GitHub Releases terbaru
  (`lib/update.js`: pembanding semver murni + prerelease lebih lama dari
  rilis final; pengambilan diinjeksi agar bisa dites tanpa jaringan lewat
  `AGENTHUB_UPDATE_API`). Ada versi baru → nomor, tanggal, potongan catatan
  rilis, dan tombol ke halaman rilis; sudah terbaru → dinyatakan jelas;
  offline/rate limit → pesan jujur (batas GitHub 60 permintaan/jam), dengan
  cache server 30 menit agar tidak menagih API tiap kali pane dibuka.
  Panel memeriksa diam-diam saat pane dibuka (cache).
- **Pulse konektor** — pane Konektor kini menampilkan denyut hidup per
  konektor: titik status (hijau berdenyut = sehat, merah = gagal), latensi
  terakhir, waktu cek, dan **sparkline riwayat health check** (20 entri
  terakhir dari history nyata, tinggi = latensi relatif). Tombol **Kirim
  pulse sekarang** per konektor + **Kirim pulse ke semua** via rute baru
  `POST /api/agents/check-all` (asinkron — HTTP tidak diblok probe; hasil
  mengalir lewat SSE scope agents). Panel hidup ulang saat scope agents
  datang di view settings.
- **Dokumen GitHub bebas emoji** — README (EN/ID), CHANGELOG, BENCHMARK, dan
  STATE-MACHINES kini memakai ikon dari set UI: `ICON_PATHS` diekspor menjadi
  `assets/icons/*.svg` oleh `tools/export-doc-icons.mjs` (`npm run icons`),
  judul README memakai logo aplikasi, tabel benchmark memakai glyph tipografis
  ✓/✕ yang sama dengan UI. Tes baru mengunci aturan ini: semua dokumen
  dipindai emoji, dan setiap ikon yang dirujuk README wajib ada asetnya.
- **Katalog promo diperluas hasil riset internet** (16 → 30 entri): OVHcloud
  (tanpa key, permanen), LLM7.io (anonim), Kilo Code (pool gratis), Z AI GLM
  internasional (Flash permanen gratis), Zhipu BigModel referral (20 juta
  token user baru / 200 juta lewat undangan), Tencent TokenHub (1 juta token
  user baru), SiliconFlow & ModelScope (dengan catatan real-name), Gonka,
  NVIDIA NIM (1.000→5.000 kredit), DeepInfra DeepStart (grant ~50 miliar
  token), SambaNova, Aion Labs, serta entri **kampanye tiket token** dengan
  peringatan kode referral. Tiap entri menyebut sumbernya; kompatibilitas
  OpenAI ditandai agar tahu mana yang bisa langsung jadi preset gateway.
  Regresi `katalog promo` di `test/api.test.js` (116 tes).
- **Pintasan keyboard: Ctrl+8 & overlay Ctrl+/** — ala hint "Toggle sidebar
  Ctrl+8": **Ctrl+8** kini benar-benar men-toggle sidebar, dan **Ctrl+/**
  membuka overlay daftar pintasan (7 baris dengan keycap) yang **bisa
  diklik** untuk menjalankan aksinya — toggle sidebar, palet, chat baru,
  sisipkan @//, tutup overlay. Logika Ctrl+K diekstrak ke `openPalette()`
  supaya satu sumber untuk shortcut & daftar. Pane Pintasan di Pengaturan
  ikut memuat Ctrl+8/Ctrl+/.
- **Mode izin 4 tingkat dengan deskripsi** — ala menu permission Kybern:
  Minta persetujuan / Setujui edit / Plan mode / Full access, tiap baris dengan
  penjelasan. Flag CLI sungguhan dipetakan di harness: Claude Code
  `--permission-mode (default|acceptEdits|plan)`, Codex `--sandbox
  (read-only|workspace-write)`, Gemini CLI `--approval-mode
  (default|auto_edit)`; server kini meneruskan `ask|edits|plan` (sebelumnya
  hanya `plan`). Diverifikasi end-to-end dengan harness uji bernama
  `claude`/`codex` yang meng-echo argumen — flag terlihat di output run
  (`test/run.test.js`).
- **Pemilih model: Favorit & Terakhir dipakai** — bintang per model
  (localStorage, maks 20), bagian Favorit + Terakhir dipakai (maks 5) di atas
  daftar; model `auto` tidak dicatat sebagai recent. Terverifikasi di
  browser: bintang → bagian Favorit muncul, memilih model → masuk Terakhir
  dipakai.
- **Nav settings berkelompok** — header Pribadi / Agent / Sistem ala Kybern;
  pencarian tetap menyaring lintas grup.
- **Menu Alat di composer** — ala menu "Minta Gemini": tombol Alat membuka
  popover berisi **hanya alat yang benar-benar ada**: Lampirkan file/gambar,
  **Jadwalkan prompt ini** (menyuntikkan isi composer ke form Jadwal — nama
  diambil dari baris pertama), **Riset mendalam** (template prompt riset
  bertingkat dengan larangan mengarang), Prompt tersimpan, dan Delegation
  (menutup celah tombol ＋ yang disembunyikan di layar sempit).
  **Dilewati secara jujur**: Buat gambar/video/musik, Canvas, Telusuri Google,
  Koleksi — tidak ada API/fitur yang mendukungnya di AgentHub saat ini.
- **Item "Jadwal prompt" di menu sidebar** — ala "Dijadwalkan" Gemini,
  langsung membuka pane Jadwal.
- **Panel Integrasi** — ala panel Integrations OpenCode: overlay dengan
  pencarian dan tiga bagian. **Terhubung** dihitung dari state nyata (key
  tersimpan dengan badge mask key/jumlah, engine CLI yang terdeteksi di PATH,
  konektor dengan status sehat). **Populer** = preset yang belum punya key —
  klik membawa langsung ke form key dengan preset terpilih & baseUrl terisi.
  **Layanan** = tunnel internet (dengan status) dan bookmark environment.
  Dibuka dari menu sidebar → "Integrasi". Layer `integrations` masuk mesin UI.
- **Menu akun di footer sidebar** — ala menu profil aplikasi agent: avatar +
  nama host + **ID perangkat** (UUID stabil, dibuat sekali di server dan
  tersimpan di config — sama untuk semua browser yang terhubung server ini,
  bisa disalin), pemilih **tema aksen** cepat, **zoom tampilan**
  (90/100/125/150%, tersimpan, via CSS zoom + fallback font-size), dan baris
  yang semuanya melakukan hal nyata: Rekap pemakaian (buka popover usage),
  Upgrade — Start Plan (tampilan promo), Bagikan AgentHub dengan badge
  **Rewards** (share promo pass yang sudah ada), dan Putuskan perangkat lain
  (mengarah ke regenerate token — satu-satunya cara jujur memutus perangkat
  lain pada arsitektur token tunggal). Layer `account` masuk mesin UI.
- **Blok Konteks di Info sesi** — ala panel "Context windows" aplikasi agent:
  judul `input / batas (x%)` dengan progress bar beraksen, baris **Riwayat
  pesan (perkiraan)** & **Prompt terakhir** (share jendela), dan **Cache hit
  rate** dari `prompt_tokens_details.cached_tokens` upstream yang nyata.
  Batas konteks model dicari di snapshot promo dengan pencocokan longgar
  (persis / tanpa `:free` / akhiran id) — model tak dikenal → tanpa batas,
  bukan tebakan; komposisi riwayat = perkiraan chars/4 yang meniru batas
  builder pool (12 pesan / 12 ribu karakter) dan ditandai "perkiraan".
  Logikanya fungsi murni `lib/context.js` + `contextStats()` di
  `GET /api/threads/:id/stats`. Blok hanya tampil bila ada run pool yang
  melaporkan usage — engine CLI tidak menampilkan angka palsu.
- **Jadwal (scheduled runs)** — fitur ala Devin/Claude Cowork: prompt berulang
  dijalankan otomatis oleh server per interval menit atau harian pada jam
  tertentu. `lib/schedules.js` (data + matematika tempo murni), eksekusi di
  server meniru `/send` (satu run per thread, pesan user ber-tanda
  `scheduledBy`, usage upstream dicatat, gagal jujur + dijadwalkan ulang).
  Hasil menumpuk di satu thread per jadwal; tombol **Jalankan sekarang** dan
  buka-thread di Pengaturan → Jadwal. Scope SSE `schedules` baru.
- **Cadangan & pulihkan** — `GET /api/backup` mengekspor seluruh store (key,
  thread, tugas, catatan, proyek, prompt, jadwal, environment, plan) ke satu
  JSON; `POST /api/restore` memulihkannya dengan validasi ketat (penanda app,
  daftar store tertutup, **`config.json` ditolak** agar token/port tidak
  tertimpa diam-diam). UI di Pengaturan → Server dengan dialog konfirmasi.
- **Installer untuk semua platform** — `desktop/package.json` kini punya target
  **macOS** (dmg + zip, ikon `build/icon.png` dari generator PNG tanpa
  dependensi) dan **Linux** (AppImage + deb). `.github/workflows/release.yml`
  direstrukturisasi: tiga runner (windows/macos/ubuntu) membangun target
  native masing-masing lalu satu job `release` memuat semua installer ke satu
  GitHub Release. Catatan jujur di UI & README: dmg belum ditandatangani
  (klik kanan → Open), AppImage perlu `chmod +x`.
- **Instal iPhone (iOS PWA)** — meta apple sudah ada; kini Pengaturan →
  Ponsel menampilkan petunjuk Safari ("Bagikan → Tambahkan ke Layar Utama")
  secara otomatis untuk perangkat iOS (deteksi UA + iPadOS via
  `maxTouchPoints`), menggantikan petunjuk Chrome Android.
- **Aplikasi desktop: unduhan multi-platform** — pane kini punya 4 tombol:
  Windows .exe & portable zip dari server lokal, macOS .dmg dan Linux
  .AppImage dari GitHub Releases `latest/download` (nama file stabil), plus
  catatan CI. Matriks platform lengkap (Windows/macOS/Linux/Android/iOS/web)
  ada di README & README.id. Regresi CI di `test/desktop.test.js` (111 tes total — lihat catatan DX/AX di atas).
- **Checklist "Semua yang termasuk"** — ala daftar fitur plan Claude: 10
  baris ✓ ber-ikon (engine CLI, gateway pool, delegation, lampiran, tasks/notes/
  proyek, akses HP & tunnel, PWA, pustaka prompt/dikte/palet, review diff, tanpa
  pelatihan model dari konten) di panel Benefit plan Start Plan. Daftar dikirim
  oleh `publicPass()` (`benefits.included`), bukan hardcode di UI.
- **Settings: kategori Penagihan, Privasi, dan Aplikasi desktop** — nav kini 14
  kategori mengikuti referensi aplikasi agent. Penagihan menampilkan plan
  aktif/status/kuota/tingkat upgrade/reset dari promo pass nyata + tombol
  kelola; Privasi merangkum fakta keamanan sungguhan (penyimpanan lokal, token
  akses, key di-mask, cache offline hanya kerangka, tanpa telemetri, tunnel
  bawaan mati); Aplikasi desktop menyediakan unduhan installer & portable plus
  fakta tray. Cache service worker dinaikkan ke `agenthub-shell-v3`.
- **Info sesi (statistik thread)** — tombol ⓘ di header chat (dan slash
  `/stats`) membuka popover dua kolom ala panel Context: Sesi, Engine, Model,
  jumlah pesan (total/user/asisten), Total/Input/Output/Reasoning/Cache token,
  waktu dibuat & aktivitas terakhir. Sumbernya endpoint baru
  `GET /api/threads/:id/stats` yang menghitung dari pesan nyata; engine yang
  tidak melaporkan token menampilkan "—" bukan 0 palsu. Gateway pool kini
  menyimpan `usage` penuh upstream (`prompt_tokens`,
  `completion_tokens`, detail reasoning & cache) di pesan asisten, jadi angka
  pecahan muncul otomatis saat dipakai. Layer `session` masuk mesin UI dan
  cache service worker dinaikkan ke `agenthub-shell-v2`.
- **Settings shell dengan navigasi kategori** — ala halaman settings aplikasi
  agent populer: kolom kiri berisi "Kembali ke studio", pencarian, dan 11
  kategori ber-ikon (Penyedia, Models, Konektor, Proyek, Preferensi, Tampilan,
  Notifikasi, Pintasan, Ponsel, Server, Tentang); kolom kanan menampilkan satu
  pane aktif (tersimpan di localStorage). Semua kategori berisi data nyata:
  rekap key/pool/agent/proyek dari state, panel QR + PWA + tunnel pindah ke
  kategori **Ponsel**, token & info server ke **Server**. Fitur baru sungguhan:
  **pemilih warna aksen** (5 swatch, tersimpan di localStorage via
  `--accent`), **Tes notifikasi** toast, daftar **Pintasan** nyata, dan pane
  **Tentang** (versi aplikasi + kontrak mesin + lisensi). Toggle notifikasi
  kini langsung tersimpan saat diubah. Kontrak UI `test/desktop.test.js`
  mengunci ID shell dan ke-11 pane.
- **Menu effort: opsi Default** — pilihan kini Default / Low / Medium / High
  (urutan naik, ✓ pada pilihan aktif, menu minimal tanpa header) mengikuti
  referensi aplikasi agent. `Default` berarti mengikuti aturan engine — flag
  `model_reasoning_effort` tidak dikirim, sama seperti sebelum ada pilihan
  effort. Tersimpan di `localStorage`, chip menampilkan label terpilih.
- **Panel Benefit plan** — Start Plan kini punya daftar benefit ala kartu plan:
  benefit inti (repo menengah–besar, akses awal model flagship, resource jam
  sibuk) plus grup **Benefit eksklusif ZCode** (tugas idle-time 5/hari, reset
  kuota 5 jam saat idle, benefit MCP, kuota%). Angka dinamis — persentase kuota
  dihitung dari boost nyata (`quotaBoostPct`, 100/150/…%), lengkap dengan label
  "diskon pengali" saat >100% — dan dikirim oleh `publicPass()`, bukan
  hardcode di UI. Kelas `pp-mark` logo tiket tidak dipakai ulang (bentrok
  membuat teks aksen jadi blok); kelas baru `pp-benefit-mark`. Regresi di
  `test/promoPass.test.js` (kini 106 tes total — lihat catatan DX/AX di atas).
- **PWA Android** — manifest web app (standalone, ikon 192/512 hasil generator
  PNG tanpa dependensi), service worker di root (`/sw.js`) yang menyimpan
  kerangka UI saja — `/api/`, `/v1/`, dan `/download` tidak pernah di-cache —,
  tombol **Instal** di Pengaturan → Telepon yang menangkap
  `beforeinstallprompt`, dan registrasi SW di `index.html`. Diverifikasi di
  viewport Android 390×844: tanpa scroll horizontal, composer tidak terpotong
  tepi (chip effort & delegasi disembunyikan di layar sempit, label engine
  di-ellipsis), dan ikon composer dirender sebagai SVG outline.
- **Akses data seluler (tunnel opsional)** — `lib/tunnel.js` menjalankan quick
  tunnel cloudflared dengan status jujur (`stopped|starting|online|error`),
  rute `/api/tunnel`, panel di Pengaturan → Telepon, URL tunnel + QR di popover
  HP, peringatan tegas bahwa **link + token = kendali penuh**, dan mati otomatis
  saat proses keluar.
- **Pustaka prompt** — `lib/prompts.js` + CRUD `/api/prompts` (maks 200, body
  8 ribu karakter, pin di atas), popover **Prompt tersimpan** di composer,
  simpan dari isi composer dengan judul, klik untuk mengisi composer, dan slash
  command `/prompt` (buka) + `/save` (simpan). Layer `prompts` masuk mesin UI.
- **Dikte suara** — tombol mikrofon di composer memakai Web Speech API
  (`id-ID`, hasil interim ditampilkan langsung), tersembunyi otomatis bila
  browser tidak mendukung, indikator berdenyut saat merekam.
- **Palet perintah & navigasi** — `Ctrl+K` membuka palet perintah terpusat,
  pencarian global di sidebar, autocomplete `@` untuk file, pin/rename/export
  markdown pada thread, rekap pemakaian token, adopsi model satu-tap
  (`/api/models/activate` memakai key tersimpan + engine pindah ke Gateway),
  menu engine/effort/izin/git yang menempel pada chip pemicunya, dan QR akses HP
  yang dirapikan (frame, seksi WiFi, seksi tunnel).
- **UI/UX mobile & ikon** — seluruh ikon memakai set SVG internal (tes anti-emoji
  30 karakter terlarang), `.mini-btn svg` kini `fill:none; stroke:currentColor`
  sehingga ikon lampiran/prompt/suara tidak lagi tampil sebagai blok hitam, dan
  media query ≤560 px menjaga composer tetap muat di HP.
- **DX/AX** — `test/prompts.test.js` (3 tes), 2 tes aset PWA di
  `test/api.test.js` (manifest terbuka tanpa token, SW di root, ikon PNG
  tersedia, API tak di-cache, HTML menautkan manifest + SW), dan ID
  `btn-pwa-install`/`pwa-hint` masuk kontrak UI `test/desktop.test.js`; total
  **106 tes** lulus lewat `npm run check`. README & README.id diperbarui:
  bagian PWA/tunnel, tabel API baru, dan catatan keamanan tunnel.
- **Promo Pass / Start Plan** — kartu promo di sidebar (logo AgentHub, 300 juta
  token, kuota GLM-5.3-Flash, tombol Claim, tombol tutup) membuka tiket klaim
  bergaya ZCode: tiket, masa berlaku, catatan ketersediaan model, serta tombol
  **Got it** dan **Share**. Setelah klaim, promo berpindah ke **Start Plan**:
  status kampanye, tanggal kedaluwarsa, upgrade kuota +50% per tingkat (maks 4),
  kartu saldo harian per model dengan reset 22:59, daftar model dengan toggle,
  badge **Vision**, tambah model, dan ubah nama tampilan.
- **Jadwal & kuota nyata** — `lib/promoPass.js` memiliki jadwal drop 22:00, tiket
  10 jam, plan 3 hari sampai 22:59, hari penagihan 22:59 (bukan tengah malam),
  dan pemakaian dari `usage.total_tokens` gateway saat model upstream cocok
  dengan GLM-5.3 / GLM-5.3-Flash. Aksi divalidasi: model tak dikenal `400
  MODEL_UNKNOWN`, tambah model di luar katalog `400 MODEL_NOT_ADDABLE`, upgrade
  berlebih `409 QUOTA_MAX`; klaim idempoten.
- **API promo pass** — `GET /api/promo/pass` dan `POST /api/promo/pass/{claim,
  dismiss,toggle,add-model,rename,upgrade,share}`, `promoPass` di `/api/state`,
  kontrak mesin v4 (`PROMO_PASS_MACHINE`), layer UI `promoClaim`, dan scope SSE
  `promoPass`.
- **Lampiran file/gambar** — tombol lampiran, drag-drop, dan paste di composer;
  chip lampiran bisa dihapus; gambar tampil sebagai thumbnail. Batas 8 MB per file
  dan 5 per pesan, nama selalu basename, penyimpanan di data dir (bukan repo).
  Engine CLI menerima path absolut; gateway menerima teks inline. `POST /send`
  memvalidasi id sebelum menulis pesan, dan pesan berisi lampiran saja tetap
  mendapat judul thread dari nama file.
- **UI** — tampilan Promo sekarang dua panel (**Promo Pass** / **Free models**),
  pilihan panel diingat di `localStorage`; kartu promo yang ditutup bisa
  dikembalikan dari Start Plan. Semua aksi memakai delegasi event sehingga render
  ulang tidak memasang handler ganda.
- **Folder kerja bebas** — baris **This PC** di pemilih workspace kini punya aksi
  ganti folder. Path divalidasi lewat `GET /api/workspace/check` (absolut, ada,
  berupa folder) sebelum disimpan, lalu chip folder dan branch langsung
  diperbarui. Tanpa aksi ini `setCwd()` tidak pernah terpakai dan folder bebas
  hanya bisa diwarisi dari localStorage.
- **Dialog in-app** — seluruh `confirm()`/`prompt()` native diganti satu overlay
  aksesibel (`role="dialog"`, Esc/Enter, focus trap, antrean untuk aksi yang
  berlomba). Dialog native diblokir di Electron/webview dan tidak bisa dijawab
  agent lewat CDP; sekarang dialog aktif terlihat di `window.__ahState().dialog`.
  Guard catatan belum tersimpan ikut memakai dialog ini, dan tes statis menolak
  pemakaian dialog native baru.
- **DX/AX** — `test/promoPass.test.js` (16 tes), `test/uploads.test.js` (8 tes),
  regresi dialog di `test/desktop.test.js`, dan tes `/api/workspace/check` di
  `test/workspace.test.js`; total **101 tes** lulus lewat `npm run check`. Band
  port tes dibuat unik per file agar `search` tidak lagi bertabrakan dengan
  `promoPass`/`uploads`. Dokumentasi diperbarui di `README.md`, `README.id.md`,
  dan `STATE-MACHINES.md` (mesin promo pass, kontrak lampiran, peta tes).
  (Total berjalan kini **130 tes** — lihat catatan DX/AX di atas.)

## 1.6.1 — 2026-11-12
- **Workspace per thread** — folder kerja kini milik thread (`thread.cwd`), bukan
  localStorage. Server memvalidasi sebelum thread dibuat / run mulai
  (`WORKSPACE_INVALID`), menyimpannya di setiap kiriman, dan thread lama mewarisi
  folder aktif sekali saat dibuka.
- **Drawer Perubahan** — status git, `+/-`, dan patch dari run terakhir, plus
  tombol kembalikan per file. Revert hanya menerima path yang muncul di
  `git status`, tidak pernah menyentuh index, dan tidak menghapus file baru tanpa
  `deleteUntracked: true`. Folder bukan repo menjawab `409 NOT_A_REPO`.
- **Aturan proyek (memory)** — baca/tulis `AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, dan `.github/copilot-instructions.md` langsung dari drawer,
  dengan batas 64 KB dan daftar nama file tertutup.
- **Pencarian global** — kotak cari sidebar dan perintah **Cari semua…** memakai
  `GET /api/search` untuk mencari judul & isi pesan thread, judul tugas,
  judul/isi catatan, dan nama/folder proyek sekaligus. Hasil terkelompok dengan
  cuplikan konteks, case-insensitive, aman untuk karakter seperti `[` (bukan
  RegExp), dan menahan kueri satu huruf agar tidak membanjiri UI.
- **Percakapan pool bersambung** — `POST /send` mengirim riwayat thread
  (user/assistant, maksimal 12 pesan / 12 ribu karakter) ke gateway, jadi
  pertanyaan lanjutan tidak lagi dijawab tanpa konteks. Subrun delegation,
  pesan yang masih streaming, dan run error tidak ikut dikirim; pesan tertua
  dipotong lebih dulu agar thread panjang tetap muat di context window.
- **Siklus run punya satu pemilik** — `lib/runs.js` mencatat `runState` (mengikuti
  `RUN_MACHINE`), menolak kiriman kedua di thread yang sama dengan
  `409 RUN_IN_PROGRESS` sebelum ada pesan ditulis, dan membuat stop idempoten.
  `thread.running` tetap ada untuk klien lama, tetapi diturunkan dari `runState`.
- **Tidak ada lagi "Working" palsu** — saat server mulai, run yang tertinggal
  `running` tanpa proses ditandai `error` ("Terputus karena server berhenti saat
  run berjalan") dan dilaporkan sebagai `recoveredRuns` di `/api/status`; thread
  langsung bisa dipakai lagi.
- **Mesin baru untuk yang dulu implisit** — `step` (pesan assistant / subrun
  delegation), `delegation` (idle → starting → running → selesai, dengan tombol
  Hentikan), `noteEditor` (draft `dirty` tidak hilang oleh Esc), aturan pool key
  eksplisit (`KEY_POOL_CANDIDATE` / `KEY_POOL_ACTIVE` / `KEY_MODEL_VISIBLE`), dan
  single-flight untuk probe key/agent serta refresh promo.
- **Kontrak mesin v3** — `GET /api/version` dan `/api/machines` melaporkan
  `machines: 3`, mesin baru, aturan pool, dan grup `workspace`
  (`changeStatuses`, `ruleFiles`); setiap penolakan membawa `code`, `machine`,
  `from`, `to`, dan `allowed`.
- **AX** — `window.__ahState()` mengembalikan state runtime (view, layer, run,
  connection, promo, delegation, noteEditor, drawer perubahan, workspace, thread)
  sehingga agent tidak perlu menebak dari DOM.
- **Dokumentasi** — [`STATE-MACHINES.md`](STATE-MACHINES.md): inventaris semua
  mesin, siapa penulisnya, di mana ditegakkan, state yang sengaja dibiarkan lokal,
  kontrak workspace, dan checklist DX untuk menambah state.
- **DX** — 74 tes (`npm run check`), termasuk regresi kiriman bersamaan, stop
  idempoten, pemulihan run yatim, revert git sungguhan di folder sementara,
  workspace yang berupa subfolder repo (path root-relative), pencarian lintas
  sumber, dan batas riwayat percakapan.

## 1.6.0 — 2026-11-11
- **UI disetel ulang mengikuti benchmark Kybern** — jendela melayang di atas wallpaper
  gelap, rail ikon 58px dengan tile proyek berwarna, sidebar 236px, hero
  "Let's work in" + judul proyek, composer dua lapis, chat maksimal 720px dengan
  bubble user `#202023` dan metadata di bawah teks asisten, baris "Worked for Xs",
  papan tugas tanpa garis kolom, serta overlay yang lebih tenang. Semua ID dan
  perilaku lama dipertahankan; suite regresi CDP tetap lulus.
- **Notes** — tampilan catatan baru (pin, cari, filter proyek, grid pinned 2 kolom /
  recent auto-fill) dengan penyimpanan lokal di `data/notes.json` dan API
  `GET/POST /api/notes`, `POST/DELETE /api/notes/:id`.
- **Promo → agent dalam satu klik** — tombol **Pakai di agent** pada setiap model
  gratis membuka alur adopsi: tempel key promo, key otomatis masuk pool gateway
  dengan `poolModel` model tersebut, lalu agent bisa langsung memakai
  `OPENAI_BASE_URL=<host>/v1` + `OPENAI_MODEL=auto`. Pengaturan `autoPool`
  (default aktif) membuat setiap key baru langsung siap dipakai agent.
- **Gateway** — contoh `curl` dan blok env agent (`OPENAI_BASE_URL`,
  `OPENAI_API_KEY`, `OPENAI_MODEL`) plus tombol salin; hasil tes rotasi menampilkan
  provider/model yang melayani.
- **Perbaikan** — glyph caret diganti chevron CSS agar tidak lagi tampil sebagai
  titik, warna proyek memakai palet tenang (This PC = aksen oranye), pluralisasi
  "1 delegated agent", dan pemulihan encoding file UI.
- **DX** — 23 tes (`npm run check`), termasuk kontrak Notes dan perilaku
  `autoPool` saat key dibuat.

## 1.5.0 — 2026-11-11
- **Satu sumber kebenaran untuk semua state** — `lib/machines.js` mendefinisikan 8 mesin
  (tugas, run, koneksi, key, agent, promo, overlay, view) + peta scope SSE.
  `public/machines.js` dihasilkan dari file itu (`npm run machines`), jadi server,
  UI, dan agent tidak bisa lagi punya aturan yang berbeda.
- **Kontrak mesin untuk agent** — `GET /api/machines` (aturan + label + scope SSE),
  `GET /api/status` (apa yang sedang berjalan), `GET /api/version`; event SSE juga
  tersedia sebagai NDJSON (`/api/events?format=json`) untuk klien non-browser.
- **Siklus tugas linear yang ditegakkan server** — inbox → todo → running → review → done.
  Lompatan kolom ditolak `409 ILLEGAL_TRANSITION` beserta `allowed`, bukan diam-diam
  diabaikan. Tombol di papan tugas kini diturunkan dari mesin yang sama, jadi UI tidak
  pernah menawarkan perpindahan yang akan ditolak. Setiap kolom punya stempel waktu
  (`statusAt`), termasuk backfill untuk tugas lama.
- **Run bisa dihentikan** — tombol ⏹ di header chat, `POST /api/threads/:id/stop`,
  `AbortController` di klien, dan pembunuhan proses (termasuk pohon proses di Windows).
  Menutup tab juga menghentikan proses, bukan meninggalkan run 10 menit.
  Status run eksplisit: idle / running / done / error / stopped.
- **Banner koneksi** — status connecting / live / degraded / offline / unauthorized
  dengan tombol "Coba lagi". Sebelumnya server mati hanya terlihat sebagai
  "Gagal: Failed to fetch" sekali lalu UI tampak normal padahal data basi.
- **SSE hemat** — event digabung dalam jendela 120 ms dan hanya slice yang berubah
  yang di-render (`threads`, `tasks`, `keys`, …), bukan `loadState()` penuh per event.
  Reconnect memakai backoff dan menyegarkan state setelah putus.
- **Satu overlay aktif** — popover usage/env/QR dan modal delegation dikelola satu
  pemilik state; Esc menutup, klik pada pemicu tidak lagi membuka-lalu-menutup.
- **URL adalah state** — `?view=` dan `?thread=` dipertahankan lewat
  `history.replaceState`, jadi refresh/bookmark/share tidak selalu mendarat di Studio.
- **UX kecil yang sering menggigit** — draft "tambah tugas" bertahan saat render ulang,
  pilihan engine delegation tidak hilang, toast kembar di-debounce, status
  `checking`/`triggering` punya spinner, dan badge run tidak lagi hilang saat stream.
- **DX** — `npm test` (21 tes: mesin, kontrak HTTP, run/stop sungguhan), `npm run check`
  (drift generator + tes), dan CI menjalankan keduanya. Notifikasi Windows bisa
  dimatikan dengan `AGENTHUB_NO_TOAST=1` untuk uji otomatis.

## 1.4.1 — 2026-11-11
- **Paritas UI dengan referensi Kybern** (dicek langsung terhadap tangkapan layar Kybern):
  - Rail ikon garis monokrom, bukan emoji; status aktif berbentuk rounded-square
  - Composer dua lapis ala Kybern: kartu konteks (folder kerja + branch) di belakang kartu utama
  - Sidebar: baris "This PC" satu baris dengan titik status, tombol filter di header Personal, ikon pensil muncul saat hover pada baris proyek
  - Tasks: top bar proyek + tombol Display, 5 kolom muat tanpa scroll horizontal dengan garis pemisah penuh, ikon kolom bergaya garis, tombol ＋ selalu tampak, filter proyek & Global berfungsi (status aktif tidak lagi dobel)
  - Popover Pemakaian engine: nama rata kiri, jumlah rata kanan, bar netral, plus pintasan ke Gateway
  - Popover Environment memakai ikon garis
- Deep link: `?view=tasks` dan `?thread=<id>` langsung membuka tampilan/thread
- Perbaikan: deep link hanya berlaku saat muat pertama, jadi pindah tab tidak lagi terlempar balik ke tampilan awal 1,2 detik setelah membuka Notifikasi.
- Perbaikan: error `Cannot read properties of null (reading 'classList')` saat Studio dimuat (`#hero-continue` belum punya id)
- Perbaikan: id ganda pada composer (shell vs textarea) yang membuat fokus kotak input tidak bekerja

## 1.4.0 — 2026-11-11
- **UI sama persis dengan referensi Kybern**:
  - Sidebar: wordmark `agenthub ⌄`, baris `This PC • server jalan`, Chat baru / Resume sesi, label PERSONAL + daftar proyek, RECENTS dengan ikon engine
  - Hero `Let's work in / agenthub` dengan composer pill dua baris: chip This PC + main, placeholder `Ask anything, @ to mention, $ skills, or / commands`, baris + / Full access / pemilih model / tombol kirim
  - Chat: pemisah tanggal `Today · ...`, kartu delegation `N delegated agents · M working`, baris pohon dan status `Xs Working`, baris `Worked for Xs`
  - Tasks: sidebar filter (All/Inbox/To do/Running/Needs review/Done) + projects, header kolom ikon + jumlah + ＋, kartu ID chip dengan aksi buka-thread/done
  - Popover Environments dan Pemakaian engine dari rail
  - Perbaikan: `#view-studio` tanpa `.active` tidak lagi flex (bocor ke view lain)

## 1.3.1 — 2026-11-11
- Restyle UI ke bahasa visual Kybern: latar gelap, rail ikon, sidebar thread, hero composer, tipografi lebih rapat

## 1.3.0 — 2026-11-11
- **Studio** — gaya antarmuka kontrol-plane ala studio agent: rail ikon, sidebar thread, composer besar, UI bahasa Indonesia
- **Chat multi-engine dengan streaming** — ngobrol langsung dengan:
  - *Free tokens (Gateway Pool)* — LLM gratis via rotasi provider
  - *Claude Code / Codex / OpenCode / Gemini CLI* — harness CLI yang terdeteksi otomatis, prompt dikirim aman via stdin, keluaran streaming realtime
- **Delegation** — satu prompt dijalankan paralel ke beberapa agent sekaligus; hasil dikumpulkan di satu thread, task otomatis dibuat di papan Tugas
- **Papan Tugas (kanban)** — Inbox / To do / Running / Needs review / Done
- **Statistik pemakaian engine** per harness di tab Gateway
- Konfigurasi harness dapat dioverride via `data/harnesses.json`
- Perbaikan: spawn CLI Windows dibungkus `cmd.exe` dengan quoting aman (shim npm .cmd)

## 1.2.0 — 2026-11-11
- **Native desktop app** — AgentHub now runs as its own Windows application (Electron shell): own window, taskbar icon, tray icon; no browser needed
- Server starts automatically as an internal child process; closing the window keeps monitoring alive in the tray
- Tray menu: open dashboard, "run at PC startup" toggle, quit
- Single-instance lock; if a server is already running on the port, the shell attaches instead of spawning a second one
- Links to external sites (model pages, provider sites) open in the default browser
- Desktop installer built automatically by CI on version tags; classic portable ZIP remains available as a lighter alternative

## 1.1.1 — 2026-11-11
- App icon for installer, shortcuts & uninstaller (custom generated .ico)
- Fixed launcher VBS "Unterminated string constant" crash (robust quoting via `Chr(34)`)
- Static assets served with `no-cache` headers + versioned URLs so UI updates always appear

## 1.1.0 — 2026-11-10
- **Gateway Pool**: one OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/models`) that rotates free providers; automatic failover on 429 (5-min cooldown), invalid keys auto-disabled, streaming passthrough
- New promo source: models.dev (~400 free models across providers) alongside OpenRouter & the GitHub free-tier list
- Downloadable Windows installer (NSIS, bundles Node.js runtime) + portable ZIP + `/download` landing page
- Launcher VBS for windowed launch without console; optional autostart during install
- Data directory auto-moves to `%APPDATA%\AgentHub` when installed under Program Files

## 1.0.0 — 2026-11-10
- Free-model & promo tracking from OpenRouter, GitHub free-tier list and a curated catalog, with diff alerts + Windows toast notifications
- API key vault with periodic validation for 11 OpenAI-compatible presets
- Agent connectors (webhook/HTTP and LLM endpoints) with scheduled health checks and history
- Mobile access over LAN via QR code (token-protected) with realtime SSE updates
- Indonesian-first dark UI, responsive from desktop to phone; zero npm dependencies
