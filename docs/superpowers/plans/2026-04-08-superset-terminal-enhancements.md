# Terminal Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Shelly's terminal pane with Fig-style autocomplete, rich input editing, clickable paths/errors, inline content blocks, CLI completion notifications, and a workflow manager — delivering an IDE-grade terminal experience on mobile.

**Architecture:** Six feature groups layered on the existing Command Block + CommandInput system. The autocomplete engine (`lib/autocomplete-engine.ts`) replaces the static `lib/completions.ts` with fuzzy matching, path resolution, and git-aware suggestions, surfaced via a floating `AutocompletePopup`. The rich input enhances `CommandInput.tsx` with syntax highlighting and bracket matching. Clickable paths extend the existing `lib/link-detector.ts` with error pattern detection and a new context menu. Inline content blocks extend `TerminalBlock.tsx` with markdown/JSON/image renderers. CLI notifications use `expo-notifications` + pane header animations. The workflow manager adds `shelly workflow` commands to the pseudo-shell and stores workflows as files via `lib/workflow-manager.ts`.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript, Zustand, react-native-reanimated, expo-notifications, react-native-markdown-display (or existing markdown lib)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `lib/autocomplete-engine.ts` | Fuzzy matching engine: commands, flags, paths, git branches, history |
| `components/terminal/AutocompletePopup.tsx` | Floating popup UI — positioned below cursor, responsive (wide/narrow) |
| `lib/syntax-highlighter.ts` | Shell command tokenizer for syntax coloring in input |
| `components/terminal/RichInputOverlay.tsx` | Syntax-highlighted overlay rendered on top of TextInput |
| `lib/error-pattern-detector.ts` | Detect `file:line:col` error patterns in terminal output |
| `components/terminal/LinkContextMenu.tsx` | Long-press context menu for paths/URLs (copy, open, highlight in sidebar) |
| `components/terminal/MarkdownBlock.tsx` | Inline markdown renderer for command output |
| `components/terminal/JsonTreeBlock.tsx` | Collapsible JSON tree viewer |
| `components/terminal/ImagePreviewBlock.tsx` | Inline image thumbnail for detected image paths/URLs |
| `components/terminal/TableBlock.tsx` | Formatted table display for tabular output |
| `lib/content-block-detector.ts` | Classify output as markdown/json/image/table/plain |
| `lib/cli-notification.ts` | Notification dispatch: in-app pane flash + system notification |
| `lib/workflow-manager.ts` | CRUD for `~/.shelly/workflows/*.sh` files |
| `store/workflow-store.ts` | Zustand store for workflow list, load/save state |

### Modified Files

| File | Change |
|------|--------|
| `lib/completions.ts` | Deprecate — `getCompletions()` delegates to new engine |
| `components/input/AutocompleteDropdown.tsx` | Replace with import of `AutocompletePopup` (backward compat wrapper) |
| `components/input/CommandInput.tsx` | Add syntax highlight overlay, bracket auto-close, multi-line Shift+Enter |
| `lib/link-detector.ts` | Add error pattern regex (`file:line:col`), export `DetectedError` type |
| `components/terminal/TerminalBlock.tsx` | Integrate content block detection, render markdown/JSON/image/table blocks |
| `components/terminal/BlockList.tsx` | Pass `onOpenPath` callback for clickable path navigation |
| `store/terminal-store.ts` | Add `notifyOnComplete` per-session flag, `finishedPaneId` event field |
| `lib/pseudo-shell.ts` | Add `shelly workflow save/run/list/edit/delete` command handlers |
| `store/types.ts` | Add `Workflow` type, extend `CommandBlock` with `contentType` field |
| `components/multi-pane/PaneSlot.tsx` | Add "Done" flash animation on pane header for CLI notification |

---

## Task 1: Autocomplete Engine — Fuzzy Matching Core

**Files:** Create `lib/autocomplete-engine.ts`

