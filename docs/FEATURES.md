# Feature Details

Full feature-by-feature breakdown for [Shelly](../README.md). The [README's Highlights table](../README.md#features) covers the pitch-level summary; this file is the detail underneath each one. See [Status](STATUS.md) for what's actually been verified on real hardware.

<details>
<summary><strong>Scouter Widget — what it shows</strong></summary>

- **Header** — a status dot (green, or red with a failure-count badge when any shown agent's last run errored) and the "AGENTS" title
- **Up to 3 agent rows** — name, a last-run status glyph (✓ success / ✗ error / • skipped-or-transient / – never run), and either the next scheduled fire time or a live elapsed-seconds counter while that agent is running
- **RUN per row** — starts that row's agent directly through the same unattended execution gates a scheduled alarm fire uses
- **ASK** — opens a lightweight prompt dialog to send a Codex prompt or register a new `@agent`
- **Decorative pet** — an optional imported/bundled Codex pet image renders in the widget; it is display-only (no tap-to-cycle) as of the 2026-07-18 redesign

</details>

<details>
<summary><strong>Scouter Widget — interactive control</strong></summary>

- **ASK** — tap ASK to open a prompt dialog; Shelly writes the text into the bound foreground Codex terminal (clear line, paste, Enter) and returns you to the launcher
- **`@agent` registration from ASK** — type or speak `@agent ...` into the ASK box instead of a plain prompt, and it hands off to the same AI Pane `parseAgentCommand`/confirm-card flow used when you type `@agent` directly, instead of landing in the Codex PTY. An opt-in **Widget No-Confirm Register** setting (off by default) skips the confirm card for widget-originated `@agent` commands only and registers immediately with a post-registration notification; typing `@agent` directly in the AI Pane always confirms regardless of this setting.
- **Voice input for ASK** — the ASK dialog's mic button uses Android's built-in speech recognizer; the recognized text lands in the field for you to review and edit, never auto-submitted.
- **RUN scheduled agent** — starts an agent directly through the foreground service without opening the app; Shelly revalidates its disk metadata at tap time, honors STOP-ALL, and keeps unattended per-action approval fail-closed. By design, unattended runs default to OAuth/local tools only — an agent that would use a cloud API key (Gemini, Perplexity, …) unattended falls back to Codex instead unless the opt-in **Autonomous Cloud** setting (off by default) allows the cloud call.
- **Cold-start ASK** — if no Codex or Agent Chat session is available, Shelly queues the widget prompt, opens a terminal, waits for the PTY to become alive, starts `codex`, waits for the Codex input surface, then delivers the queued prompt
- **Resume when unbound** — if the bound terminal has exited, a queued ASK prompt opens Agent Chat to resume the session, then drains the queued prompt
- **Approvals and choices** — no longer surface as widget pills; use the Codex notification channels' one-tap Allow/Deny buttons and numbered actions, or the in-app Agent Chat pane's Approve/Deny bubbles
- **How controls are dispatched** — ASK writes to the live PTY through the in-process terminal session registry; RUN uses a direct foreground-service PendingIntent matching scheduled fires. Neither path shells out through `am start`

</details>

<details>
<summary><strong>Layout System</strong></summary>

- **Single-screen layout** — AgentBar (top) + Sidebar (left, collapsible) + PaneContainer (center) + ContextBar (bottom)
- **9 pane types** — Terminal (native PTY), Agent Chat (Codex session companion), AI (streaming + context injection), Browser (WebView + bookmarks + background audio), Markdown (viewer), Preview (Code / Image / PDF / CSV / Markdown renderers), Ask (Shelly help), Agent Runs (browsable per-agent run history, logs, routing and step/action detail), and Memory Workbench (search, view, edit, and delete an agent's own notes, the shared `_global` notes, and the companion's own `_companion` journal — reachable from Settings → Companion Memory even with zero registered agents)
- **Preset slot layout** — up to 4 live panes in single, two-column, three-pane, or four-pane presets; drag the accent-green grip to resize, double-tap it to restore 50/50
- **Layout presets** — Single Terminal / Terminal + AI / Terminal + Browser / 3-Way Triple, all reachable from the Command Palette
- **Pane-type pill** — header left shows `[TERMINAL ▾]` / `[AI ▾]` / …; tap to change the pane type in place
- **CLI tab strip inside terminal panes** — multiple shell tabs per pane, `[● SHELL][+]`, close `×` on non-last tabs
- **Empty-pane recovery** — the last pane cannot be closed; if the tree ever empties, a 3-button CTA (Terminal / AI / Browser) brings it back
- **ContextBar** — always-visible footer showing cwd, git branch, and connection status

</details>

<details>
<summary><strong>Cross-Pane Intelligence</strong></summary>

- **"Fix the error on the right"** — AI reads the current terminal transcript and responds with executable fixes
- **ActionBlock** — code blocks in AI responses get `[▶ Run]` buttons that dispatch to the active terminal pane
- **Pane-aware terminal selection** — in split layouts, the AI pane prefers the terminal immediately to its left, then the focused terminal, then the first terminal
- **Real-time terminal awareness** — AI pane snapshots the terminal transcript on dispatch so the model sees what you just saw
- **Terminal-safe context** — ANSI/OSC/control sequences and TUI redraw noise are stripped before injection; terminal output is treated as untrusted evidence, not instructions
- **Local LLM compaction** — `@local` keeps important header/status/error lines and the recent tail so small on-device models still see the useful terminal state
- **Auto-savepoint** — every edit is auto-committed to a hidden git index so you can revert to any point with one tap
- **Pre-commit secret scan** — API keys, private keys, and other secrets are blocked before they land in a savepoint commit

</details>

<details>
<summary><strong>Agent Chat — chat surface for the bound Codex terminal</strong></summary>

- **Chat over the foreground Codex** — a chat-style pane that mirrors the bound Codex session's timeline (user prompts, Codex replies, tool runs, approvals, errors) parsed from the session JSONL and Scouter snapshots
- **Reply composer** — type a reply and send; it writes to the bound foreground Codex PTY, not a hidden API worker — consistent with Shelly's compliance boundary
- **READY / LOCKED** — a pill shows whether the bound terminal can accept a reply; when locked, the composer explains why (terminal exited, Codex busy, waiting on a terminal choice, not bound yet)
- **Approve / Deny** — approval requests surface as bubbles with Allow / Deny buttons that send the decision to the bound Codex terminal; only the latest pending approval is actionable
- **Interrupt** — a stop button sends a terminal interrupt to the bound Codex while it is working
- **Resume** — the play button reopens or focuses the bound Codex terminal for the selected session, rebinding it for replies
- **Session tabs** — recent Codex sessions are shown as tabs (deduped per workspace + model), each with a binding dot; dismiss hides a session from Agent Chat without touching its JSONL on disk
- **Session strip** — project, status, binding, model, token count, and last-update time for the selected session

</details>

<details>
<summary><strong>AI Edit — file edit with Accept / Reject</strong></summary>

- **Staged file** — tap a file in the FileTree; it opens in the Preview pane's Code tab. The `[✨ AI]` toolbar button stages the file in the AI pane's context.
- **Dispatch** — write "make the first function Japanese-comment" (or anything) and send. Shelly's system prompt asks the model to respond with a unified diff.
- **InlineDiff** — the assistant reply is scanned for unified diff blocks and each hunk is rendered with `+` / `-` / context coloring plus Accept / Reject buttons.
- **Per-hunk accept writes to disk** — accepting one hunk calls `acceptStagedDiff()` with a re-serialised single-hunk diff; the file is rewritten via the native `writeFileNative` bridge and the Preview pane auto-reloads.
- **Fuzzy re-anchor** — if the `@@ -N` line numbers are stale (because a previous hunk already edited the file on disk), the applier searches forward for the hunk's leading context block so successive hunks still land.
- **Accept All** — takes the same write-back path but applies every pending hunk in one pass.

</details>

<details>
<summary><strong>Terminal Enhancements</strong></summary>

- **Fig-style autocomplete** *(not currently implemented — see `docs/superpowers/DEFERRED.md`)* — the completion engine (`lib/autocomplete-engine.ts`) and command database exist and are reusable, but the terminal input path is a native PTY passthrough (`NativeTerminalView`) with no JS-visible input buffer/cursor, so reviving the popup requires a scoped native (Kotlin) change to stream the in-progress command line to JS
- **Syntax highlighting** — terminal output colorized by content type
- **Clickable paths and errors** — tap a file path or stack trace line to jump to it
- **Content blocks** — JSON, markdown, images, and tables from command output render as formatted blocks in the **Block History** panel, an overlay opened via the terminal pane's FAB, not literally inline in the scrolling PTY output
- **CLI notifications** — long-running commands surface a system notification when they complete
- **Codex notification channels** — Scouter posts per-category Android notifications, each on its own channel so you can tune importance / sound / mute from Android's notification settings: approvals, choices, and errors arrive as heads-up alerts, rate limits at default importance, completions and long-running quietly. Approval notifications carry one-tap **Allow / Deny** buttons and choice notifications expose the first three numbered actions. The expanded notification view shows the full request or menu text, and resolved cards are deduped and cancelled so nothing stacks or lingers. (Choice/approval pills were removed from the widget face itself in the 2026-07-18 redesign — see the Scouter Widget section above; use these notification channels or the in-app Agent Chat pane instead.)
- **SmartKeyBar** — 4 context-adaptive key sets by default (Default / Git / REPL / Navigate), swipe to switch; a 5th (Vim) is available via Settings → Terminal → "Show Vim key bar" (off by default, to avoid cluttering the bar for non-Vim users)
- **Immortal sessions** — tmux keeps your shell alive when the app is backgrounded; resume any session by name
- **Japanese input in terminal** — compose CJK characters directly in the terminal pane
- **Readable terminal glyphs** — the native Kotlin terminal view renders the PTY grid with JetBrains Mono so lowercase, columns, and code output stay legible
- **Atomic paste** — all paste paths converge on `TerminalEmulator.paste()`. When the guest shell has bracketed-paste mode on (DECSET 2004), the payload is wrapped so multi-line commands arrive as one event and readline executes only the trailing newline; shells/TUIs that don't advertise it (vim, less, nano) get a newline-normalized fallback instead. IME multi-line or ≥16-char commits, middle-click mouse paste, and the CommandKeyBar **Paste** key all reach the same normalizer.

</details>

<details>
<summary><strong>AI Pane</strong></summary>

- **Multi-agent routing** — the router picks the best AI for the task; override with `@mention`
- **One companion thread, one voice** — default local Shelly AI Panes resolve to `COMPANION_CONVERSATION_KEY` through `resolveAiPaneStoreKey`, so one conversation continues across panes and splits. Replies always read as **Shelly** — no provider-name tag on the bubble, whichever model actually answered (the provider name shows in the pane header for power users, not on every message). Explicit external-provider bindings (`@gemini`, etc.) keep their own independent per-pane history.
- **Carry-forward on switch** — switching a pane between the companion and an explicit provider (either direction, via the pane-header agent badge or an `@mention`) copies the last few on-topic messages from the thread you're leaving into the one you're entering, with a short system notice explaining the hand-off. It's a continuity nudge, not a full merge — idempotent (switching back and forth doesn't duplicate messages), and a pane-scoped copy doesn't survive an app restart (only the shared companion thread does).
- **Shared companion memory** — tell Shelly "remember that my deploy branch is staging"; after confirmation, it writes a `_global` note (`GLOBAL_MEMORY_SCOPE`) recalled by future companion conversations and every scheduled agent. This uses `detectCompanionMemoryWrite`; explicit all-agent commands use `detectGlobalMemoryWrite`.
- **Companion journal (automatic, no confirm needed)** — separately from the explicit "remember that…" flow above, Shelly distills what a conversation established into a short note (via the on-device local LLM) whenever a pane switches away from it, and saves it to its own `_companion` scope — read only by the companion, never fanned out to background agents. Later companion replies pull back only the notes relevant to what you're currently asking (BM25 + recency scoring, capped at 5), not a growing dump of everything ever said. Browse, edit, or delete these notes from **Settings → Companion Memory** — reachable with zero registered agents.
- **Agent results re-enter chat** — a manual **Run Now** completion is added to the shared thread by `lib/agent-companion-notice.ts`, alongside the existing OS notification, confirmed on-device; a scheduled (AlarmManager) completion ships on the same tracker and code path but hasn't been independently observed firing live yet.
- **Delete individual messages** — long-press any AI Pane message, then confirm the destructive action; `deleteMessage` removes only that message from the resolved conversation.
- **@mention** — direct AI Pane providers are `@gemini`, `@cerebras`, `@perplexity`, `@openrouter`, and `@local`; the only functioning utility routes are `@team` (fan-out to every configured provider at once) and `@agent` / `@edit` / `@code` (routes into the autonomous-agent confirm-card flow). `@git`, `@open` / `@browse`, `@plan`, `@arena` / `@battle` / `@compare`, and `@actions` / `@ci` are still recognized by the parser (syntax-highlighted, autocompleted, and given a label) but have no dispatch behavior behind them — typing one just sends the rest of the message as a normal chat to whatever provider is already bound to the pane. `@plan` and `@arena` are leftovers from `plan-store` / `arena-store`, both deleted 2026-08-10 with zero remaining call sites; `@git`'s intended "Git Guide" UI (`components/terminal/GitGuideBlock.tsx`) and its `@open`/`@browse`/`@actions`/`@ci` siblings were never wired to a trigger in the first place. There is no `@claude` — Claude Code is not a current provider. Codex remains available as the foreground terminal CLI via `codex`. (Groq is configurable as a provider but isn't wired to a `@groq` mention pattern yet.)
- **Terminal context injection** — the AI always has access to the current terminal transcript without you pasting anything
- **InlineDiff with per-hunk write-back** — see AI Edit above
- **Voice input** — long-press the mic in the terminal action bar to open VoiceChat; speech → Groq transcription → AI → TTS response
- **Local LLM support** — use the built-in GGUF catalog and llama.cpp / llama-server controls, then route via `@local` for fully on-device inference. Qwen3.5-0.8B Q4_K_M ships as the default (light enough for always-on/autonomous use), Qwen3.5-2B Q4_K_M is the recommended step-up for on-demand use, Qwen3 1.7B sits in between, and 4B/9B models are intended for short quality checks.

