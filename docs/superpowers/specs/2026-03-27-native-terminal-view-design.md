# Native Terminal View Design Spec

## Overview

Replace WebView + ttyd + xterm.js with a native Android terminal view built on Termux's `terminal-emulator` and `terminal-view` libraries (Apache 2.0). This eliminates 2 process boundaries, removes ttyd dependency, and connects terminal output directly to React Native state for cross-pane intelligence.

**This is the world's first React Native native terminal emulator module.**

### Problem Statement

The current WebView + ttyd architecture has 4 process boundaries (RN → WebView → ttyd → tmux → bash). Any layer dying causes cascading failures:
- Android kills ttyd → terminal goes blank
- WebView render process dies → reconnection loop with "Connecting to TDY"
- xterm.js Unicode addon fails to load from CDN → CJK text garbled
- JS injection polling (500ms) loses output and adds latency

### Solution

Native Android View that renders terminal output via Android Canvas, with PTY managed through JNI. tmux remains for session persistence.

```
【Current】 RN → WebView → ttyd(HTTP/WS) → tmux → bash
【New】     RN → NativeTerminalView → PTY(JNI) → tmux → bash
```

### Design Principles

1. **Shelly design philosophy**: non-engineers use natural language only; hide Termux from users; setup in 5 minutes
2. **Battery first**: only active session draws; screen-off stops rendering; no polling
3. **Cross-pane integrity**: terminal output flows directly to React Native state — no JS injection, no WebView bridge
4. **Zero regression**: every existing feature (themes, keybar, voice, file attach, savepoints, split view) works identically or better
5. **Best-in-class UX**: incorporate proven patterns from Ghostty, Warp, VS Code, Zed, iTerm2

---

## Architecture

### Module Structure

```
~/Shelly/modules/
  ├── terminal-emulator/              ← NEW
  │   ├── android/src/main/java/
  │   │   ├── com/termux/terminal/   ← vendor (Apache 2.0, Java)
  │   │   │   ├── TerminalEmulator.java
  │   │   │   ├── TerminalSession.java
  │   │   │   ├── TerminalBuffer.java
  │   │   │   ├── TerminalRow.java
  │   │   │   ├── TerminalColors.java
  │   │   │   ├── TerminalColorScheme.java
  │   │   │   ├── TerminalOutput.java
  │   │   │   ├── TerminalSessionClient.java
  │   │   │   ├── TextStyle.java
  │   │   │   ├── WcWidth.java        ← CJK width (solves garbled text)
  │   │   │   ├── KeyHandler.java
  │   │   │   ├── ByteQueue.java
  │   │   │   ├── JNI.java
  │   │   │   └── Logger.java
  │   │   └── expo/modules/terminalemulator/
  │   │       ├── TerminalEmulatorModule.kt   ← Expo Module definition
  │   │       ├── ShellyTerminalSession.kt    ← Session lifecycle + PTY
  │   │       └── ShellyShellEnvironment.kt   ← Termux env paths (future abstraction point)
  │   ├── android/src/main/jni/
  │   │   ├── termux.c                ← PTY operations (~80 lines)
  │   │   └── Android.mk             ← NDK build config
  │   ├── expo-module.config.json
  │   ├── src/
  │   │   ├── TerminalEmulatorModule.ts   ← TypeScript API
  │   │   └── index.ts
  │   └── build.gradle
  │
  ├── terminal-view/                  ← NEW
  │   ├── android/src/main/java/
  │   │   ├── com/termux/view/       ← vendor (Apache 2.0, Java)
  │   │   │   ├── TerminalView.java
  │   │   │   ├── TerminalRenderer.java
  │   │   │   ├── GestureAndScaleRecognizer.java
  │   │   │   └── textselection/
  │   │   │       ├── TextSelectionCursorController.java
  │   │   │       └── TextSelectionHandleView.java
  │   │   └── expo/modules/terminalview/
  │   │       ├── TerminalViewModule.kt       ← Expo Module definition
  │   │       ├── ShellyTerminalView.kt       ← Expo Native View wrapper
  │   │       ├── ShellyTerminalRenderer.kt   ← Font loading + theme rendering
  │   │       ├── ShellyInputHandler.kt       ← IME, gestures, key events
  │   │       ├── BlockDetector.kt            ← Warp-style command block detection
  │   │       ├── LinkDetector.kt             ← URL/filepath hyperlink detection
  │   │       └── FontManager.kt             ← Bundled font management
  │   ├── android/src/main/assets/fonts/
  │   │   ├── JetBrainsMono-Regular.ttf       ← ~300KB, SIL OFL
  │   │   ├── JetBrainsMono-Bold.ttf
  │   │   ├── JetBrainsMono-Italic.ttf
  │   │   ├── FiraCode-Regular.ttf            ← ~200KB, SIL OFL
  │   │   ├── FiraCode-Bold.ttf
  │   │   ├── PixelMplus10-Regular.ttf        ← ~1MB, M+ License (CJK dot font)
  │   │   └── PixelMplus12-Regular.ttf
  │   ├── expo-module.config.json
  │   ├── src/
  │   │   ├── TerminalViewModule.ts       ← TypeScript API
  │   │   ├── NativeTerminalView.tsx      ← React Native component
  │   │   └── index.ts
  │   └── build.gradle
  │
  └── termux-bridge/                  ← EXISTING (keep)
```