- [ ] Create `AutocompleteEngine` class with `getCompletions(input: string, context: AutocompleteContext): CompletionItem[]`
- [ ] Define `AutocompleteContext` type: `{ cwd: string; history: string[]; env: Record<string, string> }`
- [ ] Define `CompletionItem` type: `{ label: string; detail?: string; insertText: string; kind: 'command' | 'flag' | 'path' | 'branch' | 'history'; score: number; icon?: string }`
- [ ] Implement fuzzy match scorer: compare input chars against candidate chars (allow gaps), return 0-100 score
- [ ] Migrate static `TOP_COMMANDS`, `SUBCOMMANDS`, `FLAGS` from `lib/completions.ts` into engine
- [ ] Add history-based completions: search `context.history` with fuzzy match, kind='history'
- [ ] Add path completions: when last token starts with `/`, `./`, `~/`, or after `cd `/`cat `/etc, list directory entries via `useNativeExec` (async)
- [ ] Add git branch completions: when input matches `git checkout|merge|rebase|branch -d` + partial, run `git branch --list` and parse
- [ ] Sort results by score descending, deduplicate, limit to 8
- [ ] Update `lib/completions.ts` `getCompletions()` to delegate to engine (backward compat)

```typescript
// lib/autocomplete-engine.ts — core signature
export type CompletionItem = {
  label: string;
  detail?: string;
  insertText: string;
  kind: 'command' | 'flag' | 'path' | 'branch' | 'history';
  score: number;
  icon?: string; // MaterialIcons name
};

export type AutocompleteContext = {
  cwd: string;
  history: string[];
  env: Record<string, string>;
};

export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      score += (ci === prevMatch + 1) ? 10 : 5; // consecutive bonus
      if (ci === 0 || c[ci - 1] === '/' || c[ci - 1] === '-') score += 3; // word boundary bonus
      prevMatch = ci;
      qi++;
    }
  }
  return qi === q.length ? score : 0; // 0 = no match
}
```

**Commit:** `feat: add autocomplete engine with fuzzy matching`

---

## Task 2: Autocomplete Popup UI — Floating Panel

**Files:** Create `components/terminal/AutocompletePopup.tsx`, Modify `components/input/CommandInput.tsx`

- [ ] Create `AutocompletePopup` component: receives `items: CompletionItem[]`, `onSelect`, `visible`, `isWide: boolean`
- [ ] Wide mode (Z Fold6 unfolded): vertical list, up to 6 items, 240px min width, absolute positioned above input
- [ ] Narrow mode (folded/phone): horizontal chip strip, max 3 items, full-width row above input
- [ ] Each item row: icon (by kind) + label (accent color) + detail (muted) + kind badge
- [ ] Icons: command=`terminal`, flag=`flag`, path=`folder`, branch=`call-split`, history=`history`
- [ ] Animate entrance: `FadeIn.duration(150)` + slide up 8px
- [ ] Tap item to select, dismiss on Esc or input blur
- [ ] In `CommandInput.tsx`: detect screen width via `useWindowDimensions`, pass `isWide` (threshold: 600px)
- [ ] Replace `AutocompleteDropdown` usage in `CommandInput.tsx` with `AutocompletePopup`
- [ ] Wire `AutocompleteEngine.getCompletions()` with current session's cwd + history from terminal-store
- [ ] Add 150ms debounce on input change before querying engine (avoid jank on fast typing)

```typescript
// In CommandInput.tsx — integration point
const { width } = useWindowDimensions();
const isWide = width > 600;
const completions = useAutocomplete(inputText, session.currentDir, session.commandHistory);
// ...
{completions.length > 0 && !isNaturalMode && (
  <AutocompletePopup items={completions} onSelect={handleAutocomplete} isWide={isWide} />
)}
```

**Commit:** `feat: add floating autocomplete popup with responsive layout`

---

## Task 3: Async Path + Git Branch Completions

**Files:** Modify `lib/autocomplete-engine.ts`, Create `hooks/use-autocomplete.ts`

- [ ] Create `hooks/use-autocomplete.ts` hook: wraps engine + async completions
- [ ] Add `getPathCompletions(partialPath: string, cwd: string): Promise<CompletionItem[]>` — calls `execCommand('ls -1 <dir>')`, parses output, returns path items
- [ ] Add `getGitBranchCompletions(partial: string, cwd: string): Promise<CompletionItem[]>` — calls `execCommand('git branch --list --format="%(refname:short)"')`, filters
- [ ] In `use-autocomplete.ts`: combine sync (commands/flags/history) + async (paths/branches) results
- [ ] Async results merge into completion list when they arrive (state update, no flicker)
- [ ] Cache last directory listing for 5 seconds (avoid repeated `ls` calls)
- [ ] Cache git branches for 10 seconds

**Commit:** `feat: add async path and git branch completions`

---

## Task 4: Rich Input — Syntax Highlighting Overlay

**Files:** Create `lib/syntax-highlighter.ts`, Create `components/terminal/RichInputOverlay.tsx`, Modify `components/input/CommandInput.tsx`

