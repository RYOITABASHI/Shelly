# Shelly UI Overhaul — Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Shelly's UI with the 5 mock screenshots (`docs/images/mock-{1-5}.jpg`) — fixing visual density, typography, color consistency, and missing UI elements while preserving all existing functionality.

**Architecture:** Pure visual/style changes to existing components. No new stores, no logic changes. Each task modifies one component's JSX structure and StyleSheet to match the mock. Use `useTheme()` colors where theme tokens exist; fall back to hardcoded hex values where the codebase already does so (match existing file patterns).

**Tech Stack:** React Native 0.81, NativeWind (TailwindCSS 3), StyleSheet.create, Zustand stores (read-only), react-native-reanimated v4, @expo/vector-icons/MaterialIcons

**Reference Mocks (READ THESE FIRST):**
- `docs/images/mock-1-full-layout.jpg` — 1+2 Split: full layout with all UI elements visible
- `docs/images/mock-2.jpg` — 2 Col layout
- `docs/images/mock-3.jpg` — 2 Row layout
- `docs/images/mock-4.jpg` — Single pane layout
- `docs/images/mock-5.jpg` — 4 Terminal layout

**Design Constants (from Step 2 extraction):**
- Background: `#0A0A0A` / Sidebar: `#0D0D0D` / Pane header: `#111111`
- Border: `#1A1A1A` / Text: `#E5E7EB` / Muted: `#6B7280`
- Accent: `#00D4AA` / Claude: `#D4A574` / Gemini: `#4285F4`
- AgentBar height: 32px / Pane header: 28px / ContextBar: 24px / LayoutPresetBar: 34px
- Sidebar expanded: 240px / icons: 48px
- Font: monospace everywhere / Headers: 10px weight 700 / Status: 8-9px weight 600-800

---

## File Structure

### Files to Modify
| File | Responsibility | Task |
|------|---------------|------|
| `components/layout/AgentBar.tsx` (414 lines) | Top bar with agent tabs + CRT/lang controls | Task 1 |
| `components/layout/Sidebar.tsx` (626 lines) | Left sidebar with 7 accordion sections | Task 2 |
| `components/layout/SidebarSection.tsx` (125 lines) | Accordion section wrapper | Task 2 |
| `components/layout/FileTree.tsx` (185 lines) | File tree browser inside sidebar | Task 2 |
| `components/multi-pane/PaneSlot.tsx` (603 lines) | Pane wrapper with header + content | Task 3 |
| `components/terminal/TerminalHeader.tsx` (372 lines) | Terminal-specific header bar (mode, tabs, usage) | Task 3 |
| `components/multi-pane/LayoutPresetBar.tsx` (189 lines) | Bottom layout preset buttons | Task 4 |
| `components/layout/ShellLayout.tsx` (183 lines) | Root layout — LayoutPresetBar always visible | Task 4 |
| `components/terminal/TerminalBlock.tsx` (1226 lines) | CLI command output rendering | Task 5 |
| `components/panes/AIPane.tsx` (419 lines) | AI chat pane with messages | Task 6 |
| `components/panes/BrowserPane.tsx` (323 lines) | Browser pane with bookmarks | Task 7 |
| `components/panes/InlineDiff.tsx` (538 lines) | Inline diff rendering in AI messages | Task 6 |

### No New Files Needed
All work is modifications to existing components. The LayoutPresetBar, CRT controls, and language toggle already exist.

### Excluded Files (reviewed, no changes needed)
- `lib/content-block-detector.ts` (41 lines) — Pure detection logic, no visual output. Style changes go in TerminalBlock.tsx which consumes its results.
- `lib/i18n/locales/en.ts` / `ja.ts` — No new i18n keys needed since all UI labels already exist. These are pure style changes.

---

## Task 1: AgentBar — Tab Style + Right-Side Controls

**Files:**
- Modify: `components/layout/AgentBar.tsx`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/ja.ts`

**Mock Reference:** All 5 mocks show the AgentBar at top. Key elements:
- Left: `● CLAUDE  ● Gemini  ● Codex  ● OpenCode  ● Copilot  +`
- Right: `CRT:ON  ●———  11%  EN/JA`
- Active tab has green dot + white text, inactive has gray dot + gray text
- Height: 32px, bg: `#0D0D0D`, border-bottom: 1px `#1A1A1A`

**Current State:** AgentBar.tsx already has agent tabs, CRT controls (CrtControls sub-component), and language toggle (LangToggle sub-component). The issue is styling — spacing, font sizes, and visual density don't match the mock.

