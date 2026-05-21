# 2026-05-21 — Claude Code Bash tool handoff

Date: 2026-05-21
Repo: github.com/RYOITABASHI/Shelly — `main` at `d6da5934`
Device: Galaxy Z Fold6 / SM-F956Q / Android 16

This is the single pickup point for resuming the Claude-Code-Bash-tool work in
any environment. Read this, then the file map at the end.

## Goal

Make the latest Claude Code usable inside Shelly with no friction — the user
should not be able to tell it apart from a normal terminal. "Latest" must keep
working as Anthropic ships new Claude Code releases.

## Resolved this session (done, on `main`)

- The CI step `Validate bionic exec wrapper in APK` was false-negativing: it
  used `strings` to find a build marker, which scans a build-config-dependent
  subset of ELF sections. Replaced with a deterministic whole-file `grep -aF`
  byte scan. `main` CI is green again (build run 26213636222).
- `main` = `d6da5934` = a deliberately CLEAN state: the CI marker fix +
  `exec-wrapper.c` v183 null-deref hardening ONLY. Verified on-device: normal
  terminal, `codex --version`, `bash -c 'echo ok'` all work — no regression.

## Open problem (NOT fixed)

Claude Code's internal **Bash tool** fails every command with `Exit code 1`
and empty output, inside Shelly. `claude --version`, the TUI, and a direct
`"$SHELL" -lc '...'` smoke all work — only the tool subprocess path fails.

This is pre-existing and deep: `docs/.../2026-05-17-claude-2.1.143-update-notes.md`
records ~40 `.bashrc_version` iterations (148→186) attacking it before this
session. This session added 7 more APK builds. Still unsolved.

## What was tried and REVERTED — do not repeat as guesses

Three native `exec-wrapper.c` changes were made then judged unproven and
reverted (the `revert f040c0ae` + clean cherry-pick that produced `d6da5934`):

- **v184 "relay self-propagation"** (`is_exec_relay` / `relay_envp`, inject
  `LD_PRELOAD`/`SHELLY_LIB_DIR` into every linker64-redirected child) —
  reverted. It rewrites the env of `/system/bin/env|sh|timeout` and every
  app-private child, i.e. it affects Codex / normal terminal too, not just
  Claude. Real regression risk; did not fix the Bash tool.
- **v185 "shrink execve stack frame"** (`MAX_ARGC`/`MAX_ENVP` 4096→1024/512) —
  reverted. Based on a "the 82 KB `execve` frame overflows forked-child stacks"
  theory that the next build disproved. `MAX_ENVP=512` also introduces a new
  failure mode (large envs fail-fast).
- **`$HOME/bin/bash` → `shelly_shell` symlink** (commit `f040c0ae`) — reverted.
  Unverified; the APK nativeLibraryDir is empty on this device so a standalone
  launcher has no exec-permitted home anyway.

KEPT (genuine, on `main`): v183 hardening — `build_linker_argv`'s `out[2]`
was left uninitialized for an empty argv (a real crash cause), plus NULL guards
in `copy_rewrite` / `env_value_direct`, and the `retain` attribute on the build
markers (without it the marker can be `--gc-sections`'d and CI validation goes
false).

Every diagnosis this session (null-deref → EACCES/relay → stack overflow) was
stated confidently then disproven by the next build.

## The biggest lesson

The session burned 7 builds (~24 min each) at a ~0% hit rate because it
debugged a native crash with NO observation tooling — guess, build, test via
screenshots, repeat. An independent review called it a "guess loop, not a fix
loop."

**Next time: no guess-builds. Establish observation first.**

## Concrete next steps

1. **Establish observation tooling** (pick one):
   - Build `libexec_wrapper.so` with symbols (`-g`, same release flags/NDK so
     `.text` offsets match), capture a matching-build tombstone, `addr2line` it.
   - Bundle a static aarch64 `strace` into the APK and run the Bash-tool canary
     under it: `strace -ff -e trace=execve,execveat,clone,posix_spawn` — this
     cannot be bypassed by any layer.
   - A one-off diagnostic build that adds unconditional raw-syscall step logging
     inside `exec-wrapper.c`'s `execve()` (after rewrite / after
     `should_linker_exec` / after `build_linker_argv` / before
     `raw_execve_call`) so the log pinpoints the last step before each crash.
