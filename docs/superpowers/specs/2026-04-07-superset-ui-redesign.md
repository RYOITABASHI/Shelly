# Shelly UI Redesign: Superset-Style Terminal IDE

**Date**: 2026-04-07
**Status**: Draft (v2 — reviewed)
**Scope**: Full UI/UX overhaul — tab system removal, panel-based layout, feature consolidation

---

## 1. Vision

Shelly becomes a single-screen terminal IDE. No tabs, no routing, no separate screens.
Everything lives in a flexible panel system inspired by Apache Superset's dashboard layout,
with best-in-class features stolen from Warp, Windsurf, Ghostty, Wave, Zed, Cursor, Kitty,
WezTerm, Tabby, Fig, Neovide, and Rio.

**Background**: `#000000` (pure black, default)

---

## 2. What Gets Removed

| Component | Action |
|-----------|--------|
| `app/(tabs)/` routing | Delete — single screen, no tabs |
| Tab bar (bottom) | Delete — zero chrome |
| Chat tab (`index.tsx`) | Delete — extracted to Chelly OSS |
| Settings tab (`settings.tsx`) | Delete — `shelly config` + command palette |
| Projects tab (`projects.tsx`) | Delete — left sidebar absorbs |
| `Onboarding.tsx` | Keep as modal overlay on first launch |
| `WelcomeWizard.tsx` | Keep as modal overlay on first launch |
| Cross-Pane Intelligence | Absorb into terminal — AI pane reads terminal snapshots directly |

---

## 3. Layout Architecture

### 3.1 Structure