- [ ] Create `lib/syntax-highlighter.ts` with `tokenize(input: string): Token[]`
- [ ] Token types: `command` (first word, green), `flag` (starts with -, cyan), `string` (quoted, yellow), `pipe` (`|`, `&&`, `;`, red), `path` (starts with `/` or `./`, blue), `variable` (`$VAR`, magenta), `plain` (default white)
- [ ] Create `RichInputOverlay`: absolutely positioned `<Text>` view over the `TextInput`, pointer-events none
- [ ] Overlay renders colored `<Text>` spans from token array, matching TextInput's font/size/padding exactly
- [ ] TextInput `color` set to `transparent` so overlay text is visible but TextInput remains functional
- [ ] In `CommandInput.tsx`: render `RichInputOverlay` when `!isNaturalMode` and input is non-empty
- [ ] Match `fontFamily: 'monospace'`, `fontSize`, `paddingHorizontal: 10`, `paddingTop: 8` with TextInput

```typescript
// lib/syntax-highlighter.ts
export type Token = { text: string; type: 'command' | 'flag' | 'string' | 'pipe' | 'path' | 'variable' | 'plain' };

export function tokenize(input: string): Token[] {
  // Split by whitespace preserving spaces, classify each token
  const parts = input.match(/\S+|\s+/g) || [];
  let isFirst = true;
  return parts.map(part => {
    if (/^\s+$/.test(part)) return { text: part, type: 'plain' };
    if (isFirst) { isFirst = false; return { text: part, type: 'command' }; }
    if (part.startsWith('-')) return { text: part, type: 'flag' };
    if (/^['"]/.test(part)) return { text: part, type: 'string' };
    if (/^[|;&]{1,2}$/.test(part)) { isFirst = true; return { text: part, type: 'pipe' }; }
    if (part.startsWith('$')) return { text: part, type: 'variable' };
    if (/^[.~\/]/.test(part)) return { text: part, type: 'path' };
    return { text: part, type: 'plain' };
  });
}
```

**Commit:** `feat: add syntax highlighting overlay for shell input`

---

## Task 5: Rich Input — Auto-Close Brackets + Multi-Line

**Files:** Modify `components/input/CommandInput.tsx`

- [ ] Add bracket auto-close: when user types `(`, `[`, `{`, `'`, `"`, auto-insert matching closer and position cursor between
- [ ] Implement via `onChangeText` diff detection: if new char is an opener, append closer, set selection to middle
- [ ] Use `inputRef.current?.setNativeProps({ selection: { start, end } })` for cursor positioning
- [ ] Handle backspace on empty pair: if cursor is between `()`, `[]`, `{}`, `''`, `""`, delete both
- [ ] Multi-line: Enter key sends command (existing), Shift+Enter inserts newline (detect via `onKeyPress` on web, long-press Enter button on mobile)
- [ ] Add a "newline" button (icon: `keyboard-return`) to the ShortcutBar for mobile multi-line entry
- [ ] Increase `maxHeight` from 140 to 200 when multi-line content detected (>1 line)

**Commit:** `feat: add auto-close brackets and multi-line input`

---

## Task 6: Enhanced Link Detector — Error Patterns

**Files:** Modify `lib/link-detector.ts`, Modify `lib/error-pattern-detector.ts` (new)

- [ ] Create `lib/error-pattern-detector.ts` with `detectErrors(text: string): DetectedError[]`
- [ ] `DetectedError` type: `{ text: string; filePath: string; line?: number; col?: number; start: number; end: number }`
- [ ] Patterns to detect:
  - `path/file.ext:123:45` (generic compiler errors)
  - `path/file.ext(123,45)` (MSBuild style)
  - `File "path/file.ext", line 123` (Python tracebacks)
  - `at path/file.ext:123:45` (Node.js stack traces)
  - `ERROR in path/file.ext` (webpack)
- [ ] In `lib/link-detector.ts`: extend `DetectedLink` type with optional `line?: number; col?: number` fields
- [ ] Integrate error patterns into `detectLinks()` — error links get type `'error'` (new union member)
- [ ] Export merged `segmentText()` that includes error segments

```typescript
// lib/error-pattern-detector.ts
const ERROR_PATTERNS = [
  // file:line:col (GCC, TypeScript, ESLint, Rust)
  /(?:^|\s)((?:\/[\w.-]+)+\.\w+):(\d+):(\d+)/gm,
  // Python traceback
  /File "([^"]+)", line (\d+)/gm,
  // Node.js stack trace
  /at\s+.*?\(?((?:\/[\w.-]+)+\.\w+):(\d+):(\d+)\)?/gm,
  // webpack ERROR in
  /ERROR in ((?:\.\/|\/)?[\w./-]+\.\w+)/gm,
];
```

