# Pane Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three stub pane types (AI, Browser, Markdown) with fully functional pane components, add a shared inline input bar, and verify clipboard works across all pane types.

**Architecture:** Each pane type is a self-contained React component registered in `pane-registry.ts`. The AI Pane extracts streaming/dispatch logic from the existing Chat tab (`app/(tabs)/index.tsx`) and `use-ai-dispatch.ts`, reading terminal context via `execution-log-store` snapshots. The Browser Pane wraps `react-native-webview` with a bookmark system and `display:none` lifecycle for background media. All non-terminal panes share a common `PaneInputBar` component at the bottom.

**Tech Stack:** React Native, Zustand, react-native-webview, react-native-markdown-display, NativeTerminalView (JNI), existing `use-ai-dispatch` hook, existing `chat-store`

---

## Task 1: AI Pane Store — per-pane conversation state

**Files:**
- Create: `store/ai-pane-store.ts`

**Steps:**
- [ ] Create Zustand store `useAIPaneStore` with state:
  ```ts
  type AIPaneConversation = {
    paneId: string;
    messages: ChatMessage[];  // reuse type from chat-store
    activeAgent: ChatAgent | null;
    isStreaming: boolean;
    terminalContext: string | null;  // snapshot from focused terminal
  };
  type AIPaneState = {
    conversations: Record<string, AIPaneConversation>;
    getOrCreate: (paneId: string) => AIPaneConversation;
    addMessage: (paneId: string, msg: ChatMessage) => void;
    updateMessage: (paneId: string, msgId: string, updates: Partial<ChatMessage>) => void;
    setStreaming: (paneId: string, streaming: boolean) => void;
    setTerminalContext: (paneId: string, context: string | null) => void;
    clearConversation: (paneId: string) => void;
  };
  ```
- [ ] Persist conversations to AsyncStorage with key `shelly_ai_pane_conversations` (debounced, max 200 messages per pane)
- [ ] Export `ChatMessage` and `ChatAgent` types re-exported from `chat-store` for convenience

**Commit:** `feat(ai-pane): add per-pane conversation store`

---

## Task 2: AI Pane — terminal context injection

**Files:**
- Create: `lib/ai-pane-context.ts`

**Steps:**
- [ ] Create `getTerminalSnapshot(maxLines?: number): string | null` that reads from `execution-log-store.getState()`:
  - Gets `focusedPaneId` from `pane-store`
  - Reads the hot buffer + session buffer for recent output (last 50 lines)
  - Falls back to all sessions if no focused terminal pane
- [ ] Create `buildAIPaneSystemPrompt(terminalContext: string | null, agent: ChatAgent | null): string` that:
  - Injects terminal context as `[Terminal Output]\n...\n[End Terminal Output]`
  - Adds agent-specific system instructions (reuse patterns from `use-ai-dispatch.ts` lines 117-162)
  - Adds project context if available (reuse `loadProjectContext`)
- [ ] Create `formatContextBadge(terminalContext: string | null): string` — returns short label like "Reading Terminal 1" or null

**Commit:** `feat(ai-pane): terminal context injection layer`

---

## Task 3: AI Pane — basic component with message list

**Files:**
- Create: `components/panes/AIPane.tsx`
- Modify: `components/multi-pane/pane-registry.ts`

**Steps:**
- [ ] Create `AIPane` component that receives pane context via `MultiPaneContext`:
  - Uses `useAIPaneStore` to get/create conversation for current pane
  - Renders a FlatList of messages (simplified version of `ChatMessageList`):
    - User messages: right-aligned, themed bubble
    - Assistant messages: left-aligned, monospace, with agent badge
    - System messages: centered, dim
  - Shows context badge in header area: "Reading Terminal 1" (from `formatContextBadge`)
  - Empty state: "Ask anything. I can see your terminal output." centered dim text
- [ ] Get `leafId` from a new `PaneIdContext` (created in PaneSlot, passed down)
- [ ] Update `pane-registry.ts` to point `ai.getComponent` to `AIPane`
- [ ] Add `PaneIdContext` to PaneSlot so pane components can access their leaf ID:
  ```ts
  export const PaneIdContext = createContext<string>('');
  // In PaneSlot render: <PaneIdContext.Provider value={leafId}>
  ```