```
┌──────────────────────────────────────────────────────────┐
│  Agent Bar: [claude] [gemini] [codex] [opencode] [+]     │
├──────┬───────────────────────┬───────────────────────────┤
│      │                       │                           │
│  S   │   Pane 1 (main)       │   Pane 2                  │
│  i   │   [terminal/AI/       │   [terminal/AI/           │
│  d   │    web/markdown]      │    web/markdown]          │
│  e   │                       │                           │
│  b   ├───────────────────────┼───────────────────────────┤
│  a   │                       │                           │
│  r   │   Pane 3              │   Pane 4                  │
│      │                       │                           │
├──────┴───────────────────────┴───────────────────────────┤
│  Context Bar: ~/project  main ↑2  node v24  cpu 12%      │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Responsive Behavior

| Device State | Layout |
|-------------|--------|
| Z Fold6 unfolded + landscape | Full: sidebar + 2x2 panes (4 max) |
| Z Fold6 unfolded + portrait | Sidebar collapsed (icons) + 2 panes stacked |
| Z Fold6 folded / phone | Single pane + swipe gestures for sidebar/AI |
| Tablet landscape | Sidebar + 2 panes side-by-side |

### 3.3 Sidebar (Left, Collapsible)

Five sections, collapsible accordion:

1. **Tasks** — active background agents, running commands
2. **Repositories** — project list (replaces Projects tab), quick switch
3. **File Tree** — expands under active repository, shows project file structure
   - Search bar at top (fuzzy file search)
   - Tap file: opens in Markdown pane (if .md) or runs `cat` in terminal
   - Tap folder: expand/collapse
   - Modified files highlighted (git status integration)
4. **Device** — quick access to device storage folders
   - `~/` (home), DCIM, Download, Documents, Music
   - Not all folders — only commonly needed ones
   - Tap to browse, long-press to copy path into terminal
5. **Cloud** — cloud storage integration
   - Google Drive, Dropbox, OneDrive
   - OAuth authentication per provider (tap "connect" to link)
   - Browse files, download to local, attach to AI context
   - Status badge: "linked" or "connect"
6. **Ports** — forwarded ports with open-in-browser action
7. **Profiles** — SSH/SFTP connection profiles (Tabby-inspired)

States:
- **Expanded**: ~240px, icons + labels + file tree
- **Icons-only**: ~48px, icon badges for counts
- **Hidden**: 0px (phone/folded), swipe-right to reveal

**Design rationale**: File tree lives in the sidebar (not a pane) to maximize
terminal vertical space. Tapping a repository in Repositories auto-expands
its file tree below. This also absorbs the Worktree concept — each repository
has its own file tree and can be bound to a specific agent, providing the same
isolation as git worktrees without exposing the concept to users.

### 3.4 Agent Bar (Top)

Horizontal scrollable bar of available AI agents:
- Each agent: icon + name + status dot (green=ready, yellow=busy, gray=offline)
- Tap: switches active agent context for the focused pane
- Long-press: agent settings (API key, model selection)
- `[+]` button: add/configure new agent
- Replaces the old `@mention` routing for agent selection
- **Width**: aligned to pane grid width (not full screen — does not overlap sidebar)
- **Right side buttons**: Search (command palette) + Settings (gear icon) — always visible, one tap
- **Agent-pane color linking**: each pane shows a colored top border matching its bound agent
  (e.g., Claude=#D4A574, Gemini=#4285F4, Codex=#10A37F, unbound=#333)

### 3.5 Context Bar (Bottom)

Persistent status strip showing:
- Current working directory (truncated, tap to copy)
- Git branch + ahead/behind count
- Active runtime (node version, python version)
- Resource usage (CPU/memory, optional)
- Connection status indicator

### 3.6 Pane System

Each pane has:
- **Header**: pane type icon + title + [split] [type-switch] [close] buttons
- **Content**: one of the pane types (see 3.7)
- **Drag-resize borders**: between adjacent panes, 4px hit target

Pane operations:
- Split horizontal / vertical (from header button or command palette)
- Switch pane type (dropdown: Terminal, AI, Browser, Markdown)
- Drag to reorder (long-press header)
- Close (X button, minimum 1 pane always open)

**Input model**: inline prompt only — no separate text box.
All panes use an inline `>` prompt at the bottom of content.
Attach (clip icon) and voice (mic icon) buttons sit beside the prompt.
This applies to both Terminal and AI panes.

### 3.7 Pane Types

Four pane types (Files moved to sidebar):

#### Terminal Pane
- Native PTY terminal (existing NativeTerminalView)
- Command Blocks with inline previews (images, markdown, HTML)
- IDE-style rich input editor (multi-line, syntax highlighting)
- Fig-style autocomplete popup (floating below cursor)
- Clickable file paths / error locations (tap to open in sidebar or Markdown pane)
- Kitty graphics protocol support (inline images)
- Smooth cursor animation + scroll physics (Neovide-style)
- `shelly config` command opens TUI settings
- **Attach button** (clip icon next to prompt): attach images/files to AI context
  - Sources: camera, gallery, file picker, Device sidebar drag
  - Attached files shown as inline badges above prompt
  - Use case: screenshot → "fix this UI", log file → "explain this error"

#### AI Pane
- Streaming AI responses (replaces Chat tab functionality)
- Context-aware: auto-reads focused terminal pane's output (Cross-Pane absorption)
- Inline diff preview for suggested changes (Cursor-style green/red)
- Agent selector in pane header
- Conversation history per session
- @mention for targeting specific agents

#### Browser Pane (formerly Web Preview)
- Full in-pane browser via WebView (not just localhost)
- URL bar with navigation (back/forward/refresh)
- **Bookmarks bar**: quick-access buttons (YouTube, X, GitHub, localhost, custom)
- Auto-detects running dev servers (from Ports in sidebar)
- Responsive toggle for mobile/desktop view

**Background media playback**:
- Switching bookmark pages uses `display:none`, not unmount — audio continues
- Switching pane type (Browser → Terminal) keeps WebView alive in background
- `mediaPlaybackRequiresUserAction={false}` + `allowsInlineMediaPlayback={true}`
- Use case: YouTube playing music in background while coding in Terminal pane
- Note: YouTube web requires Premium for background audio; YouTube ReVanced works

**Intended use cases**:
- Dev server preview (localhost:3000)
- YouTube / music while CLI is working
- X/Twitter timeline during idle
- GitHub PR reviews alongside terminal
- Any web URL (documentation, Stack Overflow, etc.)

#### Markdown Pane
- Rendered markdown / README display
- Syntax-highlighted code blocks
- Scrollable, linkable headings
- Edit button → opens in terminal with `$EDITOR`

---

## 4. Feature Details

### 4.1 Fig-Style Autocomplete

Floating panel below cursor in Terminal pane:
- Triggered on typing after prompt
- Shows: command suggestions, flags, file paths, git branches
- Sources: shell history, PATH binaries, git context, project files
- Tab to accept, arrow keys to navigate, Esc to dismiss
- Fuzzy matching

**Responsive adaptation**:
- Wide screen (Z Fold6 unfolded): full popup, up to 6 candidates, 240px+ width
- Narrow screen (Z Fold6 folded): compact inline suggestions above input, max 3 candidates, full-width
- Dismiss on scroll or tap outside

### 4.2 IDE-Style Rich Input (Warp-inspired)

Terminal input area becomes a real editor:
- Click to position cursor anywhere in input
- Multi-line editing (Shift+Enter for newline)
- Syntax highlighting for shell commands
- Auto-closing quotes/brackets
- Selection via touch/drag
- Paste with preview

### 4.3 Clickable Paths & Errors (Zed-inspired)

Terminal output parsing:
- Detect file paths (absolute/relative) → underline, tap to highlight in sidebar file tree
- Detect error patterns (file:line:col) → tap to jump (highlight in file tree + show context)
- Detect URLs → tap to open in Web Preview pane or browser
- Long-press: context menu (copy path, open externally)

### 4.4 Inline Content Blocks (Wave-inspired)

Extend existing Command Blocks:
- Markdown output → rendered inline
- Image paths/URLs → thumbnail preview inline
- HTML output → mini WebView inline
- JSON → syntax-highlighted collapsible tree
- Tables → formatted grid display
- Collapsible: tap header to fold/unfold

### 4.5 Inline Diff Preview (Cursor-inspired)

When AI suggests code changes:
- Show green (added) / red (removed) lines inline
- Accept / Reject buttons per hunk
- Apply all / Reject all in header
- Animated transition on accept

### 4.6 Smooth Animations (Neovide-inspired)

GPU-accelerated micro-interactions:
- Cursor: smooth movement between positions (not teleport)
- Scroll: physics-based momentum scrolling
- Pane resize: fluid animation
- Pane open/close: slide + fade
- Content transitions: crossfade between pane types

### 4.7 Kitty Graphics Protocol

Terminal-level image display:
- `kitty +kitten icat image.png` → renders inline
- Plot libraries (matplotlib etc.) can output directly to terminal
- Sixel fallback for compatibility
- Configurable: on/off in `shelly config`

### 4.8 Lua Scripting (WezTerm-inspired)

User-extensible automation:
- `~/.shelly/config.lua` for custom keybindings, status bar, automations
- Event hooks: on_command_complete, on_directory_change, on_error
- Custom status bar widgets
- Custom pane layouts (save/restore named workspaces)
- Plugin API bridge: Lua ↔ existing JS plugin system

### 4.9 Connection Profile Manager (Tabby-inspired)

Lives in sidebar Profiles section:
- Save SSH/SFTP connection profiles
- Fields: host, port, user, key file, jump host
- Quick-launch: tap profile → opens Terminal pane with SSH session
- Import from `~/.ssh/config`
- Connection status indicator per profile

### 4.10 Settings via Terminal

No Settings screen. Configuration through:

**Primary (mobile-first)**:
1. **Settings button** (gear icon in Context Bar) — opens settings overlay/modal
2. **Command Palette button** (search icon in Context Bar) — search features and settings
3. Both always visible in bottom bar, one tap to access

**Secondary (power users with physical keyboard)**:
4. **`shelly config`** — TUI settings in terminal
5. **`shelly config set <key> <value>`** — direct CLI
6. **`~/.shelly/config.lua`** — scripted configuration
7. **`~/.shellyrc`** — shell environment / API keys

**Important**: All features must be accessible via tap/gesture. Keyboard shortcuts
are optional enhancements for physical keyboard users (Z Fold6 with keyboard case),
never the only way to access a feature.

### 4.11 Localization

- **Default**: follows device system language (existing `useI18n` behavior)
- **Manual override**: `shelly config set locale ja` or via command palette
- No in-app language toggle button — configuration-driven only
- Supported: English, Japanese (existing), extensible

### 4.12 Repository-Based Workspace Isolation

Replaces the Worktree concept for mobile:
- Each repository in sidebar = isolated workspace
- Tapping a repository switches cwd, file tree, and pane context
- Agents can be bound per-repository (e.g., Claude for Shelly, Gemini for Nacre)
- No git worktree knowledge required from user
- Terminal sessions persist per repository (switching back restores state)

### 4.13 CLI Completion Notification + Pane Focus

When a long-running command finishes in a non-focused pane:
- **Notification sound**: customizable (default: subtle chime)
- **Pane header flash**: completed pane header pulses with accent color + "Done" badge
- **Tap to focus**: tap the notification to switch focus to that pane
- **System notification**: if app is in background, Android notification with command result summary

Configurable:
- `shelly config set notify_sound chime|beep|none`
- `shelly config set notify_threshold 5` (only notify if command took >5 seconds)
- Per-pane: can mute notifications for specific panes (e.g., dev server that runs forever)

Critical for Browser Pane usage: without this, users watching YouTube will miss CLI completions.

### 4.14 Cross-Pane Clipboard Sync

Unified clipboard across all panes:
- Copy in Terminal Pane → paste in AI Pane (and vice versa)
- Copy in Browser Pane → paste in Terminal
- Uses system clipboard as single source of truth
- No custom clipboard layer — just ensure all pane types read/write to the same system clipboard
- Implementation: React Native's `Clipboard` API already unified; just verify WebView clipboard integration via `injectedJavaScript` bridge

This is not a feature — it's a correctness requirement. Broken clipboard = broken app.

### 4.15 Snippet/Workflow Manager

Save and replay command sequences from the terminal:

```
$ shelly workflow save deploy
# Interactive: select commands from history to include
# Saves to ~/.shelly/workflows/deploy.sh

