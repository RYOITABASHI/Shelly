# Chelly — Design Spec

**Date**: 2026-04-10
**Status**: Draft
**Repository**: https://github.com/RYOITABASHI/Chelly (to be created)

## Overview

Chelly is a standalone Android app that lets users accomplish anything through natural language. Users type what they want in a chat interface, an LLM translates it into shell commands, and the app executes them invisibly. The user never sees a terminal — only the conversation and results.

**Core loop**: User message → LLM → command(s) → execute → show result

## Design Philosophy

- **Zero-state users**: No technical knowledge required. Termux, terminal, shell — these words never appear in the UI.
- **Instant start**: Gemini API key (free) を AI Studio で取得 → 貼るだけで即使える。アプリ内に取得手順をガイド表示。
- **Invisible execution**: Commands run behind the scenes. Results shown in chat with Manus/NotebookLM-style fold-out for execution details.
- **Safe by default**: Destructive commands require user confirmation. Workspace sandbox limits blast radius.

## Target Users

Non-engineers who want to use their phone to create, automate, and build things using natural language. Engineers who want a faster mobile workflow are a secondary audience.

---

## Architecture

```
┌─────────────────────────────────────┐
│            React Native (Expo)       │
│  ┌───────────┐  ┌────────────────┐  │
│  │  Chat UI   │  │  Result Cards  │  │
│  │ (NativeWind)│  │  (fold-out)   │  │
│  └─────┬─────┘  └───────┬────────┘  │
│        │                 │           │
│  ┌─────▼─────────────────▼────────┐  │
│  │      AI Dispatch (Zustand)      │  │
│  │  Gemini│Claude│Groq│Cerebras│  │
│  │  Perplexity│LocalLLM│Arena     │  │
│  └─────────────┬──────────────────┘  │
│                │                     │
│  ┌─────────────▼──────────────────┐  │
│  │    Exec Bridge (Kotlin/JNI)    │  │
│  │    shelly-exec.c (fork+pipe)   │  │
│  │    linker64 trick              │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Framework | Expo 54 / React Native 0.81 |
| Language | TypeScript |
| Styling | NativeWind (TailwindCSS 3) |
| State | Zustand + AsyncStorage |
| LLM (primary) | Gemini API (API key, free tier) |
| LLM (secondary) | Claude, Groq, Cerebras, Perplexity, Local (Ollama) |
| Execution | JNI fork+exec+pipe (shelly-exec.c) |
| Binary bootstrap | linker64 trick (no Termux dependency) |
| Package manager | pnpm 9.12 |

---

## Modules

### 1. Chat UI

Copied and simplified from Shelly's `chelly/` directory.

**Files to copy**:
- `ChatScreen.tsx` — main screen (simplify: remove terminal context injection)
- `ChatBubble.tsx` — message rendering with fold-out execution details
- `ChatMessageList.tsx` — FlatList with auto-scroll
- `ChatHeader.tsx` — session title, settings access
- `CommandInput.tsx` — text input with send button, file/image attach

**Files to create new**:
- `ExecutionCard.tsx` — Manus-style fold-out showing command + output + exit code

**Store**: `chat-store.ts` — copied from Shelly, rename storage key to `chelly_chats`.

**Simplifications vs Shelly**:
- Remove `approvalData` (no terminal approval proxy needed)
- Remove `wizardType`/`wizardData` (Actions wizard is separate)
- Remove `arenaId` from core — Arena is a separate feature module
- Remove terminal context injection from message dispatch
- No multi-session (single conversation, persisted to AsyncStorage, restored on launch, clear to reset)

### 2. AI Dispatch

Core orchestration hook. Copied from Shelly's `use-ai-dispatch.ts` with heavy simplification.

**LLM routing**:
- **Gemini** (default): API key (free tier). `lib/gemini.ts`
- **Claude**: API key (settings). `lib/claude.ts` (new, direct API — not CLI)
- **Groq**: API key (settings). `lib/groq.ts`
- **Cerebras**: API key (settings). `lib/cerebras.ts`
- **Perplexity**: API key (settings). `lib/perplexity.ts`
- **Local LLM**: Ollama URL (settings). `lib/local-llm.ts`
- **Arena**: Multi-provider simultaneous. `lib/arena-selector.ts`

**System prompt strategy**:
The system prompt instructs the LLM to:
1. Understand the user's intent
2. Generate shell commands to accomplish it
3. Return a structured response: explanation + commands + expected outcome

Format: Gemini function calling (preferred) or JSON fallback.

Gemini function calling schema (requires Gemini 1.5+ / 2.x):
- `execute_commands(commands: [{cmd, desc, timeout?}])` — run shell commands
- `respond(text)` — plain text reply (no commands needed)

**Model version handling**: Function calling requires `gemini-2.5-flash` or later. If the user's selected model doesn't support function calling, fall back to JSON prompting automatically. Model capability is detected at first API call and cached.

Fallback (non-Gemini providers or older models): JSON `{ explanation, commands: [{ cmd, desc }], summary }`.

**JSON parse failure handling**: If the LLM response is not valid JSON, treat the entire response as plain text (no command execution). This gracefully handles conversational replies that break out of the JSON format.

The dispatch hook:
1. Sends user message + conversation history + cwd to LLM
2. Parses structured response (function call or JSON)
3. Safety check: classify commands → auto-execute safe, confirm destructive
4. Executes commands sequentially via Exec Bridge (with cwd)
5. Shows progress indicator for long-running commands
6. Streams results back to chat
7. If a command fails, asks LLM for recovery

**Removals vs Shelly**:
- No `TerminalEmulator.getTranscriptText()` (no terminal)
- No `useTerminalStore` dependency
- No CLI-based Claude invocation (direct API instead)
- No input-router / terminal-intent detection
- No decision-log integration

### 3. Exec Bridge (Native Module)

Kotlin + JNI module for command execution. Copied from Shelly's `terminal-emulator` module, keeping only the exec path.

**Files to copy**:
- `shelly-exec.c` → rename to `chelly-exec.c`
- `ShellyJNI.kt` → rename to `ChellyJNI.kt`
- `TerminalEmulatorModule.kt` → simplify to `ExecModule.kt` (only `execCommand`)

**What to remove**:
- All PTY code (`shelly-pty.c`, `termux.c`)
- All terminal emulation Java classes (`TerminalBuffer`, `TerminalRow`, etc.)
- `TerminalView`, `ShellyTerminalSession`
- GPU rendering, block rendering
- Agent/alarm code

**Binary bootstrap**:
- linker64 path detection (same as Shelly)
- APK-bundled `bash`, basic coreutils
- Deferred download for Python, Node, etc. when first needed

**Expo module interface**:
```typescript
// modules/exec-bridge/src/ExecBridgeModule.ts
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function execCommand(command: string, cwd?: string, timeoutMs?: number): Promise<ExecResult>;
```

**cwd tracking**: The dispatch hook maintains a `currentCwd` state (default: `~/chelly/workspace/`). When the LLM generates a `cd` command, the hook detects it and updates `currentCwd`. All subsequent `execCommand` calls pass this cwd.

**cwd persistence**: `currentCwd` is stored in `settings-store` (AsyncStorage) and restored on app launch. This means if the user was working in `~/chelly/workspace/myproject/`, closing and reopening the app resumes there.

**Timeout**: Default 30 seconds (not 120). LLM can request longer via a `timeout` field in the command object for known slow operations (package installs, builds).

**Bug fix (inherited from Shelly)**: `chelly-exec.c` line 270 — `stdout_buf[stdout_len] = '\0'` may write past allocation when buffer is exactly full. Fix: realloc to `len + 1` before null-terminating.

### 4. Auth & API Keys

**Primary flow** (Gemini):
1. App launches → Welcome screen with "Get Started" button
2. Shows inline guide: "Gemini APIキーを取得（無料）" with link to AI Studio
3. User pastes API key → stored in expo-secure-store
4. Ready to use

**UX for zero-state users**: The guide is visual (screenshots/arrows), step-by-step, and takes under 2 minutes. The key acquisition flow is the only "setup" step.

**Secondary providers**:
- Settings screen with API key input fields for Claude, Groq, Cerebras, Perplexity
- Keys stored in expo-secure-store
- Local LLM: just URL input (no auth)

### 4.5. Command Safety

**Sandbox**: Default working directory is `~/chelly/workspace/`. All LLM-generated commands execute here unless the user explicitly navigates elsewhere.

**Classification**:
- **SAFE**: read-only commands (`ls`, `cat`, `pwd`, `echo`, `python script.py`)
- **WRITE**: file creation/modification (`mkdir`, `touch`, `cat >`, `pip install`) → auto-execute
- **DESTRUCTIVE**: deletion, system modification (`rm`, `chmod`, `kill`, `dd`, `curl|sh`) → require user confirmation

**Blocklist** (always blocked):
- `rm -rf /`, `rm -rf ~`, `dd if=`
- `curl ... | sh`, `wget ... | bash` (pipe-to-shell)
- Commands targeting paths outside `~/chelly/`

**Confirmation UI** (for DESTRUCTIVE commands):
- Chat bubble with: 「このファイルを削除します。よろしいですか？」+ [実行] / [キャンセル]
- Explanation is always non-technical: what will happen, not what command runs
- Example: `rm -rf node_modules` → 「不要なファイル（約200MB）を削除してスペースを空けます」

**Block UI** (for blocklisted commands):
- 「この操作は安全上の理由で実行できません。別の方法を試します。」
- LLM に自動リトライ指示（ブロック理由付き）→ 代替コマンドを生成させる

**Implementation**: `lib/command-safety.ts` — regex-based classification, imported from Shelly's existing `checkCommandSafety()` with Chelly-specific additions.

### 5. File Browser

Copied from Shelly. Shows files created/modified by commands.

**Trigger**: After command execution that creates/modifies files, show a file card in chat.
**Capabilities**: View file contents, basic preview (images, HTML, text).

### 6. Arena Mode

Multi-LLM comparison. Copied from Shelly's arena implementation.

**Flow**: User sends message → dispatched to 2+ providers simultaneously → results shown side-by-side → user picks winner.

**Simplification**: Remove terminal-specific arena scoring. Keep it as pure response comparison.

### 7. GitHub Actions

Wizard for setting up CI/CD. Copied from Shelly's `ActionsWizardBubble`.

**Flow**: User says "set up CI" → wizard guides through: what (build/test/deploy) → when (push/daily/manual) → generates workflow YAML → commits via exec bridge.

### 8. Voice Input

Uses device speech-to-text. Message transcribed → sent as normal chat message.

**Implementation**: Android native `SpeechRecognizer` API via Expo Native Module. `@react-native-voice/voice` はメンテナンスが不安定なため、直接 Android SpeechRecognizer を Kotlin で薄くラップする（`modules/voice-input/`）。Expo SDK 54 との互換性問題を回避。

### 9. Runtime Manager (Deferred Download)

Handles downloading language runtimes when first needed.

**Flow**:
1. User says "write a Python script"
2. LLM generates commands that need Python
3. Exec bridge tries to run → fails (no Python)
4. Runtime manager detects missing runtime
5. Shows "Installing Python..." in chat
6. Downloads pre-built binary from GitHub Releases
7. Retries command

**Supported runtimes (v1)**:
- Python 3.x
- Node.js (LTS)
- Git

**Storage**: `~/chelly/runtimes/`

**Safety**:
- Show download size and ask for confirmation before downloading
- SHA256 checksum verification for all downloaded binaries
- Graceful failure: "Could not install Python. Check your connection and try again."
- Wi-Fi推奨: ダウンロード開始前に「Wi-Fi接続をおすすめします（約50MB）」と表示。モバイルデータでも「このままダウンロード」ボタンで強制DL可能

---

## Project Structure

```
Chelly/
├── app/
│   ├── _layout.tsx          # Root layout (single screen)
│   ├── index.tsx            # Chat screen (main & only screen)
│   └── settings.tsx         # Settings modal
├── components/
│   ├── ChatBubble.tsx
│   ├── ChatMessageList.tsx
│   ├── ChatHeader.tsx
│   ├── CommandInput.tsx
│   ├── ExecutionCard.tsx     # Manus-style fold-out
│   ├── FileBrowser.tsx
│   ├── FilePreview.tsx
│   ├── ArenaBubble.tsx
│   ├── ActionsWizard.tsx
│   └── RuntimeInstaller.tsx  # "Installing Python..." UI
├── hooks/
│   ├── use-ai-dispatch.ts   # Core AI orchestration
│   └── use-exec.ts          # Exec bridge hook
├── lib/
│   ├── gemini.ts            # Gemini API client
│   ├── claude.ts            # Claude API client (direct, not CLI)
│   ├── groq.ts              # Groq API client
│   ├── cerebras.ts          # Cerebras API client
│   ├── perplexity.ts        # Perplexity API client
│   ├── local-llm.ts         # Ollama client
│   ├── arena-selector.ts    # Arena mode logic
│   ├── system-prompt.ts     # System prompt generation
│   ├── command-safety.ts    # Command classification & blocklist
│   ├── runtime-manager.ts   # Deferred runtime download
│   └── id.ts                # ID generation
├── store/
│   ├── chat-store.ts        # Chat sessions & messages
│   ├── settings-store.ts    # API keys, preferences
│   └── arena-store.ts       # Arena state
├── modules/
│   └── exec-bridge/
│       ├── android/
│       │   ├── src/main/jni/chelly-exec.c
│       │   ├── src/main/java/.../ChellyJNI.kt
│       │   ├── src/main/java/.../ExecModule.kt
│       │   └── CMakeLists.txt
│       ├── src/ExecBridgeModule.ts
│       └── expo-module.config.json
├── assets/
│   └── icon.png
├── app.config.ts
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── README.md
```

---

## Data Flow

### Happy Path: "Create a Python script that counts to 10"

```
1. User types message
2. ChatInput → chat-store.addMessage(user)
3. use-ai-dispatch → gemini.ts (with system prompt + history)
4. Gemini returns:
   {
     explanation: "I'll create a Python script for you",
     commands: [
       { cmd: "cat > count.py << 'EOF'\nfor i in range(1,11): print(i)\nEOF", desc: "Create count.py" },
       { cmd: "python3 count.py", desc: "Run the script" }
     ]
   }
