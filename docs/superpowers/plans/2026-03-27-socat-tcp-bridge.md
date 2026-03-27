# socat+TCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Native Terminal View by replacing JNI fork/exec (blocked by Android UID sandbox) with socat+TCP loopback bridge. Terminal output flows through the same vendored TerminalEmulator parser and TerminalView Canvas renderer — only the I/O transport layer changes.

**Architecture:** Termux side runs `socat` to bridge a PTY (bash/tmux) to a TCP loopback port. Shelly's Native Module connects via TCP socket and feeds the raw byte stream into TerminalSession/TerminalEmulator. TerminalView renders via Canvas as before. No WebView, no ttyd, no xterm.js.

**Tech Stack:** Kotlin (Expo Modules API), Java (vendored Termux libs, modified TerminalSession), socat (Termux pkg), TypeScript/React Native

**Spec:** This plan is the spec. The original `2026-03-27-native-terminal-view-design.md` remains valid for all non-transport aspects.

**Key Insight:** The vendored `TerminalSession.java` calls `JNI.createSubprocess()` to fork/exec — this fails because Shelly's UID cannot access Termux's binaries. We add `initializeWithFd()` to TerminalSession that accepts an already-open socket fd instead of forking. Everything downstream (TerminalEmulator parser, TerminalView renderer, events, batching) remains unchanged.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `~/shelly-bridge/socat-session.sh` | Shell script: starts socat PTY↔TCP relay for one session |

### Modified Files

| File | Changes |
|------|---------|
| `modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalSession.java` | Add `initializeWithFd(fd, cols, rows)` method — creates emulator + I/O threads using existing fd instead of fork/exec |
| `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt` | Replace `TerminalSession(shellCmd, cwd, args, env, ...)` with TCP socket connection → `initializeWithFd()` |
| `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt` | Update `createSession` to accept `port` param, remove shell availability check |
| `modules/terminal-emulator/src/TerminalEmulatorModule.ts` | Add `port` to `SessionConfig` interface |
| `app/(tabs)/terminal.tsx` | Update `createNativeSession` to launch socat via TermuxBridge, pass port to createSession |
| `store/terminal-store.ts` | Add port allocation logic (base port 18200 + session index) |

### Unchanged Files (confirm no changes needed)

| File | Reason |
|------|--------|
| `modules/terminal-view/**` | View/renderer untouched — still receives TerminalSession via `attachSession()` |
| `hooks/use-terminal-output.ts` | Still listens to `onSessionOutput` events — unchanged |
| `lib/terminal-session-monitor.ts` | Still checks tmux health — unchanged |
| `store/types.ts` | TabSession type already has all needed fields |

---

## Task Breakdown

### Task 0: Install socat + Create Bridge Script

**Files:**
- Create: `~/shelly-bridge/socat-session.sh`

- [ ] **Step 1: Install socat in Termux**

```bash
pkg install -y socat
```

- [ ] **Step 2: Create socat-session.sh**

```bash
#!/data/data/com.termux/files/usr/bin/bash
# socat-session.sh — Bridge a tmux session to a TCP port via PTY
# Usage: socat-session.sh <port> <tmux-session-name>
#
# Creates tmux session if it doesn't exist, then relays its PTY
# I/O over TCP loopback. Shelly's Native Module connects to this port.

PORT="${1:?Usage: socat-session.sh <port> <tmux-session-name>}"
TMUX_SESSION="${2:?Usage: socat-session.sh <port> <tmux-session-name>}"
TMUX_BIN="/data/data/com.termux/files/usr/bin/tmux"

# Ensure tmux session exists
"$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null || \
  "$TMUX_BIN" new-session -d -s "$TMUX_SESSION" -x 80 -y 24

# Configure tmux for OSC 133 passthrough
"$TMUX_BIN" set-option -t "$TMUX_SESSION" -g allow-passthrough on 2>/dev/null

# Kill any existing socat on this port
pkill -f "socat.*TCP-LISTEN:${PORT}" 2>/dev/null
sleep 0.2

# Start socat: attach to tmux session via PTY, relay over TCP
# fork: accept multiple connections (reconnect support)
# reuseaddr: allow quick restart
exec socat \
  "TCP-LISTEN:${PORT},bind=127.0.0.1,reuseaddr,fork" \
  "EXEC:${TMUX_BIN} attach-session -t ${TMUX_SESSION},pty,setsid,ctty,stderr"
```