$ shelly workflow run deploy
# Executes saved sequence

$ shelly workflow list
# Shows all saved workflows

$ shelly workflow edit deploy
# Opens in $EDITOR
```

- **No UI** — purely CLI-driven, terminal-native
- Workflows are shell scripts with optional parameter substitution (`$1`, `$2`)
- Accessible from command palette (Ctrl+Shift+P → search workflow name)
- Shareable: plain `.sh` files in `~/.shelly/workflows/`
- Import: drop `.sh` files into the directory

### 4.16 Voice Conversation Mode

ChatGPT/Perplexity-style voice dialogue, integrated into the terminal.

**Existing infrastructure** (migrated from Chat tab):
- `VoiceChat.tsx` — full-screen voice overlay with animated UI
- `use-voice-chat.ts` — VoiceChain: speech → routing → exec/AI → TTS
- `use-speech-input.ts` — recording + Gemini/Groq transcription
- `lib/tts.ts` — expo-speech TTS with markdown stripping
- `lib/voice-chain-helpers.ts` — command output summarization for speech

**Integration points in new layout**:

1. **AI Pane mic button**: tap to enter voice mode within AI pane
   - Compact inline mode: waveform animation in pane header, not full-screen
   - User speaks → transcript appears in AI pane → AI responds → TTS reads response
   - Continuous conversation loop until user taps stop

2. **Terminal Pane voice**: accessible via CommandKeyBar mic button
   - Voice input routed through parseInput() (same as typed input)
   - Terminal command results summarized and spoken via `summarizeForSpeech()`
   - Example: "show me git status" → runs `git status` → "You have 2 modified files on main branch"

3. **CLI output auto-TTS** (opt-in):
   - When AI agent (Claude/Gemini) returns natural language in terminal, auto-speak it
   - Only for AI responses, not raw command output
   - Toggle: `shelly config set auto_tts true`
   - Detects AI response blocks via Command Block metadata

4. **Full-screen voice mode**: long-press mic or `shelly voice`
   - Existing VoiceChat.tsx overlay, adapted for new layout
   - For extended hands-free sessions

5. **Hands-free continuous mode**: `shelly voice --hands-free`
   - Zero-touch operation: no screen interaction required after activation
   - Wake word or always-listening (configurable)
   - Auto-listen after TTS completes (no tap to re-activate)
   - Screen stays on with minimal UI (waveform only, AMOLED-friendly)
   - Audio feedback for state transitions (beep on listen-start, chime on command-complete)
   - Designed for: phone mounted on car holder, cooking, walking
   - Safety: all actions are voice-confirmed before destructive operations
     ("I'm about to force-push to main. Say 'yes' to confirm or 'cancel'")
   - Session transcript saved to `~/.shelly/voice-logs/` for later review
   - Exit: say "Shelly stop" or "終了"

**Voice flow**:
```
[Mic tap] → recording → Gemini/Groq transcription
  → parseInput() routing
  → if command: execute → summarizeForSpeech() → TTS
  → if AI query: stream response → TTS
  → auto-listen for next input (conversation loop)
