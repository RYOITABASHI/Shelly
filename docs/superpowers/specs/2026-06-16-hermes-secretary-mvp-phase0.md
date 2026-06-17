# MVP Spec — AI Secretary Phase 0 (say-it → it self-registers → it acts)

Status: **Ready to build** (GO-WITH-CHANGES, agent-reviewed 2026-06-16)
Created: 2026-06-16
North Star: [2026-06-16-hermes-secretary-north-star.md](./2026-06-16-hermes-secretary-north-star.md)

> This spec is the **thin slice that ships first**. Anything not listed here is out of scope — see §7 Parked. If a feature would make the slice thicker, it belongs in the North Star, not here.

---

## 1. The one outcome this MVP delivers

> The user types, in natural language, *"毎日8時にXの下書きを作って"* — Shelly parses it into a **structured agent**, shows a **confirmation card**, and on confirm the agent **registers itself and runs on schedule**, producing a draft and **notifying** the user. The user can **list / pause / delete** it at any time.

That's it. NL → preview → confirm → scheduled run → action → approval. The existing SNS draft agents are the **first scheduled skill** that exercises this end-to-end (draft-only, no publish).

## 2. Scope (the six things we build)

### 2.1 NL self-registration **with a confirmation/preview card** `[EXTEND]`
- NL parser extracts `{name, schedule, tool, action}` from a user utterance.
- **The parse produces a reviewable preview card, NOT a live agent.** Card shows: *"I'll run **\<action\>** **\<schedule\>** using **\<route/tool\>**."* with `[Confirm] [Edit] [Cancel]`. First registration ALWAYS requires one human confirm.
- The preview card **doubles as the edit UI** (reused in §2.5).
- Back-half is already wired: feed the confirmed struct into `createAgent` ([agent-manager.ts:130](../../../lib/agent-manager.ts)) → `installAgent` (:163); chat entry already exists at [TerminalPane.tsx:1312](../../../components/panes/TerminalPane.tsx). The net-new part is the **JP/EN NL→fields parser** + the card.
- **Schedule constraint (hard requirement):** cron support is a 3-pattern whitelist — `*/N * * * *`, `M H * * *` (daily), `M H * * D` (weekly) ([agent-scheduler.ts:9-29](../../../lib/agent-scheduler.ts)). The parser MUST emit only these shapes. If it can't, the card shows the schedule field as **unset and requires manual selection** — never silently register an agent that will never fire.

### 2.2 Execution via `codex exec` one-shot `[REUSE — not net-new]`
- MVP uses the **existing** `codex exec "$prompt"` one-shot path ([agent-executor.ts:867](../../../lib/agent-executor.ts)). `codex exec` is already agentic *within its single invocation* (it uses tools in that turn). We capture final stdout → result.
- **We do NOT build Shelly-side multi-step orchestration in the MVP.** That (sub-agents, agent-to-agent handoff, intermediate-step surfacing) is the single most expensive item and is North Star / Phase 4.

### 2.3 Action layer — 3 capability types `[NET-NEW type, small]`
- Add an `action` field to the `Agent` type ([store/types.ts:458](../../../store/types.ts)). Today the only output is `outputPath` (file write).
- Three action types for MVP:
  - **`draft`** — write result to `outputPath` (+ Obsidian mirror). This is today's behavior, made explicit.
  - **`notify`** — push notification with the result (reuse `notifyAgentResult` [agent-manager.ts:232](../../../lib/agent-manager.ts)).
  - **`webhook`** — HTTP POST the result (reuse `http_post_json` already emitted into every run script, [agent-executor.ts:128](../../../lib/agent-executor.ts)).
  - **`cli`** — run a command with the result. **(highest privilege — see §2.6 approval tiering)**
- **`draft` and `publish` are distinct capabilities. Ship `draft` only.** The "no publish" guarantee lives in the action-layer capability boundary, NOT as a Codex-prompt convention — a future NL-parsed "post to X" must not silently inherit publish.

### 2.4 Routing — hard-guards + keyword + manual pin `[MIXED]`
- **Default route = on-device** (Codex/Qwen). One explicit line in code/config: local-first.
- Reuse the existing keyword router `suggestTool` ([agent-tool-router.ts:33](../../../lib/agent-tool-router.ts)).
- **Hard guards for MVP (minimal set):**
  - **secrets/PII guard** — a regex scanner over the task text; if it matches key/credential/PII patterns → force local. (Net-new; small. `command-safety.ts` is danger-detection, not secret-detection.)
  - **offline** — MVP relies on the **existing reactive fallback** (cloud call fails → `local_context_fallback`, [agent-executor.ts:678](../../../lib/agent-executor.ts)). *Proactive* offline detection (needs `expo-network`, not currently a dep) is **parked** — default-is-local already makes offline mostly a non-event.
- **Manual pin (per agent):** `Run on: [Auto] [On-device] [Cloud]` surfaced in the preview/edit card (§2.1). Stored as a field on the agent. This is the user's escape hatch for bad local quality — do not widen the default, widen control.
- **Reason log:** every routing decision records why (which guard/keyword fired) into run history.