**Commit:** `feat(ai-pane): basic message list component`

---

## Task 4: AI Pane — streaming dispatch integration

**Files:**
- Create: `hooks/use-ai-pane-dispatch.ts`
- Modify: `components/panes/AIPane.tsx`

**Steps:**
- [ ] Create `useAIPaneDispatch(paneId: string)` hook that wraps core logic from `use-ai-dispatch.ts`:
  - Reuse `orchestrateChatStream` (local LLM), Gemini/Groq/Claude/Codex routing
  - Instead of writing to `chat-store`, writes to `ai-pane-store` via `addMessage`/`updateMessage`
  - Injects terminal context from `getTerminalSnapshot()` into system prompt
  - Reads agent from `pane-store.paneAgents[paneId]` (falls back to 'local')
  - Returns `{ dispatch, cancelStreaming, isStreaming }`
- [ ] Extract shared routing logic from `use-ai-dispatch.ts` into `lib/ai-router.ts`:
  - `toGeminiHistory`, `toOllamaHistory`, `buildFileContext`, `estimateTokens`
  - `mapTargetToAgent`, `filterCliOutput`
  - Both `use-ai-dispatch` and `use-ai-pane-dispatch` import from this shared module
- [ ] Wire `dispatch` to AIPane — user submits text, creates user message, calls dispatch
- [ ] Show streaming indicator (pulsing dot) on assistant message while `isStreaming`

**Commit:** `feat(ai-pane): streaming AI dispatch with terminal context`

---

## Task 5: AI Pane — inline diff preview

**Files:**
- Create: `components/panes/InlineDiff.tsx`
- Modify: `components/panes/AIPane.tsx`

**Steps:**
- [ ] Create `InlineDiff` component that parses diff blocks from AI responses:
  - Detect ````diff` or unified diff format in message content
  - Render green lines (additions) with `#1a3a1a` background, red lines (deletions) with `#3a1a1a` background
  - Line numbers in gutter (dim)
  - "Accept" / "Reject" buttons per hunk (pill buttons, bottom-right of hunk)
  - "Accept All" / "Reject All" in a sticky header when diff is visible
- [ ] Accept action: copy the patched content to clipboard + show toast "Copied — paste in terminal to apply"
- [ ] Reject action: collapse the diff block, show "Rejected" badge
- [ ] Integrate into AIPane message renderer: if message content contains diff blocks, render `InlineDiff` inline

**Commit:** `feat(ai-pane): inline diff preview with accept/reject`

---

## Task 6: AI Pane — agent selector in header

**Files:**
- Modify: `components/multi-pane/PaneSlot.tsx`
- Modify: `components/panes/AIPane.tsx`

**Steps:**
- [ ] In PaneSlot header, when tab is `ai`, show agent selector dropdown next to the title:
  - Small colored dot + agent name (e.g., `● Claude`)
  - Tap opens dropdown with available agents (from `agent-store.ts`)
  - Selecting an agent calls `paneStore.bindAgent(leafId, agentName)`
- [ ] AIPane reads bound agent from `usePaneStore` and passes to dispatch
- [ ] Agent change mid-conversation: insert system message "Switched to {agent}" and continue
- [ ] Agent color dot updates in real-time (already wired via `agentColor` in PaneSlot header)

**Commit:** `feat(ai-pane): agent selector in pane header`

---

## Task 7: Browser Pane — basic WebView with URL bar

**Files:**
- Create: `components/panes/BrowserPane.tsx`
- Modify: `components/multi-pane/pane-registry.ts`

