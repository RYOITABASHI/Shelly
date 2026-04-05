# TCP Connection Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shelly's terminal connection as stable as Termux by hardening the TCP link between Shelly and pty-helper with heartbeat, ring buffer, improved reconnect, and WakeLock.

**Architecture:** pty-helper (C) gets heartbeat handling + 64KB ring buffer with drain loop. ShellyTerminalSession (Kotlin) gets heartbeat sender + exponential backoff reconnect + ConnectionState machine. TerminalEmulatorModule gets WakeLock management. Battery optimization exemption is already implemented — just needs to be wired into the disconnect handler.

**Tech Stack:** C (pty-helper), Kotlin (ShellyTerminalSession, TerminalEmulatorModule), Java (TerminalSession)

**Spec:** `docs/superpowers/specs/2026-04-05-tcp-hardening-design.md`

---

### Task 1: pty-helper — Heartbeat handling + escape sequence parser extension

**Files:**
- Modify: `shelly-bridge/pty-helper.c`

The existing escape sequence parser handles `\x1bPTYR<cols>;<rows>\n` for resize. We extend it to also handle `\x1bPTYH\n` for heartbeat — responding with the same sequence on client_fd (not master_fd).

- [ ] **Step 1: Add heartbeat constants and client activity tracking**

At the top of `pty-helper.c`, after the existing `#define`s (line 34-35), add:

```c
#define HEARTBEAT_PREFIX "\x1bPTYH"
#define HEARTBEAT_PREFIX_LEN 5
#define HEARTBEAT_RESPONSE "\x1bPTYH\n"
#define CLIENT_TIMEOUT_SEC 45
```

- [ ] **Step 2: Add heartbeat response in the escape sequence parser**

In `relay_loop`, the existing parser at line 116-141 handles resize sequences. After the resize `sscanf` block (line 120-123), add a heartbeat check. Replace the entire `if (in_resize_seq)` block (lines 116-128) with:

```c
                    if (in_resize_seq) {
                        if (buf[i] == '\n' || resize_buf_len >= 63) {
                            resize_buf[resize_buf_len] = '\0';
                            /* Check if this is a heartbeat */
                            if (resize_buf_len == HEARTBEAT_PREFIX_LEN &&
                                memcmp(resize_buf, HEARTBEAT_PREFIX, HEARTBEAT_PREFIX_LEN) == 0) {
                                /* Echo heartbeat back to client (NOT to PTY) */
                                write(client_fd, HEARTBEAT_RESPONSE, 6);
                            } else {
                                /* Try resize command */
                                int new_cols, new_rows;
                                if (sscanf(resize_buf + RESIZE_PREFIX_LEN, "%d;%d", &new_cols, &new_rows) == 2) {
                                    resize_pty(master_fd, new_cols, new_rows);
                                    fprintf(stderr, "[pty-helper] Resized to %dx%d\n", new_cols, new_rows);
                                }
                            }
                            resize_buf_len = 0;
                            in_resize_seq = 0;
                            i++;
                            continue;
                        }
                        resize_buf[resize_buf_len++] = buf[i];
                        i++;
```

Note: The `\x1bPTYH` prefix is the same length (5) as `\x1bPTYR`, so the existing prefix-length check at line 133 (`resize_buf_len == RESIZE_PREFIX_LEN`) correctly enters `in_resize_seq = 1` for both. The differentiation happens when the full sequence is complete (at `\n`).

- [ ] **Step 3: Add client timeout tracking**

In `relay_loop`, add a `time_t last_client_data` variable before the while loop, and update it when client data is received. After the poll timeout check, add a client timeout check:

```c
    time_t last_client_data = time(NULL);

    while (!child_exited) {
        int timeout_ms = idle_count < 50 ? 100 : 2000;
        int ret = poll(fds, 2, timeout_ms);
        if (ret < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (ret == 0) {
            idle_count++;
            /* Check client timeout */
            if (time(NULL) - last_client_data > CLIENT_TIMEOUT_SEC) {
                fprintf(stderr, "[pty-helper] Client timeout (%ds), disconnecting\n", CLIENT_TIMEOUT_SEC);
                return 0;
            }
            continue;
        }
        idle_count = 0;
```

And in the client→PTY section (after `ssize_t n = read(client_fd, buf, BUF_SIZE);`, when `n > 0`), add:

```c
            if (n > 0) {
                last_client_data = time(NULL);  /* Reset timeout */
```

Add `#include <time.h>` at the top of the file.

- [ ] **Step 4: Build and test**

