# 2026-04-28 Size Reduction Handoff

Branch: `size/allowlist-strip`
Base: `origin/main` at `8f4813d0`

## Goal

Reduce the v5.1.0 APK size without repeating the bug #142 keyboard
regression caused by broad native-library stripping.

Current published v5.1.0 release asset:

```text
shelly-v5.1.0.apk = 907,967,765 bytes (~866 MiB)
```

## Important prior attempt

The previous Tier-2/Tier-3 size reduction attempt is intentionally not on
`main`.

- Tier-2: `dec73b30` stripped the whole `jniLibs/arm64-v8a/*.so` tree.
- Tier-3: `a9172e91` removed `cli-tools.tar.gz` and relied on first-launch
  lazy fetch.
- Combined candidate `#755` produced a Z Fold6/Nacre IME regression: Android
  reported `mInputShown=true` and `mImeWindowVis=3`, but the keyboard did not
  draw.

Conclusion: do not sweep-strip RN/Hermes/Reanimated/libc++/terminal-view
native libraries until the IME regression is isolated.

## This branch

This branch implements the conservative first step only:

```text
libclaude.so
libcodex_exec.so
libcodex_tui.so
```

The new CI step is named:

```text
Strip large AI runtime binaries (allowlist size reduction)
```

It runs after all three files are created/downloaded and before Gradle
packages the APK.

Behavior:

- requires all three files to exist
- runs `aarch64-linux-gnu-strip --strip-unneeded`
- fails loud if strip fails
- verifies each output is still a 64-bit ELF with `file`
- prints `readelf -h` Type/Machine
- prints per-file and total byte savings

It deliberately does not touch:

- `libc++_shared.so`
- React Native / Hermes / Reanimated libraries
- terminal-view / terminal-emulator JNI libraries
- musl loader / trampoline / exec wrappers
- checked-in Termux-derived toolchain libraries

## Expected impact

Estimate before CI:

- `libclaude.so`: 30-60 MiB APK savings if Anthropic ships symbols/debug
- `libcodex_exec.so` + `libcodex_tui.so`: 20-40 MiB combined if upstream
  codex-termux ships symbols/debug
- total first-pass target: 50-100 MiB without changing runtime behavior

Actual savings must be read from the CI log:

```text
[allowlist-strip] ... saved N
[apk-size] android/app/build/outputs/apk/release/...apk: ... bytes (... MiB)
```

## Required device smoke

Install the APK from this branch and run the same minimum regression set:

```sh
cat ~/.bashrc_version
claude --version
claude --print "Use bash to run: echo shelly-ok"
codex --version
gemini --version
```

Manual UI checks:

- soft keyboard opens and draws in terminal pane
- input lands in focused pane
- paste into Claude/Codex/Gemini still behaves as one paste block
- `codex` TUI starts
- `gemini` starts

If any keyboard/IME regression appears, revert this branch. The point of this
branch is to prove the safe allowlist path before considering Tier-3 lazy fetch.

## Next possible step after PASS

Only after this branch passes device smoke:

1. Add a friendly not-yet-installed stub for `gemini()` when the npm tier is
   absent.
2. Retry Tier-3 lazy fetch for Gemini/Codex JS bundle.
3. Keep native runtime binaries in APK until first-launch offline behavior is
   explicitly redesigned.
