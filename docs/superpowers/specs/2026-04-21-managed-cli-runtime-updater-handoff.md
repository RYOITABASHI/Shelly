# 2026-04-21 Managed CLI Runtime Updater Handoff

## Summary

Shelly now has a managed runtime updater path for Android-native Claude Code
and Codex binaries. The goal is to avoid requiring a new APK every time
Anthropic or Codex releases a CLI update.

Committed on branch:

```text
branch: claude/elegant-chatterjee-814adb
commit: 587ae514 feat(cli): add managed runtime updater
build run: 24712613556
```

Latest APK build for the current UI/theme pass:

```text
commit: db9dec07 feat(ui): add black editor theme presets
build run: 24714496665
status: completed
conclusion: failure
failed step: Download codex-termux Android binaries (exec + TUI)
```

Recent UI/logging follow-up:

```text
commit: 4aaa7a3c feat(ui): add recent logs modal
```

## What Changed

### Claude Code

Runtime priority is now:

```text
1. ~/.shelly-runtime/claude/current/claude
2. APK bundled musl Claude binary at $libDir/claude
3. legacy cli.js fallback, currently 2.1.112
```

The managed updater downloads:

```text
@anthropic-ai/claude-code-linux-arm64-musl@latest
```

It verifies npm `dist.integrity`, extracts `package/claude`, smoke-tests:

```bash
/system/bin/linker64 $libDir/shelly_musl_exec $libDir/ld-musl-aarch64.so.1 <staged-claude> --version
```

Only after success does it switch:

```text
~/.shelly-runtime/claude/current -> <version>
```

### Codex

Runtime priority is now:

```text
1. ~/.shelly-runtime/codex/current/codex_exec / codex_tui
2. APK bundled codex_exec / codex_tui
```

The managed updater downloads the latest release from:

```text
DioNanos/codex-termux
```

It verifies the `.sha256` asset, extracts:

```text
codex-exec.bin -> codex_exec
codex.bin      -> codex_tui
```

Then smoke-tests:

```bash
/system/bin/linker64 <staged-codex_exec> --version
```

Only after success does it switch:

```text
~/.shelly-runtime/codex/current -> <tag>
```

### Background Update

`HomeInitializer.kt` now emits:

```bash
shelly-update-clis() {
  SHELLY_LIB_DIR="$libDir" _run $libDir/node "$HOME/.shelly-runtime-update.js" "$@"
}
```

Terminal startup runs the managed updater in the background once per day.
Manual force update:

```bash
shelly-update-clis --force
```

Logs:

```bash
tail -f ~/.shelly-runtime/update.log
```

## Files Changed

```text
.github/workflows/build-android.yml
modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js
modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt
modules/terminal-emulator/android/src/main/jni/shelly-musl-exec.c
```

## Important Fixes Included

### Claude LD_PRELOAD fix

Path C-bis previously failed in Shelly because the PTY-wide bionic preload:

```text
LD_PRELOAD=$libDir/libexec_wrapper.so
```

was inherited by musl Claude. On-device failure:

```text
Error relocating .../libexec_wrapper.so: __register_atfork: symbol not found
Error relocating .../libexec_wrapper.so: __open_2: symbol not found
Error relocating .../libexec_wrapper.so: __errno: symbol not found
```

Fix:

```bash
LD_PRELOAD= _run "$__trampoline" "$__musl_ld" "$__runtime_claude" "$@"
LD_PRELOAD= _run "$__trampoline" "$__musl_ld" "$__musl_claude" "$@"
```

and `shelly-musl-exec.c` strips `LD_PRELOAD=` from the env passed to musl.

Confirmed on current installed APK by manually clearing `LD_PRELOAD`:

```bash
L=/data/user/0/dev.shelly.terminal/files/termux-libs
T=$L/shelly_musl_exec
M=$L/ld-musl-aarch64.so.1
C=$L/claude
LD_PRELOAD= _run $T $M $C --version
```

Result:

```text
2.1.116 (Claude Code)
```

API reachability also works; current user credentials are invalid:

```text
Failed to authenticate. API Error: 401 Invalid authentication credentials
```

This is an auth-file issue, not an execution/runtime issue.

### APK fallback Codex latest

The APK build workflow now resolves latest `DioNanos/codex-termux` release
instead of pinning `v0.121.0-termux`. On 2026-04-21 the latest observed release
was:

```text
v0.122.2-termux
```

## Gemini CLI

Gemini is not in the same category as Claude/Codex here:

```text
@google/gemini-cli@latest
```

is already installed by the existing npm-based `__shelly_bg_cli_update`
pipeline. It is JS bundle based, with Shelly patches for the Android/clipboard
guard and relaunch behavior. No new native runtime updater was added for Gemini
in this pass.

## Paste Decision

Terminal paste must preserve user content:

```text
copy has newline -> paste newline
copy is long one-line text -> paste long one-line text
visual wrapping must not become semantic rewriting
```

An attempted soft-wrap auto-join patch was removed. Terminal paste still does
the existing terminal-safe normalization:

```text
CRLF -> LF
strip ESC / C1 controls
send via bracketed paste
```

### UI / Performance Follow-up

- `ContextBar` now reads cwd directly instead of forking a shell every 15s.
- `Sidebar` Ports polling only runs while the Ports section is open and stops retrying after a permission failure.
- `AgentBar` now exposes a recent logs button that opens an in-app viewer.
- `ConfigTUI -> Export Logs` and the new viewer share the same formatter.

## Build / Verification

Local checks passed:

```bash
node --check modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js
git diff --check
```

GitHub Actions build started:

```text
workflow: Build Android APK
run: 24714496665
status: completed
conclusion: failure
started: 2026-04-21T09:21:00Z
```

## Next APK Smoke Test

After installing the produced APK:

```bash
cat ~/.bashrc_version
# expect: 48

claude --version
# expect runtime latest or APK Path C-bis, not legacy 2.1.112
# observed on-device: 2.1.116 (Claude Code)

codex --version
# expect latest codex-termux, e.g. 0.122.2-termux or newer
# if this fails, the APK likely stopped before the codex bundle step

shelly-update-clis --force
tail -f ~/.shelly-runtime/update.log

claude --version
codex --version

# open the in-app logs viewer and confirm:
# - latest terminal output is visible
# - Copy works
# - Share works
# - long output scrolls without lag
```

Expected routing after updater succeeds:

```text
[shelly] claude: runtime latest (musl Bun SEA)
```

Codex has no tier banner; inspect:

```bash
readlink ~/.shelly-runtime/codex/current
codex --version
```

This harness is now keyed to the latest installed APK. The exact APK build can
lag the runtime updater commit, but the verification target is unchanged:

```bash
shelly-update-clis --force
tail -f ~/.shelly-runtime/update.log
claude --version
codex --version
```

## Known Remaining Issue

Claude auth files currently exist but return 401:

```text
~/.claude.json
~/.claude/.credentials.json
```

Observed timestamps were mismatched:

```text
~/.claude.json              Apr 21 17:17
~/.claude/.credentials.json Apr 20 08:43
```

Refresh by transplanting both files from the same working Claude Code login
session.
