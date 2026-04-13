# Shelly v0.1.0 — Release notes (draft)

> **Draft.** Do not tag until you've finished the smoke test in
> `docs/superpowers/specs/2026-04-14-smoke-test-v0.1.0.md` and
> replaced the placeholders below.

## TL;DR

Shelly is a mobile terminal + AI editor for Android. v0.1.0 is the
first tagged release — all the core pane types (Terminal, AI, Browser,
Markdown, Preview) ship, together with Settings-driven management UIs
for MCP servers, local llama.cpp models, theme presets, and SSH
profiles.

Built with Plan B — the Termux-free JNI `forkpty` runtime — so you can
install it as a standalone APK without pre-installing a second app.

## Highlights

- **One screen. Five pane types. Zero friction.** Terminal, AI,
  Browser, Markdown, and Preview can all live in the same multi-pane
  layout. Splits, presets, drag resize, and an empty-state CTA for
  each slot.
- **Native Android PTY** via JNI `forkpty` + `linker64` trick. No
  Termux bridge, no IPC. Sessions survive backgrounding via tmux
  keep-alive.
- **AI Edit golden path** — stage changes → unified diff → per-hunk
  accept → disk write-back with fuzzy re-anchor so successive hunks
  still apply after earlier ones drift the line numbers.
- **Eight theme presets**: Shelly, Silkscreen, 8-bit, Mono, Dracula,
  Nord, Gruvbox, Tokyo Night. Swap at runtime, the PTY survives.
- **Settings → Integrations**:
  - **MCP Servers** — catalog, add/remove, run commands via JNI exec
  - **Local LLM · llama.cpp** — model catalog with RAM hints, guided
    setup, download, start/stop, delete. 10-minute command timeout so
    builds and downloads survive.
- **Scheduled agents** — `@agent name "command"` registers a
  background job, AlarmManager fires it, Sidebar Tasks lists them
  with ▶ run-now and 🗑 delete.
- **Ports monitor** — `ss -tlnp` every 20s in the Sidebar, tap a row
  to open `http://localhost:<port>` in the Browser pane. Well-known
  ports get friendly labels (`:3000 NEXT.JS`, `:5173 VITE`, …).
- **SSH Profiles** — saved connections with key-file auth only.
  `~/.ssh/config` import, long-press edit/delete, tap-to-insert the
  full `ssh -i KEY user@host -p PORT` command into the active pane.
  No passwords or passphrases are ever persisted.
- **Background tasks & immortal sessions** — tmux keep-alive means
  your shell and its scrollback survive the app being backgrounded,
  killed, or rebooted.

## Known issues

- **Enter key sometimes needs two presses** on a freshly-spawned PTY.
  See `docs/superpowers/specs/2026-04-14-enter-key-debug-notes.md` for
  the hypothesis list. Fix targeted for v0.1.1.
- **Voice dialogue / immortal sessions / AlarmManager scheduling** are
  wired end-to-end but have not been smoke-tested on-device since the
  Plan B (Termux-free) migration. Please file issues if you hit
  anything.
- **Cloud storage** is intentionally out of scope. Install
  [`rclone`](https://rclone.org) from your package manager and run
  `rclone config` from the terminal pane — it speaks 40+ backends.
- **No Play Store or F-Droid** — the APK is distributed via GitHub
  Releases only.

## Install

1. Download `shelly-<version>.apk` from the Releases page below.
2. Enable "Install unknown apps" for your browser / file manager.
3. Tap the APK to install.
4. On first launch, Shelly requests storage + notification permissions.

The APK is signed with a dev key; Play Protect may warn the first
time. This is expected for independently-distributed Android apps.

## Upgrade

First release — no upgrade notes.

## Contributing

See `CONTRIBUTING.md`. The app is built with Expo 54 + React Native
0.81 + TypeScript strict. Native modules live under `modules/` and
`android/app/src/main/`.

## Security

See `SECURITY.md`. Report vulnerabilities via GitHub private security
advisories.

## Credits

- **Shelly**: RYOITABASHI
- **Co-Author**: Claude (Claude Code — Opus 4.6 1M context)
- **Upstream**: Termux TerminalView library, Expo, React Native, and
  the huge cast of libraries listed in `package.json`.

---

## Changelog

See `CHANGELOG.md` for the full list. Highlights:

- feat(theme): Dracula / Nord / Gruvbox / Tokyo Night presets
- feat(settings): MCP Servers management UI
- feat(settings): Local LLM · llama.cpp management UI
- feat(sidebar): Scheduled agents with run-now / delete
- refactor(sidebar): drop Cloud section — rclone covers this better
- docs: SECURITY.md, CHANGELOG.md, GitHub Actions build badge
