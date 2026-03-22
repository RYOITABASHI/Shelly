# Auto Savepoint + Undo + WebView Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Game-like auto-save, undo buttons, and HTML preview for non-engineers who don't know Git exists.

**Architecture:** Bridge executes git commands. Zustand store tracks savepoint state. ChatBubble gets undo/preview action buttons. Idle timer in index.tsx triggers periodic diff checks. WebView modal renders generated HTML/CSS/JS.

**Tech Stack:** React Native, Zustand, WebView, git CLI via bridge, Animated API

**Spec:** `docs/superpowers/specs/2026-03-22-auto-savepoint-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/auto-savepoint.ts` | Core git operations: init, status, commit, revert, diff |
| Create | `store/savepoint-store.ts` | Zustand store for savepoint state |
| Create | `components/SaveBadge.tsx` | Animated 💾 badge for ChatHeader |
| Create | `components/SavepointBubble.tsx` | Inline undo/view-changes buttons after file-changing operations |
| Create | `components/DiffViewerModal.tsx` | Modal showing git diff with color highlighting |
| Create | `components/WebPreviewModal.tsx` | WebView modal for previewing generated HTML |
| Modify | `components/chat/ChatHeader.tsx` | Integrate SaveBadge |
| Modify | `components/chat/ChatBubble.tsx` | Integrate SavepointBubble + preview button |
| Modify | `hooks/use-ai-dispatch.ts` | Hook savepoint after AI response completion |
| Modify | `app/(tabs)/index.tsx` | Idle timer, pass savepoint props to ChatBubble |
| Modify | `store/chat-store.ts` | Add savepoint fields to ChatMessage type |
| Modify | `lib/i18n/locales/en.ts` | English translations |
| Modify | `lib/i18n/locales/ja.ts` | Japanese translations |

---

### Task 1: Core savepoint library (`lib/auto-savepoint.ts`)

**Files:**
- Create: `lib/auto-savepoint.ts`

- [ ] **Step 1: Create auto-savepoint.ts with git helper functions**

```typescript
// lib/auto-savepoint.ts
/**
 * Auto Savepoint — Git operations for game-like auto-save.
 * Users never see git terminology. All commands run via bridge.
 */

type RunCommandFn = (cmd: string) => Promise<{ stdout: string; exitCode: number }>;

export type SaveResult = {
  commitHash: string;
  message: string;
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
};

const DEFAULT_GITIGNORE = `node_modules/
.expo/
*.log
.env
.env.*
dist/
build/
.DS_Store
`;

/** Check if directory has git repo, init if not */
export async function initGitIfNeeded(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<void> {
  const { exitCode } = await runCommand(`git -C ${projectDir} rev-parse --git-dir`);
  if (exitCode !== 0) {
    // No git repo — initialize
    await runCommand(`git -C ${projectDir} init`);
    // Write default .gitignore if none exists
    const { exitCode: igExists } = await runCommand(`test -f ${projectDir}/.gitignore`);
    if (igExists !== 0) {
      const escaped = DEFAULT_GITIGNORE.replace(/'/g, "'\\''");
      await runCommand(`printf '%s' '${escaped}' > ${projectDir}/.gitignore`);
    }
    await runCommand(`git -C ${projectDir} add -A`);
    await runCommand(`git -C ${projectDir} commit -m "Auto: Initial savepoint" --allow-empty`);
  }
}

/** Check for uncommitted changes and commit if any */
export async function checkAndSave(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<SaveResult | null> {
  // Get status
  const { stdout: status } = await runCommand(`git -C ${projectDir} status --porcelain`);
  if (!status.trim()) return null; // No changes

  // Parse status for commit message
  const message = generateCommitMessage(status);

  // Stage and commit
  await runCommand(`git -C ${projectDir} add -A`);
  const { exitCode } = await runCommand(
    `git -C ${projectDir} commit -m "${message.replace(/"/g, '\\"')}"`,
  );
  if (exitCode !== 0) return null;

  // Get commit hash
  const { stdout: hash } = await runCommand(`git -C ${projectDir} rev-parse --short HEAD`);

  // Count changes
  const lines = status.trim().split('\n').filter(Boolean);
  const created = lines.filter((l) => l.startsWith('?') || l.startsWith('A')).length;
  const deleted = lines.filter((l) => l.startsWith('D')).length;
  const modified = lines.length - created - deleted;

  return {
    commitHash: hash.trim(),
    message,
    filesChanged: modified,
    filesCreated: created,
    filesDeleted: deleted,
  };
}

