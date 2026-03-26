# Terminal Stability + Cross-Pane Intelligence + UX Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal sessions stay alive across app switches (like Termux does). Chat can read any terminal's output for translation/error-fix/summary. Pure black background, syntax highlighting, Alt key button.

**Architecture:**
- Terminal stability: ttyd/tmux processes are already protected by `termux-wake-lock` — they don't die on app switch. The real problem is WebView: Android kills its render process under memory pressure. The fix is making WebView recovery seamless — when `onRenderProcessGone` fires, show a brief splash with previous output snapshot while WebView reloads and re-attaches to the still-alive tmux session. No reconnection needed, just re-rendering.
- Cap ttyd at 2 max to reduce phantom process killer risk.
- Cross-pane intelligence: Chat reads `execution-log-store` sessionBuffer (already captured per-session). User references terminal via `@terminal-1` or natural language. Output injected into chat system prompt.
- UX: Background `#000000`, Alt key in CommandKeyBar, 256-color ANSI theme.

**Tech Stack:** React Native, Zustand, ttyd, tmux, WebView, xterm.js 5.3.0

---

## Phase 1: Seamless WebView Recovery + ttyd Cap

### Task 1: Cap ttyd at 2 sessions

**Files:**
- Modify: `lib/ttyd-manager.ts`
- Modify: `store/terminal-store.ts`
- Modify: `hooks/use-multi-pane.ts`
- Modify: `~/shelly-bridge/start-shelly.sh`

- [ ] **Step 1: Update MAX_SESSIONS in ttyd-manager.ts**

Change the existing constant and update `killAllTtyd` to match:

```typescript
// lib/ttyd-manager.ts — change existing constant
const MAX_SESSIONS = 2; // was 6 — Android phantom process killer limit
```

Verify that `killAllTtyd()` uses this constant (it already does via loop `i <= MAX_SESSIONS`).

- [ ] **Step 2: Update terminal-store port pool**

In `store/terminal-store.ts`, update the existing constants:

```typescript
const MAX_SESSIONS = 2; // was 6
```

- [ ] **Step 3: Limit terminal panes in use-multi-pane.ts**

In `hooks/use-multi-pane.ts`, add terminal leaf counter to `splitPane`:

```typescript
// Add helper function
function countTerminalLeaves(node: PaneNode | null): number {
  if (!node) return 0;
  if (node.type === 'leaf') return node.tab === 'terminal' ? 1 : 0;
  return countTerminalLeaves(node.children[0]) + countTerminalLeaves(node.children[1]);
}

// In splitPane action, before creating new leaf:
if (newTab === 'terminal') {
  const terminalCount = countTerminalLeaves(get().root);
  if (terminalCount >= 2) return; // silently refuse
}
```

- [ ] **Step 4: Update start-shelly.sh to create only 2 tmux sessions**

```bash
# Change loop from "1 2 3 4 5 6" to "1 2"
for i in 1 2; do
  tmux has-session -t "shelly-$i" 2>/dev/null || \
  tmux new-session -d -s "shelly-$i"
done
```

- [ ] **Step 5: Update launchTtyd to use tmux (consistency with auto-launch)**

Currently `launchTtyd()` in `ttyd-manager.ts` launches `ttyd -p ${port} -W bash` without tmux. Update to match the tmux-based approach used in `use-ttyd-connection.ts`:

```typescript
export async function launchTtyd(port: number, runRawCommand: RunCommand): Promise<void> {
  const running = await isTtydRunning(port, runRawCommand);
  if (running) return;

  const n = port - 7681 + 1;
  const sessionName = `shelly-${n}`;
  await runRawCommand(
    `tmux has-session -t "${sessionName}" 2>/dev/null || tmux new-session -d -s "${sessionName}"; nohup ttyd -p ${port} -W tmux attach-session -t "${sessionName}" > /dev/null 2>&1 &`,
    { timeoutMs: 10000, reason: 'ttyd-launch' },
  );
  // Wait for ttyd to be ready
  await new Promise((r) => setTimeout(r, 1500));
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/ttyd-manager.ts store/terminal-store.ts hooks/use-multi-pane.ts ~/shelly-bridge/start-shelly.sh
git commit -m "feat: cap ttyd at 2 sessions, unify tmux-based launch"
```

### Task 2: Seamless WebView recovery (splash overlay during reload)

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

The key insight: ttyd+tmux stay alive during app switch (protected by `termux-wake-lock`). Only the WebView render process gets killed by Android. When `onRenderProcessGone` fires, the WebView just needs to reload — it will reconnect to the same ttyd URL and tmux re-attaches automatically.

The problem is the user sees a black/grey screen during reload. Fix: show a splash overlay with the last captured output.

- [ ] **Step 1: Add recovering state and splash overlay**

