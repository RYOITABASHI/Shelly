# Autonomous Mode — Spec C: Cloud Codex Offload (own phase — NOT MVP)

Status: **Own phase, write LAST, gated behind A** — agent-reviewed 2026-06-17. **Do not call this MVP.**
Created: 2026-06-17
Series: [A policy-gate](./2026-06-17-autonomous-mode-A-policy-gate.md) → [B process-persistence](./2026-06-17-autonomous-mode-B-process-persistence.md) → C (this)

> Offload long / persistence-risky tasks to **cloud Codex** (OpenAI-hosted isolated container) so they survive device sleep; keep short / interactive tasks local-native. This is the direct answer to B's phantom-killer ceiling. **It is 100% net-new (no cloud-Codex path exists today) and carries the single most important safety interlock: auto-routing must never become auto-exfiltration.**

---

## 1. Ground-truth inventory (verified 2026-06-17)

- **No cloud-Codex path exists anywhere.** `case 'cli'` runs `codex exec` purely **local on-device** ([agent-executor.ts:867](../../../lib/agent-executor.ts)). Repo search for `codex cloud`/`cloud exec`/offload = zero execution code; existing specs list cloud execution as a **non-goal**. Net-new end-to-end.
- **Quota data exists but only Kotlin-side.** Parsed from codex session JSONL `rate_limits` (`JsonlSessionParser.parseCodexRateLimits`), rendered in the Scouter widget (5-cell remaining-quota bar + reset Chronometer). `agent-tool-router.ts` (TS) has **no access** — quota-as-routing-input is **net-new** (needs a JS bridge of those fields).
- **Auth** = `~/.codex` device-code OAuth (ChatGPT subscription). Use it; **never an API key in the agent path.**

## 2. Why C is load-bearing (not optional)

From [B](./2026-06-17-autonomous-mode-B-process-persistence.md): the phantom killer makes **long local autonomous tasks unsurvivable**, and "flat tree" is structurally impossible. **Cloud offload is the only real escape from the 32-process ceiling for long tasks.** So C is required for "autonomous mode handles long tasks" to exist at all — but it is sequenced as its own phase because of the safety machinery below.

## 3. Routing (extend the router with risk + quota axes) `[NET-NEW]`

Add axes (none exist today — current router is keyword→backend only):
- estimated duration (**long → cloud**), git self-containment (**self-contained → cloud**), interactivity (**interactive → local**), network-need (**heavy → cloud**).
- **Show the REASON per decision in Scouter/notifications.** No black-box routing.

### Quota-aware routing + the dead-cell fix `[MUST-FIX #4]`
Local burns phone CPU but **no subscription quota**; cloud burns **ChatGPT-subscription quota**. So quota/rate-limit state is a routing input (reuse the Scouter rate-limit gauge data): quota ample → heavy tasks cloud; quota tight → stay local, don't burn it.

**But** quota-tight + long-task is a **dead cell** — can't cloud (quota), can't survive locally (phantom killer, per B). A third outcome is **mandatory**:

| | quota ample | quota tight |
|---|---|---|
| short | local | local |
| long | **cloud** | **defer / queue** ← not "stay local" |

- **`defer/queue` (the required third option):** hold the task, notify *"quota tight — queued until quota resets, or approve burning it,"* let the user force-cloud. Never silently route long+quota-tight into a guaranteed local phantom-kill.
- **Split** (decompose into checkpointable sub-tasks) is **phase-2** — requires task-checkpointing infra we don't have. Do not promise it.

## 4. THE critical safety interlock — offload = boundary op `[MUST-FIX #3]`

Offloading = code leaves the device (repo checked out into an OpenAI container with full network access). **Auto-routing must not become auto-exfiltration.**

**Approval granularity = payload fingerprint, NOT per-session-once.** Per-session-once approves a *channel*; the *payload* is what leaks, and it mutates between offloads (a new `.env`, a freshly-staged secret, a different repo).
- Gate on a **hash of the offload payload manifest** = {file set + content hashes + target repo identity}.
- Approve once per **unchanged fingerprint**; **re-prompt whenever the fingerprint changes** (file added/modified since last approved offload, or repo identity change).
- **Secret-scan the payload** with [redact-secrets.ts](../../../lib/redact-secrets.ts) before every offload: a **new** secret hit → **hard-block even at L3** (silent ≠ ship credentials to OpenAI).
- L1/L2: **every** offload prompts. L3: silent allowed **only** for an unchanged, secret-clean fingerprint — L3 relaxes *prompt frequency only*, never the secret/diff safety (the [A §2 invariant](./2026-06-17-autonomous-mode-A-policy-gate.md)).
- Approval notice is explicit: *"This task will be sent to cloud Codex = your repository goes to OpenAI."*

## 5. Command surface & diff recovery `[NET-NEW]`

- Use **`codex cloud exec`** (GitHub-repo-scoped container). **No SSH** — never add/maintain/re-enable SSH-based remote execution in autonomous mode.
- Recover the **result diff** to the workspace; **review the diff before applying locally.**
- **Diff-apply review is NON-bypassable for any offload that touched the network**, regardless of level `[MUST-FIX #8]` — L3 relaxes prompt frequency, never the diff review where the risk (full cloud round-trip of the repo) is highest.

## 6. Auth & token expiry `[NET-NEW behavior]`

- Auth = existing `~/.codex` device-code OAuth. **No API key in the agent path, ever** (hard constraint; also see [A §4](./2026-06-17-autonomous-mode-A-policy-gate.md)).
- **In-flight OAuth token expiry:** a multi-hour cloud run whose token expires mid-flight needs a defined outcome — **re-auth-and-resume** if possible, else **fail-and-recover-partial-diff** (surface what completed, never silently drop). Spec the exact behavior before build.

## 7. Acceptance / tests

- [ ] Offload interlock: first offload prompts; an unchanged fingerprint doesn't re-prompt (L3); a changed fingerprint **re-prompts** even mid-session.
- [ ] Payload secret-scan: a new secret in the payload **hard-blocks at L3**.
- [ ] Quota-tight + long task → **defer/queue** with notification + force-cloud option (never silent local).
- [ ] Routing reason is shown in Scouter/notification for every decision.
- [ ] Diff-apply review cannot be bypassed for a network-touched offload at any level.
- [ ] OAuth token expiry mid-offload → defined re-auth/recover path, no silent drop.
- [ ] No API key is ever present in the offload execution env; no SSH path exists.

## 8. Out of scope (documented, with reasons)

- On-device container/VM/gVisor — infeasible on Android.
- SSH / arbitrary remote — policy-excluded; cloud `codex exec` is the **only** external execution path.
- Task-splitting/checkpointing — phase-2.