- [ ] **Step 3: Make executable and test manually**

```bash
chmod +x ~/shelly-bridge/socat-session.sh
# Test: start on port 18200 with tmux session shelly-test
~/shelly-bridge/socat-session.sh 18200 shelly-test &
sleep 1
# Verify: connect with nc and type a command
echo "echo hello" | nc 127.0.0.1 18200
# Should see bash output
kill %1
tmux kill-session -t shelly-test 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
cd ~/Shelly
git add ~/shelly-bridge/socat-session.sh
git commit -m "feat: add socat PTY-TCP bridge script for native terminal"
```

---

### Task 1: Add initializeWithFd to TerminalSession.java

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalSession.java`

**Purpose:** Add a method that initializes the emulator and I/O threads using an already-open file descriptor (TCP socket) instead of fork/exec. This is the key change that bypasses the UID sandbox issue.

- [ ] **Step 1: Add initializeWithFd method**

Add after `initializeEmulator()` method (~line 174):

```java
/**
 * Initialize emulator with an already-open file descriptor (e.g., TCP socket to socat).
 * Unlike initializeEmulator(), this does NOT fork/exec a subprocess.
 * The fd is used directly for terminal I/O read/write.
 */
public void initializeWithFd(int fd, int columns, int rows, int cellWidthPixels, int cellHeightPixels) {
    mEmulator = new TerminalEmulator(this, columns, rows, cellWidthPixels, cellHeightPixels, mTranscriptRows, mClient);
    mTerminalFileDescriptor = fd;
    mShellPid = 0; // No local process — socat runs in Termux

    final FileDescriptor fdWrapped = wrapFileDescriptor(fd, mClient);

    new Thread("TermSessionInputReader[fd=" + fd + "]") {
        @Override
        public void run() {
            try (InputStream termIn = new FileInputStream(fdWrapped)) {
                final byte[] buffer = new byte[4096];
                while (true) {
                    int read = termIn.read(buffer);
                    if (read == -1) return;
                    if (!mProcessToTerminalIOQueue.write(buffer, 0, read)) return;
                    mMainThreadHandler.sendEmptyMessage(MSG_NEW_INPUT);
                }
            } catch (Exception e) {
                // Connection closed or error — signal session exit
                mMainThreadHandler.sendMessage(
                    mMainThreadHandler.obtainMessage(MSG_PROCESS_EXITED, 0)
                );
            }
        }
    }.start();

    new Thread("TermSessionOutputWriter[fd=" + fd + "]") {
        @Override
        public void run() {
            final byte[] buffer = new byte[4096];
            try (FileOutputStream termOut = new FileOutputStream(fdWrapped)) {
                while (true) {
                    int bytesToWrite = mTerminalToProcessIOQueue.read(buffer, true);
                    if (bytesToWrite == -1) return;
                    termOut.write(buffer, 0, bytesToWrite);
                }
            } catch (IOException e) {
                // Ignore — connection closed
            }
        }
    }.start();

    // No waiter thread needed — socat process is in Termux, not ours to wait on.
    // Session exit is detected when InputReader gets EOF (read == -1).
}
```

- [ ] **Step 2: Add isRunning check for fd-based sessions**

In `isRunning` method (find it), ensure it handles `mShellPid == 0` (fd-based session):

```java
// Existing: return mShellPid != -1;
// Change to: fd-based sessions are running as long as the fd is valid
public boolean isRunning() {
    if (mShellPid == 0 && mTerminalFileDescriptor != -1) {
        // fd-based session: running until fd is closed
        return mEmulator != null;
    }
    return mShellPid != -1;
}
```

- [ ] **Step 3: Update finishIfRunning for fd-based sessions**

Find `finishIfRunning()` and ensure it closes the socket fd:

```java
// Add at the top of finishIfRunning():
if (mShellPid == 0 && mTerminalFileDescriptor != -1) {
    // fd-based session: just close the socket
    JNI.close(mTerminalFileDescriptor);
    mTerminalFileDescriptor = -1;
    return;
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd ~/Shelly && npx expo prebuild --platform android --clean 2>&1 | tail -5
cd ~/Shelly/android && ./gradlew :modules:terminal-emulator:compileDebugJavaWithJavac 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd ~/Shelly
git add modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalSession.java
git commit -m "feat: add initializeWithFd() for socket-based terminal sessions"
```

---

### Task 2: Rewrite ShellyTerminalSession.kt for TCP Socket

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`

**Purpose:** Instead of passing shell path/args to TerminalSession (which triggers fork/exec), connect a TCP socket to the socat bridge and pass the socket fd to `initializeWithFd()`.

- [ ] **Step 1: Rewrite ShellyTerminalSession.kt**

Replace the `init` block and add socket connection logic:

```kotlin
package expo.modules.terminalemulator

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import java.net.Socket

class ShellyTerminalSession(
    private val sessionId: String,
    private val emitEvent: (name: String, body: Map<String, Any?>) -> Unit,
    private val port: Int,
    rows: Int,
    cols: Int
) : TerminalSessionClient {

    companion object {
        private const val TAG = "ShellyTerminalSession"
        private const val BATCH_INTERVAL_MS = 16L
        private const val MAX_OUTPUT_BYTES = 64 * 1024
    }

    private val outputBuffer = StringBuilder()
    private val batchHandler = Handler(Looper.getMainLooper())
    @Volatile private var flushScheduled = false
    private var lastTranscriptLength = 0

    private var socket: Socket? = null
    val terminalSession: TerminalSession

    init {
        // Create a TerminalSession with dummy shell path — we won't fork/exec
        terminalSession = TerminalSession(
            "/bin/true", "/", arrayOf(), arrayOf(), null, this
        )

        // Connect TCP socket to socat bridge
        val sock = Socket("127.0.0.1", port)
        sock.tcpNoDelay = true
        socket = sock

        // Get the native fd from the socket via ParcelFileDescriptor
        val fd = getSocketFd(sock)

        // Initialize emulator with the socket fd (no fork/exec)
        terminalSession.initializeWithFd(fd, cols, rows, 1, 1)
    }

    /**
     * Extract the native file descriptor from a Socket.
     * Uses reflection to access the underlying FileDescriptor's int fd.
     */
    private fun getSocketFd(sock: Socket): Int {
        val implField = Socket::class.java.getDeclaredField("impl")
        implField.isAccessible = true
        val impl = implField.get(sock)

        val fdField = impl.javaClass.getDeclaredField("fd")
        fdField.isAccessible = true
        val fileDescriptor = fdField.get(impl) as java.io.FileDescriptor

        val fdIntField = java.io.FileDescriptor::class.java.getDeclaredField("fd")
        fdIntField.isAccessible = true
        return fdIntField.getInt(fileDescriptor)
    }

    // --- flushRunnable, appendToOutputBuffer, flushOutputBuffer: UNCHANGED ---
    // (keep existing output batching code exactly as-is)

    private val flushRunnable = Runnable { flushOutputBuffer() }

    @Synchronized
    private fun appendToOutputBuffer(text: String) {
        if (outputBuffer.length + text.length > MAX_OUTPUT_BYTES) {
            val available = MAX_OUTPUT_BYTES - outputBuffer.length
            if (available > 0) outputBuffer.append(text, 0, available)
        } else {
            outputBuffer.append(text)
        }
        if (!flushScheduled) {
            flushScheduled = true
            batchHandler.postDelayed(flushRunnable, BATCH_INTERVAL_MS)
        }
    }

    @Synchronized
    private fun flushOutputBuffer() {
        flushScheduled = false
        if (outputBuffer.isEmpty()) return
        val data = outputBuffer.toString()
        outputBuffer.clear()
        emitEvent("onSessionOutput", mapOf("sessionId" to sessionId, "data" to data))
    }

    // --- Public API ---

    fun write(data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        terminalSession.write(bytes, 0, bytes.size)
    }

    fun resize(rows: Int, cols: Int) {
        // Note: socat PTY size is set at creation. For resize, we need to
        // send SIGWINCH via tmux. TerminalEmulator internal state is updated here.
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    fun isAlive(): Boolean {
        return socket?.isConnected == true && !(socket?.isClosed ?: true)
    }

    fun destroy() {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        terminalSession.finishIfRunning()
        try { socket?.close() } catch (_: Exception) {}
        socket = null
    }

    fun getTitle(): String = terminalSession.title ?: ""

    fun getTranscriptText(maxLines: Int): String {
        val emulator = terminalSession.emulator ?: return ""
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return ""
        if (maxLines <= 0) return fullText
        val lines = fullText.split('\n')
        return if (lines.size > maxLines) lines.takeLast(maxLines).joinToString("\n") else fullText
    }

    // --- TerminalSessionClient: ALL UNCHANGED from current code ---
    // (onTextChanged, onTitleChanged, onSessionFinished, etc.)

    override fun onTextChanged(changedSession: TerminalSession) {
        val emulator = changedSession.emulator ?: return
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return
        val currentLength = fullText.length
        if (currentLength > lastTranscriptLength) {
            val newText = fullText.substring(lastTranscriptLength)
            lastTranscriptLength = currentLength
            appendToOutputBuffer(newText)
        } else if (currentLength < lastTranscriptLength) {
            lastTranscriptLength = currentLength
            if (fullText.isNotEmpty()) appendToOutputBuffer(fullText)
        }
    }

    override fun onTitleChanged(changedSession: TerminalSession) {
        emitEvent("onTitleChanged", mapOf("sessionId" to sessionId, "title" to (changedSession.title ?: "")))
    }

    override fun onSessionFinished(finishedSession: TerminalSession) {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to finishedSession.exitStatus))
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {}
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession) {
        emitEvent("onBell", mapOf("sessionId" to sessionId))
    }
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {
        Log.d(TAG, "Session $sessionId fd-based (no local PID)")
    }
    override fun getTerminalCursorStyle(): Int = 0
    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Exception", e) }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Shelly/android && ./gradlew :modules:terminal-emulator:compileDebugKotlin 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
cd ~/Shelly
git add modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt
git commit -m "feat: rewrite ShellyTerminalSession for TCP socket connection to socat"
```

---

### Task 3: Update TerminalEmulatorModule.kt

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt`
- Modify: `modules/terminal-emulator/src/TerminalEmulatorModule.ts`

- [ ] **Step 1: Update Kotlin module**

```kotlin
package expo.modules.terminalemulator

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalEmulatorModule : Module() {

    private val sessions = mutableMapOf<String, ShellyTerminalSession>()

    private fun emitEvent(name: String, body: Map<String, Any?>) {
        sendEvent(name, body)
    }

    override fun definition() = ModuleDefinition {
        Name("TerminalEmulator")

        Events("onSessionOutput", "onSessionExit", "onTitleChanged", "onBell")

        AsyncFunction("createSession") { config: Map<String, Any?> ->
            val sessionId = config["sessionId"] as? String
                ?: throw IllegalArgumentException("sessionId is required")
            val port = (config["port"] as? Number)?.toInt()
                ?: throw IllegalArgumentException("port is required")
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80

            if (sessions.containsKey(sessionId)) {
                throw IllegalStateException("Session $sessionId already exists")
            }

            val session = ShellyTerminalSession(
                sessionId = sessionId,
                emitEvent = ::emitEvent,
                port = port,
                rows = rows,
                cols = cols
            )

            sessions[sessionId] = session
            sessionId
        }

        // destroySession, writeToSession, resizeSession, isSessionAlive,
        // getTranscriptText, getSessionTitle: UNCHANGED
        AsyncFunction("destroySession") { sessionId: String ->
            val session = sessions.remove(sessionId)
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.destroy()
        }

        AsyncFunction("writeToSession") { sessionId: String, data: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.write(data)
        }

        AsyncFunction("sendKeyEvent") { sessionId: String, keyCode: Int, modifiers: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            if (keyCode in 32..126) session.write(keyCode.toChar().toString())
        }

        AsyncFunction("resizeSession") { sessionId: String, rows: Int, cols: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.resize(rows, cols)
        }

        AsyncFunction("isSessionAlive") { sessionId: String ->
            val session = sessions[sessionId] ?: return@AsyncFunction false
            session.isAlive()
        }

        AsyncFunction("getTranscriptText") { sessionId: String, maxLines: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTranscriptText(maxLines)
        }

        AsyncFunction("getSessionTitle") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTitle()
        }
    }
}
```

- [ ] **Step 2: Update TypeScript API**

```typescript
// modules/terminal-emulator/src/TerminalEmulatorModule.ts
import { NativeModule, requireNativeModule } from 'expo-modules-core';

