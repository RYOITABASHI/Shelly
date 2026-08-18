<p align="right"><a href="README.ja.md">日本語で読む</a></p>

<p align="center">
  <img src="docs/images/shelly-logo.png" alt="Shelly" width="120">
</p>

<h1 align="center">Shelly</h1>

<h3 align="center">
  Shelly turns an Android phone — folded or unfolded — into a self-contained agent machine.<br>
  <sub>Describe a task in plain language, and it wakes on its own alarm — screen off — and does the work with your own AI accounts, local LLMs, and a real terminal underneath. No cloud runner. No PC. No Termux.</sub>
</h3>

<p align="center">
  <sub><em>Honesty first: the full unattended cycle has been observed end-to-end <b>once, on a Galaxy Z Fold6 (N=1)</b> — the <a href="#status">Status</a> table tracks exactly what is and isn't verified from here on.</em></sub><br>
  <sub><b>Underneath the agent is why you can trust it:</b> a full native terminal IDE — the real Codex CLI in an app-owned JNI PTY, bash / git / Python 3 / Node.js bundled in the APK, and API-backed AI panes (Gemini, Cerebras, Groq, Perplexity, local models) beside it. Everything the agent does runs in the same on-device shell you can open, inspect, and drive by hand. No Termux install, no distro bootstrap, no WebView terminal, no remote IDE bridge.</sub>
</p>

<p align="center">
  <a href="https://github.com/RYOITABASHI/Shelly/actions/workflows/build-android.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/RYOITABASHI/Shelly/build-android.yml?branch=main&style=flat-square&label=android%20build"></a>
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-blue?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android-00D4AA?style=flat-square&logo=android&logoColor=white">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Codex-D4A574?style=flat-square">
  <img alt="Expo" src="https://img.shields.io/badge/Expo%2054-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <a href="https://buymeacoffee.com/ryo1221"><img alt="Buy Me a Coffee" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=black"></a>
</p>

<p align="center">
  <img src="docs/images/widget-register-agent-en.jpg" alt="Registering a new autonomous agent straight from the Scouter home-screen widget's ASK box, no app open" width="500">
</p>

<p align="center">
  <a href="#see-it-run"><b>Demo</b></a> &nbsp;&middot;&nbsp;
  <a href="#quick-start"><b>Quick Start</b></a> &nbsp;&middot;&nbsp;
  <a href="docs/MANUAL.md"><b>Manual</b></a> &nbsp;&middot;&nbsp;
  <a href="#why-shelly"><b>Why Shelly?</b></a> &nbsp;&middot;&nbsp;
  <a href="#features"><b>Features</b></a> &nbsp;&middot;&nbsp;
  <a href="#architecture"><b>Architecture</b></a> &nbsp;&middot;&nbsp;
  <a href="#release-integrity"><b>Release Integrity</b></a> &nbsp;&middot;&nbsp;
  <a href="#status"><b>Status</b></a> &nbsp;&middot;&nbsp;
  <a href="#contributing"><b>Contributing</b></a> &nbsp;&middot;&nbsp;
  <a href="#support"><b>Support</b></a>
</p>


<br>

---

## See it run

**Registering an autonomous agent from the home-screen widget — no need to open the app**

https://github.com/user-attachments/assets/fbda309f-ad12-4a6d-a5b8-96b6ee4d4e57

Type or speak `@agent ...` straight into the Scouter widget's ASK box. It routes through the exact same confirm flow as typing into the AI pane — same parse, same confirm card — then shows up in the scheduled-agent list with its next run time.

<br>

**The terminal underneath: a real AI coding CLI running natively on Android**

https://github.com/user-attachments/assets/c87ea206-12f8-4b21-9089-0a373b0e8a2a

No Termux. No proot. No remote dev server. OpenAI Codex — a real, full-featured coding CLI — invokes directly through Shelly's own JNI PTY, the same native terminal you can open and drive by hand.

**Unfolded: sidebar, terminal, AI, browser, and preview, all live at once — the same session, not four separate apps**

<p align="center">
  <img src="docs/images/unfolded-4-pane.jpg" alt="Shelly unfolded on a Galaxy Z Fold6, showing a 2x2 grid of Terminal, AI, Browser, and Preview panes plus the sidebar" width="800">
</p>

---

## Why Shelly?

Most of what exists today only covers one piece of this. A terminal app (like Termux) gives you a shell but no AI built in. An AI chat app gives you a smart assistant with no shell underneath it and no access to your files. A cloud coding workspace (like Replit) gives you both, but on a rented computer far from your device. Cloud "agents" run the same way — somewhere else, on files that aren't yours.

Shelly's bet: the phone in your pocket is already the best agent host you own — always on, always with you, and already holding your files, your accounts, your context. Shelly turns it into a self-contained agent machine, and grounds that agent in a real terminal IDE so you can see, verify, and drive by hand everything it does on its own.

**Two layers, one trust chain:**

