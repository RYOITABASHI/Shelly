# Termux Pain Killer — Implementation Plan

> **Goal:** Shellyがターミナルアプリとして Termux を超えるための統合改修。8機能、14タスク、4フェーズ。
>
> **Spec:** `docs/superpowers/specs/2026-03-30-termux-pain-killer-design.md`

---

## Phase 1: 基盤系（独立して実装可能）

### Task 1: Terminal theme definitions + settings-store extension

**Files:**
- Create: `lib/terminal-theme.ts`
- Modify: `store/settings-store.ts`
- Modify: `store/types.ts` (AppSettings type)

- [ ] **Step 1: Create `lib/terminal-theme.ts`**

```typescript
export type TerminalTheme = {
  name: string;
  label: string;
  background: string;
  foreground: string;
  cursor: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
};

export const TERMINAL_THEMES: Record<string, TerminalTheme> = {
  shelly: {
    name: 'shelly', label: 'Shelly',
    background: '#0A0A0A', foreground: '#E8E8E8', cursor: '#00D4AA',
    black: '#1A1A2E', red: '#FF6B6B', green: '#00D4AA', yellow: '#FFD93D',
    blue: '#6C63FF', magenta: '#CC6FE8', cyan: '#45E3FF', white: '#E8E8E8',
    brightBlack: '#4B5563', brightRed: '#FF8A8A', brightGreen: '#4AEDC4',
    brightYellow: '#FFE566', brightBlue: '#8B83FF', brightMagenta: '#DD8FEE',
    brightCyan: '#6EEBFF', brightWhite: '#FFFFFF',
  },
  dracula: {
    name: 'dracula', label: 'Dracula',
    background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2',
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C',
    blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
    brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94',
    brightYellow: '#FFFFA5', brightBlue: '#D6ACFF', brightMagenta: '#FF92DF',
    brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
  nord: {
    name: 'nord', label: 'Nord',
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B',
    blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C',
    brightYellow: '#EBCB8B', brightBlue: '#81A1C1', brightMagenta: '#B48EAD',
    brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
  monokai: {
    name: 'monokai', label: 'Monokai',
    background: '#272822', foreground: '#F8F8F2', cursor: '#F8F8F0',
    black: '#272822', red: '#F92672', green: '#A6E22E', yellow: '#F4BF75',
    blue: '#66D9EF', magenta: '#AE81FF', cyan: '#A1EFE4', white: '#F8F8F2',
    brightBlack: '#75715E', brightRed: '#F92672', brightGreen: '#A6E22E',
    brightYellow: '#F4BF75', brightBlue: '#66D9EF', brightMagenta: '#AE81FF',
    brightCyan: '#A1EFE4', brightWhite: '#F9F8F5',
  },
  tokyo_night: {
    name: 'tokyo_night', label: 'Tokyo Night',
    background: '#1A1B26', foreground: '#A9B1D6', cursor: '#C0CAF5',
    black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
    blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
    brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A',
    brightYellow: '#E0AF68', brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7',
    brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
  },
  gruvbox: {
    name: 'gruvbox', label: 'Gruvbox',
    background: '#282828', foreground: '#EBDBB2', cursor: '#EBDBB2',
    black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921',
    blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
    brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26',
    brightYellow: '#FABD2F', brightBlue: '#83A598', brightMagenta: '#D3869B',
    brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
  },
  catppuccin: {
    name: 'catppuccin', label: 'Catppuccin',
    background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC',
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF',
    blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
    brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1',
    brightYellow: '#F9E2AF', brightBlue: '#89B4FA', brightMagenta: '#F5C2E7',
    brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
  },
  solarized: {
    name: 'solarized', label: 'Solarized Dark',
    background: '#002B36', foreground: '#839496', cursor: '#839496',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
    blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75',
    brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4',
    brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
  },
};

export function getTerminalTheme(name: string): TerminalTheme {
  return TERMINAL_THEMES[name] ?? TERMINAL_THEMES.shelly;
}

export const TERMINAL_THEME_NAMES = Object.keys(TERMINAL_THEMES);
```

