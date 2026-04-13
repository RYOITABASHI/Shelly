# Changelog

All notable changes to Shelly are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in
`YYYY-MM-DD`. Shelly uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
