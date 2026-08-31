# Changelog

All notable changes to Shelly are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in
`YYYY-MM-DD`. Shelly uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [8.0.0] - 2026-08-31

### Added

- **"Shelly" as a persistent companion.** The default local-persona AI Pane
  now presents as one continuous companion named Shelly instead of a
  provider-branded chat — no per-message provider tag on its replies (the
  bound provider shows in the pane header instead). Its conversation follows
  you across AI panes and provider switches, with a short carry-forward of
  recent context into the destination thread on a switch, and companion-first
  Sidebar/Settings defaults (Tasks/Skills expanded, developer sections
  collapsed under one **Developer** row).
- **Companion journal.** Every conversation auto-distills into a
  `_companion`-scope memory note on each provider switch (on-device, no
  confirm turn required), relevance-scored and capped at recall time,
  browsable/editable/deletable from Settings → Companion Memory.
- **Sub-agent fan-out (`parallelGroup`).** A multi-step agent can declare
  branches that run in an isolated context from each other, aggregate in
  declared order, and — for unattended PlanSpec runs — actually dispatch
  concurrently (3-branch semaphore, locked shared capability budget),
  mirroring Hermes's sub-agent delegation model.
- **Skill self-improvement.** A resolved failure → success cycle
  deterministically promotes the caution into the skill body; attended runs
  ask for confirmation, unattended runs auto-apply with a one-tap revert.
  Paired with a conservative skill curator (duplicate-merge proposals,
  promotion, archival) and the skills catalog expanding from 4 to 21
  importable recipes.
- **Memory recall upgrades.** BM25 + recency-decay scoring for skill/memory
  recall, plus an optional embedding-based re-rank end-to-end when a local
  embedding-capable model is running.
- **Agent action Undo.** A run whose only action is a `draft` write into the
  local `agent-output` workspace can run optimistically (auto-savepoint →
  execute → one-tap "元に戻す" on the result) instead of blocking on
  pre-approval — narrowly scoped, opt-in, off by default.
- **Browser-pane agent action.** An agent can click, fill, or extract text
  from the page already open in a Browser pane — a closed operation set (no
  navigation, no arbitrary script injection), gated to an explicit
  page-URL allowlist and a per-action approval tap every time.
- **Nacre Bridge.** While Shelly is foregrounded, it shares sanitized live
  terminal context (cwd, git branch, a handful of safe recent-command terms)
  with the author's own Nacre Android IME so its kana-kanji conversion can
  lean toward what you're actually doing.
- **AI → Terminal insert.** Any AI-chat reply's fenced ` ```bash ` block gets
  an **Insert** button — tap it and the code lands in the focused Terminal
  pane's input line (no auto-Enter), opening a new terminal and queuing the
  insert if none is open.
- **X (Twitter) social-post connector** and simultaneous multi-platform
  posting from a single agent utterance ("post this to Bluesky and X").
- **OpenRouter** wired into the agent executor (attended-only).
- **Agent Runs pane and Memory Workbench pane.**
- **Optional tool packs** — dormant, on-demand infrastructure for
  downloading extra CLI tools after install instead of bundling everything
  up front.
- Widget agent registration gained voice input and an opt-in no-confirm
  fast path (`Widget No-Confirm Register`, off by default).

### Changed

- The default per-run action-approval mode flipped to **manual** (a human
  "Runtime Review" tap is now required by default for draft/notify/webhook/
  cli/intent/dm-reply actions; opt back into auto-approve in Settings).
- Settings split into companion-relevant and developer surfaces, with a
  single **Developer** row leading to Doctor/Integrations/Webhook
  Allowlist/Scouter/Reset.

### Removed