</details>

<details>
<summary><strong>Browser Pane</strong></summary>

- **Full WebView** — navigate any URL inside a pane; keep docs open next to your terminal
- **Bookmarks** — save and organize URLs; preset icons for YouTube, X, GitHub, and `localhost:*`
- **Background audio** — audio keeps playing when you switch panes
- **Outbound share** — share plain text (a URL, terminal output, whatever) *from* Shelly to any other Android app via the standard share sheet (there is no inbound share-target yet — Shelly does not appear in other apps' own share sheets)
- **Desktop UA toggle** — `📱` / `🖥` button in the URL row swaps the user agent so desktop-only sites behave
- **Video fullscreen** — six detection paths (W3C / WebKit / video element / monkey-patched APIs) catch YouTube-style fullscreen and maximize the pane, hiding the system nav bar

</details>

<details>
<summary><strong>File Tree</strong></summary>

- **Active-repo file list** — `ls -1pa` listing for the current working directory with per-extension icon coloring (`.tsx` sky, `.ts` blue, `.json` amber, `README.md` red, …)
- **Search** — incremental filter over the current directory
- **Open actions** — tap a Markdown file to open the Markdown pane, tap anything else to open the Preview pane's Code tab
- **Create / Rename / Delete** — `+` file and `+` folder buttons next to the search field; long-press a row for `Rename / Copy path / Delete`; modals use the active app palette
- **Breadcrumb** — tap the `..` row to go up

</details>

<details>
<summary><strong>Preview Pane</strong></summary>

- **Code tab** — per-file syntax-highlighted view with line numbers; the `[✨ AI]` button stages the current file for AI Edit
- **Markdown renderer** — `react-native-markdown-display` plus the Shelly palette
- **Image / PDF / CSV renderers** — inline viewers for common non-code attachments
- **Git diff view** — `git diff <file>` shown in the Code tab with neon `+` / `-` coloring
- **Recent files** — quick switcher inside the Preview header

</details>

<details>
<summary><strong>Sidebar</strong></summary>

- **Companion-first by default** — on a genuinely fresh install, Tasks and Skills open expanded; the developer-facing sections below (Repositories, File Tree, Device, Worktrees, Quick Launch, Codex Sessions) start collapsed under a **DEVELOPER** divider — one tap away, nothing removed, just not the first thing you see. An existing install's own open/closed choices are never touched by this default.
- **Repositories** — list of bound repo paths; tap to switch and re-root the File Tree to that repo
- **File Tree** — see above; embedded as a section so it flexes with the sidebar height
- **Tasks** — recent background-agent runs with duration and status
- **Device** — quick-access folders (`~`, `/sdcard/Download`, …) that re-bind the file tree in one tap
- **Profiles** — saved SSH connections. Tap to insert `ssh -i KEY user@host -p PORT` into the active terminal pane; long-press to edit or delete; `Import from ~/.ssh/config` bulk-adds hosts. Key-file auth only — no passwords or passphrases are persisted.

> **Cloud storage?** Shelly deliberately doesn't ship a Google Drive / Dropbox / OneDrive UI. A terminal app should lean on the tools that already solve this — Shelly has no package manager of its own, but [`rclone`](https://rclone.org) ships as a single static binary: download the `arm64` release, drop it in a directory on `PATH` (or install it via Termux alongside Shelly), run `rclone config` once, and mount or sync any of 40+ cloud backends from the terminal pane.

</details>

<details>
<summary><strong>Command Palette</strong></summary>

Opens from the search icon in the top bar (or from the AgentBar's git badge). Fuzzy search across every registered action, plus a persistent **Recent** list of the last five you ran.

Currently registered:

- **Settings** — open the terminal-style Settings TUI
- **Terminal** — Clear / New session / Restore tmux / Tmux attach
- **Git** — Status / Diff / Log / Add all / Commit / Push / Pull --rebase *(routed through the active terminal pane's `pendingCommand` channel)*
- **Panes** — Add Terminal / AI / Browser / Markdown / Preview
- **Layouts** — Single Terminal / Terminal + AI / Terminal + Browser / 3-Way Triple
- **Theme presets** — Blue / Red / Purple / Green
- **Font presets** — Silk / 8bit / Mono and legacy editor palettes
- **Voice** — Open dialogue (VoiceChat modal)
- **Snippets** — first 20 entries from your snippet store, each dispatches to the terminal
- **Package Manager** — bundled tools status

</details>

<details>
<summary><strong>Theme &amp; Fonts</strong></summary>

- **Color presets** — Blue is the default cool palette, Red is red-orange chrome, and Purple is purple with neon green accents.
- **Visible presets** — Settings and the Command Palette expose the four color themes. Legacy and editor palette IDs remain accepted for old saved settings but are no longer the primary UI surface.
- **Runtime swap** — presets are swapped by mutating the live `colors` object in place (identity preserved) and bumping a theme-version store that key-remounts the shell layout. PTY sessions survive the switch — your vim stays open.
- **Single-family rendering** — every Text is forced through JetBrains Mono regardless of its `fontWeight`, keeping UI and terminal typography consistent.
- **Text.render monkey-patch** — `Text.defaultProps.style` is replaced (not merged) when a child passes its own `style`, which would otherwise let 100+ call sites escape the theme font. The patch prepends `{ fontFamily }` to every Text's style array so the preset font reaches every call site without touching them.
- **Neon glow** — eight per-color `textShadow` styles (teal / blue / sky / purple / pink / green / red / amber) for the mock's "reading terminal" vibe
- **Haptic toggle** — per-interaction feedback on/off

</details>

<details>
<summary><strong>Git Integration</strong></summary>

- **Command Palette** — the seven git actions listed above
- **Auto-savepoint** — background git-based save system (`lib/auto-savepoint.ts`) with secret pattern scanning before each commit
- **Git diff preview** — Preview pane Code tab renders `git diff <file>` with the neon diff palette

</details>

<details>
<summary><strong>Settings, API Keys, Background Agents</strong></summary>

- **Companion / Developer split** — the gear-icon Settings sheet shows only companion-relevant sections by default (Display, Wallpaper, Language, Agents, API Keys, Companion Memory, Social Connectors, DM Pairing, Updates, Codex Login, Recovery); Doctor, Integrations (MCP/llama.cpp), Webhook Allowlist, Scouter, and Reset live one tap away behind a single **Developer** row — same "still there, not primary" philosophy as the Sidebar split above.
- **Companion Memory** — view, edit, or delete what Shelly's companion journal has automatically recorded from your conversations, plus the shared `_global` notes — reachable even with zero registered agents.
- **Inline API key editor** — Gemini / Cerebras / Groq / Perplexity / OpenRouter and local/OpenAI-compatible API keys in the Settings dropdown with masked display and per-row `EDIT / CLEAR / SAVE / CANCEL`. Keys live in `expo-secure-store`.
- **Settings TUI** — full settings also accessible via a terminal-style text UI
- **Command safety** — regex-based 5-level risk assessment (seatbelt, not firewall — see [Security](../README.md#security))
- **Workspace isolation** — per-project cwd / env / AI context
- **Background agents** — `@agent list`, `@agent status`, `@agent run <name>`, `@agent stop <name>`, `@agent history <name>`, or `@agent <natural language>` to create one. Scheduled agents run through AlarmManager when configured.
- **Managed Codex runtime updater** — the Updates UI reads the public `codex-runtime-latest/codex-runtime.json` manifest, downloads the tarball, verifies SHA-256, smoke-tests `codex_tui --version` and `codex_tui exec --help`, then promotes the runtime under `~/.shelly-runtime/codex/current`. The new runtime is used by newly opened terminal tabs; **Reset** falls back to the APK-bundled runtime.
- **`shelly-doctor`** — diagnostic command that checks shell/native binary presence, bundled Codex binaries, JS dispatcher, local LLM endpoints, and whether `~/.codex/auth.json` is present; run it when something feels broken

</details>
