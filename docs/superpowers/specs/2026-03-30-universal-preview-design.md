# Universal Preview Panel — Design Spec

> Manus-style universal preview: a persistent Preview button in the terminal header opens a tabbed panel that can display any generated artifact — web apps, code, images, documents, data.
>
> Created: 2026-03-30
> Prerequisites: Expo 54 / RN 0.81 / TypeScript / NativeWind / Zustand

---

## 1. Problem Statement

When AI CLIs (Claude Code, Gemini, Codex) generate files, users have no way to see the output without leaving Shelly. Localhost URLs are auto-detected and shown in a WebView, but static files (HTML, images, Markdown, code) require app-switching or manual `cat` commands.

Manus solves this with an always-visible preview panel that shows whatever was just generated. Shelly should do the same.

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Button placement | Terminal header, right side | Always discoverable, Manus-like |
| Button style | Icon (`open_in_new`) + "Preview" label | Clear purpose at a glance |
| Panel structure | 3 tabs: Web / Code / Files | Each tab has a distinct purpose, no ambiguity |
| File formats | 7: HTML, MD, Image, Code, JSON, PDF, CSV | Full coverage of common AI outputs |
| Code detection | git diff + PTY output pattern | Reliable (git) + real-time (PTY) |
| Layout: wide | Split view (terminal \| preview) | Matches existing PreviewPanel behavior |
| Layout: compact | Full screen overlay | No room for split on narrow screens |

## 3. Architecture

```
Preview Button (TerminalHeader)
    ↓ tap
preview-store.openPreview()
    ↓
PreviewTabs container
    ├── Web Tab    → WebView (localhost / HTML file)
    ├── Code Tab   → Syntax-highlighted recent changes
    └── Files Tab  → File tree → tap → multi-format renderer
```

### Data Flow

```
Terminal Output (PTY)
    ↓ useTerminalOutput hook
    ├── localhost URL detected → preview-store.offerPreview(url)
    │   → Web tab auto-navigates (if preview open)
    │   → PreviewBanner (if preview closed)
    ├── file change detected → preview-store.notifyFileChange(path)
    │   → Code tab refreshes
    └── execution-log-store (existing)

Preview Button tap
    ↓ preview-store.openPreview()
    ├── Wide screen → split view in terminal.tsx
    └── Compact → full screen overlay

Files tab → file tap
    ↓ bridge.runRawCommand(`cat <path>`)
    ↓ detectFileType(extension)
    └── route to appropriate renderer
```

## 4. Components

### 4.1 Preview Button (TerminalHeader modification)

Add to `components/terminal/TerminalHeader.tsx`:

```typescript
// Right side of header, before settings
<Pressable onPress={togglePreview} style={styles.previewButton}>
  <MaterialIcons name="open_in_new" size={14} color={previewOpen ? colors.accent : colors.muted} />
  <Text style={styles.previewLabel}>Preview</Text>
</Pressable>
```

- Active state: accent color when preview is open
- Badge dot: show green dot when new content is available (localhost detected or file changed while preview is closed)

### 4.2 PreviewTabs (`components/preview/PreviewTabs.tsx`)

Container component with tab bar and tab content.

```typescript
interface PreviewTabsProps {
  onClose: () => void;
  onEditSubmit?: (prompt: string) => void;
}

type PreviewTabId = 'web' | 'code' | 'files';
```

**Tab Bar:**
- 3 tabs with icons: Web (language), Code (code), Files (folder)
- Active tab: accent underline
- Close button (X) on right
- Compact: full width. Wide: matches panel width.

**Tab switching logic:**
- Default: Web tab if localhost URL available, else Files tab
- Auto-switch to Web when localhost URL detected
- Auto-switch to Code when file change detected (if Code tab was last active)
- User can always manually switch

### 4.3 WebTab (`components/preview/WebTab.tsx`)

Extracted from existing `PreviewPanel.tsx`. Same functionality:
- WebView with URL display
- Reload / Open external buttons
- Click-to-Edit mode (existing)
- Error state with retry
- Loading indicator

When no URL is available: shows placeholder "Start a dev server or open an HTML file to preview here."

### 4.4 CodeTab (`components/preview/CodeTab.tsx`)

Displays the most recently changed file with syntax highlighting.

```typescript
interface CodeTabProps {
  filePath: string | null;
  content: string;
  language: string;
}
```

