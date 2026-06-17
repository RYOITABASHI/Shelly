# North Star — Shelly On-Device Autonomous AI Secretary

Status: **Vision / aspirational** (not a build order — see the MVP spec for what ships first)
Created: 2026-06-16
Companion: [2026-06-16-hermes-secretary-mvp-phase0.md](./2026-06-16-hermes-secretary-mvp-phase0.md)

---

## 1. The product in one sentence

A **fully on-device, offline-capable autonomous AI secretary** living inside Shelly — you tell it (in natural language) what you want done and when, and it registers itself, runs on schedule, takes real actions, remembers across sessions, and gets better the more you use it.

Reference product: **Nous Research "Hermes Agent"** (hermes-agent.org) — a self-improving autonomous agent. We are building the **pocket / offline** analog of it.

## 2. The wedge — why Shelly, not Hermes

Hermes runs on a **server/PC and is reached via messaging apps** (Telegram/Discord/Slack). Shelly's differentiator is the inverse:

- **The phone IS the always-on host.** No server to rent, no cloud dependency to stay alive.
- **Offline-capable.** The reasoning brain (Codex CLI / local Qwen) runs on-device. The secretary still works on a train with no signal.
- **The hardest infra is already built.** Shelly already bundles a terminal runtime, on-device CLIs with tool-use loops (Codex working; Claude in progress), multi-backend LLM access, cron→AlarmManager scheduling, a notification system, and an Obsidian Vault on `/sdcard`.

Design consequence: **do NOT copy Hermes 1:1** (server + messaging gateway). The notification system + terminal + (optional) Telegram inbound is the gateway; the device is the host.

## 3. The six pillars (Hermes parity) vs Shelly today

| Pillar | Shelly today | Gap to close |
|---|---|---|
| **Scheduled automation** | ✅ cron→AlarmManager ([agent-scheduler.ts](../../../lib/agent-scheduler.ts), [AgentAlarmReceiver.kt](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAlarmReceiver.kt)). Cron is a **3-pattern whitelist** (every-N-min / daily / weekly). | Richer cron / one-shot timers / event triggers |
| **Multi-backend LLM** | ✅ local Qwen / Perplexity / Codex / Gemini ([agent-executor.ts](../../../lib/agent-executor.ts)) | — (strong) |
| **Reasoning loop (agentic)** | ⚠️ `codex exec` **one-shot** only; no Shelly-side multi-step orchestration | Multi-step orchestration, sub-agent spawning |
| **Parallel sub-agents** | ⚠️ multiple agents exist but isolated | Orchestration + agent-to-agent handoff |
| **Messaging gateway** | ⚠️ outbound notifications + anyclaw relay; **no inbound** | Inbound (notification-tap → Telegram → others) |
| **Browser automation + vision** | ⚠️ BrowserPane (WebView) exists, not agent-driven | Programmatic browser control + vision |
| **Persistent memory** | ❌ runHistory = logs only; **but Obsidian Vault is the substrate** | Memory write/recall, semantic retrieval |
| **Automatic skill generation** | ❌ none | Skill-doc generation + registry + recall |

**Honest framing:** the built ~40% is the *hardest* 40% (on-device runtime, scheduling, multi-backend). But the remaining 60% (memory, skills, gateway, orchestration) is the **"secretary-ness" itself** and is not light. MVP (Phase 0) is cheap; full Hermes parity is a different, much larger thing. Keep those two mentally separate.

## 4. The brain: hybrid, on-device-first

**Default = on-device (Codex CLI / local Qwen). Cloud (Perplexity/Gemini) only when a hard signal fires** (freshness, vision, heavy reasoning). Not 50/50 — a 50/50 default quietly sends half of everything to the cloud and erodes the offline differentiator.

**The routing principle (load-bearing):** the *routing decision itself must be cheap and offline*. Never call the cloud to decide whether to use the cloud — that breaks offline operation and wastes cost/latency. Two layers:

```
Layer 1 — HARD GUARDS (rules; the LLM cannot override)
  offline            → local (forced)
  secrets/PII/keys   → local (forced)
  needs fresh web    → cloud Perplexity (forced)
  cloud quota empty  → local (degrade)
Layer 2 — SCORING (a small local model judges the remainder)
  reasoning weight · code/prose/search · capability · cost · latency
Execution — fallback chain
  cloud fail/timeout → degrade to local (never silent)
```

100% correct auto-routing is impossible. Ship **smart default + manual pin (per agent) + a visible reason log** so a wrong route is shallow, not catastrophic.

## 5. Phased roadmap (leverage order)

```
Phase 0  MVP — say-it-and-it-self-registers + action layer + approval   ← MVP spec
            (SNS draft agents = first scheduled skill / draft-only vertical)
   ↓
Phase 1  Persistent memory     — Obsidian Vault as the memory substrate.
            The core of "it grows with you." Cheapest here because the
            physical substrate (Vault on /sdcard) already exists.
   ↓
Phase 2  Skill registry + hybrid auto-router (Layer 2 + scoring).
            Auto-generate reusable skill docs (Hermes' signature move).
   ↓
Phase 3  Inbound gateway       — notification-tap → Telegram inbound →
            (later) more messaging platforms. "Direct it from anywhere."
   ↓
Phase 4  Orchestration         — Codex/Claude as the reasoning loop;
            parallel sub-agents + agent-to-agent chaining.
```

Phase 1 (memory) is placed before everything fancy on purpose: without it the secretary stays a stateless bot. Shelly's Obsidian Vault makes it the cheapest high-leverage step.

### Cross-cutting hardening track — Autonomous Mode (A/B/C)

Once agents run multi-step **without per-step approval**, they must be made *narrower than the manual terminal, never wider*. This is a security track that cuts across Phase 0's action layer and Phase 4's orchestration, specced separately (agent-reviewed 2026-06-17):

- **[A — Policy gate & sandbox](./2026-06-17-autonomous-mode-A-policy-gate.md)** (the autonomous-mode MVP): L1/L2/L3 autonomy levels, canonical workspace-root boundary, policy-first allow/deny/gray approval gate (wires the existing unused `command-safety.ts` into the exec path), OAuth/local-only tool allowlist, kill-switch + audit log.
- **[B — Process persistence](./2026-06-17-autonomous-mode-B-process-persistence.md)**: FGS run + serialized fan-out; **honest finding — FGS is not a phantom-killer shield for codex children, "flat tree" is impossible (LD_PRELOAD wrapper), so long local tasks are refused/queued pending C.**
- **[C — Cloud Codex offload](./2026-06-17-autonomous-mode-C-cloud-offload.md)** (own phase, gated behind A): the only real escape from the Android phantom-process ceiling for long tasks. Quota-aware routing with a defer/queue dead-cell fix; offload = boundary op with payload-fingerprint approval; `codex cloud exec` only (no SSH), OAuth only (no API keys).

Governing invariant for the whole track: **"silent" (L3) only ever relaxes prompt *frequency* — never secret-scan, diff-review, command-safety, or boundary hard-denies.** That is what keeps auto-routing from becoming auto-exfiltration.

## 6. Self-improvement loop (Hermes' "grows with you")

Long-term, every routing/skill decision is logged as `{task, route, reason, confidence, outcome}` into the memory layer (Vault), and the existing A/B-eval infra (`ab-article-eval`) scores whether the choice was good → the router and skill set improve over time. **This is research-grade (delayed, noisy reward; hard to define "good")** and is explicitly *parked* out of the MVP. It lives here, in the North Star.

## 7. What this doc is NOT

This is the destination, not the build order. Nothing here is a commitment to build in this form or sequence. The only thing being built now is the **MVP (Phase 0)** — see the companion spec. When in doubt, the MVP spec wins; this doc bends to it.
