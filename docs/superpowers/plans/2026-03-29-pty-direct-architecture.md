# Direct PTY Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace socat TCP + tmux bridge with a direct PTY helper connected via Unix Domain Socket, fixing connection drops, display sizing, and resize issues on Z Fold6.

**Architecture:** C PTY helper (forkpty → shell) listens on Unix Domain Socket. Kotlin connects via `LocalSocket`. Resize via inline escape protocol + `ioctl(TIOCSWINSZ)`.

**Tech Stack:** C (pty-helper), Kotlin (ShellyTerminalSession), TypeScript (terminal.tsx), Node.js (bridge server.js)

---

### Task 1: Add pty-helper binary and launch script

**Files:**
- Create: `shelly-bridge/pty-helper.c`
- Create: `shelly-bridge/start-pty.sh`
- Modify: `shelly-bridge/start-shelly.sh`

- [ ] **Step 1: Copy verified pty-helper.c to shelly-bridge/**

```bash
cp ~/.shelly/pty-helper.c ~/shelly-bridge/pty-helper.c
```

- [ ] **Step 2: Create start-pty.sh**

```bash
#!/data/data/com.termux/files/usr/bin/bash
# start-pty.sh — Launch pty-helper for a session
# Usage: start-pty.sh <session-id> [cols] [rows] [shell]
SESSION_ID="${1:?Usage: start-pty.sh <session-id> [cols] [rows] [shell]}"
COLS="${2:-80}"
ROWS="${3:-24}"
SHELL_PATH="${4:-/data/data/com.termux/files/usr/bin/bash}"
SOCK_DIR="/data/data/com.termux/files/home/.shelly"
SOCK_PATH="${SOCK_DIR}/pty-${SESSION_ID}.sock"
HELPER="$(dirname "$0")/pty-helper"

mkdir -p "$SOCK_DIR"
rm -f "$SOCK_PATH"

# Compile pty-helper if binary missing
if [ ! -x "$HELPER" ]; then
  cc -o "$HELPER" "$(dirname "$0")/pty-helper.c" -lutil -O2 || exit 1
fi

exec "$HELPER" "$SOCK_PATH" "$COLS" "$ROWS" "$SHELL_PATH"
```

- [ ] **Step 3: Update start-shelly.sh — remove mandatory tmux session creation**

Remove the `for i in 1 2; tmux new-session` loop. Keep tmux config lines for users who want tmux.

- [ ] **Step 4: Compile pty-helper on device**

```bash
cd ~/shelly-bridge && cc -o pty-helper pty-helper.c -lutil -O2
```

- [ ] **Step 5: Test start-pty.sh manually**

```bash
cd ~/shelly-bridge && bash start-pty.sh test1 80 24 &
sleep 1
echo "echo hello" | socat - UNIX-CONNECT:~/.shelly/pty-test1.sock
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add shelly-bridge/pty-helper.c shelly-bridge/start-pty.sh shelly-bridge/start-shelly.sh
git commit -m "feat(bridge): add pty-helper C binary for direct PTY via Unix socket"
```

---

### Task 2: Modify ShellyTerminalSession.kt for Unix Domain Socket

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt`
- Modify: `modules/terminal-emulator/src/TerminalEmulatorModule.ts`

- [ ] **Step 1: Modify ShellyTerminalSession.kt**

Change constructor from `port: Int` to `socketPath: String`. Replace `Socket("127.0.0.1", port)` with `LocalSocket()` → `LocalSocket.connect(LocalSocketAddress(socketPath, Namespace.FILESYSTEM))`.

Add `sendResizeCommand(cols, rows)` method that writes `\x1bPTYR{cols};{rows}\n` to the socket output stream.

```kotlin
// Key changes:
import android.net.LocalSocket
import android.net.LocalSocketAddress

// Constructor: socketPath instead of port
class ShellyTerminalSession(
    private val sessionId: String,
    private val emitEvent: (name: String, body: Map<String, Any?>) -> Unit,
    private val socketPath: String,  // Changed from port
    rows: Int, cols: Int,
    private val appContext: android.content.Context
) : TerminalSessionClient {

    private var localSocket: LocalSocket? = null

    init {
        terminalSession = TerminalSession(...)
        val sock = LocalSocket()
        sock.connect(LocalSocketAddress(socketPath, LocalSocketAddress.Namespace.FILESYSTEM))
        localSocket = sock
        val inputStream = sock.inputStream
        val outputStream = sock.outputStream
        terminalSession.initializeWithStreams(inputStream, outputStream, cols, rows, 1, 1)
    }

    fun sendResizeCommand(cols: Int, rows: Int) {
        try {
            val cmd = "\u001bPTYR${cols};${rows}\n"
            localSocket?.outputStream?.write(cmd.toByteArray(Charsets.UTF_8))
            localSocket?.outputStream?.flush()
        } catch (e: Exception) {
            Log.w(TAG, "sendResizeCommand failed: ${e.message}")
        }
    }

    fun isAlive(): Boolean {
        val sock = localSocket ?: return false
        return try {
            sock.outputStream.write(ByteArray(0))
            true
        } catch (e: Exception) { false }
    }

    fun destroy() {
        // ... close localSocket instead of socket
    }
}
```

- [ ] **Step 2: Modify TerminalEmulatorModule.kt**

Change `createSession` to accept `socketPath` instead of `port`.

```kotlin
AsyncFunction("createSession") { config: Map<String, Any?> ->
    val sessionId = config["sessionId"] as? String ?: throw ...
    val socketPath = config["socketPath"] as? String ?: throw ...
    val rows = (config["rows"] as? Number)?.toInt() ?: 24
    val cols = (config["cols"] as? Number)?.toInt() ?: 80
    // ... create ShellyTerminalSession with socketPath
}
```

- [ ] **Step 3: Modify TerminalEmulatorModule.ts**

```typescript
export interface SessionConfig {
  sessionId: string;
  socketPath: string;  // Changed from port
  rows?: number;
  cols?: number;
}
```

- [ ] **Step 4: Commit**

```bash
git add modules/terminal-emulator/
git commit -m "feat(terminal-emulator): switch from TCP socket to Unix Domain Socket"
```

---

### Task 3: Modify ShellyTerminalView.kt — direct resize via session

**Files:**
- Modify: `modules/terminal-view/android/src/main/java/expo/modules/terminalview/ShellyTerminalView.kt`
- Modify: `modules/terminal-view/android/src/main/java/expo/modules/terminalview/TerminalViewModule.kt`
- Modify: `modules/terminal-view/src/NativeTerminalView.tsx`

- [ ] **Step 1: Modify ShellyTerminalView.kt**

Remove `syncTmuxSize()` method entirely. Remove `tmuxSessionName` property. In `onEmulatorSet()`, call `currentShellySession?.sendResizeCommand(cols, rows)` instead.

```kotlin
// Remove these:
// var tmuxSessionName: String? = null
// private fun syncTmuxSize(cols: Int, rows: Int) { ... }

// In onEmulatorSet():
override fun onEmulatorSet() {
    terminalView.invalidate()
    val emulator = terminalView.mEmulator ?: return
    val cols = emulator.mColumns
    val rows = emulator.mRows
    if (cols == lastSyncedCols && rows == lastSyncedRows) return
    lastSyncedCols = cols
    lastSyncedRows = rows

    // Direct PTY resize via socket (replaces syncTmuxSize)
    currentShellySession?.sendResizeCommand(cols, rows)
    onResize(mapOf("cols" to cols, "rows" to rows))
}
```

- [ ] **Step 2: Remove tmuxSessionName prop from TerminalViewModule.kt**

Remove the `Prop("tmuxSessionName")` block.

- [ ] **Step 3: Update NativeTerminalView.tsx**

Remove `tmuxSessionName` from props interface.

- [ ] **Step 4: Commit**

```bash
git add modules/terminal-view/
git commit -m "feat(terminal-view): replace tmux resize with direct PTY resize via socket"
```

---

### Task 4: Update terminal.tsx — new session lifecycle

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: Replace socat startup with pty-helper startup**

Instead of starting socat via `runRawCommand("socat-session.sh ...")`, use `runRawCommand("start-pty.sh {sessionId} {cols} {rows}")`.

- [ ] **Step 2: Replace createSession port with socketPath**

```typescript
const socketPath = `/data/data/com.termux/files/home/.shelly/pty-${sessionId}.sock`;
await TerminalEmulator.createSession({
  sessionId: nativeSessionId,
  socketPath,
  rows: 24,
  cols: 80,
});
```

- [ ] **Step 3: Remove tmux resize fallback from onResize handler**

Remove the `runRawCommand("tmux resize-window ...")` call from the onResize callback. The resize now goes through the socket protocol.

- [ ] **Step 4: Remove tmuxSessionName prop from NativeTerminalView usage**

- [ ] **Step 5: Update session recovery for Unix socket reconnection**

On app foreground: check if socket file exists and pty-helper is running. If not, restart pty-helper.

- [ ] **Step 6: Commit**

```bash
git add app/(tabs)/terminal.tsx
git commit -m "feat(terminal): switch to pty-helper + Unix socket session lifecycle"
```

---

### Task 5: Update bridge server.js for pty-helper management

**Files:**
- Modify: `shelly-bridge/server.js`

- [ ] **Step 1: Add startPty message handler**

```javascript
case 'startPty': {
  const { sessionId, cols, rows } = msg;
  const scriptPath = path.join(__dirname, 'start-pty.sh');
  const proc = spawn('bash', [scriptPath, sessionId, String(cols || 80), String(rows || 24)], {
    cwd: os.homedir(),
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  send(ws, { type: 'ptyStarted', sessionId, socketPath: `/data/data/com.termux/files/home/.shelly/pty-${sessionId}.sock` });
  break;
}
```

- [ ] **Step 2: Add stopPty message handler**

Kill pty-helper process and clean up socket file.

- [ ] **Step 3: Commit**

```bash
git add shelly-bridge/server.js
git commit -m "feat(bridge): add startPty/stopPty handlers for pty-helper lifecycle"
```

---

### Task 6: Clean up old socat/tmux code

**Files:**
- Delete: `shelly-bridge/socat-session.sh`
- Modify: `app/(tabs)/terminal.tsx` — remove socat references
- Keep: `lib/tmux-manager.ts` — for user-facing tmux commands (optional use)

- [ ] **Step 1: Remove socat-session.sh**

```bash
rm shelly-bridge/socat-session.sh
```

- [ ] **Step 2: Remove socat startup code from terminal.tsx**

Remove any `runRawCommand` calls that reference `socat-session.sh` or `socat`.

- [ ] **Step 3: Update start-shelly.sh to not create mandatory tmux sessions**

Keep the bridge server startup. Remove forced `tmux new-session` creation.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove socat dependency, make tmux optional"
```

---

### Task 7: Build and test

- [ ] **Step 1: Verify TypeScript compiles**

```bash
cd ~/Shelly && npx tsc --noEmit
```

- [ ] **Step 2: Push and trigger GitHub Actions build**

```bash
git push
```

- [ ] **Step 3: Install APK and test three Z Fold scenarios**

1. Full screen terminal → correct size
2. Fold to cover screen → correct resize
3. Split view (chat + terminal) → correct resize

- [ ] **Step 4: Test session persistence**

1. Open terminal, run a command
2. Switch to another app for 30s
3. Return → session still connected, output visible

- [ ] **Step 5: Test text input and scrolling**

1. Type regular text
2. Type Japanese (via Nacre)
3. Scroll up/down in terminal history

- [ ] **Step 6: Commit any fixes**
