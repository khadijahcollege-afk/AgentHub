# Changelog

## Unreleased — 2026-11-13
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