```

### 4.17 Sound Design

Tap/interaction sounds that enhance the tactile feel:

**Sound profiles** (selectable in `shelly config`):
- **Modern** (default): crisp click sounds, Superset-inspired
  - Key press: soft mechanical click
  - Command complete: subtle chime
  - Error: low thud
  - Notification: gentle ping
- **Retro** (auto-activates with CRT mode): 8-bit terminal sounds
  - Key press: typewriter / dot-matrix tap
  - Command complete: 8-bit success jingle
  - Error: retro buzzer
  - Notification: chip-tune beep
- **Silent**: no sounds

Implementation:
- Existing `lib/sounds.ts` already has sound system with expo-audio
- Sound profile linked to CRT mode: CRT ON → auto-switch to Retro
- All sounds < 50ms latency for responsive feel
- Volume follows system media volume
- Haptic feedback paired with sounds (existing haptics support)
- **Haptic toggle**: on/off in `shelly config set haptic true|false`
  - ON: short vibration (10ms) on every interactive tap (buttons, tabs, sidebar items, pane actions)
  - OFF: no vibration
  - Default: ON

### 4.18 Font Selection

Multiple font options with CRT-aware defaults:

**Built-in fonts**:
- **JetBrains Mono** (default): modern monospace, ligature support
- **Fira Code**: popular with ligatures
- **Source Code Pro**: clean, neutral
- **IBM Plex Mono**: technical feel
- **Pixel/8-bit** (CRT mode): dot-matrix style
  - `PixelMPlus` — Japanese support, 10/12px bitmap feel
  - `Press Start 2P` — classic 8-bit game font (ASCII only)
  - `Silkscreen` — compact pixel font

**CRT mode behavior**:
- CRT ON → auto-switches to pixel font (configurable which one)
- CRT OFF → restores previous font selection
- Override: user can lock font regardless of CRT state

**Configuration**:
- `shelly config set font "JetBrains Mono"`
- `shelly config set font_size 14`
- `shelly config set crt_font "PixelMPlus"` (font used when CRT is on)
- Command palette: search "font" to see all options with preview

### 4.19 CRT Effect (cosmetic)

Optional GPU-rendered CRT display effect:
- **Scanlines**: visible horizontal stripes (4px period)
- **Color temperature**: P1 phosphor green tint (`rgba(0, 255, 68)`)
- **Text glow**: bright text bleeds/blooms (multi-layer text-shadow)
- **Vignette**: edge darkening
- **Subtle flicker**: slight opacity oscillation

Configuration:
- Toggle: on/off in `shelly config` or command palette
- Intensity slider: 0–100% (controls all sub-effects proportionally)
- Default: off
- Stored in settings as `crt_enabled: boolean` and `crt_intensity: number`

### 4.18 Feature Discovery Layer (AI-first)

91 features exist. Users should discover them naturally, not via docs or tutorials.

**Target user**: mid-level to power user (beginners → Chelly OSS).

#### AI-Powered Feature Discovery (Phase 1 — primary mechanism)

The AI pane knows all 91 features via `feature-catalog.ts` injected into its
system prompt. Combined with Cross-Pane Intelligence reading the current UI
state (terminal output, file tree, running tasks, active panes), the AI can
proactively suggest relevant features based on what the user is actually doing.

```
User: "What can I do with this?"