### Data Flow

```
User Input (touch / keyboard / voice)
  ↓
ShellyInputHandler.kt
  ↓ KeyEvent
ShellyTerminalSession.kt → PTY write (JNI)
  ↓
tmux → bash → command execution
  ↓
PTY read (JNI) → TerminalEmulator (escape sequence parsing) → TerminalBuffer
  ↓                                                             ↓
ShellyTerminalRenderer.kt                              Kotlin → RN Event
  ↓ (Android Canvas)                                          ↓
Screen                                              execution-log-store
                                                           ↓
                                                Cross-pane intelligence
                                                (translate, summarize,
                                                 debug suggestions,
                                                 "ask AI" action)
```

### Process Architecture Comparison

| | Current (WebView+ttyd) | New (Native View) |
|---|---|---|
| Processes | RN + WebView + ttyd + tmux + bash | RN + tmux + bash |
| IPC boundaries | 4 (RN↔WV↔ttyd↔tmux↔bash) | 2 (RN↔PTY↔tmux↔bash) |
| Output capture | JS injection, 500ms polling | PTY read, realtime callback |
| CJK rendering | CDN addon, fragile | WcWidth.java, built-in |
| Phantom Process risk | High (ttyd + WebView) | Low (only tmux + bash) |
| Battery (idle) | WebView canvas + ttyd WS ping | Zero (Canvas stops on idle) |

---

## NDK / JNI Build Specification

### Build System

Use **CMake** (not Android.mk) for NDK integration. Modern Android/Expo projects use CMake.

```
modules/terminal-emulator/
  ├── android/
  │   ├── CMakeLists.txt           ← CMake build config
  │   ├── src/main/jni/
  │   │   └── termux.c             ← PTY operations
  │   └── build.gradle             ← externalNativeBuild { cmake { ... } }
```

**CMakeLists.txt:**
```cmake
cmake_minimum_required(VERSION 3.18.1)
project(termux)
add_library(termux SHARED src/main/jni/termux.c)
target_link_libraries(termux log)
```

**build.gradle (module-level):**
```groovy
android {
    ndkVersion "26.1.10909125"  // Match EAS Build NDK version
    defaultConfig {
        externalNativeBuild {
            cmake {
                cppFlags ""
                abiFilters "armeabi-v7a", "arm64-v8a"
            }
        }
    }
    externalNativeBuild {
        cmake {
            path "CMakeLists.txt"
        }
    }
}
```

### JNI Function Signatures (from JNI.java)

```java
public class JNI {
    static { System.loadLibrary("termux"); }

    // Create PTY subprocess. Returns master fd. Sets processId[0] to child pid.
    public static native int createSubprocess(
        String cmd, String cwd, String[] args, String[] envVars,
        int[] processId, int rows, int columns, int cellWidth, int cellHeight
    );

    // Resize PTY window
    public static native void setPtyWindowSize(int fd, int rows, int cols, int cellWidth, int cellHeight);

    // Wait for child process exit
    public static native int waitFor(int pid);

    // Close PTY master fd
    public static native void close(int fd);
}
```

### EAS Build Compatibility

- NDK version pinned in build.gradle to match EAS Build environment
- `abiFilters` limited to `armeabi-v7a` and `arm64-v8a` (Shelly targets ARM Android only)
- Phase 0 of implementation: build an empty module with JNI to validate EAS Build pipeline before writing any logic

### Vendored Code Tracking

Each vendor directory includes a `VENDORED.md` file:
```markdown
Source: https://github.com/termux/termux-app
Commit: <sha>
Tag: v0.118.0
Date: <date>
License: Apache 2.0
```

---

## Output Throttling and Backpressure

### Problem

A command like `cat /dev/urandom | base64` can produce megabytes per second. The old 500ms JS polling acted as accidental throttle. Without it, the Kotlin→RN event bridge will be flooded.

### Solution: Frame-Aligned Batching

PTY output is batched on the Kotlin side before crossing to React Native:

```
PTY read thread (blocking read on fd)
  ↓ accumulates bytes in StringBuilder
  ↓ every 16ms (1 frame at 60fps), post batch to main thread
Main thread
  ↓ emit single "onSessionOutput" event with accumulated text
  ↓ clear StringBuilder
React Native
  ↓ addTerminalOutput(batchedText, sessionId)
```

**Implementation in ShellyTerminalSession.kt:**