2. With observation in place, pin the exact crash point, then fix. Native bugs
   are usually 1–2 iterations once you can see them.

## Device-side tracing pitfalls (so the next person does not lose hours)

- `shelly-claude-bash-trace` (a `claude --print` canary) HANGS — a v161-era
  known issue; do not rely on it.
- Manually `export`ing the native trace gates (`SHELLY_CLAUDE_NATIVE_TRACE`,
  `SHELLY_CLAUDE_CANARY_TRACE`) breaks `claude` startup (v172/v173 footgun;
  `claude()` is meant to set them only internally and scoped).
- Even `SHELLY_CLAUDE_PATCH_TRACE=1` alone can prevent `claude` from launching.
- Crash-loops leave orphaned `linker64` processes that gum up the runtime —
  fully closing/reopening the Shelly app clears them.
- An interrupted runtime update leaves a half-extracted
  `~/.shelly-runtime/.tmp/...` tree; `linker64` then SIGBUSes loading it.
  Clear `.tmp` / reinstall the APK for a clean baseline before trusting results.
- The app is a non-debuggable release build, so `adb run-as` cannot read
  app-private files — on-device logs must be read from inside a Shelly terminal.

## Failure mechanism (best current understanding — unconfirmed)

Claude's Bash tool builds a nested `bash -c "... cd <cwd> && env <vars>
$HOME/bin/bash <flags> <cmd> ..."`. The inner `$HOME/bin/bash` is an app-private
ELF that must run via `/system/bin/linker64` (Android SELinux blocks direct
`execve` of `app_data_file`). When the nested `env` scrubs `LD_PRELOAD`, the
`libexec_wrapper.so` execve interposer is no longer present to do that
redirection. A device trace once showed every Claude child dying with
`signal=SIGSEGV` and no tombstone — consistent with a crash in the wrapper's
`execve` interposer in a forked child. The exact crash point was never pinned.

## Structural problem & the real long-term fix

Claude Code is a Bun single-executable. Shelly extracts `cli.js` from its
`.bun` section and re-hosts it on a bundled bionic Node + a Bun→Node polyfill,
because the native Bun SEA crashes on this device. The `.bun` layout, the
`child_process`/`env` command shapes, and the `Bun.*` API surface are private
internals with no stability contract — they churn every Claude release (Bun
version bumps, bundler re-layout, tool-execution + security-hardening
iteration). You cannot win by tracking an unstable internal.

Long-term direction (designed, not yet built):
1. Minimize the surface that depends on Claude's internal shapes — prefer a
   single invocation-shape-agnostic chokepoint over per-shape matchers.
2. Make the runtime updater gate promotion on a real functional canary
   (`print-ok` + `bash-tool`), and keep a `last-good` runtime for silent
   automatic rollback, so a broken Claude release never reaches the visible
   `claude` command. This accepts the churn instead of racing it.
   See the "Background Updater Policy" section of the 2026-05-17 doc.

## File map

- `modules/terminal-emulator/android/src/main/jni/exec-wrapper.c` — the
  `LD_PRELOAD` `execve`/`posix_spawn` interposer (the suspected crash site).
- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt`
  — generated `.bashrc`, the Claude Node preload + `child_process` patch,
  `claude()` tier routing, `BASHRC_VERSION` (currently 184 on `main`).
- `modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js`
  — runtime cli.js extraction, the updater, the canary policy.
- `.github/workflows/build-android.yml` — CI; the marker validation step.
- `docs/superpowers/specs/2026-05-17-claude-2.1.143-update-notes.md` — the full
  ~40-iteration investigation history.
- `docs/superpowers/DEFERRED.md` — the Bash tool is registered there (P1).