- [ ] **Step 2: Extend AppSettings type in `store/types.ts`**

Add to AppSettings interface:
```typescript
  // Terminal appearance (new)
  terminalTheme: string;        // key into TERMINAL_THEMES
  fontSizeLocked: boolean;      // disable pinch-zoom
  hideKeyBarWithHwKeyboard: boolean; // auto-hide CommandKeyBar when hardware keyboard detected
```

- [ ] **Step 3: Update `store/settings-store.ts` defaults**

Add to DEFAULT_SETTINGS:
```typescript
  terminalTheme: 'shelly',
  fontSizeLocked: false,
  hideKeyBarWithHwKeyboard: false,
```

- [ ] **Step 4: Commit**

```bash
git add lib/terminal-theme.ts store/settings-store.ts store/types.ts
git commit -m "feat: add terminal ANSI themes (8 presets) + settings extensions"
```

---

### Task 2: SmartKeyBar (CommandKeyBar extension)

**Files:**
- Modify: `components/terminal/CommandKeyBar.tsx` (in-place extension, not replace)

- [ ] **Step 1: Add key sets and context detection**

Replace existing KEYS array with multi-set system. Add horizontal paging with dot indicators. Add auto-detect badge (non-intrusive suggestion, not auto-switch).

Key sets: default (current 7 keys), vim (Esc/:w/:q/:wq/dd/u/Ctrl+R), git (status/diff/add/commit/push/log/stash), repl (Tab/↑/Ctrl+C/Ctrl+D/Ctrl+L/Paste/Enter), navigate (←/→/Home/End/PgUp/PgDn/Del).

User swipes left/right to switch set. A small badge appears when vim/git/repl is detected in PTY output (user taps to switch, never auto-switches).

- [ ] **Step 2: Add piñch-zoom lock support**

When `settings.fontSizeLocked` is true, the SmartKeyBar displays a lock icon. The actual pinch-zoom disable is handled in terminal.tsx by passing a prop to NativeTerminalView.

- [ ] **Step 3: Commit**

```bash
git add components/terminal/CommandKeyBar.tsx
git commit -m "feat: SmartKeyBar with 5 context key sets + swipe switching"
```

---

### Task 3: ProcessGuard (kill detection + device profiler)

**Files:**
- Create: `lib/process-guard.ts`

- [ ] **Step 1: Create `lib/process-guard.ts`**

