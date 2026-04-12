# Interactive Terminal Setup (`shelly setup`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the modal WelcomeWizard with a terminal-native `shelly setup` command that guides users through CLI installation, Git config, and project folder registration — all inline with tappable buttons.

**Architecture:** A new `SetupBlock` React component renders interactive setup steps inside the terminal's block list. The pseudo-shell routes `shelly setup [cli|git|projects]` to a setup orchestrator (`lib/setup-flow.ts`) that emits setup-specific blocks into terminal-store. ShellLayout triggers `shelly setup` on first launch instead of showing the modal wizard. Each step has a Skip button. ConfigTUI gets a "Re-run setup" action.

**Tech Stack:** React Native (Pressable buttons), Zustand (terminal-store), AsyncStorage (completion flag), execCommand (JNI), TerminalEmulator.writeToSession (PTY), i18n (en/ja)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `lib/setup-flow.ts` | Setup orchestrator — step sequencing, CLI install, git config, project scan |
| Create | `components/terminal/SetupBlock.tsx` | Interactive UI block with tappable buttons, progress indicators |
| Modify | `lib/pseudo-shell.ts` | Add `shelly setup [cli|git|projects]` command routing |
| Modify | `store/terminal-store.ts` | Add `addSetupBlock()` action, import SetupBlock type |
| Modify | `store/types.ts` | Add `SetupBlock` type to `TerminalEntry` union |
| Modify | `components/layout/ShellLayout.tsx` | Replace WelcomeWizard modal with `runCommand('shelly setup')` on first launch |
| Modify | `components/config/ConfigTUI.tsx` | Add "Re-run Setup" action button |
| Modify | `lib/i18n/locales/en.ts` | Add `setup.*` i18n keys |
| Modify | `lib/i18n/locales/ja.ts` | Add `setup.*` i18n keys |
| Modify | `app/(tabs)/terminal.tsx` | Render SetupBlock entries alongside CommandBlock/AiBlock |

---

### Task 1: Add SetupBlock type to store/types.ts

**Files:**
- Modify: `store/types.ts`

- [ ] **Step 1: Add SetupBlock type and update TerminalEntry**

Add after the `AiBlock` type definition (~line 116):

```typescript
// ─── Setup Block ────────────────────────────────────────────────────────────

export type SetupStepId = 'welcome' | 'cli-select' | 'cli-install' | 'cli-auth' | 'git-config' | 'project-scan' | 'done';

export type SetupOption = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  badge?: string;      // e.g. "FREE"
  selected?: boolean;
};

export type SetupBlock = {
  id: string;
  sessionId: string;
  blockType: 'setup';
  stepId: SetupStepId;
  title: string;
  description?: string;
  /** Tappable options (buttons/checkboxes) */
  options?: SetupOption[];
  /** Whether multiple options can be selected */
  multiSelect?: boolean;
  /** Text input prompt (for git user.name etc.) */
  inputPrompt?: string;
  inputPlaceholder?: string;
  /** Current value for text input */
  inputValue?: string;
  /** Log lines (install progress, etc.) */
  logLines?: string[];
  /** Step status */
  status: 'active' | 'completed' | 'skipped' | 'error';
  /** Error message */
  errorMessage?: string;
  /** Show skip button */
  skippable: boolean;
  /** Show back button */
  showBack?: boolean;
  timestamp: number;
};
```

Update the TerminalEntry union:

```typescript
export type TerminalEntry = CommandBlock | AiBlock | SetupBlock;
```

- [ ] **Step 2: Commit**

```bash
git add store/types.ts
git commit -m "feat: add SetupBlock type for interactive terminal setup"
```

---

### Task 2: Add setup block actions to terminal-store

**Files:**
- Modify: `store/terminal-store.ts`

- [ ] **Step 1: Add setup block actions to store type and implementation**

Add to the `TerminalState` type (after `addEntryBlock`):

