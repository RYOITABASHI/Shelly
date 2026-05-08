# Build 841 — Claude tier hardening (PR #47/#48) + README sync (#49) + Phase 1.2 Stage 1 foundation (#50)

**Date**: 2026-05-08 evening
**Builds**: 836 (PR #46 handoff doc) → 837 → 838 → 839 (PR #48 green) → 840 (PR #49 in-flight at session pause) → 841 (PR #50 in-flight at session pause)
**PRs**: [#47](https://github.com/RYOITABASHI/Shelly/pull/47) [#48](https://github.com/RYOITABASHI/Shelly/pull/48) [#49](https://github.com/RYOITABASHI/Shelly/pull/49) [#50](https://github.com/RYOITABASHI/Shelly/pull/50)
**Devices verified**: Z Fold6 install of #835 confirmed PR #41-#43 working; PR #47/#48/#50 install + verification PENDING (resume target)
**BASHRC_VERSION**: 82 → 84

This handoff continues from `2026-05-08-build-832-browser-pane-trio-fix.md` (which covered PR #41-#46 / build 832-836). Read that one first for the morning context (URL bar fixes, WebView resize storm, Phase 1.2 design pivot).

## Why this batch exists

After installing build #835 (PR #41-#46), the on-device test surfaced a NEW issue distinct from the URL/WebView fixes:

> Native musl Bun SEA tiers (both \`~/.shelly-runtime/claude/current/claude\` and APK-bundled Path C-bis) panic-crash at startup with exit 133 (SIGTRAP at 0x10) / 135 (SIGBUS), but ONLY after they've already drawn a partial Claude Code TUI welcome banner. Falling back to extracted Node tier (PR #41's polyfill propagation) recovers, so \`claude\` works — but the user sees a frankenstein display: corrupted half-banner from the failed native + Bun panic dump + clean banner from the fallback all interleaved.

Initial reflex was to expand the existing 134/139/159 retry list. Codex independent review pushed back: retry list expansion alone makes the visible corruption worse (more half-banner renders). Real fix: don't run the broken native tier in the foreground at all. PR #47 demoted native to opt-in; PR #48 hardened the cooldown loop so opted-in users don't re-pay for known-crashing binaries on every shell startup. PR #49 synced the README to the new reality. PR #50 is the RN-side foundation for Phase 1.2 (Google OAuth), independent of the tier work but landed in the same session because Phase 1.2 unblocks the only remaining Phase 1 gap (Gemini login).

## What changed (per PR)

### #47 `fix(claude-runtime): demote native Bun SEA tiers to opt-in`

Single file: `HomeInitializer.kt`. Both native tier blocks gated behind `SHELLY_PREFER_NATIVE_CLAUDE=1`:

```bash
if [ "${SHELLY_PREFER_NATIVE_CLAUDE:-0}" = "1" ] && [ -x "$BIN" ]; then
  ...
fi
```

Default foreground claude path skips both native blocks and goes straight to the extracted Node tier (cli.js + Bun.* polyfill via APK-bundled Node). Power users / CI smoke tests can re-enable native via the env var. Codex review fix-ups: drop `137` (SIGKILL/OOM) from retry list (cache clear doesn't help OOM); update stale "native is default" comment to current reality with a do-not-revert warning.

### #48 `fix(claude-runtime): runtime updater reliability hardening`

Two stages, two files. Codex 4-round review caught and fixed 9 bugs.

**Stage 1: bash-side cooldown integration** (`HomeInitializer.kt`, +155/-13)
- `__shelly_consume_runtime_failures`: drains `~/.shelly-runtime/.runtime-failures` into `.failed-versions` on every `claude()` invocation. Move-to-spool first (race-safe), POSIX numeric validation via `*[!0-9]*` reverse pattern.
- `__shelly_claude_native_in_cooldown`: cooldown DB lookup with `readlink basename` fallback when `version` file missing, strict semver pattern check.
- Native tier gate: `{ FORCE=1 || (PREFER=1 && !in_cooldown) } && [ -x $bin ]` — `SHELLY_FORCE_NATIVE_CLAUDE=1` is the debug escape hatch.
- Verbose log on cooldown skip (`SHELLY_VERBOSE_CLI_TIER=1` shows the skip reason).
- Cooldown TTL default 3600 → 86400 (1h was bad UX — re-paying for crash binaries hourly).
- BASHRC_VERSION 83 → 84.

**Stage 2: JS-side updater hardening** (`shelly-runtime-update.js`, +182/-22)
- Age-aware staging GC: replaced unconditional sweep with mtime-based (default 24h). Concurrent updaters no longer trample each other's WIP stages.
- 3x `--version` smoke loop (`SHELLY_NATIVE_VERSION_SMOKE_RUNS`, default 3, integer-validated > 0). Catches Bun SEA crash modes that fire on the 2nd/3rd invocation due to .node extraction race.
- Failure classification (`signal` / `auth` / `exit` / `unexpected-output` / `network` / `shape` / `extraction`). Only `signal`, `exit`, `shape` are recorded to `.failed-versions` (cooldown-worthy); `auth` / `network` / `unexpected-output` go to `.failure-log` for diagnostics only.
- Auth regex fix: `/(unauthori[sz]ed|unauthenticated|authentication|invalid api key|expired token|\b401\b|\b403\b)/` (the original `\bunauthor\b` failed to match `unauthorized` due to the word-boundary closing inside the word).
- Env validation: `SHELLY_FAILED_VERSION_COOLDOWN`, `SHELLY_NATIVE_VERSION_SMOKE_RUNS`, `SHELLY_STAGING_GC_AGE_S` all reject NaN / non-positive / out-of-bounds.

### #49 `docs(readme): reflect PR #47/#48 — extracted Node default, native opt-in`

README sync. Three locations updated, one new section added. **Implemented by Codex** as the first delegated implementation task — followed prompt constraints exactly (no version-number drift, no over-promise on unverified builds, technical tone preserved). Validated as a low-risk delegation pattern for docs work.

### #50 `feat(deeplink): JSON-line file-queue + external-browser dispatch (Phase 1.2 Stage 1)`

Single file: `app/_layout.tsx`. RN-side foundation for Phase 1.2 Google OAuth (Gemini). Each queue line is now either:

- **Legacy plain URL** (existing emitters: `shelly-xdg-open.c`, `shelly-codex-auth.js`) → in-app Browser Pane.
- **JSON object** `{type, url, provider?, authMode?}` → if `authMode === "external-browser"`, opens via `WebBrowser.openBrowserAsync` (Custom Tabs on Android).

Fallback chain: Custom Tabs → `Linking.openURL` → in-app Browser Pane. Move-to-spool drain pattern + `isDraining` re-entry guard.

**Dead code on devices** until Phase 1.2 Stage 2 (Gemini wrapper) emits the JSON entry. Existing emitters keep working unchanged via the plain-URL path. Codex 3-round review approved push.

## Codex review trail (this session)

| PR | Rounds | Outcome |
|---|---|---|
| #47 | 2 (push-prep + final) | 2 fix-ups (Path C-bis verbose banner gate, stale `native is default` comment) |
| #48 | 4 (design + push-prep + final + verification) | 9 fix-ups (mv-spool race, epoch validate, TTL default, verbose log, version-file fallback, JS env validate, smoke runs validate, auth regex, classification label) |
| #49 | Codex implemented (no review needed) | Single-shot delivery, prompt-constraint-compliant |
| #50 | 3 (design via prior #45 doc + push-prep + final) | 4 fix-ups (queue race, re-entry guard, Linking fallback tier, drop `as any`) |

15 issues caught and fixed across the session. The pattern (Claude implements, Codex reviews) has 100% catch rate so far on security-critical / native / IPC / Android changes.

## Resume instructions (for the next session)

The local working tree at `C:\Users\ryoxr\Shelly\.claude\worktrees\zen-hellman-2de212` is on this branch (`docs/handoff-build-841-evening`). All implementation work is committed and pushed; no uncommitted state.

### From a fresh / different environment

```bash
git clone https://github.com/RYOITABASHI/Shelly.git
cd Shelly
pnpm install         # or whatever the env's package manager prefers
```

### Build to install

```bash
gh run list --branch main --limit 5 --json conclusion,status,number,databaseId
# Pick the LATEST green build (should be #841 if this handoff merged before resume)
gh run download <databaseId> -n shelly-apk
# Install the .apk on Z Fold6 via adb install or file transfer
```

If #841 isn't green by resume time, fall back order: #840 → #839. Each contains a strict subset; missing PRs:
- #841 contains #41-#50 (all)
- #840 contains #41-#49 (no Phase 1.2 dead code, no behavioral diff vs #841)
- #839 contains #41-#48 (no README sync, no Phase 1.2 dead code; same runtime as later)

### Real-device verification (in priority order)

1. **`claude` REPL clean launch** (PR #41/#47/#48 combined effect)

   ```bash
   adb logcat -c && adb logcat -s HomeInitializer:* &
   # On device, open terminal pane, run: claude
   ```

   Expect:
   - `[HomeInitializer]` log line `BASHRC_VERSION 84 regenerated`
   - `claude` welcome banner renders ONCE, fully, no Bun panic interleave
   - Log path mention "extracted Bun cli.js (Node)" — NOT "runtime latest" or "Path C-bis"
   - Banner content shows `Claude Code v2.1.133` (or whatever the current promoted extracted version is)

2. **Cooldown verbose log** (PR #48)

   ```bash
   # If ~/.shelly-runtime/.failed-versions has a recent entry for the current native version
   SHELLY_VERBOSE_CLI_TIER=1 claude --version
   ```

   Expect: `[shelly] claude: native cooldown active, skipping native tier (set SHELLY_FORCE_NATIVE_CLAUDE=1 to override)` if a crash record exists. Otherwise just the extracted-Node verbose banner.

3. **Force opt-in** (PR #47/#48 escape hatch)

   ```bash
   SHELLY_FORCE_NATIVE_CLAUDE=1 SHELLY_VERBOSE_CLI_TIER=1 claude --version
   ```

   Expect: native tier ATTEMPTED (will likely panic-crash on this device with exit 133/135 — that's the documented failure mode being escaped to). After crash, the failure should be recorded in `.runtime-failures`, consumed on the NEXT non-FORCE invocation, and added to `.failed-versions` cooldown.

4. **URL bar text visibility** (PR #42 — already verified on #835, regression check only)

   Open Browser Pane in compact pane. Type "youtube.com" via Samsung IME. Each character renders immediately, font readable, cursor visible.

5. **YouTube + keyboard rendering** (PR #43 — already verified on #835, regression check only)

   Open YouTube in Browser Pane. Focus URL bar to bring up the keyboard. Search bar stays singular, video grid stays rendered, no black sections.

6. **Phase 1.2 Stage 1 dead-code sanity** (PR #50, optional)

   Manually inject a JSON line:
   ```bash
   echo '{"type":"open-url","url":"https://example.com/","authMode":"external-browser","provider":"manual-test"}' >> ~/.shelly-deep-link-queue
   ```
   Expect: Custom Tabs opens example.com within ~250 ms. `adb logcat -s Shelly:* | grep DeepLinkQueue` should show `external dispatched (provider=manual-test)`. **This validates Stage 1 plumbing without needing Stage 2 implemented.**

   Failure mode test (force fallback):
   ```bash
   adb shell pm disable-user com.android.chrome   # disable Chrome temporarily
   echo '{"url":"https://example.com/","authMode":"external-browser","provider":"fallback-test"}' >> ~/.shelly-deep-link-queue
   adb shell pm enable com.android.chrome         # re-enable
   ```
   Expect: log shows `Custom Tabs failed ... trying Linking.openURL` then either Linking opens it or the in-app fallback fires.

### If verification fails

| Failure | Likely cause | First action |
|---|---|---|
| `claude` still shows Bun panic in foreground | BASHRC v84 didn't propagate (existing $HOME kept v83 bashrc) | Check `adb logcat -s HomeInitializer:* \| head` for "regenerated" line. If missing, `rm ~/.shelly_bashrc_version` and relaunch shell. |
| `claude` REPL launches but `claude --version` fails | extracted Node tier broken; check `~/.shelly-runtime/claude-extracted/current/` exists | `ls -la ~/.shelly-runtime/claude-extracted/current/` |
| Native tier never tried even with FORCE | parsing of FORCE_NATIVE failed in bashrc | `set \| grep SHELLY_FORCE_NATIVE_CLAUDE`, then `bash -x -c claude` to trace |
| Custom Tabs doesn't open on Stage 1 manual test | expo-web-browser binding race | `adb logcat -s Shelly:* \| grep DeepLinkQueue` for the actual error |

## Open follow-ups (priority order)

| # | Item | Where | Estimate | Blocker |
|---|---|---|---|---|
| 1 | Real-device verify PR #47/#48/#50 | resume install | 30 min | install build |
| 2 | Phase 1.2 Stage 2: Gemini CLI wrapper | new file, design TBD | 2-3 hours | observe `gemini auth` URL emission on device first |
| 3 | Phase 1.2 Stage 3: completion polling | shared with Stage 2 | 1-2 hours | Stage 2 |
| 4 | Phase 1.2 real-device verify | requires Google account | 30 min | Stage 2 + 3 |
| 5 | Bun polyfill improvements (bug #139) | DEFERRED.md, P1 | 4-6 hours | none |
| 6 | Background smoke promotion (Codex's PR #48 follow-up) | shelly-runtime-update.js + bashrc | 3-4 hours | none |
| 7 | YouTube fullscreen + hardware layer smoke (bug #138) | DEFERRED.md, P1 | 5 min on-device | none |
| 8 | Multi Browser Pane navigate target (bug #136) | DEFERRED.md, P1 | 1-2 hours | none |
| 9 | DRY ensureBrowserPane (bug #137) | DEFERRED.md, P2 | 15 min | none |

## Phase 1.2 Stage 2 design notes

When implementing, refer to `docs/superpowers/DEFERRED.md` bug #102/#115 for the Codex-approved design. Key decisions already locked:

- **CLI wrapper approach: B (auth-mode wrapper, not stdout intercept, not standalone helper)**. Detect when `gemini` is invoked with the `auth` subcommand or `/auth` interactive command, watch its stdout for the Google OAuth URL pattern, write JSON to `~/.shelly-deep-link-queue`. TUI mode untouched.
- **redirect_uri stays the CLI's**: `http://127.0.0.1:<port>/...` — Shelly does NOT touch the auth code or token exchange. Per RFC 8252.
- **JSON queue line format** (already implemented in #50):
  ```json
  {"type":"open-url","url":"https://accounts.google.com/...","provider":"google","authMode":"external-browser"}
  ```
- **Completion detection**: `~/.gemini/credentials.json` mtime + `gemini --version` smoke. Don't trust the WebBrowser result alone (per Codex review F).

**Implementation gating**: install #841 → run `gemini auth login 2>&1 | tee /tmp/gemini-auth.log` on device → confirm exact URL emission stream (stdout vs stderr) and format → THEN implement the wrapper. Don't write the wrapper blind from upstream Gemini source — observed behavior on Z Fold6 is what matters.

## Things this session did NOT touch

- shelly-musl trampoline (Claude Code musl SEA on bionic) — unchanged from build #808
- Knox sepolicy workaround pattern — unchanged
- CLI auto-updater pipeline structure — only the smoke / GC / classification additions in PR #48
- Theme runtime swap — unchanged
- Savepoint auto-save bridge — unchanged
- Phase 1 OAuth (Anthropic / GitHub via WebView) — unchanged, still works
- Codex login flow (`codex-login --open`) — unchanged

## Quick refs

- Live PR list: https://github.com/RYOITABASHI/Shelly/pulls?q=is%3Apr+is%3Aclosed+merged%3A2026-05-08
- DEFERRED tracker: `docs/superpowers/DEFERRED.md` (search bug #102/#115 for Phase 1.2, #139 for Bun polyfill, #136-#138 for browser carry-forwards)
- Morning handoff: `docs/superpowers/specs/2026-05-08-build-832-browser-pane-trio-fix.md` (PR #41-#46 context)
- Memory notes (cross-session): `~/.claude/projects/.../memory/` — feedback_codex_prompt_must_match_head.md was added this session
- Build logs: `gh run view <id> --log` for any build's full output

## Session metrics

- 10 PRs opened (#41-#50), 10 merged
- 15 Codex-reviewed issues caught + fixed pre-push
- 3 builds verified green (#838, #839, more in flight at session pause)
- 1 issue carried over: real-device verify of PR #47/#48/#50 (the resume target)
- 0 commits to main without prior review
- BASHRC_VERSION advanced 81 → 84 (3 bumps: PR #41, #47, #48)
