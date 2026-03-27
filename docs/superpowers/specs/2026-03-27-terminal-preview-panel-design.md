# Terminal Preview Panel Design Spec

## Overview

Add a Manus-style live preview panel to the terminal tab. Automatically detects `http://localhost:XXXX` URLs in terminal output and offers to display them in a split-view WebView alongside the terminal. Also supports manual preview of static HTML, Markdown, and image files.

### Problem Statement

When developers use CLIs (expo, vite, next, flask, etc.) to build web apps or generate HTML, they have no way to see the output without switching to a separate browser. This breaks the flow — especially on mobile where app switching is disruptive.

### Solution

A split-view preview panel integrated into the terminal tab. Terminal on the left, WebView preview on the right. Automatic localhost URL detection from terminal output triggers a non-intrusive banner offering to open the preview.

### Design Principles

1. **Non-intrusive**: preview is offered, never forced. Banner notification, not auto-open.
2. **Zero configuration**: localhost URLs detected automatically. No setup required.
3. **Responsive**: wide screens get side-by-side split; compact screens get tab switching.
4. **Manus-inspired UX**: split panel with live content, but running entirely on-device (no cloud VM).

---

## Architecture

```
Terminal output (execution-log-store / useTerminalOutput hook)
  ↓
LocalhostDetector (regex URL extraction)
  ↓
preview-store (Zustand)
  ├── previewUrl: string | null
  ├── previewType: 'localhost' | 'file' | null
  ├── isOpen: boolean
  ├── splitRatio: number (0.5 default)
  └── detectedUrls: string[] (history)
  ↓
terminal.tsx split view
  ├── Left: NativeTerminalView (or full width when preview closed)
  └── Right: PreviewPanel (WebView)
```

### Data Flow

```
1. User runs `npx expo start --web` in terminal
2. Terminal outputs "Web is waiting on http://localhost:8081"
3. useTerminalOutput hook feeds output to execution-log-store
4. LocalhostDetector scans new output lines for URL patterns
5. Match found → preview-store.detectedUrls updated, previewUrl set
6. PreviewBanner appears: "Preview available: localhost:8081  [Open]"
7. User taps [Open]
8. preview-store.isOpen = true
9. terminal.tsx renders split view: terminal | PreviewPanel
10. PreviewPanel loads URL in WebView
```

---

## Components

### LocalhostDetector (`lib/localhost-detector.ts`)

Stateless utility that scans terminal output lines for localhost URLs.

```typescript
// ANSI escape codes must be stripped before matching
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

const LOCALHOST_PATTERNS = [
  /https?:\/\/localhost:\d{2,5}\b[^\s)}\]'"]*/,
  /https?:\/\/127\.0\.0\.1:\d{2,5}\b[^\s)}\]'"]*/,
  /https?:\/\/0\.0\.0\.0:\d{2,5}\b[^\s)}\]'"]*/,
  /https?:\/\/\[::\]:\d{2,5}\b[^\s)}\]'"]*/,
];

function detectLocalhostUrl(rawText: string): string | null {
  const text = rawText.replace(ANSI_REGEX, '');
  // match against LOCALHOST_PATTERNS, return first match or null
}
```

- Strips ANSI escape sequences before regex matching (terminal output contains color codes)
- Returns the first matched URL or null
- Normalizes `0.0.0.0` and `[::]` to `localhost`

### Subscription Mechanism

Detection runs **inline inside the `useTerminalOutput` hook**, not as a separate subscriber. This avoids extra re-renders:

```typescript
// In hooks/use-terminal-output.ts — add after addTerminalOutput call:
const url = detectLocalhostUrl(line);
if (url) {
  usePreviewStore.getState().offerPreview(url, 'localhost');
}
```

This is the only integration point. No Zustand selector subscription, no separate useEffect.

### preview-store (`store/preview-store.ts`)

Zustand store for preview state. Not persisted to AsyncStorage (ephemeral per session).

```typescript
interface PreviewState {
  previewUrl: string | null;       // Currently displayed URL
  previewType: 'localhost' | 'file' | null;
  isOpen: boolean;                 // Preview panel visible
  splitRatio: number;              // 0.3 - 0.7, default 0.5
  detectedUrls: string[];         // History of detected URLs (max 10)
  bannerVisible: boolean;         // Show "preview available" banner
  bannerUrl: string | null;       // URL shown in banner

  // Actions
  offerPreview: (url: string, type: 'localhost' | 'file') => void;
  openPreview: (url?: string) => void;
  closePreview: () => void;
  dismissBanner: () => void;
  setSplitRatio: (ratio: number) => void;
  clearDetectedUrls: () => void;
}
```

### PreviewPanel (`components/terminal/PreviewPanel.tsx`)

WebView-based preview with a thin header bar.

**Header:**
- URL display (truncated, monospace)
- Reload button
- Open in external browser button
- Close button (X)

**Body:**
- WebView with the preview URL
- `usesCleartextTraffic` already enabled in app.config.ts (needed for localhost HTTP)
- Pull-to-refresh for manual reload
- Error state: "Cannot connect to {url}" with retry button

**Props:**
```typescript
interface PreviewPanelProps {
  url: string;
  onClose: () => void;
  onReload: () => void;
}
```

### PreviewBanner (`components/terminal/PreviewBanner.tsx`)

Slim notification bar that appears above the terminal when a localhost URL is detected.