```typescript
import * as Device from 'expo-device';
import { Platform } from 'react-native';

export type KillFixStep = {
  title: string;
  description: string;
  intentUri?: string;  // android.intent URI to open settings
  adbCommand?: string; // ADB command to copy
};

export type DeviceProfile = {
  androidVersion: number;
  manufacturer: string;
  fixSteps: KillFixStep[];
};

export function getDeviceProfile(): DeviceProfile {
  const ver = Platform.Version as number;
  const mfr = (Device.manufacturer ?? '').toLowerCase();
  const steps: KillFixStep[] = [];

  // Step 1: Android version-specific phantom process fix
  if (ver >= 34) { // Android 14+
    steps.push({
      title: 'Disable process restrictions',
      description: 'Open Developer Options and disable "Background process limit" restrictions.',
      intentUri: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
    });
  } else if (ver >= 31) { // Android 12-13
    steps.push({
      title: 'Disable phantom process killer (ADB required)',
      description: 'Connect to a PC and run this ADB command:',
      adbCommand: ver >= 32
        ? 'adb shell settings put global settings_enable_monitor_phantom_procs false'
        : 'adb shell "device_config set_sync_disabled_for_tests persistent && device_config put activity_manager max_phantom_processes 2147483647"',
    });
  }

  // Step 2: Manufacturer-specific battery optimization
  if (mfr.includes('samsung')) {
    steps.push({
      title: 'Samsung battery optimization',
      description: 'Settings > Battery > App battery usage > Shelly > Unrestricted',
      intentUri: 'android.settings.BATTERY_SAVER_SETTINGS',
    });
  } else if (mfr.includes('xiaomi') || mfr.includes('redmi') || mfr.includes('poco')) {
    steps.push({
      title: 'Xiaomi battery optimization',
      description: 'Settings > Battery & performance > App battery saver > Shelly > No restrictions',
      intentUri: 'android.settings.BATTERY_SAVER_SETTINGS',
    });
  } else if (mfr.includes('huawei') || mfr.includes('honor')) {
    steps.push({
      title: 'Huawei battery optimization',
      description: 'Settings > Battery > App launch > Shelly > Manage manually (all toggles ON)',
      intentUri: 'android.settings.BATTERY_SAVER_SETTINGS',
    });
  } else if (mfr.includes('oppo') || mfr.includes('realme') || mfr.includes('oneplus')) {
    steps.push({
      title: 'OPPO/OnePlus battery optimization',
      description: 'Settings > Battery > Battery optimization > Shelly > Not optimized',
      intentUri: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    });
  } else {
    steps.push({
      title: 'Disable battery optimization',
      description: 'Settings > Battery > Battery optimization > Shelly > Not optimized',
      intentUri: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    });
  }

  return { androidVersion: ver, manufacturer: mfr, fixSteps: steps };
}

// Signal 9 = SIGKILL = Android killed the process
export function isProcessKill(signal: number, exitCode: number): boolean {
  return signal === 9 || exitCode === 137;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/process-guard.ts
git commit -m "feat: add process kill detection and device-specific fix guides"
```

---

### Task 4: PackageDoctor (error diagnosis + auto-repair)

**Files:**
- Create: `lib/package-doctor.ts`

- [ ] **Step 1: Create `lib/package-doctor.ts`**

```typescript
export type PackageFix = {
  fix: string;        // shell command to run
  message: string;    // user-facing description
  autoRun: boolean;   // safe to run without confirmation
};

export function diagnosePackageError(stderr: string): PackageFix | null {
  if (stderr.includes('Unable to locate package')) {
    return { fix: 'pkg update -y', message: 'Updating package list...', autoRun: true };
  }
  if (stderr.includes('NOSPLIT') || stderr.includes('Clearsigned file')) {
    return { fix: 'termux-change-repo', message: 'Switching to a working mirror...', autoRun: false };
  }
  if (stderr.includes('dpkg was interrupted')) {
    return { fix: 'dpkg --configure -a', message: 'Repairing package manager...', autoRun: true };
  }
  if (stderr.includes('Unable to acquire the dpkg frontend lock')) {
    return {
      fix: 'rm -f $PREFIX/var/lib/dpkg/lock-frontend && dpkg --configure -a',
      message: 'Releasing lock and repairing...',
      autoRun: true,
    };
  }
  if (stderr.includes('404  Not Found') || stderr.includes('Failed to fetch')) {
    return { fix: 'pkg update -y', message: 'Refreshing repository cache...', autoRun: true };
  }
  if (stderr.includes('Unmet dependencies') || stderr.includes('Depends:')) {
    return { fix: 'pkg install -f -y', message: 'Fixing broken dependencies...', autoRun: true };
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/package-doctor.ts
git commit -m "feat: add package error diagnosis and auto-repair for common Termux failures"
```

---

## Phase 2: UI Components

### Task 5: ProcessGuardModal

**Files:**
- Create: `components/terminal/ProcessGuardModal.tsx`

- [ ] **Step 1: Create ProcessGuardModal**

Step-by-step wizard with:
1. Problem explanation (no tech jargon, visual illustration)
2. Device-specific fix steps from `getDeviceProfile()`
3. Each step: description + action button (open settings / copy ADB command)
4. Verification: "Switch away for 30s, then come back. Is it still running?"

- [ ] **Step 2: Integrate into terminal.tsx**