**Steps:**
- [ ] Install `react-native-webview` if not already present: `pnpm add react-native-webview`
- [ ] Create `BrowserPane` component:
  - URL bar at top: `TextInput` with monospace font, submit on Enter
  - Navigation buttons: back (←), forward (→), refresh (↻) — using `webViewRef.goBack()` etc.
  - WebView fills remaining space
  - Default URL: `about:blank` with centered "Enter a URL or pick a bookmark" text
  - Handle `onNavigationStateChange` to update URL bar text
  - Set props: `javaScriptEnabled`, `domStorageEnabled`, `mediaPlaybackRequiresUserAction={false}`, `allowsInlineMediaPlayback`
- [ ] Update `pane-registry.ts` to point `browser.getComponent` to `BrowserPane`

**Commit:** `feat(browser-pane): WebView with URL bar and navigation`

---

## Task 8: Browser Pane — bookmarks bar

**Files:**
- Create: `store/browser-store.ts`
- Modify: `components/panes/BrowserPane.tsx`

**Steps:**
- [ ] Create `useBrowserStore` with Zustand:
  ```ts
  type Bookmark = { label: string; url: string; icon: string };
  type BrowserState = {
    bookmarks: Bookmark[];
    addBookmark: (b: Bookmark) => void;
    removeBookmark: (url: string) => void;
    reorderBookmarks: (from: number, to: number) => void;
  };
  ```
- [ ] Initialize with defaults: YouTube (`youtube.com`), X (`x.com`), GitHub (`github.com`), localhost (`localhost:3000`), plus a `[+]` button to add custom
- [ ] Render bookmarks as horizontal scrollable row below URL bar:
  - Small pill buttons: icon + short label (max 8 chars)
  - Tap: navigate WebView to bookmark URL
  - Long-press: edit/delete bookmark
  - `[+]` at end: adds current URL as bookmark
- [ ] Persist bookmarks to AsyncStorage

**Commit:** `feat(browser-pane): bookmarks bar with defaults`

---

## Task 9: Browser Pane — background media playback

**Files:**
- Modify: `components/panes/BrowserPane.tsx`
- Modify: `components/multi-pane/PaneSlot.tsx`

**Steps:**
- [ ] When pane type switches away from `browser`, do NOT unmount BrowserPane — use `display: 'none'` style:
  - In `PaneSlot`, maintain a `Map<PaneTab, JSX.Element>` of previously rendered pane components
  - Active pane: `display: 'flex'`, inactive panes that are `browser`: `display: 'none'`
  - Other inactive pane types: unmount normally (only browser needs persistence)
- [ ] When switching between bookmark URLs within BrowserPane, use the same WebView:
  - Navigate via `webViewRef.current.injectJavaScript('window.location.href = "..."')`
  - Previous page's audio continues until new page loads (natural WebView behavior)
- [ ] Add `allowsBackForwardNavigationGestures` prop on iOS (no-op on Android but future-proof)
- [ ] Test: open YouTube in browser pane, switch to terminal pane, verify audio continues

**Commit:** `feat(browser-pane): background media playback via display:none lifecycle`

---

## Task 10: Browser Pane — auto-detect dev servers

**Files:**
- Modify: `components/panes/BrowserPane.tsx`
- Modify: `store/browser-store.ts`

**Steps:**
- [ ] Add `detectedServers: string[]` to browser store
- [ ] Subscribe to terminal output via `execution-log-store`:
  - Reuse `detectLocalhostUrl` from `lib/localhost-detector.ts` (already exists)
  - When a localhost URL is detected, add to `detectedServers` (deduplicated)
- [ ] Show detected servers as highlighted bookmarks (green dot badge) in bookmarks bar
- [ ] Tap detected server bookmark: navigate to that URL
- [ ] Auto-clear detected servers that haven't been seen in output for 5 minutes

**Commit:** `feat(browser-pane): auto-detect dev servers from terminal output`

---

## Task 11: Markdown Pane — rendered viewer

**Files:**
- Create: `components/panes/MarkdownPane.tsx`
- Modify: `components/multi-pane/pane-registry.ts`