```typescript
// Add state
const [isRecovering, setIsRecovering] = useState(false);

// Update handleRenderProcessGone
const handleRenderProcessGone = useCallback(() => {
  console.warn('[Terminal] WebView render process gone — recovering');
  setIsRecovering(true);
  // WebView just needs to reload — ttyd/tmux are still alive
  setTimeout(() => {
    webViewRef.current?.reload();
    retry();
  }, 300);
}, [retry]);

// Update handleWebViewLoad to clear recovery state
const handleWebViewLoad = useCallback(() => {
  setWebViewFailed(false);
  setIsRecovering(false); // <-- ADD THIS
  onWebViewLoad();
  // ...existing injection code...
}, [onWebViewLoad, FONT_INJECT_JS]);
```

- [ ] **Step 2: Add recovery splash overlay in JSX**

Place this overlay OVER the WebView (after the WebView element):

```typescript
{/* Recovery splash — shown while WebView reloads after render process kill */}
{isRecovering && (
  <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center', zIndex: 10 }]}>
    <ActivityIndicator size="small" color="#00D4AA" />
    <Text style={{ color: '#4B5563', fontFamily: 'monospace', fontSize: 11, marginTop: 8 }}>
      Restoring session...
    </Text>
    {/* Show last few lines of captured output as preview */}
    <View style={{ marginTop: 16, paddingHorizontal: 16, maxHeight: 200 }}>
      <Text style={{ color: '#374151', fontFamily: 'monospace', fontSize: 9 }} numberOfLines={10}>
        {useExecutionLogStore.getState().sessionBuffer
          .filter(l => l.sessionId === activeSession?.id)
          .slice(-10)
          .map(l => l.text)
          .join('\n')}
      </Text>
    </View>
  </View>
)}
```

- [ ] **Step 3: Also show splash on AppState foreground return if WebView needs reload**

In the AppState listener (inside `use-ttyd-connection.ts`), the hook already triggers a retry loop when connection is lost. The terminal.tsx side should handle this by showing the recovery state:

```typescript
// In terminal.tsx, add AppState listener for recovery overlay
useEffect(() => {
  const sub = AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') {
      // Brief flash while WebView re-renders — show recovery if needed
      if (webViewRef.current && status === 'connected') {
        // WebView may need a moment to re-render after coming to foreground
        // Don't show recovery for normal returns — only if render process was killed
        // (onRenderProcessGone handles that case)
      }
    }
  });
  return () => sub.remove();
}, [status]);
```

- [ ] **Step 4: Commit**

```bash
git add app/(tabs)/terminal.tsx
git commit -m "feat: seamless WebView recovery with splash overlay on render process kill"
```

### Task 3: Ensure termux-wake-lock is always active

**Files:**
- Modify: `lib/smart-wakelock.ts`

Currently the wakelock has a 5-minute idle timeout that releases it. This means if the user switches to YouTube for 5+ minutes, the wakelock releases and Android CAN kill ttyd. Fix: keep wakelock held as long as any terminal session exists.

- [ ] **Step 1: Remove idle timeout — keep wakelock while app has sessions**

```typescript
// smart-wakelock.ts — simplify: always hold wakelock when started
const CHECK_INTERVAL = 30_000;

// Remove IDLE_TIMEOUT constant and _idleTimer logic entirely

async function checkAndManage(runRawCommand: RunCommand): Promise<void> {
  const active = await hasActiveProcesses(runRawCommand);
  if (active && !_wakelockHeld) {
    await acquireWakelock(runRawCommand);
  }
  // Don't release on idle — user expects processes to survive app switches
  // Wakelock is only released when stopSmartWakelock() is called (app exit)
}
```

- [ ] **Step 2: Remove _idleTimer cleanup from stopSmartWakelock**

```typescript
export function stopSmartWakelock(): void {
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
  if (_appStateSub) {
    _appStateSub.remove();
    _appStateSub = null;
  }
  if (_wakelockHeld && _runCommand) {
    releaseWakelock(_runCommand);
  }
  _runCommand = null;
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/smart-wakelock.ts
git commit -m "fix: keep termux-wake-lock active while sessions exist (no idle timeout)"
```

---

## Phase 2: Cross-Pane Intelligence (Chat reads terminal output)

### Task 4: Add multi-session output retrieval to execution-log-store

**Files:**
- Modify: `store/execution-log-store.ts`

- [ ] **Step 1: Add getSessionIds and getRecentOutputForAllSessions**