Shelly AI: "I can see git status output in your terminal.
            - Tap the modified file paths to open them
            - Auto-savepoint can auto-commit for you
            - The error on line 3 can go to AI Error Fixer"
```

This is the main discovery mechanism. No docs, no tutorials, no feature tours.
"Ask Shelly" is the onboarding. The AI sees the full UI context and knows every
feature — it recommends what's relevant right now, not a generic list.

Implementation:
- `feature-catalog.ts` contains all features: id, name, description, trigger context
- AI pane system prompt includes the catalog (compressed)
- Cross-Pane snapshot provides current UI state
- AI combines catalog + state to make contextual suggestions
- Works for any question: "what's this button?", "I want to deploy", "any tips?"

#### Context Hints (Phase 1 — lightweight supplement)

Behavior-triggered, non-intrusive hints for users who don't open the AI pane:

| Trigger | Hint |
|---------|------|
| User types `git diff` 3+ times | "Tip: tap any diff block to fold/unfold" |
| Error output detected | "Tap the error to send to AI Error Fixer" |
| User pastes long command | "Shift+Enter for multi-line editing" |
| User runs same command repeatedly | "Save as workflow: `shelly workflow save`" |
| User manually types file path | "Tap file paths in output to open them" |
| First time using AI pane | "AI reads your terminal output automatically" |
| User resizes panes manually | "Save this layout: `shelly layout save`" |
| User SSH's to a server | "Save as profile in sidebar for quick access" |

Rules:
- Each hint shown **once per feature** (tracked in AsyncStorage)
- Appears as subtle inline text below the relevant output (not modal, not toast)
- Styled as dim monospace, same as terminal dim text, with a small dismiss `×`
- Max 1 hint per 60 seconds (no hint spam)
- User can disable all hints: `shelly config set hints false`

#### Smart Command Palette (Phase 1 — must ship)

Enhance existing Ctrl+Shift+P:
- **Recent actions** section at top (last 5 commands/settings changed)
- **Suggested for you** section: based on recent terminal activity
  - If user has been doing git work → surface git-related features
  - If user has dev server running → surface Web Preview, Ports
  - If user is editing config files → surface Lua scripting, themes
- **Search**: existing fuzzy search over all 91 features
- Each item shows: icon + name + one-line description + keybinding (if any)

#### Idle Tips — removed

Superseded by AI-powered discovery. Users can ask the AI pane at any time.
Static tips are inferior to contextual AI suggestions.

---

## 5. Data Flow

### AI Pane Context (Cross-Pane replacement)

```
Terminal Pane (focused)
  │
  ├─ getTranscriptText() → last N lines of output
  ├─ getCurrentCommand() → active command
  ├─ getWorkingDir() → cwd
  │
  └──→ AI Pane
        ├─ Auto-injects terminal context into prompt
        ├─ Shows context badge: "Reading Terminal 1"
        └─ User can @mention specific pane: "@pane2 explain this"
