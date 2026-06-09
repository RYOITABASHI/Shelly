# 2026-06-09 — Scouter Widget UX expansion

Owner: CC (Codex rate-limited; CC takeover). Base: origin/main `31d9e470`. Branch: `cc/widget-ux`.

## Decision

Extend the Scouter home-screen widget (Even-G2 HUD) without breaking the
working round-trip (ASK → bound Codex PTY → reply, and ALLOW/DENY approval).
Five additions, one redesign:

1. **Codex choice prompts** — show numbered options in the widget and let the
   user pick (send the digit to the PTY), instead of the current
   "select in Terminal" dead-end.
2. **Skip-approval flow** — when the bound Codex runs with approvals skipped,
   deterministically suppress approval UI and show an explicit AUTO indicator,
   instead of relying on `WAITING_PERMISSION` never firing.
3. **Consumed tokens** — surface `tokensUsed` cleanly (already in data).
4. **Rate-limit remaining** — parse `token_count.rate_limits` from Codex JSONL
   for a continuous 5H/weekly used% + reset, instead of opportunistic text
   scraping only.
5. **Shelly CPU%** — wire the real `ScouterSystemSampler.appCpuPercent`
   (`/proc/self/stat`) into the widget; the current `LOAD CPU --%` is dead.
6. **Info-density redesign** — the `scouter_codex_metrics` line packs
   LIMIT/CTX/MODEL/TOK/FLOW/CACHE/RATE into one clipped row. Re-tier into a
   clean hierarchy that includes the new token/rate/CPU lines.

Non-goal: changing the AgentChat pane, the binding model, or the delivery
trampoline. Keep the existing 16 view ids and the
`ScouterWidgetPromptActivity` → direct `session.write()` mechanism.

## Current state (verified by 3 read-only agents, HEAD 31d9e470)

### UI (`scouter_widget_medium.xml` + `ScouterWidgetProvider.kt`)
- Single fixed RemoteViews layout; provider only sets text/color/visibility on
  existing ids (no dynamic view creation). 16 ids:
  `scouter_widget_root, scouter_codex_{dot,title,badge,detail,conversation,metrics,allow,deny,ask}, scouter_local_{dot,title,badge,detail,metrics}, scouter_footer`
  (+ unnamed 1dp `TextView` divider — MUST be TextView, not `<View>`).
- `scouter_codex_badge` / `scouter_local_badge` are bound but `visibility=gone`.
- Choice state: `bindCodexChoicePending()` shows a banner
  (`AGENT CHOICE REQUIRED` / `SELECT 1/2/3 IN TERMINAL · prompt queue blocked`)
  but no selectable options. Detection = screen-scrape
  (`isInteractivePromptScreen`, keyword RE + ≥2 numbered lines);
  `interactivePromptSummary` keeps ONE summary line only.
- Approval: `bindCodexApprovalActions` + `hasActionableApproval` fully built;
  ALLOW/DENY pills → `approvalPendingIntent` (`ACTION_APPROVAL_ALLOW/DENY`) →
  `ScouterWidgetPromptActivity.handleApprovalAction` → `session.write("y\r"/"n\r")`.
- Footer `loadLine` binds `load.cpuPercent` (device total) but `load` =
  `lightweightLoad()` with `cpuPercent=null, appCpuPercent=null` → always `--%`.

### Data (`ScouterModels.kt`, `JsonlSessionParser.kt`, `ScouterRateLimit.kt`, `ScouterSystemSampler.kt`)
- **Tokens**: `SessionSnapshot.tokensUsed` (+ input/output/reasoning/cache).
  Parsed from Codex `token_count.total_token_usage`. AVAILABLE.
- **Rate limit**: fields exist (`rateLimitRemainingRequests/Tokens`,
  `rateLimitResetAt`, `retryAfterSeconds`, `rateLimitStatus`) +
  `rateLimitLine()`/`statusWindowLimitLine()` renderers, but Codex JSONL
  `token_count` is parsed WITHOUT rate-limit fields; 5H/WK% only via
  `percentForLimitWindow` regex over status TEXT (opportunistic). NEEDS the
  `rate_limits` snapshot parsed from `token_count`.