**Steps:**
- [ ] Install `react-native-markdown-display` if not present: `pnpm add react-native-markdown-display`
- [ ] Create `MarkdownPane` component:
  - State: `content: string`, `filePath: string | null`
  - Empty state: "Open a .md file from the sidebar" (centered, dim)
  - Renders markdown with dark theme styles:
    - Headings: `#00D4AA` accent
    - Code blocks: `#1A1A1A` background, monospace, syntax highlighting via regex-based coloring
    - Links: underlined, tap opens in Browser pane (if exists) or external browser
    - Tables: bordered grid
  - ScrollView with smooth scrolling
- [ ] Add `openFile(path: string)` method exposed via a Zustand store slice or event:
  - Reads file content via `useNativeExec().runCommand('cat ' + path)`
  - Sets content + filePath
- [ ] "Edit" button in top-right: runs `$EDITOR <filePath>` in focused terminal pane (or shows toast if no terminal pane)
- [ ] Update `pane-registry.ts` to point `markdown.getComponent` to `MarkdownPane`

**Commit:** `feat(markdown-pane): rendered markdown viewer with edit button`

---

## Task 12: Markdown Pane — sidebar integration

**Files:**
- Create: `store/markdown-pane-store.ts`
- Modify: `components/panes/MarkdownPane.tsx`

**Steps:**
- [ ] Create `useMarkdownPaneStore`:
  ```ts
  type MarkdownPaneState = {
    /** paneId → { filePath, content, scrollY } */
    panes: Record<string, { filePath: string; content: string; scrollY: number }>;
    openFile: (paneId: string, filePath: string, content: string) => void;
    setScrollY: (paneId: string, y: number) => void;
    clear: (paneId: string) => void;
  };
  ```
- [ ] When sidebar file tree taps a `.md` file:
  - If a Markdown pane exists: call `openFile` on it
  - If no Markdown pane exists: switch the focused pane to `markdown` type, then `openFile`
  - (Sidebar integration is wired in Plan 1 already — just add the handler)
- [ ] MarkdownPane reads from store using `paneId` from `PaneIdContext`
- [ ] Preserve scroll position when switching away and back

**Commit:** `feat(markdown-pane): sidebar file integration with scroll persistence`

---

## Task 13: Shared Inline Input Bar — PaneInputBar component

**Files:**
- Create: `components/panes/PaneInputBar.tsx`
- Modify: `components/panes/AIPane.tsx`
- Modify: `components/panes/BrowserPane.tsx`
- Modify: `components/panes/MarkdownPane.tsx`

**Steps:**
- [ ] Create `PaneInputBar` — a slim input row for all non-terminal panes:
  ```tsx
  type Props = {
    placeholder?: string;
    onSubmit: (text: string) => void;
    leadingIcon?: 'attach' | 'search';
    onAttach?: () => void;
  };
  ```
  - Layout: `[clip icon] [> TextInput] [send arrow]`
  - Height: 36px, monospace font, `#1A1A1A` background, bottom-anchored
  - Clip icon: opens file/image picker (calls `onAttach`)
  - Send arrow: calls `onSubmit` (also Enter key)
  - No mic button in this plan (Plan 4 adds voice)
- [ ] Wire into AIPane: `onSubmit` creates user message + dispatches AI
- [ ] Wire into BrowserPane: `onSubmit` treats text as URL (if starts with http/localhost) or search query (prefix with `https://google.com/search?q=`)
- [ ] Wire into MarkdownPane: `onSubmit` runs as shell command (e.g., `cat <path>`, `grep <term> <path>`)

**Commit:** `feat(panes): shared PaneInputBar with attach button`

---

## Task 14: Clipboard sync — verify cross-pane clipboard

**Files:**
- Create: `lib/__tests__/clipboard-sync.test.ts` (manual test checklist, not automated)
- Modify: `components/panes/BrowserPane.tsx`

**Steps:**
- [ ] Verify `Clipboard` from `@react-native-clipboard/clipboard` (or `expo-clipboard`) works in AI Pane and Markdown Pane (standard RN — should work out of box)
- [ ] For Browser Pane WebView, inject clipboard bridge JavaScript:
  ```ts
  const CLIPBOARD_BRIDGE_JS = `
    document.addEventListener('copy', function(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'clipboard-copy',
        text: window.getSelection().toString()
      }));
    });
    true;
  `;
  ```
