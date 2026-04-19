# Shelly v0.1.0-rc2 — Release Notes draft

> Incremental RC2 on top of [rc1](./RELEASE-v0.1.0-RC.md). Only call out
> what changed; rc1 notes still apply to everything else.

## What changed since rc1

### Fixed

- **Ask Pane Stage 2: "GitHub Issue を作成" button now actually posts
  on first tap.** The Stage 1→2 upgrade shipped in rc1 wired the UI
  but `readShellyCSToken()` used `FileSystem.getInfoAsync` which
  returned `exists: false` for the token path on Expo SDK 52 against
  Shelly's Plan-B home directory — the canonical-vs-symlinked path
  forms disagreed. Added a fallback via the JNI `execCommand` bridge
  (`cat $HOME/.shelly-cs/token`) that guarantees the token round-trip
  works regardless of FileSystem URI quirks. Logs which path resolved
  so future regressions are trivial to diagnose from logcat.
  (Commit `84bc4198`.)

### Docs

- Verification checklist for post-break sessions:
  [`docs/verification-next-session.md`](./verification-next-session.md).
  Single-source-of-truth runbook to restart work from any state
  without chat context.

## Still deferred (unchanged from rc1)

- `shelly-cs ssh` real tunneling — branch `feat/ssh-tunneling` has
  Day 1 (lazy-install scaffold) + Day 2 draft (tunnel-client library,
  not yet wired). v0.1.1 target.
- Ask Pane Stage 3 (dedup search, category labels, history, voice
  input, full-text ingestion).
- Sidebar CODESPACES section — follows Worktrees pattern, depends on
  Ask Pane and SSH dogfood.
- SecureStore bridge for the shelly-cs token — file-based 0600 is
  adequate; expo-file-system quirk exposed today pushed us to also
  support execCommand fallback, which is the more robust path anyway.

## Verification (device smoke test for rc2)

```
+ → Ask Shelly
> VR 対応してる？
[wait for ❌ 未実装 badge]
[tap] 📝 GitHub Issue を作成
[preview modal opens; body pre-populated]
[tap] Create
[expect] spinner → modal closes → green chip "✓ Issue #NN を作成しました [View]"
[tap] [View]
[expect] Shelly Browser Pane opens the issue URL
```

If the `Create` tap yields "Not authenticated" again, check
`adb logcat -d -s ReactNativeJS:* | grep github-issues` — the
successful path prints `token read via execCommand` or `token read
via FileSystem`.

## Upgrade notes

- APK upgrade preserves `$HOME/.shelly-cs/` (including the token
  file), so if you ran `shelly-cs auth` before this update, you won't
  need to re-auth. The fix only changes the reader path.
- BASHRC_VERSION unchanged (37) — no `.bashrc` regeneration needed.
