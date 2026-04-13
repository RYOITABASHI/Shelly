<p align="center">
  <img src="docs/images/shelly-logo.png" alt="Shelly" width="120">
</p>

<h1 align="center">Shelly</h1>

<h3 align="center">
  <code>Terminal + AI + Browser + Markdown + Preview</code><br>
  <sub>One screen. Five pane types. Zero friction.</sub>
</h3>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-blue?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android-00D4AA?style=flat-square&logo=android&logoColor=white">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Claude%20Code-D4A574?style=flat-square">
  <img alt="Expo" src="https://img.shields.io/badge/Expo%2054-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Lines" src="https://img.shields.io/badge/100k%2B%20lines-of%20code-333?style=flat-square">
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

<p align="center">
  <img src="docs/images/hero.jpg" alt="Shelly — terminal, AI, browser, markdown, and preview in a single screen" width="720">
</p>

<br>

---

## I can't write code.

I'm not an engineer. I've never written a line of TypeScript. I don't fully understand how Git works internally. I have no formal training in computer science.

But I built this — a 100,000-line terminal IDE — by talking to AI.

Every architectural decision in Shelly is mine. The code is not. It was created through conversation with [Claude Code](https://claude.ai/) on a Samsung Galaxy Z Fold6. I direct. The AI builds. No desktop. No laptop. Just a foldable phone and an AI that can execute commands.

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

> **Requirements:** Android device. For building from source: Node.js 22+, pnpm, Android NDK r27+. Expo Go is not supported — Shelly uses native Kotlin/C modules.
>
> Termux is not required. Shelly ships with bash, Node.js, Python 3, git, curl, and sqlite3. For tools beyond the bundled set, Termux can be used alongside Shelly.

On first launch, the Setup Wizard handles permissions and AI configuration. The terminal is ready in under 5 minutes.

---

## The Copy-Paste Problem

You're running Claude Code in the terminal. It throws an error. You copy it. You switch to ChatGPT. You paste. You ask "what went wrong?" You read the answer. You copy the fix. You switch back. You paste. You run it.

**Seven steps. Every single time.**

This is the daily workflow of every developer using CLI-based AI tools. The terminal and the AI live in different worlds, and *you* are the copy-paste bridge between them.

**Shelly puts Terminal and AI panes side by side — and the AI reads your terminal output automatically.**

Say **"fix the error on the right"**. Shelly reads the terminal output, explains the error, and generates an executable command. Tap **[Run]** and the fix lands directly in the Terminal pane.

No copy. No paste. No tab switching. Zero friction.

**Three levels of value:**

- **Single pane:** a native terminal that is faster, smarter, and more usable than Termux alone — with inline content blocks, autocomplete, syntax highlighting, and clickable errors.
- **Split panes:** terminal + AI side by side — the AI reads what the terminal shows and executes fixes with one tap. No copy-paste bridge needed.
- **Full layout:** sidebar + up to 4 live panes + agent bar — a mobile IDE. Browse docs in the browser pane, preview code or markdown on the right, run agents in the background, and keep your terminal front and center.

---

## How is Shelly different?

Termux gives you a terminal but no AI. ChatGPT gives you AI but no terminal. Replit runs in the cloud. Claude Code on desktop is desktop-only. Shelly is the only tool that puts a native terminal and multi-agent AI side by side on your phone — with a browser pane, markdown viewer, code preview, sidebar, and agent bar all in one screen — and connects them so the AI reads your terminal output and edits your files with one tap.

---

## Features

> Everything listed in this section is working in the current build. Anything not yet shipped is listed under [Coming Soon](#coming-soon) further down.

### Highlights

| | |
|---|---|
| **Cross-pane intelligence** | Say "fix the error." AI reads your terminal, suggests a fix, one tap to run. Zero copy-paste. |
| **AI Edit golden path** | Tap a file in the sidebar → preview it → hit `[✨ AI]` → describe the change → accept per hunk → the file is rewritten on disk, the preview reloads automatically. |
| **Native PTY (JNI forkpty)** | Kotlin + C, same-process, zero IPC. The only React Native app with an embedded native terminal. |
| **5 pane types** | Terminal, AI, Browser (+ background audio), Markdown, Preview. Split up to 4 live panes freely. |
| **Multi-agent AI** | Claude Code, Gemini, Cerebras, Groq, Perplexity, Codex, Local LLM. Auto-routed or `@mention`. |
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
- **Ports** — every 20 seconds Shelly scans `ss -tlnp` and lists each loopback / wildcard listener; tap a row to open `http://localhost:<port>` in the Browser pane. Well-known ports get friendly labels (`:3000 NEXT.JS`, `:5173 VITE`, `:8081 EXPO`, `:8888 JUPYTER`, …).
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
- **Other presets** — Silkscreen (previous greener palette), 8bit (PressStart2P), Mono (system monospace). Switch from Settings → Display → Font or from the Command Palette.
- **Runtime swap** — presets are swapped by mutating the live `colors` object in place (identity preserved) and bumping a theme-version store that key-remounts the shell layout. PTY sessions survive the switch — your vim stays open.
- **Single-weight rendering** — every Text is forced through Silkscreen Regular regardless of its `fontWeight`. A two-weight mix (bold section headers against regular inline buttons) read as visibly inconsistent, so Shelly commits to one pixel weight everywhere.
- **Text.render monkey-patch** — `Text.defaultProps.style` is replaced (not merged) when a child passes its own `style`, which would otherwise let 100+ call sites escape the theme font. The patch prepends `{ fontFamily }` to every Text's style array so the preset font reaches every call site without touching them.
- **Neon glow** — seven per-color `textShadow` styles (teal / blue / sky / purple / pink / green / red / amber) for the mock's "reading terminal" vibe
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

</details>

---

## Coming Soon

Parts of the app are scaffolded but not ready. These are on the short-term roadmap, not in the current build:

- **Additional terminal theme presets** — beyond the four Shelly / Silk / 8bit / Mono font presets, the palette is currently Shelly-only
- **Background agent scheduler UI** — currently registered via `@agent` syntax; a proper sidebar/Settings view is planned
- **MCP manager** — MCP server catalog exists but is experimental
- **App icon + Play Store / F-Droid distribution** — the APK is published via GitHub Releases only

---

## Status

| Area | State |
|---|---|
| Native PTY, sessions, tmux revival | ✅ shipping |
| Multi-pane layout (5 types, splits, presets, drag resize, empty-state CTA) | ✅ shipping |
| AI Edit golden path (stage → diff → per-hunk accept → disk writeback) | ✅ shipping, fuzzy re-anchor for successive hunks |
| FileTree CRUD (create / rename / delete / copy path) | ✅ shipping |
| Command Palette — tabs, terminal, git, panes, layouts, font, CRT, voice | ✅ shipping |
| Browser fullscreen, desktop UA toggle, link capture, bookmarks | ✅ shipping |
| Shelly theme preset + runtime swap + single-weight Text monkey-patch | ✅ shipping |
| AgentBar + Sidebar git dirty badge (single-writer poll) | ✅ shipping |
| Voice dialogue (VoiceChat + VoiceChain + TTS) | ✅ implemented, device smoke-test pending |
| Immortal sessions (tmux keep-alive) | ✅ implemented, device smoke-test pending |
| Local LLM via llama.cpp `@local` (Settings · Integrations · Local LLM: catalog, download, start/stop) | ✅ shipping |
| Arena mode | ✅ wired, under-used — let us know how it feels |
| Background agents (`@agent` + AlarmManager) | 🟡 skeleton, end-to-end validation pending |
| Sidebar Ports monitor (`ss -tlnp` → tap to open in Browser pane) | ✅ shipping |
| Sidebar SSH Profiles (key-file auth, ~/.ssh/config import, tap-to-connect) | ✅ shipping |
| Cloud storage | 🚫 out of scope — use `rclone` from the terminal pane |
| App icon + distribution channels | 🟡 brief written, image + store flow not done |

Full validation checklist: [`docs/superpowers/specs/2026-04-13-validation-checklist.md`](docs/superpowers/specs/2026-04-13-validation-checklist.md)

---

## The Story

Mobile development never took off — not because phones lack computing power, but because the **input** and **interface** weren't designed for creation.

Chat apps (ChatGPT, Claude, Gemini) can *talk* about code, but they can't *run* it. Terminal emulators (Termux) can *run* anything, but they're hostile to anyone who isn't already a developer.

Shelly fills the gap. You type "make me a portfolio site" in the AI pane, and a real shell runs the commands, generates files, and shows you the results — right next to the terminal that produced them.

### Why Native?

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
  JS["React Native JS"] -- "JSI bridge" --> KT["Kotlin NativeModule"]
  KT -- "JNI call" --> C["shelly-exec.c / shelly-pty.c"]
  C -- "forkpty()" --> SH["shell process\nbash / zsh / sh"]
  C -- "read/write fd" --> TV["ShellyTerminalView.kt\nKotlin Canvas renderer"]
  TV --> GPU["Android SurfaceView\nGPU composited"]
```

No TCP. No sockets. No separate process. The shell runs as a child of the app process via `forkpty`, and the PTY fd is read directly from Kotlin via JNI.

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
| Fonts | Silkscreen (400 + 700) via `@expo-google-fonts/silkscreen`, PressStart2P, system monospace |
| i18n | expo-localization + Zustand (900+ keys, EN/JA) |

---

## Design Philosophy

Shelly was designed by someone who can't use a terminal — for people who can't use a terminal.

Every design decision comes from the question: *"If I don't know what this command does, how should the app protect me and teach me at the same time?"*

The cross-pane system comes from: *"Why do I have to copy an error from one window and paste it into another?"*
The native terminal comes from: *"Why does the terminal die every time I switch apps?"*
The approval proxy comes from: *"Claude is asking me to approve something in English. I don't know what it means."*
The VoiceChain comes from: *"I can't type on a phone keyboard fast enough to keep up with my ideas."*
The layout system comes from: *"Why can't I have a browser, a terminal, and an AI all on the same screen at the same time?"*
The Shelly theme preset comes from: *"Why do I have to choose between a usable UI and an aesthetically interesting one?"*

Every limitation became an innovation that engineers need just as much.

Read the full design philosophy: **[docs/DESIGN_PHILOSOPHY.md](docs/DESIGN_PHILOSOPHY.md)**

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

Mobile terminals are about to become standard. Most developers don't see it yet.

Modern mobile SoCs have NPUs pushing 40+ TOPS. Local LLMs that required a desktop GPU two years ago now run on phones. Soon, 7B-13B parameter models will run natively on mobile at acceptable speeds.

When that happens, you'll have zero-cost AI-assisted development, complete privacy, and development anywhere — airplanes, remote sites, commutes.

Shelly was built for that future. Local LLM routing is already wired. The native terminal is already there. The multi-agent routing already supports local models alongside cloud APIs. The layout system already handles the screen real estate of foldables and tablets.

The question isn't whether mobile development will happen. It's who builds the tools for it first.

---

## About the Creator

**RYO ITABASHI** — Creative Director at [Rebuild Factoryz](https://rebuildfactoryz.com/). Branding and design are my profession. Code is not.

I built Shelly because I wanted to use Claude Code on my phone, but Termux was too intimidating. So I made a chat interface that hides the terminal complexity while keeping its full power. Then I realized the real problem wasn't the terminal itself — it was the gap between the terminal and the AI. So I connected them. Then the WebView kept dying, so I directed the AI to replace the entire rendering layer with a native terminal emulator. Then I realized I needed a browser pane, a markdown viewer, a code preview, a sidebar, and a proper layout system to make it a real IDE.

100,000 lines later, I still can't write code. But I can describe what I need, and the AI builds it.

The keyboard in the screenshots is **Nacre** — a split-layout Android IME I built (also through AI) to solve the input problem on mobile. Shelly handles the interface. Nacre handles the input. Together, they make phone-only development actually possible.

Both were developed entirely on a Samsung Galaxy Z Fold6, without ever touching a desktop computer.

---

## Known Limitations

- **No offline mode by default** — Cloud AI features require an internet connection. Local LLM via `@local` works offline, but you must start the llama.cpp server yourself today.
- **Additional tools beyond the bundle** — Shelly ships with bash, Node.js, Python 3, git, curl, and sqlite3. For tools outside this set, Termux can be used alongside Shelly.
- **`@team` routes to multiple APIs simultaneously** — this consumes credits on every provider at once; a cost warning is shown before execution.
- **Multi-hunk Accept against a partially-edited file** — per-hunk Accept uses fuzzy re-anchoring so successive hunks land, but if the AI's diff references context that has already been edited to something else, the hunk will be rejected with a toast asking you to regenerate.
- **Silkscreen is not monospaced** — `ls -la` columns may drift slightly; switch to the `Mono` font preset from the Command Palette if you need strict columns.

---

## Security

Shelly runs commands on your device. The safety system is a best-effort layer, not a guarantee.

- **Command safety is regex-based** — The 5-level risk assessment uses pattern matching. It catches common dangerous patterns (`rm -rf /`, `dd if=`, etc.) but is not a sandbox. Treat it as a seatbelt, not a firewall.
- **APK distribution is unsigned** — Release APKs from GitHub Actions are not code-signed. For verified builds, clone the repo and build locally with your own keystore. See [Building from source](#quick-start).
- **Autonomous agents require explicit approval per action** — When using CLI agents (Claude Code, Gemini CLI) through Shelly, all file writes and command executions go through the approval proxy. The "all" auto-approve mode shows a security warning before activation.
- **API keys are stored in SecureStore** — Keys are never written to logs or debug output. SecureStore uses Android Keystore encryption on supported devices.

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
