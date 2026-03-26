# Shelly Terminal Overhaul — Design Spec

**Date:** 2026-03-26
**Status:** Active
**Author:** Claude Code + りょう

---

## Goal

Transform Shelly's terminal from a single-ttyd wrapper into a multi-session, project-aware, voice-enabled terminal that surpasses Termux in usability — making it the best terminal app on Android for both AI-assisted and manual development workflows.

## Strategic Context

- **Primary:** Enable parallel AI agent workflows (Claude Code + Gemini CLI + Codex in separate sessions)
- **Secondary:** Attract Termux users by solving top-voted pain points (copy/paste, background killing, wakelock, session persistence)
- **Tertiary:** Build foundation for future features (auto-summary titles, terminal multi-view, ADB quick connect)

---

## Architecture Overview

```
┌─ Shelly App ──────────────────────────────────────────────┐
│                                                            │
│  ┌─ Chat Pane ────────┐  ┌─ Terminal Pane ──────────────┐ │
│  │                     │  │ ┌─ TerminalHeader ─────────┐ │ │
│  │  AI Chat            │  │ │ [1][2][3][4][5][6] [+]   │ │ │
│  │  (reads active      │  │ └──────────────────────────┘ │ │
│  │   session output)   │  │ ┌─ WebView (active ttyd) ──┐ │ │
│  │                     │  │ │ ttyd @ port 7681-7686     │ │ │
│  │  sends commands ──────>│ │ (independent bash each)   │ │ │
│  │  to active session  │  │ └──────────────────────────┘ │ │
│  │                     │  │ ┌─ CommandKeyBar ──────────┐ │ │
│  │                     │  │ │ [Ctrl+C] [Tab] [↑] [↓]   │ │ │
│  │                     │  │ └──────────────────────────┘ │ │
│  │                     │  │ ┌─ ActionBar ──────────────┐ │ │
│  │                     │  │ │ [📎 Attach] [🎤 Voice]   │ │ │
│  └─────────────────────┘  │ └──────────────────────────┘ │ │
│                            └──────────────────────────────┘ │
│                                                            │
│  ┌─ .shelly/ (per-project persistence) ──────────────────┐ │
│  │  sessions/terminal-{1-6}.json  — cwd, history, output │ │
│  │  context.md                    — project context       │ │
│  │  chat/session.json             — chat history          │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Background Services ─────────────────────────────────┐ │
│  │  SmartWakelock: auto-acquire on activity, release idle │ │
│  │  PhantomKiller: detect signal 9, guide recovery        │ │
│  └───────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Multi-Session Infrastructure

### 1.1 Independent ttyd Instances

Each session runs its own ttyd process on a dedicated port:

| Session | Port | ttyd Command |
|---------|------|-------------|
| 1 | 7681 | `ttyd -p 7681 -W bash` |
| 2 | 7682 | `ttyd -p 7682 -W bash` |
| 3 | 7683 | `ttyd -p 7683 -W bash` |
| 4 | 7684 | `ttyd -p 7684 -W bash` |
| 5 | 7685 | `ttyd -p 7685 -W bash` |
| 6 | 7686 | `ttyd -p 7686 -W bash` |

**Lifecycle:**
- ttyd launched lazily on first tab switch (not all at startup)
- ttyd killed when session is removed (`pkill -f "ttyd -p PORT"`)
- Connection check per-session via HEAD to `http://localhost:PORT`

**Changes:**
- `use-ttyd-connection.ts` → accept port parameter, per-session instance
- `terminal-store.ts` → `TabSession.port: number` field, max 6
- Module-level `_ttydLaunchAttempted` → per-session map

### 1.2 Session Store Updates

```typescript
// TabSession additions
type TabSession = {
  // ... existing fields
  port: number;        // ttyd port (7681-7686)
  ttyUrl: string;      // "http://localhost:{port}"
  pid?: number;        // ttyd process PID for cleanup
};
```

