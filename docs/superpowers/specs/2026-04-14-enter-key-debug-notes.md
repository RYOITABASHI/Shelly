# Enter key double-press — Debug notes

**Status**: Unresolved, deferred to next session. Documented here so the
next investigation can start from a concrete hypothesis list instead of
re-deriving the whole call graph.

**Symptom**: In freshly-spawned PTY sessions, the *first* Enter after the
first prompt appears occasionally does nothing visible; pressing Enter
again renders the new prompt. Subsequent Enters are fine. Reproduces on
Z Fold 6 running the current `ee2c9572` build candidate.

## What's already been ruled out

### 1. Double-redraw on flush (already fixed — commit c4fb… see note)
`ShellyTerminalSession.flushOutputBuffer()` used to call
`onScreenUpdateCallback?.invoke()` from the 16 ms delayed batch. That
caused the View to redraw an older screen state *after* the Termux
`TerminalView.onTextChanged()` had already drawn the new one. The
delayed snapshot stomped the live one. Fixed by moving the redraw into
`onTextChanged` (line 149–170, `ShellyTerminalSession.kt`) and leaving
the batch flush strictly JS-output-only.

This is NOT the current bug — the fix shipped but the symptom persists.
The remaining Enter-key issue is something else.

## Current hypothesis list (ordered by likelihood)

### H1. `inputHandler.onKeyDown` never calls `session.write('\r')`

File: `modules/terminal-view/android/src/main/java/expo/modules/terminalview/ShellyTerminalView.kt:449`

The `TerminalView` from Termux has its own `TerminalKeyListener` that
processes Enter into `\r` and writes it directly to the session. But
we've wrapped the input in our own `inputHandler` for Ctrl+C/V. If our
handler returns `true` from `onKeyDown` for KEYCODE_ENTER *without*
forwarding the write, the first Enter is swallowed — but the key-repeat
or the next press hits a different code path and goes through.

**Next step**: `adb logcat` filter `ShellyInputHandler` while pressing
Enter. If no "KEYCODE_ENTER handled" log appears on press 1 but does on
press 2, H1 is confirmed.

### H2. Initial prompt draw races `mEmulator` readiness

Line 210: `terminalView.attachSession(shellySession.terminalSession)`
happens before the PTY child has printed its first byte. If the user
types Enter in the window between attach and the first `onTextChanged`
(empty prompt state), the TermView may route the keystroke through a
fallback path that ignores it.

**Next step**: check whether `hasEmulator()` (`ShellyTerminalSession.kt:118`)
returns true at the moment of the first Enter. If it's false, H2 is it.

### H3. IME composition state

Samsung's default keyboard (Samsung Keyboard) uses composing text even
for ASCII. The first Enter on a composing session triggers
`InputConnection.finishComposingText()` but *not* a real key event. If
our `TerminalEditText` overlay doesn't translate that into `\r`, the
first Enter vanishes into the IME layer.

**Next step**: run the repro with Gboard instead of Samsung Keyboard.
If Gboard doesn't reproduce, H3 is likely.

### H4. PTY slave line discipline buffers the first LF

`fork_pty` on Bionic comes up with ICANON on, which means keystrokes are
buffered until newline. But Enter *is* the newline. Unless the
`termios` is configured before the child has started writing, the first
LF from the parent PTY can be echoed but not cooked — shells like bash
then wait for a second LF to treat the input as a complete line.

**Next step**: inspect `shelly-exec.c` / `shelly-pty.c` for `tcsetattr`
calls. Confirm `ICANON` is off on the master side before forking. Also
try setting `ONLCR` / `INLCR` explicitly.

## How to gather evidence quickly

Minimum useful logcat filter:

```
adb logcat -c && adb logcat \
  ShellyTerminalView:V \
  ShellyInputHandler:V \
  ShellyTerminalSession:V \
  *:E
```

Reproduce:
1. Cold start Shelly
2. Wait for prompt to render
3. Press Enter once — note the screen
4. Press Enter again — note the screen
5. Save logcat buffer

Look for:
- Time delta between `write(\r)` and the next `onTextChanged`
- Whether `inputHandler.onKeyDown` is hit twice or once
- Whether the emulator screen cursor position advances after press 1

## Suggested fix order (cheapest first)

1. **Cheapest**: in `ShellyInputHandler`, explicitly intercept
   KEYCODE_ENTER and `session.write("\r".toByteArray())` — bypass the
   Termux TerminalKeyListener on Enter only. Log + ship + retest.
2. If that doesn't help: force `termios.c_lflag &= ~ICANON` in the JNI
   PTY init before `execvp`.
3. If neither helps: add a View-level `postDelayed(16ms)` after
   `attachSession` that re-invokes `onScreenUpdateCallback` as a belt-
   and-braces initial paint.

## Why this matters for the v0.1.0 release

Not a ship-blocker, but listed under Known Issues in `CHANGELOG.md` and
README Status. If a user sees it once on first launch they'll think the
terminal is broken. Fix should land in v0.1.1 at the latest.