- [ ] **Step 1: Read the current AgentBar.tsx fully**

Read `components/layout/AgentBar.tsx` to understand all sub-components and styles.

- [ ] **Step 2: Fix agent tab styling to match mock**

Update the `styles` StyleSheet in AgentBar.tsx:
- `bar`: height 32, backgroundColor `#0D0D0D`, borderBottomWidth 1, borderBottomColor `#1A1A1A`, flexDirection 'row', alignItems 'center', paddingHorizontal 8
- `agentTab`: paddingHorizontal 10, paddingVertical 4, flexDirection 'row', alignItems 'center', gap 5, borderRadius 3
- `agentTabActive`: backgroundColor `rgba(0,212,170,0.08)`, borderWidth 1, borderColor `rgba(0,212,170,0.2)`
- `agentText`: fontSize 10, fontFamily 'monospace', fontWeight '700', letterSpacing 0.8, textTransform 'uppercase'
- `statusDot`: width 6, height 6, borderRadius 3

- [ ] **Step 3: Ensure CRT controls and LangToggle render inline in the right section**

In the JSX, verify the right side shows: CRT badge → slider → percentage → separator → EN/JA toggle. The sub-components `CrtControls()` and `LangToggle()` should be adjacent in `styles.rightBtns` with `flexDirection: 'row', alignItems: 'center', gap: 8`.

- [ ] **Step 4: Fix right-side control sizing**

Update right-side styles:
- CRT badge: fontSize 8, fontWeight '800', letterSpacing 0.5
- Slider: width 50, height 2 (thin bar)
- Percentage text: fontSize 8, color `#6B7280`
- EN/JA text: fontSize 9, fontWeight '700'

- [ ] **Step 5: Visual verification**

Run the app and compare AgentBar against mock-1-full-layout.jpg. Verify:
- Tab text is uppercase monospace
- Active tab has green dot + white text
- CRT:ON badge + slider + percentage visible on right
- EN/JA toggle visible on far right
- Total height is compact (32px)

- [ ] **Step 6: Commit**

```bash
git add components/layout/AgentBar.tsx
git commit -m "style(AgentBar): match mock — compact tabs, CRT+lang controls right-aligned"
```

---

## Task 2: Sidebar — Expanded Design with All 7 Sections

**Files:**
- Modify: `components/layout/Sidebar.tsx`
- Modify: `components/layout/SidebarSection.tsx`
- Modify: `components/layout/FileTree.tsx`

**Mock Reference (mock-1):** Sidebar is expanded showing all 7 sections:
- TASKS: `NPM RUN DEV` with red `RUNNING` badge, `GIT PUSH` with `25 AGO`
- REPOSITORIES: `SHELLY v9.2` (green highlight), `NACRE`, `LLM-BENCH-V2`, `+ ADD REPOSITORY`
- FILE TREE: Search bar + full tree (app/, components/, chat/, terminal/, welcomewizard.tsx, lib/, input-router.ts, store/, app.config.ts, package.json, README.md)
- DEVICE: ~/ DCIM DOWNLOAD DOCUMENTS MUSIC (with icons)
- CLOUD: GOOGLE DRIVE `LINKED`, DROPBOX `CONNECT`, ONEDRIVE `CONNECT`
- PORTS: `:3000 NEXT.JS ●`, `:8081 EXPO ●` (with external link icons)
- PROFILES: `PROD-SERVER`, `STAGING`, `+ ADD PROFILE`

**Current State:** Sidebar.tsx has all 7 sections with correct data. The issue is visual polish — section header styling, row density, badge colors, and typography need to match the mock's "pro IDE" look.

- [ ] **Step 1: Read current Sidebar.tsx, SidebarSection.tsx, FileTree.tsx fully**

Read all three files completely to understand every style and JSX element.

- [ ] **Step 2: Update SidebarSection.tsx header and body styles**

```typescript
// In SidebarSection.tsx styles:
header: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 12,
  paddingVertical: 6,
  gap: 6,
},
title: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '700',
  letterSpacing: 1.2,
  color: '#6B7280',
  textTransform: 'uppercase',
},
body: {
  paddingLeft: 12,
  paddingRight: 8,
  paddingBottom: 4,
},
chevron: {
  marginLeft: 'auto',
},
```

- [ ] **Step 3: Update Sidebar.tsx TASKS section rows**

