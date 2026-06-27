# Widget → Agent launch (A: input shortcut + B: one-tap run) — implementation handoff

**Date**: 2026-06-27
**Branch**: `claude/work-handoff-2qb1xd` (v7.0.0 shipped from here; see release `v7.0.0`)
**Status**: 🟢 Ready to implement. Design finalized, code anchors verified against HEAD. **Implementation deferred to a mobile-linked session** — this doc is the cold-start resume point.
**DEFERRED entry**: `docs/superpowers/DEFERRED.md` → "Secretary MVP — ウィジェット導線".

---

## 0. Why now (blocker cleared)

The old "Why not now" was **コアループ未完**. That precondition is now **met**: the
autonomous core loop (NL → confirm card → gate → action, then unattended
AlarmManager fire) is on-device proven and shipped in **v7.0.0** (N=1 demo:
`@agent` → scheduled → screen-off fire → sourced summary to Obsidian). So both
widget導線 are ripe.

User decision (2026-06-27): **implement BOTH A and B.** Implementation happens in
a later mobile-linked session; this handoff exists so that session can resume
from Git with zero context loss.

---

## 1. What A and B are (and the crucial distinction)

- **A — input shortcut.** Widget tap opens the app at the agent NL input
  (voice-armed) → user speaks/types → **confirm card → Confirm**. This still
  opens the app and shows the card. It only removes "open app, navigate to
  input". *Per the original DEFERRED design.*

- **B — one-tap RUN of an already-registered agent (the real "fire from the home
  screen").** No card, because the agent + its gates were configured **once at
  creation**. Re-running it is identical to a scheduled fire or the Sidebar "Run
  now" — it just runs. **B must reuse the v7.0.0 unattended fire path so it runs
  WITHOUT opening the app.**

A = convenience entry. B = the genuinely useful capability. Ship both.

---

## 2. Verified code anchors (HEAD, do not trust from memory — re-grep before editing)

### Widget (native)
- `…/scouter/ScouterWidgetProvider.kt` (1611 lines) — `AppWidgetProvider`.
  - Action dispatch in `onReceive` (line ~30): existing actions `ACTION_CYCLE_PET`,
    `ACTION_WAIT_EXPIRY_REFRESH`. **Add B's run action here.**
  - RemoteViews built ~line 234; click wiring pattern:
    `views.setOnClickPendingIntent(R.id.<view>, <pendingIntent>)`.
    - `launchPendingIntent(context)` → opens the app (root tap), line ~236.
    - `promptPendingIntent(context)` → opens `ScouterWidgetPromptActivity`, wired
      to `R.id.scouter_codex_ask`, line ~237. **A and B's buttons follow this
      exact pattern.**
  - PendingIntent helpers live in the companion (see `waitExpiryRefreshPendingIntent`
    line ~190 for the broadcast pattern; B uses a **foreground-service** PI, see §4).
  - Layout: `res/layout/scouter_widget_medium.xml` — add the new button view id(s).
- `…/scouter/ScouterWidgetPromptActivity.kt` (801 lines) — the existing prompt
  dialog. `launchAgentChatResume()` (line ~265) shows the **deep-link-from-Activity**
  pattern: `Intent(ACTION_VIEW, Uri.parse(agentChatResumeUri(...)))` +
  `FLAG_ACTIVITY_NEW_TASK`. **A reuses this** (ACTION_VIEW from an Activity is NOT
  the Knox-blocked `am start` from app uid — see §5).
- `…/scouter/ScouterStateStore.kt` — `ScouterWidgetConversation` has
  `widgetPrompt/widgetStatus/...`. **B's status row adds next/last-scheduled-run
  fields here** (mirror the existing snapshot-field pattern).

### Native unattended run path (the v7.0.0 path B reuses)
- `…/AgentAlarmScheduler.kt` — builds the `getForegroundService` PendingIntent
  targeting `TerminalSessionService.ACTION_RUN_AGENT` with `EXTRA_AGENT_ID`
  (+ `EXTRA_INTERVAL_MS` / `EXTRA_CRON`). **B fires the SAME intent shape.**
- `…/TerminalSessionService.kt` — `ACTION_RUN_AGENT` branch calls
  `runAgentInBackground(agentId)` then re-arms via `AgentAlarmScheduler.scheduleNext`.
  **B's widget tap targets this service directly** (no re-arm needed for a manual
  run — pass interval/cron absent so it doesn't reschedule, OR add an
  `EXTRA_MANUAL=true` guard so scheduleNext is skipped).