- **`app.act` (cross-app UI automation via Android Accessibility Service).**
  Implemented as an experimental Phase 1 on 2026-08-29 (LINE messaging and X
  posting, driven through a package-allowlisted recipe walker), it was
  removed entirely two days later after on-device testing surfaced three
  distinct structural bugs in one session — a cold-start timing miss, a
  matcher that could ambiguously bind to multiple screen elements, and a
  fundamentally unfixable focus-stealing bug in the recipe-capture UI
  (tapping Shelly's own Capture button hands Android's foreground-window
  focus to Shelly before the Accessibility Service can read the target
  app's screen). Accessibility-driven UI automation proved structurally
  fragile against any change in the target app's own screen, even scoped to
  just two apps. `AGENT_SCRIPT_VERSION` / `CURRENT_SCRIPT_VERSION` bumped to
  59 in lockstep so a stale on-disk script from a previously-registered
  autonomous `app-act` agent fails loudly on its next run instead of hanging
  on a silently-dropped approval request. Reviewed independently by Fable5
  and Codex, no P0s found. Social-post connectors (including X) remain the
  supported way to publish an agent's output to another platform.

### Fixed

Security and correctness fixes from this window's extensive on-device QA
passes, among many smaller ones: unattended agents now fail closed on a
rollback secret scan and on a secret-bearing skill body; command-safety
scanning is quote-aware; boundary-policy lexical bypasses are closed;
notification-triggered agents disclose an unset sender allowlist instead of
silently accepting any sender; several Settings-panel scroll/gesture
conflicts (opacity sliders and a percent-height ScrollView eating vertical
scroll gestures) were root-caused and fixed across multiple rounds; the
Sidebar's "+ Add Repository" self-heals after a focus race that could leave
its modal window stuck invisible; `tryAddRepo` no longer fail-opens on a
ghost/non-git path; and a new single-source-of-truth schema-parity test
(`__tests__/agent-action-type-schema-parity.test.ts`) now catches any future
drift between the TS, Kotlin, and bundled-JS copies of the agent
action-type allowlist before it can silently ship again.

### Note

This is a "highlights" reconstruction, not an exhaustive log: 352 commits
landed between the `v7.5.5` and `v8.0.0` tags, most of them as part of a
parallel-squad, on-device-QA-driven development style (many small
`fix`/`docs(deferred)` commits per feature) that this file didn't keep pace
with in real time — the same gap `v7.0.0`'s entry above already
acknowledges for its own release window. `docs/superpowers/DEFERRED.md` is
the detailed, contemporaneous engineering log this project actually
maintained throughout this period, including every Fable5/Codex review
round and on-device verification result.

## [7.5.5] - 2026-08-03

### Added

- **LLM-led conversational agent registration ("Tier 3"), on by default.**
  When a request is ambiguous, an LLM now drives the rest of the
  clarification in its own words — asking one distinct follow-up at a
  time — instead of Shelly's older fixed one-field prompts, trying a fast
  cloud provider first (Cerebras, then Groq, if configured) and falling
  back to the on-device model, then the fixed-question flow, so a
  conversation never gets stuck. A request that turns out to need several
  ordered steps ("look this up, summarize it, then post it") is kept as a
  real multi-step chain — the same orchestration engine deterministic
  registration already used — instead of collapsing into one prompt.
  Every value the model proposes is still independently re-checked before
  being trusted (deterministic cron re-parsing, connector existence
  checks, and — for the separately-gated webhook/CLI action types — a
  verbatim-substring match against what you actually typed), and the
  human confirmation tap is never skipped. Toggle it off in
  Settings → Agents → LLM-Led Agent Registration.
- **X (Twitter) connector**: OAuth 2.0 PKCE connect, regular posts, and
  long-form Articles (draft → publish).
- **User-profile learning is now wired up.** Shelly observes command
  patterns, agent usage, and self-introduced facts on-device and folds a
  short summary into the AI Pane's system prompt to personalize
  responses. (This existed in code before but had zero callers — it now
  actually runs.)
- **Skills carry a failure hint.** A skill recipe that failed its most
  recent run surfaces a one-line caution the next time it's matched,
  cleared automatically once a run succeeds again. The recipe body itself
  is never auto-rewritten.

### Fixed

- **Cerebras's default model was silently 404ing on every call.** The
  hardcoded default (`qwen-3-235b-a22b-instruct-2507`) had been removed
  from Cerebras's own model catalog; switched to `gpt-oss-120b` across
  every call site. Also added `reasoning_effort: 'low'` where a small
  token budget made truncation-by-reasoning a real risk, and added a
  success-path log line for Cerebras/Groq calls (previously only failures
  were logged, making it impossible to tell which provider actually
  answered from the logs alone).
- **`shelly <subcommand>` failed with `Permission denied` in the
  terminal** (bug #166) — a regression from a preload change; routed
  through the same linker64 wrapper every other bundled binary uses.
- ConfigTUI's bottom sheet could collapse to header-only on tap (a Yoga
  flexbox sizing trap).
- The local model could repeat an already-answered clarifying question
  verbatim, or lose all conversation progress when the 5-turn cap was hit
  — both now fall back cleanly to the fixed-question flow without
  discarding what was already understood.

## [7.5.0] - 2026-07-29

### Added

- **Scouter widget can register a brand-new agent, not just run an existing
  one.** Typing `@agent ...`-shaped text into the widget's ASK box now hands
  off through the app's deep-link queue into the AI Pane's own
  `parseAgentCommand`/confirm-card flow, instead of landing as a literal
  Codex prompt (which is what happened before — silently, with no agent ever
  registered). An explicit opt-in setting (`Widget No-Confirm Register`,
  off by default) lets this path skip the confirm card and register
  immediately with a post-registration notification, without touching the
  AI Pane's own always-confirms default.
- **Voice input for the widget's ASK dialog**, via Android's built-in speech
  recognizer — recognized text populates the field for review, never
  auto-submits.
- **OpenRouter** is wired in as an attended-only AI Pane provider (Settings
  API key field, `@openrouter` mention, streaming dispatch). Unattended
  agent runs never route through it.
- **Agents can remember and reuse what worked.** Successful runs leave a
  memory note the agent recalls later; multi-step successes distill into
  a reusable skill that gets matched and replayed for similar requests.
  Unattended successes of remembering agents auto-save a skill with a
  post-hoc deletable notification instead of an interrupting prompt.
- **Cross-agent shared memory**, gated behind an explicit natural-language
  trigger plus a confirmation step before anything gets written into every
  agent's shared context.
- Bilingual documentation: `README.ja.md` and `docs/MANUAL.ja.md` join
  `README.md` and the new `docs/MANUAL.md` (a full 9-chapter user manual).

### Fixed

- **Scheduled-run memory/skill capture never actually fired in production**
  — the hook lived in a code path (`loadAgentsFromDisk`'s `syncLogs: true`
  branch) that the app's one real startup call never used
  (`syncLogs: false`, intentionally, for a fast launch). Moved the capture
  call to `syncAgentRunLogsFromDisk`, the function actually driving the
  periodic/foreground-resume sync — a second instance of the same
  "implemented, unit-tested, zero production callers" bug class found
  repeatedly this cycle.
- **A skill-reuse re-run could permanently collide with its own chain lock**
  — a rehydrated multi-step skill plan was routed as a single-attempt run
  by the JS-side scheduler, whose native execution then got redirected to
  the PlanSpec chain executor; that executor's chain-lock guard couldn't
  tell the difference between "someone else's lock" and its own run's lock,
  and skipped every time, regardless of how long you waited.
- **Foreground-triggered notifications (e.g. the skill-save "delete" action)
  never displayed** — the module that registers `expo-notifications`'
  foreground display handler was never imported anywhere in the app.
- Several Japanese widget strings silently fell back to English
  (`scouter_ask_agent_chat_short` and others were missing from
  `values-ja/scouter_strings.xml`).

## [7.0.0] - 2026-06-27

### Added

- **Autonomous agents.** Plain-language `@agent` registration compiles to a
  real Android `AlarmManager` alarm — not a cron shim, not a foreground
  service — that wakes the phone screen-off and reports when it ran (or
  flags a missed run). Vague requests get a clarifying question about *what*
  before the app asks *when*.
- **Deferred-start scheduling** ("starting next week, check the news every
  morning") and a short correction window right after an agent is
  auto-registered.
- **Capability broker** — an allowlist-gated boundary for outbound network
  calls from unattended runs, plus an explicit `Autonomous Cloud` opt-in
  (default off) before a scheduled agent can spend a configured cloud API
  key unattended; it falls back to local/Codex otherwise.
- **Multi-platform delivery** — Bluesky, Discord, Slack, Telegram, Mastodon,
  Misskey, WordPress connectors, plus a generic webhook, configured once per
  platform and selectable per agent.
- **Scouter widget redesigned from a Codex monitor into an agent launcher**
  — RUN starts an already-registered scheduled agent through the same
  unattended execution gates a real alarm fire uses.
- Sidebar per-agent pause/resume, a RUNNING section with live progress, and
  a chat-native agent editing/confirm flow.

### Note

This release window (85 commits between the `v6.0.0` and `v7.0.0` tags,
514 total through the 7.5.0 work above) went undocumented here at the time
— `CHANGELOG.md` sat at `[Unreleased]` while the autonomous-agent system
was being built. This entry reconstructs the highlights after the fact;
see `docs/superpowers/DEFERRED.md` for the detailed, contemporaneous
engineering log this project actually kept up to date during that period.

## [6.0.0] - 2026-06-10

### Added

- **Interactive Scouter widget** — the home-screen widget is no longer
  read-only: tap **ASK** to inject a prompt into the bound Codex PTY, and
  answer Codex with **Allow / Deny** and numbered **1 / 2 / 3** choice pills
  that write straight to the terminal, with a stale-tap guard that re-parses the
  live screen before firing.
- **Live rate-limit + chronometer** — the widget surfaces a `RATE LIMITED`
  override the moment a usage limit hits, plus a self-ticking chronometer that
  counts down to the rate-limit reset (or up the running session) without a
  widget re-render.
- **Quota gauge** — a 5-cell remaining-quota bar (`5H` / `WK`) using filled/empty
  squares, green while healthy and glowing red once it drops to its last cell.
- **Derived Codex cost** — the USAGE line shows `$cost` derived from a bundled
  LiteLLM price table, since Codex emits no cost itself.
- **Per-category Codex notification channels** — approvals, choices, and errors
  arrive as heads-up alerts on their own Android channels (tunable from system
  settings), with one-tap **Allow / Deny** and **1 / 2 / 3** action buttons and
  the full request / menu text in the expanded view.
- **Two-line conversation + relative idle time** — the widget shows the last
  `YOU` prompt and `CODEX` reply, and the idle line reads `idle · 3m ago`.

### Changed

- **Release version bumped to 6.0.0** across Expo config, Android versionName,
  and runtimeVersion (versionCode stays git-derived).
- **Widget readability** — larger status / usage fonts, the lower row header
  renamed `MODEL` → `LOCAL` to stop colliding with the Codex `MODEL` token, and
  the token total labelled `TOK … used` to disambiguate it from rate `… left`.
- **Idle freshness** — a ~60s poll heartbeat keeps CPU / RAM / clock / footer
  current while idle, and the footer `updated` time now reflects the actual
  render, not the last event.
- **README** documents the interactive widget, the Agent Chat surface for the
  bound Codex, and the notification channels.

### Fixed

- **Fold display relayout hardening (v6.0.0 build 1510)** — the React safe-area
  provider no longer seeds stale initial window metrics, and the Android
  MainActivity now requests a root relayout after configuration, focus, and
  resume events. This targets the intermittent main-display to cover-display
  switch where Shelly could remain squeezed into the previous window bounds.
- **Widget ASK cold-start hardening (v6.0.0 build 1507)** — when a widget
  prompt is submitted while no Codex session is running, Shelly now retries the
  native PTY launch command directly (`clear && codex`) instead of relying only
  on a pending TerminalPane write. This keeps the no-Codex/no-Agent-Chat widget
  path from landing in Agent Chat with "No Codex session observed" and no
  command entered.
- **Updates modal overflow hotfix (v6.0.0 build 1505)** — fixed horizontal
  right-clipping on Fold layouts by opening Updates as a top-level modal and
  tightening shrink/wrap constraints for long update labels, toolbar buttons,
  and release action rows.
- **Updates screen could hang forever on "Checking…"** — the GitHub fetch body
  read was unbounded after the response headers arrived; the whole refresh is
  now bounded by a timeout so it always completes.
- **LOCAL offline row contradiction** — the health line said "no endpoint" while
  the metrics line still showed `END :11434`; offline now reads `Offline` +
  `LOCAL PROBE <ports>`.
- **Duplicated status signal** — the `[OK]` / `[--]` indicator no longer appears
  on both the status line and the top-right badge.

## [5.3.1] - 2026-05-14

### Changed

- **Release version bumped to 5.3.1** across Expo config, package metadata,
  Android versionName/versionCode, and runtimeVersion.
- **Local LLM catalog refreshed** — Qwen 3 8B Q4_K_M is now the recommended
  high-quality model for high-end Android/foldable devices, while Qwen 2.5
  1.5B remains the low-memory fallback.
- **README and release-surface docs synced** with the supported CLI posture:
  Claude Code and Codex are the supported foreground CLIs, Gemini CLI remains
  Experimental, and AI Pane/background automation uses explicit API providers.

## [5.3.0] - 2026-05-14

### Added

- **Supported Codex CLI login path** — bare `codex` now routes through
  Shelly's device-code wrapper when `~/.codex/auth.json` is missing or
  invalid, opens the in-app Browser Pane, writes credentials with private
  file modes, then launches the normal Codex TUI. Device validation shows
  `codex-exec 0.130.0` and GPT-5.5.
- **Release-surface documentation** — README, CLAUDE.md, AGENTS.md, and
  GEMINI.md now explicitly distinguish supported foreground CLIs,
  API-backed AI pane/background providers, and Experimental Gemini CLI.

### Changed

- **Release version bumped to 5.3.0** across Expo config, package metadata,
  Android versionName/versionCode, and runtimeVersion.
- **Claude Code subscription boundary tightened** — Claude Code remains a
  foreground user-controlled terminal CLI. AI Pane and background agents use
  explicit API providers such as Gemini API, Cerebras, Groq, Perplexity, and
  OpenAI-compatible local routes.
- **Sidebar Worktrees and Quick Launch narrowed to Claude Code and Codex**.
  Gemini CLI is hidden from release shortcuts while investigation continues.
- **New terminal tabs autofocus their terminal** so split-pane session
  creation lands keyboard input in the newly opened shell.

### Fixed

- **Codex auth loop from the normal startup prompt** — the wrapper now
  launches Shelly's device-code login path before the upstream Codex TUI
  starts, avoiding the unsupported `/login` REPL route on Android.

### Known limitations

- **Gemini CLI remains Experimental**. `gemini --version` works through the
  APK bundle tier, but Gemini CLI 0.42.x has shown blank TUI startup, slow
  rendering, and shell-tool signal 11 behavior on Android/musl. Gemini API
  remains supported for AI Pane/background use.

## [5.2.0] - 2026-05-06

### Added

- **Latest Claude Code 2.1.131 runs as the default tier** — the runtime
  updater promotes the latest `@anthropic-ai/claude-code-linux-arm64-musl`
  release and the LD_PRELOAD wrappers carry the trampoline. Bash tool
  works end to end inside Claude Code at 2.1.131.
- **Sidebar Quick Launch section** between TASKS and REPOSITORIES.
  Three compact chips (Claude orange / Codex green / Gemini blue) open
  a fresh Terminal pane and run the matching CLI in one tap.
- **Bun.hash polyfill** with full named-variant coverage (wyhash,
  cityHash32/64, xxHash3/32/64, murmur32v2/v3, murmur64v1/v2, rapidhash,
  adler32, crc32). SHA-256-backed; honours the `seed` argument so
  `Bun.hash(K, Bun.hash(q))` retains its seed-distinct invariant.
- **Runtime-failure feedback loop** — native-tier crash signals append
  to `~/.shelly-runtime/.runtime-failures`; the next
  `__shelly_bg_cli_update` consumes the file and adds those versions
  to `recordFailedVersion`'s cooldown so the updater walks past them.
- **`SHELLY_LEGACY_NPM_PIN`** environment variable — defaults to
  `2.1.112` (last npm release with `cli.js`); override to test a
  different tag.
- **`SHELLY_PREFER_NATIVE_CLAUDE`** environment variable — historically
  required to opt in to the native Bun SEA tier. No longer needed for
  default usage now that the SEA path is stable; kept for explicit
  control.
- **`BUN_TMPDIR=$HOME/.bun-tmp`** is set in the bashrc so Bun's lazy
  `.node` extraction has a known writable directory and a single-shot
  retry can clean it on crash.

### Changed

- **`exec-wrapper.c` and `exec-wrapper-musl.c` rewritten to use raw
  arm64 `svc #0` syscalls** — `dlsym(RTLD_NEXT, ...)`, libdl, liblog,
  malloc, and TLS were all removed from the LD_PRELOAD shim's
  interception path. The bug class "wrapper crashes during fresh CI
  rebuild" is gone.
- **Two embedded Bun SEA `.node` add-ons are byte-patched out** —
  `audio-capture.node` and `image-processor.node` loader call sites
  return `null` instead of invoking `process.dlopen()`. Same-length
  patch keeps offsets stable. Voice native input and the image
  processor native helper are disabled; JS fallbacks handle the
  "feature missing" case. Patch is applied both at runtime promotion
  time (`shelly-runtime-update.js`) and at CI build time (the bundled
  `libclaude.so`).
- **`__shelly_bg_cli_update` pinned to
  `@anthropic-ai/claude-code@2.1.112`** by default. 2.1.113+ removed
  `cli.js` from the npm tarball, so chasing `@latest` on a Node-only
  path is structurally impossible.
- **`LibExtractor.kt::ALWAYS_REFRESH` extended** to include
  `libexec_wrapper.so` and `claude` (the bundled byte-patched
  `libclaude.so`). Wrapper rewrites and SEA byte patches now reach
  existing devices on app upgrade without a `versionCode` bump.
- **`BASHRC_VERSION` 73 → 76**.
- **Quick Launch chip styling** — compact one-row layout, Anthropic
  copper/orange (`#CC785C`) for Claude.

### Fixed

- **Wrapper SIGSEGV on fresh CI rebuild** (`pc=0x1ff0` PLT
  trampoline). Root cause was the bionic linker not resolving the
  wrapper's `dlsym` PLT entry; raw-syscall rewrite eliminates the
  dependency entirely.
- **Bun SEA segfault while loading `audio-capture.node` /
  `image-processor.node`** (Anthropic Claude Code issue
  [#54530](https://github.com/anthropics/claude-code/issues/54530)).
  Bypassed at the SEA level via byte patch.
- **`grep` SEGV in any pipeline** — `static __thread char rewrite_buf[]`
  in the LD_PRELOAD wrapper pulled in Clang's emulated-TLS helper,
  whose own PLT entries were unresolved. Buffer is now stack-allocated
  and threaded through `rewrite_path()` as a parameter; `errno = ...`
  writes (also TLS-backed) were also removed.
- **`Bun.hash is not a function`** at Claude Code 2.1.112 startup
  through the legacy npm tier — covered by the new polyfill.

### Known limitations

- Claude Code's voice native input and image processor native paths
  are disabled. Re-enable automatically once Bun upstream fixes the
  Android arm64 musl `.node` segfault.
- `~/.shelly-cli` legacy install uses `--omit=optional`, so versions
  past 2.1.112 won't populate `cli.js` from Anthropic's restructured
  npm package. Pin defaults make this a no-op for users today.
- `ALWAYS_REFRESH += "claude"` copies ~220 MB out of the APK on every
  app launch. Future work: sha / build-marker diff refresh.

## [5.1.1] - 2026-05-01

### Added

- **Build 782 security harness** — documented the release-gate checks for
  `shelly-doctor` credential hygiene, CLI runtime smoke tests, and GitHub
  secret-scanning false-positive handling in
  `docs/superpowers/specs/2026-05-01-build-782-security-harness.md`.
- **Log secret redaction** — app debug logging now redacts common API key and
  token patterns before writing to logcat. Unit tests cover OpenAI, Google,
  Groq, Cerebras, and environment-style secret strings without keeping literal
  secret-shaped fixtures in the repository.
- **`shelly-doctor` security checks** — doctor now reports leftover credential
  handoff files in `/sdcard/Download`, private-mode status for credential files,
  and whether known API-key environment variables are present.

- **Ask Pane** — Shelly's self-documenting assistant (Stage 1). New
  pane type `ask` opens via the "+" menu or pane switcher. Users ask
  natural-language questions ("can Shelly do X?" / "how do I use Y?")
  and the built-in feature catalog + curated shipping/roadmap snippets
  feed into a Groq-backed answer via the existing streaming dispatch.
  Each response ends with a coloured status badge:

    ✅ **AVAILABLE**       — feature ships today; answer walks through it.
    ⏳ **PLANNED**          — on the DEFERRED backlog; priority surfaced
                             when stated.
    ❌ **NOT_AVAILABLE**    — no evidence in docs; Stage 2 will add a
                             one-tap "Create GitHub issue" button here.

  No new LLM plumbing: reuses `groqChatStream` via `systemPromptOverride`.
  Zero native/Kotlin changes.

- **`shelly-cs open` routes into Shelly's Browser Pane via deep link**.
  A custom `shelly://browser?url=<encoded>` scheme is registered on
  Shelly's `MainActivity` (the `shelly://` family was already in the
  manifest from expo-router scaffolding — we just added a handler in
  `app/_layout.tsx`). The codespace web URL lands inside Shelly's
  in-app WebView instead of kicking out to Chrome. Falls back to the
  raw VIEW intent (external browser) if the deep-link start fails.

- **`cs` shortcut + default codespace**. `cs` is a `.bashrc` alias for
  `shelly-cs`. `shelly-cs use <name>` persists a default codespace to
  `$HOME/.shelly-cs/config.json` (verified via REST before saving).
  `shelly-cs open` with no args resolves in order: positional arg →
  default → the only Available/Shutdown codespace → helpful error.
  `shelly-cs list` marks the default with a yellow ★. `shelly-cs`
  with no command falls through to `open` when authenticated.

  Target UX from any `$PWD`:
  ```
  cs use sturdy-cod-557j97jgggjc7p4w   # one-time
  cs                                    # → codespace in Browser Pane
  ```

- **Clipboard auto-copy during `shelly-cs auth`**. The OAuth device
  code is written to the Android clipboard via a new `shelly://
  clipboard?text=<encoded>` deep link handled by the same
  `app/_layout.tsx` Linking listener. `app/_layout.tsx` calls
  `Clipboard.setStringAsync` (already a project dep). Paste directly
  in the browser instead of retyping the 8-char pair.

- **`shelly-cs` — GitHub Codespaces CLI** (Phase 1 minimum). Pure-Node
  helper that speaks the GitHub REST API directly. No gh CLI dependency,
  no external binaries, bundled bionic `node` runs it unchanged. Ships
  as an APK asset (`modules/.../assets/shelly-cs.js`) extracted to
  `$HOME/.shelly-cs/shelly-cs.js` on every launch.

  Commands: `auth` (OAuth device flow against the Shelly OAuth App),
  `list`, `create [--repo O/R]` (defaults to
  `RYOITABASHI/shelly-codespace-template` which pre-installs
  `@anthropic-ai/claude-code`), `open`, `stop`, `delete --yes`,
  `doctor`, `logout`. `ssh` is stubbed for Phase 1.5 — `open` gives
  you the codespace's web terminal for now.

  Env-overridable constants: `SHELLY_OAUTH_CLIENT_ID`,
  `SHELLY_CS_DEFAULT_REPO`, `SHELLY_CS_SCOPE`, `SHELLY_CS_DEBUG`.

- **Three-tier fallback for `claude`**: `$HOME/.shelly-cli` (auto-updated)
  → `$HOME/.shelly-cli.prev` (last-known-good snapshot) →
  `$libDir/node_modules` (APK-bundled golden). `claude()` walks the
  tiers at invocation time, reporting which tier it landed on (unless
  `SHELLY_SILENT_CLI_TIER=1`). The `__shelly_bg_cli_update` background
  job now stages into `$HOME/.shelly-cli.staging`, runs a 15-second
  `node cli.js --version` health check, and rotates only on success —
  a broken `@latest` never reaches the live tree and never blocks the
  `claude` command.

- Four additional theme presets: **Dracula**, **Nord**, **Gruvbox**,
  **Tokyo Night**. Selectable from Settings → Display → Theme or the
  Command Palette (`theme-dracula`, `theme-nord`, `theme-gruvbox`,
  `theme-tokyo-night`). Runtime swap, no PTY restart.
- **MCP Servers** management UI wired into Settings → Integrations.
  Opens the existing `McpSection` (catalog, add/remove, run command)
  as a slide-up Modal backed by the JNI `execCommand` bridge.
- **Local LLM · llama.cpp** management UI wired into Settings →
  Integrations. Opens the existing `LlamaCppSection` (model catalog
  with RAM hints, guided setup, download, start/stop, delete) as a
  slide-up Modal with a 10-minute command timeout so builds and
  downloads don't get killed.
- **Scheduled agents** in the Sidebar Tasks section: lists every
  registered `@agent` with run-now (▶) and delete (🗑) actions backed
  by `agent-executor.generateRunNowCommand()` and
  `agent-manager.deleteAgent()`.
- `SECURITY.md` and `CHANGELOG.md`. README now carries a GitHub
  Actions build badge.

### Changed

- **`claude` dispatch simplified** to `_run node cli.js` (v26 pattern
  restored). The v28–v30 detour (Bun binary + proot + Alpine chroot +
  musl sub-package + CA bundle + `/etc/*` population) turned out to be
  over-engineering — the npm tarball for
  `@anthropic-ai/claude-code@<=2.1.112` ships a plain-JS `cli.js` that
  runs under Shelly's bundled bionic node unmodified. Five-agent survey
  (GitHub issues, Ishabdullah/claude-code-termux, Qiita/Zenn/LINUX DO)
  converged on the same dispatch.
- **`claude-code` pinned to 2.1.112** — the final release that ships
  `cli.js` as a pure-JS entry point. Both the CI bundle step and
  `__shelly_bg_cli_update` pin explicitly. 2.1.113 replaced `cli.js`
  with a Bun-compiled SEA binary (`bin/claude.exe`) whose only entry
  point `cli-wrapper.cjs` is a platform-detect + spawn launcher with no
  JS fallback. Latest claude-code on mobile now requires Codespaces —
  see `shelly-cs` above.
- **Paste pipeline (bug #97 root fix)** — multi-line paste now arrives
  at bash as a single bracketed-paste chunk again. Earlier dispatch
  failed on bionic bash's readline because the ESC in `\e[200~` was
  swallowed by the meta-prefix handler; we now trigger
  `bracketed-paste-begin` via an ESC-free `\C-x\C-b` keybind instead,
  which `.bashrc` binds in the emacs, vi-insert, and vi-command
  keymaps. `TerminalEmulator.paste()` gates the wrap on DECSET 2004 so
  vim / less / nano still get the pre-#91 `\r?\n → \r` fallback.
- **README** — Coming Soon trimmed to genuine unknowns only (app icon
  + store distribution, end-to-end device smoke tests). Status table
  rewritten to reflect shipping state of theme presets, MCP,
  llama.cpp, SSH profiles, scheduled agents, and Ports monitor.
- **Sidebar Profiles** is now documented as shipping (it had been a
  section shell in the README but was in fact a fully-wired orphan
  the whole time — ~/.ssh/config import, long-press edit/delete,
  tap-to-insert `ssh -i KEY user@host -p PORT`, key-file auth only).

### Removed

- **Sidebar CLOUD section** — the Google Drive / Dropbox / OneDrive
  placeholder rows, the OAuth URL table, and `handleCloudConnect`.
  Shelly defers cloud storage to [`rclone`](https://rclone.org), which
  already speaks 40+ backends from the terminal pane. README Feature
  Tour now points at rclone directly. Status table flips the Cloud
  row from 🟡 to 🚫 out-of-scope.

### Known issues

These are tracked for the first tagged release but not yet fixed:

- **Enter key sometimes needs two presses** in freshly-spawned PTY
  sessions. Suspected to be the `TerminalSession` Kotlin
  non-blocking read loop racing with the initial prompt render —
  native debug next.
- **Voice dialogue, immortal sessions, and AlarmManager scheduling**
  are wired end-to-end but have not been smoke-tested on-device since
  the Plan B (Termux-free) migration.
- **App icon + Play Store / F-Droid distribution** — the APK ships
  via GitHub Releases only. Icon brief exists, store flow does not.

---

Earlier history (pre-changelog) is visible in `git log`. Noteworthy
milestones:

- **Shelly theme preset + runtime swap + Silkscreen single-weight
  monkey-patch** — `4687da97` through `ca428062`
- **Plan B (Termux-free JNI forkpty + APK-bundled binaries)**
  completes — commit `1323a287`
- **Superset UI redesign** — 50+ commits, mock-faithful pane/sidebar
  layout with Silkscreen pixel font
- **AI Edit golden path** — stage → unified diff → per-hunk accept →
  disk writeback with fuzzy re-anchor