- [ ] Handle `onMessage` in BrowserPane: when `clipboard-copy` event received, write to system clipboard via `Clipboard.setString()`
- [ ] For paste into WebView: add a paste button in URL bar that calls `webViewRef.injectJavaScript` to paste from system clipboard
- [ ] Document known limitation: some sites block clipboard access; system clipboard is the source of truth

**Commit:** `feat(clipboard): cross-pane clipboard sync for WebView`

---

## Task 15: Pane registry cleanup and legacy removal

**Files:**
- Modify: `components/multi-pane/pane-registry.ts`
- Modify: `hooks/use-multi-pane.ts`
- Modify: `components/multi-pane/PaneSelector.tsx`

**Steps:**
- [ ] Remove legacy entries from `PANE_REGISTRY`: `index`, `projects`, `settings`
- [ ] Update `PaneTab` type to only include `'terminal' | 'ai' | 'browser' | 'markdown'`
- [ ] Update `PaneSelector` to only show the four valid pane types (it may already filter, verify)
- [ ] Verify SplitMenu in PaneSlot only shows valid pane types (already uses the 4 types, but double-check)

**Commit:** `refactor(pane-registry): remove legacy tab entries, clean up PaneTab type`

---

## Task 16: Integration test — all pane types work end-to-end

**Files:**
- No new files (manual verification)

**Steps:**
- [ ] Build and launch: `npx expo start --dev-client`
- [ ] Open default terminal pane — verify it still works
- [ ] Split pane, select AI — verify message list renders, send a message, verify streaming response
- [ ] Verify AI pane shows "Reading Terminal 1" context badge when terminal has output
- [ ] Split pane, select Browser — verify URL bar, navigate to a URL, test bookmarks
- [ ] Split pane, select Markdown — verify empty state, open a .md file from sidebar
- [ ] Test clipboard: copy text in terminal, paste in AI pane input, paste in browser URL bar
- [ ] Test background media: open YouTube in browser, switch pane type to terminal, verify audio continues
- [ ] Test inline diff: ask AI "show me a diff for..." and verify green/red rendering
- [ ] Verify PaneInputBar appears at bottom of AI/Browser/Markdown panes

**Commit:** (no commit — manual QA checkpoint)

---

## Summary

| # | Task | Files | Est. |
|---|------|-------|------|
| 1 | AI Pane store | 1 new | 3 min |
| 2 | Terminal context injection | 1 new | 3 min |
| 3 | AI Pane basic component | 1 new, 2 mod | 5 min |
| 4 | AI Pane streaming dispatch | 1 new, 1 mod | 5 min |
| 5 | AI Pane inline diff | 1 new, 1 mod | 4 min |
| 6 | AI Pane agent selector | 2 mod | 3 min |
| 7 | Browser Pane basic WebView | 1 new, 1 mod | 4 min |
| 8 | Browser Pane bookmarks | 1 new, 1 mod | 3 min |
| 9 | Browser background media | 2 mod | 4 min |
| 10 | Browser auto-detect servers | 2 mod | 3 min |
| 11 | Markdown Pane viewer | 1 new, 1 mod | 4 min |
| 12 | Markdown sidebar integration | 1 new, 1 mod | 3 min |
| 13 | Shared PaneInputBar | 1 new, 3 mod | 4 min |
| 14 | Clipboard sync | 1 mod | 3 min |
| 15 | Registry cleanup | 3 mod | 2 min |
| 16 | Integration test | 0 | 5 min |

**Total: 16 tasks, ~58 min estimated**

**Dependencies:**
- Tasks 1-2 must complete before Task 3-4
- Task 3 must complete before Tasks 4, 5, 6
- Task 7 must complete before Tasks 8, 9, 10
- Task 11 must complete before Task 12
- Task 13 depends on Tasks 3, 7, 11 (needs all pane components)
- Task 14 depends on Task 7 (needs BrowserPane)
- Task 15 can run any time after Task 3, 7, 11
- Task 16 is last (QA)
