# Build 808 — Claude harness rework (raw-syscall wrappers + Bun .node patch + legacy pin + TLS fix)

**Date**: 2026-05-06
**Builds**: 803 → 804 → 807 → 808
**Release**: v5.2.0
**Devices verified**: Galaxy Z Fold6 / Android 16

## Why this release exists

A 24-hour churn between two CI cache states surfaced four overlapping
problems in Shelly's Claude / Codex / Gemini harness. None of them was
caused by an Anthropic upgrade — every single root cause was something
Shelly had been masking. Cache invalidation cascades exposed them one
by one.

## What broke

| # | Symptom | Root cause |
|---|---|---|
| 1 | `cat ~/.bashrc_version` SIGSEGV at `pc=0x1ff0` (PLT trampoline) inside `libexec_wrapper.so:execve+0x30` | bionic `libexec_wrapper.so` rebuild in fresh CI cache produced a binary where `dlsym(RTLD_NEXT, "execve")` lazy-PLT entry was never resolved by the Android dynamic linker. Cached pre-bug binaries had been protecting users until a `.c` edit invalidated the cache. |
| 2 | Claude Code 2.1.129/2.1.131 native musl Bun SEA `panic: Segmentation fault at address 0x10` while loading `audio-capture.node` / `image-processor.node` | Bun's SEA loader extracts embedded `.node` add-ons to `$BUN_TMPDIR`, then `process.dlopen()`s them. Two specific add-ons in Anthropic's 2.1.x SEA segfault on Android arm64 musl during ELF init — upstream Bun bug, unchanged across 1.3.13 / 1.3.14. |
| 3 | `__shelly_bg_cli_update` health check `[health] node --version FAILED` because `grep` SEGVed in any pipeline | Codex's raw-syscall wrapper rewrite removed PLT deps (dlsym, log, etc.), but `static __thread char rewrite_buf[]` for the `/bin/X → /system/bin/X` rewrite path still pulled in Clang's emulated-TLS helper, which itself had unresolved PLT references. Pipe context happened to hit the `/bin/grep` rewrite branch. |
| 4 | `npm install @anthropic-ai/claude-code@latest` produced a tree without `cli.js` (just `cli-wrapper.cjs` + `bin/claude.exe`) | Anthropic restructured the npm package at 2.1.113 — `cli.js` is gone from the main package; the binary is shipped via per-platform optional deps. Shelly's `--omit=optional` install can't reach those, so `~/.shelly-cli` stays unpopulated past 2.1.112. |

## Fixes (per commit)

### 70106f92 `fix(exec): use raw syscalls in preload wrappers`
- Rewrote `exec-wrapper.c` and `exec-wrapper-musl.c` to invoke raw arm64
  `svc #0` syscalls (`__NR_execve`, `__NR_clone`, `__NR_openat`,
  `__NR_read`, `__NR_close`, `__NR_exit_group`) instead of `dlsym(RTLD_NEXT,
  ...)` + libc forwards.
- Removed `target_link_libraries(exec_wrapper dl log)`; added
  `-fno-builtin -fno-stack-protector` to keep the wrapper minimal.
- Inlined `streq` / `starts_with` / `ends_with` to avoid pulling in
  libc string ops.
- bash → `$libDir/libbash.so` rewrite still passes through the linker64
  trampoline because `should_linker_exec` re-evaluates on the rewritten
  path.
- Verified on device: `cat`, `claude`, Bash tool inside Claude all work.