export interface SessionConfig {
  sessionId: string;
  port: number;       // TCP port where socat is listening
  rows?: number;
  cols?: number;
}

declare class TerminalEmulatorModuleType extends NativeModule {
  createSession(config: SessionConfig): Promise<string>;
  destroySession(sessionId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): Promise<void>;
  sendKeyEvent(sessionId: string, keyCode: number, modifiers: number): Promise<void>;
  resizeSession(sessionId: string, rows: number, cols: number): Promise<void>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  getTranscriptText(sessionId: string, maxLines: number): Promise<string>;
  getSessionTitle(sessionId: string): Promise<string>;
}

export default requireNativeModule<TerminalEmulatorModuleType>('TerminalEmulator');
```

- [ ] **Step 3: Commit**

```bash
cd ~/Shelly
git add modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt
git add modules/terminal-emulator/src/TerminalEmulatorModule.ts
git commit -m "feat: update TerminalEmulatorModule for socat TCP port-based sessions"
```

---

### Task 4: Update terminal.tsx Session Creation

**Files:**
- Modify: `app/(tabs)/terminal.tsx`
- Modify: `store/terminal-store.ts` (add port allocation)

- [ ] **Step 1: Add port allocation to terminal-store.ts**

Add constant and helper near the top of the store:

```typescript
// Base port for socat bridges. Each session gets BASE + index.
const SOCAT_BASE_PORT = 18200;

