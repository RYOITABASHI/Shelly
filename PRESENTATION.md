# Shelly — AI-Powered Mobile Terminal IDE

## Overview

Shelly is a chat-first terminal IDE for Android. It wraps Termux (Linux terminal emulator) in a familiar chat interface — like ChatGPT or Claude, but with real shell execution behind every message.

Users type natural language. The AI picks the right tool, runs commands in Termux, and translates the results back into chat bubbles. No terminal knowledge required.

For power users, a raw terminal tab gives full shell access — with Japanese input support that Termux alone cannot provide.

**The entire app was developed on-device using Termux + Claude Code on a Samsung Galaxy Z Fold6.**

---

## Core Concept

```
User: "ポートフォリオ作って"
         |
    Chat UI (natural language)
         |
    Input Router (intent classification)
         |
    AI Agent Selection (Claude Code / Gemini CLI / Local LLM)
         |
    Termux Bridge (real shell execution)
         |
    Chat UI (results as chat bubbles)
```

What makes Shelly different from ChatGPT/Claude apps:
- **Real execution.** Not just conversation — commands actually run on the device.
- **Multiple AI backends.** Claude Code, Gemini CLI, Perplexity, Local LLM, Codex — auto-selected or @mentioned.
- **Terminal access.** When you need it, raw shell is one tab away.

What makes Shelly different from Termux:
- **Japanese input.** Termux can't handle Gboard/Japanese IME properly. Shelly can.
- **Chat UI.** No need to know bash. Talk naturally, get results.
- **AI translation.** Command outputs are summarized in plain Japanese.

---

## App Structure (4 Tabs)

| Tab | Role | Target User |
|-----|------|-------------|
| **Projects** | Project folders + chat history. Like GPT/Claude's left sidebar, but as a tab (mobile-friendly). | Everyone |
| **Chat** | Main screen. Right: user bubbles, Left: AI bubbles. Commands execute behind the scenes. | Everyone |
| **Terminal** | Raw TTY terminal. Full shell access with Japanese input via Shelly's keyboard. | Power users |
| **Settings** | AI config, Termux Bridge, snippets, Obsidian RAG, themes, backup. | Everyone (initial setup) |

### Why 4 tabs?

Previous design had 8 tabs (Chat, TTY, Snippets, Creator, Browser, Obsidian, Search, Settings). This was overwhelming for new users and blurred the line between "chat app" and "terminal app".

New design: GPT/Claude users see a familiar interface. Terminal users get a dedicated tab. Everything else lives in Settings or Projects.

**Migration:**
| Old Tab | New Location |
|---------|-------------|
| TTY | Terminal tab (renamed) |
| Creator | Chat (say "アプリ作って" — AI handles project creation) |
| Snippets | Settings > Snippets (or `/` slash command in Chat) |
| Browser | Removed (use device browser) |
| Obsidian | Settings > Obsidian RAG |
| Search | Projects tab (chat history search) |

---

## Chat Tab — Detailed Design

```
+------------------------------+
| <<  Shelly           [>_]    |  << = Projects drawer, >_ = Terminal shortcut
+------------------------------+
|                              |
|        こんにちは    [User] >|  Right-aligned user bubble
|                              |
|< [AI]  こんにちは！          |  Left-aligned AI bubble
|        何か作りましょうか？   |
|                              |
|   ポートフォリオ作って [User]>|
|                              |
|< [AI]  Claude Codeで         |
|        作成します。          |
|   +-- Executing -----------+ |
|   | mkdir portfolio        | |  Command execution inside bubble
|   | npm init -y            | |
|   | Creating files...      | |  Collapsible for long output
|   | Done (3 files)         | |
|   +------------------------+ |
|                              |
+------------------------------+
| [+] メッセージを入力...  [>] |  GPT-style input bar
+------------------------------+
```

**Key behaviors:**
- User input → right bubble (blue/green)
- AI response → left bubble with avatar
- Command execution → embedded in AI bubble, collapsible
- Dangerous commands → red warning bubble with confirm/cancel
- @mention → routes to specific AI (e.g., `@claude`, `@gemini`, `@local`)
- `/` prefix → slash commands (snippets, settings shortcuts)
- Long outputs → auto-collapsed, tap to expand
- Streaming → typing indicator with token/s stats

---

## Projects Tab — Detailed Design

```
+------------------------------+
| Projects            [+ New]  |
+------------------------------+
| [Search...]                  |
+------------------------------+
| [folder] portfolio-site      |
|    ~/dev/portfolio            |
|    3 hours ago  |  12 msgs   |
+------------------------------+
| [folder] shelly-bridge       |
|    ~/shelly-bridge            |
|    Yesterday  |  8 msgs      |
+------------------------------+
| [chat] 雑談                  |
|    (no project folder)        |
|    2 days ago  |  3 msgs     |
+------------------------------+
| -- Older ------------------- |
| [folder] timer-app  ...      |
+------------------------------+
```

**Key behaviors:**
- Each chat session can be linked to a project folder (cwd)
- Tap → switch to that chat in Chat tab
- Swipe left → delete
- New chat → optional project folder selection
- Search → full-text search across all chat history
- Folder-less chats = casual conversation (like "New chat" in GPT)

---

## Terminal Tab

