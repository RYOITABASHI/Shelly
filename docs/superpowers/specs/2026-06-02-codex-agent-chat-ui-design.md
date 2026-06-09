# 2026-06-02 — Codex Agent Chat UI design

## Decision

Build the next Codex interaction surface inside Shelly itself, not through
Galaxy Watch first.

The first implementation should be a pane-native, LINE-like **Agent Chat**
for the foreground Codex CLI. It should show the useful conversational output
from Codex and let the user reply from a normal text input.

This is not a hidden background Codex worker. Codex remains a user-controlled
foreground terminal CLI backed by a real native PTY.

## Why This Shape

The user need is not a second AI provider. The need is a less noisy way to
drive the existing Codex TUI:

- Terminal remains the source of truth and recovery path.
- Agent Chat presents only the conversational layer: user prompts, Codex
  replies, status, tool activity, approvals, and errors.
- Type-less or any other external input tool can type into the same
  `TextInput`. Shelly does not need a voice-input feature for V1.
- Galaxy Watch can later consume the same event/reply model, but it should
  not be part of the first implementation.

## Non-goals For V1

- No Galaxy Watch app, Tile, or watch-side chat.
- No Shelly-owned voice input, microphone button, or speech recognition
  pipeline.
- No change to Codex authentication semantics.
- No silent/background Codex execution using subscription access.
- No attempt to replace the Terminal pane.
- No blind text injection into an unknown PTY state.

## Existing Repo Anchors

### Pane and UI

- Pane registry:
  `components/multi-pane/pane-registry.ts`
- Pane type union:
  `hooks/use-multi-pane.ts`
- Current chat-like UI pattern:
  `components/panes/AIPane.tsx`
- Shared input bar:
  `components/panes/PaneInputBar.tsx`
- Broader multiline input reference:
  `components/input/CommandInput.tsx`
- Per-pane conversation store pattern:
  `store/ai-pane-store.ts`
- Reusable message shape:
  `store/chat-store.ts`

### Terminal and Codex Session Control

- Native module surface:
  `modules/terminal-emulator/src/TerminalEmulatorModule.ts`
- Native session creation/write/paste:
  `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt`
- PTY output event emission:
  `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyTerminalSession.kt`
- JS terminal output subscription:
  `hooks/use-terminal-output.ts`
- Terminal write/paste usage:
  `components/panes/TerminalPane.tsx`

### Codex JSONL and Scouter

- Codex session watcher:
  `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/JsonlWatcher.kt`
- Codex JSONL parser:
  `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/JsonlSessionParser.kt`
- Scouter state persistence:
  `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterStateStore.kt`
- Scouter debug UI:
  `components/scouter/ScouterDetailModal.tsx`

## Product Model

Agent Chat is a new pane type, tentatively `agent-chat`.

It binds to one foreground Codex terminal session and provides:

- user prompt bubbles
- Codex assistant message bubbles
- status rows such as thinking, running tool, waiting for input, failed
- tool/action summaries
- approval prompts when Codex asks for confirmation
- a normal bottom text input
- an "Open Terminal" affordance for raw recovery/debugging

The terminal pane still exists and still displays the real TUI. Agent Chat is
a readable control layer over that session, not a replacement for the PTY.

## Data Contract

Define a JS/native event shape before UI work:

```ts
type AgentChatEvent = {
  id: string;
  source: 'codex';
  codexSessionId: string;
  ptySessionId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind:
    | 'user_message'
    | 'assistant_message'
    | 'status'
    | 'tool_start'
    | 'tool_result'
    | 'approval'
    | 'error';
  text: string;
  status?: 'idle' | 'thinking' | 'tool_running' | 'waiting_input' | 'error';
  toolName?: string;
  timestamp: number;
  rawEvent?: unknown;
};
```

This contract intentionally does not mention Watch. If Watch support is added
later, it should consume this same event stream.

## Session Binding

The hard part is not drawing chat bubbles. The hard part is safely connecting
these three identities:

- Shelly terminal session id, for example `shelly-1`
- native PTY session id
- Codex JSONL session id from `~/.codex/sessions`

Do not guess only by current working directory. The preferred path is:

1. When Shelly launches or detects a foreground Codex session, record:
   `{ ptySessionId, shellySessionId, cwd, startedAt }`.
2. When a new Codex JSONL file appears, reconcile it with recent foreground
   Codex launches using `cwd` and timestamp.
3. Store the binding in a small Agent Chat store.
4. Refuse chat replies when no reliable binding exists.

