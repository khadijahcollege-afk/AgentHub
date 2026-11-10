# Changelog

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