5. use-exec → ExecBridge.execCommand("cat > count.py ...")
   → exit 0, stdout: ""
6. use-exec → ExecBridge.execCommand("python3 count.py")
   → exit 0, stdout: "1\n2\n3\n...\n10\n"
7. chat-store.addMessage(assistant):
   content: "Done! Here's the output:"
   executions: [
     { command: "cat > count.py ...", output: "", exitCode: 0 },
     { command: "python3 count.py", output: "1\n2\n...", exitCode: 0 }
   ]
8. ChatBubble renders: explanation + ExecutionCard (folded)
```

### Error Recovery: Missing Runtime

```
1. Step 6 fails: python3 not found (exit 127)
2. runtime-manager detects "python3" → not installed
3. Chat shows: "Python is not installed yet. Setting it up..."
4. runtime-manager downloads Python from GitHub Releases
5. Retries command → success
6. Normal result display
```

---

## System Prompt

```
You are Chelly, a helpful assistant that accomplishes tasks on the user's Android device.

You have two tools:
1. execute_commands — run shell commands on the device
2. respond — reply with text only (no commands needed)

## When to use execute_commands
- File creation, editing, deletion
- Running scripts (Python, Node, etc.)
- Package installation
- Git operations
- Any task that requires system interaction

## When to use respond
- Answering questions ("What is X?")
- Explaining concepts
- Casual conversation
- When no action is needed

