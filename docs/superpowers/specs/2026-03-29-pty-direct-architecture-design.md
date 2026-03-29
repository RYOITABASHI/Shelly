# Direct PTY Architecture — Design Specification

> **Date**: 2026-03-29
> **Status**: Approved
> **Replaces**: socat TCP + tmux resize architecture

## Problem Statement

The current Native Terminal View architecture uses a 5-layer bridge chain:

```
TerminalView → TerminalSession → TCP Socket → socat → tmux → shell
```

This causes three critical failures on Samsung Galaxy Z Fold6:

1. **Connection drops** — socat TCP connections die when the app is backgrounded (Android kills network I/O for background apps)
2. **Display sizing failures** — tmux resize is sent via async Intent (RunCommandService), creating race conditions during fold/unfold/split transitions where the emulator and tmux disagree on terminal dimensions
3. **Auth interference** — Shelly and Termux share `~/.claude/` because they operate in the same Termux filesystem via tmux

After multiple build-test-fix cycles with no progress, the decision was made to replace the architecture.

## Solution: Direct PTY via C Helper

Replace the 5-layer chain with a 2-layer connection:

```
TerminalView → TerminalSession → Unix Domain Socket → pty-helper (C) → shell
```

### pty-helper

A minimal C program (~200 lines) that:

1. Calls `forkpty()` to create a real PTY and spawn a shell (bash)
2. Listens on a Unix Domain Socket (`~/.shelly/pty-{sessionId}.sock`)
3. Relays data bidirectionally between the socket and PTY master fd
4. Accepts inline resize commands via a unique escape prefix (`\x1bPTYR{cols};{rows}\n`) and calls `ioctl(TIOCSWINSZ)` directly on the PTY fd

### Why This Works

| Problem | Old Architecture | New Architecture |
|---------|-----------------|------------------|
| Connection drops | TCP socket killed by Android | Unix Domain Socket (filesystem-based, no network layer) |
| Resize race | Intent → RunCommandService → tmux → SIGWINCH (async, 3 hops) | Socket → pty-helper → ioctl(TIOCSWINSZ) (sync, 1 hop) |
| Auth interference | Shared tmux sessions share ~/.claude/ | Each pty-helper is independent; tmux is optional |

### Verified by Proof of Concept

Tested on Termux (aarch64, Android 14):

```
$ cc -o pty-helper pty-helper.c -lutil -O2   # Compiles in <1s
$ ./pty-helper /tmp/test.sock 80 24           # Starts PTY + shell
$ # Connected via socat, sent resize command:
$ # \x1bPTYR120;40\n → pty-helper resized to 120x40
$ # tput cols → 120, tput lines → 40            ✓ Instant resize
```

## Architecture

### Data Flow

```
[Shelly App (React Native)]
  │
  │ NativeTerminalView (Expo Module)
  │   └─ ShellyTerminalView.kt
  │       └─ TerminalView.java (Termux-derived, Canvas rendering)
  │
  │ TerminalEmulator (Expo Module)
  │   └─ ShellyTerminalSession.kt
  │       └─ TerminalSession.java → initializeWithStreams(in, out)
  │                                     │
  │                              Unix Domain Socket
  │                              ~/.shelly/pty-{id}.sock
  │                                     │
[Termux Process Space]                  │
  │                                     │
  └─ pty-helper (C binary)             ◄┘
      ├─ forkpty() → PTY master/slave
      ├─ relay: socket ↔ PTY master
      ├─ resize: parse \x1bPTYR → ioctl(TIOCSWINSZ)
      └─ child: bash -l (login shell)
```

### Resize Flow (New)

```
ShellyTerminalView.onEmulatorSet()
  ↓ cols/rows from TerminalView.updateSize()
ShellyTerminalSession.resize(cols, rows)
  ↓ write "\x1bPTYR{cols};{rows}\n" to socket
pty-helper parses resize command
  ↓ ioctl(TIOCSWINSZ, &winsize)
Shell receives SIGWINCH
  ↓ Programs (vim, htop, etc.) redraw immediately
```

No tmux. No Intent. No RunCommandService. Instant.

### Session Lifecycle

```
1. User opens Terminal tab
2. terminal.tsx calls TerminalEmulator.createSession(socketPath, rows, cols)
3. Kotlin starts pty-helper via RUN_COMMAND Intent (one-time setup)
4. ShellyTerminalSession connects to Unix Domain Socket
5. TerminalView attaches to session → rendering begins
6. User interacts normally (typing, scrolling, etc.)
7. On resize (fold/unfold/split): resize command sent via socket → instant
8. On app background: socket stays alive (filesystem-based)
9. On app foreground: reconnect to same socket if disconnected
10. On session close: pty-helper detects client disconnect, shell gets SIGHUP
```

### tmux: Optional, User-Controlled

