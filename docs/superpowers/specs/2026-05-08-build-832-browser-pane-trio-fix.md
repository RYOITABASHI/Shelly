# Build 832-836 — Browser Pane trio fix + Bun polyfill propagation + Phase 1.2 redesign

**Date**: 2026-05-08
**Builds**: 831 → 832-836 (5 sequential rebuilds from PRs #41-#45)
**PRs**: [#41](https://github.com/RYOITABASHI/Shelly/pull/41) [#42](https://github.com/RYOITABASHI/Shelly/pull/42) [#43](https://github.com/RYOITABASHI/Shelly/pull/43) [#44](https://github.com/RYOITABASHI/Shelly/pull/44) [#45](https://github.com/RYOITABASHI/Shelly/pull/45)
**Devices verified**: Galaxy Z Fold6 / Android 14 (post-merge real-device test pending)
**BASHRC_VERSION**: 81 → 82

## Why this batch exists

User-reported symptoms after build #830 (post #39 + #40 install):

1. `claude` REPL crash on launch with `TypeError: globalThis.Bun.which is not a function`
2. URL bar in Browser Pane showed only a thin horizontal line — text typed via Samsung IME (visible in IME suggestion chips as "youtube") never appeared in the field
3. Opening YouTube in Browser Pane and then bringing up the soft keyboard caused WebView paint corruption — search bar stacked, video grid disappeared, sections went black; recovered only on keyboard dismiss

The stacking made the cause non-obvious — each surface masked the others. Codex and internal agent reviews independently confirmed three separate root causes.

## What broke

| # | Symptom | Root cause |
|---|---|---|
| 1 | `claude` REPL TypeError on `globalThis.Bun.which` | PR #40 added Bun.* polyfill heredoc to `HomeInitializer.kt` and `shelly-runtime-update.js` but **forgot to bump `BASHRC_VERSION`**. Existing devices with `$HOME` already provisioned kept their v81 bashrc on disk (since `$HOME` persists across APK reinstall), so the new heredoc never propagated. Claude Code 2.1.133 calls `Bun.which` early in cli.js fallback tier → REPL dies before first prompt. |
| 2 (a) | URL bar text invisible — typed "youtube" via IME never rendered | URL TextInput style had `fontSize: 9` in compactChrome mode (`urlInputCompact`). On Z Fold6 in a third-screen pane, 9px monospace renders as a near-invisible thin dash. The text was being typed correctly — it was just illegible. PR #39's selectionColor/cursorColor fix made the cursor visible but didn't address the typography. |
| 2 (b) | URL bar text gets cleared mid-typing | `handleNavigationStateChange` unconditionally called `setInputUrl(state.url)` on every WebView navigation event — including background redirects, OAuth bounces, and YouTube prefetch frames. The user's typed input was overwritten as soon as any nav fired. |
| 2 (c) | Samsung IME shows "youtube" suggestions but field stays empty | `selectTextOnFocus` interacts badly with Samsung Honeyboard's compose mode: the field auto-selects on focus, IME starts composing replacement text, but Android Autofill Framework claims input ownership and the composed text never commits. Suggestion chips show what the user typed; the field never receives onChangeText. |
| 3 | YouTube WebView paint corrupts on every keyboard toggle | `BrowserPane` had its own `Keyboard.addListener` and applied `paddingBottom: keyboardHeight` to its root View. `MultiPaneContainer` ALREADY does the equivalent at the grid level (`gridHeight = size.H - keyboardHeight` + `paddingBottom: keyboardHeight` on container root). Combined with Activity-level `windowSoftInputMode="adjustResize"`, WebView resized 2-3 times per keyboard toggle. Chromium's tile compositor for heavy SPAs (custom compositors, IntersectionObservers, layered scrollers) couldn't re-rasterize fast enough → corrupted paint until keyboard dismissed. Plain HTML pages were unaffected. |

## Fixes (per PR)

### #41 `fix(claude-runtime): bump BASHRC_VERSION 81 -> 82 to ship Bun polyfill`

Single-line bump. `HomeInitializer.kt:663` `private const val BASHRC_VERSION = 81 -> 82`. The version-bump check in HomeInitializer regenerates `~/.bashrc` from the heredoc on next launch, propagating the Bun.* polyfill (`Bun.which / semver / YAML / gc / generateHeapSnapshot`) added in PR #40 to existing devices. Build #831 verified green.

### #42 `fix(browser): URL bar text visibility + IME compose + nav race`

Three stacked fixes in `components/panes/BrowserPane.tsx`:

1. **Typography**: `fontSize` 11→13 (standard) / 9→12 (compact); heights 28→32 / 22→26; added `paddingVertical: 0` + `textAlignVertical: 'center'` + `includeFontPadding: false` for proper Android vertical centering of monospace text.

2. **Nav race guard**: Added `urlFocused` state + `urlFocusedRef` ref-mirror. `handleNavigationStateChange` now skips `setInputUrl(state.url)` when `urlFocusedRef.current` is true. Ref-mirror keeps the useCallback dep array empty (avoids WebView prop diff churn on every focus toggle).

3. **IME conflict**: Removed `selectTextOnFocus` (incompatible with Samsung Honeyboard compose). Added `autoComplete="off"` + `importantForAutofill="no"` to suppress Android Autofill Framework overlay competing with IME for input ownership.

Plus `placeholderTextColor` `#6B7280` → `C.text2` (theme-aware), forced-blur fallback via `Keyboard.addListener('keyboardDidHide')` for [RN issue #29571](https://github.com/facebook/react-native/issues/29571) (onBlur doesn't fire when keyboard dismissed via back button), and clear-X icon color `#6B7280` → `C.text2` drive-by.

Two internal agent reviews (state/logic + RN/Android-behavior) verified each change. Reviewers caught the back-button blur bug and the duplicate hardcoded `#6B7280`.

### #43 `fix(browser): remove duplicate keyboard avoidance to stop WebView resize storm`

Codex independent review (WebView/keyboard rendering 2nd opinion request) confirmed the "double/triple resize trigger" hypothesis directly from code inspection:
- `MultiPaneContainer.tsx:160` comment says "keyboard avoidance is managed centrally here"
- `MultiPaneContainer.tsx:273` `gridHeight = size.H - keyboardHeight`
- `MultiPaneContainer.tsx:277` container root `paddingBottom: keyboardHeight`
- BUT `BrowserPane.tsx:264-273` had its own `Keyboard.addListener` and `BrowserPane.tsx:495` applied another `paddingBottom: keyboardHeight` on top

Stage 1 fix (Codex's recommendation): drop BrowserPane's local listener + paddingBottom entirely. Container's grid-level handling already shifts the entire pane up by keyboardHeight, so PaneInputBar (rendered inside BrowserPane) rides above the keyboard automatically without WebView needing to resize.

If YouTube still corrupts after Stage 1, Stage 2/3 (`windowSoftInputMode="adjustNothing"` + central inset management) is the next step, but that's a bigger change deferred until verification.

Merge note: PR #43 originally branched from origin/main BEFORE #42, so it removed `Keyboard` / `Platform` imports. After #42 merged (which added a new `keyboardDidHide` forced-blur listener using those imports), rebase produced a *semantic* (non-textual) conflict — git auto-merged but the result wouldn't compile. Rebase + manual import restoration + force-push fixed it; merge then completed cleanly.

### #44 `docs(deferred): bug #139 — Bun.* polyfill 強化`

Codex review of PR #40's Bun polyfill design surfaced multiple improvement opportunities, captured as P1 follow-up:

- `Bun.which(cmd, { PATH, cwd })` 2nd arg unsupported; paths containing `/` should be cwd-resolved instead of PATH-searched
- `Bun.semver.satisfies` should return `false` on invalid input (not throw)
- `Bun.YAML.parse` uses `js-yaml.load` only — misses multi-doc YAML (`loadAll` + `SyntaxError` wrap)
- Add `Bun.env / argv / main / inspect / sleep / sleepSync`; `Bun.version` as fake-marked sentinel
- **Explicit throw stubs** for `Bun.spawn / spawnSync / serve / $` (silent no-op masks the cause when Claude actually needs them)
- **NEVER** set `process.versions.bun` — Claude would take Bun-specific paths that break on Node
- Mid-term: move heredoc-in-bashrc to dedicated `~/.shelly-claude-node-preload.js` injected via `NODE_OPTIONS=--require=...` only inside Claude wrapper (not globally polluting all Node processes)

### #45 `docs(deferred): Phase 1.2 設計を Codex review に従って書き換え`

**This is the most consequential finding of the session.** Codex review of the proposed Phase 1.2 (Google OAuth Custom Tabs trampoline) design revealed the original architecture was fundamentally wrong:

> The original proposal had Shelly intercept the OAuth callback at `shelly://oauth/callback`, perform token exchange itself, and write `~/.gemini/credentials.json` directly.

The flaw: OAuth flow ownership lives entirely with the CLI:
- `client_id`, `redirect_uri`, `state`, **`code_verifier` (PKCE)**, loopback callback server, token spec, credential file format

If Shelly intercepts the redirect, it gets the auth code but **doesn't have the PKCE `code_verifier`** that the CLI generated. RFC 7636 requires the verifier to match the code challenge that was used to obtain the code; without it, Google's token endpoint returns `invalid_grant`. Even if we somehow got past that, we'd be on the hook to track every credential schema change Gemini CLI ships.

**Correct design** (now in DEFERRED.md bug #102/#115):

Shelly's job is *only* to open the OAuth URL in a safe Custom Tab. The CLI's own loopback server (`http://127.0.0.1:<port>/...`, RFC 8252) receives the callback. CLI does the token exchange (it has the verifier) and writes its own credential file. Shelly detects completion via credential file mtime + `gemini --version` smoke.

```
[Gemini CLI generates OAuth URL with redirect_uri=http://127.0.0.1:<port>/...]
[CLI wrapper → file-queue { provider: "google", authMode: "external-browser", url }]
[RN main thread → WebBrowser.openBrowserAsync(url) → Custom Tabs]
[Real Chrome process — no `wv` token, no X-Requested-With]
[User signs in → Google redirects to 127.0.0.1:<port>]
[CLI's loopback server receives code → token exchange (CLI has PKCE verifier) → writes credentials]
[Shelly polls credential file mtime + gemini --version smoke → completion]
```

A-G judgments captured in DEFERRED.md include:
- ✅ `openAuthSessionAsync` should work under Knox (RN main thread Activity API, not `am start`)
- ✅ Loopback `http://127.0.0.1:<port>/...` is the right scheme (RFC 8252)
- ⚠️ WebView fallback is **NG** — Google explicitly blocks it
- ✅ Serialize multiple OAuth flows (Custom Tabs owns activity stack)
- ⚠️ Don't trust browser result alone for completion — use credential file mtime + smoke

Estimated implementation: 4-6 hours (was anticipated as multi-day with the wrong design).

## Knox / Android specific findings (carried forward)

The session reinforced three constraints documented earlier:

1. `am start` from app uid is structurally blocked by Knox sepolicy → file-queue + RN main thread dispatch
2. Shebang scripts in `app_data_file` aren't exec-able → native binary in `jniLibs/` + symlink from `$libDir`
3. WebView `wv` UA + `X-Requested-With` header for OAuth fingerprinting → Phase 1.2 Custom Tabs

Phase 1.2 design now correctly accounts for #1 (openBrowserAsync goes through Activity context, not `am start`) and #3 (Custom Tabs uses real Chrome process). Updated CLAUDE.md still applies.

## Open follow-ups

| Item | Where | Priority |
|---|---|---|
| Real-device verification of #41 (`claude` REPL) | post-build-832 install | P0 (current session) |
| Real-device verification of #42 (URL bar typing) | post-build-832 install | P0 |
| Real-device verification of #43 (YouTube + keyboard) | post-build-832 install | P0 |
| Phase 1.2 implementation per new design | bug #102/#115, DEFERRED.md | P1 |
| Bun polyfill improvements + dedicated preload file | bug #139, DEFERRED.md | P1 |
| Stage 2/3 keyboard avoidance (adjustNothing) | only if Stage 1 insufficient | conditional |
| YouTube fullscreen smoke test | bug #138 | P1 |
| Multi Browser Pane navigate target | bug #136 | P1 |
| `ensureBrowserPane` DRY | bug #137 | P2 |

## Things this session did NOT touch

- `shelly-musl` trampoline (Claude Code musl SEA on bionic) — unchanged from build #808
- CLI auto-updater pipeline (`__shelly_bg_cli_update`) — unchanged; Codex review deferred until reliability concern surfaces
- Knox sepolicy workaround pattern — unchanged
- Theme runtime swap mechanism — unchanged
- Savepoint auto-save bridge — unchanged

## Verification recipe (for next session)

After installing build #832 (or any of #832-#836 — runtime is identical, #44/#45 are docs only):

```bash
# 1. Bun polyfill propagation
adb logcat -s HomeInitializer:* | head -20  # expect "BASHRC_VERSION 82 regenerated"
ls -la ~/.shelly-claude-node-preload.js     # expect Bun.which / semver / YAML in heredoc
claude --version                            # expect version string, not crash
claude                                      # expect REPL prompt
```

UI checks:
- Open Browser Pane in compact split. Tap URL bar, type "youtube.com" via Samsung IME. Each character should appear immediately, font readable.
- Submit, watch YouTube load. Tap URL bar mid-page-load. Typed text should NOT be overwritten by background nav events.
- Open YouTube. Focus URL bar to bring up keyboard. Search bar should stay singular, video grid should stay rendered, no black sections.
- Dismiss keyboard. Page should remain rendered (regression check).

If any of the above fails, capture logs and screenshot — the fix landed but didn't propagate, OR Stage 2 work is needed.

## Process / harness notes

- Two internal agents reviewed PR #42 in parallel (state/logic + RN/Android). They caught a real bug (back-button blur) and a duplicate anti-pattern.
- Codex (external) reviewed both the WebView/keyboard hypothesis and the Phase 1.2 OAuth design. Both reviews changed the implementation direction — the WebView fix went minimal (Stage 1 only) instead of the full triple-stage refactor; the Phase 1.2 design pivoted from "Shelly owns callback + token exchange" to "Shelly opens browser, CLI owns everything else".
- The user's "Agent review before push" pattern was applied throughout: each risky change had explicit review pass before commit/push.
- Squash-merged in dependency order #41 → #42 → #43; #43 hit a *semantic* conflict on rebase (textually clean merge, would fail to compile because #42 added new uses of imports #43 deleted) and was fixed by hand-restoring imports.