```typescript
/** Add a setup block to the active session's entries */
addSetupBlock: (block: SetupBlock) => void;
/** Update an existing setup block */
updateSetupBlock: (blockId: string, updates: Partial<SetupBlock>) => void;
```

Add imports for `SetupBlock` from `./types`.

Add implementations:

```typescript
addSetupBlock: (block: SetupBlock) => {
  const { activeSessionId } = get();
  set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === activeSessionId
        ? { ...s, entries: [...s.entries, block] }
        : s
    ),
  }));
},

updateSetupBlock: (blockId: string, updates: Partial<SetupBlock>) => {
  const { sessions, activeSessionId } = get();
  const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
  if (sIdx === -1) return;
  const eIdx = sessions[sIdx].entries.findIndex((e) => e.id === blockId);
  if (eIdx === -1) return;
  const updatedEntry = { ...sessions[sIdx].entries[eIdx], ...updates };
  const updatedEntries = [...sessions[sIdx].entries];
  updatedEntries[eIdx] = updatedEntry;
  const updatedSession = { ...sessions[sIdx], entries: updatedEntries };
  const updatedSessions = [...sessions];
  updatedSessions[sIdx] = updatedSession;
  set({ sessions: updatedSessions });
},
```

- [ ] **Step 2: Commit**

```bash
git add store/terminal-store.ts
git commit -m "feat: add addSetupBlock/updateSetupBlock actions"
```

---

### Task 3: Add i18n keys for setup flow

