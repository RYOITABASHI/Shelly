<p align="center">
  <img src="docs/images/shelly-logo.png" alt="Shelly" width="120">
</p>

<h1 align="center">Shelly</h1>

<h3 align="center">
  <code>Terminal + AI + Browser + Markdown + Preview</code><br>
  <sub>A mobile IDE where the AI reads your terminal. No copy-paste, no tab-switching, no desktop.</sub>
</h3>

<p align="center">
  <a href="https://github.com/RYOITABASHI/Shelly/actions/workflows/build-android.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/RYOITABASHI/Shelly/build-android.yml?branch=main&style=flat-square&label=android%20build"></a>
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-blue?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android-00D4AA?style=flat-square&logo=android&logoColor=white">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Claude%20Code-D4A574?style=flat-square">
  <img alt="Expo" src="https://img.shields.io/badge/Expo%2054-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
</p>

<p align="center">
  <img src="docs/images/hero.jpg" alt="Shelly — AI reads your terminal error and suggests a fix with COPY and INSERT buttons" width="800">
</p>

<p align="center">
  <a href="#quick-start"><b>Quick Start</b></a> &nbsp;&middot;&nbsp;
  <a href="#the-copy-paste-problem"><b>Why Shelly?</b></a> &nbsp;&middot;&nbsp;
  <a href="#features"><b>Features</b></a> &nbsp;&middot;&nbsp;
  <a href="#architecture"><b>Architecture</b></a> &nbsp;&middot;&nbsp;
  <a href="#status"><b>Status</b></a> &nbsp;&middot;&nbsp;
  <a href="#contributing"><b>Contributing</b></a>
</p>


<br>

---

## The Copy-Paste Problem

You're running an AI coding tool in a terminal — Claude Code, Codex, Gemini, whatever. It throws an error. You copy it. You switch to ChatGPT. You paste. You ask "what went wrong?" You read the answer. You copy the fix. You switch back. You paste. You run it.

**Seven steps. Every single time.**

This is the daily workflow of every developer using CLI-based AI tools. The terminal and the AI live in different worlds, and *you* are the copy-paste bridge between them.

**Shelly puts the terminal and the AI side by side. The AI reads your terminal output automatically.**

Say **"fix the error on the right"**. Shelly reads the terminal output, explains the error, and generates an executable command. Tap **[Run]** and the fix lands directly in the Terminal pane.

No copy. No paste. No tab switching. Zero friction.

**Three levels of value:**

- **Single pane:** a native terminal that is faster, smarter, and more usable than Termux alone — with inline content blocks, autocomplete, syntax highlighting, and clickable errors.
- **Split panes:** terminal + AI side by side — the AI reads what the terminal shows and executes fixes with one tap. No copy-paste bridge needed.
- **Full layout:** sidebar + up to 4 live panes + agent bar — a mobile IDE. Browse docs in the browser pane, preview code or markdown on the right, run agents in the background, and keep your terminal front and center.

---

## Quick Start

