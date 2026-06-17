# Autonomous Mode — B2 Phase B: Escalation Bridge (gray → human → resume)

Status: **Design / next handoff** — depends on B2 Phase A driver (feat/b2-agent-driver) merging.
Created: 2026-06-17
Parent: [A2 approval-bridge contract](./2026-06-17-autonomous-mode-A2-approval-bridge-contract.md) · [B2 Phase A driver report](./2026-06-17-autonomous-mode-B2-agent-driver-phaseA.md)

> Phase A's driver gates every command: allow→accept, deny→decline, **gray→(Phase A) log + decline**. Phase B replaces the gray stub with **true human-in-the-loop**: the driver pauses, asks the human via the existing notification, and resumes with the human's accept/decline. This is the only piece between the proven core loop and a shippable autonomous gate.

---

## 1. Requirement

When the gate returns `escalate` (gray — a boundary op: leaves-root / secret-read / network / HIGH-destructive that isn't a hard-deny), the driver must **block that one command's approval** until a human decides, then respond `accept`/`decline` to codex. Everything else (allow/deny) is unchanged from Phase A.

**Fail-closed (non-negotiable):** if the human decision can't be obtained — timeout, malformed reply, queue I/O error, app not running — the driver responds **decline**. A gray op never auto-accepts.

## 2. The bridge — reuse, don't rebuild

Reuse the two proven mechanisms (no parallel stack — A2 §1.5):
- **File-queue** (the `$HOME/.shelly-deep-link-queue` + `app/_layout.tsx` poll/drain pattern) for driver↔RN messaging — the driver is a node process in the FGS with no RN bridge, so a file queue is the established shell→RN channel.
- **Notification approval** (`NotificationDispatcher.notifyApprovalNeeded` Allow/Deny + `ScouterWidgetPromptActivity.handleApprovalAction`) for the human prompt — already built for live-PTY codex; here the Allow/Deny handler writes a **reply file** instead of injecting `y/n` to a PTY.

## 3. Flow

```
driver gate → escalate
  1. driver writes  $HOME/.shelly/agents/escalations/req-<runId>-<reqId>.json
       { runId, agentId, reqId, command, cwd, reason, signals, level, ts }
     then BLOCKS, polling for  req-<runId>-<reqId>.reply.json  (interval ~250ms)
  2. RN poll (extend the _layout.tsx drain) picks up the request →
       NotificationDispatcher posts an approval notification (reuse channel):
       title "Agent <name>: approve boundary op?", body = redacted command + reason,
       Allow / Deny actions (+ a dry-run/diff line where available)
  3. human taps → handler writes  req-<runId>-<reqId>.reply.json { reqId, decision:"accept"|"decline", by:"human", ts }
  4. driver reads the reply → responds { id, result:{ decision } } to codex → command runs / is declined
  5. driver deletes both files (single-use)
```

## 4. Rules

- **Timeout:** driver waits `ESCALATION_TIMEOUT_MS` (default 120_000). On timeout → **decline** + audit `{kind:"escalation_timeout"}` + a "auto-declined (no response)" notification. Tunable; never infinite (a hung approval would hang the turn).
- **Single-use, bound:** reply is keyed by `runId+reqId`; a reply for a different/expired req is ignored (no replay). The driver only accepts a reply file it is currently waiting on.
- **Redaction:** the command in the request file + notification is `redactSecrets`-ed (the request file lives under $HOME, agent-readable — see §6).
- **Validation:** malformed/partial reply JSON, or `decision` not in {accept,decline} → treat as **decline** (fail-closed).
- **L3:** at L3 the gate auto-allows (no gray), so Phase B is mostly an L1/L2 path. L3's one-time-warning is a separate ConfigTUI concern (Spec A §3), not here.

## 5. What Phase B changes in the Phase A driver

Replace the Phase A escalate stub (`log ESCALATE … action=decline`) with: write request file → poll for reply (with timeout) → map reply→decision. Keep it a pluggable `escalate(requestCtx) → Promise<'accept'|'decline'>` so the host harness can still pass a stub. Everything else in the driver is unchanged.

## 6. Security note

The escalation request file is under `$HOME` (agent-readable). It contains a command the agent already proposed (no new secret), redacted. The **decision** must come only from the human-tap handler (RN/Kotlin), never from anything the agent can write — i.e. the driver must distinguish a reply written by the approval handler from a reply file the agent could fabricate. Mitigation: the reply path/name is derived from the runId (not guessable mid-run) AND the driver should treat a reply that appears without a corresponding posted notification as suspect. Simplest robust option: have the **RN side write the reply to a location the agent cannot write** (e.g. app-private storage the run-script's cwd can't reach) and the driver read it via a small RN→driver signal — evaluate vs. the file-queue's simplicity during impl. Flag for the implementer; do not let a self-written reply file forge a human accept.

## 7. On-device (Codex + CC review; device-gated)

- Implement the RN drain + reply (extend `app/_layout.tsx` + the notification handler).
- Wire the driver escalate hook to the file queue.
- Verify on device via the mirror: an autonomous agent proposing a boundary op (e.g. write outside workspace) → notification appears → tap Allow → command runs; tap Deny / wait for timeout → declined. Capture the audit.

## 8. Out of scope

The per-command human prompt only. The autonomy-level UI (set L1/L2/L3) and the L3 one-time warning are the held `feat/autonomy-ui` work (Spec A §3), shipped once the gate enforces levels.