Each task row needs:
- Left: task name in `#E5E7EB`, fontSize 10, fontFamily 'monospace', fontWeight '600'
- Right: status badge — `RUNNING` in red (`#EF4444` bg with 15% opacity, `#EF4444` text) or time ago in `#6B7280`
- Row: paddingVertical 3, paddingHorizontal 4

- [ ] **Step 4: Update REPOSITORIES section rows**

- Active repo: green left border (2px, `#00D4AA`), text `#00D4AA`, fontWeight '700'
- Inactive repos: text `#E5E7EB`, no left border
- Version badge: fontSize 8, color `#6B7280`, marginLeft 4
- `+ ADD REPOSITORY`: color `#6B7280`, fontSize 9

- [ ] **Step 5: Update FileTree.tsx search bar and tree items**

- Search bar: backgroundColor `#111`, borderWidth 1, borderColor `#1A1A1A`, borderRadius 3, height 24, fontSize 9
- Tree items: fontSize 10, paddingVertical 2, paddingLeft per depth level (12px * depth)
- Folder icon: `#6B7280`, file icon: `#4B5563`
- Selected file: backgroundColor `rgba(0,212,170,0.08)`

- [ ] **Step 6: Update DEVICE, CLOUD, PORTS, PROFILES sections**

- DEVICE folders: icon + label rows, fontSize 10, color `#E5E7EB`
- CLOUD: label left, status badge right (`LINKED` in green, `CONNECT` in `#6B7280`)
- PORTS: port number in `#E5E7EB`, service name in `#6B7280`, green dot for active, external link icon
- PROFILES: icon + label rows with colored squares (green for prod, blue for staging)

- [ ] **Step 7: Visual verification**

Compare sidebar against mock-1. Check:
- All 7 sections visible when expanded
- TASKS badges colored correctly
- FILE TREE search bar present and styled
- CLOUD status badges (LINKED/CONNECT) aligned right
- PORTS show green active dots

- [ ] **Step 8: Commit**

```bash
git add components/layout/Sidebar.tsx components/layout/SidebarSection.tsx components/layout/FileTree.tsx
git commit -m "style(Sidebar): match mock — dense section rows, colored badges, pro-IDE look"
```

---

## Task 3: Pane Header — Rich Info Display

**Files:**
- Modify: `components/multi-pane/PaneSlot.tsx`
- Modify: `components/terminal/TerminalHeader.tsx`

**Mock Reference (mock-1, mock-4):** Pane header shows:
- Left: `⊙ CLAUDE CODE — ~/Shelly` (icon + title + path)
- Center: `⊙42K/1H  💾  👤  ⊞  ✕` (token usage, save icon, pin icon, split icons, close)
- Height: 28px, bg: `#111`, border-top colored by agent (Claude=`#D4A574`, etc.)

**Current State:** PaneSlot.tsx already has this structure. The styling needs fine-tuning to match the mock's density.

- [ ] **Step 1: Read PaneSlot.tsx header section (lines 90-180)**

Already read. Focus on the styles object.

- [ ] **Step 2: Update header styles**

```typescript
header: {
  height: 28,
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: '#111',
  borderTopWidth: 2,
  borderBottomWidth: 1,
  borderBottomColor: '#1A1A1A',
  paddingHorizontal: 8,
  gap: 4,
},
headerTitle: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '700',
  color: '#E5E7EB',
  letterSpacing: 0.5,
},
headerPath: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '400',
  color: '#6B7280',
  marginLeft: 2,
},
tokenText: {
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '600',
  color: '#6B7280',
  marginLeft: 4,
},
```

- [ ] **Step 3: Ensure header icons are consistently sized**

All header action icons: size 11-12, color `#6B7280`. Active/hovered: color `#E5E7EB`. Gap between action icons: 2px.

- [ ] **Step 4: Update TerminalHeader.tsx styles**

Read `components/terminal/TerminalHeader.tsx` (372 lines). This renders inside the terminal pane — session tabs, connection mode badge, usage indicator. Update styles to match mock density:
- Tab text: fontSize 9, fontFamily 'monospace', fontWeight '700', color `#6B7280` (active: `#E5E7EB`)
- Mode badge: fontSize 8, fontWeight '800', backgroundColor `rgba(0,212,170,0.1)`, color `#00D4AA`
- Usage text: fontSize 8, color `#6B7280`
- Overall height: compact, matching the 28px pane header proportion

- [ ] **Step 5: Visual verification**

