# Shelly v0.1.0 RC — Release Notes draft

**Target**: first tagged release candidate.
**Status**: draft (not yet cut). Update this doc through RC builds; promote to `RELEASE-v0.1.0.md` on the tagged commit.

> TL;DR — Shelly is a chat-first terminal IDE for Android (Samsung Galaxy Z Fold6 primary target). This RC ships the full Phase-1 Codespaces story, the self-documenting **Ask Pane**, and a hardened paste pipeline. Claude Code, Gemini, and Codex all work on-device; **"always-latest" Claude Code is one tap away via Codespaces**.

## Highlights

### 🚀 GitHub Codespaces, end-to-end — `shelly-cs` CLI

A pure-Node helper (no `gh` binary, no external deps, no Termux) that owns the OAuth device flow, Codespace CRUD, and web-URL launch. Installed by HomeInitializer on every launch; invoked through a new `shelly-cs` bash function and the two-letter `cs` alias.

```
shelly-cs auth           one-time sign-in via GitHub's device flow
shelly-cs create         make a codespace from the Shelly template
shelly-cs use <name>     set a default codespace
cs                       → open default in Browser Pane (claude-code ready)
```

Supporting polish:

- **Browser Pane deep link** — `shelly-cs open` routes the codespace's web URL into Shelly's own WebView via `shelly://browser?url=…`, not an external browser.
- **Clipboard auto-copy** — the OAuth device code lands on the clipboard while the code is printed; paste it directly in the browser.
- **Default resolution** — `shelly-cs open` with no args uses the default, or the only Available/Shutdown codespace. `shelly-cs list` marks the default with ★.
- **Smart zero-arg mode** — `shelly-cs` with no command falls through to `open` when authenticated.

### ❓ Ask Pane — Shelly's self-documenting assistant

A new pane type (`ask`) that answers "can Shelly do X?" / "how do I use Y?" grounded in the bundled feature catalog and a curated shipping/roadmap snapshot. Each answer closes with a coloured badge:

- ✅ **AVAILABLE** — works today, answer cites where
- ⏳ **PLANNED** — in the DEFERRED backlog (priority shown when known)
- ❌ **NOT_AVAILABLE** — no evidence; Stage 2 will let users file an issue with one tap

Uses Groq's free tier by default via the existing `groqChatStream` dispatch — zero new LLM plumbing.

### 🩹 Paste pipeline — root-fix for bug #97

`\e[200~` bracketed-paste wrap was broken by bionic bash 5.3's readline meta-prefix handler. Fixed by switching the trigger to `\C-x\C-b` (ESC-free), bound to `bracketed-paste-begin` in the emacs, vi-insert, and vi-command keymaps. Multi-line paste is atomic again; vim / less / nano still get the fallback behaviour via DECSET 2004 gating.

### 🏗 Three-tier fallback for `claude` + staged auto-update

`claude()` walks three tiers at invocation time:

1. `$HOME/.shelly-cli` (auto-updated, `claude-code@2.1.112` pinned)
2. `$HOME/.shelly-cli.prev` (last-known-good snapshot)
3. `$libDir/node_modules` (APK-bundled golden fallback)

`__shelly_bg_cli_update` now stages into `.shelly-cli.staging`, runs a 15-second health check, and rotates only on success. A broken upstream `@latest` never blocks the CLI.

**Why 2.1.112 pin**: claude-code 2.1.113 dropped `cli.js` in favour of a Bun-SEA binary that can't execute on Android bionic. Shelly's dispatch (`_run node cli.js`) needs `cli.js` to exist, so we pin to the last release that ships it. The Codespaces path gives users access to the real @latest whenever they want.

### 🎨 Four additional theme presets

**Dracula**, **Nord**, **Gruvbox**, **Tokyo Night**. Runtime swap, no PTY restart, no re-mount.

### 🔌 Settings integrations — MCP, Local LLM, Scheduled Agents

Modal-backed, slide-up versions of the existing section components, now reachable from Settings → Integrations. `SSH profiles` section was already wired; documented as shipping.

---

## Full change set (via [CHANGELOG.md `[Unreleased]`](../CHANGELOG.md#unreleased))

