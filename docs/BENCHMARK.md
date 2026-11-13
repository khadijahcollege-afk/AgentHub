# Benchmark AgentHub

Dua bagian yang sengaja dipisah supaya jujur:

1. **Angka terukur** — hasil pengukuran nyata AgentHub di mesin ini (Windows 11,
   Node.js 24), dengan perintah agar bisa diulang siapa pun.
2. **Matriks fitur** — perbandingan fitur dengan aplikasi agent populer.
   Kolom AgentHub didukung tes otomatis; kolom kompetitor disarikan dari
   **pengetahuan publik per Nov 2026** (dokumentasi resmi), bukan hasil
   pengukuran — jadi baca sebagai peta fitur, bukan skor kinerja.

## 1. Angka terukur (AgentHub, Windows 11 x64, Node 24)

| Metrik | Hasil | Cara mengukur ulang |
|---|---|---|
| Cold start server (healthz siap) | **~131–140 ms** | spawn `node server.js` → fetch `/healthz` sampai 200 |
| Memori idle (WorkingSet) | **~99 MB** | `Get-Process -Id <pid>).WorkingSet64` setelah 2 s idle |
| Throughput kecil | **200/200 req `/healthz` dalam 68 ms** (≈ 3.000 req/s, localhost) | loop fetch 200× |
| SSE: buka + event pertama | **1 ms** | fetch `/api/events` → chunk pertama |
| UI: DOMContentLoaded | **114 ms** (548 KB transfer, 20 resource, localhost) | `performance.getEntriesByType('navigation')` |
| Installer Windows (Electron bundling) | 78 MB | artefak build |
| Portable ZIP (tanpa shell desktop) | 33 MB | artefak build |
| Dependensi npm (server) | **0** | `package.json` |
| Tes otomatis | **130 lulus** (`npm run check`) | `node --test test/*.test.js` |
| Kode | ~3.800 baris `lib/` (server) + ~6.900 baris UI (vanilla JS/CSS/HTML) | `wc -l` |

Cara baca: angka ini menyatakan **biaya berjalan** (mulai, memori, latensi),
bukan kualitas model. Kualitas jawaban agent ditentukan model upstream yang
Anda pilih (Gateway hanya meneruskan) atau CLI engine yang dipanggil.

## 2. Matriks fitur

Legenda: ✓ ada · parsial parsial/dengan catatan · ✕ tidak ada. Kolom kompetitor =
saris publik Nov 2026; kolom AgentHub = terverifikasi tes/UI di repo ini.

| Fitur | AgentHub | ChatGPT | Claude Desktop/Code | OpenCode | Kybern | ZCode | Gemini |
|---|---|---|---|---|---|---|---|
| Chat streaming + markdown | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Multi-engine (Claude Code/Codex/OpenCode/Gemini CLI) | ✓ | ✕ | parsial (sendiri) | parsial (sendiri) | parsial | parsial (sendiri) | ✕ |
| Gateway pool multi-provider + failover 429 | ✓ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| Pemantau promo API gratis | ✓ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| Adopsi model satu-tap (key tersimpan) | ✓ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| Lampiran gambar/file (vision pass) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dikte suara (id-ID) | ✓ | ✓ | parsial | ✕ | parsial | ✕ | ✓ |
| Pustaka prompt (simpan/pin/pakai ulang) | ✓ | parsial (memory) | ✓ (skills) | parsial | parsial | ✓ (skills) | ✓ |
| Jadwal prompt otomatis | ✓ | parsial (tasks) | ✓ | ✕ | ✓ | ✓ (cron) | ✓ |
| Papan tugas kanban | ✓ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| Notes per proyek | ✓ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| Proyek + konteks git (branch/changes) | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✕ |
| Review diff + revert per file | ✓ | ✕ | parsial | ✓ | parsial | parsial | ✕ |
| Mode izin berjenjang (ask/edits/plan/full) | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Pemilih model: favorit + terakhir | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Palet perintah (Ctrl+K) | ✓ | parsial | ✕ | ✓ | ✓ | ✓ | ✕ |
| @ mention berkas | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Slash command | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✕ |
| Akses HP: QR + LAN | ✓ | ✕ | ✕ | ✕ | ✓ | ✕ | ✕ |
| Tunnel internet (data seluler) | ✓ | ✕ | ✕ | ✕ | ✓ | ✕ | ✕ |
| PWA Android/iOS terpasang | ✓ | ✓ | ✕ | ✕ | ✕ | ✕ | ✓ |
| Installer Win/mac/Linux | ✓ (CI) | ✓ | ✓ | ✓ | parsial | ✓ | ✓ |
| Lokal-first, tanpa telemetri | ✓ | ✕ | parsial | ✓ | ✓ | parsial | ✕ |
| Server tanpa dependensi npm | ✓ | ✕ | ✕ | ✓ | ✕ | ✕ | ✕ |
| Cadangan/pulihkan satu berkas | ✓ | ✓ (cloud) | ✕ | ✕ | ✕ | ✕ | ✓ (cloud) |
| Panel integrasi | ✓ | ✓ | ✓ | ✓ | parsial | ✓ | ✓ |
| Identitas perangkat (ID + salin) | ✓ | ✓ | ✓ | parsial | ✓ | ✓ | ✓ |
| Overlay pintasan yang bisa diklik | ✓ | parsial | ✓ | ✓ | ✓ | ✓ | parsial |
| Statistik sesi + konteks + cache hit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | parsial |
| Orchestrator (tim agent paralel di cabang git) | ✓ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| Thread tags/koleksi | ✓ | ✅ | ❌ | ❌ | ⚠️ | ⚠️ | ✅ |
| Pulse konektor (sparkline + check-all) | ✓ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| Tema terang/gelap/sistem | ✓ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| MCP | ✕ (CLI native) | ✓ | ✓ | ✓ | parsial | ✓ | parsial |
| Buat gambar/video/musik | ✕ | ✓ | parsial | ✕ | ✕ | ✕ | ✓ |
| Web search bawaan | ✕ | ✓ | ✓ | ✕ | parsial | ✓ | ✓ |

## Cara membaca

- **Keunggulan nyata AgentHub** ada di lapisan yang kompetitor tidak fokuskan:
  menggabungkan sumber token gratis jadi satu gateway, menjalankan banyak
  engine CLI dari satu UI, dan membuat semuanya bisa dipantau dari HP —
  dengan nol dependensi dan lokal penuh.
- **Keunggulan kompetitor** ada di kemampuan model generatif (gambar/video/
  musik Gemini & ChatGPT), ekosistem MCP, dan pencarian web — AgentHub tidak
  menggandakannya karena engine CLI sudah membawa fitur itu sendiri.
- Kybern dinilai dari screenshot yang tersedia; fitur di luar itu tidak
  diklaim salah — hanya belum diketahui.

## Batasan

- Angka kinerja kompetitor (latensi model, harga) tidak diukur di sini —
  mereka layanan cloud yang berganti versi; membandingkannya tanpa
  lingkungan yang sama hanya menghasilkan klaim.
- Matriks fitur bisa usang; jika Anda menemukan sel yang keliru, ubah barisnya
  dan sebutkan sumbernya di PR.
