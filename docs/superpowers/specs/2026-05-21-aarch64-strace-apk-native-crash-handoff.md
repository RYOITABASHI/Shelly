# 2026-05-21 — aarch64 strace bundled in APK for native crash observation

## Summary

Shelly now bundles a CI-built aarch64 `strace` in the APK so device-side
agents can collect syscall traces for native crash debugging. This is the
observation prerequisite for resuming the deferred Claude Code Bash tool
`Exit code 1` investigation without guesswork builds.

Branch / commit:

- Branch: `codex/aarch64-strace-debug`
- Commit: `92f89af2 feat(android): bundle musl strace for crash tracing`
- CI: <https://github.com/RYOITABASHI/Shelly/actions/runs/26237234723>
- Artifact: `shelly-apk` / artifact id `7141573254`

## Implementation

- `.github/workflows/build-android.yml`
  - Reuses the existing Alpine aarch64 + QEMU payload build container.
  - Builds upstream `strace` v6.16 from source instead of bundling Alpine's
    packaged `strace`.
  - Configures strace with:
    - `--enable-mpers=no`
    - `--enable-stacktrace=no`
    - `--without-libdw`
    - `--without-libunwind`
    - `--without-libiberty`
  - Bundles only `lib/arm64-v8a/libstrace.so`.
  - Cleans `/tmp/musl-out`, source tarballs, and Docker images before Gradle
    packaging to avoid GitHub runner disk exhaustion.

- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt`
  - Extracts `lib/arm64-v8a/libstrace.so` to `$SHELLY_LIB_DIR/strace`.
  - Keeps `strace` in `ALWAYS_REFRESH`.
  - Deletes obsolete `libstrace_*` files left by the rejected Alpine package
    candidate.

- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt`
  - Adds PATH-visible `strace()` wrapper.
  - Adds `SHELLY_DEBUG_DIR=/sdcard/Download/shelly-debug`.
  - Adds `shelly-debug-dir` and `shelly-strace-debug`.
  - `BASHRC_VERSION=186`.

- `modules/terminal-emulator/android/src/main/jni/shelly-musl-exec.c`
  - Supports ET_DYN musl executable targets such as strace by setting target
    auxv (`AT_PHDR`, `AT_ENTRY`) and musl loader `AT_BASE`.

## Rejected Candidate

Candidate A, `apk add strace` inside Alpine and copy `/usr/bin/strace`, was
not viable on device.

Observed failure from the CI artifact at `4df417e9`:

```text
Error loading shared library wfl_module_relocate_address: No such file or directory
Segmentation fault
```

Root cause: Alpine packaged strace pulls elfutils/libdw stack-tracing
dependencies with versioned `dwfl_*@ELFUTILS_*` symbols. Those dependencies do
not resolve correctly in Shelly's Android + bundled musl-loader launch path.

## Verification

CI:

- Run `26237234723` completed successfully.
- APK inspection confirmed:
  - `lib/arm64-v8a/libstrace.so` exists.
  - No `libstrace_dw.so`, `libstrace_elf.so`, `libstrace_fts.so`,
    `libstrace_bz2.so`, `libstrace_lzma.so`, `libstrace_z.so`, or
    `libstrace_zstd.so` are present.
  - `readelf -d libstrace.so` shows only:

```text
NEEDED Shared library: [libc.so]
```

Real device:

- Device: Galaxy Z Fold6 / `SM_F956Q`
- Installed artifact APK:
  `/tmp/shelly-strace-apk-92f/artifact/app-release.apk`
- Smoke command:

```sh
mkdir -p /sdcard/Download/shelly-debug
strace -o /sdcard/Download/shelly-debug/smoke.log -e trace=execve echo ok
```

- Verified log:

```text
execve("/bin/echo", ["echo", "ok"], 0x7bfdc607e8 /* 55 vars */) = 0
+++ exited with 0 +++
```

## Notes for Next Claude Bash Tool Session

Use the external debug dir so wireless debugging / PC-side adb can read traces:

```sh
mkdir -p /sdcard/Download/shelly-debug
shelly-strace-debug claude-bash \
  -tt -s 256 -e trace=execve,execveat,clone,vfork,fork \
  -- env LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so" \
     timeout 90 bash -lc shelly-claude-bash-canary
```

Then pull logs with adb:

```sh
adb shell 'ls -l /sdcard/Download/shelly-debug'
adb pull /sdcard/Download/shelly-debug ./shelly-debug
```

Do not resume the Claude Bash tool fix by changing wrappers blindly. First run
the canary under `strace` and identify the exact `execve` / `clone` boundary
where the failure occurs.

2026-05-22 follow-up observation:

- `strace echo ok` still passed on the CI-built APK artifact from run
  `26259019707`.
- The Bash-tool canary reached Claude Code and spawned children; no
  `SIGSEGV` / `SIGABRT` / `SIGBUS` / `SIGILL` appeared in the 163 trace files.
- The only hard execution denial was:

```text
execve("/data/user/0/dev.shelly.terminal/files/home/bin/npm",
       ["npm", "root", "-g"], ...) = -1 EACCES (Permission denied)
```

- That is the known Android/Samsung app-private shebang-script class, not a
  native crash. The follow-up fix is in `libexec_wrapper.so`: app-private
  `sh` shebang scripts are re-executed as `/system/bin/sh <script> ...`
  before the kernel hits the direct app-data `execve`.
- The outer `strace()` helper intentionally clears `LD_PRELOAD` for strace
  itself. When tracing Claude/Bash paths that need Shelly's bionic exec
  wrapper, pass `env LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so"` after
  the `--` as shown above.

## Review

Agent review was performed during this work. Findings fixed before final push:

- Fixed broken CI shell quoting from apostrophes inside a single-quoted
  container script.
- Removed stale `libstrace_*` extraction entries and added cleanup for existing
  devices.
