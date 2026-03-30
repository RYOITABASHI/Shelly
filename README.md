<h1 align="center">Shelly</h1>

<p align="center">
  A chat-first terminal IDE for Android.<br>
  Chat and Terminal, side by side. Connected by AI.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-blue">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android-blue">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Claude%20Code-orange">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#the-copy-paste-problem">Why Shelly?</a> ·
  <a href="#features">Features</a> ·
  <a href="#the-story">Story</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#known-limitations">Limitations</a> ·
  <a href="#security">Security</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## I can't write code.

I'm not an engineer. I've never written a line of TypeScript. I don't fully understand how Git works internally. I have no formal training in computer science.

But I built this — a 100,000-line terminal IDE — by talking to AI.

Every architectural decision in Shelly is mine. The code is not. It was created through conversation with [Claude Code](https://claude.ai/), running inside [Termux](https://termux.dev/) on a Samsung Galaxy Z Fold6. I direct. The AI builds. No desktop. No laptop. Just a foldable phone and an AI that can execute commands.

The keyboard you see in the screenshots? I built that too. It's called [Nacre](https://github.com/RYOITABASHI/Nacre) — an 11,000-line Android IME written in Kotlin, also created entirely through AI conversation. I'm typing on it right now, inside Shelly, improving both apps simultaneously.

This is not a portfolio project. This is a tool I use every day to build things. And I'm releasing it as open source — not because the code is perfect, but because I believe this represents a new way of making software.

If you find rough edges in the code, that's expected. **Improvements are not just welcome — they're the reason this is open source.**

---

## Quick Start

Download the latest APK from [**GitHub Releases**](https://github.com/RYOITABASHI/Shelly/releases), or build from source:

```bash
git clone https://github.com/RYOITABASHI/Shelly.git && cd Shelly
pnpm install && pnpm android
```

> **Requirements:** Android device + [Termux (F-Droid)](https://f-droid.org/en/packages/com.termux/). For building from source: Node.js 22+, pnpm, Android NDK r27+. Expo Go is not supported — Shelly uses native Kotlin/C modules.

On first launch, the Setup Wizard handles everything: Termux installation, storage permissions, package setup, and Android process-kill protection. You'll see the chat screen in under 5 minutes. Type "hello" and the AI responds.

---

## The Copy-Paste Problem

You're running Claude Code in the terminal. It throws an error. You copy it. You switch to ChatGPT. You paste. You ask "what went wrong?" You read the answer. You copy the fix. You switch back. You paste. You run it.

**Seven steps. Every single time.**

This is the daily workflow of every developer using CLI-based AI tools. The terminal and the chat live in different worlds, and *you* are the copy-paste bridge between them.

**Shelly puts Chat and Terminal side by side — and connects them with AI.**

Say **"fix the error on the right"**. Shelly reads the terminal output, explains the error, and generates an executable command. Tap **[▶ Run]** and the fix lands directly in the Terminal pane.

No copy. No paste. No tab switching. Zero friction.

**Three levels of value:**
- **Level 1:** Chat alone — build things by talking. The entry point for beginners.
- **Level 2:** Terminal alone — a full native TTY for power users.
- **Level 3:** Both panes, side by side — a development experience that doesn't exist anywhere else.

---

## How is Shelly different?

Termux gives you a terminal but no AI. ChatGPT gives you AI but no terminal. Replit runs in the cloud. Claude Cowork is desktop-only. Shelly is the only tool that puts a native terminal and multi-agent AI chat side by side on your phone — and connects them so the AI can read what the terminal shows and execute fixes with one tap.

---

## Features

### Highlights

- **Cross-pane intelligence** — Say "fix the error on the right." AI reads your terminal, suggests a fix, one tap to execute. No copy-paste. No tab switching.
- **Native terminal emulator** — Kotlin + C (`forkpty`), not a WebView. Sessions survive app switching. The only React Native app with an embedded native terminal.
- **Natural language everything** — Talk, type, or speak. Shelly figures out whether to run a command, ask an AI, or both. 12 AI agents, auto-routed or `@mention`-selected.

<details>
<summary><strong>Cross-Pane Intelligence (8 features)</strong></summary>

- **"Fix the error on the right"** — AI reads terminal output and responds with executable fixes
- **ActionBlock** — Code blocks in AI responses have [▶ Run] buttons that execute directly in Terminal
- **Real-time terminal awareness** — Chat AI always knows what's happening in Terminal (wide mode: automatic, single pane: on reference)
- **CLI Co-Pilot** — Real-time translation of terminal output, approval prompt explanations, second opinions, session summaries
- **Approval Proxy** — Terminal `[Y/n]` prompts become native chat buttons (Approve / Deny / Ask @team). No more typing blind 'Y'.
- **Error Summary** — Errors are detected, translated, and surfaced as persistent chat bubbles with [Suggest Fix] buttons
- **Auto-savepoint** — Game-like save/load system. Every change is auto-committed. Revert to any point with one tap
- **Pre-commit security scan** — API keys, private keys, and secrets are detected before they're committed

</details>

<details>
<summary><strong>Chat-First Development (6 features)</strong></summary>

- **Natural language execution** — Talk naturally, get real execution. Commands run behind the scenes in Termux
- **Multi-agent AI routing** — Automatically selects the best AI based on the task
- **@mention routing** — `@claude`, `@gemini`, `@codex`, `@cerebras`, `@local`, `@perplexity`, `@team`, `@plan`, `@arena`, `@actions` for direct control
- **VoiceChain** — Voice input connects to the full input router. Speak → execute → TTS response
- **GitHub integration** — AI suggests when to push. PAT setup in chat. One-tap sync. `@actions` sets up CI/CD without touching YAML
- **Natural language packages** — "install python" → `pkg install -y python`. Package errors auto-diagnosed and fixed

</details>

<details>
<summary><strong>Creative Tools (4 features)</strong></summary>

- **Plan Mode** — AI-generated plans as interactive step cards. Execute or skip each step with a tap
- **Click-to-Edit** — In the preview panel, tap any element to select it. Preset buttons or custom instructions modify the UI instantly
- **Arena Mode** — Same prompt, two AIs, blind comparison. Vote for the better response, then see which AI wrote it
- **Template Gallery** — 7 project templates with guided wizard flows. From "what do you want to build?" to running code in under a minute

</details>

<details>
<summary><strong>Safety & Learning (3 features)</strong></summary>

- **5-level command safety** — Every command is risk-assessed before execution. Dangerous operations require confirmation
- **Learning mode** — AI explains what each command does and what the output means, in your language
- **Onboarding wizard** — 5-minute setup from zero. Termux install, AI configuration, everything guided

</details>

<details>
<summary><strong>Power Features (11 features)</strong></summary>

- **Native Terminal Emulator** — Kotlin-based rendering on Android Canvas. No WebView. Connected via direct PTY helper (C, `forkpty()`) over TCP localhost
- **Reconnectable sessions** — PTY helper supports client reconnection. Sessions survive app transitions
- **Termux bridge** — Native Kotlin module for direct Termux integration
- **Local LLM support** — Run Gemma/Qwen on-device via llama.cpp with guided setup wizard
- **Japanese input in terminal** — Something Termux alone can't do
- **Multi-pane layout** — Split view on foldable/wide screens
- **SmartKeyBar** — 5 context-adaptive key sets (Default / Vim / Git / REPL / Navigate). Swipe to switch
- **Command completion** — 30+ top-level commands with subcommand and flag completion
- **PackageDoctor** — Auto-diagnoses Termux package errors and suggests fixes in chat
- **ProcessGuard** — Detects Android process kills, shows device-specific fix wizard
- **8 terminal themes** — Shelly / Dracula / Nord / Monokai / Tokyo Night / Gruvbox / Catppuccin / Solarized

</details>

---

## The Story

Mobile development never took off — not because phones lack computing power, but because the **input** and **interface** weren't designed for creation.

Chat apps (ChatGPT, Claude, Gemini) can *talk* about code, but they can't *run* it. Terminal emulators (Termux) can *run* anything, but they're hostile to anyone who isn't already a developer.

Shelly fills the gap. You type "make me a portfolio site" in a chat bubble, and a real shell runs the commands, generates files, and shows you the results.

### Why Native?

Early versions used ttyd and a WebView. WebSocket connections dropped. Android's Phantom Process Killer terminated background processes. Every time you switched apps, the terminal was dead.

So I directed the AI to throw it all away and go native. Shelly now embeds a native terminal emulator — Kotlin code derived from Termux's own `terminal-emulator` library — directly inside an Expo/React Native app, connected via a custom C helper that creates pseudo-terminals with `forkpty()`.

As far as we know, this is the **only React Native app in the world** with an embedded native terminal emulator.

### Who is this for?

- **Vibe Coders** — Lovable/Bolt/Replit Agent, but on your phone with a real terminal underneath
- **Mobile-first developers** — Claude Code or Gemini CLI in Termux, with a proper UI around it
- **Non-engineers with ideas** — Shelly translates everything. Dangerous operations are blocked until you understand them

---

## Architecture

### Chat → Execution Pipeline

```
User input (natural language / voice)
       │
       ▼
┌─────────────────────┐
│   Input Router       │  ← Intent classification (4 layers + 4.5 routing)
│   "What does the     │
│    user want?"       │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌──────────┐
│ Light  │  │ AI Agent │  ← Claude / Gemini / Codex / Cerebras / Groq / Local LLM
│ Tasks  │  │ Selection│
│(direct)│  └────┬─────┘
└────────┘       │
                 ▼
          ┌─────────────┐
          │ Direct PTY   │  ← C helper (forkpty) → real shell
          │ (native)     │
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │  Chat UI     │  ← Results as chat bubbles + ActionBlocks
          │  (response)  │
          └─────────────┘
```

### Cross-Pane Intelligence

```
┌─────────────────────────────────────────────────┐
│              Shelly (Wide Mode)                  │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐  │
│  │   Chat Pane   │    │    Terminal Pane        │  │
│  │              │    │                        │  │
│  │  User: "fix  │    │  $ npm run build       │  │
│  │  the error   │    │  Error: Cannot find     │  │
│  │  on the      │    │  module './utils'       │  │
│  │  right"      │    │                        │  │
│  │              │    │                        │  │
│  │  AI: The     │◄───│  (output captured via    │  │
│  │  error is... │    │   native terminal view)  │  │
│  │              │    │                        │  │
│  │  ┌────────┐  │    │                        │  │
│  │  │▶ Run   │──┼───►│  $ mv util.ts utils.ts │  │
│  │  └────────┘  │    │                        │  │
│  └──────────────┘    └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Chat reads Terminal. Terminal executes Chat. The user just talks.

---

## Built With

| Layer | Technology |
|-------|-----------|
| Framework | Expo 54 / React Native 0.81 |
| Language | TypeScript (strict) + Kotlin + C |
| UI | NativeWind (TailwindCSS 3) |
| State | Zustand |
| Navigation | expo-router v6 |
| Terminal | Native emulator (Kotlin, Termux-derived) + Direct PTY (C, forkpty) |
| i18n | expo-localization + Zustand (900+ keys, EN/JA) |

---

## Design Philosophy

Shelly was designed by someone who can't use a terminal — for people who can't use a terminal.

Every design decision comes from the question: *"If I don't know what this command does, how should the app protect me and teach me at the same time?"*

The cross-pane system comes from: *"Why do I have to copy an error from one window and paste it into another?"*
The native terminal comes from: *"Why does the terminal die every time I switch apps?"*
The approval proxy comes from: *"Claude is asking me to approve something in English. I don't know what it means."*
The VoiceChain comes from: *"I can't type on a phone keyboard fast enough to keep up with my ideas."*

Every limitation became an innovation that engineers need just as much.

Read the full design philosophy: **[docs/DESIGN_PHILOSOPHY.md](docs/DESIGN_PHILOSOPHY.md)**

---

## Contributing

This started as a personal tool. Community contributions are shaping it into a true OSS project.

Code comments are primarily in Japanese. English translations welcome as PRs.

**Good first files to explore:**
- `lib/input-router.ts` — The brain. Classifies natural language into shell commands, AI requests, or @mentions
- `lib/terminal-context.ts` — Cross-pane intelligence. Captures terminal output and injects it into AI prompts
- `lib/command-safety.ts` — Risk assessment engine. Blocks dangerous commands with 5 severity levels
- `lib/auto-savepoint.ts` — Watches for file changes and auto-commits. The "game save" system
- `components/chat/ActionBlock.tsx` — Renders [▶ Run] / [Copy] buttons on AI-generated code blocks
- `modules/terminal-view/android/.../ShellyTerminalView.kt` — The native terminal renderer (Kotlin + Android Canvas)

> **Test suite:** Not yet established. Adding tests for `input-router`, `command-safety`, and `auto-savepoint` is a high-value contribution.

If you find something that could be better — a cleaner pattern, a performance optimization, a bug fix — **please open an issue or PR**. That's exactly why this is open source.

Read the contributing guide: **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## Vision

Mobile terminals are about to become standard. Most developers don't see it yet.

Modern mobile SoCs have NPUs pushing 40+ TOPS. Local LLMs that required a desktop GPU two years ago now run on phones. Soon, 7B-13B parameter models will run natively on mobile at acceptable speeds.

When that happens, you'll have zero-cost AI-assisted development, complete privacy, and development anywhere — airplanes, remote sites, commutes.

Shelly was built for that future. Local LLM integration is already implemented. The native terminal is already there. The multi-agent routing already supports local models alongside cloud APIs.

The question isn't whether mobile development will happen. It's who builds the tools for it first.

---

## About the Creator

**RYO ITABASHI** — Creative Director at [Rebuild Factoryz](https://rebuildfactoryz.com/). Branding and design are my profession. Code is not.

I built Shelly because I wanted to use Claude Code on my phone, but Termux was too intimidating. So I made a chat interface that hides the terminal complexity while keeping its full power. Then I realized the real problem wasn't the terminal itself — it was the gap between the terminal and the AI. So I connected them. Then the WebView kept dying, so I directed the AI to replace the entire rendering layer with a native terminal emulator.

100,000 lines later, I still can't write code. But I can describe what I need, and the AI builds it.

The keyboard in the screenshots is **Nacre** — a split-layout Android IME I built (also through AI) to solve the input problem on mobile. Shelly handles the interface. Nacre handles the input. Together, they make phone-only development actually possible.

Both were developed entirely on a Samsung Galaxy Z Fold6, in Termux, without ever touching a desktop computer.

---

## Known Limitations

- **PTY communication is unauthenticated** — The native terminal connects to a PTY helper over TCP localhost. This is same-device only and not exposed to the network, but there is no auth layer between the two processes.
- **OOB TCP health check** — The session health monitor uses an out-of-band TCP connection. Same localhost-only constraint applies.
- **No offline mode** — Cloud AI features require an internet connection. Local LLM support works offline, but the default experience assumes connectivity.
- **Manus-era bundle ID** — The Android package name (`space.manus.shelly.terminal.t20260224103125`) dates from early development. Changing it would break existing installs — a migration is planned for a future major release.
- **Deep link scheme** — The custom URL scheme (`manus20260224103125://`) is a legacy artifact. Same migration timeline as the bundle ID.
- **@team routes to multiple APIs** — When using `@team`, Shelly queries multiple AI providers simultaneously. This consumes API credits on each provider. A cost warning is displayed before execution.

## Security

Shelly runs commands on your device. The safety system is a best-effort layer, not a guarantee.

- **Command safety is regex-based** — The 5-level risk assessment uses pattern matching. It catches common dangerous patterns (`rm -rf /`, `dd if=`, etc.) but is not a sandbox. Treat it as a seatbelt, not a firewall.
- **APK distribution is unsigned** — Release APKs from GitHub Actions are not code-signed. For verified builds, clone the repo and build locally with your own keystore. See [Building from source](#quick-start).
- **The autonomous agent requires explicit user approval for each action** — When using CLI agents (Claude Code, Gemini CLI) through Shelly, all file writes and command executions go through the approval proxy. The "all" auto-approve mode shows a security warning before activation.
- **API keys are stored in SecureStore** — Keys are never written to logs or debug output. SecureStore uses Android Keystore encryption on supported devices.

To report a security issue, please open a [GitHub issue](https://github.com/RYOITABASHI/Shelly/issues) with the `security` label, or contact the maintainer directly.

## Privacy

- **User profile learning** — Shelly observes your command patterns and AI usage to personalize suggestions (`lib/user-profile.ts`). This data stays on-device in AsyncStorage. However, when you send a message to a cloud AI, the profile context is included in the API request to improve response quality. You can disable profile learning in Settings.
- **No telemetry** — Shelly does not phone home. No analytics, no crash reporting, no usage tracking. The only network traffic is your explicit AI API calls.
- **Local LLM mode** — For fully private usage, configure a local model (Gemma/Qwen via llama.cpp). All processing stays on-device.

---

## License

[GPLv3](./LICENSE) — Copyright (c) 2026 RYO ITABASHI

This project includes code derived from [Termux](https://github.com/termux/termux-app) (GPLv3), specifically the terminal emulator rendering layer.
