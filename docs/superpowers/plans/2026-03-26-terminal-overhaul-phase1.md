# Terminal Overhaul Phase 1: Multi-Session Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-ttyd terminal with 6 independent ttyd sessions, each with its own bash shell, managed via tab UI.

**Architecture:** Each session gets a dedicated ttyd process on ports 7681-7686. Sessions are created lazily (ttyd launched on first use). The existing TerminalHeader component is integrated into the main terminal screen. WebView switches URI on tab change.

**Tech Stack:** React Native, Zustand, ttyd, WebView, expo-haptics

**Spec:** `docs/superpowers/specs/2026-03-26-terminal-overhaul-design.md`

---

### Task 1: Update TabSession Type & Session Constants

**Files:**
- Modify: `store/types.ts:138-148`
- Modify: `store/terminal-store.ts:20-74, 190-210`

- [ ] **Step 1: Add port and ttyUrl fields to TabSession type**

In `store/types.ts`, update the `TabSession` type:

```typescript
export type TabSession = {
  id: string;
  name: string;
  connectionStatus: ConnectionStatus;
  currentDir: string;
  port: number;          // ttyd port (7681-7686)
  ttyUrl: string;        // "http://localhost:{port}"
  blocks: CommandBlock[];
  entries: TerminalEntry[];
  commandHistory: string[];
  historyIndex: number;
};
```

- [ ] **Step 2: Add port pool constants to terminal-store**

In `store/terminal-store.ts`, add constants near the top:

```typescript
const TTYD_PORT_BASE = 7681;
const MAX_SESSIONS = 6;
const TTYD_PORTS = Array.from({ length: MAX_SESSIONS }, (_, i) => TTYD_PORT_BASE + i);
```

- [ ] **Step 3: Update default session to include port**

In `store/terminal-store.ts`, update the initial session creation:

```typescript
const DEFAULT_SESSION: TabSession = {
  id: 'session-1',
  name: 'Terminal 1',
  connectionStatus: 'local',
  currentDir: '',
  port: TTYD_PORT_BASE,
  ttyUrl: `http://localhost:${TTYD_PORT_BASE}`,
  blocks: [],
  entries: [],
  commandHistory: [],
  historyIndex: -1,
};
```

- [ ] **Step 4: Commit**

```bash
git add store/types.ts store/terminal-store.ts
git commit -m "feat: add port/ttyUrl to TabSession, increase max sessions to 6"
```

---

### Task 2: Update addSession / removeSession for Port Allocation

**Files:**
- Modify: `store/terminal-store.ts:190-230`

- [ ] **Step 1: Implement port allocation helper**

Add helper function in `terminal-store.ts`:

```typescript
function allocatePort(sessions: TabSession[]): number | null {
  const usedPorts = new Set(sessions.map((s) => s.port));
  for (const port of TTYD_PORTS) {
    if (!usedPorts.has(port)) return port;
  }
  return null; // All ports in use
}
```

- [ ] **Step 2: Update addSession to use port allocation**

Replace the `addSession` implementation:

```typescript
addSession: () => {
  const { sessions } = get();
  if (sessions.length >= MAX_SESSIONS) return;
  const port = allocatePort(sessions);
  if (!port) return;
  const newSession: TabSession = {
    id: `session-${Date.now()}`,
    name: `Terminal ${sessions.length + 1}`,
    connectionStatus: 'local',
    currentDir: '',
    port,
    ttyUrl: `http://localhost:${port}`,
    blocks: [],
    entries: [],
    commandHistory: [],
    historyIndex: -1,
  };
  set({ sessions: [...sessions, newSession], activeSessionId: newSession.id });
  get().saveSessionState();
},
```

- [ ] **Step 3: Update removeSession — no ttyd kill yet (Phase 1 Task 4 handles it)**

Ensure `removeSession` works with new structure (existing logic should suffice, just verify session limit guard is removed from `< 3`).

- [ ] **Step 4: Commit**

```bash
git add store/terminal-store.ts
git commit -m "feat: port allocation pool for multi-session (7681-7686)"
```

---

### Task 3: Refactor use-ttyd-connection for Per-Session Ports

**Files:**
- Modify: `hooks/use-ttyd-connection.ts`

- [ ] **Step 1: Accept port/ttyUrl as parameters instead of reading from store**

Refactor the hook signature:

```typescript
export function useTtydConnection(ttyUrl: string = 'http://localhost:7681') {
```

Remove the internal `ttyUrl` derivation from `termuxSettings`. The URL is now passed by the caller (terminal.tsx will pass the active session's ttyUrl).

- [ ] **Step 2: Replace module-level _ttydLaunchAttempted with per-URL map**

```typescript
const _ttydLaunchAttempted = new Map<string, boolean>();
```

Update `autoLaunchTtyd`:

```typescript
const autoLaunchTtyd = useCallback(async () => {
  if (_ttydLaunchAttempted.get(ttyUrl)) return;
  _ttydLaunchAttempted.set(ttyUrl, true);
  try {
    if (bridgeConnected) {
      const port = new URL(ttyUrl).port || '7681';
      await runRawCommand(
        `nohup ttyd -p ${port} -W bash > /dev/null 2>&1 & sleep 2 && echo OK`,
        { timeoutMs: 10000, reason: 'ttyd-auto-launch' },
      );
    }
  } catch {
    // Best-effort
  }
  setTimeout(() => { _ttydLaunchAttempted.set(ttyUrl, false); }, 30000);
}, [bridgeConnected, runRawCommand, ttyUrl]);
```

- [ ] **Step 3: Update retry to reset per-URL flag**

```typescript
const retry = useCallback(() => {
  _ttydLaunchAttempted.set(ttyUrl, false);
  startRetryLoop();
}, [startRetryLoop, ttyUrl]);
```

- [ ] **Step 4: Update useEffect dependency from [ttyUrl] (already correct)**

Verify the mount effect depends on `ttyUrl` — when session switches and ttyUrl changes, the hook restarts its connection loop.

- [ ] **Step 5: Commit**

```bash
git add hooks/use-ttyd-connection.ts
git commit -m "refactor: use-ttyd-connection accepts per-session ttyUrl"
```

---

### Task 4: Add ttyd Process Lifecycle Management

**Files:**
- Create: `lib/ttyd-manager.ts`
- Modify: `store/terminal-store.ts`

- [ ] **Step 1: Create ttyd-manager.ts**

```typescript
/**
 * ttyd-manager — launch/kill ttyd processes per session port
 */

import { useTermuxBridge } from '@/hooks/use-termux-bridge';

const TTYD_PORT_BASE = 7681;

/** Launch ttyd on a specific port (idempotent — checks if already running) */
export async function launchTtyd(
  port: number,
  runRawCommand: (cmd: string, opts: any) => Promise<any>,
): Promise<boolean> {
  try {
    // Check if already running on this port
    const check = await runRawCommand(
      `pgrep -f "ttyd -p ${port}" > /dev/null && echo RUNNING || echo STOPPED`,
      { timeoutMs: 5000, reason: 'ttyd-check' },
    );
    if (check?.output?.includes?.('RUNNING')) return true;

    // Launch new instance
    await runRawCommand(
      `nohup ttyd -p ${port} -W bash > /dev/null 2>&1 &`,
      { timeoutMs: 5000, reason: 'ttyd-launch' },
    );
    // Wait for startup
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } catch {
    return false;
  }
}

/** Kill ttyd on a specific port */
export async function killTtyd(
  port: number,
  runRawCommand: (cmd: string, opts: any) => Promise<any>,
): Promise<void> {
  try {
    await runRawCommand(
      `pkill -f "ttyd -p ${port}" 2>/dev/null; true`,
      { timeoutMs: 5000, reason: 'ttyd-kill' },
    );
  } catch {
    // Best-effort
  }
}

/** Kill all ttyd instances managed by Shelly */
export async function killAllTtyd(
  runRawCommand: (cmd: string, opts: any) => Promise<any>,
): Promise<void> {
  try {
    const ports = Array.from({ length: 6 }, (_, i) => TTYD_PORT_BASE + i);
    const pattern = ports.map((p) => `ttyd -p ${p}`).join('\\|');
    await runRawCommand(
      `pkill -f "${pattern}" 2>/dev/null; true`,
      { timeoutMs: 5000, reason: 'ttyd-kill-all' },
    );
  } catch {
    // Best-effort
  }
}
```

- [ ] **Step 2: Wire removeSession to killTtyd**

In `terminal-store.ts`, update `removeSession` to store the port for cleanup (actual kill will be triggered from the component that has bridge access).

Add a new action `getSessionPort`:

```typescript
getSessionPort: (sessionId: string): number | undefined => {
  const session = get().sessions.find((s) => s.id === sessionId);
  return session?.port;
},
```

- [ ] **Step 3: Commit**

```bash
git add lib/ttyd-manager.ts store/terminal-store.ts
git commit -m "feat: ttyd-manager for per-session process lifecycle"
```

---

### Task 5: Integrate TerminalHeader into terminal.tsx

**Files:**
- Modify: `app/(tabs)/terminal.tsx:1-50, 338-370`
- Modify: `components/terminal/TerminalHeader.tsx:225`

- [ ] **Step 1: Update TerminalHeader session limit from 3 to MAX_SESSIONS**

In `TerminalHeader.tsx`, change:

```typescript
// Before:
{sessions.length < 3 && (
// After:
{sessions.length < 6 && (
```

Import and use the constant if accessible, or hardcode 6.

- [ ] **Step 2: Replace terminal.tsx custom status bar with TerminalHeader**

In `terminal.tsx`, replace the custom status bar JSX (the `<View style={[styles.statusBar, ...`> block) with:

```typescript
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
```

And in the return:

```tsx
<View style={[styles.container, { paddingTop: insets.top, backgroundColor: c.background }]}>
  <TerminalHeader />
  {/* ... rest of terminal content */}
</View>
```

Remove the now-unused StatusBadge component and related styles.

- [ ] **Step 3: Pass active session's ttyUrl to useTtydConnection**

```typescript
const activeSession = useActiveSession();
const {
  status, retryCount, retry, onWebViewLoad, onWebViewError, ttyUrl,
} = useTtydConnection(activeSession?.ttyUrl || 'http://localhost:7681');
```

- [ ] **Step 4: Update WebView source to use dynamic ttyUrl**

The WebView already uses `ttyUrl` from the hook — verify it renders the active session's URL:

```tsx
<WebView
  ref={webViewRef}
  source={{ uri: ttyUrl }}
  // ... rest unchanged
/>
```

- [ ] **Step 5: Commit**

```bash
git add "app/(tabs)/terminal.tsx" components/terminal/TerminalHeader.tsx
git commit -m "feat: integrate TerminalHeader with multi-session tab UI"
```

---

### Task 6: Handle Session Switching in WebView

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: Re-inject capture JS on session switch**

Add effect that watches `activeSession.id`:

```typescript
const prevSessionIdRef = useRef(activeSession?.id);

useEffect(() => {
  if (activeSession && activeSession.id !== prevSessionIdRef.current) {
    prevSessionIdRef.current = activeSession.id;
    // WebView will reload due to URI change → handleWebViewLoad re-injects capture JS
    // Reset connection state for new session
    setWebViewFailed(false);
  }
}, [activeSession?.id]);
```

- [ ] **Step 2: Verify CAPTURE_INJECT_JS re-injection**

The `handleWebViewLoad` callback already injects `CAPTURE_INJECT_JS` on every `onLoadEnd`. Since the WebView URI changes on session switch, `onLoadEnd` fires again → capture JS is re-injected. The `__shellyCaptureActive` guard in the JS resets because it's a new page load.

No code change needed, just verify the flow works.

- [ ] **Step 3: Commit**

```bash
git add "app/(tabs)/terminal.tsx"
git commit -m "feat: handle session switching with WebView URI swap"
```

---

### Task 7: ttyd Auto-Launch on Session Creation

**Files:**
- Modify: `app/(tabs)/terminal.tsx`
- Modify: `hooks/use-ttyd-connection.ts`

- [ ] **Step 1: Auto-launch ttyd when new session is created**

The existing `useTtydConnection` hook already auto-launches ttyd after 2 failed connection attempts. Since each session has its own port, and the hook is parameterized with `ttyUrl`, this should work automatically when:

1. User taps "+" → `addSession()` creates session with port 7682
2. Store sets `activeSessionId` to new session
3. `terminal.tsx` re-renders with new `activeSession.ttyUrl`
4. `useTtydConnection('http://localhost:7682')` restarts → HEAD check fails → auto-launches ttyd on port 7682

Verify this flow works by reading through the code path. If the `ttyUrl` dependency in the mount effect triggers correctly, no additional code is needed.

- [ ] **Step 2: Add port extraction for auto-launch command**

Already handled in Task 3 Step 2 — `autoLaunchTtyd` extracts port from URL.

- [ ] **Step 3: Commit (if any changes needed)**

```bash
git add hooks/use-ttyd-connection.ts "app/(tabs)/terminal.tsx"
git commit -m "feat: auto-launch ttyd per-session on first use"
```

---

### Task 8: Kill ttyd on Session Removal

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: Kill ttyd when session is removed**

In terminal.tsx, add cleanup when a session is removed. Listen for session removal and kill the ttyd process:

```typescript
const { runRawCommand } = useTermuxBridge();

// Wrap removeSession to also kill ttyd
const handleRemoveSession = useCallback(async (sessionId: string) => {
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    await killTtyd(session.port, runRawCommand);
  }
  removeSession(sessionId);
}, [sessions, removeSession, runRawCommand]);
```

Pass `handleRemoveSession` to TerminalHeader via props or store action.

- [ ] **Step 2: Commit**

```bash
git add "app/(tabs)/terminal.tsx"
git commit -m "feat: kill ttyd process on session removal"
```

---

### Task 9: Verify & Polish

**Files:**
- All modified files

- [ ] **Step 1: Verify session creation flow**

Manual test: tap "+" → new tab appears → ttyd launches → WebView connects → terminal is usable.

- [ ] **Step 2: Verify session switching**

Manual test: switch between tabs → WebView loads correct ttyd → each session has independent shell state.

- [ ] **Step 3: Verify session removal**

Manual test: long-press tab → confirm delete → ttyd process killed → tab disappears → fallback to remaining session.

- [ ] **Step 4: Verify AppState resume with multi-session**

Manual test: background app → foreground → active session reconnects without unnecessary reloads on other sessions.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: multi-session terminal infrastructure complete (Phase 1)"
```