Add `TerminalEmulator.addListener('onSessionExit')` check for signal 9. Track kill count in state. Show modal after 2+ kills.

- [ ] **Step 3: Commit**

```bash
git add components/terminal/ProcessGuardModal.tsx app/(tabs)/terminal.tsx
git commit -m "feat: add ProcessGuard wizard for Android phantom process killer"
```

---

### Task 6: FirstMateOverlay

**Files:**
- Create: `components/terminal/FirstMateOverlay.tsx`

- [ ] **Step 1: Create FirstMateOverlay**

Goal-selection grid: Web Development / AI Development / File Management / Programming Study.
Each selection → package bundle auto-install via bridge.
Auto-runs `pkg update -y && pkg upgrade -y` first.
Auto-runs `termux-setup-storage` for storage permission.
Progress bar + status text during install.
Saved to AsyncStorage `firstmate_completed` to show only once.

- [ ] **Step 2: Integrate into terminal.tsx**

Show after first successful bridge connection if `firstmate_completed` is not set.

- [ ] **Step 3: Commit**

```bash
git add components/terminal/FirstMateOverlay.tsx app/(tabs)/terminal.tsx
git commit -m "feat: add FirstMate onboarding with goal-based package bundles"
```

---

### Task 7: Terminal Appearance settings section

**Files:**
- Modify: `app/(tabs)/settings.tsx`

- [ ] **Step 1: Add Terminal Appearance section**

Between existing sections, add:
- Theme selector (horizontal scroll of theme preview cards)
- Font size slider (with live preview)
- Cursor shape picker (existing, move here)
- Pinch-zoom lock toggle
- Hardware keyboard key-bar hide toggle

Each theme card: 80x50 mini-terminal preview with 3 sample lines in the theme's colors.

- [ ] **Step 2: Commit**

```bash
git add app/(tabs)/settings.tsx
git commit -m "feat: add Terminal Appearance section with theme previews"
```

---

### Task 8: Package NL patterns in input-router

**Files:**
- Modify: `lib/input-router.ts`

- [ ] **Step 1: Add package management patterns to LIGHTWEIGHT_PATTERNS**

```typescript
  // Package management
  { pattern: /^(?:(?:install|インストール)\s+)(.+)/i, command: 'pkg install -y $1', label: 'pkg install' },
  { pattern: /^(?:パッケージ|package)(?:を|)(?:更新|アップデート|update)/i, command: 'pkg update -y && pkg upgrade -y', label: 'pkg update' },
  { pattern: /^(?:(?:search|検索|探す)\s+(?:package|パッケージ)\s+)(.+)/i, command: 'pkg search $1', label: 'pkg search' },
  { pattern: /^(?:(?:remove|削除|アンインストール)\s+)(.+)/i, command: 'pkg remove -y $1', label: 'pkg remove' },
```

Note: $1 substitution needs matchLightweightTask to support capture groups.

- [ ] **Step 2: Wire package-doctor into use-terminal-output.ts**

After bridge command exits with error, check stderr with `diagnosePackageError()`. If a fix is found and `autoRun` is true, execute it automatically. If `autoRun` is false, show ApprovalBubble.

- [ ] **Step 3: Commit**

```bash
git add lib/input-router.ts hooks/use-terminal-output.ts
git commit -m "feat: add natural language package management + auto-repair on errors"
```

---

## Phase 3: VoiceChain + ClipboardPlus + OutputIntel

### Task 9: VoiceChain (voice ↔ terminal integration)

**Files:**
- Modify: `hooks/use-voice-chat.ts` (major rewrite)
- Modify: `components/VoiceChat.tsx`
- Create: `lib/voice-chain-helpers.ts`

- [ ] **Step 1: Create `lib/voice-chain-helpers.ts`**

```typescript
// Summarize long terminal output for voice reading
export async function summarizeForSpeech(
  output: string,
  apiKey: string,
  provider: 'groq' | 'cerebras' | 'gemini'
): Promise<string> {
  // Short output → read as-is
  if (output.length <= 200) return output;
  // AI summarization: "Summarize this terminal output for voice reading, 2 sentences max, natural spoken Japanese"
  // ... provider-specific API call
}
```