```bash
cd ~/shelly-bridge && cc -o pty-helper pty-helper.c -lutil
# Test: start pty-helper, connect with nc, send heartbeat
./pty-helper 19999 80 24 &
sleep 1
echo -ne '\x1bPTYH\n' | nc -q1 127.0.0.1 19999 | xxd | head -5
kill %1
```

Expected: should see `\x1bPTYH\n` echoed back among terminal output.

- [ ] **Step 5: Commit**

```bash
cd ~/shelly-bridge && git add pty-helper.c && git commit -m "feat: add heartbeat protocol and client timeout to pty-helper"
```

Also commit in Shelly repo if pty-helper.c is tracked there:
```bash
cd ~/Shelly && git add shelly-bridge/pty-helper.c 2>/dev/null && git commit -m "feat: pty-helper heartbeat + client timeout" 2>/dev/null || true
```

---

### Task 2: pty-helper — Ring buffer with drain loop and replay

**Files:**
- Modify: `shelly-bridge/pty-helper.c`

- [ ] **Step 1: Add ring buffer data structure**

After the `#define` section, add:

```c
#define RING_BUF_SIZE (64 * 1024)  /* 64KB */
#define REPLAY_START "\x1bPTYREPLAY_START\n"
#define REPLAY_END   "\x1bPTYREPLAY_END\n"

static char ring_buf[RING_BUF_SIZE];
static int ring_pos = 0;
static int ring_wrapped = 0;  /* 1 if buffer has wrapped around */

static void ring_write(const char *data, int len) {
    for (int i = 0; i < len; i++) {
        ring_buf[ring_pos] = data[i];
        ring_pos = (ring_pos + 1) % RING_BUF_SIZE;
        if (ring_pos == 0) ring_wrapped = 1;
    }
}

static void ring_replay(int fd) {
    write(fd, REPLAY_START, strlen(REPLAY_START));
    if (ring_wrapped) {
        /* Buffer has wrapped — write from ring_pos to end, then from 0 to ring_pos */
        write(fd, ring_buf + ring_pos, RING_BUF_SIZE - ring_pos);
        write(fd, ring_buf, ring_pos);
    } else if (ring_pos > 0) {
        /* Buffer hasn't wrapped — write from 0 to ring_pos */
        write(fd, ring_buf, ring_pos);
    }
    write(fd, REPLAY_END, strlen(REPLAY_END));
}
```

Add `#include <string.h>` if not already present (it is — line 19).

- [ ] **Step 2: Write to ring buffer during relay**

In `relay_loop`, in the PTY→client write section (after the successful `write(client_fd, ...)` loop at lines 94-104), add ring buffer write:

```c
            if (n > 0) {
                ring_write(buf, n);  /* Save to ring buffer */
                ssize_t total = 0;
                while (total < n) {
```

- [ ] **Step 3: Add drain loop during accept-wait**

In `main()`, in the accept loop (lines 245-273), add a drain loop that reads from master_fd into the ring buffer while waiting for a new client. Replace the simple poll+accept with:

```c
    while (!child_exited) {
        /* Poll both server socket (for new clients) and master_fd (drain PTY output) */
        struct pollfd afds[2];
        afds[0].fd = srv_fd;
        afds[0].events = POLLIN;
        afds[1].fd = master_fd;
        afds[1].events = POLLIN;

        int pret = poll(afds, 2, 2000);
        if (pret < 0) {
            if (errno == EINTR) continue;
            break;
        }

        /* Drain PTY output into ring buffer (prevents shell from blocking) */
        if (afds[1].revents & POLLIN) {
            char drain_buf[BUF_SIZE];
            ssize_t n = read(master_fd, drain_buf, BUF_SIZE);
            if (n > 0) {
                ring_write(drain_buf, n);
            } else if (n == 0 || (n < 0 && errno != EAGAIN)) {
                break;  /* PTY closed */
            }
        }
        if (afds[1].revents & (POLLERR | POLLHUP)) break;

        /* Accept new client */
        if (afds[0].revents & POLLIN) {
            int client_fd = accept(srv_fd, NULL, NULL);
            if (client_fd < 0) {
                if (errno == EINTR) continue;
                perror("accept");
                break;
            }

            /* Disable Nagle for low latency */
            int nodelay = 1;
            setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

            /* Enable TCP keepalive */
            int keepalive = 1;
            setsockopt(client_fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
            int keepidle = 30;
            int keepintvl = 10;
            int keepcnt = 3;
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));

            set_nonblock(client_fd);
            fprintf(stderr, "[pty-helper] Client connected\n");

            /* Replay ring buffer to new client */
            ring_replay(client_fd);

            int result = relay_loop(master_fd, client_fd);
            close(client_fd);

            if (result < 0) break;
            fprintf(stderr, "[pty-helper] Waiting for reconnection...\n");
        }
    }
```