- Ask Pane (Stage 1)
- `shelly-cs` CLI + Browser Pane deep link + clipboard auto-copy + `cs` shortcut + default codespace
- Three-tier `claude` fallback with staged health-checked auto-update
- Paste pipeline root-fix (bug #97)
- `claude-code` pinned to 2.1.112 (last `cli.js` release)
- Four theme presets, MCP/Local-LLM/Scheduled-Agents settings modals
- README trimmed to actual unknowns; Sidebar Profiles documented; Cloud section removed in favour of rclone

---

## What didn't ship in this RC

Intentionally deferred to v0.1.1+:

- **`shelly-cs ssh <name>`** — Ship it as a stub that opens the codespace's web URL via `shelly-cs open` for now. Full dev-tunnels-based SSH tunneling lands in v0.1.1 (3-5 days, separate release track). Design: [docs/codespaces-integration-design.md](./codespaces-integration-design.md).
- **Ask Pane Stage 2** — `[📝 Create GitHub issue]` button for NOT_AVAILABLE answers. Design: [docs/ask-pane-stage2-design.md](./ask-pane-stage2-design.md). 1-1.5 day implementation.
- **Sidebar CODESPACES section** — follows the Worktrees pattern. Depends on Ask Pane dogfood feedback first.
- **SecureStore bridge for the `shelly-cs` token** — file-based 0600 storage is adequate for MVP; JSI bridge lands with v0.1.1.
- **Transparent `claude` via Tier-0 Codespace** — requires SSH tunneling to be stable first.

Also explicitly out-of-scope:

- Cloud storage providers (Google Drive / Dropbox / OneDrive) — Shelly defers to [`rclone`](https://rclone.org) (40+ backends, already a bundled tool).
- Anthropic / OpenAI paid-API direct integrations — user policy is "no paid APIs except Perplexity". Claude and Codex ship as CLIs only.
- Play Store / F-Droid distribution — v0.1.0 distributes via GitHub Releases only. App icon ships, store flow is v0.2.0+.

---

## Known issues

- **Enter key sometimes needs two presses** in freshly-spawned PTY sessions. Suspected `TerminalSession` read-loop race; native debug pending.
- **Voice dialogue, immortal sessions, and AlarmManager scheduling** are wired end-to-end but have not been smoke-tested on-device since the Plan B (Termux-free) migration.
- **Codespace's Android VIEW intent may not open**: if `am start` fails on the device (OEM-specific), `shelly-cs auth` and `shelly-cs open` both print the URL and silently fall back — user can open the URL manually on any device. GitHub's device flow doesn't require the browser to be on the same device as the polling client.

---

## Verification checklist (device smoke test)

Run on a fresh APK install to confirm the RC is stable. Full script at [scripts/test-v34.md](../scripts/test-v34.md). The short list:

- [ ] `cat ~/.bashrc_version` → `37`
- [ ] Multi-line paste (`echo one\necho two`) → single atomic command
- [ ] `claude --version` → `2.1.112` (or the bundled fallback)
- [ ] `gemini --version`, `codex --version` → both launch
- [ ] `shelly-cs auth` → device code + clipboard copy + browser launch → "Authenticated as …"
- [ ] `cs create` → codespace reaches Available within 2-3 min
- [ ] `cs use <name>` → star appears in `cs list`
- [ ] `cs` (no args) → Browser Pane opens the codespace web UI
- [ ] In the codespace web terminal: `claude --version` → latest upstream (e.g. 2.1.114+)
- [ ] Ask Pane: "Does Shelly have pane splitting?" → ✅ AVAILABLE badge
- [ ] Ask Pane: "Does Shelly support MIDI keyboards?" → ❌ NOT_AVAILABLE badge with Stage 2 hint

---

## Upgrading from pre-RC builds

- APK upgrade preserves `$HOME/.shelly-cli` and other user data. The `termux-libs/` bundled CLIs do NOT auto-refresh on upgrade — a fresh install (or manual `rm -rf ~/.shelly-cli`) is the only way to see the newer bundled versions. This is intentional: upgrading APK shouldn't wipe the user's codespaces / settings / history.
- BASHRC_VERSION bumps trigger `.bashrc` regeneration on next shell launch; users see the new `cs` alias and Ask Pane pane type without any manual steps.