**Commit:** `feat: add error pattern detection for clickable file:line:col`

---

## Task 7: Clickable Paths — Tap Handlers + Context Menu

**Files:** Create `components/terminal/LinkContextMenu.tsx`, Modify `components/terminal/TerminalBlock.tsx`, Modify `components/terminal/BlockList.tsx`

- [ ] Create `LinkContextMenu`: modal popup with options: "Copy Path", "Open in Sidebar", "Open Externally" (for URLs)
- [ ] Style: dark surface, 3 action rows, positioned near touch point
- [ ] In `TerminalBlock.tsx`: update `handleLinkPress` to handle new `'error'` link type
- [ ] For `'error'` type: dispatch `onOpenFile(path, line, col)` callback (opens in sidebar file tree + scrolls to line, or opens in markdown pane)
- [ ] For `'filepath'` type: single tap opens in sidebar, long-press shows `LinkContextMenu`
- [ ] For `'url'` type: single tap opens in browser pane (if exists) or system browser, long-press shows context menu
- [ ] In `BlockList.tsx`: accept and forward `onOpenPath: (path: string, line?: number) => void` prop
- [ ] Render error links with underline + red tint (distinct from URL blue underline)

**Commit:** `feat: add clickable paths with context menu and error navigation`

---

## Task 8: Content Block Detector

**Files:** Create `lib/content-block-detector.ts`, Modify `store/types.ts`

- [ ] Add `contentType` field to `CommandBlock` in `store/types.ts`: `'plain' | 'markdown' | 'json' | 'image' | 'table' | 'diff'`
- [ ] Create `lib/content-block-detector.ts` with `detectContentType(command: string, output: string): ContentType`
- [ ] Detection rules:
  - `json`: output starts with `{` or `[`, valid JSON parse succeeds (try/catch)
  - `markdown`: command is `cat *.md` or output contains `# ` headings + `**bold**` or `- list items`
  - `image`: command output contains image file paths (`.png`, `.jpg`, `.gif`, `.svg`, `.webp`)
  - `table`: output has consistent column-separated lines (2+ lines with same number of `|` or tab characters)
  - `diff`: existing `isDiffOutput()` returns true
  - `plain`: fallback
- [ ] Export `detectContentType` and `ContentType` type

**Commit:** `feat: add content block type detection for terminal output`

---

## Task 9: Inline Content Blocks — Markdown + JSON Renderers

**Files:** Create `components/terminal/MarkdownBlock.tsx`, Create `components/terminal/JsonTreeBlock.tsx`

- [ ] Create `MarkdownBlock.tsx`: renders markdown string using `<Text>` components (no heavy dependency)
  - Headers: `#` → bold + larger font, `##` → bold, `###` → bold + muted
  - Bold: `**text**` → fontWeight 700
  - Code: `` `inline` `` → monospace + background badge, ` ``` ` blocks → dark background + monospace
  - Lists: `- ` → bullet prefix, `1. ` → numbered
  - Links: `[text](url)` → underline + accent color + tappable
- [ ] Create `JsonTreeBlock.tsx`: collapsible JSON tree viewer
  - Parse JSON string, render key-value pairs with indentation
  - Keys: cyan, string values: yellow, numbers: green, booleans: magenta, null: muted
  - Objects/arrays: tap `{...}` or `[...]` to expand/collapse (toggle state)
  - Default: collapsed if >20 keys, expanded if <=20
  - Max depth rendering: 5 levels (deeper shows `...`)

**Commit:** `feat: add markdown and JSON tree inline renderers`

---

## Task 10: Inline Content Blocks — Image Preview + Table

**Files:** Create `components/terminal/ImagePreviewBlock.tsx`, Create `components/terminal/TableBlock.tsx`

- [ ] Create `ImagePreviewBlock.tsx`: detect image paths in output, show thumbnail
  - Parse output lines for file paths ending in image extensions
  - Show `expo-image` `<Image>` with `contentFit="contain"`, max height 200px
  - Tap thumbnail to open full-screen modal preview
  - Handle both local paths (`/path/to/image.png`) and URLs (`https://...`)
  - Show placeholder if file not found