```

### Agent Routing (replaces input-router for Chat)

```
Agent Bar tap → sets activeAgent for focused pane
  │
  ├─ Terminal Pane: @agent prefix auto-added
  ├─ AI Pane: agent handles conversation
  └─ Both: agent status shown in pane header
```

### Repository Switch

```
Sidebar: tap "Nacre"
  │
  ├─ cwd changes to ~/Nacre
  ├─ File tree updates to Nacre's structure
  ├─ Terminal sessions for Nacre restored (or new session created)
  ├─ Context bar updates (path, git branch, runtime)
  └─ Bound agent activates (if configured)
```

---

## 6. File Structure (Post-Redesign)

```
app/
  _layout.tsx          # Single screen, no tabs
  index.tsx            # Main shell (the entire app)

components/
  layout/
    ShellLayout.tsx     # Top-level: sidebar + panes + bars
    Sidebar.tsx         # Left sidebar (Tasks/Repos/FileTree/Ports/Profiles)
    FileTree.tsx        # File tree browser (lives inside Sidebar)
    AgentBar.tsx        # Top agent switcher
    ContextBar.tsx      # Bottom status strip
  panes/
    PaneContainer.tsx   # Pane grid manager (split/resize/reorder)
    PaneHeader.tsx      # Header with type switch, split, close
    TerminalPane.tsx    # Terminal content
    AIPane.tsx          # AI conversation (ex-Chat)
    BrowserPane.tsx     # In-pane browser with bookmarks + background media
    MarkdownPane.tsx    # Rendered markdown viewer
  terminal/
    RichInput.tsx       # IDE-style input editor
    AutocompletePopup.tsx  # Fig-style completions
    InlinePreview.tsx   # Wave-style content blocks
    InlineDiff.tsx      # Cursor-style diff preview
    ClickablePath.tsx   # Zed-style path detection
  config/
    ConfigTUI.tsx       # Terminal-based settings UI
    LuaEngine.tsx       # Lua scripting bridge
  discovery/
    ContextHint.tsx     # Inline hint display component
    hint-triggers.ts    # Trigger definitions (action → hint mapping)
    hint-tracker.ts     # AsyncStorage: which hints have been shown