This replaces the existing accept loop (lines 245-273).

- [ ] **Step 4: Build and test**

```bash
cd ~/shelly-bridge && cc -o pty-helper pty-helper.c -lutil
```

- [ ] **Step 5: Commit**

```bash
cd ~/shelly-bridge && git add pty-helper.c && git commit -m "feat: add 64KB ring buffer with drain loop and replay on reconnect"
```

---

### Task 3: ShellyTerminalSession — Heartbeat sender thread

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`

- [ ] **Step 1: Add heartbeat constants and state**

After the existing `companion object` constants (line 23), add:

```kotlin
        private const val HEARTBEAT_PREFIX = "\u001bPTYH"
        private const val HEARTBEAT_CMD = "\u001bPTYH\n"
        private const val HEARTBEAT_INTERVAL_MS = 15_000L
        private const val HEARTBEAT_TIMEOUT_MS = 45_000L
```

After the existing instance variables (around line 37), add:

```kotlin
    private var heartbeatThread: Thread? = null
    @Volatile private var lastDataReceived = System.currentTimeMillis()
```

- [ ] **Step 2: Add heartbeat thread start/stop methods**

After the `destroy()` method (line 228), add:

```kotlin
    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatThread = Thread("Heartbeat-$sessionId") {
            while (shouldReconnect && !Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }
                // Send heartbeat
                synchronized(socketLock) {
                    try {
                        socket?.getOutputStream()?.write(HEARTBEAT_CMD.toByteArray(Charsets.UTF_8))
                        socket?.getOutputStream()?.flush()
                    } catch (e: Exception) {
                        Log.w(TAG, "Heartbeat send failed: ${e.message}")
                        // Socket likely dead — close to trigger reconnect
                        try { socket?.close() } catch (_: Exception) {}
                        break
                    }
                }
                // Check for response timeout
                if (System.currentTimeMillis() - lastDataReceived > HEARTBEAT_TIMEOUT_MS) {
                    Log.w(TAG, "Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms), triggering reconnect")
                    synchronized(socketLock) {
                        try { socket?.close() } catch (_: Exception) {}
                    }
                    break
                }
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun stopHeartbeat() {
        heartbeatThread?.interrupt()
        heartbeatThread = null
    }
```

- [ ] **Step 3: Start heartbeat after connection, stop on disconnect**

In the `init` block, after `terminalSession.initializeWithStreams(...)` (line 57), add:

```kotlin
        startHeartbeat()
```

In `reconnectSocket()`, after successful reconnect (line 138, after `return true`), add before the return:

```kotlin
                lastDataReceived = System.currentTimeMillis()
                startHeartbeat()
```

In `destroy()`, add `stopHeartbeat()` as the first line.

In `startReconnectLoop()`, add `stopHeartbeat()` before `isReconnecting = true`.

- [ ] **Step 4: Update `lastDataReceived` on any incoming data**

In `onTextChanged()` callback (the text output handler), add at the beginning:

```kotlin
    override fun onTextChanged(changedSession: TerminalSession) {
        lastDataReceived = System.currentTimeMillis()
```

- [ ] **Step 5: Filter heartbeat responses from terminal output**

In `TerminalSession.java`, in the `TermSessionInputReader[stream]` thread (line 210-228), add heartbeat filtering. The heartbeat response `\x1bPTYH\n` arrives as raw bytes in the input stream. We need to filter it before writing to `mProcessToTerminalIOQueue`.

This is complex to do at the byte level. A simpler approach: filter in `ShellyTerminalSession`'s output processing. In `onTextChanged`, check the last few characters of the emulator output for the heartbeat response and suppress it. However, since the heartbeat response is written to the socket and processed by TerminalEmulator's VT100 parser, it will show as garbled text.

Better approach: filter in `TerminalSession.java`'s stream reader. Add a small state machine:

In `TerminalSession.java`, replace the stream reader thread (lines 210-228) with:

```java
        new Thread("TermSessionInputReader[stream]") {
            @Override
            public void run() {
                try {
                    final byte[] buffer = new byte[4096];
                    // Heartbeat filter state
                    final byte[] hbPrefix = {0x1b, 'P', 'T', 'Y', 'H', '\n'};
                    final byte[] replayStartPrefix = {0x1b, 'P', 'T', 'Y', 'R', 'E', 'P', 'L', 'A', 'Y', '_', 'S', 'T', 'A', 'R', 'T', '\n'};
                    final byte[] replayEndPrefix = {0x1b, 'P', 'T', 'Y', 'R', 'E', 'P', 'L', 'A', 'Y', '_', 'E', 'N', 'D', '\n'};
                    boolean inReplay = false;

                    while (true) {
                        int read = inputStream.read(buffer);
                        if (read == -1) {
                            mMainThreadHandler.sendMessage(
                                mMainThreadHandler.obtainMessage(MSG_PROCESS_EXITED, 0)
                            );
                            return;
                        }

                        // Filter out heartbeat responses and replay markers
                        // Simple approach: scan for \x1bPTYH\n and remove it
                        int writeStart = 0;
                        for (int i = 0; i < read; i++) {
                            // Check for 6-byte heartbeat sequence
                            if (i + 6 <= read && buffer[i] == 0x1b) {
                                boolean isHeartbeat = true;
                                for (int j = 0; j < 6 && i + j < read; j++) {
                                    if (buffer[i + j] != hbPrefix[j]) { isHeartbeat = false; break; }
                                }
                                if (isHeartbeat) {
                                    // Write everything before the heartbeat
                                    if (i > writeStart) {
                                        if (!mProcessToTerminalIOQueue.write(buffer, writeStart, i - writeStart)) return;
                                        mMainThreadHandler.sendEmptyMessage(MSG_NEW_INPUT);
                                    }
                                    i += 5; // skip heartbeat (loop will i++)
                                    writeStart = i + 1;
                                    continue;
                                }
                            }
                        }
                        // Write remaining data
                        if (writeStart < read) {
                            if (!mProcessToTerminalIOQueue.write(buffer, writeStart, read - writeStart)) return;
                            mMainThreadHandler.sendEmptyMessage(MSG_NEW_INPUT);
                        }
                    }
                } catch (java.net.SocketTimeoutException e) {
                    // Read timeout — not a real disconnect
                } catch (Exception e) {
                    mMainThreadHandler.sendMessage(
                        mMainThreadHandler.obtainMessage(MSG_PROCESS_EXITED, 0)
                    );
                }
            }
        }.start();
```

- [ ] **Step 6: Commit**

```bash
cd ~/Shelly && git add modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalSession.java
git commit -m "feat: bidirectional heartbeat with 15s interval and 45s timeout"
```

---

### Task 4: ShellyTerminalSession — Exponential backoff reconnect + resize after reconnect

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`

- [ ] **Step 1: Replace the reconnect loop**

Replace `startReconnectLoop()` method (lines 149-194) with:

```kotlin
    private fun startReconnectLoop() {
        if (isReconnecting) return
        isReconnecting = true
        stopHeartbeat()

        val thread = object : Thread("ReconnectLoop-$sessionId") {
            override fun run() {
                var backoffMs = 0L  // First attempt is immediate

                while (shouldReconnect && isReconnecting) {
                    if (backoffMs > 0) {
                        try { sleep(backoffMs) } catch (_: InterruptedException) { break }
                    }

                    Log.d(TAG, "Session $sessionId: reconnect attempt (backoff=${backoffMs}ms)")

                    if (reconnectSocket()) {
                        isReconnecting = false

                        batchHandler.post {
                            // Re-send current terminal size
                            try {
                                val emulator = terminalSession.emulator
                                if (emulator != null) {
                                    sendResizeCommand(emulator.mColumns, emulator.mRows)
                                }
                            } catch (_: Exception) {}

                            // Refresh screen
                            try { write("\u000c") } catch (_: Exception) {}
                            onScreenUpdateCallback?.invoke()
                        }
                        return
                    }

                    // Exponential backoff: 0 → 100 → 200 → 400 → ... → 5000ms max
                    backoffMs = if (backoffMs == 0L) 100L else minOf(backoffMs * 2, 5000L)
                }

                // shouldReconnect set to false — session destroyed
                isReconnecting = false
                if (!shouldReconnect) return

                Log.w(TAG, "Session $sessionId: reconnect loop ended (shouldReconnect=$shouldReconnect)")
                batchHandler.post {
                    emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to -1))
                }
            }
        }
        thread.isDaemon = true
        thread.start()
        reconnectThread = thread
    }
```

Key differences from the old version:
- First attempt at 0ms (immediate)
- Exponential backoff starting at 100ms
- No attempt limit (keeps trying while `shouldReconnect`)
- Sends resize command after reconnect
- Calls `stopHeartbeat()` at start, `startHeartbeat()` is called inside `reconnectSocket()` on success

- [ ] **Step 2: Commit**

```bash
cd ~/Shelly && git add modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt
git commit -m "feat: exponential backoff reconnect with immediate first attempt + resize"
```

---

### Task 5: TerminalEmulatorModule — WakeLock management

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt`

- [ ] **Step 1: Add WakeLock field and acquire/release methods**

Read the file first. Find the `class` declaration and add a WakeLock field. In the existing `createSession` function, acquire the WakeLock. In `destroySession`, release it when no sessions remain.

Add a WakeLock field to the module:

```kotlin
    private var wakeLock: PowerManager.WakeLock? = null
    private val wakeLockLock = Any()

    private fun acquireWakeLock() {
        synchronized(wakeLockLock) {
            if (wakeLock != null) return
            val context = appContext.reactContext ?: return
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shelly:terminal").also {
                it.acquire()
            }
            Log.i("TerminalEmulator", "WakeLock acquired")
        }
    }

    private fun releaseWakeLock() {
        synchronized(wakeLockLock) {
            wakeLock?.let {
                if (it.isHeld) it.release()
                Log.i("TerminalEmulator", "WakeLock released")
            }
            wakeLock = null
        }
    }
```

In the `createSession` AsyncFunction, after `sessions[sessionId] = session`, add:

```kotlin
            acquireWakeLock()
```

In the `destroySession` AsyncFunction, after `sessions.remove(sessionId)`, add:

```kotlin
            if (sessions.isEmpty()) releaseWakeLock()
```

- [ ] **Step 2: Commit**

```bash
cd ~/Shelly && git add modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt
git commit -m "feat: acquire PARTIAL_WAKE_LOCK while terminal sessions are active"
```

---

### Task 6: Battery optimization exemption on first disconnect

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`
- Modify: `app/(tabs)/terminal.tsx` (JS-side disconnect handler)

The `isIgnoringBatteryOptimizations` and `requestBatteryOptimizationExemption` functions already exist in `TerminalEmulatorModule.kt`. We just need to call them when a disconnect is detected.

- [ ] **Step 1: In terminal.tsx, add battery exemption check on session exit**

In `terminal.tsx`, find the `onSessionExit` event handler. After a session exit event, check battery optimization and prompt if not exempted:

```typescript
// Add after the session exit handler
const checkBatteryExemption = useCallback(async () => {
  try {
    const isExempted = await TerminalEmulator.isIgnoringBatteryOptimizations();
    if (!isExempted) {
      Alert.alert(
        'Terminal Connection',
        'To keep the terminal stable, allow Shelly to run in the background without battery restrictions.',
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Allow',
            onPress: () => TerminalEmulator.requestBatteryOptimizationExemption(),
          },
        ]
      );
    }
  } catch {}
}, []);
```

Call `checkBatteryExemption()` in the session exit handler, but only if `sessionStatus` was `'alive'` (not on initial creation failure).

- [ ] **Step 2: Commit**

```bash
cd ~/Shelly && git add app/\(tabs\)/terminal.tsx
git commit -m "feat: prompt battery optimization exemption on first disconnect"
```

---

### Task 7: Build, test, deploy

- [ ] **Step 1: Rebuild pty-helper**

```bash
cd ~/shelly-bridge && cc -o pty-helper pty-helper.c -lutil
```

- [ ] **Step 2: Kill old pty-helper processes**

```bash
pkill pty-helper
```

- [ ] **Step 3: TypeScript check**

```bash
cd ~/Shelly && npx tsc --noEmit 2>&1 | grep -v "expo-modules-core"
```

Expected: No new errors.

- [ ] **Step 4: Push and build APK**

```bash
cd ~/Shelly && git push origin main
```

Wait for GitHub Actions build to complete.

- [ ] **Step 5: Manual testing checklist**

Install APK and test:

1. **Heartbeat test**: Open terminal, start claude, wait 2+ minutes idle. Terminal should stay alive.
2. **Reconnect test**: Open terminal, background Shelly for 1 minute, return. Should show "Reconnecting..." briefly then restore.
3. **Ring buffer test**: Open terminal, run `ls -la`, background app for 30 seconds, return. Previous output should be visible.
4. **Reset test**: Tab long-press → Reset. New shell should start.
5. **APK update test**: With claude running, install a new APK. Terminal should auto-recover.
6. **Battery prompt test**: If not already exempted, should see prompt after first disconnect.