**Layout:**
```
[🌐 Preview available: localhost:3000          [Open] [✕]]
```

- Animated slide-in from top
- Auto-dismiss after 10 seconds if not tapped
- Tapping [Open] opens the preview panel
- Tapping [✕] dismisses the banner
- Tapping the URL text copies it to clipboard

### PreviewButton (in TerminalHeader or CommandKeyBar)

A persistent button to manually open preview:
- Shows file picker dialog for HTML/MD/image files
- Or re-opens the last detected localhost URL
- Icon: eye or browser icon

---

## Layout Strategy

### Layout Breakpoint

Split view triggers when `layout.isWide` is true (≥600dp width), regardless of orientation. This differs from the existing `useSplitLayout` (which requires landscape + wide) because the Z Fold6 inner display is ~600dp wide even in portrait — enough for a meaningful side-by-side split. A dedicated `usePreviewLayout` hook or inline check is used instead of the existing `useSplitLayout`.

### Wide Screen (Z Fold6 main display, ≥600dp)

```
┌──────────────────────────────────────────────┐
│ Terminal Header (tabs)                        │
├───────────────────────┬──────────────────────┤
│                       │  Preview Header      │
│  NativeTerminalView   │  [url] [↻] [↗] [✕]  │
│                       │──────────────────────│
│  (50% width)          │  WebView             │
│                       │  (50% width)         │
│                       │                      │
├───────────────────────┴──────────────────────┤
│ CommandKeyBar                                 │
└──────────────────────────────────────────────┘
```

- Drag handle between terminal and preview for resize (splitRatio 0.3-0.7)
- Double-tap drag handle to reset to 50:50

### Compact Screen (<600dp)

```
┌──────────────────────┐
│ [Terminal] [Preview]  │  ← Tab switcher
├──────────────────────┤
│                      │
│  Active tab content  │
│  (full width)        │
│                      │
├──────────────────────┤
│ CommandKeyBar         │
└──────────────────────┘
```

- Two tabs: Terminal and Preview
- When preview is opened on compact, switches to Preview tab
- Terminal continues running in background

---

## Manual Preview (Static Files)

### Preview Button Flow

1. User taps preview button in header/keybar
2. If `detectedUrls` is non-empty: show last URL directly
3. If empty: scan current session's working directory for previewable files
   - Look for: `index.html`, `*.html`, `README.md`, `*.md`
   - Show a quick picker if multiple files found
4. For HTML files: read file content via bridge and pass to WebView as `source={{ html }}` (avoids Android `file://` access restrictions)
5. For Markdown: convert to HTML (simple regex-based, no heavy library) and display
6. For images: display in WebView with `<img>` tag

### File Detection (`lib/preview-file-detector.ts`)

```typescript
async function findPreviewableFiles(cwd: string, runCmd: RunCommand): Promise<PreviewableFile[]>

type PreviewableFile = {
  path: string;
  name: string;
  type: 'html' | 'markdown' | 'image';
}
```

Scans cwd for common previewable files. Uses bridge `runRawCommand` with `find . -maxdepth 2` (shallow scan for speed). Results cached per cwd to avoid repeated scans.

---

## Integration with Existing Features

### Cross-Pane Intelligence

When preview is open in split view alongside terminal:
- Chat tab (in triple-pane on wide screens) can see both terminal output AND the preview URL
- "What's on the preview?" could be answered by taking a WebView screenshot (future enhancement)

### Existing WebPreviewModal

Stays unchanged. It's used by the savepoint/diff system and serves a different purpose (inline HTML preview in chat context). The new PreviewPanel is terminal-specific.

### NativeTerminalView

Preview panel sits next to the NativeTerminalView in the same container. No interaction between them — they're independent views sharing horizontal space.

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `lib/localhost-detector.ts` | URL pattern matching in terminal output |
| `lib/preview-file-detector.ts` | Scan cwd for previewable static files |
| `store/preview-store.ts` | Zustand store for preview state |
| `components/terminal/PreviewPanel.tsx` | WebView preview with header |
| `components/terminal/PreviewBanner.tsx` | "Preview available" notification |

### Modified Files

| File | Changes |
|------|---------|
| `app/(tabs)/terminal.tsx` | Add split view layout with PreviewPanel, integrate PreviewBanner, add preview button |
| `hooks/use-terminal-output.ts` | Add LocalhostDetector call on each output line |

### Unchanged

| File | Reason |
|------|--------|
| `components/WebPreviewModal.tsx` | Used by savepoint system, separate concern |
| `store/terminal-store.ts` | Preview state is in its own store |
| `modules/terminal-view/` | No changes to native module |

---

## Battery & Performance

- WebView is only created when preview is opened (lazy mount)
- Closing preview destroys the WebView (no background rendering)
- No polling — URL detection is event-driven (fires on terminal output)
- Banner auto-dismiss timer uses `setTimeout`, not `setInterval`

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Multiple localhost URLs detected | Banner shows most recent. `detectedUrls` keeps history (max 10). User can pick from list via preview button long-press. |
| Dev server stops | WebView shows connection error. Retry button available. Banner does not reappear until new URL detected. |
| App backgrounded with preview open | WebView pauses rendering (Android default). Resumes on foreground. |
| Z Fold6 fold/unfold with preview open | Layout switches between split (wide) and tabs (compact). Preview URL preserved. |
| No localhost detected, user taps preview button | File picker scans cwd for HTML/MD/image files. If none found, shows "No previewable content found". |