### 2.5 Agent lifecycle + kill-switch `[NET-NEW — table stakes]`
Autonomy without a stop button is not shippable. MVP must include:
- **List view** of registered agents (reuse `@agent list` data path).
- **Pause / disable** and **delete** per agent (`enabled` field already exists on `Agent`).
- **Global "stop all agents"** kill-switch (single toggle).
- **Circuit breaker:** auto-disable an agent after **N consecutive failed runs** (default N=3) so a misfiring self-registered agent can't loop forever (e.g. a bad webhook = self-inflicted DoS).
- **Minimal run log** per agent (last run, last result, last error) — reuse `runHistory` ([agent-store.ts:11](../../../store/agent-store.ts), last 30 logs).

### 2.6 Push approval — **tiered by action privilege** `[EXTEND]`
Reuse the notification action-button + PendingIntent pattern ([NotificationDispatcher.kt:163-215](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/NotificationDispatcher.kt)). **But** the existing Allow handler writes `y\r` to a *live Codex PTY*; a scheduled draft has no live PTY, so the Allow handler that dispatches the **stored action** is net-new (bridge via the existing `$HOME/.shelly-deep-link-queue` poll, [app/_layout.tsx](../../../app/_layout.tsx)).

Approval tiers (blast-radius control):
| Action | Approval |
|---|---|
| `draft`, `notify` | one-tap from notification |
| `webhook` | one-tap **only with destination host + payload preview shown** |
| `cli` | **never one-tap** — open app, explicit in-app confirm showing the exact command string, routed through `command-safety.ts` 5-level check; non-auto-approvable above a safety threshold |

Approvals are **single-use, bound to a specific pending run-id, and expire** after a short window (no replay / stale-notification re-fire).

## 3. Degraded path (Codex is the load-bearing brain)

Codex agentic execution on-device is fragile (it's a termux ELF fork; Claude re-enable unfinished). MVP must define failure behavior — **silence is the worst outcome for a secretary:**
- **Per-run timeout + crash detection** → mark the run failed (feeds the §2.5 circuit breaker), never hang forever.
- **Registration parse fallback:** if Codex can't parse the NL, fall back to a **deterministic template grammar** (e.g. `remind me <X> at <time>` regex) OR surface the raw text in the preview card with empty structured fields for the user to fill. NL parse must never hard-block registration.
- **Execution failure:** notify *"agent X couldn't run"*. A degraded honest failure is acceptable; silent non-execution is not.
- **Never** fall back to cloud secretly (breaks the offline promise and may leak the §2.4 secret guard's protected input).

## 4. Build order within the MVP

1. `Agent.action` type + action dispatch (`draft`/`notify`/`webhook`) after result is ready ([agent-executor.ts:788](../../../lib/agent-executor.ts)).
2. NL→fields parser (constrained to the 3 cron shapes) + deterministic fallback grammar.
3. Confirmation/preview card (also the edit UI) + manual-pin field.
4. Lifecycle: list / pause / delete / global stop / circuit breaker / run log.
5. Tiered push approval (notify→webhook→cli) + run-id-bound single-use approvals.
6. Secret-guard regex + reason log; wire the SNS draft agents through the new action layer as the validation vertical.

## 5. Done = (acceptance)

- [ ] Typing *"毎日8時に〜して"* yields a preview card with correct schedule `0 8 * * *`, an action, and a route; Cancel discards, Confirm registers.
- [ ] A registered agent fires on its AlarmManager schedule and runs via `codex exec`.
- [ ] `draft`/`notify`/`webhook` actions all execute; `cli` requires in-app confirm.
- [ ] User can list, pause, delete agents and hit a global stop.
- [ ] An agent failing 3× auto-disables and notifies.
- [ ] Codex unavailable → registration still possible (template/manual), execution failure notifies (never silent, never secret cloud fallback).
- [ ] Existing SNS draft agents run through the new action layer, draft-only (no publish capability present).

## 6. Verification note

Per project rule, changes touching native (notification handler, deep-link bridge, AlarmManager) and the routing/execution path need an **on-device smoke test** before merge — registering a real agent, confirming it fires, and confirming a real notification→approve→action round-trip. `-p`/`--version`-style checks are insufficient for the agentic path.

## 7. Parked — explicitly NOT in this MVP

- **Layer-2 local Qwen routing classifier** — per-task small-model inference = latency + battery + no model-selection UI. MVP routing is hard-guard + keyword + pin. Add when it demonstrably helps.
- **A/B-eval self-learning routing loop** — research-grade (delayed/noisy reward, "good routing" hard to define). North Star §6.
- **Proactive offline detection** (`expo-network`/NetInfo) — MVP uses the existing reactive cloud→local fallback.
- **Shelly-side multi-step agentic orchestration / parallel sub-agents** — North Star Phase 4.
- **Persistent memory layer, skill auto-generation, inbound messaging gateway, browser automation** — North Star Phases 1–4.
- **`publish` action capability** — distinct type, deliberately not shipped.