- [ ] Create `TableBlock.tsx`: detect and render tabular output
  - Parse lines with consistent column separators (pipes, tabs, or aligned spaces)
  - Render as horizontal `ScrollView` with column headers (first row) styled bold
  - Alternating row backgrounds for readability
  - Cell text uses monospace font, right-align numbers

**Commit:** `feat: add image preview and table inline content blocks`

---

## Task 11: Integrate Content Blocks into TerminalBlock

**Files:** Modify `components/terminal/TerminalBlock.tsx`

- [ ] Import `detectContentType` from `lib/content-block-detector.ts`
- [ ] Import `MarkdownBlock`, `JsonTreeBlock`, `ImagePreviewBlock`, `TableBlock`
- [ ] In `TerminalBlockComponent`: after block finishes (`!isRunning && exitCode !== null`), compute `contentType`
- [ ] Render output section based on `contentType`:
  - `'markdown'` → `<MarkdownBlock content={outputText} />`
  - `'json'` → `<JsonTreeBlock json={outputText} />`
  - `'image'` → `<ImagePreviewBlock output={block.output} cwd={currentDir} />`
  - `'table'` → `<TableBlock output={block.output} />`
  - `'diff'` → existing `<DiffViewer>` (already implemented)
  - `'plain'` → existing line-by-line rendering (no change)
- [ ] Add collapse/expand toggle for all content block types (tap header bar to fold)
- [ ] Add "View as Plain" toggle button in block header: forces `plain` rendering

**Commit:** `feat: integrate content block renderers into TerminalBlock`

---

## Task 12: CLI Completion Notification — In-App

**Files:** Create `lib/cli-notification.ts`, Modify `components/multi-pane/PaneSlot.tsx`, Modify `store/terminal-store.ts`

- [ ] Create `lib/cli-notification.ts` with `notifyCommandComplete(paneId: string, command: string, exitCode: number, durationMs: number)`
- [ ] In-app notification: dispatch event to pane store — `{ paneId, status: 'done' | 'error', command }`
- [ ] In `PaneSlot.tsx`: subscribe to completion events for non-focused panes
- [ ] Add pane header flash animation: background pulses accent (success) or red (error) 3 times over 1.5s
- [ ] Add "Done" or "Error" badge next to pane title, auto-dismiss after 5s or on focus
- [ ] Play notification sound via `playSound('notification')` (reuse existing sound system)
- [ ] In `terminal-store.ts`: add `notifyThreshold: number` setting (default 5 seconds) — only notify if command duration > threshold
- [ ] Track command start time in block, compute duration in `finalizeBlock`

```typescript
// lib/cli-notification.ts
import { playSound } from '@/lib/sounds';

type CompletionEvent = {
  paneId: string;
  command: string;
  exitCode: number;
  durationMs: number;
};

const listeners = new Set<(event: CompletionEvent) => void>();

export function onCommandComplete(cb: (event: CompletionEvent) => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitCommandComplete(event: CompletionEvent) {
  playSound(event.exitCode === 0 ? 'success' : 'error');
  listeners.forEach(cb => cb(event));
}
```

**Commit:** `feat: add in-app CLI completion notification with pane header flash`

---

## Task 13: CLI Completion Notification — System (Background)

**Files:** Modify `lib/cli-notification.ts`, Modify `app/_layout.tsx`

- [ ] Install `expo-notifications` (if not already: `pnpm add expo-notifications`)
- [ ] In `lib/cli-notification.ts`: add `sendSystemNotification(command: string, exitCode: number)`
- [ ] Use `Notifications.scheduleNotificationAsync` with `trigger: null` (immediate)
- [ ] Title: command (truncated to 60 chars), body: "Completed (exit 0)" or "Failed (exit 1)"
- [ ] Android channel: create `cli-completion` channel with importance DEFAULT
- [ ] In `app/_layout.tsx` or root: request notification permissions on first launch
- [ ] Detect app state via `AppState` from react-native: only send system notification when `appState === 'background'`
- [ ] Add `notifyInBackground: boolean` setting (default true)
- [ ] Register notification channel in app startup

**Commit:** `feat: add system notification for background CLI completion`

---

## Task 14: Workflow Manager — Storage Layer

**Files:** Create `lib/workflow-manager.ts`, Create `store/workflow-store.ts`, Modify `store/types.ts`