```typescript
// Add to ExecutionLogStore type:
getSessionIds: () => string[];
getRecentOutputForAllSessions: (lines?: number) => { sessionId: string; output: string }[];

// Add implementations:
getSessionIds: () => {
  const { sessionBuffer } = get();
  return [...new Set(sessionBuffer.filter(l => l.sessionId).map(l => l.sessionId!))];
},

getRecentOutputForAllSessions: (lines = 30) => {
  const { sessionBuffer } = get();
  const sessionIds = [...new Set(sessionBuffer.filter(l => l.sessionId).map(l => l.sessionId!))];
  return sessionIds.map(sid => ({
    sessionId: sid,
    output: sessionBuffer
      .filter(l => l.sessionId === sid)
      .slice(-lines)
      .map(l => l.text)
      .join('\n'),
  }));
},
```

- [ ] **Step 2: Commit**

```bash
git add store/execution-log-store.ts
git commit -m "feat: add multi-session output retrieval to execution-log-store"
```

### Task 5: Create terminal-context.ts for chat injection

**Files:**
- Create: `lib/terminal-context.ts`

- [ ] **Step 1: Create the terminal context builder**

```typescript
// lib/terminal-context.ts
import { useExecutionLogStore } from '@/store/execution-log-store';
import { hasTerminalReference, getTerminalIntent } from '@/lib/input-router';

const TERMINAL_MENTION_RE = /@terminal[-\s]?(\d)?/i;

function getTerminalMentionSessionId(text: string): string | null {
  const m = text.match(TERMINAL_MENTION_RE);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  return `shelly-${n}`;
}

export function buildTerminalContext(userMessage: string): string | null {
  if (!hasTerminalReference(userMessage) && !TERMINAL_MENTION_RE.test(userMessage)) {
    return null;
  }

  const store = useExecutionLogStore.getState();

  // Specific session mentioned
  const mentionedSession = getTerminalMentionSessionId(userMessage);
  if (mentionedSession) {
    const output = store.getRecentOutput(50, 5, mentionedSession);
    if (!output.trim()) return null;
    return `Terminal [${mentionedSession}] output:\n${output}`;
  }

  // General terminal reference — include all sessions
  const sessions = store.getRecentOutputForAllSessions(50);
  if (sessions.length === 0) return null;

  let context = '--- Terminal Output ---\n';
  for (const s of sessions) {
    if (!s.output.trim()) continue;
    context += `[${s.sessionId}]\n${s.output}\n\n`;
  }
  context += '--- End Terminal Output ---';

  const intent = getTerminalIntent(userMessage);
  if (intent === 'reference') {
    return `The user is referencing terminal output:\n\n${context}`;
  }
  if (intent === 'second-opinion') {
    return `The user wants you to review/analyze this terminal output:\n\n${context}`;
  }
  if (intent === 'session-summary') {
    return `Summarize what happened in these terminal sessions:\n\n${context}`;
  }
  return context;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/terminal-context.ts
git commit -m "feat: terminal context builder for cross-pane intelligence"
```

### Task 6: Inject terminal context into chat message dispatch

**Files:**
- Modify: `app/(tabs)/index.tsx`

- [ ] **Step 1: Read index.tsx to find message dispatch point**

Find where user messages are sent to the AI backend. Look for `sendMessage`, `dispatch`, or `handleSend` function.

- [ ] **Step 2: Import and call buildTerminalContext before dispatch**

```typescript
import { buildTerminalContext } from '@/lib/terminal-context';

// In the send handler, before dispatching to AI:
const terminalContext = buildTerminalContext(userMessage);
const enrichedMessage = terminalContext
  ? `[Terminal Context]\n${terminalContext}\n\n[User Message]\n${userMessage}`
  : userMessage;
// Use enrichedMessage instead of userMessage for AI dispatch
```

- [ ] **Step 3: Commit**

```bash
git add app/(tabs)/index.tsx
git commit -m "feat: inject terminal output into chat when user references terminal"
```

---

## Phase 3: UX Improvements

### Task 7: Terminal background pure black

**Files:**
- Modify: `components/terminal/FullscreenTerminal.tsx`
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: Update FullscreenTerminal xterm.js theme and CSS**

In `FullscreenTerminal.tsx`, change all `#0D0D0D` to `#000000`:

```typescript
// CSS in XTERM_HTML
html, body { background: #000000; }

// xterm.js theme
theme: {
  background: '#000000',
  // ...rest stays the same
}

// React Native styles
container: { backgroundColor: '#000000' },
webview: { backgroundColor: '#000000' },
```

- [ ] **Step 2: Update terminal.tsx WebView container**

Ensure the WebView and its parent containers use `#000000`:

```typescript
// In styles or inline — any reference to #0D0D0D → #000000
// The WebView renders ttyd's own page, which has its own background.
// Just ensure the RN container behind it is pure black so no grey peeks through.
```

- [ ] **Step 3: Commit**

```bash
git add components/terminal/FullscreenTerminal.tsx app/(tabs)/terminal.tsx
git commit -m "fix: terminal background pure black (#000000)"
```

### Task 8: Add Alt key and Enter button to CommandKeyBar

