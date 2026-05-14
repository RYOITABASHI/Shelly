# Shelly — GEMINI.md (for Gemini CLI)

This file is read by Gemini CLI when launched inside the Shelly project.
For Claude Code context, see `CLAUDE.md`. For Codex CLI, see `AGENTS.md`.

---

## Project Overview

**Shelly** is a single-screen terminal IDE for Android (Expo 54 / React Native 0.81 / TypeScript).
Layout: AgentBar (top) + Sidebar (left) + PaneContainer (center, up to 4 panes) + ContextBar (bottom).

## Architecture (v6 — Superset UI)

- **Terminal**: JNI forkpty — `modules/terminal-emulator/` (Kotlin + C). NO Termux, NO bridge, NO WebSocket, NO TCP.
- **Command execution**: `execCommand()` from `hooks/use-native-exec.ts` (calls `TerminalEmulator.execCommand` via JNI)
- **PTY write**: `TerminalEmulator.writeToSession(sessionId, text)` 
- **Pane types**: Terminal, AI, Browser, Markdown — registered in `components/multi-pane/pane-registry.ts`
- **Settings**: ConfigTUI modal (gear button or `shelly config`) — `components/config/ConfigTUI.tsx`
- **API keys**: `lib/secure-store.ts` (expo-secure-store, encrypted)
- **Bundled tools**: bash, Node.js, Python 3, git, curl, sqlite3. No `pkg install`.

## Gemini Release Status (2026-05-14)

Gemini API is supported in AI Pane/background flows when the user configures a Gemini API key. The interactive Gemini CLI is Experimental for v5.3.0.

Known device findings:

- `gemini --version` works through the APK bundle tier.
- Authenticated Gemini accounts can be present under `~/.gemini`.
- The interactive TUI has shown upstream Android/musl instability: blank launch, slow rendering, and shell-tool commands terminating with signal 11.
- Worktrees and CLI Quick Launch must not expose Gemini in the release surface.

When changing Gemini support, update README, `CLAUDE.md`, `AGENTS.md`, and `docs/superpowers/specs/2026-05-14-release-cli-surface-handoff.md` together.

## Key Stores (Zustand)

| Store | File | Purpose |
|-------|------|---------|
| terminal-store | `store/terminal-store.ts` | Sessions, blocks, command execution |
| settings-store | `store/settings-store.ts` | App settings + ConfigTUI visibility |
| pane-store | `store/pane-store.ts` | Focused pane, agent-pane bindings |
| sidebar-store | `store/sidebar-store.ts` | Sidebar mode, repos, sections |
| ai-pane-store | `store/ai-pane-store.ts` | Per-pane AI conversations |
| cosmetic-store | `store/cosmetic-store.ts` | CRT, fonts, sound profile, haptics |

## Build

```bash
pnpm install && pnpm android        # local dev
git push origin main                 # triggers GitHub Actions APK build
```

Bundle ID: `dev.shelly.terminal`

## Current Task

Keep Gemini CLI investigation isolated from the supported Claude Code / Codex release path.

### Rules for this work:
- Use `execCommand()` from `hooks/use-native-exec.ts` for shell execution
- Use `TerminalEmulator.writeToSession()` for interactive PTY commands
- API keys: `lib/secure-store.ts` (NOT `~/.shellyrc`)
- NO `pkg install/upgrade` commands (tools are bundled)
- Remove "Termux" from user-facing messages
- `shelly` prefix commands stay in pseudo-shell; everything else uses real JNI exec

## Dev Rules

- Code comments/variables: English
- UI text: i18n keys (`lib/i18n/`)
- Colors: `useTheme().colors`
- State: Zustand stores
- Commits: English, conventional style
