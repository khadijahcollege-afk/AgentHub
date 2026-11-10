# Changelog

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