Download the latest APK from [**GitHub Releases**](https://github.com/RYOITABASHI/Shelly/releases), or build from source:

```bash
git clone https://github.com/RYOITABASHI/Shelly.git && cd Shelly
pnpm install && pnpm android
```

> **Requirements:** Android device. For building from source: Node.js 22+, pnpm, Android NDK r27+. Expo Go is not supported — Shelly uses native Kotlin/C modules.
>
> Termux is not required. Shelly ships with bash, Node.js, Python 3, git, curl, sqlite3, tmux, vim, less, jq, make, and ripgrep. For tools beyond the bundled set, Termux can be used alongside Shelly.

On first launch Shelly asks for **All files access** so the terminal can read scripts in `/sdcard/Download` and anywhere else on your phone. Tap **Allow** and you're done — `source /sdcard/Download/foo.sh` just works. (Shelly is distributed via GitHub Releases and F-Droid, not Google Play, so this permission is fine here.)

After that, open **Settings → API Keys** (or run `shelly config` from the terminal pane) to paste your Claude / Gemini / Cerebras / Groq / Perplexity keys. Keys are stored in `expo-secure-store` and never written to logs. The terminal is ready in under 5 minutes.

---

## Flagship Runtime

Shelly's headline advantage is simple: it keeps Claude Code and Codex current on-device and launches them inside the same native shell as your files.

If Claude Code stopped working in Termux, proot, or another Android terminal setup, Shelly gives you a maintained on-device environment for running the latest AI coding CLIs.

No fragile terminal stack. No WebView terminal crashes. No copy-paste-driven workflow.

- **Managed updates** — the app downloads the latest CLI release, verifies it, smoke-tests it on-device, and hot-swaps it without an APK rebuild.
- **Real execution path** — the CLIs run through Shelly's native terminal stack, not a remote bridge.
- **Visible state** — the app can show recent terminal logs, so version drift and startup failures are easier to debug on the device itself.

This is the part that makes Shelly more than a terminal skin. It is the reason the app can ship fast-moving CLI tools on Android without turning the user into the update mechanism.

---

## How is Shelly different?

Termux gives you a terminal but no AI. ChatGPT gives you AI but no terminal. Replit runs in the cloud. Claude Code on desktop is desktop-only. To our knowledge, Shelly is the only tool that puts a native terminal and multi-agent AI side by side on your phone — with a browser pane, markdown viewer, code preview, sidebar, and agent bar all in one screen — and keeps Claude Code and Codex current on-device so they run in the same shell as your files.

---

## Features

> Everything listed in this section is working in the current build. Anything not yet shipped is listed under [Coming Soon](#coming-soon) further down.

### Highlights

| | |
|---|---|
| **Cross-pane intelligence** | Say "fix the error." AI reads your terminal, suggests a fix, one tap to run. Zero copy-paste. |
| **AI Edit golden path** | Tap a file in the sidebar → preview it → hit `[✨ AI]` → describe the change → accept per hunk → the file is rewritten on disk, the preview reloads automatically. |
| **Native PTY (JNI forkpty)** | Kotlin + C, same-process, zero IPC. The only React Native app we know of with an embedded native terminal. |
| **Batteries included** | bash, Node.js, Python 3, git, curl, sqlite3, tmux, vim, ripgrep, jq ship inside the APK. Termux not required. |
| **5 pane types** | Terminal, AI, Browser (+ background audio), Markdown, Preview. Split up to 4 live panes freely. |
| **Multi-agent AI** | Claude Code, Gemini, Cerebras, Groq, Perplexity, Codex, Local LLM. Auto-routed or `@mention`. |
| **Latest Claude Code + Codex on Android** | The only Android app that keeps claude-code 2.1.113+ and codex-termux current on-device via a Shelly-managed runtime. No proot, no root. APK auto-bundles the newest release via nightly CI. |
| **Shelly theme preset** | Mock-faithful teal-on-black palette with Silkscreen pixel font. Runtime swap — your shell survives the switch. |
| **Voice input** | Speak your commands or AI prompts. VoiceChain ties speech to the same input router the keyboard uses. |
| **CRT mode** | Scanlines + phosphor green + vignette. Retro 8-bit sounds. Pixel fonts. Just for fun. |

<details>
<summary><strong>Layout System</strong></summary>

- **Single-screen layout** — AgentBar (top) + Sidebar (left, collapsible) + PaneContainer (center) + ContextBar (bottom)
- **5 pane types** — Terminal (native PTY), AI (streaming + context injection), Browser (WebView + bookmarks + background audio), Markdown (viewer), Preview (Code / Image / PDF / CSV / Markdown renderers)
- **Recursive binary split tree** — any leaf can split horizontally or vertically, up to 4 live panes; drag the accent-green grip to resize, double-tap it to restore 50/50
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
- **Real-time terminal awareness** — AI pane snapshots the terminal transcript on dispatch so the model sees what you just saw
- **CLI Co-Pilot** — in-flight translation of output, approval prompt explanations, session summaries
- **Approval Proxy** — terminal `[Y/n]` prompts are lifted into chat-style `Approve / Deny / Ask AI` buttons so you never type blind 'Y'
- **Error Summary** — detected errors surface as persistent chat bubbles with `[Suggest Fix]`
- **Auto-savepoint** — every edit is auto-committed to a hidden git index so you can revert to any point with one tap
- **Pre-commit secret scan** — API keys, private keys, and other secrets are blocked before they land in a savepoint commit

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

- **Fig-style autocomplete** — top-level commands with subcommand and flag completion, rendered as an inline popup
- **Syntax highlighting** — terminal output colorized by content type
- **Clickable paths and errors** — tap a file path or stack trace line to jump to it
- **Inline content blocks** — JSON, markdown, images, and tables rendered inline inside the terminal output (Command Blocks)
- **CLI notifications** — long-running commands surface a system notification when they complete
- **SmartKeyBar** — 5 context-adaptive key sets (Default / Vim / Git / REPL / Navigate), swipe to switch
- **Immortal sessions** — tmux keeps your shell alive when the app is backgrounded; resume any session by name
- **Japanese input in terminal** — compose CJK characters directly in the terminal pane
- **Silkscreen-rendered glyphs** — native Kotlin terminal view renders the PTY grid in the same Silkscreen font as the rest of the UI
- **Atomic paste** — all paste paths converge on `TerminalEmulator.paste()`, which wraps payloads in bracketed-paste markers (`\e[200~..\e[201~`) unconditionally. IME multi-line or ≥16-char commits, middle-click mouse paste, and the CommandKeyBar **Paste** key all reach the same normalizer; multi-line and complex one-liners arrive as one event so readline executes only the trailing newline.

</details>

<details>
<summary><strong>AI Pane</strong></summary>

- **Multi-agent routing** — the router picks the best AI for the task; override with `@mention`
- **@mention** — `@claude`, `@gemini`, `@codex`, `@cerebras`, `@groq`, `@perplexity`, `@local`, `@team`, `@plan`, `@arena`, `@actions`
- **Terminal context injection** — the AI always has access to the current terminal transcript without you pasting anything
- **InlineDiff with per-hunk write-back** — see above
- **Voice input** — long-press the mic in the terminal action bar to open VoiceChat; speech → transcription → AI → TTS response
- **Arena Mode** — same prompt, two AIs, blind comparison; vote, then reveal
- **Local LLM support** — point Shelly at a running llama.cpp / llama-server and route via `@local` for fully on-device inference *(server must be started manually; guided setup wizard is planned)*

</details>

<details>
<summary><strong>Browser Pane</strong></summary>

- **Full WebView** — navigate any URL inside a pane; keep docs open next to your terminal
- **Bookmarks** — save and organize URLs; preset icons for YouTube, X, GitHub, and `localhost:*`
- **Background audio** — audio keeps playing when you switch panes
- **Link capture** — share a URL to Shelly from any Android app; it opens in the browser pane
- **Desktop UA toggle** — `📱` / `🖥` button in the URL row swaps the user agent so desktop-only sites behave
- **Video fullscreen** — six detection paths (W3C / WebKit / video element / monkey-patched APIs) catch YouTube-style fullscreen and maximize the pane, hiding the system nav bar

</details>

<details>
<summary><strong>File Tree</strong></summary>

- **Active-repo file list** — `ls -1pa` listing for the current working directory with per-extension icon coloring (`.tsx` sky, `.ts` blue, `.json` amber, `README.md` red, …)
- **Search** — incremental filter over the current directory
- **Open actions** — tap a Markdown file to open the Markdown pane, tap anything else to open the Preview pane's Code tab
- **Create / Rename / Delete** — `+` file and `+` folder buttons next to the search field; long-press a row for `Rename / Copy path / Delete`; modals use Silkscreen and the Shelly palette
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

- **Repositories** — list of bound repo paths; tap to switch; the active repo shows an amber badge with the number of uncommitted files, polled every 20 seconds from `git status --porcelain`
- **File Tree** — see above; embedded as a section so it flexes with the sidebar height
- **Tasks** — recent background-agent runs with duration and status
- **Device** — quick-access folders (`~`, `/sdcard/Download`, …) that re-bind the file tree in one tap
- **Ports** — every 15 seconds Shelly reads `/proc/net/tcp` and `/proc/net/tcp6` directly in-process (JNI fopen) and lists each loopback / wildcard listener; tap a row to open `http://localhost:<port>` in the Browser pane. Well-known ports get friendly labels (`:3000 NEXT.JS`, `:5173 VITE`, `:8081 EXPO`, `:8888 JUPYTER`, …).
- **Profiles** — saved SSH connections. Tap to insert `ssh -i KEY user@host -p PORT` into the active terminal pane; long-press to edit or delete; `Import from ~/.ssh/config` bulk-adds hosts. Key-file auth only — no passwords or passphrases are persisted.

> **Cloud storage?** Shelly deliberately doesn't ship a Google Drive / Dropbox / OneDrive UI. A terminal app should lean on the tools that already solve this — install [`rclone`](https://rclone.org) from your package manager, run `rclone config` once, and mount or sync any of 40+ cloud backends from the terminal pane.

</details>

<details>
<summary><strong>Command Palette</strong></summary>

Opens from the search icon in the top bar (or from the AgentBar's git badge). Fuzzy search across every registered action, plus a persistent **Recent** list of the last five you ran.

Currently registered:

- **Tabs** — Projects / Chat / Terminal / Settings
- **Terminal** — Clear / New session / Restore tmux / Tmux attach
- **Git** — Status / Diff / Log / Add all / Commit / Push / Pull --rebase *(routed through the active terminal pane's `pendingCommand` channel)*
- **Panes** — Add Terminal / AI / Browser / Markdown / Preview
- **Layouts** — Single Terminal / Terminal + AI / Terminal + Browser / 3-Way Triple
- **Font presets** — Shelly / Silk / 8bit / Mono
- **Cosmetics** — CRT toggle
- **Voice** — Open dialogue (VoiceChat modal)
- **Snippets** — first 20 entries from your snippet store, each dispatches to the terminal
- **Package Manager** — bundled tools status

</details>

<details>
<summary><strong>Theme &amp; Fonts</strong></summary>

- **"Shelly" preset** — new default. Mock-faithful palette with 8 neon accents (teal / green / blue / sky / purple / pink / amber / red) on a `#0A0A0A` background. Paired with Silkscreen.
- **Other presets** — Silkscreen (previous greener palette), 8bit (PressStart2P), Mono (system monospace), plus eleven classic editor palettes: **Dracula**, **Nord**, **Gruvbox**, **Tokyo Night**, **Catppuccin Mocha**, **Rose Pine**, **Kanagawa**, **Everforest**, **One Dark**, **Blackline** (pure black, low-distraction), and **Modal** (high-contrast modal ui theme). Switch from Settings → Display → Theme or the Command Palette.
- **Runtime swap** — presets are swapped by mutating the live `colors` object in place (identity preserved) and bumping a theme-version store that key-remounts the shell layout. PTY sessions survive the switch — your vim stays open.
- **Single-weight rendering** — every Text is forced through Silkscreen Regular regardless of its `fontWeight`. A two-weight mix (bold section headers against regular inline buttons) read as visibly inconsistent, so Shelly commits to one pixel weight everywhere.
- **Text.render monkey-patch** — `Text.defaultProps.style` is replaced (not merged) when a child passes its own `style`, which would otherwise let 100+ call sites escape the theme font. The patch prepends `{ fontFamily }` to every Text's style array so the preset font reaches every call site without touching them.
- **Neon glow** — eight per-color `textShadow` styles (teal / blue / sky / purple / pink / green / red / amber) for the mock's "reading terminal" vibe
- **CRT overlay** — scanlines + phosphor tint + vignette, backed by the cosmetic store
- **Haptic toggle** — per-interaction feedback on/off

</details>

<details>
<summary><strong>Git Integration</strong></summary>

- **Dirty badge** — AgentBar (amber pill, global) and Sidebar (on the active repo row) both show the uncommitted-file count, polled every 20 seconds by a single writer in `useGitStatusStore`. Tapping the AgentBar badge opens the Command Palette filtered toward git actions.
- **Command Palette** — the seven git actions listed above
- **Auto-savepoint** — background git-based save system (`lib/auto-savepoint.ts`) with secret pattern scanning before each commit
- **Git diff preview** — Preview pane Code tab renders `git diff <file>` with the neon diff palette

</details>

<details>
<summary><strong>Settings, API Keys, Background Agents</strong></summary>

- **Inline API key editor** — Claude / Gemini / Cerebras / Groq / Perplexity keys in the Settings dropdown with masked display and per-row `EDIT / CLEAR / SAVE / CANCEL`. Keys live in `expo-secure-store`.
- **Settings TUI** — full settings also accessible via a terminal-style text UI
- **Command safety** — regex-based 5-level risk assessment (seatbelt, not firewall — see [Security](#security))
- **Workspace isolation** — per-project cwd / env / AI context
- **Background agents** — `@agent` schedule + AlarmManager-triggered runs under tmux; skeleton is in place, end-to-end runs are still being validated on device
- **Managed CLI runtime updater** — `shelly runtime-update` downloads the latest `claude` (musl) and `codex` (codex-termux) binaries, verifies integrity, smoke-tests on-device, then hot-swaps `~/.shelly-runtime/<cli>/current` without an APK update
- **`shelly doctor`** — diagnostic command that checks PTY health, CLI binary presence, musl loader, resolv.conf, and credential state; run it when something feels broken

</details>

---

## Status

| Area | State |
|---|---|
| Native PTY, sessions, tmux revival | ✅ shipping |
| Multi-pane layout (5 types, splits, presets, drag resize, empty-state CTA) | ✅ shipping |
| Atomic paste (bracketed-paste wrap when guest opts in via DECSET 2004, single `TerminalEmulator.paste()` choke point, IME chunk-split coalesced) | ✅ shipping (bugs #91, #94, #97, #106) |
| `/sdcard` access via `MANAGE_EXTERNAL_STORAGE` (first-launch grant flow) | ✅ shipping (bug #92) |
| `bash` wrapper at `$HOME/bin/bash` for shebangs and `bash script.sh` | ✅ shipping (bug #93) |
| `execSubprocess` JNI read loop (EAGAIN vs EOF distinction) | ✅ shipping (bug #70) |
| AI Edit golden path (stage → diff → per-hunk accept → disk writeback) | ✅ shipping, fuzzy re-anchor for successive hunks |
| FileTree CRUD (create / rename / delete / copy path) | ✅ shipping |
| Command Palette — tabs, terminal, git, panes, layouts, font, CRT, voice | ✅ shipping |
| Browser fullscreen, desktop UA toggle, link capture, bookmarks | ✅ shipping |
| Theme presets — Shelly / Silkscreen / 8-bit / Mono + Dracula / Nord / Gruvbox / Tokyo Night / Catppuccin Mocha / Rose Pine / Kanagawa / Everforest / One Dark / Blackline / Modal (runtime swap, single-weight Text monkey-patch) | ✅ shipping |
| AgentBar + Sidebar git dirty badge (single-writer poll) | ✅ shipping |
| Sidebar Add Repository existence check + Alert on ghost path | ✅ shipping (bug #73) |
| AI pane Local LLM routing (URL-driven, no enable toggle) | ✅ shipping (bug #68) |
| Voice dialogue (VoiceChat + VoiceChain + TTS) | ✅ implemented, device smoke-test pending |
| Immortal sessions (tmux keep-alive) | ✅ implemented, device smoke-test pending |
| Local LLM via llama.cpp `@local` (Settings · Integrations · Local LLM: catalog, download, start/stop) | ✅ shipping |
| MCP Servers (Settings · Integrations · MCP Servers) | ✅ shipping |
| Claude / Gemini CLIs auto-installed on first launch (via npm) | ✅ shipping |
| Claude Code 2.1.113+ (Bun SEA) + Codex CLI on Android bionic via musl trampoline loader / managed runtime updater — only Android app to keep both latest CLIs current natively (bug #117 Path C-bis, bugs #76/#96) | ✅ shipping |
| Arena mode | ✅ wired, under-used — let us know how it feels |
| Background agents — `@agent` registration, AlarmManager scheduling, Sidebar Tasks list with run-now / delete | ✅ wired, AlarmManager end-to-end smoke test pending |
| Sidebar Ports monitor (`/proc/net/tcp` → tap to open in Browser pane) | ⚠ Android 10+ SELinux denies both `/proc/net/tcp{,6}` reads and `NETLINK_SOCK_DIAG` sockets from `untrusted_app`; tracked as bug #99 (P1) — needs an alternative channel (e.g. a bundled privileged helper or system_server intent) in v0.1.1 |
| Sidebar SSH Profiles (key-file auth, ~/.ssh/config import, tap-to-connect) | ✅ shipping |
| Cloud storage | 🚫 out of scope — use `rclone` from the terminal pane |
| App icon | ✅ shipping |
| Distribution channels (Play Store / F-Droid) | 🟡 GitHub Releases only for now |

Full validation checklist: [`docs/superpowers/specs/2026-04-13-validation-checklist.md`](docs/superpowers/specs/2026-04-13-validation-checklist.md)

---

## Coming Soon

Parts of the app are written but not yet verified. These are on the short-term roadmap, not in the current build:

- **Play Store / F-Droid distribution** — the APK is published via GitHub Releases only; store submission flow not yet done
- **End-to-end device validation** for voice dialogue, immortal sessions, and background agent AlarmManager scheduling — all wired but not yet smoke-tested on the target device
- **Snippet authoring UI** — the Command Palette shows the first 20 entries from your snippet store and dispatches them to the terminal, but the in-app create/import/edit flow was removed in the v0.1.0 cleanup. Snippets can still be added by editing `~/.shelly/snippets.json` directly or via `shelly config`.

---

## The Story

### I don't hand-write code.

I'm not an engineer by training — I'm a Creative Director. Every line in this repo was generated by AI under my direction, then reviewed, tested on-device, and shipped. What I bring is twenty years of product judgment about what belongs on a screen and what doesn't — and that turns out to be most of the job.

Every architectural decision in Shelly is mine. The code is not. It was created through conversation with [Claude Code](https://claude.ai/) on a Samsung Galaxy Z Fold6. I direct. The AI builds. No desktop. No laptop. Just a foldable phone and an AI that can execute commands.

The keyboard you see in the screenshots? I built that too. It's called [Nacre](https://github.com/RYOITABASHI/Nacre) — an Android IME written in Kotlin, also created entirely through AI conversation. I'm typing on it right now, inside Shelly, improving both apps simultaneously.

This is not a portfolio project. This is a tool I use every day to build things. If you find something that could be better, that's what the issue tracker is for.

### Why any of this exists

Mobile development never took off — not because phones lack computing power, but because the **input** and **interface** weren't designed for creation.

Chat apps (ChatGPT, Claude, Gemini) can *talk* about code, but they can't *run* it. Terminal emulators (Termux) can *run* anything, but they're hostile to anyone who isn't already a developer.

Shelly fills the gap. You type "make me a portfolio site" in the AI pane, and a real shell runs the commands, generates files, and shows you the results — right next to the terminal that produced them.

### Why every design decision is shaped like a question

Every feature in Shelly started as a frustration I had with existing tools:

- The cross-pane system comes from *"Why do I have to copy an error from one window and paste it into another?"*
- The native terminal comes from *"Why does the terminal die every time I switch apps?"*
- The approval proxy comes from *"Claude is asking me to approve something in English. I don't know what it means."*
- The VoiceChain comes from *"I can't type on a phone keyboard fast enough to keep up with my ideas."*
- The layout system comes from *"Why can't I have a browser, a terminal, and an AI all on the same screen at the same time?"*
- The Shelly theme preset comes from *"Why do I have to choose between a usable UI and an aesthetically interesting one?"*

Every limitation became an innovation that engineers need just as much.

### Why native — the WebView pivot

Early versions used ttyd and a WebView. WebSocket connections dropped. Android's Phantom Process Killer terminated background processes. Every time you switched apps, the terminal was dead.

So I directed the AI to throw it all away and go native. Shelly now embeds a native terminal emulator — Kotlin code derived from Termux's own `terminal-emulator` library — connected via a JNI C layer that calls `forkpty()` in the same process. No TCP. No IPC boundary. No socket drops.

As far as we know, this is the **only React Native app in the world** with an embedded native terminal emulator running in-process via JNI.

### Who is this for?

- **Vibe Coders** — Lovable / Bolt / Replit Agent, but on your phone with a real terminal underneath
- **Mobile-first developers** — Claude Code or Gemini CLI, with a proper multi-pane IDE around them
- **Non-engineers with ideas** — Shelly translates everything. Dangerous operations are blocked until you understand them

---

## Architecture

### Screen Layout

```mermaid
block-beta
  columns 5
  AB["Agent Bar — layout / add pane / search / settings"]:5
  SB["Sidebar\nRepos (dirty badge)\nFile Tree\nTasks\nDevice"]:1 TP["Terminal Pane\n$ npm run build\nError: missing..."]:2 AP["AI Pane\n'Fix the error →'\n[Accept hunk]"]:2
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
  PTY -- "read/write fd" --> TV["ShellyTerminalView.kt\nKotlin Canvas renderer"]
  TV --> GPU["Android SurfaceView\nGPU composited"]
```

Two JNI entry points for two different needs. **`shelly-pty.c`** owns interactive shells: it opens `/dev/ptmx`, calls `forkpty`-equivalent logic (`grantpt` + `unlockpt` + `setsid` + `execve` via `/system/bin/linker64`), and hands the master fd back to Kotlin for the terminal view to read. **`shelly-exec.c`** owns programmatic one-shots (`git status`, `ls`, file I/O, AI dispatch helpers): it does a vanilla `fork` + `exec` + `pipe` and returns `{exitCode, stdout, stderr}` synchronously, with an EAGAIN-aware read loop that distinguishes spurious select wakes from genuine EOF (bug #70 fix).

No TCP. No sockets. No separate process. Shells run as children of the app process, and the PTY fd is read directly from Kotlin via JNI.

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

## Built With

| Layer | Technology |
|-------|-----------|
| Framework | Expo 54 / React Native 0.81 |
| Language | TypeScript (strict) + Kotlin + C |
| UI | NativeWind (TailwindCSS 3) |
| State | Zustand |
| Navigation | expo-router v6 |
| Terminal | Native emulator (Kotlin, Termux-derived) + JNI forkpty (C, same-process) |
| Fonts | Silkscreen (single weight, via `@expo-google-fonts/silkscreen`) + PressStart2P + system monospace |
| i18n | expo-localization + Zustand (900+ keys, EN/JA) |

---

## Contributing

This started as a personal tool. Community contributions are shaping it into a true OSS project.

**Looking for a first contribution?** Check the [`good first issue`](https://github.com/RYOITABASHI/Shelly/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label:

- [Set up Jest test framework](https://github.com/RYOITABASHI/Shelly/issues/5) — foundational, unblocks all test work
- [Add unit tests for input-router.ts](https://github.com/RYOITABASHI/Shelly/issues/1) — pure functions, easy to test
- [Add unit tests for command-safety.ts](https://github.com/RYOITABASHI/Shelly/issues/2) — security-critical, great for TDD
- [Add unit tests for auto-savepoint.ts](https://github.com/RYOITABASHI/Shelly/issues/3) — git operations, secret detection
- [Translate Japanese code comments to English](https://github.com/RYOITABASHI/Shelly/issues/4) — one file per PR is fine
- [Flesh out CONTRIBUTING.md](https://github.com/RYOITABASHI/Shelly/issues/6) — development setup guide

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

In two years, mobile terminals will be standard. The hardware is already here — 40+ TOPS NPUs, 12 GB of RAM, 7B-parameter models running on-device at interactive speeds — and the only thing missing is the interface. Shelly is a bet on that timeline.

When a full IDE runs in your pocket and the AI doesn't have to phone home, you get zero-cost assisted development, complete privacy, and the ability to ship real software from places no laptop reaches. The first person to ship a production app from a plane without wifi will be using something like this.

Shelly was built for that future. Local LLM routing is already wired. The native terminal is already there. The multi-agent routing already supports local models alongside cloud APIs. The layout system already handles the screen real estate of foldables and tablets.

The question isn't whether mobile development will happen. It's who builds the tools for it first.

---

## About the Creator

**RYO ITABASHI** — Creative Director at [Rebuild Factoryz](https://rebuildfactoryz.com/). Branding and design are my profession. Code is not.

I built Shelly because I wanted to use Claude Code on my phone, but Termux was too intimidating. So I made a chat interface that hides the terminal complexity while keeping its full power. Then I realized the real problem wasn't the terminal itself — it was the gap between the terminal and the AI. So I connected them. Then the WebView kept dying, so I directed the AI to replace the entire rendering layer with a native terminal emulator. Then I realized I needed a browser pane, a markdown viewer, a code preview, a sidebar, and a proper layout system to make it a real IDE.

I still don't hand-write code. I describe what I need, the AI builds it, and I decide whether it ships.

The keyboard in the screenshots is **Nacre** — a split-layout Android IME I built (also through AI) to solve the input problem on mobile. Shelly handles the interface. Nacre handles the input. Together, they make phone-only development actually possible.

**Both were developed entirely on a Samsung Galaxy Z Fold6, without ever touching a desktop computer.**

---

## Known Limitations

Shelly is v0.1.0. Here's what we know isn't perfect yet.

- **No offline mode by default** — Cloud AI features require an internet connection. Local LLM via `@local` works offline, but you must start the llama.cpp server yourself today.
- **Additional tools beyond the bundle** — Shelly ships with bash, Node.js, Python 3, git, curl, sqlite3, tmux, vim, less, jq, make, and the GNU coreutils set. Notable tools **not** bundled include `busybox`, `watch` (procps-ng), `htop`, and most network daemons. If you need them, install Termux alongside Shelly or open a PR adding the binary to `modules/terminal-emulator/android/src/main/jniLibs/`.
- **`watch` is broken in the current release** — the bundled `watch` binary fails to invoke subcommands under Shelly's bionic environment and the watched command never actually runs, even though the header refreshes. Workaround: `while true; do clear; <cmd>; sleep 1; done`. Tracked as bug #34.
- **`busybox` is not bundled** — `busybox httpd`, `busybox nc`, and other applets return `command not found`. Use the standalone equivalents where available (`curl`, `nc` from the bundle, `python3 -m http.server`), or bundle `busybox-static` yourself. Tracked as bug #35.
- **`@team` routes to multiple APIs simultaneously** — this consumes credits on every provider at once; a cost warning is shown before execution.
- **Multi-hunk Accept against a partially-edited file** — per-hunk Accept uses fuzzy re-anchoring so successive hunks land, but if the AI's diff references context that has already been edited to something else, the hunk will be rejected with a toast asking you to regenerate.
- **Silkscreen is not monospaced** — `ls -la` columns may drift slightly; switch to the `Mono` font preset from the Command Palette if you need strict columns.
- **Codex CLI runs through a rewritten `codex.js`** — `@openai/codex` ships a statically-linked ET_EXEC aarch64 binary that Android's `mmap_min_addr` refuses to load. Shelly replaces it with the `codex-termux` ET_DYN build and patches `codex.js` at post-install to spawn it through `/system/bin/linker64`. If `codex --version` fails, run `shelly doctor` or check `~/.shelly-cli/install.log` for the `[patch] codex.js OK` line. Tracked as bugs #76 and #96.
- **`/sdcard` access requires MANAGE_EXTERNAL_STORAGE** — Android 11+ Scoped Storage blocks direct `open(2)` on `/sdcard` paths without this permission. Shelly asks for it on first launch; if you deny it, `source /sdcard/Download/foo.sh` will fail with `Permission denied`. Re-grant from system Settings → Apps → Shelly → Permissions → Files and media → Allow management of all files.
- **Claude Code first-run OAuth requires credential transplant** — Anthropic's OAuth flow tries a loopback callback that requires a registered browser handler (`xdg-open` / `termux-open`); under Shelly the flow falls back to manual code paste, and the paste step rejects with `OAuth error: status code 400` for reasons we haven't fully traced. Workaround: complete `/login` in another environment (Termux, PC, GitHub Codespaces, anywhere Claude Code already works), then transplant the credentials — details in [Bring your own credentials](#bring-your-own-credentials) below. This is an intentional scope limitation: first-run zero-setup authentication is the job of the sister project **Chelly**, not Shelly. Tracked as bug #102.
- **Gemini CLI `/auth` cannot complete inside Shelly either** — same pattern as Claude: gemini-cli tries to `spawn('xdg-open', [url])` and gets `EACCES`, and copying the OAuth URL into an external browser returns HTTP 400 from Google (the registered loopback port in the gemini-cli OAuth client doesn't match what the CLI picked). Workaround is identical: authenticate on another machine, then transplant `~/.gemini/` — see [Bring your own credentials](#bring-your-own-credentials). Tracked as bug #115.

### Bring your own credentials

Both Claude Code and Gemini CLI fail to complete first-run OAuth inside Shelly. The workaround for each is the same: finish authentication on a machine where it works (Termux, PC, Codespaces), then copy the resulting credential files onto the phone via `/sdcard/Download/` and unpack them into Shelly's home directory.

#### Claude Code

Claude Code stores its authentication in two files on whatever machine you ran `/login` on:

- `~/.claude.json` — account + onboarding completion state (~32 KB)
- `~/.claude/.credentials.json` — OAuth access + refresh tokens (~500 B)

Both need to land in the corresponding paths inside Shelly's home directory. The shortest route is `/sdcard` as a shared drop point:

**On the working machine** (Termux, laptop, Codespaces, …) after a successful `/login`:

```bash
# Drop both files onto shared storage. On desktop, use scp/rsync/adb push
# to put them under /sdcard/Download/ on the phone instead.
cp ~/.claude.json                /sdcard/Download/shelly-claude-root.json
tar cf  /sdcard/Download/termux-claude-dir.tar -C ~/.claude .
# If your tar defaults to gzip, use `tar cf` (no `z`) — Shelly's bundled
# tar cannot exec /bin/zcat and will fail on tar.gz.
```

**On Shelly**, in a terminal pane:

```bash
cp /sdcard/Download/shelly-claude-root.json ~/.claude.json
chmod 600 ~/.claude.json
cd ~/.claude && tar xf /sdcard/Download/termux-claude-dir.tar
claude              # "Welcome back <you>" means success; an onboarding picker means a file is missing
```

Caveats:

- Access tokens are short-lived (~9 hours). When the refresh token eventually rotates or Cloudflare's WAF rejects an Android-origin refresh, Shelly's `claude` will stop authenticating and you'll need to repeat the copy from a working environment. The community has reported refresh failures in [anthropics/claude-code#47754](https://github.com/anthropics/claude-code/issues/47754); we have not yet seen it in Shelly testing, but it is the expected long-tail failure mode.
- The donor machine's `claude` version does not matter for credential transplants — **any version** of claude-code produces compatible `~/.claude.json` and `.credentials.json` files. Shelly bundles the latest claude-code musl binary natively (bug #117 Path C-bis), so no pinning is needed on either side.
- These files are highly sensitive (anyone holding them can talk to Anthropic as you). Treat the `/sdcard/Download/` copies as single-use — delete them after the transplant lands.

#### Gemini CLI

Gemini stores everything under a single directory — no `$HOME`-level file like Claude's `~/.claude.json`. Size is small (~110 KB tarred) so the transplant is trivial.

**On the working machine** (after `/auth` completes):

```bash
tar cf /sdcard/Download/termux-gemini-dir.tar -C ~/.gemini .
```

**On Shelly**:

```bash
mkdir -p ~/.gemini
cd ~/.gemini && tar xf /sdcard/Download/termux-gemini-dir.tar
gemini              # "Signed in with Google" → interactive prompt, no trust picker
```

Key files inside `~/.gemini/`:

- `oauth_creds.json` — Google OAuth access + refresh tokens
- `google_accounts.json` — account linkage
- `trustedFolders.json` — skips the first-run trust picker once your workspace path is listed
- `settings.json`, `state.json`, `projects.json` — preferences and history

Caveats:

- Keep the donor environment on a working `@google/gemini-cli` (known-good at `0.38.2`). Upstream version drift has historically broken Termux in ways unrelated to Shelly.
- Same single-use security reminder as above — `~/.gemini/oauth_creds.json` is a bearer credential. Delete the `/sdcard/Download/` copy after importing.

---

## Permissions

Shelly is a terminal app that runs shell commands, edits files, calls AI APIs, and stores credentials. That combination requires more Android permissions than a typical app. Here's why each exists, what happens if you deny it, and what alternatives exist.

| Permission | Why | If denied | Alternative |
|---|---|---|---|
| **MANAGE_EXTERNAL_STORAGE** | Lets the terminal read scripts in `/sdcard/Download` and other shared directories. The standard "adb push a file, source it from the shell" workflow requires this. | `source /sdcard/Download/*.sh` fails with `Permission denied`. Everything inside `$HOME` (the app's private data dir) still works. | SAF-based per-file import UI is planned for Play Store distribution (DEFERRED P3). For now, grant from Settings → Apps → Shelly → Permissions → Files and media → Allow management of all files. |
| **INTERNET** | AI API calls (Claude, Gemini, Groq, Perplexity, Cerebras). Also used by npm install for CLI auto-updates. | Cloud AI features stop working. Local LLM (`@local`) and all terminal features still work. | Use `@local` for fully on-device inference. |
| **POST_NOTIFICATIONS** | CLI completion notifications (long-running commands surface a system notification). | You won't see the "command finished" toast. | — |
| **FOREGROUND_SERVICE** | Keeps the terminal alive when the app is backgrounded. | Shell processes may be killed by the OS when you switch apps. | — |
| **RECORD_AUDIO** | Voice input (VoiceChat + VoiceChain). | Voice features are disabled. Typing works normally. | — |

Shelly is distributed via GitHub Releases and F-Droid, not Google Play. The `MANAGE_EXTERNAL_STORAGE` permission would require a Play Store all-files-access audit, which is why Play Store distribution is deferred until a SAF-based import path is available as a fallback.

---

## Security

Shelly runs commands on your device. The safety system is a best-effort layer, not a guarantee.

- **Command safety is regex-based** — The 5-level risk assessment uses pattern matching. It catches common dangerous patterns (`rm -rf /`, `dd if=`, etc.) but is not a sandbox. Treat it as a seatbelt, not a firewall.
- **APK distribution is unsigned** — Release APKs from GitHub Actions are not code-signed. For verified builds, clone the repo and build locally with your own keystore. See [Building from source](#quick-start).
- **Autonomous agents require explicit approval per action** — When using CLI agents (Claude Code, Gemini CLI) through Shelly, all file writes and command executions go through the approval proxy. The "all" auto-approve mode shows a security warning before activation.
- **API keys are stored in SecureStore** — Keys are never written to logs or debug output. SecureStore uses Android Keystore encryption on supported devices.
- **Convenience ≠ security** — Shelly combines shell execution, AI dispatch, file editing, API key storage, and broad storage access in a single app. This is powerful but means a compromise of any one layer could affect the others. Review the source, build from your own keystore, and treat Shelly as a development tool — not as a production server environment.

To report a security issue, please open a [GitHub issue](https://github.com/RYOITABASHI/Shelly/issues) with the `security` label, or contact the maintainer directly.

---

## Privacy

- **User profile learning** — Shelly observes your command patterns and AI usage to personalize suggestions (`lib/user-profile.ts`). This data stays on-device in AsyncStorage. However, when you send a message to a cloud AI, the profile context is included in the API request to improve response quality. You can disable profile learning in Settings.
- **No telemetry** — Shelly does not phone home. No analytics, no crash reporting, no usage tracking. The only network traffic is your explicit AI API calls.
- **Local LLM mode** — For fully private usage, configure a local model (Gemma / Qwen via llama.cpp). All processing stays on-device.

---

## License

[GPLv3](./LICENSE) — Copyright (c) 2026 RYO ITABASHI

This project includes code derived from [Termux](https://github.com/termux/termux-app) (GPLv3), specifically the terminal emulator rendering layer.