// In createSession or wherever sessions are initialized:
// session.port = SOCAT_BASE_PORT + sessions.length;
```

Add `port` field to the session creation logic (where `nativeSessionId` is assigned).

- [ ] **Step 2: Update createNativeSession in terminal.tsx**

Replace the current createNativeSession with:

```typescript
const createNativeSession = useCallback(async (session: TabSession) => {
  try {
    const port = SOCAT_BASE_PORT + sessions.indexOf(session);

    // 1. Launch socat bridge in Termux (creates tmux session + TCP relay)
    await runRawCommand(
      `nohup ~/shelly-bridge/socat-session.sh ${port} "${session.tmuxSession}" > /dev/null 2>&1 &`,
      { timeoutMs: 5000, reason: 'socat-start' }
    );

    // 2. Wait for socat to be ready
    await new Promise(resolve => setTimeout(resolve, 800));

    // 3. Create native session connected to socat TCP port
    await TerminalEmulator.createSession({
      sessionId: session.nativeSessionId,
      port,
      rows: 24,
      cols: 80,
    });

    // 4. Mark session as alive
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
      ),
    }));
  } catch (err) {
    console.error('[Terminal] Failed to create native session:', err);
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, sessionStatus: 'exited' as const, isAlive: false } : s
      ),
    }));
  }
}, [runRawCommand, sessions]);
```

- [ ] **Step 3: Update recoverSession to kill old socat + restart**

```typescript
const recoverSession = useCallback(async (session: TabSession) => {
  setIsRecovering(true);
  useTerminalStore.setState((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === session.id ? { ...s, sessionStatus: 'recovering' as const } : s
    ),
  }));

  // Destroy old native session
  try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

  // Kill old socat for this session's tmux
  const port = SOCAT_BASE_PORT + sessions.indexOf(session);
  await runRawCommand(
    `pkill -f "socat.*TCP-LISTEN:${port}" 2>/dev/null; true`,
    { timeoutMs: 3000, reason: 'socat-kill' }
  );

  // Re-create
  await createNativeSession(session);

  // Resume CLI if active
  if (session.activeCli) {
    const resumeCmd = buildRecoveryCommand(session.currentDir, session.activeCli);
    if (resumeCmd) {
      setTimeout(async () => {
        await sendKeysToSession(session.tmuxSession, resumeCmd, runRawCommand);
      }, 3000);
    }
  }

  setIsRecovering(false);
}, [createNativeSession, runRawCommand, sessions]);
```

- [ ] **Step 4: Remove redundant tmux creation from createNativeSession**

The old code had separate `runRawCommand` calls to create tmux session and configure passthrough. These are now handled by `socat-session.sh`. Remove them.

- [ ] **Step 5: Commit**

```bash
cd ~/Shelly
git add app/\(tabs\)/terminal.tsx store/terminal-store.ts
git commit -m "feat: wire terminal.tsx to socat bridge for session creation"
```

---

### Task 5: Clean Up Dead Code

**Files:**
- Modify: `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyShellEnvironment.kt`

- [ ] **Step 1: Simplify ShellyShellEnvironment**

`ShellyShellEnvironment.kt` is no longer used by `ShellyTerminalSession` (we don't fork/exec anymore). However, `TerminalViewModule` or other code might reference it. Check if anything imports it:

```bash
grep -r "ShellyShellEnvironment\|ShellEnvironment\|TermuxShellEnvironment" ~/Shelly/modules/ --include="*.kt"
```

If only the old `TerminalEmulatorModule` referenced it, delete or keep as-is (it's harmless). Don't delete if other code uses it.

- [ ] **Step 2: Commit cleanup**

```bash
cd ~/Shelly
git add -A modules/terminal-emulator/
git commit -m "chore: clean up unused shell environment after socat migration"
```

---

### Task 6: Build + Test

- [ ] **Step 1: Run expo prebuild**

```bash
cd ~/Shelly && npx expo prebuild --platform android --clean 2>&1 | tail -20
```

- [ ] **Step 2: Trigger GitHub Actions build**

```bash
cd ~/Shelly && git push origin main
gh run list --limit 1
```

Or local Gradle build if possible:
```bash
cd ~/Shelly/android && ./gradlew :app:assembleDebug 2>&1 | tail -30
```

- [ ] **Step 3: Install APK and test**

1. Open Shelly app
2. Go to Terminal tab
3. Verify: should see terminal prompt (not "Session not available")
4. Type `ls` and verify output renders
5. Test Japanese input proxy
6. Test Reload button
7. Verify: StatusBadge shows "Connected" (green)

- [ ] **Step 4: Commit any fixes**

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Socket fd extraction via reflection may break on some Android versions | Fall back to `ParcelFileDescriptor.fromSocket()` if reflection fails |
| socat not installed on user's Termux | Add socat to setup wizard prerequisites check |
| Port collision | Use high ports (18200+), check with `ss -tlnp` before binding |
| socat process killed by Android | Same risk as ttyd (lower actually — socat is smaller). Session monitor detects and recovers. |
| TCP loopback security (other apps can connect) | socat with `fork` allows reconnect; single-session-per-port limits exposure. Future: add shared secret handshake. |