### RN entry points (for A's deep-link routing + reference)
- `app/_layout.tsx` ~line 945 — `handleDeepLink(url)` for `Linking` events +
  `getInitialURL()` cold-start. Existing `shelly://agent-chat?compose=1` is handled
  here. **A adds a `shelly://agent/new?voice=1` branch** that focuses the agent NL
  input with the mic armed.
- `lib/agent-manager.ts:387` — `runAgentNow(agentId, runCommand, options)`: gated,
  honors the global kill-switch (`useAgentStore.getState().halted`), orchestration
  aware. This is the RN-side run path (used by Sidebar "Run now"). **B does NOT
  need this if it uses the native service path (§4); listed for reference / as the
  fallback route.**

---

## 3. Task A — input shortcut (small)

1. **Widget**: add a "＋ New agent" affordance (a small button, or repurpose the
   root/long-press) in `scouter_widget_medium.xml` + `ScouterWidgetProvider.kt`.
   Wire it to a PendingIntent that launches `ScouterWidgetPromptActivity` in an
   **agent-new mode** OR directly fires an `ACTION_VIEW` `shelly://agent/new?voice=1`.
   - Simplest: an `ACTION_VIEW` deep-link PI (Activity → ACTION_VIEW is allowed;
     `getActivity` PendingIntent, not `am`).
2. **RN**: in `handleDeepLink`, add the `shelly://agent/new` branch → open the
   agent input pane, arm voice if `?voice=1`. Land on the SAME NL→card flow.
3. **Status row** (shared with B): add next-scheduled-run (agent name + next fire
   time) and last result (success/error) to the widget. Source = new
   `ScouterStateStore` fields written by RN (mirror `widgetStatus`).

A's acceptance: widget tap → app opens at agent input (mic armed) → speak →
**card appears** → Confirm registers. (Card is expected for A — it's an input
shortcut, not a bypass.)

---

## 4. Task B — one-tap run of an existing agent (the real one)

**Design: widget button → `PendingIntent.getForegroundService(...)` targeting
`TerminalSessionService` with `ACTION_RUN_AGENT` + `EXTRA_AGENT_ID` (+ a manual
marker).** This is byte-for-byte the v7.0.0 alarm-fire path, just triggered by a
tap instead of `setExactAndAllowWhileIdle`. **No app open, no card.**