**Files:**
- Modify: `components/terminal/CommandKeyBar.tsx`

- [ ] **Step 1: Add useState import and altActive state**

```typescript
// Update import
import React, { useCallback, useState } from 'react';

// Inside component, add state
const [altActive, setAltActive] = useState(false);
```

- [ ] **Step 2: Modify handleKeyPress to apply Alt modifier**

```typescript
const handleKeyPress = useCallback((keyCode: string) => {
  if (settings.hapticFeedback) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
  if (altActive) {
    sendKey('\x1b' + keyCode); // ESC prefix = Alt modifier
    setAltActive(false);
  } else {
    sendKey(keyCode);
  }
}, [sendKey, settings.hapticFeedback, altActive]);
```

- [ ] **Step 3: Add Alt and Enter buttons in JSX (after Paste button)**

```typescript
{/* Alt key toggle */}
<Pressable
  style={[
    styles.key,
    {
      backgroundColor: altActive
        ? withAlpha(c.accent, 0.2)
        : withAlpha(c.foreground, 0.06),
      borderColor: altActive ? c.accent : c.borderLight,
    },
  ]}
  onPress={() => {
    setAltActive(v => !v);
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }}
  accessibilityRole="button"
  accessibilityLabel="Alt key"
>
  <Text style={[styles.keyText, { color: altActive ? c.accent : c.foreground }]}>
    Alt
  </Text>
</Pressable>

{/* Enter key */}
<Pressable
  style={[styles.key, { backgroundColor: withAlpha(c.foreground, 0.06), borderColor: c.borderLight }]}
  onPress={() => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (altActive) {
      // Alt+Enter — some shells treat this as literal newline
      sendKey('\x1b\r');
      setAltActive(false);
    } else {
      sendKey('\r');
    }
  }}
  accessibilityRole="button"
  accessibilityLabel="Enter"
>
  <Text style={[styles.keyText, { color: c.foreground }]}>
    {isCompact ? '↵' : 'Enter'}
  </Text>
</Pressable>
```

- [ ] **Step 4: Commit**

```bash
git add components/terminal/CommandKeyBar.tsx
git commit -m "feat: add Alt key toggle + Enter button to terminal command bar"
```

### Task 9: Syntax highlighting — 256-color terminal support

**Files:**
- Modify: `components/terminal/FullscreenTerminal.tsx`
- Modify: `~/shelly-bridge/start-shelly.sh`

- [ ] **Step 1: Optimize ANSI color palette for pure black background**

In `FullscreenTerminal.tsx`, update the xterm.js theme colors for better contrast on `#000000`:

```typescript
theme: {
  background: '#000000',
  foreground: '#E0E0E0',
  cursor: '#00D4AA',
  cursorAccent: '#000000',
  selectionBackground: '#00D4AA44',
  black:   '#1A1A1A',
  red:     '#FF6B6B',
  green:   '#4ADE80',
  yellow:  '#FFD93D',
  blue:    '#6CB4FF',
  magenta: '#B48EFF',
  cyan:    '#00D4AA',
  white:   '#E0E0E0',
  brightBlack:   '#6B7280',
  brightRed:     '#FCA5A5',
  brightGreen:   '#86EFAC',
  brightYellow:  '#FDE68A',
  brightBlue:    '#93C5FD',
  brightMagenta: '#C4B5FD',
  brightCyan:    '#67E8F9',
  brightWhite:   '#F9FAFB',
},
```

- [ ] **Step 2: Set TERM=xterm-256color in start-shelly.sh**

```bash
# Add near the top of start-shelly.sh, after PATH setup
export TERM=xterm-256color

# Add tmux 256-color config
tmux set-option -g default-terminal "xterm-256color" 2>/dev/null
```

This ensures shell tools (ls --color, bat, eza, git diff, etc.) emit full color codes.

- [ ] **Step 3: Commit**

```bash
git add components/terminal/FullscreenTerminal.tsx ~/shelly-bridge/start-shelly.sh
git commit -m "feat: 256-color terminal with optimized ANSI theme for pure black bg"
```

---

## Summary

| Phase | What | Key Insight |
|-------|------|-------------|
| 1 | Seamless recovery + ttyd cap | ttyd/tmux DON'T die (wake-lock protects them). WebView render process dies → seamless reload with splash |
| 2 | Cross-pane intelligence | Chat reads any terminal's captured output via sessionBuffer |
| 3 | UX polish | Pure black bg, Alt key, 256-color support |

**Total: 9 tasks, ~24 steps**

**Important note on "background survival":** Termux survives because it uses a native terminal renderer (not WebView). Shelly uses WebView which Android CAN kill the render process of. The tmux layer ensures the actual shell session survives — the WebView just needs to re-render. With the splash overlay, this should feel near-instant to the user.
