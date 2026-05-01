# Changelog

All notable changes to Shelly are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in
`YYYY-MM-DD`. Shelly uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Build 782 security harness** — documented the release-gate checks for
  `shelly-doctor` credential hygiene, CLI runtime smoke tests, and GitHub
  secret-scanning false-positive handling in
  `docs/superpowers/specs/2026-05-01-build-782-security-harness.md`.
- **Log secret redaction** — app debug logging now redacts common API key and
  token patterns before writing to logcat. Unit tests cover OpenAI, Google,
  Groq, Cerebras, and environment-style secret strings without keeping literal
  secret-shaped fixtures in the repository.
- **`shelly-doctor` security checks** — doctor now reports leftover credential
  handoff files in `/sdcard/Download`, private-mode status for credential files,
  and whether known API-key environment variables are present.

- **Ask Pane** — Shelly's self-documenting assistant (Stage 1). New
  pane type `ask` opens via the "+" menu or pane switcher. Users ask
  natural-language questions ("can Shelly do X?" / "how do I use Y?")
  and the built-in feature catalog + curated shipping/roadmap snippets
  feed into a Groq-backed answer via the existing streaming dispatch.
  Each response ends with a coloured status badge:

    ✅ **AVAILABLE**       — feature ships today; answer walks through it.
    ⏳ **PLANNED**          — on the DEFERRED backlog; priority surfaced
                             when stated.
    ❌ **NOT_AVAILABLE**    — no evidence in docs; Stage 2 will add a
                             one-tap "Create GitHub issue" button here.

  No new LLM plumbing: reuses `groqChatStream` via `systemPromptOverride`.
  Zero native/Kotlin changes.

- **`shelly-cs open` routes into Shelly's Browser Pane via deep link**.
  A custom `shelly://browser?url=<encoded>` scheme is registered on
  Shelly's `MainActivity` (the `shelly://` family was already in the
  manifest from expo-router scaffolding — we just added a handler in
  `app/_layout.tsx`). The codespace web URL lands inside Shelly's
  in-app WebView instead of kicking out to Chrome. Falls back to the
  raw VIEW intent (external browser) if the deep-link start fails.

- **`cs` shortcut + default codespace**. `cs` is a `.bashrc` alias for
  `shelly-cs`. `shelly-cs use <name>` persists a default codespace to
  `$HOME/.shelly-cs/config.json` (verified via REST before saving).
  `shelly-cs open` with no args resolves in order: positional arg →
  default → the only Available/Shutdown codespace → helpful error.
  `shelly-cs list` marks the default with a yellow ★. `shelly-cs`
  with no command falls through to `open` when authenticated.

  Target UX from any `$PWD`:
  ```
  cs use sturdy-cod-557j97jgggjc7p4w   # one-time
  cs                                    # → codespace in Browser Pane
  ```

- **Clipboard auto-copy during `shelly-cs auth`**. The OAuth device
  code is written to the Android clipboard via a new `shelly://
  clipboard?text=<encoded>` deep link handled by the same
  `app/_layout.tsx` Linking listener. `app/_layout.tsx` calls
  `Clipboard.setStringAsync` (already a project dep). Paste directly
  in the browser instead of retyping the 8-char pair.

- **`shelly-cs` — GitHub Codespaces CLI** (Phase 1 minimum). Pure-Node
  helper that speaks the GitHub REST API directly. No gh CLI dependency,
  no external binaries, bundled bionic `node` runs it unchanged. Ships
  as an APK asset (`modules/.../assets/shelly-cs.js`) extracted to
  `$HOME/.shelly-cs/shelly-cs.js` on every launch.

  Commands: `auth` (OAuth device flow against the Shelly OAuth App),
  `list`, `create [--repo O/R]` (defaults to
  `RYOITABASHI/shelly-codespace-template` which pre-installs
  `@anthropic-ai/claude-code`), `open`, `stop`, `delete --yes`,
  `doctor`, `logout`. `ssh` is stubbed for Phase 1.5 — `open` gives
  you the codespace's web terminal for now.

  Env-overridable constants: `SHELLY_OAUTH_CLIENT_ID`,
  `SHELLY_CS_DEFAULT_REPO`, `SHELLY_CS_SCOPE`, `SHELLY_CS_DEBUG`.

- **Three-tier fallback for `claude`**: `$HOME/.shelly-cli` (auto-updated)
  → `$HOME/.shelly-cli.prev` (last-known-good snapshot) →
  `$libDir/node_modules` (APK-bundled golden). `claude()` walks the
  tiers at invocation time, reporting which tier it landed on (unless
  `SHELLY_SILENT_CLI_TIER=1`). The `__shelly_bg_cli_update` background
  job now stages into `$HOME/.shelly-cli.staging`, runs a 15-second
  `node cli.js --version` health check, and rotates only on success —
  a broken `@latest` never reaches the live tree and never blocks the
  `claude` command.