Compare pane headers in all 5 mock layouts. Verify:
- Agent color border-top visible
- Title + path in correct fonts
- Token usage visible for terminal/AI panes
- Action icons (split, close) aligned right

- [ ] **Step 6: Commit**

```bash
git add components/multi-pane/PaneSlot.tsx components/terminal/TerminalHeader.tsx
git commit -m "style(PaneSlot,TerminalHeader): match mock — 28px header, agent border, token display"
```

---

## Task 4: LayoutPresetBar — Always Visible + Style Fix

**Files:**
- Modify: `components/layout/ShellLayout.tsx`
- Modify: `components/multi-pane/LayoutPresetBar.tsx`

**Mock Reference (all 5 mocks):** Bottom bar shows 6 preset buttons: `[1+2 SPLIT] [2 COL] [2 ROW] [SINGLE] [2X2 GRID] [4 TERMINAL]`. Active preset is highlighted with accent color background. The bar is **always visible** regardless of screen size (visible in all mocks which show a tablet-size screen).

**Current State:** LayoutPresetBar exists and works. Two issues:
1. `ShellLayout.tsx:154` wraps it in `{layout.isWide && ...}` — it should be always visible
2. Style is close but needs minor tweaks

- [ ] **Step 1: Make LayoutPresetBar always visible**

In `components/layout/ShellLayout.tsx`, change line 154:

```typescript
// Before:
{layout.isWide && <LayoutPresetBar />}

// After:
<LayoutPresetBar />
```

- [ ] **Step 2: Fine-tune LayoutPresetBar styles**

In `components/multi-pane/LayoutPresetBar.tsx`, verify styles match:
- Container: height 34, bg `#0D0D0D`, borderTopWidth 1, borderTopColor `#1A1A1A`
- Buttons: paddingHorizontal 12, paddingVertical 5, borderRadius 4, borderWidth 1
- Active: backgroundColor `#00D4AA`, borderColor `#00D4AA`, text color `#000`
- Inactive: backgroundColor `#111`, borderColor `#333`, text color `#6B7280`
- Label: fontSize 9, fontFamily 'monospace', fontWeight '700', letterSpacing 0.8

These already match. Just verify no changes needed after removing the `isWide` guard.

- [ ] **Step 3: Visual verification**

Check LayoutPresetBar appears on phone-size screens too. Verify active preset highlights correctly when switching layouts.

- [ ] **Step 4: Commit**

```bash
git add components/layout/ShellLayout.tsx components/multi-pane/LayoutPresetBar.tsx
git commit -m "fix(ShellLayout): show LayoutPresetBar on all screen sizes"
```

---

## Task 5: TerminalBlock — Rich CLI Output with Action Badges

**Files:**
- Modify: `components/terminal/TerminalBlock.tsx`

**Mock Reference (mock-1, mock-4):** Terminal pane shows Claude Code session with rich blocks:
1. Session banner: `CLAUDE CODE V2.1.92 / OPUS 4.6 (1M CONTEXT) · ~/SHELLY` with progress bar and token info `92K / 1M TOKENS · ~$0.63`
2. READ block: `● READ COMPONENTS/WELCOMEWIZARD.TSX  0.3S 📋` — green dot, file path, duration, copy icon
3. EDIT block: `● EDIT LIB/INPUT-ROUTER.TS ✏️` with diff (red deletion, green addition lines) + `ACCEPT` / `REJECT` buttons
4. BASH block: `⚠ BASH: RM -RF NODE_MODULES/  CONFIRM?` with yellow warning + `ALLOW` / `DENY` buttons
5. Auto-save bar: `🔒 AUTO-SAVED · 3 FILES CHANGED  UNDO  VIEW DIFF`
6. Tip: `💡 TIP: SAY "SHELLY VOICE" FOR HANDS-FREE MODE`

**Current State:** TerminalBlock.tsx (1226 lines) already has content-type detection and specialized blocks. The issue is that the rendered styles don't match the mock's polished look. This is the most complex task.

- [ ] **Step 1: Read TerminalBlock.tsx fully (focus on render methods)**

Read the entire file, focusing on:
- How `detectContentType` categorizes blocks
- How diff output is rendered
- How action badges (ACCEPT/REJECT) are styled
- The main render method's JSX structure

- [ ] **Step 2: Style the command header row**