**Files:**
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/ja.ts`

- [ ] **Step 1: Add setup.* keys to en.ts**

Add after the existing `wizard2.*` section:

```typescript
// ── Interactive Setup (shelly setup) ────────────────────────────────
'setup.welcome_title': 'Welcome to Shelly',
'setup.welcome_desc': 'Let\'s set up your terminal. This takes about 2 minutes.\nYou can skip any step.',
'setup.next': 'Next',
'setup.skip': 'Skip',
'setup.back': 'Back',
'setup.done': 'Done',
'setup.retry': 'Retry',
// CLI step
'setup.cli_title': 'Install AI Coding Agents',
'setup.cli_desc': 'Pick the tools you want to use. All are optional.',
'setup.cli_claude': 'Claude Code',
'setup.cli_claude_desc': 'Anthropic\'s coding agent',
'setup.cli_gemini': 'Gemini CLI',
'setup.cli_gemini_desc': 'Google\'s coding agent (free)',
'setup.cli_codex': 'Codex CLI',
'setup.cli_codex_desc': 'OpenAI\'s coding agent',
'setup.cli_installing': 'Installing {name}...',
'setup.cli_installed': '{name} installed',
'setup.cli_already': '{name} already installed',
'setup.cli_failed': 'Failed to install {name}',
'setup.cli_install_all': 'Install Selected',
'setup.cli_none_selected': 'No tools selected — skipping installation.',
// Auth step
'setup.auth_title': 'Sign In',
'setup.auth_desc': 'Authenticate your installed tools.',
'setup.auth_browser': 'Sign in with browser',
'setup.auth_apikey': 'Enter API key',
'setup.auth_skip_tool': 'Skip this tool',
// Git step
'setup.git_title': 'Git Configuration',
'setup.git_desc': 'Set up your Git identity for commits.',
'setup.git_name_prompt': 'Your name (for git commits)',
'setup.git_email_prompt': 'Your email (for git commits)',
'setup.git_name_placeholder': 'e.g. John Doe',
'setup.git_email_placeholder': 'e.g. john@example.com',
'setup.git_configured': 'Git configured: {name} <{email}>',
'setup.git_already': 'Git already configured: {name} <{email}>',
'setup.git_ssh_prompt': 'Generate SSH key for GitHub?',
'setup.git_ssh_yes': 'Generate SSH Key',
'setup.git_ssh_no': 'Skip SSH',
// Project step
'setup.project_title': 'Project Folders',
'setup.project_desc': 'Select folders to show in the sidebar.',
'setup.project_scanning': 'Scanning ~/...',
'setup.project_none': 'No project folders found.',
'setup.project_register': 'Add Selected',
// Done
'setup.done_title': 'You\'re All Set!',
'setup.done_desc': 'Your terminal is ready. Run `shelly setup` anytime to change these settings.',
'setup.done_start': 'Start Using Shelly',
// Errors
'setup.path_error': 'npm not found in PATH. Bundled tools may not be extracted yet.',
'setup.path_hint': 'Try restarting the app. If the problem persists, check Settings.',
// ConfigTUI
'setup.rerun_label': 'Re-run Setup Wizard',
'setup.rerun_desc': 'Run the initial setup again',
```

- [ ] **Step 2: Add setup.* keys to ja.ts**

```typescript
// ── Interactive Setup (shelly setup) ────────────────────────────────
'setup.welcome_title': 'Shellyへようこそ',
'setup.welcome_desc': 'ターミナルをセットアップしましょう。約2分で完了します。\nどのステップもスキップできます。',
'setup.next': '次へ',
'setup.skip': 'スキップ',
'setup.back': '戻る',
'setup.done': '完了',
'setup.retry': 'リトライ',
'setup.cli_title': 'AIコーディングエージェントをインストール',
'setup.cli_desc': '使いたいツールを選んでください。すべてオプションです。',
'setup.cli_claude': 'Claude Code',
'setup.cli_claude_desc': 'Anthropicのコーディングエージェント',
'setup.cli_gemini': 'Gemini CLI',
'setup.cli_gemini_desc': 'Googleのコーディングエージェント（無料）',
'setup.cli_codex': 'Codex CLI',
'setup.cli_codex_desc': 'OpenAIのコーディングエージェント',
'setup.cli_installing': '{name} をインストール中...',
'setup.cli_installed': '{name} インストール完了',
'setup.cli_already': '{name} は既にインストール済み',
'setup.cli_failed': '{name} のインストールに失敗',
'setup.cli_install_all': '選択したツールをインストール',
'setup.cli_none_selected': 'ツール未選択 — インストールをスキップします。',
'setup.auth_title': 'サインイン',
'setup.auth_desc': 'インストールしたツールの認証を設定します。',
'setup.auth_browser': 'ブラウザでサインイン',
'setup.auth_apikey': 'APIキーを入力',
'setup.auth_skip_tool': 'このツールをスキップ',
'setup.git_title': 'Git設定',
'setup.git_desc': 'コミット用のGit IDを設定します。',
'setup.git_name_prompt': '名前（gitコミット用）',
'setup.git_email_prompt': 'メールアドレス（gitコミット用）',
'setup.git_name_placeholder': '例: 田中太郎',
'setup.git_email_placeholder': '例: taro@example.com',
'setup.git_configured': 'Git設定完了: {name} <{email}>',
'setup.git_already': 'Git設定済み: {name} <{email}>',
'setup.git_ssh_prompt': 'GitHub用のSSH鍵を生成しますか？',
'setup.git_ssh_yes': 'SSH鍵を生成',
'setup.git_ssh_no': 'SSHをスキップ',
'setup.project_title': 'プロジェクトフォルダ',
'setup.project_desc': 'サイドバーに表示するフォルダを選択します。',
'setup.project_scanning': '~/をスキャン中...',
'setup.project_none': 'プロジェクトフォルダが見つかりません。',
'setup.project_register': '選択したフォルダを追加',
'setup.done_title': '準備完了！',
'setup.done_desc': 'ターミナルの準備ができました。`shelly setup` でいつでも設定を変更できます。',
'setup.done_start': 'Shellyを使い始める',
'setup.path_error': 'npmがPATHに見つかりません。バンドルツールがまだ展開されていない可能性があります。',
'setup.path_hint': 'アプリを再起動してみてください。問題が続く場合は設定を確認してください。',
'setup.rerun_label': 'セットアップウィザードを再実行',
'setup.rerun_desc': '初回セットアップをもう一度実行',
```

- [ ] **Step 3: Commit**

```bash
git add lib/i18n/locales/en.ts lib/i18n/locales/ja.ts
git commit -m "feat: add i18n keys for interactive terminal setup (en/ja)"
```

---

### Task 4: Create setup flow orchestrator (`lib/setup-flow.ts`)

**Files:**
- Create: `lib/setup-flow.ts`

- [ ] **Step 1: Create the setup flow orchestrator**

This module manages the setup state machine and emits SetupBlock entries to terminal-store. Key responsibilities:
- Step sequencing (welcome → cli-select → cli-install → cli-auth → git-config → project-scan → done)
- CLI detection/installation via `execCommand`
- Git config check/set via `execCommand`
- Project folder scanning via `execCommand`
- Auth delegation to AuthWizard or direct PTY write
- Completion flag in AsyncStorage

The orchestrator is a class with methods for each step transition. It receives callbacks for adding/updating setup blocks.

Core API:
```typescript
export class SetupFlow {
  constructor(private addBlock: (block: SetupBlock) => void,
              private updateBlock: (id: string, updates: Partial<SetupBlock>) => void);
  