1. **Which agent(s)?** Decide the widget surface:
   - MVP: a single **pinned** agent (a `pinnedAgentId` in settings, or "the next
     scheduled one") with one RUN button. Cheapest, clearest.
   - Later: a short list (top N agents) each with a RUN affordance — but widget
     RemoteViews lists need a `RemoteViewsService`/collection adapter; keep MVP to
     1 button.
2. **Widget action**: add `ACTION_RUN_AGENT_FROM_WIDGET` to `ScouterWidgetProvider`
   `onReceive`, OR directly build a `getForegroundService` PI (preferred — no
   broadcast hop). Reuse `AgentAlarmScheduler`'s intent-construction so the extras
   match exactly.
3. **Service**: ensure `TerminalSessionService.ACTION_RUN_AGENT` does NOT re-arm
   the schedule for a manual run (pass no interval/cron, or gate `scheduleNext`
   behind `!EXTRA_MANUAL`).
4. **Status feedback**: after the run, native already updates run logs; surface
   next/last on the widget via the §3 status row so the tap has visible feedback.

B's acceptance: from the home screen, tap RUN on a registered agent → it runs
**without the app opening and without a card** → output lands where the agent is
configured to write → widget status row shows last result. Per-action gates +
unattended fail-closed behave exactly as in a scheduled fire.

---

## 5. Guards / invariants (DO NOT violate)

- **No schedule-approval pills on the widget.** The existing ALLOW/DENY widget
  pills write `y\r` to a **live Codex PTY**; scheduled/unattended runs have no PTY.
  Schedule approval must stay on the **notification side** (the MVP §2.6 / B5
  single-use, run-id-bound, expiring handler). If you ever surface approval on the
  widget, it MUST ride the B5 stored-action dispatch handler and share its
  single-use/expiry — never build a separate fast-path button (replay/stale risk).
- **B runs EXISTING agents only.** No arbitrary new prompt executes card-less. A
  new prompt always goes through A → confirm card → gate. B's safety = the gates
  were set at creation; runtime per-action approval + unattended fail-closed still
  apply (same as a scheduled fire — **zero new attack surface**).
- **`am start` from app uid is Knox-blocked.** Native binaries that need to reach
  RN write to `$HOME/.shelly-deep-link-queue` (250 ms RN poll drain,
  `app/_layout.tsx` ~959). But A's widget deep-link uses **`ACTION_VIEW` from an
  Activity/`getActivity` PendingIntent**, which is allowed (it's not `am` from the
  app uid). B uses **`getForegroundService`**, also allowed (it's how the alarm
  fires today). Don't route B through `am`.
- **agent-store has NO persist.** The agent list is rebuilt from
  `~/.shelly/agents/*.json` each launch. The widget's "which agents exist" must
  read ground truth (disk / a snapshot RN writes), not a stale in-memory list.
- **Global kill-switch.** B must refuse to run while `halted` (STOP-ALL). The
  native path should check the same halted flag the scheduled fire checks, or
  route through a guard that does (`runAgentNow` already throws when halted —
  mirror that in the native manual path).

---

## 6. On-device verification (mobile-linked session)

A:
1. Add the Scouter widget to the home screen. Tap the New-agent affordance →
   app opens at agent input with mic armed → speak a prompt → confirm card appears
   → Confirm → agent registered (visible in Sidebar AGENTS).

B:
2. Pre-register an agent (e.g. a cheap "echo to a file" once-agent). From the home
   screen, tap RUN on the widget → **app does NOT open** → agent runs → output
   file written → widget status row shows last=success. Confirm via
   `dumpsys alarm | grep dev.shelly.terminal` (schedule state) and the agent's
   output dir.
3. STOP-ALL (kill-switch) on → widget RUN is refused (no run, status unchanged).
4. Per-action gate: an agent whose action needs approval, run unattended via the
   widget → it fails closed (declined at timeout), does not run unreviewed.

Note: on this device adb `$HOME` = `/` (NOT the app home); app home =
`/data/user/0/dev.shelly.terminal/files/home`; app-private agent dir is
unreadable via adb on a release build — use `dumpsys alarm` + the in-app AGENTS
detail (next/last/missed) for state checks. Screen recording is banned (breaks
Claude Code); live scrcpy mirror (no --record) is OK.

---

## 7. Out of scope for this slice
- Widget agent **list/collection** (multiple agents) — MVP is 1 pinned/next agent
  + RUN. Collection adapter (`RemoteViewsService`) is a follow-up.
- Voice-to-card auto-confirm — A always shows the card.
- Schedule approval on the widget — stays on the notification/B5 path.

---

## 8. On completion
- Move the DEFERRED "Secretary MVP — ウィジェット導線" entry to ✅ with the commit
  SHA, and update the Phase 0 MVP spec §7 Parked → done.
- `→ sync:` add the widget導線 to the README Autonomous-agents / Scouter section.
- Update `CLAUDE.md` "セッション開始時に必ず読むもの" if this becomes the active
  resume point.