- Max sessions: 3 → 6
- `addSession()`: allocate next available port from pool
- `removeSession()`: kill ttyd process, free port
- Port allocation: scan 7681-7686 for first unused

### 1.3 Tab UI Integration

- Replace `terminal.tsx`'s custom status bar with `TerminalHeader`
- `TerminalHeader` session limit: 3 → 6
- Tab shows session number (1-6)
- Active tab switches WebView `source.uri` to that session's ttyUrl
- Long-press to delete (with confirmation if session has running process)

### 1.4 WebView Session Switching

When active session changes:
1. Current WebView keeps running (don't destroy)
2. Switch WebView `source.uri` to new session's ttyUrl
3. Re-inject `CAPTURE_INJECT_JS` after load
4. Status bar reflects new session's connection status

**Option A (single WebView, switch URI):** Simple but loses scroll position
**Option B (WebView pool):** Keep up to 2-3 WebViews alive, swap visibility

**Decision: Option A** for initial implementation. Scroll position loss is acceptable because terminal output is captured in the buffer anyway. Option B can be added later if needed.

---

## Phase 2: Chat ↔ Active Session Linkage

### 2.1 Session-Aware Output Capture

`execution-log-store.ts` changes:
- `TerminalOutputLine` gets `sessionId: string` field
- `addTerminalOutput(text, sessionId)` — tag each line
- `getRecentOutput(lines, contextLines, sessionId?)` — filter by session
- Default (no sessionId): returns active session's output

### 2.2 Chat Context Injection

`use-ai-dispatch.ts` changes:
- `getTerminalContextForPrompt()` passes `activeSessionId`
- Output header: `--- Terminal Output (Session 3, last 50 lines) ---`
- AI knows which session the output is from

### 2.3 Command Sending to Active Session

`terminal.tsx` `sendToTerminal()` is already WebView-based.
- Chat side calls `sendToTerminal()` via store action or ref
- Target is always the currently displayed WebView (= active session)
- No session picker needed (as discussed with user)

---

## Phase 3: Project Persistence & Recovery

### 3.1 `.shelly/sessions/` Structure

Per-project directory (created in project's working directory):

```
.shelly/
  context.md                    # existing
  sessions/
    terminal-1.json             # session state
    terminal-2.json
    ...
  chat/
    session.json                # chat history (future)
```

### 3.2 Session State File Format

```json
{
  "id": "session-1",
  "name": "Terminal 1",
  "port": 7681,
  "cwd": "/home/user/project",
  "commandHistory": ["npm install", "npm run dev"],
  "outputBuffer": ["last 200 lines of output"],
  "createdAt": "2026-03-26T10:00:00Z",
  "lastActiveAt": "2026-03-26T11:30:00Z"
}
```

### 3.3 Save Triggers

- **Auto-save:** Every 30 seconds while session is active
- **On session switch:** Save outgoing session state
- **On app background:** Save all sessions
- **On app termination:** Best-effort save via AppState listener

### 3.4 Restore Flow

On project open (or app restart):
1. Check `.shelly/sessions/` for saved state
2. Recreate sessions with saved ports/cwd
3. Launch ttyd instances
4. Restore output buffer to WebView
5. Restore command history to store
6. cd to saved cwd in each session

---

## Phase 4: Terminal UX Improvements

### 4.1 Command Key Bar

Thin bar (32dp height) between WebView and keyboard:

```
┌──────────────────────────────────────────┐
│  [Ctrl+C]   [Tab]    [↑]    [↓]         │
└──────────────────────────────────────────┘
```

- Sends key codes to xterm.js via `injectJavaScript()`
- Ctrl+C: `\x03`
- Tab: `\t`
- ↑: `\x1b[A`
- ↓: `\x1b[B`
- Responsive: compact labels on narrow panes
- Haptic feedback on press

### 4.2 Copy/Paste Improvement

**Problem:** Termux requires Ctrl+Alt+C/V (15+ upvotes, 35 comments)

**Solution:**
- Paste button in command key bar: reads system clipboard → `sendToTerminal()`
- Copy: long-press on WebView selects text (already works with WebView)
- Add visible "Paste" icon to command key bar

Updated bar:
```
[Ctrl+C] [Tab] [↑] [↓] [📋 Paste]
```

### 4.3 File Attachment

Attach button opens picker:
1. **Image** — expo-image-picker → copy to session cwd
2. **File** — expo-document-picker → copy to session cwd

After copy, show toast: "photo.jpg copied to /current/dir/"

### 4.4 Voice Input & Dialog Mode

**Voice Input (simple):**
- Mic button next to attach button
- Uses `use-speech-input.ts` → transcribed text → `sendToTerminal(text)`

**Voice Dialog Mode:**
- Reuse `use-voice-chat.ts` with modified I/O:
  - Input: STT → sendToTerminal() (instead of chat store)
  - Output: CAPTURE_INJECT_JS output → TTS (instead of AI response)
  - Dialog loop: listen → transcribe → send to terminal → capture output → speak → listen
- Trigger: long-press mic button opens dialog mode overlay

### 4.5 Font & Spacing Optimization

**Chat side:**
- Bubble padding: 12+10 horizontal → 10 total
- lineHeight: 21dp → 18dp (ratio 1.3 instead of 1.5)
- borderRadius: 18dp → 14dp
- maxWidth: 85% → 90%

**Terminal side:**
- Compact screen textZoom: 140% → 120%
- Compact fontSize: 20px → 16px
- Status bar fontSize: 15dp → 13dp

---

## Phase 5: Background Stability

### 5.1 Smart Wakelock

**Module:** `lib/smart-wakelock.ts`

Logic:
1. Monitor ttyd process activity (stdout in last 30s → active)
2. If any session is active → acquire wakelock via TermuxBridge: `termux-wake-lock`
3. If all sessions idle for 5 minutes → release: `termux-wake-unlock`
4. On app background with active processes → keep wakelock
5. Show notification: "Shelly: 2 sessions active, wakelock held"

### 5.2 Phantom Process Killer Detection

**Problem:** Android 12+ kills processes exceeding 32-process limit

**Detection:**
- Monitor ttyd process health via periodic `kill -0 PID` check
- If process dies unexpectedly (not user-initiated): show recovery banner

**Recovery UI (BridgeRecoveryBanner extension):**
```
⚠️ Terminal session 3 was killed by Android
[Restart Session] [Disable Process Limit] [Learn More]
```

- "Disable Process Limit" → guide to Developer Options toggle (Android 14+)
- "Learn More" → in-app explanation of phantom process killer
- Auto-restart option in settings

---

## Future Extensions (Not in Scope)

- **Auto-summary session titles** — LLM summarizes session activity for tab label
- **Terminal multi-view** — split terminal pane into sub-panes (requires session picker)
- **ADB quick connect** — wizard for wireless debugging setup
- **UI self-check** — screencap → multimodal AI → bug detection
- **HW keyboard detection** — auto-hide command key bar
- **Premium fonts** — JetBrains Mono + Nerd Fonts + CJK fallback
- **Project ↔ session binding** — associate sessions with specific projects

---

## Dependencies & Risk

| Risk | Impact | Mitigation |
|------|--------|-----------|
| 6 ttyd processes = ~90MB memory | Medium | Lazy launch, kill idle sessions |
| Port conflicts (7681-7686) | Low | Check port availability before launch |
| WebView URI switch loses scroll | Low | Output captured in buffer, restorable |
| Phantom Process Killer kills ttyd | High | Detection + recovery + user guidance |
| expo-speech TTS quality varies | Low | Fallback to Android system TTS |
| Termux permission for wakelock | Low | Already handled via TermuxBridge |