Full TTY terminal powered by ttyd WebView. Same as current TTY tab, but now:
- Japanese input works (Shelly's keyboard layer intercepts IME)
- Shortcut bar (Ctrl, Esc, Tab, arrows) shown here only
- Copy/paste integration with Chat tab

---

## Technical Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | React Native | 0.81.5 |
| Platform | Expo (New Architecture) | SDK 54 |
| Language | TypeScript | Strict mode |
| State Management | Zustand | 5.0.11 |
| Animation | React Native Reanimated | v4 |
| Styling | NativeWind + Tailwind CSS | 4.2.1 / 3.4.17 |
| Navigation | Expo Router (file-based) | v6 |
| Storage | AsyncStorage + Expo SecureStore | Latest |

---

## Input Routing (5 Layers)

```
User Input
    |
    v
Layer 1: @mention        -> Direct AI routing (@claude, @gemini, @local, @team, @git)
Layer 2: NL + Tool        -> Keyword detection ("claudeで", "検索して")
Layer 3: Natural Language  -> LLM intent classification (chat/code/research/file_ops)
Layer 4: Shell Command     -> Pattern detection (pipes, paths, known CLIs)
Layer 4.5: Lightweight NL  -> Simple NL->shell shortcut ("ファイル一覧"->ls) — no API call
    |
    v
Target Execution
    +-- Termux Bridge       -> Real shell execution (WebSocket)
    +-- Claude Code CLI     -> Code generation, complex tasks
    +-- Gemini CLI          -> Research, information gathering
    +-- Local LLM (Ollama)  -> Offline chat, intent routing
    +-- Perplexity API      -> Web search with citations
    +-- @team Table         -> Multi-agent parallel consensus
    +-- @git Guide          -> Natural language Git tutoring
```

---

## Multi-AI Integration

5 AI backends with instant switching via @mention:

| Agent | Method | Trigger | Use Case |
|-------|--------|---------|----------|
| Claude Code | CLI | `@claude` | Code generation, complex reasoning |
| Gemini | CLI + API | `@gemini` | Research, information gathering |
| Local LLM | llama-server | `@local` / `@ai` | Offline chat, task classification |
| Perplexity | Sonar API | `@perplexity` / `@search` | Web search with citations |
| Codex | CLI | `@codex` | Code assistance (optional) |

**Default agent (no @mention):**
- Local LLM enabled → Local LLM handles chat, delegates code/research to CLI
- Local LLM disabled → Gemini CLI (free tier, easy setup, natural language)

**Recommended Local LLM:** Gemma 3 4B IT (Q4_K_M) — best Japanese instruction-following in the 3-4B class.

---

## Command Safety System

Pre-execution risk analysis with 5 danger levels + post-execution recovery suggestions:

| Level | Action | Recovery |
|-------|--------|----------|
| CRITICAL | Block + confirm | N/A (prevented) |
| HIGH | Confirmation dialog | git reflog, force-with-lease tips |
| MEDIUM | Warning | Permission fix guides |
| LOW/SAFE | Pass | N/A |

---

## Git Assistant

Natural language Git tutoring via `@git`:

- **5 Core Intents** (commit, push, status, diff, help): Full guided workflow with action buttons
- **11 Advanced Intents** (branch, merge, undo, etc.): Delegated to AI agents with example prompts

---

## @team Table — Multi-Agent Consensus

Sends the same prompt to all enabled AI agents in parallel. Facilitator AI generates unified summary shown first, individual responses shown after.

---

## Responsive Design

Optimized for Samsung Galaxy Z Fold6:

| Layout | Width | Behavior |
|--------|-------|----------|
| Compact | < 380dp | Cover screen, small phones. Single column. |
| Standard | 380-599dp | Regular phones. Single column. |
| Wide | >= 600dp | Tablets, Fold6 inner screen. Multi-pane available. |

---

## Why Shelly Exists

**The problem:** Mobile development never took off — not because of hardware limits, but because of UX.

1. **Input:** Typing code on a phone keyboard is painful. Shelly solves this — talk naturally, AI writes code.
2. **Terminal access:** Termux exists but is unusable for non-developers. Can't even type Japanese. Shelly wraps it in a chat UI.
3. **The idea itself:** "Develop on a phone" sounded absurd until local LLMs fit in 4GB RAM. Shelly is built for this moment.

**Resource usage:**

| Component | RAM | Notes |
|-----------|-----|-------|
| Shelly APK | ~40MB | UI only |
| Termux + Node Bridge | ~130MB | Idle |
| + Gemini CLI | ~150-200MB | On demand |
| + Claude Code | ~200-300MB | On demand |
| + Local LLM (4B) | ~5GB | Always loaded |

Without local LLM: ~500MB total. Works on 4GB RAM phones.
With local LLM: ~5.5GB. Needs 8GB+ RAM.

---

## Development Environment

```
Device:     Samsung Galaxy Z Fold6 (RAM 12GB)
OS:         Android 14
Terminal:   Termux
Editor:     Claude Code (CLI) running in Termux
Runtime:    Node.js 22
Package:    pnpm 9.12
Build:      GitHub Actions (EAS Build)
TypeScript: Strict mode, 0 errors
```

---

## Summary

Shelly = ChatGPT UI + real terminal execution.

Chat for beginners. Terminal for pros. Both connected to the same AI backbone and the same Linux filesystem. Built entirely on a phone, for phones.