- Four additional theme presets: **Dracula**, **Nord**, **Gruvbox**,
  **Tokyo Night**. Selectable from Settings → Display → Theme or the
  Command Palette (`theme-dracula`, `theme-nord`, `theme-gruvbox`,
  `theme-tokyo-night`). Runtime swap, no PTY restart.
- **MCP Servers** management UI wired into Settings → Integrations.
  Opens the existing `McpSection` (catalog, add/remove, run command)
  as a slide-up Modal backed by the JNI `execCommand` bridge.
- **Local LLM · llama.cpp** management UI wired into Settings →
  Integrations. Opens the existing `LlamaCppSection` (model catalog
  with RAM hints, guided setup, download, start/stop, delete) as a
  slide-up Modal with a 10-minute command timeout so builds and
  downloads don't get killed.
- **Scheduled agents** in the Sidebar Tasks section: lists every
  registered `@agent` with run-now (▶) and delete (🗑) actions backed
  by `agent-executor.generateRunNowCommand()` and
  `agent-manager.deleteAgent()`.
- `SECURITY.md` and `CHANGELOG.md`. README now carries a GitHub
  Actions build badge.

### Changed

- **`claude` dispatch simplified** to `_run node cli.js` (v26 pattern
  restored). The v28–v30 detour (Bun binary + proot + Alpine chroot +
  musl sub-package + CA bundle + `/etc/*` population) turned out to be
  over-engineering — the npm tarball for
  `@anthropic-ai/claude-code@<=2.1.112` ships a plain-JS `cli.js` that
  runs under Shelly's bundled bionic node unmodified. Five-agent survey
  (GitHub issues, Ishabdullah/claude-code-termux, Qiita/Zenn/LINUX DO)
  converged on the same dispatch.
- **`claude-code` pinned to 2.1.112** — the final release that ships
  `cli.js` as a pure-JS entry point. Both the CI bundle step and
  `__shelly_bg_cli_update` pin explicitly. 2.1.113 replaced `cli.js`
  with a Bun-compiled SEA binary (`bin/claude.exe`) whose only entry
  point `cli-wrapper.cjs` is a platform-detect + spawn launcher with no
  JS fallback. Latest claude-code on mobile now requires Codespaces —
  see `shelly-cs` above.
- **Paste pipeline (bug #97 root fix)** — multi-line paste now arrives
  at bash as a single bracketed-paste chunk again. Earlier dispatch
  failed on bionic bash's readline because the ESC in `\e[200~` was
  swallowed by the meta-prefix handler; we now trigger
  `bracketed-paste-begin` via an ESC-free `\C-x\C-b` keybind instead,
  which `.bashrc` binds in the emacs, vi-insert, and vi-command
  keymaps. `TerminalEmulator.paste()` gates the wrap on DECSET 2004 so
  vim / less / nano still get the pre-#91 `\r?\n → \r` fallback.
- **README** — Coming Soon trimmed to genuine unknowns only (app icon
  + store distribution, end-to-end device smoke tests). Status table
  rewritten to reflect shipping state of theme presets, MCP,
  llama.cpp, SSH profiles, scheduled agents, and Ports monitor.
- **Sidebar Profiles** is now documented as shipping (it had been a
  section shell in the README but was in fact a fully-wired orphan
  the whole time — ~/.ssh/config import, long-press edit/delete,
  tap-to-insert `ssh -i KEY user@host -p PORT`, key-file auth only).

### Removed

- **Sidebar CLOUD section** — the Google Drive / Dropbox / OneDrive
  placeholder rows, the OAuth URL table, and `handleCloudConnect`.
  Shelly defers cloud storage to [`rclone`](https://rclone.org), which
  already speaks 40+ backends from the terminal pane. README Feature
  Tour now points at rclone directly. Status table flips the Cloud
  row from 🟡 to 🚫 out-of-scope.

### Known issues

These are tracked for the first tagged release but not yet fixed:

- **Enter key sometimes needs two presses** in freshly-spawned PTY
  sessions. Suspected to be the `TerminalSession` Kotlin
  non-blocking read loop racing with the initial prompt render —
  native debug next.
- **Voice dialogue, immortal sessions, and AlarmManager scheduling**
  are wired end-to-end but have not been smoke-tested on-device since
  the Plan B (Termux-free) migration.
- **App icon + Play Store / F-Droid distribution** — the APK ships
  via GitHub Releases only. Icon brief exists, store flow does not.

---

Earlier history (pre-changelog) is visible in `git log`. Noteworthy
milestones:

- **Shelly theme preset + runtime swap + Silkscreen single-weight
  monkey-patch** — `4687da97` through `ca428062`
- **Plan B (Termux-free JNI forkpty + APK-bundled binaries)**
  completes — commit `1323a287`
- **Superset UI redesign** — 50+ commits, mock-faithful pane/sidebar
  layout with Silkscreen pixel font
- **AI Edit golden path** — stage → unified diff → per-hunk accept →
  disk writeback with fuzzy re-anchor
