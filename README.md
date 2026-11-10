# 🛰️ AgentHub

**The lightweight desktop control plane for free AI tokens.**

[![Release](https://img.shields.io/github/v/release/khadijahcollege-afk/AgentHub?include_prereleases&label=release&color=blue)](https://github.com/khadijahcollege-afk/AgentHub/releases/latest)
[![CI](https://github.com/khadijahcollege-afk/AgentHub/actions/workflows/ci.yml/badge.svg)](https://github.com/khadijahcollege-afk/AgentHub/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blueviolet)

AgentHub watches **free AI model promos** from multiple internet sources, connects to your **agent apps**, and keeps them alive: when one free provider's quota runs out, traffic **fails over automatically** to the next one — all monitored from your phone.

> 🇮🇩 Dokumentasi berbahasa Indonesia: [README.id.md](README.id.md)

| Studio (chat) | Tasks board | Free promo tracking |
|---|---|---|
| ![](assets/readme/studio.png) | ![](assets/readme/tasks.png) | ![](assets/readme/promo.png) |

## Why AgentHub?

Free AI API tiers (Groq, Google AI Studio, Cerebras, OpenRouter `:free`, …) are great — until your agent hits the rate limit at the worst moment. AgentHub solves this with a **Gateway Pool**: your agents point at *one* endpoint, and AgentHub rotates through all your free keys.

- **💬 Studio** — chat directly with your agents in a native desktop app: pick an engine, type a prompt, watch it stream. Engines include the **free-token Gateway Pool** and installed **CLI harnesses** (Claude Code, Codex, OpenCode, Gemini CLI — auto-detected).
- **🎯 Delegation** — send one prompt to several agents in parallel; results are collected into a single thread and a task appears on the board.
- **📋 Tasks board** — Inbox / To do / Running / Needs review / Done.
- **🎁 Promo tracking** — live from [OpenRouter](https://openrouter.ai), [models.dev](https://models.dev) and the [free-llm-api-resources](https://github.com/raullenchai/free-llm-api-resources) list, plus a curated catalog with signup links. New free model detected → notification + Windows toast.
- **🔀 Gateway Pool** — one OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/models`). `429` → 5-minute cooldown → traffic shifts to the next provider. Rejected keys (401) get disabled automatically. Supports streaming (`stream: true`).
- **🔑 API key vault** — store keys for 11+ OpenAI-compatible presets (Groq, OpenRouter, Cerebras, Gemini, GitHub Models, Mistral, Together, DeepSeek, xAI, GLM, Hugging Face, custom). Periodic re-validation, keys masked in the UI.
- **🤖 Agent connectors** — n8n/Make/custom webhooks and LLM endpoints; scheduled health checks with latency history.
- **📱 Phone access** — scan a QR, open the same dashboard over Wi-Fi. Realtime via SSE, protected by an access token.
- **🔒 Local-first** — everything runs on your machine. No cloud, no telemetry. API keys stay on disk.
- **🪶 Featherweight server** — pure Node.js, **zero npm dependencies** for the server itself; the desktop shell is a thin Electron wrapper (native window + tray, no browser).

## Install

**Windows 10/11 (64-bit)** — grab the latest from [Releases](https://github.com/khadijahcollege-afk/AgentHub/releases/latest):

| Asset | What |
|---|---|
| [`AgentHub-Setup.exe`](https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download/AgentHub-Setup.exe) | **Desktop app** (~82 MB) — native window with tray icon, minimize-to-tray, autostart toggle, bundled runtime. The recommended way to run AgentHub. |
| [`AgentHub-Portable.zip`](https://github.com/khadijahcollege-afk/AgentHub/releases/latest/download/AgentHub-Portable.zip) | Portable (classic) — extract and run `Start AgentHub.bat`; opens in an app window of your browser, no desktop shell |

On the first launch Windows Firewall may ask permission for Node.js — allow it so phones on the same Wi-Fi can connect.

**From source** (any OS with Node.js 18+ — UI is fully responsive, so it works in any browser):

```bash
git clone https://github.com/khadijahcollege-afk/AgentHub.git
cd AgentHub
node server.js
```

## Quick start

1. **Add free keys** — API Keys tab → pick a preset → paste key (grab free ones from the catalog: Groq, OpenRouter, Cerebras, …).
2. **Join the pool** — press **"+ Pool"** on each valid key.
3. **Point your agents at the gateway:**

```
Base URL : http://<your-pc-ip>:7788/v1
API Key  : <AgentHub access token — shown in the Gateway tab>
Model    : auto   |   groq/llama-3.3-70b-versatile   |   <model name>
```

Quota hit → AgentHub cools that provider down for 5 minutes and your request is served by the next one. Your agent never knows the difference.

4. **Scan the QR** from your phone (same Wi-Fi) to monitor everything remotely.

## Building from source

The installer is built with [NSIS](https://nsis.sourceforge.io):

```bash
# stage the app + a node.exe copy, then:
makensis /DXVER=1.2.3 /DSTAGE="<stage-dir>" packaging/agenthub.nsis
```

CI does this for you: pushing a tag `v*` runs [.github/workflows/release.yml](.github/workflows/release.yml), builds the installer & portable ZIP on a Windows runner, and publishes them to GitHub Releases.

## Privacy & security

- Runs on `0.0.0.0:7788` so phones can connect; every `/api/*` route requires an access token (shown in Settings, regenerable).
- API keys live in `data/keys.json` (source mode) or `%APPDATA%\AgentHub` (installed) — local only, never sent anywhere except the provider you chose.
- For access from outside your home, use a VPN such as Tailscale — do not port-forward directly.

## Desktop shell notes

The Electron shell (`desktop/main.js`) starts the server as a child process, remembers a single instance, and keeps running minimized to the tray — closing the window does not stop monitoring. "Run at PC startup" can be toggled from the tray menu.

## License

[MIT](LICENSE) — free to use, modify and ship.
