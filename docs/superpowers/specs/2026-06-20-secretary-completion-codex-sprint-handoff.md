# Codex 2-Day Sprint Handoff — Autonomous Secretary Full Build (`/goal` loop)

Status: **Active handoff** — start here for the 2026-06-21/22 Codex sprint.
Created: 2026-06-20 (Claude Code, on `feat/secretary-ux-detail` → merged to main as #83)
Companions:
- North Star: [2026-06-16-hermes-secretary-north-star.md](./2026-06-16-hermes-secretary-north-star.md)
- Phase 0 MVP: [2026-06-16-hermes-secretary-mvp-phase0.md](./2026-06-16-hermes-secretary-mvp-phase0.md)
- B2 autonomous gate (verified): [2026-06-17-B2-on-device-verified-HANDOFF.md](./2026-06-17-B2-on-device-verified-HANDOFF.md)
- Autonomous-mode hardening track: [A policy-gate](./2026-06-17-autonomous-mode-A-policy-gate.md) · [B persistence](./2026-06-17-autonomous-mode-B-process-persistence.md) · [C cloud-offload](./2026-06-17-autonomous-mode-C-cloud-offload.md)

---

## 0. How to run this sprint (the `/goal` loop protocol)

The goal of these two days: **finish the on-device autonomous AI secretary as far as rate limits allow.** Work proceeds as a sequence of self-contained `/goal` chunks. Each chunk is "キリのよい" — it ends in a **buildable, device-testable** state. Paste the chunk's `/goal …` prompt verbatim into Codex; Codex implements it autonomously, then **stops at the device-test boundary**.

**The loop, per chunk (NON-NEGOTIABLE order):**

1. **Paste `/goal <chunk prompt>`** (the fenced prompts in §4 already encode the rules below).
2. Codex implements the chunk autonomously (long-horizon).
3. **Mandatory agent review BEFORE push.** Codex spawns a code-review subagent over its own diff; fixes all blockers/High; re-reviews if needed. No push until review is clean. *(This is the user's standing rule — see §2. native / OAuth / IPC / Android-security / exec-path changes especially.)*
4. `tsc --noEmit` + `eslint` clean. Then **push** to a feature branch and **open a PR** (do NOT merge yet).
5. **Trigger the CI build** (`gh workflow run "Build Android APK" --ref <branch>`), wait for green, confirm `latest.json` advanced.
6. **STOP. Hand back to the user** with a tight "what to device-test" list. The user self-installs (updater now fixed — see §3) and runs the on-device smoke.
7. User reports PASS/FAIL. On PASS → **merge the PR to main**, then the user runs the **next `/goal`**. On FAIL → Codex iterates (back to step 2) on the same branch.

**Why the human gate stays:** the agentic/native/exec paths cannot be proven by `--version`/`-p`. Only a real on-device round-trip (register → fire → action → approve) proves them. Codex never skips the device test by self-attesting.

**If rate-limited mid-chunk:** push WIP to the branch with a `WIP:` commit + a one-paragraph state note in the PR body, so the next session resumes cleanly. Never leave uncommitted work.

---

## 1. Where we are right now (2026-06-22)

**G5 merged to main (PR #89, branch `feat/secretary-inbound`, build 1600):** Phase-3 Telegram inbound gateway. A message from the single authorized chat becomes an `@agent` utterance that flows through the EXISTING confirm-card + secret-guard + command-safety + approval pipeline (inbound is strictly narrower than local — it can only create a draft card, never reach run/stop/delete; nothing runs without an on-device Confirm). Security core (`lib/telegram-inbound.ts`, pure) is unit-tested (13) + security-reviewed (no Blocker/High); the poller enqueues confirm cards only, token in SecureStore + never logged. **NOT device-tested live: the user does not use Telegram, so the live long-poll round-trip is unverified — but it's opt-in + off by default (dormant).** Deferred: live Telegram test, alternate inbound channel (user doesn't use Telegram), webhook mode, reply-back. **Next chunk: G6 (multi-step orchestration — largest/most expensive).**

**G4 merged to main (PR #88, branch `feat/secretary-router`):** Phase-2b Layer-2 scoring router (`lib/agent-router-scoring.ts`). After the hard guards, an `auto` agent's tool is chosen by a deterministic OFFLINE scorer (category affinity + reasoning weight + search + on-device bonus), with confidence + candidate scores recorded in the reason log and shown in the detail popup. Device testing fixed two integration bugs: (1) the scorer wasn't running because the NL parser pre-resolved a concrete tool — wired `tool:'auto'` at creation when RUN ON=Auto; (2) "summarize the news" misrouted to paid Perplexity — removed news/latest from the research keywords. Device-verified: a transform task scores Local (on-device-first) with the Scores line + "Why: Layer-2 scorer" visible; hard-guards-win + offline are unit-tested + reviewed. Deferred: cloud-key-missing fallback (P1), Qwen-0.8B classification (P2), keyword-set consolidation (P2). **Next chunk: G5 (inbound gateway).**

**G3 merged to main (PR #87, branch `feat/secretary-skills`, CI build 1594):** Phase-2a skill registry. Device-verified on build 1594: distill-on-success (gated save Alert after Run now), SKILLS sidebar section + detail/delete, Vault mirror (`91_Agent_Skills/`), success-count, no-cloud-leak. Device testing exposed that skill reuse never matched Japanese tasks (the tokenizer couldn't word-segment JP) — fixed with a shared CJK-bigram tokenizer (`lib/agent-text-match.ts`, used by skills AND memory recall); the "Use skill X?" toggle + recipe injection then verified on device. Deferred P2 (see DEFERRED.md): one-shot skill-save, semantic match, in-app skill editing, half-width katakana. **Next chunk: G4 (Layer-2 scoring router).**

**G2 merged to main (PR #86, branch `feat/secretary-memory`, CI build 1591):** Phase-1 persistent memory. Device-verified on build 1591: memory-write (fact at registration + result digest after a TS-driven run), recall injection (the recall block is baked into the generated run script's prompt — verified on device), the Memory (k notes) detail-popup line + list, and on-device execution. Deferred to P2 (see DEFERRED.md): scheduled-fire auto result-capture, semantic recall, per-fire recall freshness, NAME_STRIP marker leak.

**G1 merged to main (PR #85, branch `feat/secretary-phase0-finish`, CI build 1589):** secret-guard + reason log + tiered approval scaffolding + the one-shot **audit-persistence fix**. Device-verified on build 1589: audit persistence (survives one-shot delete + failure path), secret-guard forced-local (tool=Codex CLI overridden to on-device / cloud-fallback disabled), reason log in the detail popup, draft one-tap approval. **Still unverified (P1 release gate — see DEFERRED.md, blocked by Codex usage limit until 2026-06-24):** command-safety blocks a dangerous cli + cli in-app confirm (never one-tap), webhook host+payload-preview approval, approval single-use/expiry, SNS draft-only no-publish, secret-guard end-to-end with the local LLM actually loaded. **Next chunk: G2 (persistent memory).**

**(Earlier) Merged to main (`82f1a70e`, PR #83), CI build ~1584:**
- `583097aa` Sidebar agent **detail popup** (tap row → purpose/schedule/action/autonomy/last-result + Run now/Pause/Close) + card **"Project name"** label + `cleanupOrphanAgentFiles` orphan sweep. *(detail popup on-device-verified: smoke5 showed prompt + webhook + last error.)*
- `b7691533` **delete-resurrection fix** *(reviewed, NOT yet device-smoked)*.
- `f6e35540` **updater download fix** *(reviewed, NOT yet device-smoked)*.

**Phase 0 MVP status (six pillars from the MVP spec §2):**
| § | Pillar | State |
|---|---|---|
| 2.1 | NL self-registration + confirm card | ✅ #79 (A1–A3), unified `@agent` flow #82 (A5) |
| 2.2 | `codex exec` one-shot execution | ✅ reused; B2 gate **on-device verified** (build 1570/1580) |
| 2.3 | Action layer `draft`/`notify`/`webhook`/`cli` | ✅ #80 (B1), all action types smoked build 1578 |
| 2.4 | Routing: hard-guards + keyword + manual pin | ✅ pin + keyword + **secret-guard (A6) + reason-log** done (PR #85, device-verified build 1589) |
| 2.5 | Lifecycle + kill-switch | ✅ #82 (A4): circuit-breaker / pause-resume / STOP-ALL, device-verified |
| 2.6 | Push approval (tiered) | ✅ implemented (PR #85): draft one-tap device-verified; **webhook host+preview / cli in-app confirm / single-use+expiry still need on-device verify — P1 gate, blocked by usage limit until 6/24** |

**So Phase 0 is implemented and merged (PR #85); the security-critical approval paths for cli/webhook + single-use remain to be device-verified after the 6/24 rate-limit reset (tracked in DEFERRED.md as a P1 release gate).** Everything after G1 is North-Star Phases 1–4 + the Autonomous-Mode A/B/C hardening track. **Next: G2.**

---

## 2. Standing rules & invariants (read once, obey every chunk)

**Process rules (from the user, persistent):**
- **Agent review before every push** — mandatory, no exceptions. Especially native / Kotlin / JNI / OAuth / IPC / Android-security / exec-path / routing changes.
- **User does the on-device test** after each build. Codex stops at that boundary; never self-certifies the agentic path.
- **Code/comments/commits in English; UI strings via i18n (en.ts + ja.ts both).** Hardcoded colors banned (`useTheme()`/`theme.config`). New state → Zustand store.
- **No `am start` from the app, no shebang scripts in app_data_file** (Knox sepolicy) — shell→RN bridge is the `$HOME/.shelly-deep-link-queue` file-queue (250 ms poll in `app/_layout.tsx`). PATH-visible shims must be native binaries (jniLibs + LibExtractor + symlink), never `#!` scripts.
- **No screenshots / screen-record** (`screencap`/`screenrecord`/`scrcpy --record` break Claude Code on this device). Live `scrcpy` mirroring without `--record` is allowed.
- **DEFERRED.md is the single source of truth** for "later" items — anything descoped goes there with a priority, never a verbal "あとで".

**Security invariant for ALL autonomous work (the one that must never bend):**
> **"Silent" (L3 autonomy) only ever relaxes prompt *frequency* — never the secret-scan, never diff-review, never `command-safety.ts`, never the workspace-root boundary hard-denies.** Auto-routing must never become auto-exfiltration. Every relaxation of approvals must keep these four hard-deny layers intact.

**Approval tiers (MVP §2.6 — keep enforcing as you extend):**
| Action | Approval |
|---|---|
| `draft`, `notify` | one-tap from notification |
| `webhook` | one-tap **only with destination host + payload preview shown** |
| `cli` | **never one-tap** — open app, explicit in-app confirm of the exact command, routed through `command-safety.ts` 5-level check |

Approvals are **single-use, bound to a specific pending run-id, and expire** (no replay / stale re-fire).

---

## 3. Architecture landmines (we hit these — do not rediscover them)

- **`agent-store` has NO `persist`.** The agent list is rebuilt from `~/.shelly/agents/<id>.json` **on every launch** by `loadAgentsFromDisk` (`app/_layout.tsx`). **Disk json is the source of truth.** Any "agent CRUD" must write/delete the json, not just mutate the store, or it reverts on restart.
- **`getHomePath()` (lib/home-path.ts) returns a FALLBACK alias** `/data/user/0/dev.shelly.terminal/files/home` until `initHomePath()` resolves async. On this OEM build that alias does **not** resolve to the real files dir for some ops. **For shell file ops prefer the live shell `$HOME`** (what `enqueueApkDownload`/`deleteAgent` now use). The native `$HOME` (set by `HomeInitializer` → `File(context.filesDir,"home")`) is authoritative.
- **`rm -f <wrong-path>` exits 0** → silent. Any destructive shell op must **verify** (`[ ! -e … ] || exit 1`) and **assert exitCode**, not swallow. (This was the delete-resurrection bug.)
- **DownloadManager ignores `MANAGE_EXTERNAL_STORAGE`** and cannot write the public Downloads dir on targetSdk ≥29 → `SecurityException`, zero rows. Use `setDestinationInExternalFilesDir` (app-specific dir). (This was the updater bug. FileProvider `external-files-path path="."` already covers it.)
- **adb shell `$HOME` = `/`** (NOT the app home). App home = `/data/user/0/dev.shelly.terminal/files/home`. The app is a **release build → not debuggable → `run-as` fails → app-private dirs are unreadable via adb.** To inspect agent/schedule state from the PC, use **`adb shell dumpsys alarm | grep dev.shelly.terminal`** (counts active `AgentAlarmReceiver` alarms) or read state the app exposes to `/sdcard`. To see disk json, run `ls ~/.shelly/agents` **inside the Shelly terminal**, not adb.
- **Codex runtime exec must go through the linker64 wrapper** — raw `node`/`curl` exec is Knox-denied (exit 126) in the agent-script context. Route via `__shelly_linker64`.
- **Cron is a 3-pattern whitelist** (`*/N * * * *`, `M H * * *`, `M H * * D`) in `agent-scheduler.ts`. The NL parser must emit only these; otherwise leave schedule unset and require manual selection (never register an agent that can't fire).
- **In-app updater** (`components/layout/BuildsModal.tsx`) downloads to the app-specific dir now; it still accumulates old `shelly-apk*` dirs under `/sdcard/Download` — clean periodically.

---

## 4. The `/goal` chunk queue (paste each prompt verbatim, in order)

Each prompt is self-contained and already encodes: implement → **agent review before push** → tsc/eslint → push + PR (no merge) → trigger build → **stop for user device test**. Run them in order; only advance after the user device-PASSes the prior chunk and merges it.

> **Pre-flight (before G1):** the user self-installs the latest **main** build (CI ~1584) and smoke-tests the two already-merged fixes: (a) delete 7 test agents → in the Shelly terminal `ls ~/.shelly/agents/*.json | wc -l` drops to 0 → restart app → list stays empty (delete-resurrection fixed); (b) open the updater → APK download now progresses to 100% and installs (updater fixed). If either FAILS, fix that first (branches `b7691533`/`f6e35540` are the reference) before starting G1.

### G1 — Finish Phase 0 (secret-guard + tiered approval + reason log + SNS vertical)

```
/goal Finish the Phase-0 AI-secretary MVP in the Shelly repo so docs/superpowers/specs/2026-06-16-hermes-secretary-mvp-phase0.md §5 acceptance is fully met. Implement, in one branch feat/secretary-phase0-finish:

1. SECRET-GUARD (MVP §2.4, the A6 hard guard): add a cheap, offline regex scanner (new lib/secret-guard.ts) over the agent task text + prompt that matches credential/key/PII patterns (API keys, bearer tokens, private keys, emails+phones, AWS/GCP/GitHub token shapes). If it matches → force the route to on-device (local), record the reason, and NEVER fall back to cloud for that run. Wire it into the routing decision in lib/agent-executor.ts / lib/agent-tool-router.ts so it runs BEFORE any cloud route is chosen. command-safety.ts is danger-detection, not secret-detection — this is net-new.

2. REASON LOG (MVP §2.4): every routing decision records {route, which guard/keyword fired, why} into the agent run history (runHistory in store/agent-store.ts), surfaced in the existing agent detail popup (components/layout/Sidebar.tsx showAgentDetail).

3. TIERED PUSH APPROVAL + CLI CONFIRM UI (MVP §2.6, the B5 work): extend the notification approval so draft/notify are one-tap; webhook one-tap shows destination host + payload preview; cli is NEVER one-tap — it opens the app to an in-app confirm screen showing the exact command string, routed through command-safety.ts's 5-level check, non-auto-approvable above a safety threshold. Approvals must be single-use, bound to a specific pending run-id, and expire after a short window (no replay). Reuse the NotificationDispatcher.kt PendingIntent pattern and the existing $HOME/.shelly-deep-link-queue bridge; the B2 signed-reply escalation channel (docs 2026-06-17-B2-*) is already built and verified — extend, do not rebuild.

4. SNS VERTICAL: wire the existing SNS draft agents through the new action layer as the validation vertical, draft-only — confirm no publish capability is reachable (publish is a distinct, unshipped action type; the no-publish guarantee lives in the action-layer capability boundary, not a prompt convention).

Hard constraints: keep the security invariant — L3 silent only relaxes prompt frequency, never secret-scan/diff-review/command-safety/boundary. i18n en+ja for all new UI strings. New state in Zustand. Respect the 3-cron-pattern whitelist. Read docs/superpowers/specs/2026-06-20-secretary-completion-codex-sprint-handoff.md §2/§3 for the landmines (agent-store no-persist, $HOME vs getHomePath, Knox sepolicy bridge).

Before pushing: run a code-review subagent over the full diff, focused on (a) the secret-guard regex completeness + no-cloud-leak, (b) cli approval cannot be auto-approved, (c) approval single-use/expiry/run-id binding, (d) no native/IPC regressions. Fix all blockers/High. tsc --noEmit + eslint clean. Then push branch feat/secretary-phase0-finish, open a PR (do NOT merge), trigger gh workflow run "Build Android APK" --ref feat/secretary-phase0-finish, wait for green, and STOP. Report a device-test checklist: register an agent whose task contains a fake API key → confirm it's forced local with a visible reason; a webhook agent → approve from notification with payload preview; a cli agent → confirm it requires in-app confirm and command-safety blocks a dangerous command; verify single-use (re-tapping a used approval does nothing).
```

### G2 — Phase 1: Persistent memory (Obsidian Vault substrate)

```
/goal Build Phase-1 persistent memory for the Shelly AI secretary (North Star §5 Phase 1) on branch feat/secretary-memory. The Obsidian Vault on /sdcard is the substrate — do NOT add a new DB.

Scope: give agents a memory write/recall capability so the secretary is stateful across runs.
1. A memory store layer (new lib/agent-memory.ts) that writes structured memory notes as markdown files into a dedicated Vault folder (e.g. 90_Agent_Memory/), one fact per file with frontmatter {agentId, type, created, tags}, mirroring the existing Obsidian mirror pattern used by the draft action (lib/agent-executor.ts). Reads happen via the same Expo FileSystem path the agents already use; writes via the run-script shell with verified exitCode (see §3 landmine: verify file writes, never swallow).
2. A recall step injected into the agent run prompt: before codex exec, load the N most relevant memory notes for that agent (start with simple tag/recency match — semantic retrieval is parked) and prepend them as context. After the run, optionally extract a memory note from the result (a "remember this" capability the NL parser can set on the agent).
3. UI: the agent detail popup (components/layout/Sidebar.tsx) shows a "Memory (k notes)" line; tapping lists the agent's memory notes (reuse the popup/list pattern).
4. NL: extend the parser so utterances like "覚えておいて / remember that …" register a memory-write, and "前に言った…を踏まえて" enables recall.

Constraints: memory is on-device only; a memory note must never be silently sent to cloud — it flows through the same secret-guard (G1) before any cloud route. Keep writes idempotent and crash-safe. i18n en+ja. Read §3 landmines (agent-store no-persist → memory is files on disk, not store state; $HOME/Vault path resolution).

Before pushing: code-review subagent over the diff (focus: file-write crash-safety + verify, no-cloud-leak of memory, path correctness vs the Vault). Fix blockers/High. tsc+eslint clean. Push feat/secretary-memory, open PR (no merge), trigger the build, STOP. Device-test checklist: tell an agent to remember a fact, run it again later, confirm the fact is recalled into its next run; confirm memory notes appear in the Obsidian Vault on /sdcard and in the detail popup.
```

### G3 — Phase 2a: Skill registry + auto-generated skill docs

```
/goal Build Phase-2a skill registry for the Shelly secretary (North Star §5 Phase 2, Hermes' signature move) on branch feat/secretary-skills. Builds on G2 memory.

Scope: the secretary auto-generates reusable "skill docs" from successful runs and can recall+reuse them.
1. A skill registry (new lib/agent-skills.ts) storing skill docs as markdown in the Vault (e.g. 91_Agent_Skills/), each: {name, trigger-pattern, the prompt/recipe that worked, success-count, last-used}. Reuse the G2 memory file/frontmatter machinery.
2. Auto-generation: after a run succeeds (action completed, no circuit-breaker failure), offer to distill the {task → working prompt/route/tools} into a skill doc (gated, not silent — show the user what would be saved). Increment success-count on reuse.
3. Recall/reuse: when a new agent task matches an existing skill's trigger, surface "use skill X?" and prepend the skill recipe to the run prompt.
4. UI: a Skills section (reuse SidebarSection.tsx accordion) listing skills with success-counts; tap to view/edit/delete a skill doc.

Constraints: skill docs are on-device files; reuse the secret-guard before any cloud route. Skill creation is gated (user-visible), never auto-silent. i18n en+ja. Keep it additive — do not change the existing agent execution contract.

Before pushing: code-review subagent (focus: skill-doc injection can't leak secrets, gating is enforced, registry CRUD is crash-safe). Fix blockers/High. tsc+eslint clean. Push feat/secretary-skills, PR (no merge), build, STOP. Device-test: run a task, accept distilling it into a skill, then run a similar task and confirm the skill is offered + reused; confirm skill docs in the Vault and the Skills sidebar section.
```

### G4 — Phase 2b: Layer-2 scoring router (on-device classifier)

```
/goal Build Phase-2b the hybrid Layer-2 scoring router for the Shelly secretary (North Star §4/§5 Phase 2) on branch feat/secretary-router. Keep routing cheap and OFFLINE — never call the cloud to decide whether to use the cloud.

Scope: today routing = hard-guards (G1 secret-guard + offline) + keyword (suggestTool) + manual pin. Add Layer-2 scoring for the remainder.
1. A scoring router (extend lib/agent-tool-router.ts) that, AFTER the hard guards, scores candidate routes on {reasoning-weight, code/prose/search, capability, cost, latency} using a small on-device signal (start deterministic/heuristic; optionally a Qwen 0.8B classification call via the local-llm cascade — see project_local_llm_cascade — but only if it demonstrably helps and stays fast/offline). Hard guards always win; the LLM can never override a forced-local secret-guard decision.
2. Integrate the reason log (G1): record the full {task, route, reason, confidence} so a wrong route is shallow and visible. Manual pin still overrides everything.
3. Fallback chain stays: cloud fail/timeout → degrade to local, never silent.

Constraints: the routing decision itself must be offline + cheap (no cloud round-trip to route). Default stays on-device-first — do not widen the cloud default. i18n en+ja. Read North Star §4 (the two-layer routing principle) — it is load-bearing.

Before pushing: code-review subagent (focus: hard guards can't be overridden by scoring, no cloud call in the routing decision, secret-guard still forces local). Fix blockers/High. tsc+eslint clean. Push feat/secretary-router, PR (no merge), build, STOP. Device-test: tasks of different shapes (fresh-web vs private vs heavy-reasoning) route as expected with a visible reason; a secret-bearing task is forced local regardless of scoring; manual pin overrides.
```

### G5 — Phase 3: Inbound gateway (notification-tap → Telegram)

```
/goal Build Phase-3 the inbound messaging gateway for the Shelly secretary (North Star §5 Phase 3) on branch feat/secretary-inbound. "Direct it from anywhere."

Scope: today the gateway is outbound-only (notifications + anyclaw relay). Add a minimal INBOUND path so the user can issue/confirm agent tasks remotely.
1. Inbound channel: start with Telegram bot inbound (long-poll or webhook via the existing http stack) → a received message becomes an @agent NL utterance routed through the SAME confirm-card / secret-guard / approval pipeline as a local utterance (no privileged bypass). The phone stays the host; Telegram is just the gateway.
2. Identity/authz: bind the inbound channel to a single pre-authorized chat-id (config in ConfigTUI); reject anything else. Inbound NEVER auto-executes a cli action — it still hits the tiered approval (G1), and high-privilege actions still require in-app confirm on the device.
3. Reuse the file-queue bridge ($HOME/.shelly-deep-link-queue) to hand inbound messages from the network layer to RN (Knox: no am start).

Constraints: inbound is an attack surface — every inbound message flows through secret-guard + command-safety + approval tiers; an inbound request can never be wider than a local one. Channel is opt-in, single-authorized-id, revocable. i18n en+ja. Read §2 invariants + §3 Knox bridge landmine.

Before pushing: code-review subagent (SECURITY-CRITICAL: authz binding, no privilege escalation via inbound, cli still device-confirmed, secret-guard applied to inbound text). Fix all blockers/High — be conservative. tsc+eslint clean. Push feat/secretary-inbound, PR (no merge), build, STOP. Device-test: send a Telegram message → it appears as a confirm card on the device → confirm → it runs; an unauthorized chat-id is rejected; an inbound cli request still requires in-app confirm.
```

### G6 — Phase 4: Multi-step orchestration (sub-agent chaining)

```
/goal Build Phase-4 multi-step orchestration for the Shelly secretary (North Star §5 Phase 4) on branch feat/secretary-orchestration. This is the largest/most expensive item — scope it to a shippable first slice.

Scope: today execution is codex exec one-shot. Add Shelly-side multi-step orchestration for tasks that need more than one turn.
1. A small orchestration layer that can run a task as an ordered sequence of codex-exec steps, passing each step's result to the next, with intermediate-step surfacing in the agent run log. Start linear (no parallel fan-out); a step that fails feeds the circuit breaker.
2. Optional agent-to-agent handoff: an agent can enqueue a follow-up agent task on completion (gated by the same confirm/approval pipeline — no silent self-spawning of privileged work).
3. Respect the Autonomous-Mode A policy gate (docs 2026-06-17-autonomous-mode-A-policy-gate.md): multi-step autonomous runs must stay inside the canonical workspace-root boundary, route every command through command-safety, and honor L1/L2/L3 — L3 only relaxes prompt frequency, never the hard-denies. Heed the B-persistence finding: long local chains hit the Android phantom-process ceiling — refuse/queue beyond a step/time budget rather than hang (cloud offload is Phase C, gated).

Constraints: an orchestrated run can never exceed the privileges of a single manual command; sub-agent spawning is gated, not silent. Per-step timeout + crash detection (degraded honest failure, never silent hang). i18n en+ja.

Before pushing: code-review subagent (SECURITY-CRITICAL: workspace-root boundary holds across steps, no privilege widening via chaining, command-safety on every step, step budget enforced). Fix all blockers/High. tsc+eslint clean. Push feat/secretary-orchestration, PR (no merge), build, STOP. Device-test: a 2–3 step task runs end-to-end with intermediate steps visible in the run log; a step that escapes the workspace root is denied; a runaway chain is stopped by the step budget, not by hanging.
```

### Stretch / cross-cutting — Autonomous-Mode A policy-gate hardening

```
/goal Harden Autonomous Mode per docs/superpowers/specs/2026-06-17-autonomous-mode-A-policy-gate.md on branch feat/autonomous-policy-gate, wherever the prior chunks left gaps. Wire the existing (currently under-used) lib/command-safety.ts 5-level check into the autonomous exec path as a policy-first allow/deny/gray gate; enforce the canonical workspace-root boundary; enforce the OAuth/local-only tool allowlist; ensure the kill-switch + audit log cover every autonomous action. Governing invariant: L3 silent relaxes prompt frequency ONLY — never secret-scan, diff-review, command-safety, or boundary hard-denies. Before pushing: SECURITY-CRITICAL code-review subagent over the diff. Fix all blockers/High. tsc+eslint clean. Push, PR (no merge), build, STOP. Device-test checklist: an autonomous agent is denied a command outside the workspace root and a dangerous command, every autonomous action shows in the audit log, and STOP-ALL halts it mid-run.
```

---

## 5. Build / install / verify mechanics (so Codex can self-serve up to the device gate)

- **Build:** `gh workflow run "Build Android APK" --ref <branch>` → `gh run watch <id> --exit-status`. Artifact + `latest.json` land on the `android-dev` GitHub release. versionCode auto-increments.
- **Install (user, on device):** the in-app updater is now fixed (G-preflight) — open it, it pulls + installs `latest.json`'s build. If ever stuck again, the device-direct fallback is: in the Shelly terminal `curl -L -o ~/Download/shelly.apk "<browser_download_url>"` then tap to install. (Do NOT have CC/Codex download the 852 MB APK to the PC + adb install — device pulls directly.)
- **Signing:** device is on the canonical `NACRE_*` CI key → `adb install -r` / updater installs are non-destructive (no uninstall, settings preserved).
- **Schedule-state inspection from PC (read-only):** `adb -s <serial> shell dumpsys alarm | grep -cE "Alarm\{[^}]*dev.shelly.terminal\}"` = active agent alarms (drops to 0 after delete/STOP-ALL, returns after RESUME). Logcat tags: `HomeInitializer`, `ShellyExec`, `ShellyPTY`, `Sidebar`, `TerminalEmulator` (see CLAUDE.md table).
- **Disk hygiene:** after installs, delete `/sdcard/Download/shelly-update-*` and `shelly-apk*` (they accumulate 250–850 MB each). Keep `ShellyModels`.

---

## 6. Definition of done for the sprint

The secretary is "complete enough" when the North Star §3 gaps are closed to a shippable first slice:
- Phase 0 acceptance (MVP §5) fully met **on-device** (G1).
- Persistent memory: facts survive across runs (G2).
- Skill registry: successful tasks become reusable skills (G3).
- Hybrid router: offline routing with a visible reason log, secret-guard forced-local (G4).
- Inbound: direct it from Telegram, no privilege escalation (G5).
- Orchestration: multi-step runs inside the policy boundary (G6).
- Autonomous-mode hardening intact throughout (Stretch).

Each chunk that PASSes on-device and merges is a real increment — partial completion across 2 days is still a win. Update this file's §1 status + DEFERRED.md as chunks land, so the next session always knows the true state.
```