store/
  shell-store.ts        # Main app state (replaces terminal-store)
  pane-store.ts         # Pane layout, types, focus
  agent-store.ts        # Agent configs, active agent per pane
  sidebar-store.ts      # Sidebar state, repos, file tree, tasks, ports
  profile-store.ts      # SSH/connection profiles
  workspace-store.ts    # Per-repository workspace state (sessions, bound agents)

lib/
  pane-manager.ts       # Pane split/resize/close logic
  autocomplete.ts       # Completion engine
  path-detector.ts      # Clickable path/error parsing
  feature-catalog.ts    # All 91 features: id, name, description, keybinding, category
  kitty-graphics.ts     # Kitty protocol implementation
  lua-runtime.ts        # Lua VM bridge
  inline-renderer.ts    # Markdown/image/HTML inline rendering
  workspace-manager.ts  # Repository switch, session persistence
```

---

## 7. Migration Path

### Phase 1: Layout Foundation
- New `ShellLayout` with sidebar + pane grid + agent bar + context bar
- Single pane type: Terminal (existing)
- Remove tab routing, collapse to single screen
- Drag-resize between panes
- Sidebar: Tasks, Repositories, File Tree, Ports, Profiles sections
- Repository-based workspace switching

### Phase 2: Pane Types + Voice
- AI Pane (extract from Chat, integrate Cross-Pane context reading)
- Browser Pane (WebView + bookmarks + background media playback)
- Markdown Pane
- Voice conversation mode (migrate VoiceChat + hooks to AI/Terminal panes)

### Phase 3: Terminal Enhancements + Feature Discovery
- Rich input editor (IDE-style)
- Fig-style autocomplete (with responsive adaptation for narrow screens)
- Clickable paths/errors (→ sidebar file tree highlight)
- Inline content blocks (Wave-style: images, markdown, HTML, JSON, tables)
- Context hints (behavior-triggered feature discovery)
- Smart command palette (recent + suggested sections)
- Feature catalog (`lib/feature-catalog.ts` — all 91 features indexed)

### Phase 4: Advanced Features
- Smooth animations (Neovide-style cursor, scroll, pane transitions)
- Inline diff preview (Cursor-style green/red with Accept/Reject)
- Kitty graphics protocol (inline images in terminal)
- Lua scripting engine (`~/.shelly/config.lua`)
- CRT effect (toggle + intensity slider in settings)
- Connection profile manager (SSH/SFTP in sidebar)
- Settings TUI (`shelly config`)

### Phase 5: Cleanup & Extraction
- Delete old Chat/Settings/Projects tabs and components
- Extract Chat to Chelly repo (separate OSS)
- Update i18n (remove unused keys, add new)
- Update CLAUDE.md and documentation
- Remove unused stores, hooks, and libs

---

## 8. Non-Goals

- Desktop/web version (Android only)
- Real code editor (use `vim`/`nano` in terminal)
- Full IDE debugging (use AI-assisted debugging instead)
- VS Code extension compatibility
- In-app language toggle (use device settings or `shelly config`)
- Git worktree as user-facing concept (absorbed by repository switching)
- Feature discovery panel/page in sidebar (AI pane + context hints are sufficient)
- Static tips / "Did you know?" popups (AI contextual suggestions are superior)
- Feature documentation / user manual (ask the AI instead)
- Picture-in-Picture pane (Z Fold6 specific, low ROI)
- Built-in file editor (use vim/nano in terminal)
- Database viewer (use CLI)
- Docker management UI (not a mobile use case)
