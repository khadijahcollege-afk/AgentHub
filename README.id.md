# 🛰️ AgentHub

**Control plane desktop ringan untuk token AI gratis.**

[![Release](https://img.shields.io/github/v/release/khadijahcollege-afk/AgentHub?include_prereleases&label=release&color=blue)](https://github.com/khadijahcollege-afk/AgentHub/releases/latest)
[![CI](https://github.com/khadijahcollege-afk/AgentHub/actions/workflows/ci.yml/badge.svg)](https://github.com/khadijahcollege-afk/AgentHub/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blueviolet)

> 📖 English version: [README.md](README.md)

AgentHub memantau **promo model & API AI gratis** dari berbagai sumber internet, menyambung ke **aplikasi agent** Anda, dan menjaga mereka tetap hidup: saat kuota satu provider gratis habis, traffic **otomatis pindah** ke provider berikutnya — semuanya bisa dipantau dari HP.

| Studio (chat) | Papan tugas | Catatan | Pelacak promo |
|---|---|---|---|
| ![](assets/readme/studio.png) | ![](assets/readme/tasks.png) | ![](assets/readme/notes.png) | ![](assets/readme/promo.png) |

## Fitur

- **💬 Studio** — ngobrol langsung dengan agent di aplikasi desktop native: pilih engine, ketik prompt, lihat streaming. Engine: **Free tokens (Gateway Pool)** + harness CLI terpasang (**Claude Code, Codex, OpenCode, Gemini CLI** — terdeteksi otomatis).
- **🎯 Delegation** — satu prompt dijalankan paralel ke beberapa agent; hasil terkumpul di satu thread dan task otomatis muncul di papan tugas.
- **📋 Papan tugas** — Inbox / To do / Running / Needs review / Done.
- **🎁 Pelacak promo** — live dari [OpenRouter](https://openrouter.ai), [models.dev](https://models.dev), dan daftar [free-llm-api-resources](https://github.com/raullenchai/free-llm-api-resources) + katalog kurasi dengan link pendaftaran. Ada model gratis baru → notifikasi + toast Windows.
- **🔀 Gateway Pool** — satu endpoint OpenAI-compatible (`/v1/chat/completions`, `/v1/models`). Kena `429` → cooldown 5 menit → traffic pindah otomatis ke provider berikutnya. Key ditolak (401) → otomatis dimatikan dari rotasi. Mendukung streaming (`stream: true`).
- **🔑 Brankas API key** — simpan key 11+ preset (Groq, OpenRouter, Cerebras, Gemini, GitHub Models, Mistral, Together, DeepSeek, xAI, GLM, Hugging Face, custom). Re-validasi berkala, key di-mask di UI.
- **🤖 Konektor agent** — webhook n8n/Make/custom dan endpoint LLM; health check terjadwal dengan riwayat latensi.
- **📱 Akses dari HP** — pindai QR, buka dashboard yang sama via WiFi. Realtime via SSE, dilindungi token akses.
- **🔒 Lokal dulu** — semua berjalan di komputer Anda. Tanpa cloud, tanpa telemetri. API key tidak keluar dari disk.
- **🪶 Server ringan** — Node.js murni, **nol dependency npm**; shell desktop-nya Electron tipis (jendela native + tray, tanpa browser).

## Install

**Windows 10/11 (64-bit)** — ambil terbaru dari [Releases](https://github.com/khadijahcollege-afk/AgentHub/releases/latest):

| Berkas | Keterangan |
|---|---|
| [`AgentHub-Setup.exe`](https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download/AgentHub-Setup.exe) | **Aplikasi desktop** (~82 MB) — jendela native dengan tray, minimize-to-tray, toggle autostart, runtime tergabung. Cara utama memakai AgentHub. |
| [`AgentHub-Portable.zip`](https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download/AgentHub-Portable.zip) | Portable (klasik) — extract lalu jalankan `Start AgentHub.bat`; terbuka sebagai jendela app browser, tanpa shell desktop |

Saat pertama dijalankan Windows Firewall mungkin menanya izin Node.js — pilih **Allow** agar HP di WiFi yang sama bisa terhubung.

**Dari sumber** (OS apa pun dengan Node.js 18+ — UI responsif, jalan di browser mana pun):

```bash
git clone https://github.com/khadijahcollege-afk/AgentHub.git
cd AgentHub
node server.js
```

## Mulai cepat

1. **Tambah key gratis** — tab API Keys → pilih preset → tempel key (ambil gratis dari katalog: Groq, OpenRouter, Cerebras, …).
2. **Masuk pool** — tekan **"+ Pool"** pada tiap key valid.
3. **Arahkan agent ke gateway:**

```
Base URL : http://<ip-komputer>:7788/v1
API Key  : <token akses AgentHub — tampil di tab Gateway>
Model    : auto   |   groq/llama-3.3-70b-versatile   |   <nama model>
```

Kuota habis → provider itu di-cooldown 5 menit dan request dilayani provider berikutnya. Agent Anda tidak perlu tahu bedanya.

4. **Pindai QR** dari HP (satu WiFi) untuk memantau dari jauh.

## Mesin state & API untuk agent

Semua status di AgentHub (tugas, run, koneksi, probe key/agent, refresh promo, overlay,
view) dideklarasikan sekali di [`lib/machines.js`](lib/machines.js). `public/machines.js`
dihasilkan dari file itu, jadi server yang menegakkan transisi dan UI yang menggambar
tombol tidak bisa berbeda aturan:

```bash
npm run machines   # regenerasi public/machines.js
npm run check      # gagal bila file hasil generate drift, lalu jalankan tes
npm test           # 21 tes: mesin, kontrak HTTP, run + stop sungguhan
```

Agent yang mengemudikan aplikasi tidak perlu menebak; kontraknya disajikan lewat HTTP:

| Endpoint | Isinya |
| --- | --- |
| `GET /api/machines` | semua state, transisi, label, dan scope SSE |
| `GET /api/status` | apa yang sedang berjalan + jumlah tugas per kolom |
| `GET /api/version` | versi kontrak mesin + daftar status tugas |
| `GET /api/events?format=json` | stream SSE sebagai newline-delimited JSON |

Perpindahan tugas linear ketat: `inbox → todo → running → review → done`. Lompatan
kolom ditolak `409` dengan body berisi `allowed`, jadi klien bisa mengoreksi diri
alih-alih diam-diam menyimpang.

## Privacy & keamanan

- Server berjalan di `0.0.0.0:7788` agar HP bisa akses; semua `/api/*` wajib token akses (tampil di Pengaturan, bisa di-regenerate).
- API key tersimpan di `data/keys.json` (mode sumber) atau `%APPDATA%\AgentHub` (terinstall) — lokal saja.
- Akses dari luar rumah: pakai VPN seperti Tailscale — jangan port-forward langsung.

## Catatan shell desktop

Shell Electron (`desktop/main.js`) menyalakan server sebagai proses anak, memastikan satu instance saja, dan tetap berjalan di tray saat jendela ditutup — memantau tidak berhenti. "Jalankan saat PC menyala" bisa diaktifkan dari menu tray.

## Lisensi

[MIT](LICENSE)
