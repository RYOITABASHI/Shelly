# TCP Connection Hardening — Termux-Equivalent Terminal Stability

**Date:** 2026-04-05
**Status:** Draft

## Problem

Shelly's terminal connection drops during idle periods (e.g., Claude Code thinking for 30+ seconds). The screen goes blank, requiring manual recovery. Termux doesn't have this problem because it holds the PTY in-process — no TCP.

## Why TCP Is Required

Android's security model prevents two apps with different UIDs from communicating via:
- Unix Domain Sockets (SELinux MLS categories differ per app since Android 9)
- Shared file descriptors (Binder FD passing requires a bound service — Termux doesn't expose one)
- Shared memory (same Binder constraint)
- Direct binary execution (Termux's `/data/data/com.termux/` is 700, inaccessible to Shelly)

**TCP localhost is the only IPC channel Android allows between two apps without special permissions.** Both apps share the same network namespace and have the `inet` group. SELinux allows `untrusted_app` to use inet sockets. TCP on 127.0.0.1 never leaves the kernel's loopback interface.

## Design Philosophy Alignment

- **Termux is invisible**: No changes to Termux required. Stock F-Droid Termux works.
- **Native feel**: Disconnections become invisible to the user (sub-second auto-reconnect).
- **No special permissions**: Only standard INTERNET permission (already granted).

## Architecture (No Change)

```
Shelly App (Kotlin) ──TCP 127.0.0.1──▶ pty-helper (C, Termux) ──PTY──▶ bash
```

The architecture stays the same. We harden every layer.

## Improvements (Priority Order)

### 1. Application-Level Heartbeat

**Why**: TCP keepalive takes 30-60s to detect a dead connection. An app-level heartbeat detects in 5s.

**Protocol**: Shelly sends a 1-byte heartbeat (`\x00`) every 15 seconds. pty-helper ignores null bytes (doesn't write to PTY). If pty-helper detects no data from the client for 45 seconds, it marks the client as potentially dead but keeps waiting (the accept loop handles reconnection). On the Kotlin side, if no data received from pty-helper for 45 seconds AND a heartbeat wasn't echoed, trigger reconnect.

**Implementation**:
- **pty-helper.c**: In `relay_loop`, filter out `\x00` bytes from client→PTY writes. Add a counter that tracks time since last client data; after 45s of silence from client, close the client socket to trigger reconnect-wait.
- **ShellyTerminalSession.kt**: Start a heartbeat timer thread that writes `\x00` to the socket every 15s. Track last received data time; if >45s without any data from pty-helper AND heartbeat not echoed, close socket and start reconnect.

### 2. Output Ring Buffer in pty-helper

**Why**: When the client disconnects, PTY output is lost. On reconnect, the user sees a blank screen instead of the last terminal state.

**Design**: pty-helper maintains a 64KB ring buffer of recent PTY output. On new client connection, replay the buffer before entering the relay loop.

**Implementation**:
- Add `char ring_buf[65536]; int ring_pos = 0; int ring_full = 0;`
- In `relay_loop`, every PTY→client write also copies to ring buffer
- On new client `accept()`, write ring buffer contents to client before entering relay_loop
- Flag the replay with a special escape sequence (`\x1bPTYREPLAY\n`) so Kotlin side knows it's replayed output (optional, for future use)

### 3. Kotlin Auto-Reconnect Improvement

**Why**: Current reconnect loop has fixed 1s interval and 30 max attempts. Needs to be faster initially and more persistent.

**Design**: Exponential backoff starting at 100ms, doubling to max 5s. No attempt limit — keep trying as long as the app is alive. Show "Reconnecting..." indicator only after 2s of failed reconnect (avoid flashing for sub-second drops).

**Implementation changes to ShellyTerminalSession.kt**:
```kotlin
// Replace fixed interval reconnect
var backoff = 100L  // Start at 100ms
while (shouldReconnect && isReconnecting) {
    sleep(backoff)
    if (reconnectSocket()) {
        isReconnecting = false
        // ... send Ctrl+L, update screen
        return
    }
    backoff = minOf(backoff * 2, 5000L)  // Max 5s
}
```

Remove the 30-attempt limit. The reconnect loop should only stop when:
- `shouldReconnect` is set to false (session destroyed)
- Reconnection succeeds

### 4. Foreground Service WakeLock

**Why**: Android can put the CPU to sleep even with the screen on, which drops TCP connections. Termux uses a `PARTIAL_WAKE_LOCK` in its foreground service.

**Design**: Acquire `PARTIAL_WAKE_LOCK` when any terminal session is active. Release when all sessions are closed.

**Implementation**:
- In `ShellyForegroundService` (or `TerminalEmulatorModule`), acquire `PowerManager.PARTIAL_WAKE_LOCK` with tag `"shelly:terminal"` when the first session is created
- Release when the last session is destroyed
- The existing foreground notification already satisfies Android's requirement for holding a WakeLock

### 5. Battery Optimization Exemption

**Why**: Even with a foreground service, Android's Doze mode can defer network activity. Exemption from battery optimization prevents this.

**Design**: During Shelly's setup wizard, request `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. This is a standard API that shows a system dialog. If the user denies, Shelly still works but may have occasional disconnects during Doze.

**Implementation**:
- Check `PowerManager.isIgnoringBatteryOptimizations()` on startup
- If not exempted, show a one-time prompt explaining why it's needed
- Use `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent

### 6. TCP Keepalive (Already Implemented)

Already in pty-helper: `TCP_KEEPIDLE=30s, TCP_KEEPINTVL=10s, TCP_KEEPCNT=3`. This serves as a secondary detection mechanism behind the app-level heartbeat.

## Expected Behavior After Hardening

| Scenario | Before | After |
|----------|--------|-------|
| Claude Code thinking (60s) | Screen goes blank | No change — heartbeat keeps connection alive |
| App backgrounded 5min | Dead terminal on return | Auto-reconnect in <1s, output preserved |
| App updated (APK install) | `[Process completed]` | Auto-reconnect on launch, shell still alive in pty-helper |
| Memory pressure | Silent socket death | Heartbeat detects in 5s → auto-reconnect |
| Screen off 30min | Connection dies | WakeLock + heartbeat prevent disconnection |
| Doze mode | Deferred network | Battery exemption prevents Doze interference |

## File Changes

| File | Change |
|------|--------|
| `shelly-bridge/pty-helper.c` | Heartbeat filtering, output ring buffer, replay on reconnect |
| `modules/terminal-emulator/.../ShellyTerminalSession.kt` | Heartbeat thread, exponential backoff reconnect, no attempt limit |
| `modules/terminal-emulator/.../TerminalEmulatorModule.kt` | WakeLock acquire/release |
| `modules/terminal-emulator/.../ShellyForegroundService.kt` | WakeLock integration |
| `app/(tabs)/settings.tsx` or setup wizard | Battery optimization exemption request |

## Non-Goals

- Replacing TCP with another IPC (proven infeasible due to Android security model)
- Modifying Termux (design principle: stock Termux only)
- Bundling a shell/toolchain inside Shelly (Termux dependency is by design)

## Success Criteria

1. Terminal survives 10+ minutes of idle (Claude Code thinking) without disconnection
2. App background → foreground recovers in <1 second with full output preserved
3. APK update recovers terminal session automatically
4. User never sees blank screen or `[Process completed]` during normal usage