  // Start full wizard or individual steps
  async startFull(): Promise<void>;
  async startCli(): Promise<void>;
  async startGit(): Promise<void>;
  async startProjects(): Promise<void>;
  
  // User interactions (called from SetupBlock button presses)
  async onOptionSelected(blockId: string, optionId: string): Promise<void>;
  async onInputSubmitted(blockId: string, value: string): Promise<void>;
  async onSkip(blockId: string): Promise<void>;
  async onBack(blockId: string): Promise<void>;
  async onAction(blockId: string, action: string): Promise<void>;
}
```

See full implementation in Step 1 code block. The file should be ~300 lines covering all step logic.

- [ ] **Step 2: Commit**

```bash
git add lib/setup-flow.ts
git commit -m "feat: add setup flow orchestrator for shelly setup command"
```

---

### Task 5: Create SetupBlock component

**Files:**
- Create: `components/terminal/SetupBlock.tsx`

- [ ] **Step 1: Create the SetupBlock component**

A React component that renders based on `SetupBlock.stepId` and `status`:
- Title + description text
- Tappable option buttons (Pressable with icon/label/badge)
- Text input field (for git name/email)
- Log lines (monospace, scrollable area for install output)
- Skip / Back / Next action buttons
- Status indicators (checkmark for completed, x for error)

Uses `useTheme()` for colors, `useTranslation()` for labels. No external deps beyond what TerminalBlock already uses.

Props:
```typescript
type Props = {
  block: SetupBlock;
  onOptionToggle: (blockId: string, optionId: string) => void;
  onInputSubmit: (blockId: string, value: string) => void;
  onSkip: (blockId: string) => void;
  onBack: (blockId: string) => void;
  onAction: (blockId: string, action: string) => void;
};
```

- [ ] **Step 2: Commit**

```bash
git add components/terminal/SetupBlock.tsx
git commit -m "feat: add SetupBlock component for inline terminal setup UI"
```

---

### Task 6: Wire `shelly setup` into pseudo-shell

**Files:**
- Modify: `lib/pseudo-shell.ts`

- [ ] **Step 1: Add setup command routing**

In the `case 'shelly':` block, add handling for `sub === 'setup'` before the default fallback. The pseudo-shell creates a SetupFlow instance, starts the appropriate flow, and returns a minimal info line. The actual interactive UI is rendered via SetupBlock entries added by the orchestrator.

```typescript
if (sub === 'setup') {
  const { SetupFlow } = require('@/lib/setup-flow');
  const { useTerminalStore } = require('@/store/terminal-store');
  const store = useTerminalStore.getState();
  const flow = new SetupFlow(
    store.addSetupBlock.bind(store),
    store.updateSetupBlock.bind(store),
  );
  const subCmd = args[1]; // 'cli' | 'git' | 'projects' | undefined
  if (subCmd === 'cli') flow.startCli();
  else if (subCmd === 'git') flow.startGit();
  else if (subCmd === 'projects') flow.startProjects();
  else flow.startFull();
  return { lines: [], newState: {} };
}
```

Also update the help text for `shelly` to include `setup`.

- [ ] **Step 2: Commit**

```bash
git add lib/pseudo-shell.ts
git commit -m "feat: add shelly setup command to pseudo-shell"
```

---

### Task 7: Render SetupBlock in terminal view

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: Find where entries/blocks are rendered and add SetupBlock rendering**

Look for the FlatList/ScrollView that renders `session.entries` or `session.blocks`. Add a condition for `blockType === 'setup'` that renders the `SetupBlock` component, passing down the flow interaction callbacks.

This requires importing `SetupBlock` component and the `SetupFlow` class (or storing the flow instance in a ref).

- [ ] **Step 2: Commit**

```bash
git add app/(tabs)/terminal.tsx
git commit -m "feat: render SetupBlock entries in terminal view"
```

---

### Task 8: Replace WelcomeWizard with auto-run in ShellLayout

**Files:**
- Modify: `components/layout/ShellLayout.tsx`

- [ ] **Step 1: Replace modal wizard with runCommand('shelly setup')**

Change the wizard check from:
```typescript
isWizardComplete().then((done) => {
  if (!done) setShowWizard(true);
  setWizardChecked(true);
});
```

To:
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

AsyncStorage.getItem('@shelly/setup_complete').then((val) => {
  if (val !== 'true') {
    // Delay to let terminal session initialize
    setTimeout(() => {
      useTerminalStore.getState().runCommand('shelly setup');
    }, 500);
  }
});
```