## Command rules
- Commands must work with sh/bash
- Use absolute paths when possible
- For file creation, use heredoc (cat << 'EOF')
- Working directory is provided as context — use relative paths within it
- For long-running commands (installs, builds), set timeout > 30

## Style rules
- Keep explanations concise and non-technical
- Never reference "terminal", "shell", "command line", or "Termux"
- Speak the user's language (detect from their message)
- You're helping someone who may have never programmed before
```

## Context Management

Conversation history sent to LLM is limited to the last 20 messages. Each message in context is truncated to 500 characters max to prevent prompt bloat.

**Upper limit behavior**: When the conversation exceeds 20 messages, older messages are silently dropped from the LLM context (not from the UI — the user can still scroll back). No notification is shown. The LLM may lose track of earlier context, but this is acceptable for v1. If the user needs to reference old context, they can copy-paste it.

---

## What's NOT in v1

- Terminal display (PTY rendering) — Chelly is chat-only
- Multi-session — single conversation, clear to reset
- Streaming terminal output — commands return results, not live streams
- Project context auto-detection (`.chelly/context.md`) — may add in v2
- User profile learning — may add in v2
- Background agents — not needed without terminal

---

## OSS Considerations

- **License**: MIT
- **Bundle ID**: `dev.chelly.app`
- **Package name**: `chelly`
- **Repository**: `RYOITABASHI/Chelly`
- **Distribution**: GitHub Releases (APK), F-Droid
- **No Play Store** (same reasoning as Shelly)
