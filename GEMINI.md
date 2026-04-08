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
- **Bundled tools**: bash, Node.js 22, Python 3.12, git, curl, sqlite3. No `pkg install`.

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

## Current Task: Termux Dependency Removal (2026-04-08)

9 files still have Termux bridge/pkg assumptions that break in the new JNI architecture.
See `docs/current-tasks.md` for the full task list with file paths, problems, and fix strategies.

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