**File detection (combined approach):**
1. On tab open / refresh: `git diff --name-only HEAD` via bridge → list of changed files
2. On PTY file change detection: immediately push file path to preview-store
3. Display the most recent file from either source

**UI:**
- File path header with language badge
- Line numbers (left gutter, muted color)
- Syntax highlighting (keyword-level: keywords=green, strings=yellow, comments=gray, numbers=magenta)
- Horizontal scroll for long lines
- File switcher: dropdown of all recently changed files

**Syntax highlighting approach:**
Simple regex-based highlighter. No heavy library. Map file extensions to keyword sets:
- `.js/.ts/.tsx` → JavaScript/TypeScript keywords
- `.py` → Python keywords
- `.kt` → Kotlin keywords
- `.css` → CSS properties
- `.json` → JSON structure coloring
- Fallback: plain monospace text

### 4.5 FilesTab (`components/preview/FilesTab.tsx`)

Two-state component: file tree browser → file preview.

**State 1: File Tree**
```typescript
type FileEntry = {
  name: string;
  path: string;       // relative to cwd
  isDirectory: boolean;
  size?: number;
  extension?: string;
};
```

- Scan cwd via bridge: `ls -la` (shallow, max depth 2 for speed)
- Directory icons (folder) vs file icons (by extension)
- Tap directory → expand
- Tap file → switch to preview state
- Breadcrumb navigation at top
- Pull-to-refresh

**State 2: File Preview**
Route to renderer based on extension:

| Extension | Renderer | Implementation |
|-----------|----------|---------------|
| `.html`, `.htm` | WebView | `source={{ html: content }}` |
| `.md`, `.markdown` | Markdown | react-native-markdown-display (existing) |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp` | Image | `<Image>` with pinch-to-zoom (ScrollView) |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.kt`, `.java`, `.css`, `.sh`, `.yml`, `.toml` | Code | Same as CodeTab renderer |
| `.json` | JSON Tree | Collapsible tree (custom component) |
| `.pdf` | PDF Viewer | react-native-pdf or WebView with Google Docs viewer |
| `.csv`, `.tsv` | Table | ScrollView with grid layout |
| Other | Plain text | Monospace text with line numbers |

Back button returns to file tree.

### 4.6 File Renderers (`components/preview/renderers/`)

Each renderer is a standalone component:

```
renderers/
  HtmlRenderer.tsx    — WebView with source={{ html }}
  MarkdownRenderer.tsx — react-native-markdown-display
  ImageRenderer.tsx    — ScrollView + Image with pinch zoom
  CodeRenderer.tsx     — Line numbers + keyword highlighting
  JsonTreeRenderer.tsx — Collapsible tree nodes
  PdfRenderer.tsx      — react-native-pdf or WebView fallback
  CsvTableRenderer.tsx — Horizontal/vertical scroll grid
  PlainTextRenderer.tsx — Monospace fallback
```

## 5. Store Changes

### preview-store.ts (modified)

```typescript
// New fields
interface PreviewState {
  // ... existing fields (previewUrl, isOpen, splitRatio, etc.)

  // New: tab management
  activeTab: PreviewTabId;          // 'web' | 'code' | 'files'
  setActiveTab: (tab: PreviewTabId) => void;

  // New: code tab state
  recentFiles: RecentFile[];        // changed files (max 20)
  activeCodeFile: string | null;    // currently displayed file path
  notifyFileChange: (path: string) => void;
  setActiveCodeFile: (path: string) => void;

  // New: files tab state
  currentDir: string;               // cwd for file browsing
  setCurrentDir: (dir: string) => void;

  // New: notification badge
  hasNewContent: boolean;           // show badge dot on Preview button
  clearNewContent: () => void;
}

type RecentFile = {
  path: string;
  detectedAt: number;
  source: 'git' | 'pty';           // how it was detected
};
```

## 6. Integration Points

### TerminalHeader.tsx
- Add Preview button (right side, before existing buttons)
- Badge dot driven by `preview-store.hasNewContent`

### terminal.tsx
- Replace `<PreviewPanel>` with `<PreviewTabs>` in split/fullscreen positions
- Pass same `onEditSubmit` prop (Click-to-Edit still works via WebTab)

### use-terminal-output.ts
- Enhance FILE_CHANGE_OUTPUT patterns to extract file paths (not just detect change)
- New: `preview-store.notifyFileChange(extractedPath)` on detection
- Existing localhost detection unchanged

