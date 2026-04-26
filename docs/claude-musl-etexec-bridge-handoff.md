# Claude musl ET_EXEC bridge handoff

Date: 2026-04-27
Branch: `fix/claude-musl-etexec-bridge`
Base: `main`

## Problem observed on device

Device smoke log:

```text
### claude --version
error: "/data/data/dev.shelly.terminal/files/termux-libs/claude" has unexpected e_type: 2
rc=1
```

`e_type: 2` is `ET_EXEC`. The Claude Code Bun SEA binary is a musl `ET_EXEC`
payload. It must not be handed directly to Android's bionic
`/system/bin/linker64`.

The earlier `__errno_location` failure was a separate LD_PRELOAD leak:
bionic linker was loading the musl-built preload library. That is handled by
launching the musl path with `env -u LD_PRELOAD` and using
`SHELLY_MUSL_LD_PRELOAD` for musl only.

The remaining failure path is:

```text
Claude/Bun musl process
  -> child_process / execve / posix_spawn
  -> libexec_wrapper_musl.so intercepts
  -> app-data ELF gets routed to /system/bin/linker64
  -> bionic linker rejects musl ET_EXEC with "unexpected e_type: 2"
```

## Implementation in this branch

Files changed:

- `.github/workflows/build-android.yml`
- `modules/terminal-emulator/android/src/main/jni/exec-wrapper.c`
- `modules/terminal-emulator/android/src/main/jni/shelly-musl-exec.c`
- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt`
- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt`

Key behavior:

- CI now builds `libexec_wrapper_musl.so` from the same `exec-wrapper.c` inside
  the Alpine aarch64 musl container.
- `LibExtractor` extracts `libexec_wrapper_musl.so` into Shelly's runtime lib dir.
- `claude()` exports:
  - `SHELLY_MUSL_EXEC=$libDir/shelly_musl_exec`
  - `SHELLY_MUSL_LD=$libDir/ld-musl-aarch64.so.1`
  - `SHELLY_MUSL_LD_PRELOAD=$libDir/libexec_wrapper_musl.so`
  - `SHELLY_BIONIC_LD_PRELOAD=$libDir/libexec_wrapper.so`
- `exec-wrapper.c` now has separate bionic vs musl behavior:
  - bionic build keeps the normal `/system/bin/linker64 <target>` route.
  - musl build sanitizes child env so musl `LD_PRELOAD` is not passed into
    bionic children.
  - musl build routes `ET_EXEC` app-data ELF through:

```text
/system/bin/linker64 $SHELLY_MUSL_EXEC $SHELLY_MUSL_LD <target> <args...>
```

- `shelly-musl-exec.c` converts `SHELLY_MUSL_LD_PRELOAD` into musl-side
  `LD_PRELOAD` only after the bionic trampoline has started. This keeps the
  bionic linker from loading the musl `.so`, while still loading
  `libexec_wrapper_musl.so` inside Claude/Bun.

This is intended to stop musl Claude/Bun child spawns from falling into bionic
`unexpected e_type: 2`.

## Local verification performed

Host syntax/build checks:

```sh
gcc -fsyntax-only -Wall -Wextra modules/terminal-emulator/android/src/main/jni/exec-wrapper.c

mkdir -p /tmp/android/android
printf '#pragma once\n#define ANDROID_LOG_INFO 4\n#define ANDROID_LOG_WARN 5\nint __android_log_print(int prio, const char *tag, const char *fmt, ...);\n' > /tmp/android/android/log.h
gcc -D__ANDROID__ -I/tmp/android -fsyntax-only -Wall -Wextra modules/terminal-emulator/android/src/main/jni/exec-wrapper.c

gcc -shared -fPIC -O2 modules/terminal-emulator/android/src/main/jni/exec-wrapper.c -o /tmp/libexec_wrapper_musl.so -ldl
file /tmp/libexec_wrapper_musl.so
readelf -h /tmp/libexec_wrapper_musl.so | grep -E 'Type|Machine'
```

Expected output for the last check:

```text
Type: DYN (Shared object file)
Machine: AArch64
```

## Required next validation

After CI APK installs on device:

```sh
cat ~/.bashrc_version
type claude | head -n 80
ls -l /data/user/0/dev.shelly.terminal/files/termux-libs/libexec_wrapper_musl.so

claude --version
claude --print "Say OK"
claude --print "Use bash to run: echo shelly-ok"
```

Expected progression:

- `__errno_location` must not appear.
- `unexpected e_type: 2` must not appear.
- If `--version` passes but Bash tool fails, inspect child spawn path next.

## Related observed device state

From 2026-04-27 device diagnostic:

```text
~/.shelly-runtime/claude/current -> 2.1.120
~/.shelly-runtime/codex/current -> v0.124.0-termux
~/.shelly-cli @google/gemini-cli -> 0.39.1
~/.shelly-cli @openai/codex -> 0.125.0
~/.shelly-cli @anthropic-ai/claude-code -> 2.1.119
```

Note: device diagnostics that wrap shell functions with `timeout claude` /
`timeout codex` can be misleading because `timeout` resolves external commands,
not shell functions. Use `bash -lc 'source ~/.bashrc; claude ...'` or run the
commands directly in the interactive Shelly shell.
