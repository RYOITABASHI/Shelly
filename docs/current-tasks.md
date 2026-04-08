# Current Tasks — Termux Dependency Removal (2026-04-08)

Status: 9 tasks, 0 completed.

## Background

Superset UI Redesign (Plans 1-5) is complete (50+ commits). The app now uses JNI forkpty for native terminal — no Termux bridge. However, 9 files still contain Termux-era code that doesn't work.

## New Architecture API Reference

```typescript
// Real command execution (JNI, synchronous result)
import { execCommand } from '@/hooks/use-native-exec';
const result = await execCommand('ls -la');
// result: { stdout: string, stderr: string, exitCode: number }

// Write to interactive PTY session
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
await TerminalEmulator.writeToSession(sessionId, 'claude auth login\n');

// Secure API key storage
import { saveApiKey, getApiKey } from '@/lib/secure-store';
await saveApiKey('perplexityApiKey', 'pplx-xxxx');

// Settings update
import { useSettingsStore } from '@/store/settings-store';
useSettingsStore.getState().updateSettings({ fontSize: 16 });
```

---

## Task 1: AuthWizard — web auth broken
- **File**: `components/AuthWizard.tsx`
- **Problem**: `handleBrowserAuth()` calls `runCommand('claude auth login')` via pseudo-shell mock — never reaches real PTY
- **Fix**: 
  - Send to real PTY: `TerminalEmulator.writeToSession(sessionId, 'claude auth login\n')`
  - Poll terminal output every 2s for URL pattern (`https?://[^\s]+`)
  - Auto-open URL via `Linking.openURL(url)`
  - Detect success: "authenticated", "success", "logged in"
  - 60s timeout
  - Session ID: `useTerminalStore.getState().sessions[0]?.nativeSessionId`
  - Keep API key manual input working (don't touch that path)

## Task 2: cli-runner.ts — Termux messages
- **File**: `lib/cli-runner.ts`
- **Problem**: 13+ Termux string references, bridge-based CLI launching
- **Fix**: Replace all "Termux" → "terminal", use `execCommand('which claude')` for detection

## Task 3: PackageManager.tsx — pkg hardcoded
- **File**: `components/PackageManager.tsx`
- **Problem**: `pkg install/upgrade/uninstall` only. Termux-only.
- **Fix**: Replace with "Tool Status" panel showing bundled tool versions via `execCommand('node --version')` etc.
- **Bundled**: bash, Node.js 22, Python 3.12, git, curl, sqlite3

## Task 4: env-manager.ts — pkg install
- **File**: `lib/env-manager.ts`
- **Problem**: `pkg install -y node`, `pkg update -y` hardcoded
- **Fix**: `ensureTool()` → `checkTool()`. Tools are bundled, just verify with `which <tool>`

## Task 5: terminal-store.ts — mock execution
- **File**: `store/terminal-store.ts`
- **Problem**: `runCommand()` uses `pseudo-shell.ts` (fake FS mock). Real commands don't execute.
- **Fix**:
  - Commands starting with `shelly ` → keep in pseudo-shell (app commands)
  - Everything else → `execCommand(command)` for real JNI execution
  - Feed stdout/stderr to existing block output system

## Task 6: cli-auth.ts — shellyrc sed
- **File**: `lib/cli-auth.ts`
- **Problem**: Uses `sed` to write env vars to `~/.shellyrc`
- **Fix**: Use `lib/secure-store.ts` for token storage instead

## Task 7: github-push.ts — no git check
- **File**: `lib/github-push.ts`
- **Problem**: `runCommand('git ...')` with no fallback if git missing
- **Fix**: `execCommand('which git')` check before operations, clear error if missing

## Task 8: input-router.ts — pkg routing
- **File**: `lib/input-router.ts`
- **Problem**: Routes "package" natural language to `pkg update -y`
- **Fix**: Route to `npm install` or appropriate alternative

## Task 9: ErrorSummaryBubble.tsx — pkg suggestions
- **File**: `components/chat/ErrorSummaryBubble.tsx`
- **Problem**: Suggests `pkg install <cmd>` in error messages
- **Fix**: Suggest `npm install -g` or appropriate guidance

---

## Rules (apply to ALL tasks)

1. `execCommand()` from `hooks/use-native-exec.ts` for real execution
2. `TerminalEmulator.writeToSession()` for interactive PTY
3. `lib/secure-store.ts` for API keys/tokens (NOT `~/.shellyrc`)
4. `store/settings-store.ts` for settings (NOT direct file writes)
5. No `pkg` commands anywhere
6. No "Termux" in user-facing strings
7. `shelly ` prefix → pseudo-shell; everything else → JNI exec