## Reply Path

Replies must go to the active Codex PTY only when that session is in a safe
input state.

Implementation guidance:

- Single-line reply:
  `TerminalEmulator.writeToSession(ptySessionId, text + "\n")`
- Multi-line reply:
  `TerminalEmulator.pasteToSession(ptySessionId, text)`, then
  `TerminalEmulator.writeToSession(ptySessionId, "\n")`
- If Codex is running a tool, editing, or not mapped to a PTY, show "not
  ready" instead of sending text.
- Keep an "Open Terminal" button next to the status so the user can recover
  from any ambiguous state manually.

## Text Input Strategy

V1 should expose only a normal `TextInput`.

That means:

- no new microphone permission
- no new audio focus lifecycle risk
- no dependency on Groq Whisper for this feature
- no custom speech UI required

The Agent Chat input should be multiline-friendly and should not disable IME
composition. If the user uses Type-less, Shelly only receives the resulting
text. There should be no mic button or voice state in Agent Chat V1.

## Implementation Phases

### Phase 0 — Design and Contracts

- Add this design document.
- Define the event/store shape.
- Keep Watch explicitly deferred.

Expected builds: 0.

### Phase 1 — Read-only Agent Chat Pane

- Add `agent-chat` pane type to the pane registry and pane type union.
- Add `components/panes/AgentChatPane.tsx`.
- Add `store/agent-chat-store.ts`.
- Initially populate the pane from Scouter/Codex JSONL snapshots or a narrow
  native getter.
- Show status/tool/message bubbles, but no reply input yet.

Expected builds: 2-3.

### Phase 2 — Live Codex Event Bridge

- Add native `onScouterEvent` or a narrower `onAgentChatEvent`.
- Extend `TerminalEmulatorModule` event declarations.
- Preserve existing Scouter widget/state behavior.
- Convert Codex JSONL payloads into ordered `AgentChatEvent` records.

Expected builds: 2-3.

### Phase 3 — Session Binding

- Record foreground Codex launches and PTY identity.
- Reconcile Codex JSONL sessions with PTY sessions.
- Display binding state in Agent Chat.
- Require reliable binding before enabling replies.

Expected builds: 1-2.

### Phase 4 — Text Reply

- Add input bar.
- Send replies through `writeToSession`/`pasteToSession`.
- Disable send while Codex is not ready.
- Add "Open Terminal" and "Stop/Interrupt" affordances if safe.

Expected builds: 2-3.

### Phase 5 — Input Polish

- Ensure the input works with Japanese composition and Type-less output as
  plain text.
- Add localized empty states and labels.
- Add accessibility labels.
- Do not add custom STT or a mic button.

Expected builds: 1-2.

## Estimated Effort

Phone-only practical V1:

- 10-16 person-days
- 5-8 CI/APK build cycles

Minimal read-only preview:

- 4-7 person-days
- 2-4 CI/APK build cycles

Adding Shelly-owned speech recognition or Watch support should be treated as a
separate follow-up, not part of this first branch.

## Verification Plan

Use staged verification. Do not wait until the whole feature is built.

- `pnpm check`
- `./gradlew :app:compileDebugKotlin`
- Launch Shelly on device
- Start Codex in a terminal pane
- Confirm Agent Chat sees the same Codex session
- Confirm assistant messages appear as ordered bubbles
- Confirm tool-running and error states are represented
- Confirm Japanese IME composition works in the input
- Confirm Type-less can enter text into the input as normal text
- Confirm reply goes to the correct Codex session
- Confirm reply is blocked when binding is missing or Codex is busy
- Confirm raw Terminal recovery still works

## Risks

- Codex JSONL schema can change. Keep parsing tolerant and fail visibly.
- Terminal bytes alone are too noisy for reliable chat extraction. Prefer
  JSONL events for assistant/tool state.
- PTY reply routing can be dangerous if the target session is ambiguous.
  Binding and ready-state checks are required before enabling send.
- Existing `AIPane` intentionally keeps Codex out of API-provider chat.
  Agent Chat must remain a distinct PTY-backed surface.
- Hardcoded UI strings have historically slipped in. New user-facing labels
  should use `lib/i18n/locales/en.ts` and `lib/i18n/locales/ja.ts` from the
  first implementation commit.

## Deferred Follow-ups

- Galaxy Watch notification reply.
- Wear OS app or Tile.
- Shelly-owned microphone button and STT.
- Push notification style background agent updates.
- Cross-device Codex session control.