- **CPU**: `ScouterSystemSampler.sample()` computes `appCpuPercent` from
  `/proc/self/stat` utime+stime delta (Shelly's own process). Only called in
  `ScouterLifecycleService.debugJson()`, never on the widget path. DERIVABLE —
  needs wiring. First sample returns null (no baseline); baseline persists in
  `scouter_system_load` prefs.

### Choice / approval / skip (`ScouterWidgetPromptActivity.kt`, `_layout.tsx`, `codex-session-reply.ts`)
- Delivery: widget tap → `ScouterWidgetPromptActivity` (in-process Activity) →
  `TerminalSessionService.sessionRegistry[ptySessionId].session.write()/paste()`.
  Path A (live screen) writes immediately; Path B (not ready) records pending +
  deep-links `shelly:///agent-chat?...drainWidget*` → RN drains via
  `TerminalEmulator.consumeScouterWidgetPending*`.
- Approval primitive = `y\r`/`n\r`. **No digit-send primitive** for choices.
- **No approval-policy awareness** anywhere. TUI launched with
  `__shelly_codex_prepare_args 0` (no bypass) → approvals DO appear by default.

## Design

### Shared data-layer additions (`ScouterModels.kt`)
- `SessionSnapshot.rateLimitPrimaryUsedPercent: Double?`,
  `rateLimitSecondaryUsedPercent: Double?`,
  `rateLimitPrimaryResetAt: Long?`, `rateLimitSecondaryResetAt: Long?`
  (populated from `token_count.rate_limits`).
- `ScouterWidgetConversation.choiceOptions: List<ChoiceOption>?` where
  `ChoiceOption(index:Int, label:String)` — parsed numbered options.
- `ScouterWidgetCodexBinding.approvalPolicy: String?` (`"never"|"on-request"|...`)
  captured at bind time; null = unknown.

### 1. Choice selection UI + digit-send
- **Parse options**: new `parseInteractiveChoices(screenText)` returns
  `List<ChoiceOption>` from `INTERACTIVE_NUMBERED_CHOICE_RE` lines (index + label,
  cap at 4, label `shorten(…, 40)`). Store via
  `recordWidgetChoicePending(message, options)`.
- **Render**: reuse the ALLOW/DENY pill row pattern. When choice pending and
  options parsed, show up to 3 option pills (reuse `scouter_codex_allow`,
  `scouter_codex_deny`, + ONE new id `scouter_codex_choice3`) labeled with the
  option text; ASK hidden. If >3 options or parse fails, fall back to the
  current banner. Keep the existing 16 ids; add only `scouter_codex_choice3`.
- **Deliver**: new `ACTION_CHOICE_SELECT` in `ScouterWidgetPromptActivity` with
  `EXTRA_CHOICE_INDEX`; `handleChoiceAction` re-validates the live screen is
  still an interactive prompt, then `session.write("${index}\r")` (Path A) or
  records pending + drains via RN (Path B), mirroring approval exactly.
- **JS mirror**: add a digit-send to `codex-session-reply.ts`
  (`sendCodexChoice(sessionId, index)` → `writeToSession("${index}\r")`) and a
  `consumeScouterWidgetPendingChoice` native bridge for the drain path.

### 2. Skip-approval flow
- Capture `approval_policy` at bind time into
  `ScouterWidgetCodexBinding.approvalPolicy` (source: the codex launch args /
  a session env marker; if unavailable, infer from absence of approval events —
  keep null = unknown).
- When `approvalPolicy == "never"`: `hasActionableApproval` returns false
  deterministically, and the metrics/status line shows `AUTO` (e.g.
  `STATE [OK] running · AUTO-APPROVE`). When unknown/on-request: current behavior.
- No change to the TUI launch (it stays `prepare_args 0`); this is display +
  suppression only, plus reading whatever policy signal exists.

### 3. Consumed tokens
- Promote `TOK <n>` to a stable always-present slot (not gated on
  `contextPercentRemaining`). Format `formatTokens` (e.g. `49.4K`).

### 4. Rate-limit remaining
- `JsonlSessionParser`: when a `token_count` event has `rate_limits`
  (`primary`/`secondary` with `used_percent`, `resets_in_seconds`/`window_minutes`),
  populate the new snapshot fields. Render
  `LIMIT · 5H <100-primary>% · WK <100-secondary>% · RESET <hh:mm>` continuously
  (remaining = 100 − used%). Keep the text-scrape path as fallback.

### 5. Shelly CPU%
- In `updateWidgets`, replace `lightweightLoad()` with
  `ScouterSystemSampler(context).sample()` (guard cost; sample is cheap —
  two `/proc` reads). Bind `appCpuPercent` (Shelly's own) as `CPU <n>%` in the
  footer/load line; keep device total optional. First tick shows `--%` until a
  baseline exists.

### 6. Info-density redesign (keep 16 ids + `scouter_codex_choice3`)
Target CODEX block hierarchy (top→bottom):
```
● AGENT  CODEX@<project>            (title)
STATE [..] <plain status>           (detail)
<reply text, white>                 (conversation)
TOK 49.4K · CTX 40% · MODEL 5.5     (metrics line 1 — useful only)
LIMIT 5H 20% · WK 58% · RESET 14:05 (metrics line 2 — only when rate data)
[ ASK ]  or  [opt1][opt2][opt3]  or  [OK][NO]
```
- Drop `FLOW/REASON/CACHE/SID/TRACE` from the default view (noise). Keep them
  only in `ScouterDetailModal` (debug), not the widget.
- Footer: `CPU 12% · updated hh:mm:ss` (Shelly's own CPU).
- `scouter_codex_metrics` → allow 2 lines (maxLines=2) for the token + limit
  tiers, or add one new id `scouter_codex_usage` for the limit line. (Prefer a
  new id to keep formatting clean.)

## Implementation phases (each: tsc/XML-validate → agent review → push → CI)

- **P1 — CPU wiring** (low risk): sampler into `updateWidgets`, bind
  `appCpuPercent`, footer `CPU n%`. Validates the pipeline.
- **P2 — Info-density redesign + consumed tokens**: layout re-tier (new
  `scouter_codex_usage` id), provider `codexMetrics` simplification, promote TOK.
- **P3 — Rate-limit remaining**: `JsonlSessionParser` `rate_limits` parse + new
  fields + continuous LIMIT line.
- **P4 — Choice selection UI + digit-send**: parse options, render pills, new
  `ACTION_CHOICE_SELECT` + `session.write("<n>\r")`, JS mirror + drain bridge.
- **P5 — Skip-approval flow**: bind-time policy capture + deterministic
  suppression + AUTO indicator.

## Verification
- Local: `tsc --noEmit` (JS parts), XML well-formedness + `<View>`-free + id
  consistency (provider R.id ⊆ layout ids), `git diff --check`.
- Native: CI build (cannot build Android locally).
- Each phase: independent agent review BEFORE push (pre-push gate). Native
  RemoteViews allowlist checked by the reviewer (no `<View>`, no unsupported
  widget classes).
- Device: install CI APK, verify each surface (CPU%, token, rate line, choice
  pick sends digit, skip-approval hides pills + AUTO).

## Risks
- **RemoteViews class allowlist** — only Frame/Linear/Relative/GridLayout +
  TextView/ImageView/Button/etc.; plain `<View>` crashes at inflate (already
  bitten once). Reviewer must check.
- **Choice screen-scrape brittleness** — option parse depends on PTY text;
  cap at 3 pills + fall back to banner. Re-validate screen at send time.
- **Rate-limit `rate_limits` shape** — depends on Codex version emitting it in
  `token_count`; if absent, fields stay null and the text-scrape fallback
  remains (no regression).
- **CPU first-sample null** — acceptable; resolves after one refresh tick.
- **Cannot build locally** — every native change is CI/device-verified; lean on
  agent review + XML/id validation.

## Deferred
- Precise "remaining requests count" (vs %) needs Codex app-server
  `account/rateLimits/read` (not on the JSONL path) — out of scope; % is enough.
- Arrow-key choice navigation (only digit-send supported).
