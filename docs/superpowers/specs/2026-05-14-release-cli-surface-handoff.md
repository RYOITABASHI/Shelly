# 2026-05-14 — v5.3.0 release CLI surface handoff

## Decision

v5.3.0 ships with a narrow, supportable AI/CLI surface:

| Area | Release status |
|---|---|
| Claude Code CLI | Supported foreground Terminal CLI |
| Codex CLI | Supported foreground Terminal CLI |
| AI Pane / background agents | Supported only through explicit API providers |
| Gemini API | Supported when configured |
| Gemini CLI | Experimental, bundled but not promoted in release UI |

This is a product and compliance boundary, not just a UI choice. Claude
Code subscription access must stay under direct user control in a Terminal
pane. Shelly must not run Claude Code as a hidden background worker or use
Claude Code subscription access to power AI Pane automation.

## Current verified behavior

- Claude Code starts as an interactive CLI in Terminal panes with seeded
  home trust/onboarding state and app-private credential files.
- Codex starts through the Shelly wrapper. Bare `codex` checks
  `~/.codex/auth.json`; if missing or invalid, it launches
  `codex-login --open`, opens the Browser Pane to OpenAI device auth,
  writes credentials, and then starts the normal Codex TUI.
- On-device Codex validation: `codex-exec 0.130.0`, OpenAI Codex
  `v0.130.0`, GPT-5.5.
- AI Pane/background providers are API-backed: Gemini API, Cerebras, Groq,
  Perplexity, OpenAI-compatible local endpoints, and explicit future API
  routes.
- Sidebar Worktrees and CLI Quick Launch expose Claude Code and Codex only.
- New Terminal tabs created by the pane UI autofocus the new shell.

## Gemini CLI status

Gemini CLI stays in the APK for continued investigation, but it is not part
of the supported launch promise.

Observed during the v131-v136/v899-v904 cycle:

- `gemini --version` works through the APK bundle tier.
- `SHELLY_VERBOSE_CLI_TIER=1 gemini --version` reports the APK bundle tier.
- Gemini API remains useful and should stay available in AI Pane/background
  flows.
- Interactive Gemini CLI 0.42.x showed blank TUI startup, slow rendering,
  and shell-tool command failures ending in signal 11 on Android/musl.
- Patcher instrumentation exposed cases where intended Gemini bundle
  patches did not match production minified files; future work needs
  fail-loud patching and more stable upstream hooks.

Do not re-add Gemini to Worktrees or Quick Launch until an on-device test
proves TUI launch, prompt response, shell tool execution, and recovery from
failed commands across multiple fresh installs.

## Required docs sync

When changing any of this release surface, update all of:

- README.md
- CLAUDE.md
- AGENTS.md
- GEMINI.md
- CHANGELOG.md
- docs/release-notes/v5.3.0.md
- docs/superpowers/DEFERRED.md

## Follow-up work

- Rebuild Gemini patcher as fail-loud and minification-tolerant.
- Track upstream Gemini CLI Android/musl PTY issues before promoting the
  CLI again.
- Consider Anthropic API-key based AI Pane integration separately from
  Claude Code subscription CLI usage.
- Keep Codex login wrapper aligned with upstream auth schema changes.