- **The agent layer** — say what you want in plain language; Shelly registers a scheduled agent that wakes on an AlarmManager alarm, screen off, runs on your own keys and local models, and reports when it ran. ([details](#autonomous-agents) — and the [Status](#status) caveats that go with them)
- **The terminal layer** — everything the agent can do runs through the same on-device shell and toolchain you use interactively: an app-owned native PTY, the real Codex CLI, bundled bash / git / Python / Node. The agent isn't a cloud sandbox you take on faith; it's your own machine, inspectable down to the transcript.

### The copy-paste problem

You're running an AI coding tool in a terminal — Codex, or any other AI CLI. It throws an error. You copy it. You switch to ChatGPT. You paste. You ask "what went wrong?" You read the answer. You copy the fix. You switch back. You paste. You run it.

**Seven steps. Every single time.**

This is a familiar workflow for developers using CLI-based AI tools. The terminal and the AI live in different worlds, and *you* are the copy-paste bridge between them.

**Shelly puts the terminal and the AI side by side. The AI reads your terminal output automatically.**

Say **"fix the error on the right"**. Shelly reads the terminal output, explains the error, and generates an executable command. Tap **[Run]** and the fix lands directly in the Terminal pane.

No copy. No paste. No tab switching.

**Four levels of value:**

- **Single pane:** a native terminal that is faster, smarter, and more usable than Termux alone — with inline content blocks, syntax highlighting, and clickable errors.
- **Split panes:** terminal + AI side by side — the AI reads what the terminal shows and executes fixes with one tap. No copy-paste bridge needed.
- **Full layout:** sidebar + up to 4 live panes + agent bar — a mobile IDE. Browse docs in the browser pane, preview code or markdown on the right, use API-backed agents in the background, and keep your terminal front and center.
- **Unattended:** register a plain-language scheduled agent — the same machinery runs while the phone sits in your pocket, and tells you when it ran.

**On a foldable, that full layout is the default rather than an aspiration.** Folded, Shelly is a single-pane terminal. Unfold, and the same live shell expands into a sidebar plus up to four panes in a 2×2 grid — terminal, AI, browser, preview — without restarting the session. Shelly is developed daily on a Galaxy Z Fold6, which is why the unfolded layout is the design target and not an afterthought. (Rapid fold ↔ unfold during an active CLI stream is still listed under [Known Limitations](#known-limitations).)

---

## Important Android Notes

- **APK is ~800 MB** because Shelly bundles real tools, not shims. bash,
  Node.js, Python 3, git, curl, ripgrep, jq, tmux, vim, less, sqlite3,
  make, ssh — plus the OpenAI Codex CLI runtime — ship inside the APK.
  No Termux, no repository server, no package manager bootstrap. First
  launch extracts the binaries into app-private data.
- **All files access** is requested on first launch so `/sdcard` works
  the way a desktop terminal expects (`cd /sdcard/Download`, editing
  files there, etc.). Scoped Storage without this permission silently
  blocks writes. You can refuse — Shelly still works inside its own
  sandbox, but `/sdcard` paths will `Permission denied`.
- **LD_PRELOAD + /system/bin/linker64** is how Shelly runs Linux-layout
  binaries on Android bionic (SELinux blocks direct execve on
  app-private ELFs). The wrapper rewrites `/bin/X` and `/usr/bin/X` to
  `/system/bin/X` and routes app-bundled ELFs through `linker64`. Source
  is in `modules/terminal-emulator/android/src/main/jni/exec-wrapper.c`.
- **Not Termux-compatible by design.** Shelly does not use Termux
  packages, Termux paths, or Termux's prefix assumptions. If you already
  have Termux installed, Shelly still bundles its own copies of
  everything. No conflict, but also no sharing.

---

## Quick Start

### Install

Download the current Android APK from [**GitHub Releases**](https://github.com/RYOITABASHI/Shelly/releases). The rolling `android-latest` release is the source of truth for the newest Shelly build, and the latest tagged `vX.Y.Z` release APK is cut from that same build — the exact `versionCode`, commit, and SHA-256 are live in [`android-latest/latest.json`](https://github.com/RYOITABASHI/Shelly/releases/download/android-latest/latest.json).

After the first install, Shelly can update itself from inside the app: open the cloud-download button in the top bar or **Settings → Updates**. Shelly reads the public `android-latest/latest.json` manifest, compares Android `versionCode`, enqueues the APK with Android DownloadManager under `/sdcard/Download/shelly-update-<versionCode>/`, verifies SHA-256, then opens Android's package installer. The system download keeps running if Shelly is backgrounded or restarted. Android still asks you to confirm the install because Shelly is distributed outside the Play Store.

Expo OTA is disabled for release APKs. JS, native, and bundled-tool changes ship together through a new APK so the installed binary and app code stay in sync.

### Build from source

```bash
git clone https://github.com/RYOITABASHI/Shelly.git && cd Shelly
pnpm install && pnpm android
```

**Requirements:**

- Android device
- Node.js 20+ (CI currently builds on Node 20)
- pnpm
- Android NDK 26.1.10909125 (or an Android SDK/Gradle setup that resolves that pinned NDK)

Expo Go is not supported — Shelly uses native Kotlin/C modules.

Termux is not required. Shelly ships with bash, Node.js, Python 3, git, curl, ssh, sqlite3, tmux, vim, less, jq, make, and ripgrep. For tools beyond the bundled set, Termux can be used alongside Shelly.

### First launch

On first launch Shelly asks for **All files access** so the terminal can read scripts in `/sdcard/Download` and anywhere else on your phone. Tap **Allow** and you're done — `source /sdcard/Download/foo.sh` just works. Shelly is distributed through GitHub Releases for now; Play Store / F-Droid submission is still future work.

### Configure AI

After that, open **Settings → API Keys** (or run `shelly config` from the terminal pane) to paste API keys for Gemini, Cerebras, Groq, Perplexity, OpenRouter, OpenAI-compatible local servers, or other explicit API providers. Keys are stored in `expo-secure-store` and never written to logs.

### Sign in

Shelly's foreground AI CLI is **Codex**. Everything else is an API provider you configure with a key.

| Surface | How to sign in | Notes |
|---|---|---|
| **Codex CLI** (ChatGPT subscription) | Run `codex`, or `codex-login --open` directly | The supported foreground CLI. If `~/.codex/auth.json` is missing or invalid, the `codex` wrapper starts Shelly's device-code login, opens the OpenAI device-code page in the in-app Browser Pane, writes `~/.codex/auth.json` (mode `0600`) on success, then launches the normal Codex TUI. No OpenAI API key required — this rides your ChatGPT subscription. |
| **API providers** (Gemini, Cerebras, Groq, Perplexity, OpenRouter, local) | **Settings → API Keys** or `shelly config` | Paste a key per provider for AI-Pane / `@mention` / `@team` / background-agent use (OpenRouter is attended-only). Keys live in `expo-secure-store`. Local/OpenAI-compatible servers need only a base URL. |

> **Codex login note.** `codex /login` inside the REPL is not the supported path on Shelly. Use bare `codex` and let Shelly's wrapper launch device-code auth, or run `codex-login --open` from bash.

### Bundled Shelly commands

| Command | Use |
|---|---|
| `codex` | Launch the foreground Codex TUI in the native terminal. If auth is missing, Shelly starts the device-code login flow first. |
| `codex-login --open` | Start ChatGPT subscription device-code auth and open the verification page in Shelly's Browser Pane. |
| `shelly-doctor` | Check shell/native binary presence, bundled Codex binaries, JS dispatcher, local LLM endpoints, and Codex auth file presence. |
| `shelly-codex-diagnose` | Run deeper Codex smoke/canary/edit/patch diagnostics. |
| `shelly-update-clis codex --check-only` | Probe the active Codex runtime. Runtime installs are normally driven by the Updates UI. |
| `shelly-cs` / `cs` | GitHub Codespaces helper commands. |

**First thing to try:** once a provider key is set, type `@agent` in any pane followed by a plain-language instruction and a time — e.g. `@agent every day at 8am, collect the latest STEAM×AI education papers and news, summarize them, and save to Obsidian`. Shelly turns that into a scheduled on-device agent (see [it run above](#see-it-run)).

---

## Runtime model

Under the agent sits Shelly's structural advantage: the runtime itself — a native PTY and a managed Codex CLI running in the same on-device shell as your files, with API-backed agents layered on top. Not a WebView terminal, not a remote IDE client.

If your AI coding CLI workflow stalled in Termux, proot, or another Android terminal setup, Shelly gives you a maintained on-device environment built around the constraints of real Android devices (bionic libc, `linker64` exec rules, SELinux on `app_data_file`).

No fragile terminal stack. No WebView terminal crashes. No copy-paste-driven workflow.

- **Native execution path** — Codex runs through Shelly's app-owned native PTY (JNI `forkpty`), not a remote bridge or socket terminal.
- **Managed latest, not blind latest** — Shelly ships a pinned Codex runtime in each APK, and the Updates UI can install a newer verified Codex runtime from the rolling `codex-runtime-latest` release without waiting for the next APK.
- **Visible state** — the app can show recent terminal logs, so version drift and startup failures are easier to debug on the device itself.
- **Compliance boundary** — Codex is a foreground, user-controlled terminal CLI. AI-Pane / background automation uses explicit API providers; it does not run a hidden subscription worker.

This is the part that makes Shelly more than a terminal skin. It is the reason the app can ship a fast-moving CLI on Android without turning the user into the update mechanism.

### Release surface

| Surface | Status | What that means |
|---|---|---|
| **Codex CLI** | Supported | The foreground CLI. Bare `codex` launches the normal Codex TUI after Shelly verifies or creates `~/.codex/auth.json` through in-app device-code auth, running over the native PTY. |
| **AI Pane / background agents** | Supported through APIs | Uses configured providers: Gemini API, Cerebras, Groq, Perplexity, OpenRouter (attended AI-Pane use only), and local OpenAI-compatible servers. Provider-key based, no hidden subscription reuse. |
| **Gemini API** | Supported where configured | Available for the AI Pane, `@gemini` routing, `@team`, multimodal/API-backed tasks, and background agents when a Gemini API key is set. (This is the API provider — there is no bundled Gemini CLI.) |

---

## What Shelly is not

Shelly is not a Termux skin, a WebView terminal, or a remote IDE client. It owns the Android terminal stack inside the app, runs Codex on-device in the same shell as your files, and layers API-backed agents next to that terminal instead of forcing you through copy/paste or a cloud workspace.

It is also not a cloud agent service. Scheduled agents run on the device, on your keys, with no server-side component and no subscription runner — if the phone is off, nothing pretends otherwise, and missed runs are surfaced instead of hidden.

No Termux install. No proot. No ttyd. No remote bridge. No cloud runner.

---

## Features

> Features below describe implemented paths in the current build. Items with limited device validation (e.g. unattended agent firing, TTS playback, cross-OEM reliability) are caveated here and in [Status](#status) / [Coming Soon](#coming-soon).

### Highlights

| | |
|---|---|
| **On-device autonomous agent** | Say it in plain language → a scheduled agent runs on the phone *by itself* (screen off), on your own keys and tools, and tells you when it ran. It works where a cloud agent can't reach — your files, terminal, local LLM, the device itself. *N=1 verified so far — see [Status](#status).* ([details](#autonomous-agents)) |
| **Shelly companion** | The default local-persona AI Pane is one persistent companion named **Shelly**, not a provider-branded form. Its conversation follows you across AI panes and splits, remembers confirmed preferences for itself and every background agent, and adds completed agent results to the same thread automatically. Explicit provider routes keep their own per-pane histories. |
| **Multi-platform delivery** | An agent's output isn't limited to a notification or an Obsidian draft — it can post directly to Bluesky, Discord, Slack, Telegram, Mastodon, Misskey, WordPress, or X, or call a webhook. Store each platform's key once, then point an agent at it in plain language. *Bluesky is verified live end-to-end.* |
| **Notification-triggered agents** | An agent can also fire when another app posts a matching notification — LINE, Discord, Slack, whatever you allowlist — instead of only on a schedule. Package allowlist gates first, an exact sender-name match narrows it further (fail-closed if unset), and the triggering text is always injected as tainted, untrusted data, never instructions. Separately, the opt-in **Telegram inbound gateway** (off by default) accepts `@agent` messages from one authorized chat and queues a confirmation card; its authorization/sanitization core is tested, but the real bot-token long-poll → confirm flow has not been live-tested. |
| **Agent browser automation** | An agent can click, fill, or extract text from the page already open in the Browser pane — a deliberately narrow action set (no navigation, no arbitrary script injection), gated to an explicit page-URL allowlist and a per-action approval tap; page-derived output is always treated as untrusted at the next capability boundary. |
| **Cross-app UI automation (`app.act`)** | For apps with no public API — LINE messaging is the flagship case — an agent can drive the real app UI through Android's Accessibility Service (an explicit, package-allowlisted, one-time-granted recipe walker; on-device verified sending to LINE and posting to X). It goes through the same approval-gated agent action pipeline as every other action type, including a trusted-unattended auto-fire path — which is exactly the trap: Accessibility automation can't act while the phone is locked, so a scheduled `app.act` agent can silently do nothing at fire time. Where a real API exists (X's `x.post` recipe, when the utterance explicitly names the platform and a connector is registered) natural-language registration now prefers the API instead; LINE has no API alternative, so `line.send-message` isn't offered as an NL registration target for scheduled agents at all — reachable only for manually-triggered runs today. *A generic, platform-unnamed "post/tweet this" phrasing can still resolve to the older `app.act` path even for X — this narrower case is a known gap, not yet closed.* |
| **Cross-pane intelligence** | Say "fix the error." AI reads your terminal, suggests a fix, one tap to run. Zero copy-paste. |
| **AI Edit golden path** | Tap a file in the sidebar → preview it → hit `[✨ AI]` → describe the change → accept per hunk → the file is rewritten on disk, the preview reloads automatically. |
| **Codex apply_patch on-device** | Codex file edits land through the agent's native patch tool on Android, not a shell-only fallback. |
| **Native PTY (JNI forkpty)** | Kotlin + C, direct PTY fd, no TCP/socket bridge — an embedded native terminal, not a WebView terminal. |
| **Batteries included** | bash, Node.js, Python 3, git, curl, ssh, sqlite3, tmux, vim, less, make, ripgrep, jq ship inside the APK. Termux not required. |
| **9 pane types** | Terminal, Agent Chat, AI, Browser (+ background audio), Markdown, Preview, Ask, Agent Runs, and Memory Workbench. Split up to 4 live panes freely. |
| **Multi-agent AI** | API-backed Gemini, Cerebras, Groq, Perplexity, OpenRouter, Local LLM, plus the foreground Codex terminal CLI. Auto-routed or `@mention` where supported. |
| **Local LLM (on-device, llama.cpp)** | Qwen3.5 models run on-device through the bundled llama.cpp / llama-server flow, with Qwen3.5-2B as the daily-driver default, Qwen3 1.7B / Qwen3.5 0.8B as lighter fallbacks, and 4B+ models reserved for short quality checks. |
| **Codex on Android** | Shelly keeps Codex on a managed-latest path without trusting upstream blindly: each APK bundles a pinned runtime, the Updates UI can promote verified runtime releases, and Reset falls back to the bundled runtime. Codex runs over the native PTY with a Shelly-owned device-code login wrapper. No proot, no root. |
| **Scouter home widget** | A home-screen agent launcher and health list — up to 3 upcoming scheduled agents, each with a status glyph (last run's success/error/skipped) and next-fire time, without opening the app. It is interactive: **RUN** starts that already-registered agent through the unattended execution gates; **ASK** can also register a brand-new agent — type or speak `@agent ...` and it routes through the same confirm flow as typing it in the AI Pane. |
| **Color themes** | Blue / Red / Purple / Green palettes run on the existing preset IDs, so runtime swaps keep your shell alive without settings migration. |
| **Voice input** | Speak your commands or AI prompts. Groq Whisper handles transcription, then VoiceChain routes the text through the same input router the keyboard uses. |

### Autonomous agents

Say what you want in plain language; Shelly registers a scheduled agent that runs **on the device, by itself** — even with the screen off. It wakes via Android **AlarmManager** (`setExactAndAllowWhileIdle`, designed to fire under Doze, unlike cron-under-Termux), runs on-device with **your own keys and tools**, and **tells you when it ran** (notification + per-agent next/last-run, with a missed-run warning if an expected run didn't record).

The wedge isn't "smarter than a cloud agent" — it's that it **works where a cloud agent can't reach**: your files, your terminal/scripts, your local LLM, the phone itself.

It's a **capability you point at your own tools**, not a fixed feature. One example (mine):

```
@agent every day at 8am, collect the latest STEAM×AI education papers and news,
and write the primary-source links + a short summary to my Obsidian vault
```

The schedule above registers an agent that, when it fires, wakes the phone, researches via Perplexity, and drops a dated, sourced summary into Obsidian — unattended, the same run shown in the demo above. Swap in your own schedule, source, and output.

Scheduling also understands a relative *start*, not just a recurrence — "starting next week, check the news every morning" registers the agent now but holds its first fire until the resolved date, instead of running tomorrow by mistake. (Confirmed on-device for the registration/confirm-card path.)

If the request itself is too vague to act on — "help me out" with no object or domain — Shelly asks what you actually want done *before* it asks when to run it, instead of scheduling an agent with an empty task.

**Honest caveat:** unattended firing depends on Android's background limits, which vary by manufacturer (Samsung / Xiaomi / Oppo / OnePlus battery-freezers). Shelly uses Android's highest-priority alarm path (named above) and surfaces missed runs, but it can't *guarantee* a fire on every device — grant the battery-optimization exemption and check the agent's run view.

### Learning loop

Registering an agent isn't a fixed form. When what you asked for is ambiguous, an LLM — not a hardcoded pipeline — drives the rest of the conversation in its own words, asks follow-up questions one at a time, and only proposes a final registration once it believes it has enough (**LLM-Led Agent Registration**, on by default, toggle in Settings → Agents; tries a fast cloud provider first if you've configured one, then falls back to the on-device model, then to Shelly's fixed one-field-at-a-time prompts if nothing is reachable — so the conversation degrades gracefully instead of getting stuck). A request that turns out to have several ordered steps ("look this up, summarize it, then post it") is kept as a real multi-step chain — the same orchestration engine deterministic registration already used — instead of being collapsed into one prompt. Every value the model proposes is still independently re-checked before it's trusted: a schedule phrase is re-parsed by the same deterministic cron logic every other path uses, a posting destination has to match a connector you actually registered, and a webhook URL or shell command is only accepted when it's a literal, character-for-character copy of something you typed in that same conversation — never something the model invented. The human confirmation tap is never skipped, no matter which path produced the draft.

Agents also get better with use, on-device, without a server:

- **Skill distillation** — after a successful run, Shelly can distill it into a reusable "skill recipe" (a markdown file, GLOBAL across agents, not tied to the one that created it) and offers to save it; a later task that matches gets the recipe recalled and reused instead of solving the same problem from scratch. Nothing saves silently — you always see what would be kept.
- **Skills catalog** — the Sidebar's **Browse Catalog** action fetches Shelly's first-party catalog of importable skill recipes, verifies each download, and places it in the same quarantine/review flow as a local skill import; catalog availability follows the published `skills-catalog-latest` release.
- **Persistent memory** — agents can write and recall small facts across runs ("remember that…"). Per-agent writes now use the encrypted MEMORY-001 store by default, with the older markdown/Obsidian path retained as a fallback; shared `_global` writes still use that older path. See [Privacy](#privacy) for the current storage and verification limits.

### Scouter Widget

<p align="center">
  <img src="docs/images/scouter-widget.jpg" alt="Shelly Scouter widget showing a registered agent with its next scheduled run time, plus one-tap RUN and ASK buttons" width="500">
</p>

Scouter is Shelly's home-screen agent launcher and health list. It shows up
to 3 upcoming scheduled agents (name, last-run status glyph, next-fire time)
and lets you run one, or register a new one via ASK, without opening the app.
An earlier version of this widget also carried a live Codex session HUD
(status/DOING line, token/context/rate-limit cells, local LLM health row) plus
Allow/Deny and numbered-choice pills that wrote straight to the foreground
Codex PTY — that was deliberately removed in a 2026-07-18 redesign to keep the
widget a launcher, not a second copy of the terminal; approvals and choices
are still available through Codex notification channels and the in-app Agent
Chat pane (see below).

<details>
<summary><strong>What it shows</strong></summary>

- **Header** — a status dot (green, or red with a failure-count badge when any shown agent's last run errored) and the "AGENTS" title
- **Up to 3 agent rows** — name, a last-run status glyph (✓ success / ✗ error / • skipped-or-transient / – never run), and either the next scheduled fire time or a live elapsed-seconds counter while that agent is running
- **RUN per row** — starts that row's agent directly through the same unattended execution gates a scheduled alarm fire uses
- **ASK** — opens a lightweight prompt dialog to send a Codex prompt or register a new `@agent`
- **Decorative pet** — an optional imported/bundled Codex pet image renders in the widget; it is display-only (no tap-to-cycle) as of the 2026-07-18 redesign

</details>

<details>
<summary><strong>Interactive control</strong></summary>

- **ASK** — tap ASK to open a prompt dialog; Shelly writes the text into the bound foreground Codex terminal (clear line, paste, Enter) and returns you to the launcher
- **`@agent` registration from ASK** — type or speak `@agent ...` into the ASK box instead of a plain prompt, and it hands off to the same AI Pane `parseAgentCommand`/confirm-card flow used when you type `@agent` directly, instead of landing in the Codex PTY. An opt-in **Widget No-Confirm Register** setting (off by default) skips the confirm card for widget-originated `@agent` commands only and registers immediately with a post-registration notification; typing `@agent` directly in the AI Pane always confirms regardless of this setting.
- **Voice input for ASK** — the ASK dialog's mic button uses Android's built-in speech recognizer; the recognized text lands in the field for you to review and edit, never auto-submitted.
- **RUN scheduled agent** — starts an agent directly through the foreground service without opening the app; Shelly revalidates its disk metadata at tap time, honors STOP-ALL, and keeps unattended per-action approval fail-closed. By design, unattended runs default to OAuth/local tools only — an agent that would use a cloud API key (Gemini, Perplexity, …) unattended falls back to Codex instead unless the opt-in **Autonomous Cloud** setting (off by default) allows the cloud call.
- **Cold-start ASK** — if no Codex or Agent Chat session is available, Shelly queues the widget prompt, opens a terminal, waits for the PTY to become alive, starts `codex`, waits for the Codex input surface, then delivers the queued prompt
- **Resume when unbound** — if the bound terminal has exited, a queued ASK prompt opens Agent Chat to resume the session, then drains the queued prompt
- **Approvals and choices** — no longer surface as widget pills; use the Codex notification channels' one-tap Allow/Deny buttons and numbered actions, or the in-app Agent Chat pane's Approve/Deny bubbles (both below)
- **How controls are dispatched** — ASK writes to the live PTY through the in-process terminal session registry; RUN uses a direct foreground-service PendingIntent matching scheduled fires. Neither path shells out through `am start`

</details>

<details>
<summary><strong>Layout System</strong></summary>

- **Single-screen layout** — AgentBar (top) + Sidebar (left, collapsible) + PaneContainer (center) + ContextBar (bottom)
- **9 pane types** — Terminal (native PTY), Agent Chat (Codex session companion), AI (streaming + context injection), Browser (WebView + bookmarks + background audio), Markdown (viewer), Preview (Code / Image / PDF / CSV / Markdown renderers), Ask (Shelly help), Agent Runs (browsable per-agent run history, logs, routing and step/action detail), and Memory Workbench (search, view, edit, and delete an agent's notes and shared `_global` notes)
- **Preset slot layout** — up to 4 live panes in single, two-column, three-pane, or four-pane presets; drag the accent-green grip to resize, double-tap it to restore 50/50
- **Layout presets** — Single Terminal / Terminal + AI / Terminal + Browser / 3-Way Triple, all reachable from the Command Palette
- **Pane-type pill** — header left shows `[TERMINAL ▾]` / `[AI ▾]` / …; tap to change the pane type in place
- **CLI tab strip inside terminal panes** — multiple shell tabs per pane, `[● SHELL][+]`, close `×` on non-last tabs
- **Empty-pane recovery** — the last pane cannot be closed; if the tree ever empties, a 3-button CTA (Terminal / AI / Browser) brings it back
- **ContextBar** — always-visible footer showing cwd, git branch, and connection status

</details>

<details>
<summary><strong>Cross-Pane Intelligence</strong></summary>

- **"Fix the error on the right"** — AI reads the current terminal transcript and responds with executable fixes
- **ActionBlock** — code blocks in AI responses get `[▶ Run]` buttons that dispatch to the active terminal pane
- **Pane-aware terminal selection** — in split layouts, the AI pane prefers the terminal immediately to its left, then the focused terminal, then the first terminal
- **Real-time terminal awareness** — AI pane snapshots the terminal transcript on dispatch so the model sees what you just saw
- **Terminal-safe context** — ANSI/OSC/control sequences and TUI redraw noise are stripped before injection; terminal output is treated as untrusted evidence, not instructions
- **Local LLM compaction** — `@local` keeps important header/status/error lines and the recent tail so small on-device models still see the useful terminal state
- **Auto-savepoint** — every edit is auto-committed to a hidden git index so you can revert to any point with one tap
- **Pre-commit secret scan** — API keys, private keys, and other secrets are blocked before they land in a savepoint commit

</details>

<details>
<summary><strong>Agent Chat — chat surface for the bound Codex terminal</strong></summary>

- **Chat over the foreground Codex** — a chat-style pane that mirrors the bound Codex session's timeline (user prompts, Codex replies, tool runs, approvals, errors) parsed from the session JSONL and Scouter snapshots
- **Reply composer** — type a reply and send; it writes to the bound foreground Codex PTY, not a hidden API worker — consistent with Shelly's compliance boundary
- **READY / LOCKED** — a pill shows whether the bound terminal can accept a reply; when locked, the composer explains why (terminal exited, Codex busy, waiting on a terminal choice, not bound yet)
- **Approve / Deny** — approval requests surface as bubbles with Allow / Deny buttons that send the decision to the bound Codex terminal; only the latest pending approval is actionable
- **Interrupt** — a stop button sends a terminal interrupt to the bound Codex while it is working
- **Resume** — the play button reopens or focuses the bound Codex terminal for the selected session, rebinding it for replies
- **Session tabs** — recent Codex sessions are shown as tabs (deduped per workspace + model), each with a binding dot; dismiss hides a session from Agent Chat without touching its JSONL on disk
- **Session strip** — project, status, binding, model, token count, and last-update time for the selected session

</details>

<details>
<summary><strong>AI Edit — file edit with Accept / Reject</strong></summary>

- **Staged file** — tap a file in the FileTree; it opens in the Preview pane's Code tab. The `[✨ AI]` toolbar button stages the file in the AI pane's context.
- **Dispatch** — write "make the first function Japanese-comment" (or anything) and send. Shelly's system prompt asks the model to respond with a unified diff.
- **InlineDiff** — the assistant reply is scanned for unified diff blocks and each hunk is rendered with `+` / `-` / context coloring plus Accept / Reject buttons.
- **Per-hunk accept writes to disk** — accepting one hunk calls `acceptStagedDiff()` with a re-serialised single-hunk diff; the file is rewritten via the native `writeFileNative` bridge and the Preview pane auto-reloads.
- **Fuzzy re-anchor** — if the `@@ -N` line numbers are stale (because a previous hunk already edited the file on disk), the applier searches forward for the hunk's leading context block so successive hunks still land.
- **Accept All** — takes the same write-back path but applies every pending hunk in one pass.

</details>

<details>
<summary><strong>Terminal Enhancements</strong></summary>

- **Fig-style autocomplete** *(not currently implemented — see `docs/superpowers/DEFERRED.md`)* — the completion engine (`lib/autocomplete-engine.ts`) and command database exist and are reusable, but the terminal input path is a native PTY passthrough (`NativeTerminalView`) with no JS-visible input buffer/cursor, so reviving the popup requires a scoped native (Kotlin) change to stream the in-progress command line to JS
- **Syntax highlighting** — terminal output colorized by content type
- **Clickable paths and errors** — tap a file path or stack trace line to jump to it
- **Inline content blocks** — JSON, markdown, images, and tables rendered inline inside the terminal output (Command Blocks)
- **CLI notifications** — long-running commands surface a system notification when they complete
- **Codex notification channels** — Scouter posts per-category Android notifications, each on its own channel so you can tune importance / sound / mute from Android's notification settings: approvals, choices, and errors arrive as heads-up alerts, rate limits at default importance, completions and long-running quietly. Approval notifications carry one-tap **Allow / Deny** buttons and choice notifications expose the first three numbered actions; the widget itself can show up to six choice pills. The expanded notification view shows the full request or menu text, and resolved cards are deduped and cancelled so nothing stacks or lingers
- **SmartKeyBar** — 4 context-adaptive key sets by default (Default / Git / REPL / Navigate), swipe to switch; a 5th (Vim) is available via Settings → Terminal → "Show Vim key bar" (off by default, to avoid cluttering the bar for non-Vim users)
- **Immortal sessions** — tmux keeps your shell alive when the app is backgrounded; resume any session by name
- **Japanese input in terminal** — compose CJK characters directly in the terminal pane
- **Readable terminal glyphs** — the native Kotlin terminal view renders the PTY grid with JetBrains Mono so lowercase, columns, and code output stay legible
- **Atomic paste** — all paste paths converge on `TerminalEmulator.paste()`. When the guest shell has bracketed-paste mode on (DECSET 2004), the payload is wrapped so multi-line commands arrive as one event and readline executes only the trailing newline; shells/TUIs that don't advertise it (vim, less, nano) get a newline-normalized fallback instead. IME multi-line or ≥16-char commits, middle-click mouse paste, and the CommandKeyBar **Paste** key all reach the same normalizer.

</details>

<details>
<summary><strong>AI Pane</strong></summary>

- **Multi-agent routing** — the router picks the best AI for the task; override with `@mention`
- **One companion thread** — default local Shelly AI Panes resolve to `COMPANION_CONVERSATION_KEY` through `resolveAiPaneStoreKey`, so one conversation continues across panes and splits. Explicit external-provider bindings keep independent per-pane histories; changing a binding adds a small system notice.
- **Shared companion memory** — tell Shelly “remember that my deploy branch is staging”; after confirmation, it writes a `_global` note (`GLOBAL_MEMORY_SCOPE`) recalled by future companion conversations and every scheduled agent. This uses `detectCompanionMemoryWrite`; explicit all-agent commands use `detectGlobalMemoryWrite`.
- **Agent results re-enter chat** — a manual **Run Now** completion is added to the shared thread by `lib/agent-companion-notice.ts`, alongside the existing OS notification, confirmed on-device; a scheduled (AlarmManager) completion ships on the same tracker and code path but hasn't been independently observed firing live yet.
- **Delete individual messages** — long-press any AI Pane message, then confirm the destructive action; `deleteMessage` removes only that message from the resolved conversation.
- **@mention** — direct AI Pane providers are `@gemini`, `@cerebras`, `@perplexity`, `@openrouter`, and `@local`; utility routes include `@team`, `@agent`, `@git`, `@open` / `@browse`, `@plan`, `@arena`, and `@actions` / `@ci`. There is no `@claude` — Claude Code is not a current provider. Codex remains available as the foreground terminal CLI via `codex`. (Groq is configurable as a provider but isn't wired to a `@groq` mention pattern yet.)
- **Terminal context injection** — the AI always has access to the current terminal transcript without you pasting anything
- **InlineDiff with per-hunk write-back** — see above
- **Voice input** — long-press the mic in the terminal action bar to open VoiceChat; speech → Groq transcription → AI → TTS response
- **Local LLM support** — use the built-in GGUF catalog and llama.cpp / llama-server controls, then route via `@local` for fully on-device inference. Qwen3.5-2B Q4_K_M is the default, Qwen3 1.7B and Qwen3.5 0.8B are lighter fallbacks, and 4B/9B models are intended for short quality checks.

</details>

<details>
<summary><strong>Browser Pane</strong></summary>

- **Full WebView** — navigate any URL inside a pane; keep docs open next to your terminal
- **Bookmarks** — save and organize URLs; preset icons for YouTube, X, GitHub, and `localhost:*`
- **Background audio** — audio keeps playing when you switch panes
- **Outbound share** — share plain text (a URL, terminal output, whatever) *from* Shelly to any other Android app via the standard share sheet (there is no inbound share-target yet — Shelly does not appear in other apps' own share sheets)
- **Desktop UA toggle** — `📱` / `🖥` button in the URL row swaps the user agent so desktop-only sites behave
- **Video fullscreen** — six detection paths (W3C / WebKit / video element / monkey-patched APIs) catch YouTube-style fullscreen and maximize the pane, hiding the system nav bar

</details>

<details>
<summary><strong>File Tree</strong></summary>

- **Active-repo file list** — `ls -1pa` listing for the current working directory with per-extension icon coloring (`.tsx` sky, `.ts` blue, `.json` amber, `README.md` red, …)
- **Search** — incremental filter over the current directory
- **Open actions** — tap a Markdown file to open the Markdown pane, tap anything else to open the Preview pane's Code tab
- **Create / Rename / Delete** — `+` file and `+` folder buttons next to the search field; long-press a row for `Rename / Copy path / Delete`; modals use the active app palette
- **Breadcrumb** — tap the `..` row to go up

</details>

<details>
<summary><strong>Preview Pane</strong></summary>

- **Code tab** — per-file syntax-highlighted view with line numbers; the `[✨ AI]` button stages the current file for AI Edit
- **Markdown renderer** — `react-native-markdown-display` plus the Shelly palette
- **Image / PDF / CSV renderers** — inline viewers for common non-code attachments
- **Git diff view** — `git diff <file>` shown in the Code tab with neon `+` / `-` coloring
- **Recent files** — quick switcher inside the Preview header

</details>

<details>
<summary><strong>Sidebar</strong></summary>

- **Repositories** — list of bound repo paths; tap to switch and re-root the File Tree to that repo
- **File Tree** — see above; embedded as a section so it flexes with the sidebar height
- **Tasks** — recent background-agent runs with duration and status
- **Device** — quick-access folders (`~`, `/sdcard/Download`, …) that re-bind the file tree in one tap
- **Profiles** — saved SSH connections. Tap to insert `ssh -i KEY user@host -p PORT` into the active terminal pane; long-press to edit or delete; `Import from ~/.ssh/config` bulk-adds hosts. Key-file auth only — no passwords or passphrases are persisted.

> **Cloud storage?** Shelly deliberately doesn't ship a Google Drive / Dropbox / OneDrive UI. A terminal app should lean on the tools that already solve this — Shelly has no package manager of its own, but [`rclone`](https://rclone.org) ships as a single static binary: download the `arm64` release, drop it in a directory on `PATH` (or install it via Termux alongside Shelly), run `rclone config` once, and mount or sync any of 40+ cloud backends from the terminal pane.

</details>

<details>
<summary><strong>Command Palette</strong></summary>

Opens from the search icon in the top bar (or from the AgentBar's git badge). Fuzzy search across every registered action, plus a persistent **Recent** list of the last five you ran.

Currently registered:

- **Settings** — open the terminal-style Settings TUI
- **Terminal** — Clear / New session / Restore tmux / Tmux attach
- **Git** — Status / Diff / Log / Add all / Commit / Push / Pull --rebase *(routed through the active terminal pane's `pendingCommand` channel)*
- **Panes** — Add Terminal / AI / Browser / Markdown / Preview
- **Layouts** — Single Terminal / Terminal + AI / Terminal + Browser / 3-Way Triple
- **Theme presets** — Blue / Red / Purple / Green
- **Font presets** — Silk / 8bit / Mono and legacy editor palettes
- **Voice** — Open dialogue (VoiceChat modal)
- **Snippets** — first 20 entries from your snippet store, each dispatches to the terminal
- **Package Manager** — bundled tools status

</details>

<details>
<summary><strong>Theme &amp; Fonts</strong></summary>

- **Color presets** — Blue is the default cool palette, Red is red-orange chrome, and Purple is purple with neon green accents.
- **Visible presets** — Settings and the Command Palette expose the four color themes. Legacy and editor palette IDs remain accepted for old saved settings but are no longer the primary UI surface.
- **Runtime swap** — presets are swapped by mutating the live `colors` object in place (identity preserved) and bumping a theme-version store that key-remounts the shell layout. PTY sessions survive the switch — your vim stays open.
- **Single-family rendering** — every Text is forced through JetBrains Mono regardless of its `fontWeight`, keeping UI and terminal typography consistent.
- **Text.render monkey-patch** — `Text.defaultProps.style` is replaced (not merged) when a child passes its own `style`, which would otherwise let 100+ call sites escape the theme font. The patch prepends `{ fontFamily }` to every Text's style array so the preset font reaches every call site without touching them.
- **Neon glow** — eight per-color `textShadow` styles (teal / blue / sky / purple / pink / green / red / amber) for the mock's "reading terminal" vibe
- **Haptic toggle** — per-interaction feedback on/off

</details>

<details>
<summary><strong>Git Integration</strong></summary>

- **Command Palette** — the seven git actions listed above
- **Auto-savepoint** — background git-based save system (`lib/auto-savepoint.ts`) with secret pattern scanning before each commit
- **Git diff preview** — Preview pane Code tab renders `git diff <file>` with the neon diff palette

</details>

<details>
<summary><strong>Settings, API Keys, Background Agents</strong></summary>

- **Inline API key editor** — Gemini / Cerebras / Groq / Perplexity / OpenRouter and local/OpenAI-compatible API keys in the Settings dropdown with masked display and per-row `EDIT / CLEAR / SAVE / CANCEL`. Keys live in `expo-secure-store`.
- **Settings TUI** — full settings also accessible via a terminal-style text UI
- **Command safety** — regex-based 5-level risk assessment (seatbelt, not firewall — see [Security](#security))
- **Workspace isolation** — per-project cwd / env / AI context
- **Background agents** — `@agent list`, `@agent status`, `@agent run <name>`, `@agent stop <name>`, `@agent history <name>`, or `@agent <natural language>` to create one. Scheduled agents run through AlarmManager when configured.
- **Managed Codex runtime updater** — the Updates UI reads the public `codex-runtime-latest/codex-runtime.json` manifest, downloads the tarball, verifies SHA-256, smoke-tests `codex_tui --version` and `codex_tui exec --help`, then promotes the runtime under `~/.shelly-runtime/codex/current`. The new runtime is used by newly opened terminal tabs; **Reset** falls back to the APK-bundled runtime.
- **`shelly-doctor`** — diagnostic command that checks shell/native binary presence, bundled Codex binaries, JS dispatcher, local LLM endpoints, and whether `~/.codex/auth.json` is present; run it when something feels broken

</details>

### Codex Runtime

<p align="center">
  <img src="docs/images/agent-chat-codex.jpg" alt="OpenAI Codex CLI running natively in Shelly's terminal pane on Android, with the AI pane reading its output alongside it" width="700">
</p>

- **Native runtime** — the npm `@openai/codex` package is only part of the JS dispatcher story. Release APKs bundle the pinned Android-native unified `codex_tui` binary from `.ci-versions/`, and runtime updates install the same shape under `~/.shelly-runtime/codex/current`.
- **Managed promotion** — a new runtime candidate is promoted only after download, SHA-256 verification, extraction, executable checks, and `codex_tui --version` / `codex_tui exec --help` smoke checks.
- **Repair / reset path** — if the app-data runtime is broken or unwanted, the Updates UI can repair it from the latest runtime release or reset to the APK-bundled Codex runtime.

---

## Status

| Area | State |
|---|---|
| Native PTY, sessions, tmux revival | ✅ shipping |
| Multi-pane layout (8 types, splits, presets, drag resize, empty-state CTA) | ✅ shipping |
| Atomic paste (bracketed-paste wrap when guest opts in via DECSET 2004, single `TerminalEmulator.paste()` choke point, IME chunk-split coalesced) | ✅ shipping (bugs #91, #94, #97, #106) |
| `/sdcard` access via `MANAGE_EXTERNAL_STORAGE` (first-launch grant flow) | ✅ shipping (bug #92) |
| `bash` wrapper at `$HOME/bin/bash` for `bash -c "…"` and `bash script.sh` (including scripts with a `#!/usr/bin/env bash` shebang line) | ✅ shipping (bug #93); direct execution of a shebang script (`./script.sh`) still fails under Knox's `binfmt_script` restriction — always invoke via `bash script.sh` |
| `execSubprocess` JNI read loop (EAGAIN vs EOF distinction) | ✅ shipping (bug #70) |
| AI Edit golden path (stage → diff → per-hunk accept → disk writeback) | ✅ shipping, fuzzy re-anchor for successive hunks; on-device verified 2026-08-17 — both Accept (file content and mtime changed to match the diff) and Reject (file untouched) confirmed with real before/after md5 checksums |
| FileTree CRUD (create / rename / delete / copy path) | ✅ shipping |
| Command Palette — settings, terminal, git, panes, layouts, theme, voice | ✅ shipping |
| Browser fullscreen, desktop UA toggle, link capture, bookmarks | ✅ shipping |
| Theme presets — Blue / Red / Purple / Green, with legacy preset IDs accepted for saved settings (runtime swap, Text monkey-patch) | ✅ shipping |
| Sidebar Add Repository existence check + Alert on ghost path | 🟡 fixed 2026-08-17 (`tryAddRepo` now falls back to probing the target directly instead of failing open on a parent-read error, and requires an actual `.git` entry — directory or file, to cover worktrees/submodules) with 7 unit tests passing; the original bug is well understood (`readDirEntries` returning `[]` indistinguishably on missing/unreadable/empty was silently treated as "accept the add," reproduced 2026-08-17 with a fabricated-version-badge ghost entry that self-healed on app restart) but the fix itself hasn't been re-verified on-device yet |
| AI pane Local LLM routing (URL-driven, no enable toggle) | ✅ shipping (bug #68) |
| Voice dialogue (VoiceChat + VoiceChain + TTS) | ✅ voice input (mic → transcription → routed reply) confirmed on-device 2026-07-27; the dedicated full-screen VoiceChat mode and TTS playback weren't independently re-verified this pass |
| Immortal sessions (tmux keep-alive) | ✅ confirmed on-device 2026-07-27 — a `vim` session's interactive state (insert mode, unsaved buffer, cursor position) survived a full background/foreground cycle intact, not just a transcript replay |
| Local LLM via llama.cpp `@local` (Settings · Integrations · Local LLM: catalog, download, start/stop) | ✅ shipping |
| MCP Servers (Settings · Integrations · MCP Servers) | ✅ shipping for server lifecycle management (install/start/stop, config generation for tools like Codex that consume MCP) — the AI Pane itself does not act as an MCP client (no `listTools`/`callTool`) |
| Codex CLI launch/auth | ✅ supported; bare `codex` runs over the native PTY, using Shelly device-code auth before TUI launch |
| Codex managed native runtime (`codex_tui` staged under `~/.shelly-runtime/codex/current`, `--version` and `exec --help` smoke-tested, repair / reset to bundled runtime) | ✅ shipping; on one real device (2026-08-17) no `current/` had ever been promoted — only versioned staging dirs up to 0.134.1 — while the APK-bundled runtime (0.147.0, newer) was the one actually running via fallback. Whether that reflects an intentional "only promote if newer than bundled" gate or a promotion step that never fired hasn't been root-caused yet; treat "managed latest" as the mechanism's design intent, not a guarantee that `current/` is populated on every device |
| Gemini API in AI Pane / `@gemini` / `@team` / background agents | ✅ available when a Gemini API key is configured |
| OpenRouter in AI Pane / `@openrouter` (attended only — unattended runs never route through it) | ✅ available when an OpenRouter API key is configured; verified on-device up to the live endpoint (Settings field, mention routing, real HTTP auth errors surfaced) — a full streamed reply with a real key hasn't been exercised yet |
| Shelly companion presentation — AI Pane replies use “Shelly” as the default speaker instead of the raw provider name; an explicitly `@`-routed provider remains visible as a secondary tag, with conversational registration / confirmation copy | ✅ shipping; confirmed on-device 2026-08-15 |
| Shared Shelly conversation — default local-persona AI Panes share one thread via `COMPANION_CONVERSATION_KEY` / `resolveAiPaneStoreKey`; explicit external-provider panes retain independent per-pane history, with a system notice when a binding changes | ✅ shipping |
| Companion/global memory — confirmed “remember …” requests use `detectCompanionMemoryWrite` to write `_global` / `GLOBAL_MEMORY_SCOPE` notes recalled by Shelly and every background agent; explicit all-agent phrasing remains supported by `detectGlobalMemoryWrite` | ✅ shipping |
| Agent completion chat re-entry — scheduled and **Run Now** results are appended to the shared companion thread by `lib/agent-companion-notice.ts`, in addition to OS notifications and run history | ✅ **Run Now** confirmed on-device 2026-08-17; the scheduled (AlarmManager) path ships on the same tracker and code path but hasn't been independently observed firing live yet |
| AI Pane individual message deletion — long-press a message, confirm deletion, and `deleteMessage` removes that message from its resolved conversation | ✅ shipping |
| Background / autonomous agents — `@agent` registration, unattended AlarmManager execution (getForegroundService), run / next / last / missed-run visibility | ✅ wired; one unattended fire observed end-to-end on Z Fold6 (N=1, app cached at fire) — cross-OEM reliability not yet broadly tested |
| Agent social-post connectors — Bluesky, Discord, Slack, Telegram, Mastodon, Misskey, WordPress | ✅ Bluesky verified live end-to-end; the other six ship on the same code path and test coverage but haven't each been fired against a real account yet |
| Agent task-clarity detection — asks what the task actually is when a request is too vague, before asking about scheduling | ✅ shipping; confirmed on-device 2026-07-27 |
| LLM-Led Agent Registration (on by default, Settings → Agents) — the model drives multi-turn clarification in its own words instead of fixed prompts, cloud-provider-first with a local-model and fixed-prompt fallback chain, webhook/CLI proposals gated to literal copies of what you typed | ✅ shipping; on-device verified 2026-08-03, including the default-on flip firing with no flag toggled (Cerebras succeeded live, logged, no fallback needed) |
| LLM-Led Agent Registration — multi-step chain authoring (`steps`) — a conversational registration that turns out to need several ordered steps stays a real chain (same orchestration engine as deterministic registration) instead of collapsing into one prompt | ✅ shipping; on-device verified 2026-08-03 (a live 3-step registration produced a correctly-ordered "Multi-step (3 steps, each gated)" confirm summary). Per-step tool routing (naming Perplexity/local/Codex/Gemini for a specific step) and honoring that pin on a scheduled/unattended fire landed after that pass and are unit-tested only, not yet on-device verified |
| Sub-agent fan-out (`parallelGroup`) — branches receive an isolated pre-group context and aggregate results in declared order; unattended PlanSpec branches dispatch concurrently with a 3-branch semaphore and a locked shared capability budget | ✅ on-device verified 2026-08-17 (build 2237) via three real AlarmManager fires: branches actually ran and stayed context-isolated (a serial control step correctly saw all three branch outputs, branches never saw each other's), a declared 4th branch was severed to serial by the 3-branch cap, results aggregated in declared order rather than completion order, and per-branch API call timestamps landed within tens of ms of each other with total wall-clock time matching the parallel prediction, not the sum of branch durations. The locked shared capability budget specifically wasn't independently exercised (no budget contention occurred in these runs) — extensively tested at the tsc/Jest level, just not this one sub-claim on real hardware |
| Skill distillation — a successful run can be saved as a reusable, global skill recipe and recalled on a matching later task; a recipe that fails carries a corrective hint into its next use until a verified success clears it | ✅ shipping |
| First-party Skills catalog — browse downloadable skill recipes from the Sidebar, verify them, and import them through quarantine/review | ✅ shipping; availability depends on the published `skills-catalog-latest` release |
| Skill self-improvement — a resolved failure → success cycle deterministically promotes the caution into the skill body; attended runs ask for confirmation, while unattended runs auto-apply, notify, and offer one-tap revert | ✅ confirmed on-device on Fable5 across multiple rounds (versionCode 2179) |
| Persistent agent memory — write/recall facts across runs, secret-guarded to force local-only when a note contains a secret | ✅ shipping |
| User profile learning — locally observes command/agent-usage patterns for proactive agent suggestions and AI Pane personalization; can be disabled or reset in Settings → Agents; see [Privacy](#privacy) for what leaves the device | ✅ shipping; on-device verified 2026-08-17 (View/Edit Facts UI and per-fact deletion confirmed on Fable5) |
| X (Twitter) connector — OAuth 2.0 PKCE connect, regular posts, long-form Articles (draft → publish) | ✅ implemented, integration-tested; not yet fired against a live account with billing enabled. Regular posts are reachable from BOTH the attended and the unattended/scheduled (PlanSpec) execution path as of 2026-08-06 — Articles remain attended-only |
| Agent action Undo — for the narrow class of actions whose entire effect is a workspace file write (currently: `draft`), Shelly can run optimistically (auto-savepoint → run → offer a one-tap Undo on the result) instead of blocking on pre-approval; every other action type (network egress, notifications, cross-app automation, …) keeps the standard pre-approval gate, since a real `git revert` is the bar for "reversible," not "we could probably undo it" | ✅ shipping; on-device verified 2026-08-05 |
| Scouter widget RUN (widget-triggered agent start) | ✅ shipping; runs through the same unattended execution gates as a scheduled alarm fire. Cloud-API-backed agents fall back to Codex unless the opt-in **Autonomous Cloud** setting (off by default) allows the unattended cloud call — this is the credential policy working as designed, not a bug. On-device verified 2026-08-17 end-to-end (widget tap → real launcher-uid PendingIntent → agent run → draft written to disk); note the widget only lists an agent once it has a run artifact on disk (a generated `.sh` or PlanSpec file), so a freshly hand-placed agent JSON won't appear until the app has materialized it once |
| Scouter widget `@agent` registration (new-agent registration from ASK, voice input, opt-in no-confirm register) | ✅ shipping; confirmed on-device 2026-07-30 — ASK routes `@agent` text through the same AI Pane confirm flow as typing it directly; with **Widget No-Confirm Register** off it confirms normally, with it on it registers immediately and a notification confirms it; voice input populates the field without auto-submitting |
| Sidebar SSH Profiles (key-file auth, ~/.ssh/config import, tap-to-connect) | ✅ shipping |
| Sidebar Quick Launch / Worktrees (one-tap CLI shortcuts) | ✅ shipping for Codex |
| In-app Android APK updates (`android-latest/latest.json`, SHA-256 verification, Package Installer handoff) | ✅ shipping |
| In-app Codex runtime updates (`codex-runtime-latest/codex-runtime.json`, smoke-tested runtime promote / reset) | ✅ shipping |
| Cloud storage | 🚫 out of scope — use `rclone` from the terminal pane |
| App icon | ✅ shipping |
| Distribution channels (Play Store / F-Droid) | 🟡 GitHub Releases only for now; current Android release is the rolling `android-latest` build |

Full validation checklist: [`docs/superpowers/specs/2026-04-13-validation-checklist.md`](docs/superpowers/specs/2026-04-13-validation-checklist.md)

---

## Coming Soon

Parts of the app are written but not yet verified. These are on the short-term roadmap, not in the current build:

- **Play Store / F-Droid distribution** — the APK is published via GitHub Releases only; store submission flow not yet done
- **Cross-OEM autonomous-agent reliability** — unattended scheduled firing is observed on the Z Fold6 (N=1), but Android background limits vary by manufacturer (Samsung / Xiaomi / Oppo / OnePlus battery-freezers); broad cross-device reliability + a device health/permission checklist are not done yet
- **Snippet authoring UI** — the Command Palette shows the first 20 entries from your snippet store and dispatches them to the terminal, but the in-app create/import/edit flow was removed in an earlier cleanup pass. Snippets are stored in Android's AsyncStorage (`store/snippet-store.ts`), not a plain file — there is currently no supported way to bulk-add them outside the (removed) in-app UI.

---

## The Story

### I don't hand-write code.

I'm a Creative Director, not an engineer by training. Every line in this repo was generated by AI under my direction — through conversation with AI coding agents on a Samsung Galaxy Z Fold6, no desktop, no laptop — then reviewed, tested on-device, and shipped. Every architectural decision is mine. The keystrokes are not. What I bring is twenty years of product judgment about what belongs on a screen and what doesn't — and that turns out to be most of the job.

That's the origin story. It is deliberately **not** the trust story — "an AI wrote it" is a reason to hold the code to a *higher* verification standard, not a lower one. You're deciding whether to give this app shell execution, broad storage, and your API keys, so the honest answer to "why trust it?" is the discipline around the code, all of which is auditable in this repo:

- **On-device verification before "done."** Features aren't marked shipped until they've been observed working on real hardware, and single observations stay labeled as such — the N=1 caveats in this README's [Status](#status) table are that policy in public.
- **Tests that execute the real code.** The agent pipeline's regression tests run the actual generated scripts with real processes — real bash execution, real HTTP-failure surfaces — instead of hand-copied re-implementations that can silently drift from what ships.
- **Adversarial review before risky merges.** Native, OAuth, IPC, and security-boundary changes get an explicit second-agent review pass before they land; the signed-approval channel and the autonomous-agent execution gates went through dedicated security reviews.
- **An engineering ledger instead of vibes.** [`docs/superpowers/DEFERRED.md`](docs/superpowers/DEFERRED.md) is the single source of truth for what's shipped vs. flag-gated-off vs. known-broken, with reasons and priorities. When this README hedges, that's where the hedge comes from.
- **The agent stack is engineered to fail loudly and closed.** Unattended runs climb an escalation ladder across local and cloud backends (`lib/agent-escalation-ladder.ts`), a quality gate rejects completions that merely announce the work instead of doing it, and unattended actions that would need approval fail closed rather than running unreviewed.

The keyboard you see in the screenshots? I built that too. It's called [Nacre](https://github.com/RYOITABASHI/Nacre) — an Android IME written in Kotlin, also created entirely through AI conversation. I'm typing on it right now, inside Shelly, improving both apps simultaneously.

This is not a portfolio project. This is a tool I use every day to build things. If you find something that could be better, that's what the issue tracker is for.

### Why any of this exists

Mobile development never took off — not because phones lack computing power, but because the **input** and **interface** weren't designed for creation.

Chat apps (ChatGPT, Claude, Gemini) can *talk* about code, but they can't *run* it. Terminal emulators (Termux) can *run* anything, but they're hostile to anyone who isn't already a developer.

Shelly fills the gap. You type "make me a portfolio site" in the AI pane, and a real shell runs the commands, generates files, and shows you the results — right next to the terminal that produced them.

And once that machinery exists, the next step is obvious: let it run without you watching. Describe a recurring task once, and the phone does it on its own alarm — no laptop left running, no cloud runner subscription.

### Why every design decision is shaped like a question

Every feature in Shelly started as a frustration I had with existing tools:

- The cross-pane system comes from *"Why do I have to copy an error from one window and paste it into another?"*
- The native terminal comes from *"Why does the terminal die every time I switch apps?"*
- The Codex notification channels and Agent Chat's Approve/Deny bubbles come from *"An AI CLI is asking me to approve something in English. I don't know what it means."*
- The VoiceChain comes from *"I can't type on a phone keyboard fast enough to keep up with my ideas."*
- The layout system comes from *"Why can't I have a browser, a terminal, and an AI all on the same screen at the same time?"*
- The color theme presets come from *"Why do I have to choose between a usable UI and an aesthetically interesting one?"*

Every limitation became an innovation that engineers need just as much.

### Why native — the WebView pivot

Early versions used ttyd and a WebView. WebSocket connections dropped. Android's Phantom Process Killer terminated background processes. Every time you switched apps, the terminal was dead.

So I directed the AI to throw it all away and go native. Shelly now embeds a native terminal emulator — Kotlin code derived from Termux's own `terminal-emulator` library — connected to an app-owned PTY through a JNI C layer. No TCP terminal server. No WebSocket boundary. No ttyd process to drop.

For a React Native app this is an unusual architecture: an embedded native terminal emulator backed by an app-owned PTY via JNI `forkpty`, rather than a WebView or a socket bridge to an external terminal server.

### Who is this for?

- **People who want an agent on their own hardware** — scheduled, unattended tasks that run on your alarm, your keys, and your files, auditable down to the shell transcript
- **Vibe Coders** — Lovable / Bolt / Replit Agent, but on your phone with a real terminal underneath
- **Mobile-first developers** — Codex CLI users and anyone serious about CLI-first AI coding workflows who want a proper multi-pane IDE around real local terminals
- **Non-engineers with ideas** — Shelly translates everything. Dangerous operations are surfaced with explanations and approval steps before they run

---

## Architecture

### System Architecture

```mermaid
flowchart TB
  U["User on Android"] --> UI["Shelly UI\nReact Native panes"]

  subgraph P["Pane runtime"]
    TP["Terminal pane\nCodex foreground CLI"]
    AP["AI pane\nAPI and local providers"]
    BP["Browser pane\nDocs and localhost"]
    PP["Preview pane\nCode, Markdown, images"]
  end

  UI --> TP
  UI --> AP
  UI --> BP
  UI --> PP

  subgraph N["Native Android bridge"]
    KT["Expo Kotlin modules"]
    JNI["JNI C layer\nforkpty and exec"]
    TV["Terminal renderer\nTermux-derived emulator"]
  end

  TP --> KT --> JNI
  JNI --> SH["App-owned shell\nbash, git, node, python"]
  JNI --> WR["exec wrapper\nlinker64 and LD_PRELOAD"]
  SH --> CX["Codex runtime\nunified codex_tui"]
  TP --> TV

  subgraph A["Agent context"]
    LOG["Terminal transcript"]
    CTX["Context builder\nredaction and compaction"]
    ACT["User-approved actions\nrun command or apply diff"]
  end

  TP --> LOG --> CTX --> AP
  AP --> ACT --> TP

  subgraph R["Release pipeline"]
    CI["GitHub Actions\nlint, typecheck, tests, APK build"]
    APK["android-latest\nAPK and latest.json"]
    CRT["codex-runtime-latest\nruntime tarball and manifest"]
  end

  CI --> APK
  CI --> CRT
  APK --> UP["Updates UI\nSHA-256 verify, installer handoff"]
  CRT --> RU["Runtime updater\nverify, smoke-test, promote, reset"]
  UP --> UI
  RU --> CX
```

Shelly's core is the connection between three systems that are usually
separate: a native Android terminal runtime, a foreground Codex CLI, and
context-aware AI panes. The terminal is not a WebView or remote bridge; it is
an app-owned PTY read by Kotlin through JNI. The update system is also split:
APK releases update the app and native payload, while the Codex runtime lane can
move faster after SHA-256 verification and smoke tests.

### Screen Layout

```mermaid
block-beta
  columns 5
  AB["Agent Bar — layout / add pane / search / settings"]:5
  SB["Sidebar\nRepos, File Tree\nTasks, Device"]:1 TP["Terminal Pane\n$ npm run build\nError: missing..."]:2 AP["AI Pane\n'Fix the error →'\n[Accept hunk]"]:2
  space:1 BP["Browser Pane\nlocalhost:3000\nYouTube / GitHub"]:2 MP["Preview Pane\nCode / MD / Image"]:2
  CB["Context Bar — ~/Shelly  main  ↑2  Native"]:5

  style AB fill:#1a1a1a,stroke:#00D4AA,color:#00D4AA
  style SB fill:#111,stroke:#333,color:#ccc
  style TP fill:#0a0a0a,stroke:#333,color:#0f0
  style AP fill:#0a0a0a,stroke:#D4A574,color:#D4A574
  style BP fill:#0a0a0a,stroke:#333,color:#61AFEF
  style MP fill:#0a0a0a,stroke:#333,color:#ccc
  style CB fill:#1a1a1a,stroke:#333,color:#666
```

### Cross-Pane Intelligence

```mermaid
flowchart LR
  subgraph AI Pane
    U["User: 'fix the error'"]
    R["AI: missing import path..."]
    RUN["▶ Run fix"]
  end
  subgraph Terminal Pane
    CMD["$ npm run build"]
    ERR["Error: Cannot find './utils'"]
    FIX["$ mv util.ts utils.ts"]
  end
  ERR -- "transcript injected" --> R
  RUN -- "execute" --> FIX
  U --> R
```

AI reads Terminal. Terminal executes AI. The user just talks.

### AI Edit Golden Path

```mermaid
flowchart LR
  FT["FileTree tap"] --> OF["openFile()"]
  OF -->|*.md| MP["Markdown pane"]
  OF -->|other| CT["Preview → Code tab"]
  CT -->|AI button| SE["stageAiEdit()"]
  SE --> AIP["AI pane w/ file in context"]
  AIP --> DIFF["assistant unified diff"]
  DIFF --> IND["InlineDiff — per-hunk Accept"]
  IND --> ASD["acceptStagedDiff() (strict → fuzzy)"]
  ASD --> WF["writeFileNative() on disk"]
  WF --> RELOAD["Preview Code tab auto-reload"]
```

Each step is a real module: `lib/open-file.ts`, `lib/ai-edit.ts`, `components/panes/InlineDiff.tsx`, `hooks/use-native-exec.ts`.

### Native PTY — JNI forkpty

```mermaid
flowchart TB
  JS["React Native JS"] -- "Expo Module call" --> KT["Kotlin NativeModule"]
  KT -- "JNI" --> PTY["shelly-pty.c (forkpty)"]
  KT -- "JNI" --> EXEC["shelly-exec.c (fork+exec+pipe)"]
  PTY -- "ptmx / setsid" --> SH["shell process\nbash / zsh / sh"]
  PTY -- "read/write fd" --> TV["ShellyTerminalView.kt\nKotlin renderer"]
  TV --> VIEW["Android View\nCanvas path / optional GLSurfaceView path"]
```

Two JNI entry points for two different needs. **`shelly-pty.c`** owns interactive shells: it opens `/dev/ptmx`, calls `forkpty`-equivalent logic (`grantpt` + `unlockpt` + `setsid` + `execve` via `/system/bin/linker64`), and hands the master fd back to Kotlin for the terminal view to read. **`shelly-exec.c`** owns programmatic one-shots (`git status`, `ls`, file I/O, AI dispatch helpers): it does a vanilla `fork` + `exec` + `pipe` and returns `{exitCode, stdout, stderr}` synchronously, with an EAGAIN-aware read loop that distinguishes spurious select wakes from genuine EOF (bug #70 fix).

No TCP. No socket terminal server. No separate PTY helper daemon. Shells still run as normal forked child processes, while the PTY master fd is owned by the app and read directly from Kotlin via JNI.

### Runtime Theme Swap

```mermaid
flowchart LR
  U["Settings → Font: Shelly"] --> S["settings-store.uiFont"]
  S --> E["RootLayout effect"]
  E --> AP["applyThemePreset()"]
  AP --> M["Object.assign(colors, palette)"]
  AP --> P["patchTextRenderOnce()"]
  AP --> V["theme-version bump"]
  V --> R["ShellLayout key-remount"]
  R --> UI["all Text re-renders with new fontFamily"]
  PTY["native PTY"] -. unaffected .- R
```

The `colors` object is mutable and keeps the same identity, so every `import { colors as C }` consumer sees the new values without a code change. The Text monkey-patch handles font changes. The theme-version key-remount forces all rendered Text through the patch. PTY lives outside JS, so it's untouched.

---

## Release Integrity

These are intentionally operational rather than synthetic — they show the cost
of shipping a real Android-native toolchain, not a thin client. The exact
per-build numbers (`versionCode`, commit, asset name, byte size, SHA-256) live
in the release manifests, which the in-app updater reads directly, so they never
drift out of sync with this page:

- **Android APK** — [`android-latest/latest.json`](https://github.com/RYOITABASHI/Shelly/releases/download/android-latest/latest.json): `versionCode`, `versionName`, `gitSha`, `apkAssetName`, `apkSizeBytes`, `sha256`.
- **Codex runtime** — [`codex-runtime-latest/codex-runtime.json`](https://github.com/RYOITABASHI/Shelly/releases/download/codex-runtime-latest/codex-runtime.json): `codexVersion`, asset name, `sha256`.

| What | Shape | Why it costs that |
|---|---|---|
| APK size | ~800 MB | bundles bash / Node.js / Python 3 / git / ripgrep / … plus the Codex runtime as real binaries, not shims |
| Codex runtime | shipped + managed on its own lane (~160 MB) | promoted separately so it can move faster than the APK |
| Release verification | SHA-256 checked before the installer handoff | the updater refuses an APK whose hash doesn't match the manifest |
| Runtime verification | SHA-256 + `codex_tui --version` / `codex_tui exec --help` smoke tests | a runtime candidate is only promoted after it actually runs |
| CI per release | lint · typecheck · unit tests · native release build · signed APK + manifest publish | every release artifact is built and verified by GitHub Actions |

The point: a large APK, a separately managed Codex runtime, and a CI pipeline
that builds native release artifacts and generates verified update manifests
before anything reaches a device. The exact, current numbers live in the
manifests linked above rather than being copied here where they would go stale.

---

## Built With

| Layer | Technology |
|-------|-----------|
| Framework | Expo 54 / React Native 0.81 |
| Language | TypeScript (strict) + Kotlin + C |
| UI | NativeWind (TailwindCSS 3) |
| State | Zustand |
| Navigation | expo-router v6 |
| Terminal | Native emulator (Kotlin, Termux-derived) + JNI forkpty (C, app-owned PTY) |
| Fonts | JetBrains Mono for app/terminal readability, with bundled legacy pixel fonts retained for compatibility |
| i18n | expo-localization + Zustand (900+ keys, EN/JA) |

---

## Contributing

This started as a personal tool. Community contributions are shaping it into a true OSS project.

**Looking for a first contribution?** Check the [`good first issue`](https://github.com/RYOITABASHI/Shelly/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Unit tests are already wired through Jest; focused tests around routing, update manifests, command safety, and native bridge helpers are especially useful.

**Key files to explore:**

- `lib/input-router.ts` — the brain; classifies natural language into shell commands, AI requests, or `@mentions`
- `lib/command-safety.ts` — risk assessment engine; blocks dangerous commands with 5 severity levels
- `lib/auto-savepoint.ts` — watches for file changes and auto-commits; the "game save" system
- `lib/ai-edit.ts` — stage / apply / fuzzy-re-anchor unified diffs against the staged file
- `lib/theme-presets.ts` — palette + runtime preset swap + Text.render monkey-patch
- `components/panes/InlineDiff.tsx` — per-hunk Accept / Reject with write-back
- `modules/terminal-view/android/.../ShellyTerminalView.kt` — the native terminal renderer (Kotlin + Android Canvas)
- `modules/terminal-emulator/android/src/main/jni/shelly-pty.c` — the JNI forkpty layer

If you find something that could be better — a cleaner pattern, a performance optimization, a bug fix — **please open an issue or PR**. That's exactly why this is open source.

Read the contributing guide: **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## Vision

In two years, phones won't just run AI chat — they'll run agents that work while you're not looking. The hardware is already here — 40+ TOPS NPUs, 12 GB of RAM, multi-billion-parameter models running on-device at usable speeds — and the missing piece was never compute. It was an interface that could hold a real terminal, a real toolchain, and a real scheduler in one place you already carry.

When local-LLM inference doesn't have to phone home and a scheduled task can wake the phone itself, you get agents that work on your own keys, from places no cloud runner reaches — no laptop left on, no server to pay for, no wifi required until the result needs to go somewhere. The first person to ship real, unattended work from a plane without wifi will be using something like this.

Shelly was built for that future, agent-first: the escalation ladder across local and cloud backends is already wired, the scheduler and quality gates are already hardening under real on-device testing, and underneath all of it is the native terminal — the same environment a scheduled agent uses is the one you can open and drive by hand.

The question isn't whether unattended, on-device AI will happen. It's who builds the tools for it first, and whether those tools are honest about what's actually been verified along the way.

---

## About the Creator

**RYO ITABASHI** — Creative Director at [Rebuild Factoryz](https://rebuildfactoryz.com/). Branding and design are my profession. Code is not. See [The Story](#the-story) above for how that actually works and why it doesn't lower the bar for what ships.

The keyboard in the screenshots is **Nacre** — a split-layout Android IME I built (also through AI) to solve the input problem on mobile. Shelly handles the interface. Nacre handles the input. Together, they make phone-only development actually possible.

**Both were developed entirely on a Samsung Galaxy Z Fold6, without ever touching a desktop computer.**

---

## Support

Shelly is a solo, self-funded project. If it saves you a Termux setup or makes phone development viable for you, a coffee goes a long way. (A Z Fold8 also works — purely for testing purposes, obviously.)

<p align="center">
  <a href="https://buymeacoffee.com/ryo1221"><img alt="Buy Me a Coffee" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black"></a>
</p>

You can also support the project by:

- ⭐ Starring this repo
- 🐛 [Reporting bugs](https://github.com/RYOITABASHI/Shelly/issues)
- 🔧 Sending a PR — see [Contributing](#contributing)
- 💬 Sharing what you built with Shelly

GitHub Sponsors is also enabled via the "Sponsor" button at the top of this repo.

---

## Known Limitations

Shelly is pre-release Android software. Here's what we know isn't perfect yet.

- **No offline mode by default** — Cloud AI features require an internet connection. Local LLM via `@local` works offline with the bundled catalog and llama.cpp / llama-server controls; Qwen3.5-2B Q4_K_M is the recommended on-device default, Qwen3 1.7B / Qwen3.5 0.8B are lighter options, and 4B/9B models are reserved for short quality checks.
- **Additional tools beyond the bundle** — Shelly ships with bash, Node.js, Python 3, git, curl, ssh, sqlite3, tmux, vim, less, jq, make, and the GNU coreutils set. Notable tools **not** bundled include `busybox`, `watch` (procps-ng), `htop`, and most network daemons. If you need them, install Termux alongside Shelly or open a PR adding the binary to `modules/terminal-emulator/android/src/main/jniLibs/`.
- **`watch` is broken in the current release** — the bundled `watch` binary fails to invoke subcommands under Shelly's bionic environment and the watched command never actually runs, even though the header refreshes. Workaround: `while true; do clear; <cmd>; sleep 1; done`. Tracked as bug #34.
- **`busybox` is not bundled** — `busybox httpd`, `busybox nc`, and other applets return `command not found`. Use the standalone equivalents where available (`curl`, `nc` from the bundle, `python3 -m http.server`), or bundle `busybox-static` yourself. Tracked as bug #35.
- **`@team` routes to multiple APIs simultaneously** — this consumes credits on every provider at once, with no confirmation step before it runs. Use it deliberately.
- **Multi-hunk Accept against a partially-edited file** — per-hunk Accept uses fuzzy re-anchoring so successive hunks land, but if the AI's diff references context that has already been edited to something else, the hunk will be rejected with a toast asking you to regenerate.
- **Terminal font mismatch** — if a saved legacy theme looks wrong after upgrading, switch Settings → Display → Theme to one of the three color presets.
- **Codex CLI runs through Shelly-managed runtime routing** — Shelly prefers a healthy app-data runtime under `~/.shelly-runtime/codex/current`, then falls back to the APK-bundled runtime. If `codex --version` fails, run `shelly-doctor`, `shelly-update-clis codex --check-only`, or use **Settings → Updates → Repair Codex / Reset**.
- **Codex login uses an in-app device-code OAuth flow** — run bare `codex` or `codex-login --open` from any terminal pane. Shelly validates `~/.codex/auth.json`; if it is missing or invalid, Shelly opens the OpenAI verification page in the in-app Browser Pane, writes `~/.codex/auth.json` (mode `0600`) on success, then launches the normal Codex TUI. No OpenAI API key is required; this rides your ChatGPT Plus/Pro/Business/Enterprise subscription. The flow has a 15-minute device-code timeout — re-run if it expires. Verify with `shelly-doctor` (it reports whether `~/.codex/auth.json` is present).
- **`/sdcard` access requires MANAGE_EXTERNAL_STORAGE** — Android 11+ Scoped Storage blocks direct `open(2)` on `/sdcard` paths without this permission. Shelly asks for it on first launch; if you deny it, `source /sdcard/Download/foo.sh` will fail with `Permission denied`. Re-grant from system Settings → Apps → Shelly → Permissions → Files and media → Allow management of all files.
- **Gemini is API-only** — Gemini is available as an API provider (AI Pane, `@gemini`, `@team`, background agents) with a configured key. There is no bundled Gemini CLI and no interactive `gemini` login flow in this release.
- **Very large or binary pastes** — the paste path is a one-shot write into the PTY. Multi-megabyte clipboard payloads will take noticeable time and may stall the UI briefly; binary content (non-UTF-8 bytes, null characters) is not a supported transport mechanism and may corrupt the shell buffer. Use `curl -O` / `scp` / `/sdcard/Download/` drop-point for binary transfer.
- **Fold/rotate/split-screen during an active CLI session** — Shelly survives layout changes, but terminal state is not always persisted across an Android Activity recreate. Save or commit work before aggressive multitasking (fold ↔ unfold rapidly, split-screen drag while a foreground job is running). AI CLI streams specifically are best completed or interrupted (Ctrl-C) before rotating.

## Permissions

Shelly is a terminal app that runs shell commands, edits files, calls AI APIs, and stores credentials. That combination requires more Android permissions than a typical app. Here's why each exists, what happens if you deny it, and what alternatives exist.

| Permission | Why | If denied | Alternative |
|---|---|---|---|
| **MANAGE_EXTERNAL_STORAGE** | Lets the terminal read scripts in `/sdcard/Download` and other shared directories. The standard "adb push a file, source it from the shell" workflow requires this. | `source /sdcard/Download/*.sh` fails with `Permission denied`. Everything inside `$HOME` (the app's private data dir) still works. | SAF-based per-file import UI is planned for Play Store distribution (DEFERRED P3). For now, grant from Settings → Apps → Shelly → Permissions → Files and media → Allow management of all files. |
| **INTERNET** | AI API calls (Gemini, Groq, Perplexity, Cerebras, OpenRouter, OpenAI-compatible/local servers) and CLI account/device-auth flows. Also used by runtime checks for CLI updates. | Cloud AI features and login/update flows stop working. Local LLM (`@local`) and all terminal features still work. | Use `@local` for fully on-device inference. |
| **POST_NOTIFICATIONS** | CLI completion notifications (long-running commands surface a system notification). | You won't see the "command finished" toast. | — |
| **FOREGROUND_SERVICE** | Keeps the terminal alive when the app is backgrounded. | Shell processes may be killed by the OS when you switch apps. | — |
| **RECORD_AUDIO** | Voice input (VoiceChat + VoiceChain). | Voice features are disabled. Typing works normally. | — |

Shelly is distributed via GitHub Releases for now, not Google Play or F-Droid yet. The `MANAGE_EXTERNAL_STORAGE` permission would require a Play Store all-files-access audit, which is why Play Store distribution is deferred until a SAF-based import path is available as a fallback.

---

## Security

Shelly runs commands on your device. The safety system is a best-effort layer, not a guarantee.

- **Security model** — Shelly is a normal Android app sandbox, not a hardened VM. Terminal commands and approved AI-agent actions run as the app uid and can read/write whatever the app can access.
- **Command safety is regex-based** — The 5-level risk assessment uses pattern matching. It catches common dangerous patterns (`rm -rf /`, `dd if=`, etc.) but is not a sandbox. Treat it as a seatbelt, not a firewall.
- **APK distribution uses CI release APKs** — GitHub Actions builds release APKs and publishes them to the rolling `android-latest` release. For production-grade signing guarantees, clone the repo and build with your own keystore. See [Build from source](#build-from-source).
- **Autonomous agents are gated, not free-roaming** — AI Pane and background agents use explicit API providers, not hidden subscription reuse. Shell-command execution and risky actions still go through Shelly's approval / command-safety path; when an agent runs unattended and an action needs approval, it fails closed rather than running unreviewed. There is no hidden subscription worker.
- **API keys are stored in SecureStore** — Keys are never written to logs or debug output. SecureStore uses Android Keystore encryption on supported devices.
- **`shelly-doctor`** — reports shell/native binary presence, bundled Codex binaries, JS dispatcher, local LLM endpoints, and whether `~/.codex/auth.json` exists. Run it when something feels broken.
- **Log redaction** — Shelly redacts common API key and token patterns before writing app debug logs. This is a guardrail, not permission to paste secrets into prompts or terminal output.
- **Convenience ≠ security** — Shelly combines shell execution, AI dispatch, file editing, API key storage, and broad storage access in a single app. This is powerful but means a compromise of any one layer could affect the others. Review the source, build from your own keystore, and treat Shelly as a development tool — not as a production server environment.

See [SECURITY.md](./SECURITY.md) for the threat model and private vulnerability reporting process.

---

## Privacy

- **User profile learning** — Shelly observes your command patterns and AI usage to personalize suggestions (`lib/user-profile.ts`). This data stays on-device in AsyncStorage. When Profile Learning is enabled and you send a message to a cloud AI, the profile context is included in the API request to improve response quality. Settings → Agents includes a Profile Learning toggle and a Reset Profile action.
- **Persistent agent memory** — `MEMORY_ENABLED` is `true`: per-agent recall, writes, and lists use MEMORY-001 by default. Its JSON records are encrypted at rest with AES-256-GCM and a device SecureStore-backed key, then fall back to the older G2 markdown/Obsidian path if the new store fails; shared `_global` writes still go directly through G2. The project has not yet verified on a real device that no legacy plaintext files remain or that uninstall makes old records unrecoverable. The `touchesPii` classifier signal is produced but does not yet gate model eligibility, so do not assume non-secret sensitive prose is kept away from cloud routing.
- **No telemetry** — Shelly does not phone home: no analytics, no crash reporting, no usage tracking. Network traffic comes only from things you initiate — your AI API calls, Codex auth, update checks/downloads, Browser Pane use, and any local/API endpoints you configure.
- **Local LLM mode** — For fully private usage, configure a local GGUF model through llama.cpp. Qwen3.5-2B Q4_K_M is the recommended default, Qwen3 1.7B and Qwen3.5 0.8B are available for lower memory pressure, and 4B/9B models are available for short quality checks. All processing stays on-device.

---

## License

[GPLv3](./LICENSE) — Copyright (c) 2026 RYO ITABASHI

This project includes code derived from [Termux](https://github.com/termux/termux-app) (GPLv3), specifically the terminal emulator rendering layer.