Remove the `WelcomeWizard` rendering (`<WelcomeWizard visible={showWizard} .../>`) but keep the import commented out for now (per instructions: don't delete WelcomeWizard.tsx yet).

Remove `showWizard` / `wizardChecked` state variables.

- [ ] **Step 2: Commit**

```bash
git add components/layout/ShellLayout.tsx
git commit -m "feat: replace modal wizard with auto shelly setup on first launch"
```

---

### Task 9: Add "Re-run Setup" to ConfigTUI

**Files:**
- Modify: `components/config/ConfigTUI.tsx`

- [ ] **Step 1: Add action to SECTIONS array**

In the `Data` section (or create a new section), add:

```typescript
{ key: 'rerunSetup', label: 'Re-run Setup Wizard', type: 'action', source: 'custom', actionLabel: 'Run', description: 'Run initial setup again' },
```

Add handler in `handleAction`:

```typescript
case 'rerunSetup': {
  // Clear completion flag and run setup
  AsyncStorage.removeItem('@shelly/setup_complete').then(() => {
    useTerminalStore.getState().runCommand('shelly setup');
  });
  onClose();
  break;
}
```

- [ ] **Step 2: Commit**

```bash
git add components/config/ConfigTUI.tsx
git commit -m "feat: add re-run setup wizard button to ConfigTUI"
```

---

### Task 10: Integration verification

- [ ] **Step 1: Run TypeScript type check**

```bash
cd ~/Shelly && npx tsc --noEmit 2>&1 | head -50
```

Fix any type errors.

- [ ] **Step 2: Verify no circular imports**

```bash
cd ~/Shelly && grep -r "setup-flow" lib/ components/ store/ --include='*.ts' --include='*.tsx' | head -20
```

- [ ] **Step 3: Final commit with any fixes**

```bash
git add -A && git commit -m "fix: resolve type errors in interactive setup implementation"
```