/** Generate human-readable commit message from git status --porcelain */
export function generateCommitMessage(status: string): string {
  const lines = status.trim().split('\n').filter(Boolean);
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of lines) {
    const code = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    const name = file.split('/').pop() ?? file;
    if (code === '??' || code === 'A') created.push(name);
    else if (code === 'D') deleted.push(name);
    else modified.push(name);
  }

  if (created.length && !modified.length && !deleted.length) {
    return created.length === 1
      ? `Auto: Created ${created[0]}`
      : `Auto: Created ${created.length} files`;
  }
  if (modified.length && !created.length && !deleted.length) {
    return modified.length === 1
      ? `Auto: Updated ${modified[0]}`
      : `Auto: Updated ${modified.length} files`;
  }
  if (deleted.length && !created.length && !modified.length) {
    return deleted.length === 1
      ? `Auto: Removed ${deleted[0]}`
      : `Auto: Removed ${deleted.length} files`;
  }

  const parts: string[] = [];
  if (modified.length) parts.push(`modified ${modified.length}`);
  if (created.length) parts.push(`created ${created.length}`);
  if (deleted.length) parts.push(`removed ${deleted.length}`);
  return `Auto: ${parts.join(', ')} files`;
}

/** Revert the last commit */
export async function revertLastSavepoint(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<boolean> {
  const { exitCode } = await runCommand(`git -C ${projectDir} revert HEAD --no-edit`);
  if (exitCode !== 0) {
    // Revert failed — abort and return false
    await runCommand(`git -C ${projectDir} revert --abort`);
    return false;
  }
  return true;
}

/** Get diff of last commit for "view changes" */
export async function getLastDiff(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<string> {
  const { stdout } = await runCommand(`git -C ${projectDir} diff HEAD~1 HEAD`);
  return stdout;
}

/** Detect if a command likely modifies files */
export function isFileChangingCommand(command: string): boolean {
  const cmd = command.trim().split(/\s+/)[0];
  const changingCommands = [
    'npm', 'npx', 'pnpm', 'yarn', 'bun',
    'touch', 'mkdir', 'cp', 'mv', 'rm',
    'cat', 'echo', 'printf', // when used with > or >>
    'sed', 'awk',
    'vi', 'vim', 'nano', 'code',
    'pip', 'pip3', 'python', 'node',
    'make', 'cmake', 'cargo', 'go',
    'wget', 'curl', // downloads
    'tar', 'unzip', 'gzip',
    'chmod', 'chown',
    'git', // git operations
  ];
  // Also check for redirects
  if (command.includes('>') || command.includes('>>')) return true;
  return changingCommands.includes(cmd);
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/auto-savepoint.ts
git commit -m "feat: add auto-savepoint core library (git init/commit/revert/diff)"
```

---

### Task 2: Savepoint store (`store/savepoint-store.ts`)

**Files:**
- Create: `store/savepoint-store.ts`

- [ ] **Step 1: Create zustand store**

```typescript
// store/savepoint-store.ts
import { create } from 'zustand';

export type SavepointInfo = {
  commitHash: string;
  message: string;
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
  reverted: boolean;
  timestamp: number;
};

type SavepointState = {
  isEnabled: boolean;
  isSaving: boolean;
  showBadge: boolean;
  lastSaveTime: number | null;

  // Per-message savepoint info (messageId -> info)
  messageSavepoints: Record<string, SavepointInfo>;

  // Actions
  setEnabled: (enabled: boolean) => void;
  setSaving: (saving: boolean) => void;
  flashBadge: () => void;
  recordSavepoint: (messageId: string, info: Omit<SavepointInfo, 'reverted' | 'timestamp'>) => void;
  markReverted: (messageId: string) => void;
};

export const useSavepointStore = create<SavepointState>((set, get) => ({
  isEnabled: true,
  isSaving: false,
  showBadge: false,
  lastSaveTime: null,
  messageSavepoints: {},

  setEnabled: (enabled) => set({ isEnabled: enabled }),

  setSaving: (saving) => set({ isSaving: saving }),

  flashBadge: () => {
    set({ showBadge: true, lastSaveTime: Date.now() });
    setTimeout(() => set({ showBadge: false }), 2000);
  },

  recordSavepoint: (messageId, info) =>
    set((state) => ({
      messageSavepoints: {
        ...state.messageSavepoints,
        [messageId]: { ...info, reverted: false, timestamp: Date.now() },
      },
    })),

  markReverted: (messageId) =>
    set((state) => {
      const existing = state.messageSavepoints[messageId];
      if (!existing) return state;
      return {
        messageSavepoints: {
          ...state.messageSavepoints,
          [messageId]: { ...existing, reverted: true },
        },
      };
    }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add store/savepoint-store.ts
git commit -m "feat: add savepoint zustand store"
```

---

### Task 3: SaveBadge component (`components/SaveBadge.tsx`)

**Files:**
- Create: `components/SaveBadge.tsx`
- Modify: `components/chat/ChatHeader.tsx`

- [ ] **Step 1: Create SaveBadge with fade animation**

```typescript
// components/SaveBadge.tsx
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useSavepointStore } from '@/store/savepoint-store';

export function SaveBadge() {
  const showBadge = useSavepointStore((s) => s.showBadge);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showBadge) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1600),
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [showBadge]);

  return (
    <Animated.Text style={[styles.badge, { opacity }]}>
      💾
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    fontSize: 14,
    marginLeft: 6,
  },
});
```

- [ ] **Step 2: Add SaveBadge to ChatHeader**

In `components/chat/ChatHeader.tsx`, add after the status dot:

```typescript
import { SaveBadge } from '@/components/SaveBadge';

// In the left section, after statusDot:
<SaveBadge />
```

- [ ] **Step 3: Commit**

```bash
git add components/SaveBadge.tsx components/chat/ChatHeader.tsx
git commit -m "feat: add save badge with fade animation in ChatHeader"
```

---

### Task 4: DiffViewerModal (`components/DiffViewerModal.tsx`)

**Files:**
- Create: `components/DiffViewerModal.tsx`

- [ ] **Step 1: Create diff viewer modal**

```typescript
// components/DiffViewerModal.tsx
import React from 'react';
import {
  Modal, View, Text, ScrollView, Pressable, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  diff: string;
  onClose: () => void;
};

export function DiffViewerModal({ visible, diff, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const lines = diff.split('\n');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: insets.top }]}>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('savepoint.view_changes')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={colors.inactive} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll}>
            {lines.map((line, i) => {
              let bg = 'transparent';
              let fg = colors.foreground;
              if (line.startsWith('+') && !line.startsWith('+++')) {
                bg = '#00440020';
                fg = '#4ADE80';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                bg = '#44000020';
                fg = '#F87171';
              } else if (line.startsWith('@@')) {
                fg = '#60A5FA';
              } else if (line.startsWith('diff ')) {
                fg = colors.accent;
              }
              return (
                <Text
                  key={i}
                  style={[styles.line, { color: fg, backgroundColor: bg }]}
                >
                  {line}
                </Text>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#00000088',
  },
  container: {
    flex: 1,
    marginTop: 40,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
    padding: 12,
  },
  line: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 4,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/DiffViewerModal.tsx
git commit -m "feat: add diff viewer modal with syntax highlighting"
```

---

### Task 5: SavepointBubble (`components/SavepointBubble.tsx`)

**Files:**
- Create: `components/SavepointBubble.tsx`

- [ ] **Step 1: Create savepoint bubble with undo/view buttons**

```typescript
// components/SavepointBubble.tsx
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';
import { useSavepointStore, type SavepointInfo } from '@/store/savepoint-store';
import { revertLastSavepoint, getLastDiff } from '@/lib/auto-savepoint';
import { DiffViewerModal } from './DiffViewerModal';

type Props = {
  messageId: string;
  projectDir: string;
  runCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
};

export function SavepointBubble({ messageId, projectDir, runCommand }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const info = useSavepointStore((s) => s.messageSavepoints[messageId]);
  const markReverted = useSavepointStore((s) => s.markReverted);
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffContent, setDiffContent] = useState('');
  const [reverting, setReverting] = useState(false);

  if (!info) return null;

  const totalFiles = info.filesChanged + info.filesCreated + info.filesDeleted;

  const handleUndo = useCallback(async () => {
    if (info.reverted || reverting) return;
    setReverting(true);
    const success = await revertLastSavepoint(projectDir, runCommand);
    setReverting(false);
    if (success) {
      markReverted(messageId);
    } else {
      Alert.alert('', t('savepoint.revert_failed'));
    }
  }, [info.reverted, reverting, projectDir, runCommand, messageId, markReverted, t]);

  const handleViewDiff = useCallback(async () => {
    const diff = await getLastDiff(projectDir, runCommand);
    setDiffContent(diff);
    setDiffVisible(true);
  }, [projectDir, runCommand]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <MaterialIcons name="folder" size={14} color={colors.inactive} />
        <Text style={[styles.text, { color: colors.inactive }]}>
          {t('savepoint.files_changed', { count: totalFiles })}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, info.reverted && styles.btnDisabled]}
          onPress={handleUndo}
          disabled={info.reverted || reverting}
        >
          <Text style={[styles.btnText, { color: info.reverted ? '#666' : '#F87171' }]}>
            {info.reverted ? t('savepoint.reverted') : t('savepoint.undo')}
          </Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={handleViewDiff}>
          <Text style={[styles.btnText, { color: colors.accent }]}>
            {t('savepoint.view_changes')}
          </Text>
        </Pressable>
      </View>

      <DiffViewerModal
        visible={diffVisible}
        diff={diffContent}
        onClose={() => setDiffVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  text: {
    fontFamily: 'monospace',
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#333',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/SavepointBubble.tsx
git commit -m "feat: add savepoint bubble with undo and view-changes buttons"
```

---

### Task 6: WebPreviewModal (`components/WebPreviewModal.tsx`)

**Files:**
- Create: `components/WebPreviewModal.tsx`

- [ ] **Step 1: Create WebView preview modal**

```typescript
// components/WebPreviewModal.tsx
import React from 'react';
import { Modal, View, Pressable, StyleSheet, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  html: string;
  onClose: () => void;
};

export function WebPreviewModal({ visible, html, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: insets.top }]}>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('preview.title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={colors.inactive} />
            </Pressable>
          </View>
          <WebView
            source={{ html }}
            style={styles.webview}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            scrollEnabled
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#00000088',
  },
  container: {
    flex: 1,
    marginTop: 40,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  webview: {
    flex: 1,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/WebPreviewModal.tsx
git commit -m "feat: add WebView preview modal for generated HTML"
```

---

### Task 7: Integration — wire up triggers and UI

**Files:**
- Modify: `hooks/use-ai-dispatch.ts` — add savepoint trigger after AI completion
- Modify: `app/(tabs)/index.tsx` — idle timer, pass savepoint props, preview detection
- Modify: `components/chat/ChatBubble.tsx` — render SavepointBubble and preview button
- Modify: `lib/i18n/locales/en.ts` — translations
- Modify: `lib/i18n/locales/ja.ts` — translations

- [ ] **Step 1: Add i18n keys**

Add to both `en.ts` and `ja.ts`:

```typescript
// en.ts
'savepoint.files_changed': '{{count}} file(s) changed',
'savepoint.undo': 'Undo',
'savepoint.reverted': 'Undone',
'savepoint.view_changes': 'View changes',
'savepoint.revert_failed': 'Could not undo the changes.',
'preview.title': 'Preview',
'preview.open': 'Preview',

// ja.ts
'savepoint.files_changed': '{{count}}個のファイルを変更しました',
'savepoint.undo': '元に戻す',
'savepoint.reverted': '元に戻しました',
'savepoint.view_changes': '変更を見る',
'savepoint.revert_failed': '元に戻せませんでした。',
'preview.title': 'プレビュー',
'preview.open': 'プレビューを見る',
```

- [ ] **Step 2: Add savepoint trigger to use-ai-dispatch.ts**

At each AI response completion point (the `if (done)` blocks), add:

```typescript
import { checkAndSave, initGitIfNeeded } from '@/lib/auto-savepoint';
import { useSavepointStore } from '@/store/savepoint-store';

// In each `if (done)` block, after updateMessage:
const projectDir = useTerminalStore.getState().currentDir;
if (projectDir && useSavepointStore.getState().isEnabled) {
  const exec = async (cmd: string) => {
    const result = await bridgeRunCommand(cmd);
    return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
  };
  await initGitIfNeeded(projectDir, exec);
  const saveResult = await checkAndSave(projectDir, exec);
  if (saveResult) {
    useSavepointStore.getState().recordSavepoint(msgId, saveResult);
    useSavepointStore.getState().flashBadge();
  }
}
```

- [ ] **Step 3: Add idle timer and preview detection to index.tsx**

In `app/(tabs)/index.tsx`:

```typescript
import { checkAndSave, initGitIfNeeded, isFileChangingCommand } from '@/lib/auto-savepoint';
import { useSavepointStore } from '@/store/savepoint-store';
import { WebPreviewModal } from '@/components/WebPreviewModal';

// Idle timer ref
const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const [previewHtml, setPreviewHtml] = useState('');
const [previewVisible, setPreviewVisible] = useState(false);

// Reset idle timer on each command
const resetIdleTimer = useCallback(() => {
  if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  idleTimerRef.current = setTimeout(async () => {
    const projectDir = currentDir;
    if (!projectDir || !useSavepointStore.getState().isEnabled) return;
    if (!isBridgeConnected) return;
    const exec = async (cmd: string) => {
      const result = await bridgeRunCommand(cmd);
      return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
    };
    await initGitIfNeeded(projectDir, exec);
    const saveResult = await checkAndSave(projectDir, exec);
    if (saveResult) {
      useSavepointStore.getState().flashBadge();
      // No chat bubble for idle saves — just badge
    }
  }, 30000);
}, [currentDir, isBridgeConnected]);
```

- [ ] **Step 4: Add SavepointBubble to ChatBubble**

In `components/chat/ChatBubble.tsx`:

```typescript
import { SavepointBubble } from '@/components/SavepointBubble';
import { useSavepointStore } from '@/store/savepoint-store';

// After the message content, inside assistant bubble:
const savepointInfo = useSavepointStore((s) => s.messageSavepoints[message.id]);

// Render after executions:
{savepointInfo && (
  <SavepointBubble
    messageId={message.id}
    projectDir={projectDir}
    runCommand={runCommand}
  />
)}
```

- [ ] **Step 5: Add preview button for HTML content**

In `ChatBubble.tsx`, detect HTML in assistant responses and add preview button:

```typescript
import { WebPreviewModal } from '@/components/WebPreviewModal';

// Detect HTML in message content
const htmlMatch = message.content?.match(/```html\n([\s\S]*?)```/);
const [showPreview, setShowPreview] = useState(false);

// After message text, before SavepointBubble:
{htmlMatch && (
  <>
    <Pressable style={styles.previewBtn} onPress={() => setShowPreview(true)}>
      <MaterialIcons name="visibility" size={14} color={colors.accent} />
      <Text style={[styles.previewBtnText, { color: colors.accent }]}>
        {t('preview.open')}
      </Text>
    </Pressable>
    <WebPreviewModal
      visible={showPreview}
      html={htmlMatch[1]}
      onClose={() => setShowPreview(false)}
    />
  </>
)}
```

- [ ] **Step 6: Commit**

```bash
git add lib/i18n/locales/en.ts lib/i18n/locales/ja.ts \
  hooks/use-ai-dispatch.ts app/(tabs)/index.tsx \
  components/chat/ChatBubble.tsx
git commit -m "feat: wire up auto-savepoint triggers, undo UI, and HTML preview"
```

---

### Task 8: Command completion savepoint trigger

**Files:**
- Modify: `app/(tabs)/index.tsx` — hook into command completion

- [ ] **Step 1: Add savepoint check after file-changing commands**

In the `handleSend` flow or via a `useEffect` that watches for block finalization:

```typescript
// After a command block finalizes with exit code 0,
// check if it was a file-changing command
useEffect(() => {
  // Find the most recently finalized block
  const session = terminalSessions.find(s => s.id === activeSessionId);
  if (!session) return;
  const lastBlock = session.blocks[session.blocks.length - 1];
  if (!lastBlock || lastBlock.isRunning || lastBlock.exitCode !== 0) return;

  if (isFileChangingCommand(lastBlock.command)) {
    resetIdleTimer(); // Reset idle timer
    // Trigger savepoint
    const doSave = async () => {
      const projectDir = currentDir;
      if (!projectDir || !useSavepointStore.getState().isEnabled) return;
      const exec = async (cmd: string) => {
        const result = await bridgeRunCommand(cmd);
        return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
      };
      await initGitIfNeeded(projectDir, exec);
      const saveResult = await checkAndSave(projectDir, exec);
      if (saveResult) {
        useSavepointStore.getState().flashBadge();
      }
    };
    doSave();
  }
}, [/* block finalization dependency */]);
```

- [ ] **Step 2: Commit**

```bash
git add app/(tabs)/index.tsx
git commit -m "feat: trigger savepoint after file-changing commands"
```