- [ ] Add `Workflow` type to `store/types.ts`: `{ id: string; name: string; commands: string[]; description?: string; params?: string[]; createdAt: number; lastRunAt?: number }`
- [ ] Create `lib/workflow-manager.ts`:
  - `saveWorkflow(name: string, commands: string[]): Promise<void>` — writes `~/.shelly/workflows/<name>.sh`
  - `loadWorkflow(name: string): Promise<Workflow>` — reads and parses `.sh` file
  - `listWorkflows(): Promise<Workflow[]>` — lists `~/.shelly/workflows/` directory
  - `deleteWorkflow(name: string): Promise<void>` — removes file
  - `runWorkflow(name: string, args: string[]): string[]` — returns commands with `$1`, `$2` substituted
- [ ] File format: shebang + comment header + commands, one per line
- [ ] Create `store/workflow-store.ts`: Zustand store caching workflow list, `load()`, `refresh()`

```sh
#!/bin/bash
# Shelly Workflow: deploy
# Params: $1=branch
git checkout $1
git pull origin $1
pnpm install
pnpm build
pnpm deploy
```

**Commit:** `feat: add workflow manager storage layer`

---

## Task 15: Workflow Manager — CLI Commands

**Files:** Modify `lib/pseudo-shell.ts`

- [ ] Add `shelly workflow save <name>` handler:
  - Prompt user to select from last N commands in history (show numbered list)
  - Save selected commands as workflow via `workflow-manager.ts`
  - Output: "Saved workflow '<name>' with N commands"
- [ ] Add `shelly workflow run <name> [args...]` handler:
  - Load workflow, substitute params, execute each command sequentially
  - Output each command before running it (echo-style)
- [ ] Add `shelly workflow list` handler:
  - Show table: name, # commands, last run, created date
- [ ] Add `shelly workflow edit <name>` handler:
  - Output workflow contents with line numbers for review
  - Suggest: "Edit with: vim ~/.shelly/workflows/<name>.sh"
- [ ] Add `shelly workflow delete <name>` handler:
  - Delete workflow file, confirm with output message
- [ ] Add `shelly workflow` (no subcommand) handler:
  - Show usage help text

**Commit:** `feat: add shelly workflow CLI commands`

---

## Task 16: Wire Everything Together + Polish

**Files:** Modify `components/input/CommandInput.tsx`, Modify `components/terminal/BlockList.tsx`, Modify `app/index.tsx` (or terminal pane entry)

- [ ] Ensure `AutocompletePopup` respects keyboard-should-persist-taps (tapping popup item doesn't dismiss keyboard)
- [ ] Add `keyboardShouldPersistTaps="always"` to popup's ScrollView/FlatList
- [ ] Verify syntax highlight overlay aligns with TextInput across different font sizes (test fontSize 12, 14, 16)
- [ ] Verify clickable paths work inside collapsible blocks (collapsed state should not break link detection)
- [ ] Add toggle in settings: `shelly config set autocomplete true|false` to disable popup
- [ ] Add toggle in settings: `shelly config set syntax_highlight true|false` to disable overlay
- [ ] Add toggle in settings: `shelly config set inline_blocks true|false` to force plain rendering
- [ ] Test notification flow: run `sleep 10` in pane 2, switch to pane 1, verify header flash + sound on completion
- [ ] Verify system notification appears when app is backgrounded during long command

**Commit:** `feat: wire terminal enhancements and add config toggles`

---

## Dependency Summary

```
Task 1 (engine) ──> Task 2 (popup UI) ──> Task 3 (async completions)
Task 4 (syntax HL) ──> Task 5 (brackets + multiline)
Task 6 (error detector) ──> Task 7 (clickable + context menu)
Task 8 (content detector) ──> Task 9 (markdown + JSON) ──> Task 10 (image + table) ──> Task 11 (integrate)
Task 12 (in-app notify) ──> Task 13 (system notify)
Task 14 (workflow storage) ──> Task 15 (CLI commands)
Task 16 (polish) depends on all above
```

Tasks 1-3, 4-5, 6-7, 8-11, 12-13, 14-15 are independent groups and can be parallelized across agents.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Syntax highlight overlay misaligns with TextInput on different devices | Use exact same font metrics (monospace, same size/padding); test on Z Fold6 both screens |
| Async path completions cause flicker | Debounce 150ms + merge async results into existing list without clearing |
| JSON tree deep nesting causes perf issues | Cap at 5 levels depth, virtualize if >100 nodes |
| expo-notifications permission denied | Graceful degradation: skip system notification, in-app flash still works |
| Workflow `$1` param substitution conflicts with shell | Only substitute `$N` patterns, escape `$$` as literal `$` |