Each block should have a colored header row:
```typescript
blockHeader: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 8,
  paddingVertical: 4,
  gap: 6,
},
blockDot: {
  width: 6,
  height: 6,
  borderRadius: 3,
},
blockAction: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '700',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
},
blockPath: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '400',
  color: '#E5E7EB',
  flex: 1,
},
blockDuration: {
  fontSize: 9,
  fontFamily: 'monospace',
  color: '#6B7280',
},
```

Color per action type:
- READ: dot `#00D4AA`, action text `#00D4AA`
- EDIT: dot `#FBBF24`, action text `#FBBF24`
- BASH: dot `#F87171` if dangerous, `#00D4AA` if safe
- WRITE: dot `#60A5FA`, action text `#60A5FA`

- [ ] **Step 3: Style diff output (EDIT blocks)**

```typescript
diffAddLine: {
  backgroundColor: 'rgba(0,212,170,0.12)',
  paddingHorizontal: 8,
  paddingVertical: 1,
},
diffAddText: {
  color: '#00D4AA',
  fontSize: 10,
  fontFamily: 'monospace',
},
diffRemoveLine: {
  backgroundColor: 'rgba(239,68,68,0.12)',
  paddingHorizontal: 8,
  paddingVertical: 1,
},
diffRemoveText: {
  color: '#EF4444',
  fontSize: 10,
  fontFamily: 'monospace',
},
diffPrefix: {
  fontWeight: '700',
  marginRight: 4,
},
```

- [ ] **Step 4: Style ACCEPT/REJECT and ALLOW/DENY buttons**

```typescript
acceptBtn: {
  backgroundColor: '#00D4AA',
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 3,
},
acceptText: {
  color: '#000',
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '800',
},
rejectBtn: {
  backgroundColor: 'transparent',
  borderWidth: 1,
  borderColor: '#333',
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 3,
},
rejectText: {
  color: '#6B7280',
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '700',
},
```

- [ ] **Step 5: Style auto-save bar and tip**

```typescript
autoSaveBar: {
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: 'rgba(0,212,170,0.08)',
  paddingHorizontal: 8,
  paddingVertical: 4,
  gap: 6,
  borderRadius: 3,
  marginVertical: 2,
},
autoSaveText: {
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '600',
  color: '#00D4AA',
},
autoSaveLink: {
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '700',
  color: '#00D4AA',
  textDecorationLine: 'underline',
},
tipBar: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 8,
  paddingVertical: 3,
  gap: 4,
},
tipText: {
  fontSize: 9,
  fontFamily: 'monospace',
  color: '#6B7280',
},
```

- [ ] **Step 6: Visual verification**

Compare terminal content against mock-1 and mock-4. Check:
- READ blocks show green dot + path + duration
- EDIT blocks show yellow dot + diff with colored lines + ACCEPT/REJECT
- BASH warning blocks show yellow warning + ALLOW/DENY
- Auto-save bar has green tint
- Tip text is subtle gray

- [ ] **Step 7: Commit**

```bash
git add components/terminal/TerminalBlock.tsx
git commit -m "style(TerminalBlock): match mock — action badges, diff colors, ACCEPT/REJECT buttons"
```

---

## Task 6: AIPane — Chat UI Design Improvements

**Files:**
- Modify: `components/panes/AIPane.tsx`
- Modify: `components/panes/InlineDiff.tsx`

**Mock Reference (mock-1, mock-2):** Right pane shows AI chat:
- Header: `CLAUDE CODE` (already handled by PaneSlot header)
- Status badge: `⊙ READING TERMINAL 1` in muted text
- Messages: `YOU` label (green), `CLAUDE` label (brown/tan)
- User message: plain text on dark background
- Claude response: text + inline diff (same style as terminal) + ACCEPT/REJECT buttons
- Input bar at bottom with cursor

- [ ] **Step 1: Read AIPane.tsx fully**

Read the complete file to understand MessageBubble rendering, streaming dots, and input bar integration.

- [ ] **Step 2: Update message label styles**

```typescript
userLabel: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '800',
  color: '#00D4AA',
  letterSpacing: 0.8,
  marginBottom: 4,
  textTransform: 'uppercase',
},
assistantLabel: {
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: '800',
  color: '#D4A574',
  letterSpacing: 0.8,
  marginBottom: 4,
  textTransform: 'uppercase',
},
```

- [ ] **Step 3: Update message content styles**

```typescript
messageContent: {
  fontSize: 11,
  fontFamily: 'monospace',
  color: '#E5E7EB',
  lineHeight: 16,
},
messageRow: {
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderBottomWidth: 1,
  borderBottomColor: '#1A1A1A',
},
```