- [ ] **Step 2: Rewrite `hooks/use-voice-chat.ts`**

Replace `processRecording()` Step 2 (direct AI chat) with:
1. `parseInput(transcript)` → get routing info
2. If `layer === 'command'` or `layer === 'lightweight'`:
   - Execute via `runRawCommand()`
   - Summarize output for speech
   - Speak result
   - Also echo command to terminal via `writeToSession()`
3. If `layer === 'natural'` or `layer === 'nl_with_tool'` or `layer === 'mention'`:
   - Inject terminal output context if `hasTerminalReference(transcript)`
   - Send to AI (existing flow)
   - Speak response
4. New status: `'executing'` between `'thinking'` and `'speaking'` for terminal commands

- [ ] **Step 3: Update `components/VoiceChat.tsx`**

- Add `'executing'` status with terminal icon + spinner
- Show `$ command` text when executing terminal command
- Show command output preview (first 3 lines) under response

- [ ] **Step 4: Commit**

```bash
git add lib/voice-chain-helpers.ts hooks/use-voice-chat.ts components/VoiceChat.tsx
git commit -m "feat: VoiceChain — connect voice to terminal via input-router"
```

---

### Task 10: ClipboardPlus (Ctrl+Shift+C/V + terminal link detection)

**Files:**
- Create: `lib/terminal-link-detector.ts`
- Modify: `hooks/use-terminal-output.ts` (general URL detection)

- [ ] **Step 1: Create `lib/terminal-link-detector.ts`**

```typescript
const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g;
const FILE_PATH_PATTERN = /(?:^|\s)((?:\/|\.\/|~\/)[^\s:]+\.[a-zA-Z0-9]+)/g;

export type TerminalLink = {
  text: string;
  type: 'url' | 'file';
};

export function detectLinks(line: string): TerminalLink[] { ... }
```

- [ ] **Step 2: Enhance use-terminal-output.ts**

Add general URL detection (not just localhost). When non-localhost URL detected, offer as previewable link in chat bubbles.

- [ ] **Step 3: Commit**

```bash
git add lib/terminal-link-detector.ts hooks/use-terminal-output.ts
git commit -m "feat: terminal link detection for URLs and file paths"
```

---

### Task 11: OutputIntel (smart output blocks in chat)

**Files:**
- Modify: `hooks/use-terminal-output.ts`

- [ ] **Step 1: Add command completion detection**

Detect when a command finishes (prompt restoration pattern like `$ ` or `> `) and capture the command + output block. In wide mode, add a compact summary to chat (existing ErrorSummaryBubble pattern, but for all commands).

- [ ] **Step 2: Commit**

```bash
git add hooks/use-terminal-output.ts
git commit -m "feat: smart terminal output capture with command block detection"
```

---

## Phase 4: Integration + Polish

### Task 12: i18n keys

**Files:**
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/ja.ts`

- [ ] **Step 1: Add all new keys**

ProcessGuard, FirstMate, SmartKeyBar, VoiceChain, ThemeStudio keys.

- [ ] **Step 2: Commit**

```bash
git add lib/i18n/locales/en.ts lib/i18n/locales/ja.ts
git commit -m "feat: add i18n keys for Termux pain killer features"
```

---

### Task 13: SetupWizard ProcessGuard step

**Files:**
- Modify: SetupWizard (find exact file)

- [ ] **Step 1: Add "Background Protection" step to SetupWizard**

After Termux install check + before finish, add a step showing device-specific battery optimization guide. Use `getDeviceProfile()` from process-guard.ts.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: add background protection step to SetupWizard"
```

---

### Task 14: Final verification + worklog

- [ ] **Step 1: TypeScript check**
- [ ] **Step 2: Verify no broken imports**
- [ ] **Step 3: Update worklog memory**
