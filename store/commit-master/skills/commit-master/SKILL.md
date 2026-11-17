---
name: Commit Master
description: Menulis pesan commit konvensional dari diff — bahasa Indonesia, format Conventional Commits.
when_to_use: pengguna butuh commit master atau menyebut commit master
---

Tulis pesan commit git dari diff atau deskripsi perubahan yang diberikan pengguna.

Aturan:
- Format Conventional Commits: type(scope): subjek singkat.
- Type yang sah: feat, fix, docs, refactor, test, chore, perf, ci, style.
- Subjek maksimal 72 karakter, bahasa Indonesia, tanpa titik di akhir.
- Bila diberi diff, bacalah dulu: sebutkan alasan perubahan, bukan apa yang tampak.
- Sertakan body bullet bila perubahan menyentuh lebih dari satu area.
- Keluarkan HANYA pesan commit siap tempel, tanpa penjelasan tambahan.