tmux is no longer in the critical path. Users can still:
- Type `tmux` in the shell to start tmux manually
- Use `tmux attach` to reconnect to sessions
- Use tmux for multiplexing within the PTY

But Shelly does not depend on tmux for:
- Session persistence (pty-helper process persists while shell is alive)
- Resize (direct ioctl)
- Connection (Unix Domain Socket)

### Immortal Sessions: New Approach

Old: tmux kept sessions alive during app background.
New: pty-helper process persists in Termux. Shell stays alive as long as pty-helper runs.

For long-running tasks (claude --continue, npm run dev):
- pty-helper keeps running even when Shelly is backgrounded
- On return, ShellyTerminalSession reconnects to the same socket
- Shell output that occurred while backgrounded is still in the PTY buffer

**Limitation**: If Android's Phantom Process Killer terminates pty-helper, the session dies. Mitigation: Use Termux's wakelock (`termux-wake-lock`) or foreground notification.

## Files to Change

### New Files
| File | Purpose |
|------|---------|
| `shelly-bridge/pty-helper.c` | C source for PTY helper |
| `shelly-bridge/pty-helper` | Compiled binary (committed or built on first run) |
| `shelly-bridge/start-pty.sh` | Script to launch pty-helper for a session |

### Modified Files
| File | Change |
|------|--------|
| `modules/terminal-emulator/.../ShellyTerminalSession.kt` | TCP Socket → Unix Domain Socket connection |
| `modules/terminal-emulator/.../TerminalEmulatorModule.kt` | `createSession()` takes socketPath instead of port |
| `modules/terminal-view/.../ShellyTerminalView.kt` | Remove `syncTmuxSize()`, add `sendResizeCommand()` via session |
| `app/(tabs)/terminal.tsx` | Replace socat startup with pty-helper startup; remove tmux resize fallback |
| `shelly-bridge/server.js` | Add `startPty` message handler to launch pty-helper |
| `shelly-bridge/start-shelly.sh` | Remove mandatory tmux session creation |
| `modules/terminal-view/src/NativeTerminalView.tsx` | Update props (remove tmuxSessionName, add socketPath) |
| `modules/terminal-emulator/src/TerminalEmulatorModule.ts` | Update createSession signature |

### Unchanged Files (80% of codebase)
- `TerminalView.java` — Canvas rendering, unchanged
- `TerminalRenderer.java` — Glyph rendering, unchanged
- `TerminalEmulator.java` — VT100 parser, unchanged
- `TerminalSession.java` — `initializeWithStreams()` still used, unchanged
- `ShellyInputHandler.kt` — Key handling, unchanged
- `BlockDetector.kt` — OSC 133 detection, unchanged
- `LinkDetector.kt` — URL/file detection, unchanged
- `FontManager.kt` — Font management, unchanged
- `GestureAndScaleRecognizer.java` — Touch handling, unchanged

## Resize Protocol

Inline escape sequence mixed with terminal data:

```
\x1bPTYR{cols};{rows}\n
```

- Prefix: `\x1b` `P` `T` `Y` `R` (5 bytes) — unique, won't clash with any VT100/xterm/OSC sequence
- Body: decimal cols, semicolon, decimal rows
- Terminator: newline (`\n`)

Example: `\x1bPTYR120;40\n` → resize to 120 cols, 40 rows

pty-helper strips this from the data stream — it never reaches the shell.

## Migration Strategy

1. **Phase 1**: Add pty-helper binary and start-pty.sh
2. **Phase 2**: Modify ShellyTerminalSession.kt for Unix Domain Socket
3. **Phase 3**: Modify ShellyTerminalView.kt for direct resize
4. **Phase 4**: Update terminal.tsx for new session lifecycle
5. **Phase 5**: Update bridge server.js for pty-helper management
6. **Phase 6**: Clean up old socat/tmux code (keep tmux-manager.ts for user-facing tmux commands)

Each phase produces a buildable state. Rollback is possible at any phase.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| pty-helper crash | Auto-restart via bridge server; session monitor detects death |
| Phantom Process Killer | termux-wake-lock; foreground notification; smaller process footprint than socat+tmux |
| Binary compatibility | Compile on target device (Termux has clang); or compile in CI for aarch64 |
| Simultaneous sessions | Each session gets its own pty-helper + socket pair |
| Japanese input (IME) | Unchanged — TerminalView handles IME → ShellyInputHandler → socket → PTY |

## Success Criteria

1. Terminal renders correctly on Z Fold6 in all three transitions (full screen → folded → split view)
2. Session survives app backgrounding (30+ seconds)
3. Resize is instant (no visible delay or content scrambling)
4. Scrolling works smoothly
5. Text input (including Japanese via Nacre) works correctly
6. No dependency on tmux for core functionality