### PreviewBanner.tsx
- Unchanged. Still appears when localhost detected and preview is closed.
- Tapping "Open" now opens PreviewTabs with Web tab active.

## 7. Layout

### Wide Screen (≥600dp)

```
┌──────────────────────────────────────────────────┐
│ Terminal Header          [◲ Preview] [⚙]          │
├─────────────────────┬────────────────────────────┤
│                     │ [Web] [Code] [Files]   [✕] │
│  NativeTerminalView │────────────────────────────│
│                     │                            │
│  (splitRatio)       │  Active tab content        │
│                     │                            │
├─────────────────────┴────────────────────────────┤
│ CommandKeyBar                                     │
└──────────────────────────────────────────────────┘
```

### Compact (<600dp)

```
┌──────────────────────┐
│ [Web] [Code] [Files] │
│──────────────────────│
│                      │
│  Active tab content  │
│  (full screen)       │
│                      │
│──────────────────────│
│  [← Back to Terminal]│
└──────────────────────┘
```

## 8. New Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| react-native-pdf | PDF rendering | ~2MB (optional, can use WebView fallback) |

No other new dependencies. All renderers use existing packages (react-native-markdown-display, WebView, Image) or are custom lightweight implementations.

## 9. Files

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `components/preview/PreviewTabs.tsx` | Tab container + switching logic | ~150 |
| `components/preview/WebTab.tsx` | Extracted from PreviewPanel | ~120 |
| `components/preview/CodeTab.tsx` | Recent changes viewer | ~180 |
| `components/preview/FilesTab.tsx` | File tree + router to renderers | ~200 |
| `components/preview/renderers/HtmlRenderer.tsx` | WebView HTML | ~40 |
| `components/preview/renderers/MarkdownRenderer.tsx` | MD render | ~50 |
| `components/preview/renderers/ImageRenderer.tsx` | Pinch zoom image | ~60 |
| `components/preview/renderers/CodeRenderer.tsx` | Syntax HL | ~150 |
| `components/preview/renderers/JsonTreeRenderer.tsx` | Collapsible JSON | ~120 |
| `components/preview/renderers/PdfRenderer.tsx` | PDF view | ~50 |
| `components/preview/renderers/CsvTableRenderer.tsx` | Table grid | ~80 |
| `components/preview/renderers/PlainTextRenderer.tsx` | Fallback | ~30 |
| `lib/preview-file-detector.ts` | cwd scan + file type detection | ~80 |
| `lib/file-renderer.ts` | Extension → renderer mapping | ~40 |
| `lib/syntax-highlight.ts` | Keyword-based highlighting | ~120 |

### Modified Files

| File | Changes |
|------|---------|
| `components/terminal/TerminalHeader.tsx` | Add Preview button |
| `store/preview-store.ts` | Add activeTab, recentFiles, code/files state |
| `hooks/use-terminal-output.ts` | Extract file paths from change patterns |
| `app/(tabs)/terminal.tsx` | Replace PreviewPanel with PreviewTabs |

### Removed/Replaced

| File | Status |
|------|--------|
| `components/terminal/PreviewPanel.tsx` | Content moves to WebTab.tsx. File kept as thin wrapper for backwards compat or deleted. |

## 10. Edge Cases

| Scenario | Behavior |
|----------|----------|
| No content available | Web: placeholder text. Code: "No recent changes". Files: shows cwd tree. |
| File too large (>1MB) | Show first 1000 lines with "truncated" notice |
| Binary file selected | Show file info (size, type) with "Binary file — cannot preview" |
| Bridge disconnected | All tabs show "Connect Termux to enable preview" |
| PDF without react-native-pdf | Fallback to WebView with Google Docs viewer URL |
| Image file in Termux storage | Read via bridge `base64 <path>`, display as data URI |
| cwd changes during browse | Files tab auto-refreshes on cwd change detection |

## 11. Performance

- File tree scan: shallow (`ls -la`, max depth 2), cached per cwd
- File content: read on demand, not pre-loaded
- Code tab: only reads the active file, not all changed files
- Renderers: lazy-mounted (only active tab's renderer exists in tree)
- Images: resized to screen dimensions before display (avoid OOM on large images)
- JSON tree: default collapsed beyond depth 2 (expand on tap)
