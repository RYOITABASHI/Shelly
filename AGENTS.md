# Shelly — AGENTS.md (for Codex CLI)

This file is read by Codex CLI when launched inside the Shelly project.
For Claude Code context, see `CLAUDE.md`. For Gemini CLI, see `GEMINI.md`.

## ⚠️ Required reading at session start

**[docs/superpowers/DEFERRED.md](./docs/superpowers/DEFERRED.md)** — the single source of truth for deferred work.

This file tracks every item that has been explicitly deferred to a later release, descoped, or marked as a known limitation, along with the reason and priority (P0/P1/P2/P3). Introduced on 2026-04-14 after repeated README/code mismatches in earlier sessions.

**Rules**:
- Verbal "we'll do it later" is forbidden — everything goes into DEFERRED.md
- Verify P0 is empty before starting any release work
- When descoping a feature, sync both the README Status table and DEFERRED.md

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

## Key Stores (Zustand)

| Store | File | Purpose |
|-------|------|---------|
| terminal-store | `store/terminal-store.ts` | Sessions, blocks, command execution |
| settings-store | `store/settings-store.ts` | App settings + ConfigTUI visibility |
| pane-store | `store/pane-store.ts` | Focused pane, agent-pane bindings |
| sidebar-store | `store/sidebar-store.ts` | Sidebar mode, repos, sections |
| ai-pane-store | `store/ai-pane-store.ts` | Per-pane AI conversations |
| cosmetic-store | `store/cosmetic-store.ts` | CRT, fonts, sound profile, haptics |
| browser-store | `store/browser-store.ts` | Bookmarks |
| profile-store | `store/profile-store.ts` | SSH profiles |
| workspace-store | `store/workspace-store.ts` | Per-repo isolation |
| workflow-store | `store/workflow-store.ts` | Saved workflows |

## Build

```bash
pnpm install && pnpm android        # local dev
git push origin main                 # triggers GitHub Actions APK build
gh run download <run-id>             # download APK
```

Bundle ID: `dev.shelly.terminal`

## Current Release Surface (2026-05-14)

Read `docs/superpowers/specs/2026-05-14-release-cli-surface-handoff.md` before changing CLI/auth behavior.

- Supported foreground CLIs: Claude Code and Codex.
- Experimental CLI: Gemini. Keep it bundled for investigation, but do not expose it in Worktrees or Quick Launch.
- AI Pane/background agents use explicit API providers only: Gemini API, Cerebras, Groq, Perplexity, OpenAI-compatible local routes, etc.
- Do not drive Claude Code subscription access as a hidden background worker. Claude Code remains a user-controlled terminal CLI.
- Bare `codex` must route through Shelly's login wrapper when `~/.codex/auth.json` is missing or invalid, then launch the normal Codex TUI.

### Rules for this work:
- Use `execCommand()` from `hooks/use-native-exec.ts` for shell execution (NOT pseudo-shell, NOT bridge)
- Use `TerminalEmulator.writeToSession()` for interactive PTY commands
- API keys go to `lib/secure-store.ts` (NOT `~/.shellyrc`)
- Settings go to `store/settings-store.ts` `updateSettings()`
- NO `pkg install/upgrade` commands (tools are bundled)
- Remove the word "Termux" from user-facing messages unless explicitly describing compatibility boundaries
- `shelly` prefix commands (e.g. `shelly config`) stay in pseudo-shell — everything else uses real JNI exec

## Dev Rules

- Code comments/variables: English
- UI text: i18n keys (`lib/i18n/`)
- Colors: `useTheme().colors` — never hardcode
- State: Zustand stores, not React state (except component-local)
- Commits: English, conventional style