- [ ] **Step 4: Update context badge style**

```typescript
contextBadge: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
  paddingHorizontal: 12,
  paddingVertical: 4,
  borderBottomWidth: 1,
  borderBottomColor: '#1A1A1A',
},
contextText: {
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '600',
  color: '#6B7280',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
},
```

- [ ] **Step 5: Ensure inline diff in AI messages matches TerminalBlock diff style**

The InlineDiff component used in AIPane should use the same diff colors:
- Added lines: `rgba(0,212,170,0.12)` bg, `#00D4AA` text
- Removed lines: `rgba(239,68,68,0.12)` bg, `#EF4444` text
- ACCEPT/REJECT buttons: same style as Task 5

- [ ] **Step 6: Visual verification**

Compare AI pane against mock-1 right side. Check:
- "READING TERMINAL 1" badge visible
- YOU label green, CLAUDE label brown
- Inline diff with ACCEPT/REJECT matches terminal style
- Input bar at bottom

- [ ] **Step 7: Commit**

```bash
git add components/panes/AIPane.tsx components/panes/InlineDiff.tsx
git commit -m "style(AIPane): match mock — YOU/CLAUDE labels, context badge, inline diff"
```

---

## Task 7: BrowserPane — Bookmark Tabs Design

**Files:**
- Modify: `components/panes/BrowserPane.tsx`

**Mock Reference (mock-1 bottom-left):** Browser pane shows:
- Header: `⊙ BROWSER` with nav buttons (←→🔄) + close (handled by PaneSlot)
- URL bar: `YOUTUBE.COM` in dark input
- Bookmark tabs: `▶ YOUTUBE ×  </> GITHUB  🌐 LOCALHOST` — active tab highlighted
- Content: WebView

- [ ] **Step 1: Read BrowserPane.tsx fully**

Read to understand current toolbar, bookmark rendering, and WebView integration.

- [ ] **Step 2: Update toolbar styles**

```typescript
toolbar: {
  height: 28,
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: '#111',
  borderBottomWidth: 1,
  borderBottomColor: '#1A1A1A',
  paddingHorizontal: 6,
  gap: 2,
},
urlInput: {
  flex: 1,
  height: 20,
  backgroundColor: '#1A1A1A',
  borderRadius: 3,
  paddingHorizontal: 8,
  fontSize: 10,
  fontFamily: 'monospace',
  color: '#E5E7EB',
},
```

- [ ] **Step 3: Update bookmark tab styles**

```typescript
bookmarkBar: {
  height: 28,
  backgroundColor: '#0D0D0D',
  borderBottomWidth: 1,
  borderBottomColor: '#1A1A1A',
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 4,
  gap: 2,
},
bookmarkTab: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 8,
  paddingVertical: 4,
  borderRadius: 3,
  gap: 4,
},
bookmarkTabActive: {
  backgroundColor: '#1A1A1A',
  borderWidth: 1,
  borderColor: '#333',
},
bookmarkLabel: {
  fontSize: 9,
  fontFamily: 'monospace',
  fontWeight: '700',
  color: '#6B7280',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
},
bookmarkLabelActive: {
  color: '#E5E7EB',
},
bookmarkClose: {
  marginLeft: 2,
},
```

- [ ] **Step 4: Visual verification**

Compare browser pane against mock-1 bottom-left. Check:
- URL bar styled with dark input
- Bookmark tabs show icon + label + close
- Active bookmark has background highlight
- Nav buttons in header functional

- [ ] **Step 5: Commit**

```bash
git add components/panes/BrowserPane.tsx
git commit -m "style(BrowserPane): match mock — bookmark tabs, URL bar, compact toolbar"
```

---

## Execution Notes

### Order Matters
Tasks 1-4 are layout/structural and should be done first (they affect the overall frame). Tasks 5-7 are content-level and can be done in parallel after the frame is right.

### Testing Strategy
- After each task, visually compare against the relevant mock screenshot
- No unit tests needed — these are pure style changes
- If the app crashes, check for StyleSheet syntax errors (missing commas, wrong property names)

### Common Pitfalls
- Don't use NativeWind classes in these files — they all use StyleSheet.create()
- Don't change any store logic, hooks, or state management
- Keep all `onPress` handlers unchanged
- MonoSpace font: use `fontFamily: 'monospace'` (React Native resolves this per platform)
- Colors from theme: ideally use `useTheme()` hook's `colors` object, but the codebase currently mixes hardcoded colors. Match existing file patterns.
