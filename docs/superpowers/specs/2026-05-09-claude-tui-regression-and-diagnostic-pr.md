# 2026-05-09 — Claude TUI silent-exit regression analysis + diagnostic PR

**Date**: 2026-05-09 (continued from morning install of build #842)
**PRs added this session**: [#52](https://github.com/RYOITABASHI/Shelly/pull/52) (workaround), [#53](https://github.com/RYOITABASHI/Shelly/pull/53) (diagnostic)
**Status at session pause**: PR #52 + #53 both open, neither merged yet, BASHRC sequencing 85 → 86 requires merge in that order
**Devices verified**: Z Fold6 install of build #842 confirmed bare \`claude\` (TUI mode) silent-exits via extracted Node tier; \`--version\` and \`-p\` work fine on the same tier

This handoff continues from \`2026-05-08-evening-claude-tier-and-phase-1.2-stage-1.md\`. Read both for full session context.

## What broke and how we got here

| Step | Date | What happened |
|---|---|---|
| 1 | 2026-05-08 | Build #835 installed (PR #41-#46). User screenshot showed Bun panic / Bus error in foreground native musl Bun SEA tier (Claude Code 2.1.131-ish). |
| 2 | 2026-05-08 | I read the screenshot incorrectly and reported "全 OK 🎉" missing the panic entirely. |
| 3 | 2026-05-08 | User caught the miss: "claudecode エラー出てるじゃん". |
| 4 | 2026-05-08 | Rushed PR #47 to demote native to opt-in (\`SHELLY_PREFER_NATIVE_CLAUDE=1\`), making extracted Node tier the default. Codex 2 rounds, merged. |
| 5 | 2026-05-08 | PR #48 hardened the cooldown loop. Codex 4 rounds, merged. |
| 6 | 2026-05-08 | PRs #49 / #50 / #51 (docs + Phase 1.2 Stage 1 foundation). |
| 7 | 2026-05-09 | Build #842 installed. **Bare \`claude\` silent-exits**. \`--version\` and \`-p\` still work. |
| 8 | 2026-05-09 | User opened PR #52 — daily-driver workaround routes bare TUI to APK-bundled legacy cli.js. \`SHELLY_CLAUDE_EXTRACTED_TUI=1\` / \`SHELLY_CLAUDE_TUI_AUTO_LEGACY=1\` overrides. BASHRC 85. |
| 9 | 2026-05-09 | Investigation: I proposed a Bun virtual fs hypothesis (\`/$bunfs/root/*.node\` lazy require). External \`NODE_OPTIONS=--require=hook.js\` test couldn't even fire heartbeat. |
| 10 | 2026-05-09 | Codex review: pivot priority — verify preload-load path before chasing Bun.* internals. PR #53 (this session) bakes diagnostic into the generated preload heredoc. |

**Root cause of the regression chain**: PR #47 changed the **default route** from native to extracted Node tier without verifying that bare TUI (the most common claude invocation) actually works on the new default. \`--version\` and \`-p\` PASS were the only verification before merge. The user's bare claude usage broke immediately on next install.

**Memory rule added** (\`feedback_runtime_route_change_needs_bare_tui_test.md\`):
> Default tier / runtime route / preload polyfill / cli.js loader 変更時は merge 前に bare claude REPL 実機 PASS を必須にする。\`--version\` / \`-p\` PASS だけでは不十分。

## PR #52 — bare TUI → legacy cli.js workaround

User-facing daily-driver fix. Routes \`claude\` (no args) to the APK-bundled legacy cli.js path instead of the broken extracted Node TUI path. Other invocations (\`claude --version\`, \`claude -p\`, anything with arguments) keep using the latest extracted Node route.

Env overrides:
- \`SHELLY_CLAUDE_EXTRACTED_TUI=1\` — force bare TUI through extracted Node (for testing)
- \`SHELLY_CLAUDE_TUI_AUTO_LEGACY=1\` — explicit opt-in for the legacy-fallback behaviour (default-on currently)

BASHRC_VERSION 84 → 85.

## PR #53 — preload-internal diagnostic instrumentation

Codex 2-round-reviewed. Three rounds total of design discussion + push-prep fixes. Key Codex insights:

1. **Priority**: don't chase Bun.* polyfill internals before proving the preload itself loads. External \`NODE_OPTIONS=--require=...\` tests showed nothing — the user-side hook never reached cli.js — so chasing TUI mount details was premature.
2. **Method**: bake the diagnostic INTO \`~/.shelly-claude-node-preload.js\` heredoc, since the claude bash function loads that unconditionally.
3. **Fix-ups (4)**:
   - \`uncaughtException\` listener suppresses Node's terminate-on-throw → switched to \`uncaughtExceptionMonitor\` (observe-only).
   - \`SHELLY_VERBOSE_CLI_TIER=1\` is already common for tier-route debug; adding event listeners would noise every \`--version\` / \`-p\` invocation. Restructured: VERBOSE = \`loaded\` log only; DIAG = full event listeners + Bun Proxy.
   - Stack trace 5 → 10 lines (minified bundle needs more frames).
   - BASHRC bumped to 86 to land on top of PR #52's 85.

### What it captures (only when env enabled)

\`SHELLY_VERBOSE_CLI_TIER=1\`:
- \`[SHELLY-PRELOAD] loaded {node, argv, isTTY..., nodeOptions, cwd}\` once per invocation. Confirms the preload reaches cli.js.

\`SHELLY_CLAUDE_DIAG=1\`:
- All of the above, plus
- \`[SHELLY-PRELOAD] uncaughtExceptionMonitor\` (observe-only, doesn't change disposition)
- \`[SHELLY-PRELOAD] unhandledRejection\`
- \`[SHELLY-PRELOAD] beforeExit code=N\`
- \`[SHELLY-PRELOAD] exit code=N\`
- \`globalThis.Bun\` Proxy wrap → \`[SHELLY-BUN-MISSING] <prop> + 10-line stack\` for every Bun.* property cli.js reads that we don't polyfill, deduped per name.

Default install: silent. Zero behaviour change.

### Failure-mode separation this provides

The four observed manifestations (rc=0 silent exit / sleep-hang / prompt-not-returning / checkpoints-fire-but-no-render) were being lumped. Diagnostic separates them:

| Symptom | What appears in stderr |
|---|---|
| rc=0 silent exit | \`loaded\` + \`beforeExit code=0\` + \`exit code=0\`, no error events |
| sleep / hang | \`loaded\`, then nothing (no \`exit\`, no \`beforeExit\`) |
| prompt-not-returning | Same as sleep from JS side; \`/proc/$pid/wchan\` needed at the bash layer |
| checkpoints fire but no render | \`exit\` fires, but no Ink output before it; \`BUN-MISSING\` for Ink-adjacent APIs |

## Resume instructions (next session)

The branches are pushed but **not merged**. Local working tree is on \`docs/handoff-claude-tui-regression-analysis\`.

### Merge sequence (BASHRC sequencing matters)

1. Merge PR #52 first (BASHRC bump to 85). Build #843 fires.
2. Merge PR #53 second (BASHRC bump to 86). Build #844 fires.
3. (Merge this handoff PR whenever — docs only, no BASHRC change.)

If you change order, BASHRC numbering will collide and you'll need to rebase one of them.

### After install

```bash
# 1. Confirm preload load path works (the foundational unknown)
SHELLY_VERBOSE_CLI_TIER=1 claude --version
# Expect: single "[SHELLY-PRELOAD] loaded ..." line. If absent, preload-load path itself is broken (different bug class).

# 2. Default install path (PR #52 fallback) still working
claude
# Expect: TUI launches via legacy cli.js fallback. Daily-driver health check.

# 3. Force the BROKEN path so we can capture the diagnostic trace
SHELLY_CLAUDE_DIAG=1 SHELLY_CLAUDE_EXTRACTED_TUI=1 claude
# Expect: lots of stderr output. Look for:
#   - [SHELLY-PRELOAD] loaded ... (preload path OK)
#   - [SHELLY-BUN-MISSING] <prop> + stack (cli.js's TUI path tried Bun.<prop> we don't polyfill)
#   - [SHELLY-PRELOAD] uncaughtExceptionMonitor / unhandledRejection (silent-fail captured)
#   - [SHELLY-PRELOAD] exit code=N (final disposition)
# Save this output to a file for analysis: ... 2>&1 | tee /tmp/claude-diag.log
```

### What the output reveals

| Captured | Likely cause | Next fix |
|---|---|---|
| \`[SHELLY-BUN-MISSING] spawn\` near start | cli.js TUI mount uses \`Bun.spawn\` for MCP server / editor invocation | Polyfill \`Bun.spawn\` via \`child_process.spawn\` shim |
| \`[SHELLY-BUN-MISSING] file\` | \`Bun.file()\` for state read | Polyfill via \`fs.readFileSync\` shim |
| \`[SHELLY-BUN-MISSING] fetch\` (and works on \`-p\`) | streaming-specific code path | Investigate fetch wrapper |
| \`uncaughtExceptionMonitor\` with stack | Identifies the actual throw location | Read the stack |
| \`exit code=0\` only, no other signal | TUI mount thinks it succeeded but rendered nothing | Ink render / setRawMode issue |
| Nothing fires (no \`loaded\`) | Preload not loaded — \`NODE_OPTIONS\` propagation broken | Investigate claude bash function's NODE_OPTIONS construction |

## Open follow-ups after this resume

| # | Item | Gating |
|---|---|---|
| 1 | Merge PR #52 + #53 in order | none |
| 2 | Install + capture diagnostic trace | builds green |
| 3 | Identify root cause from \`[SHELLY-BUN-MISSING]\` / event signals | step 2 |
| 4 | Implement bug #139 (Bun.* polyfill completion) targeted at observed missing APIs | step 3 |
| 5 | Once root fix lands, revert PR #52 workaround | step 4 verified |
| 6 | Phase 1.2 Stage 2 (Gemini CLI wrapper) | unrelated, blocked on \`gemini auth\` URL emission observation |

## Things this session DID NOT change

- Any source-of-truth for runtime tier resolution beyond the diagnostic instrumentation in PR #53
- Phase 1.2 implementation (still at Stage 1 only, dead-code'd until Stage 2)
- bug #139 (Bun.* polyfill expansion) — design captured in DEFERRED.md, implementation gated on this session's diagnostic output
- Any user-facing UI / browser pane / terminal pane code

## Process notes from this session

- The Bun panic that user spotted in build #835 screenshots was the trigger for PRs #47/#48. I missed it. Lesson captured in memory rule (link above).
- Codex review caught 4 substantive issues in PR #53 (uncaughtException disposition, gating noise, stack truncation, BASHRC conflict). Pre-push review remained 100% catch rate for substantive bugs across the session.
- The "Codex prompt must mirror HEAD" memory rule (added previous session) was applied throughout. No stale-snippet incidents this round.
- Memory rule added this session: "Default tier / runtime route 変更は bare TUI 実機 PASS が mandatory."