```kotlin
private val outputBuffer = StringBuilder()
private val batchHandler = Handler(Looper.getMainLooper())
private val BATCH_INTERVAL_MS = 16L  // ~60fps
@Volatile private var flushScheduled = false

private val flushRunnable = Runnable {
    val text = synchronized(outputBuffer) {
        val t = outputBuffer.toString()
        outputBuffer.clear()
        t
    }
    flushScheduled = false
    if (text.isNotEmpty()) {
        emitEvent("onSessionOutput", mapOf("sessionId" to sessionId, "data" to text))
    }
}

// Called from PTY read thread
fun onNewOutput(data: String) {
    synchronized(outputBuffer) {
        outputBuffer.append(data)
    }
    // Only schedule if not already pending — prevents perpetual deferral
    if (!flushScheduled) {
        flushScheduled = true
        batchHandler.postDelayed(flushRunnable, BATCH_INTERVAL_MS)
    }
}
```

**For execution-log-store integration:**

The TypeScript side further throttles for the cross-pane log buffer:
- `addTerminalOutput()` already batches into `hotBuffer` (100 lines) and `sessionBuffer` (1000 lines)
- Lines are split from the batched text on the TypeScript side
- `sessionId` and `timestamp` are added at the TypeScript layer (in `terminal.tsx`'s `onOutput` handler)

**Backpressure:** If output exceeds 64KB in a single batch interval, truncate the middle and keep first 1KB + last 1KB (preserving command start and final output). Log a warning to the user: "Output truncated (very high throughput)".

---

## Error Recovery Protocol

### Failure Scenarios and Recovery

**Scenario 1: PTY fd becomes invalid (child process crash)**
```
TerminalSession.onProcessExited(exitCode)
  ↓
ShellyTerminalSession emits "onSessionExit" event
  ↓
terminal.tsx receives event
  ↓
If activeCli != null:
  1. Check tmux session alive: tmux has-session -t "shelly-N"
  2. If alive: createSession() with same tmuxSessionName → reattach
  3. If dead: createSession() with useTmux=true → new tmux session
  4. Send CLI resume command: sendKeysToSession("claude --continue")
If activeCli == null:
  1. Show "Session ended" inline message
  2. Auto-restart: createSession() with same cwd
```

**Scenario 2: tmux server dies**
```
tmux has-session returns error
  ↓
terminal-session-monitor.ts detects (60s check)
  ↓
For each affected session:
  1. Start new tmux server: tmux new-session -d -s "shelly-N"
  2. Destroy old PTY session: destroySession()
  3. Create new PTY session: createSession() with useTmux=true
  4. Notify user: "Session recovered" inline message
```

**Scenario 3: JNI/native module crash (segfault)**
```
Android restarts the app process
  ↓
App cold-starts, loads session state from AsyncStorage
  ↓
For each session with isAlive=true:
  1. Check tmux: tmux has-session -t "shelly-N"
  2. If alive: createSession() to reattach → full recovery
  3. If dead: mark session as ended, preserve blocks/history
```

**Scenario 4: Android OOM killer terminates app**
```
Same as Scenario 3 — tmux sessions survive in Termux process
```

### Session Monitor (replaces phantom-process-guard.ts)

```typescript
// lib/terminal-session-monitor.ts
const CHECK_INTERVAL = 60_000; // 60s (was 15s for ttyd)

// Only checks tmux sessions, not ttyd processes
// Triggers recovery callback if tmux session dies unexpectedly
```

---

## Output Event Architecture

### Canonical Path Decision

The `TerminalEmulatorModule` EventEmitter is the **canonical source** of terminal output. It fires regardless of whether a view is mounted (critical for background sessions).

```
PTY read → ShellyTerminalSession → EventEmitter("onSessionOutput")
                                         ↓
                              ┌──────────┴──────────┐
                              ↓                      ↓
                    View mounted?              Always running
                    onOutput prop              useTerminalOutput hook
                    (rendering)                (execution-log-store)
```

**useTerminalOutput hook** (new):
```typescript
// hooks/use-terminal-output.ts
// Subscribes to TerminalEmulatorModule events
// Feeds addTerminalOutput() for ALL sessions, including background ones
// Independent of view lifecycle
```

The `NativeTerminalViewProps.onOutput` callback is a **convenience for view-specific UI reactions** (e.g., auto-scroll). It is NOT the path for execution-log-store.

---

## BlockDetector: Prompt Detection Strategy

### Approach: PROMPT_COMMAND Injection

Shelly injects a custom `PROMPT_COMMAND` via the session's environment variables. It **appends** to any existing PROMPT_COMMAND to avoid overwriting user customizations:

```kotlin
// In ShellyShellEnvironment.kt, added to envVars:
"PROMPT_COMMAND" to "\${PROMPT_COMMAND:+\$PROMPT_COMMAND;}echo -ne '\\033]133;D;\$?\\007\\033]133;A\\007'"
```

This uses the **OSC 133 (FinalTerm) semantic prompt protocol**, which is the same standard used by VS Code's terminal, iTerm2, and Warp:
- `\033]133;D;$?\007` — marks command completion with exit code
- `\033]133;A\007` — marks prompt start

### tmux Passthrough Configuration

OSC sequences must pass through tmux to reach the terminal view. Shelly configures this automatically during session creation:

```kotlin
// In ShellyTerminalSession.kt, after tmux session creation:
sendCommand("tmux set -g allow-passthrough on")
```

This is set once per tmux server and persists across sessions.

### Why OSC 133

- **Not fragile**: unlike watching for `$ ` patterns, OSC sequences are control codes that never appear in normal output
- **Industry standard**: VS Code, iTerm2, Warp, WezTerm all use this
- **Works with tmux**: tmux passes through OSC sequences (with `allow-passthrough on`, configured automatically by Shelly)
- **User PS1 compatible**: appends to PROMPT_COMMAND, not replacing it

### BlockDetector.kt Implementation

```kotlin
class BlockDetector(private val onBlockCompleted: (command: String, output: String, exitCode: Int) -> Unit) {
    private var currentCommand: String? = null
    private var currentOutput = StringBuilder()
    private var inCommand = false

    fun processOutput(data: String) {
        // Scan for OSC 133 sequences
        // A = prompt start → if previous block exists, emit it
        // B = command start (user pressed Enter) → capture command
        // C = command output start
        // D;N = command finished with exit code N
    }
}
```

### Fallback for Non-bash Shells

If a user runs `python`, `node`, or `mysql` inside the terminal, OSC 133 won't fire. BlockDetector falls back to:
- Timeout-based grouping: if no output for 2 seconds after a burst, close the block
- No exit code in fallback mode (shown as neutral, no color coding)

---

## Connection Status Model

### New Status States

Replace `connectionMode: 'termux' | 'disconnected'` and `ConnectionStatus`:

```typescript
type SessionStatus = 'starting' | 'alive' | 'exited' | 'recovering';

// In TabSession:
sessionStatus: SessionStatus;  // replaces connectionStatus

// StatusBadge mapping:
// 'starting'   → yellow dot, "Starting..."
// 'alive'      → green dot, "Connected"
// 'exited'     → gray dot, "Session ended"
// 'recovering' → orange dot, "Recovering..."
```

### useTermuxBridge Hook

The `useTermuxBridge` hook **survives** but its role narrows:
- **Still used for**: bridge WebSocket connection to Termux (needed for `runRawCommand` — tmux management, wakelock commands, system queries)
- **No longer used for**: terminal display, output capture, ttyd management
- The chat tab's "Run in Terminal" feature sends commands via `TerminalEmulatorModule.writeToSession()` instead of the bridge

---

## Resize Handling

The `NativeTerminalView` handles resize internally:

```kotlin
override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val cols = w / characterWidth
    val rows = h / characterHeight
    session?.let {
        terminalEmulatorModule.resizeSession(it.sessionId, rows, cols)
    }
}
```

This automatically handles:
- Z Fold6 fold/unfold
- Split-screen / multi-window mode
- Keyboard show/hide
- Split view resize (drag handle)

React Native's `onLayout` is NOT involved — the native view owns its own measurement.

---

## Scroll Handling

The `NativeTerminalView` owns all scroll gestures:

```kotlin
// In ShellyTerminalView.kt
override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    // Consume all vertical scroll events — do not propagate to React Native ScrollView
    return true
}
```

**Exposed to TypeScript:**
```typescript
// Added to TerminalViewModule.ts
scrollToBottom(viewId: string): void
scrollToTop(viewId: string): void
```

---

## Smart Wakelock: Event-Driven Design

Replace 30s polling with event-driven wakelock:

```typescript
// lib/smart-wakelock.ts (rewritten)

// Listens to TerminalEmulatorModule events:
// - "onSessionOutput" with CLI-related content → acquire wakelock
// - "onSessionExit" → check if any CLI still running → release if none

// CLI detection: activeCli field in terminal-store
// On activeCli change from null → "claude": acquire
// On activeCli change from "claude" → null: release (after 5min grace period)
// No polling. No pgrep. Pure state-driven.
```

---

## License Compliance

Each vendor directory includes:
```
modules/terminal-emulator/android/src/main/java/com/termux/terminal/
  ├── LICENSE                    ← Apache 2.0 full text
  ├── NOTICE                     ← Copyright notice
  └── VENDORED.md                ← Source commit, date, version

modules/terminal-view/android/src/main/java/com/termux/view/
  ├── LICENSE
  ├── NOTICE
  └── VENDORED.md

modules/terminal-view/android/src/main/assets/fonts/
  ├── JetBrainsMono-LICENSE.txt  ← SIL OFL
  ├── FiraCode-LICENSE.txt       ← SIL OFL
  └── PixelMplus-LICENSE.txt     ← M+ License
```

---

## TypeScript API

### terminal-emulator Module

```typescript
// modules/terminal-emulator/src/TerminalEmulatorModule.ts

import { NativeModule, requireNativeModule } from 'expo-modules-core';

export interface SessionConfig {
  sessionId: string;
  shell: string;               // e.g., "/data/data/com.termux/files/usr/bin/bash"
  cwd: string;
  env: Record<string, string>;
  rows: number;
  cols: number;
  useTmux: boolean;
  tmuxSessionName?: string;    // e.g., "shelly-1"
}

export interface TerminalEmulatorModule extends NativeModule {
  // Session lifecycle
  // Caller provides sessionId in config. Returns the same sessionId on success.
  // Throws if session creation fails (e.g., shell not found, PTY open failed).
  createSession(config: SessionConfig): Promise<string>;
  destroySession(sessionId: string): Promise<void>;
  resizeSession(sessionId: string, rows: number, cols: number): Promise<void>;

  // I/O
  writeToSession(sessionId: string, data: string): Promise<void>;
  sendKeyEvent(sessionId: string, keyCode: number, modifiers: number): Promise<void>;

  // State queries
  isSessionAlive(sessionId: string): Promise<boolean>;
  getSessionTitle(sessionId: string): Promise<string>;
  getTranscriptText(sessionId: string, maxLines: number): Promise<string>;

  // Events (Kotlin → RN)
  // Emitted via Expo EventEmitter:
  //   "onSessionOutput"  → { sessionId: string, data: string }
  //   "onSessionExit"    → { sessionId: string, exitCode: number }
  //   "onTitleChanged"   → { sessionId: string, title: string }
  //   "onBell"           → { sessionId: string }
}

export default requireNativeModule<TerminalEmulatorModule>('TerminalEmulator');
```

### terminal-view Module

```typescript
// modules/terminal-view/src/NativeTerminalView.tsx

import { requireNativeViewManager } from 'expo-modules-core';
import { ViewProps } from 'react-native';

export type FontFamily = 'jetbrains-mono' | 'fira-code' | 'pixel-mplus';

export interface TerminalColorScheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  // ANSI 0-15 (required)
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  // ANSI 16-255 (optional — Termux defaults used if omitted)
  extendedColors?: string[];  // length 240 (indices 16-255)
}

export interface NativeTerminalViewProps extends ViewProps {
  sessionId: string;
  fontFamily: FontFamily;
  fontSize: number;
  theme: TerminalColorScheme;
  showBlocks: boolean;
  cursorShape: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  ligatures: boolean;

  // Callbacks (Kotlin → RN)
  onOutput?: (event: { nativeEvent: { text: string; isError: boolean } }) => void;
  onBlockCompleted?: (event: { nativeEvent: { command: string; output: string; exitCode: number } }) => void;
  onSelectionChanged?: (event: { nativeEvent: { text: string } }) => void;
  onUrlDetected?: (event: { nativeEvent: { url: string; type: 'url' | 'filepath' } }) => void;
  onBell?: () => void;
  onTitleChanged?: (event: { nativeEvent: { title: string } }) => void;
}

// View commands (imperative methods via ref)
export interface NativeTerminalViewRef {
  scrollToBottom(): void;
  scrollToTop(): void;
  selectAll(): void;
  clearSelection(): void;
  getSelectedText(): Promise<string>;
  copyToClipboard(): Promise<void>;
  focus(): void;
}

export const NativeTerminalView = requireNativeViewManager<NativeTerminalViewProps>('NativeTerminalView');
```

---

## Kotlin Implementation Details

### ShellyShellEnvironment.kt

Abstracts Termux environment paths. Future migration to self-contained bootstrap (approach C) only requires a new implementation of this interface.

```kotlin
interface ShellEnvironment {
    val shellPath: String          // Path to bash/zsh
    val homePath: String           // HOME directory
    val envVars: Map<String, String>  // PATH, LD_LIBRARY_PATH, etc.
    fun isAvailable(): Boolean     // Check if environment is usable
    fun tmuxPath(): String         // Path to tmux binary
}

class TermuxShellEnvironment : ShellEnvironment {
    override val shellPath = "/data/data/com.termux/files/usr/bin/bash"
    override val homePath = "/data/data/com.termux/files/home"
    override val envVars = mapOf(
        "PATH" to "/data/data/com.termux/files/usr/bin",
        "HOME" to homePath,
        "TERM" to "xterm-256color",
        "LANG" to "en_US.UTF-8",
        "LD_LIBRARY_PATH" to "/data/data/com.termux/files/usr/lib",
        "PREFIX" to "/data/data/com.termux/files/usr",
    )
    override fun isAvailable(): Boolean = File(shellPath).exists()
    override fun tmuxPath(): String = "/data/data/com.termux/files/usr/bin/tmux"
}
```

### ShellyTerminalSession.kt

Wraps Termux's TerminalSession with Shelly-specific behavior:

- **tmux integration**: on create, ensures tmux session exists, then spawns `tmux attach-session -t <name>` instead of raw bash
- **Output forwarding**: implements TerminalSessionClient, forwards `onTextChanged` events to Expo EventEmitter as `onSessionOutput`
- **CLI detection**: monitors input/output for `claude`, `gemini`, `codex` patterns to set `activeCli` state
- **Idle detection**: tracks last output timestamp for battery optimization

### ShellyTerminalView.kt

Expo Native View wrapping Termux's TerminalView:

- **Font injection**: loads bundled fonts (JetBrains Mono, Fira Code, PixelMplus) via FontManager and sets on TerminalRenderer
- **Theme mapping**: converts Shelly ThemeColors to TerminalColorScheme (16 ANSI + bg/fg/cursor)
- **Block detection**: BlockDetector monitors OSC 133 (FinalTerm) semantic prompt sequences to segment output into command blocks, emitting `onBlockCompleted` events. Falls back to timeout-based grouping for non-bash shells (python, node REPL, etc.)
- **Link detection**: LinkDetector scans rendered text for URLs and file paths, creating tappable regions
- **Selection menu**: on text selection, shows floating menu with "Copy", "Ask AI", "Open in Browser" actions
- **Battery optimization**: when view is not visible (tab switched, app backgrounded), stops Canvas invalidation while PTY continues reading into buffer

### BlockDetector.kt

Implements Warp-style command block grouping using **OSC 133 (FinalTerm) semantic prompt protocol** (see "BlockDetector: Prompt Detection Strategy" section above for full rationale).

```
OSC 133;A (prompt start) → previous block ends, new block begins
  ↓
User types command
  ↓
OSC 133;B (command start) → capture command text
  ↓
OSC 133;C (output start) → output accumulates in block
  ↓
OSC 133;D;N (command done, exit code N) → block finalized
  ↓
Emit onBlockCompleted { command, output, exitCode }
```

Color coding: exit 0 = neutral, exit != 0 = red sidebar (Warp-style).
Fallback for non-bash shells: timeout-based grouping (2s idle → close block, no exit code).

### LinkDetector.kt

Scans terminal buffer for clickable content:
- **URLs**: `https?://...`, `git@...` patterns
- **File paths**: `/path/to/file`, `./relative/path` (verified against filesystem)
- **Error references**: `file.ts:42:10` format (opens in editor context)
- Tap action: URL → system browser; file path → inject `cat` or open in chat; error ref → "Ask AI to fix"

### FontManager.kt

Manages bundled terminal fonts:

```kotlin
object FontManager {
    private val fontCache = mutableMapOf<String, Typeface>()

    fun getTypeface(context: Context, family: String, style: Int): Typeface {
        val key = "$family-$style"
        return fontCache.getOrPut(key) {
            val assetPath = when (family) {
                "jetbrains-mono" -> when (style) {
                    Typeface.BOLD -> "fonts/JetBrainsMono-Bold.ttf"
                    Typeface.ITALIC -> "fonts/JetBrainsMono-Italic.ttf"
                    else -> "fonts/JetBrainsMono-Regular.ttf"
                }
                "fira-code" -> when (style) {
                    Typeface.BOLD -> "fonts/FiraCode-Bold.ttf"
                    else -> "fonts/FiraCode-Regular.ttf"
                }
                "pixel-mplus" -> "fonts/PixelMplus12-Regular.ttf"
                else -> "fonts/JetBrainsMono-Regular.ttf"
            }
            Typeface.createFromAsset(context.assets, assetPath)
        }
    }
}
```

---

## Battery Optimization Strategy

### Principle: "Only spend power on what the user sees"

| State | Rendering | PTY Read | tmux | Wakelock |
|-------|-----------|----------|------|----------|
| Active session visible | Full Canvas draw | Active | Running | None needed |
| Background session (tab hidden) | Stopped | Active (buffered) | Running | None |
| App backgrounded, CLI running | Stopped | Active (buffered) | Running | Acquired |
| App backgrounded, idle | Stopped | Suspended | Running | None |
| Screen off, CLI running | Stopped | Active (buffered) | Running | Acquired |
| Screen off, idle | Stopped | Suspended | Running | None |

### Implementation

1. **Visibility-driven rendering**: `ShellyTerminalView` observes `View.onVisibilityChanged()`. When not visible, skip `invalidate()` calls. When visible again, single `invalidate()` redraws from current TerminalBuffer state.

2. **Smart wakelock**: only acquire when a CLI process (claude, gemini, codex) is actively running. Release when CLI exits or after 5 minutes of no output.

3. **No polling**: current architecture polls every 15s (phantom guard) + 30s (wakelock check) + 500ms (JS output capture). All replaced:
   - Phantom guard: simplified to 60s tmux-only check (tmux process is harder to kill than ttyd)
   - Wakelock: event-driven, not polled (triggered by CLI start/stop detection)
   - Output capture: PTY read is inherently event-driven (blocking read on fd)

4. **PTY read suspension**: when app is backgrounded AND no CLI is running, stop reading from PTY fd. tmux buffers output. On resume, read buffered output in one batch.

5. **Estimated savings**: ~40-60% reduction in CPU usage during idle/background compared to WebView+ttyd (no WebView render process, no ttyd WebSocket, no JS polling).

---

## Session Management Changes

### terminal-store.ts Updates

```typescript
// REMOVE these fields from TabSession:
//   port: number
//   ttyUrl: string

// KEEP (rename where needed):
interface TabSession {
  id: string;                      // Session identifier
  name: string;                    // "Terminal 1" etc.
  currentDir: string;              // Working directory
  blocks: CommandBlock[];          // Command history (max 50)
  entries: TerminalEntry[];        // Mixed blocks
  commandHistory: string[];        // Last 100 commands
  historyIndex: number;
  activeCli: 'claude' | 'gemini' | 'codex' | 'cody' | null;
  tmuxSession: string;             // "shelly-1" through "shelly-4"

  // NEW fields:
  nativeSessionId: string;         // Maps to Kotlin ShellyTerminalSession
  isAlive: boolean;                // PTY process alive
}

// Session limits
const MAX_SESSIONS = 4;  // was 2

// Port allocation removed — sessions identified by tmux name only
```

### Migration

Runs in `terminal-store.ts`'s `loadSessionState()` method (called on app launch). Detection: if any session has a `ttyUrl` field, it's old format.

1. Strip `port`, `ttyUrl`, and `connectionStatus` fields
2. Set `nativeSessionId` = `tmuxSession` (reuse tmux name)
3. Set `isAlive` = false (will be checked on next launch)
4. Set `sessionStatus` = `'starting'`
5. Preserve `blocks`, `entries`, `commandHistory`, `activeCli`
6. Store-level: remove `connectionMode` field, replace with per-session `sessionStatus`

**Rollback**: not needed. Migration is additive (removes fields, adds defaults). Old data is preserved. If the native module fails to create a session, the UI shows "Session ended" and user can create a new one.

---

## terminal.tsx Rewrite

### What Changes

| Section | Current | New |
|---------|---------|-----|
| Terminal display | `<WebView source={{uri: ttyUrl}} />` | `<NativeTerminalView sessionId={...} />` |
| Output capture | `CAPTURE_INJECT_JS` + postMessage polling | `onOutput` prop callback |
| Font injection | `FONT_INJECT_JS` + CDN addon | `fontFamily` prop |
| Theme | CSS injection | `theme` prop |
| Resize overlay | CSS hide hack | Not applicable (no overlay) |
| Connection status | `useTtydConnection` hook | `isSessionAlive` query |
| Recovery | `recoverSession` (ttyd relaunch) | `recoverSession` (tmux reattach only) |

### What Stays

- `TerminalHeader` — tab UI (unchanged)
- `StatusBadge` — connection indicator (simplified)
- `CommandKeyBar` — Ctrl+C, Tab, arrows, Paste (sends KeyEvent to native)
- `TerminalActionBar` — file attach, voice (unchanged)
- Japanese input proxy — sends text via `writeToSession`
- Scroll-to-bottom FAB (calls native `scrollToBottom`)
- Theme integration via `useTheme()`
- Layout responsiveness (compact/standard/wide breakpoints)
- Auto-save sessions to project directory

### New Additions

- **Block rendering overlay**: visual grouping of command+output with colored sidebar
- **Font selector**: settings UI for JetBrains Mono / Fira Code / PixelMplus
- **Hyperlink tap handling**: URL → browser, filepath → chat context, error → AI fix

---

## Cross-Pane Intelligence Integration

### Current Flow (WebView)

```
xterm.js buffer
  ↓ CAPTURE_INJECT_JS (500ms poll)
  ↓ ReactNativeWebView.postMessage()
  ↓ handleWebViewMessage()
  ↓ stripAnsi()
addTerminalOutput(text, sessionId)
  ↓
execution-log-store (hotBuffer + sessionBuffer)
  ↓
Chat reads via getRecentOutput()
```

### New Flow (Native)

```
PTY read → TerminalEmulator → TerminalBuffer
  ↓
TerminalSessionClient.onTextChanged()
  ↓
ShellyTerminalSession → Expo EventEmitter("onSessionOutput")
  ↓
useTerminalOutput hook (subscribes to EventEmitter, always running)
  ↓
addTerminalOutput(text, sessionId)  ← SAME STORE, SAME API
  ↓
execution-log-store (hotBuffer + sessionBuffer)
  ↓
Chat reads via getRecentOutput()  ← UNCHANGED
```

Note: `NativeTerminalView.onOutput` prop is a separate convenience callback for view-specific UI reactions (e.g., auto-scroll). It is NOT the path to execution-log-store. See "Output Event Architecture" section for the canonical path.

**Key point**: everything below `addTerminalOutput()` is unchanged. The cross-pane intelligence stack (error detection, debug suggestions, translation, summarization, "Ask AI" action) works identically because it reads from `execution-log-store`, which receives data through the same `addTerminalOutput()` API.

The only difference: data arrives in realtime instead of 500ms-delayed polls, and ANSI stripping is more accurate because TerminalEmulator has already parsed the escape sequences.

---

## Existing Feature Compatibility Matrix

| Feature | Impact | Notes |
|---------|--------|-------|
| Cross-pane output capture | Improved | Realtime, no polling |
| Error detection → debug suggestions | Improved | No output loss |
| Terminal translation/summarization | Improved | Cleaner text (no ANSI artifacts) |
| "Ask AI" action button | Unchanged | Reads from same store |
| Japanese input proxy | Unchanged | writeToSession instead of WebView inject |
| Command key bar (Ctrl+C, Tab, arrows) | Unchanged | sendKeyEvent to PTY |
| Voice input | Unchanged | Text sent via writeToSession |
| File attachment | Unchanged | Path logic unchanged |
| Savepoints / undo | Unchanged | Git-based, no terminal dependency |
| Theme switching (30+ themes) | Unchanged | Colors mapped to TerminalColorScheme |
| Split view layout | Unchanged | NativeTerminalView replaces WebView in same slot |
| CommandBlock rendering | Improved | Native BlockDetector, Warp-style grouping |
| Session persistence (AsyncStorage) | Migrated | Auto-migration strips ttyd fields |
| CLI auto-resume (claude --continue) | Unchanged | tmux + sendKeysToSession unchanged |
| Foreground Service | Unchanged | ShellyForegroundService stays |
| Smart wakelock | Improved | Event-driven instead of 30s polling |
| Setup wizard | Simplified | No ttyd installation step |

---

## UX Enhancements (from Ghostty, Warp, VS Code, Zed, iTerm2)

### From Warp: Block-Based Output

Each command + its output is a discrete, visual block:
- Prompt line highlighted as block header
- Output indented or boxed below
- Exit code indicator: success = subtle green dot, failure = red sidebar + exit code
- Collapsible: tap block header to fold/unfold output
- Blocks map directly to existing `CommandBlock` in terminal-store

### From Ghostty: Zero-Config Defaults

- Ship with optimized defaults: JetBrains Mono, ligatures on, theme matched to system dark/light
- New tab opens in same directory as current session
- No configuration file needed to start being productive

### From VS Code: Error Quick Actions

- When a command fails (exit code != 0), show inline action row:
  - "Ask AI to fix" → sends error + command to chat
  - "Retry" → re-runs command
  - "Copy error" → clipboard
- Powered by existing `llmSuggestedCommand` field in CommandBlock

### From Zed: Minimal UI, Maximum Content

- No unnecessary chrome. Terminal area maximized.
- Status information (session name, connection state) compressed into thin header bar
- Keyboard shortcuts shown only when hardware keyboard detected

### From iTerm2: Smart Selection

- Double-tap: select word (with smart boundaries for paths, URLs, quoted strings)
- Triple-tap: select entire line
- Long press: free selection mode with drag handles
- Selection menu: Copy | Ask AI | Open URL | Search

---

## Files to Delete

| File | Reason |
|------|--------|
| `lib/ttyd-manager.ts` | ttyd no longer used |
| `hooks/use-ttyd-connection.ts` | WebView connection no longer needed |
| `lib/phantom-process-guard.ts` | Replace with simplified tmux-only monitor |

## Files to Modify

| File | Changes |
|------|---------|
| `app/(tabs)/terminal.tsx` | Replace WebView with NativeTerminalView; remove all JS injection; simplify recovery |
| `store/terminal-store.ts` | Remove `port`/`ttyUrl`; add `nativeSessionId`; raise MAX_SESSIONS to 4 |
| `lib/tmux-manager.ts` | Unchanged (keep as-is) |
| `lib/smart-wakelock.ts` | Event-driven instead of polling; CLI activity triggers |
| `~/shelly-bridge/start-shelly.sh` | Remove ttyd launch; tmux + bridge only. Bridge WebSocket server stays — still used by chat tab for runRawCommand (tmux management, system queries, wakelock) |
| `app.config.ts` | Add terminal-emulator and terminal-view plugins |

## Files to Create

| File | Purpose |
|------|---------|
| `modules/terminal-emulator/` | Expo Native Module: PTY + TerminalEmulator |
| `modules/terminal-view/` | Expo Native Module: NativeTerminalView |
| `lib/terminal-session-monitor.ts` | Simplified tmux-only session health check (replaces phantom-process-guard) |
| `lib/theme-to-terminal-colors.ts` | Convert Shelly Theme to TerminalColorScheme |

---

## Testing Strategy

### Unit Tests (Kotlin)
- ShellyShellEnvironment: path resolution, env var construction
- BlockDetector: prompt pattern recognition, exit code parsing
- LinkDetector: URL/filepath/error-ref detection
- FontManager: font loading, cache behavior
- Theme mapping: Shelly colors → ANSI 16 conversion

### Integration Tests
- Session lifecycle: create → write → read output → resize → destroy
- tmux attach/detach: session survives view destruction
- CLI detection: `claude` command sets activeCli
- Cross-pane: terminal output appears in execution-log-store

### Manual Tests
- CJK text rendering (no garbled characters)
- Z Fold6 fold/unfold (resize handling)
- Background → foreground recovery (tmux buffer preserved)
- Split view: chat reads terminal output
- 4 concurrent sessions
- Battery usage comparison vs old WebView version
- All 30+ themes render correctly
- Font switching (JetBrains Mono ↔ Fira Code ↔ PixelMplus)

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Termux vendor code has undocumented Android version requirements | Low | minSdkVersion 24 matches; test on Android 7+ |
| NDK build fails in EAS Build | Medium | Test NDK config early; fallback to prebuilt .so |
| IME (Japanese input) conflicts with native view | Medium | Dedicated ShellyInputHandler; test with Nacre, Gboard, Typeless |
| Font rendering differences across devices | Low | Use bundled fonts only; no system font dependency |
| Session migration loses user data | Low | Migration is additive (strip fields); old data preserved |
| Expo Modules API limitations for complex native views | Medium | TerminalView is a standard Android View; Expo supports this |