### b01c9902 `fix(claude): avoid Bun SEA native addon crash`
- Set `BUN_TMPDIR=$HOME/.bun-tmp` in the bashrc so Bun's `.node`
  extraction lands in a known writable directory (Bun's defaults walk
  `BUN_TMPDIR / TMPDIR / TMP / TEMP`, and the `.node` filename is
  hash-prefixed so a stale cache can't be reused safely).
- Added a single-shot retry on `__runtime_rc` ∈ {134, 139, 159}: clear
  `$__bun_tmp/.*.node` and re-exec the same binary. Catches transient
  extraction races without relaunching the entire shell.
- Added `runClaudeNative` env (CLAUDE_BUN_TMP) to the runtime updater
  so candidate validation uses the same writable directory as the
  user-facing path.
- **Byte patch**: replaced the SEA's `audio-capture.node` /
  `image-processor.node` loader call sites with constant-`null`
  returns. Same length so offsets stay stable. Voice native input and
  the image processor become unavailable; Claude Code's existing JS
  fallbacks handle the "feature missing" case. Patch is applied both
  by the runtime updater (for fetched SEAs) and by CI at APK build
  time (for the bundled `libclaude.so`).

### 07a4c4ba `feat(v76): legacy pin + Bun.hash polyfill + ALWAYS_REFRESH + Quick Launch`
- Pinned `__shelly_bg_cli_update` to
  `@anthropic-ai/claude-code@${SHELLY_LEGACY_NPM_PIN:-2.1.112}`. 2.1.113+
  is structurally unreachable from a Node-only path because Anthropic
  removed `cli.js` from the npm tarball; pin makes the floor explicit.
- Added a SHA-256-backed `Bun.hash(input, seed)` polyfill (default + named
  variants — wyhash / cityHash32/64 / xxHash3/32/64 / murmur32v2/v3 /
  murmur64v1/v2 / rapidhash / adler32 / crc32). Polyfill ships in both
  the `~/.shelly-claude-node-preload.js` heredoc and the runtime updater's
  `CLAUDE_BUN_NODE_POLYFILL` constant. Honours the `seed` argument so
  `Bun.hash(K, Bun.hash(q))` doesn't collapse to one value across q's.
- Added `libexec_wrapper.so` and `claude` to `LibExtractor.kt`'s
  `ALWAYS_REFRESH` set so wrapper rewrites and byte patches reach
  existing devices on app upgrade without a `versionCode` bump.
- `claude()` bash function records crash-class native-tier exits to
  `~/.shelly-runtime/.runtime-failures` (4-column format
  `claude=<ver> <epoch> <rc> <tier>`). The updater consumes the file at
  the start of `updateClaude()` and feeds each version to
  `recordFailedVersion`, which puts the version into the cooldown list
  so the next walk-back skips it.
- `BASHRC_VERSION` 73 → 76 so v75 feature-branch installs regenerate.
- New **Quick Launch** sidebar section between TASKS and REPOSITORIES:
  three chips (Claude / Codex / Gemini) that open a fresh Terminal pane
  and queue the matching CLI as `pendingCommand`.

### 8ed8fdac `fix(exec): avoid TLS in preload wrappers`
- Removed `static __thread char rewrite_buf[PATH_BUF_SIZE]` from both
  wrappers; the buffer is now allocated on the `execve()` caller's stack
  and threaded through `rewrite_path()` as a parameter. Eliminates the
  emulated-TLS helper PLT chain the `/bin/X` rewrite branch was hitting.
- Removed `errno = ...` writes from the wrappers (errno is also TLS-
  backed on bionic/musl). Failures are surfaced through the syscall
  return values directly.
- Verified: `echo X | grep Y` works, `__shelly_bg_cli_update` health
  check passes.

### e911fbc7 `fix(quick-launch): compact chip layout + Anthropic orange for Claude`
- Quick Launch chips were too wide (flexWrap pushed them onto a second
  row on standard sidebars). Switched to `flexWrap: nowrap` with
  shrunk padding (6/2) and 9/11 fonts so all three chips fit on one row.
- Claude chip color changed from `#A78BFA` (purple) to `#CC785C`
  (Anthropic's official copper/orange). Emoji 🟣 → 🟠. Codex green and
  Gemini blue stay.
- Label "Claude Code" → "Claude" so all three brand names share a
  compact footprint.

## Verified end-to-end on Galaxy Z Fold6 (build 807, post-merge)

```text
~$ cat ~/.bashrc_version
76

~$ SHELLY_VERBOSE_CLI_TIER=1 claude --version
[shelly] claude: runtime latest (musl Bun SEA)
2.1.131 (Claude Code)

~$ SHELLY_PREFER_NATIVE_CLAUDE=1 claude
 ▐▛███▜▌   Claude Code v2.1.131
▝▜█████▛▘  Opus 4.7 (1M context) · Claude Max
❯ echo hello を bash tool で実行して
● Bash(echo hello)
  ⎿  hello
```

Sidebar **QUICK LAUNCH** section visible with Claude / Codex / Gemini
chips between TASKS and REPOSITORIES.

## Known limitations

- Claude Code voice native input (`audio-capture.node`) and image
  processor native paths (`image-processor.node`) are disabled. JS
  fallbacks cover the "feature missing" case. Re-enable by patching
  `shelly-runtime-update.js` to skip the byte patch (set
  `SHELLY_PATCH_CLAUDE_NATIVE_ADDONS=0`) once Bun upstream fixes the
  Android arm64 musl `.node` SEGV.
- `~/.shelly-cli` legacy-tier install still goes through the standard
  npm path with `--omit=optional`, so 2.1.113+ won't populate `cli.js`
  even though the pin lets 2.1.112 land cleanly. Future work could
  add the platform-specific dep `@anthropic-ai/claude-code-linux-arm64-musl`
  as a separate install step if a future Anthropic release decouples
  the wrapper from the platform binary.
- `LibExtractor.kt`'s `ALWAYS_REFRESH += "claude"` re-extracts
  ~220 MB on every app launch. Long-term: switch to a sha/build-marker
  diff refresh.

## Companion specs

- [`2026-04-29-build-769-cli-harness.md`](2026-04-29-build-769-cli-harness.md)
  — predecessor harness (extracted-Node tier as default).
- [`2026-04-29-claude-extracted-runtime-updater.md`](2026-04-29-claude-extracted-runtime-updater.md)
  — original runtime updater design.
- [`2026-05-01-build-782-security-harness.md`](2026-05-01-build-782-security-harness.md)
  — credential hygiene + log redaction.
