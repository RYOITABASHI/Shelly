# Autonomous Mode — A2: Approval-Bridge Integration Contract (for on-device Codex)

Status: **Implementation contract — hand to on-device Codex; CC pre-merge review**
Created: 2026-06-17
Parent: [Spec A — Policy Gate](./2026-06-17-autonomous-mode-A-policy-gate.md) §6 (enforcement substrate)
Depends on: PR #61 (Spec A TS core: `lib/agent-boundary-policy.ts`, `lib/agent-policy.ts`) landing in main.

> Goal: wire the TS gate (`decideAutoAnswer`) into the LIVE approval path so an
> autonomous agent's codex run is gated per-command without per-step human
> approval — allow→`y`, deny→`n`, gray→human. This is the piece that turns the
> Spec A TS core from "tested logic" into "actually enforced." Needs on-device
> work + verification → Codex implements, CC reviews.

---

## 1. Hard requirements (non-negotiable)

1. **Fail-CLOSED.** If a decision cannot be obtained (helper error, timeout, missing policy), the answer is **`escalate` (block + notify human)** — NEVER auto-`y`. A gate that fails open is worse than no gate.
2. **Background-robust.** Autonomous runs fire from AlarmManager into the FGS, possibly with **no Activity and no live RN JS context** (e.g. after reboot). The decision MUST NOT depend on the React Native JS runtime being alive.
3. **Single source of truth.** The decision logic is `lib/agent-policy.ts` + `lib/agent-boundary-policy.ts` + `lib/command-safety.ts`. Do **not** hand-reimplement it; see §3.
4. **Manual terminal unchanged.** Interactive (non-autonomous) codex keeps today's behavior exactly: WAITING_PERMISSION → human notification. The gate only intercepts **autonomous agent runs**.
5. **Reuse existing infra.** Do not build a parallel approval stack. Reuse the existing prompt-detection (NotificationDispatcher WAITING_PERMISSION / codex screen inspection), PTY-write (`y\r`/`n\r`), and notification-approval (for escalate).

## 2. The resolved design fork (why Kotlin→node, not Kotlin→RN, not a Kotlin port)

The decision is TS; the prompt-detection + PTY-write is Kotlin. Three ways to bridge:

| Option | Verdict |
|---|---|
| **Kotlin → RN → Kotlin** (call decideAutoAnswer in the RN JS context) | ❌ Violates req #2 — RN JS may be dead in an alarm-triggered background FGS. Fragile for a security gate. |
| **Port decideAutoAnswer to Kotlin** | ⚠️ Violates req #3 — duplicates command-safety's large pattern set; drift risk. Fallback only (see §3 sync guard). |
| **Kotlin → bundled `node` subprocess → Kotlin** ✅ | The agent runtime already bundles & runs `node`. Kotlin invokes a node gate helper (compiled from the TS modules), gets the decision. RN-independent (req #2), single-source (req #3), trivially fail-closed (node error → escalate). **CHOSEN.** |

## 3. The node gate helper `shelly-gate-decide.js`

- A **bundled standalone JS** produced from `lib/agent-policy.ts` (+ its imports `agent-boundary-policy.ts`, `command-safety.ts`, `redact-secrets.ts`) via an esbuild/metro one-shot bundle step (no `@/` alias / TS at runtime — bundle resolves them). Kept in `modules/terminal-emulator/.../assets/` and extracted like the other JS helpers.
- **Interface (stdin/argv → stdout):**
  - Input: JSON `{ "command": string, "policy": AutonomyPolicy }` on stdin.
  - Output (stdout, one line): the `GateOutcome` JSON from `decideAutoAnswer(command, policy)` — `{ answer: "y"|"n"|"escalate", verdict, audit }`.
  - Nonzero exit / unparseable output ⇒ caller treats as **`escalate`** (fail-closed).
- **Build/sync:** add a build script that regenerates `shelly-gate-decide.js` from the TS. To guard against drift, add a **shared fixture** (`__tests__/fixtures/gate-cases.json`: `{command, policy, expected}` rows) that BOTH the TS test (`agent-policy.test.ts`) and a smoke test of the bundled helper run against. (If a Kotlin port is ever chosen instead, it runs the same fixtures.)

## 4. Kotlin orchestration (extend the existing bridge)

In the existing WAITING_PERMISSION handling path (NotificationDispatcher / the codex screen-inspection that today calls `notifyApprovalNeeded`):

```
on WAITING_PERMISSION for a session:
  if NOT an autonomous-agent session  →  unchanged (human notifyApprovalNeeded)   # req #4
  else (autonomous):
     cmd   = extract the proposed command from the codex approval screen
     policy= the agent's AutonomyPolicy (passed in at run start — see §5)
     out   = run `node shelly-gate-decide.js`  (stdin = {cmd, policy}, short timeout)
     when out.answer:
       "y"        → write "y\r" to the PTY      ; append out.audit to the audit log
       "n"        → write "n\r" to the PTY      ; append out.audit (decision=deny)
       "escalate" → existing notifyApprovalNeeded(human)  ; audit decision=gray
       (error/timeout) → treat as "escalate"    # fail-closed, req #1
```

- The command extraction must capture the **full** proposed command (the classifier needs the whole string). If the screen-scrape only yields a truncated/garbled command, treat as **escalate** (fail-closed), don't guess.
- Audit log sink: append redacted `out.audit` (one JSON line) to `~/.shelly/agents/logs/<agentId>/audit.jsonl`.

## 5. Wiring the autonomy flag + policy into the run

- An autonomous agent run carries an `autonomous: true` marker + its `AutonomyPolicy` (level, workspaceRoot canonicalised at run start, secretPaths, policyPath, deny/allowPatterns). Decide the carrier (run-script env / a sidecar JSON the FGS reads) — must be readable by the Kotlin handler at approval time and **NOT writable by the agent** (policy-file hard-deny already covers writes).
- **`resolveForAutonomous` (TS, run-script generation):** before generating the run-script for an autonomous agent, resolve the tool via `resolveForAutonomous(agent.tool)` (lib/agent-credential-policy.ts): `auto→{cli,codex}`, api-key backends → rejected (no autonomous form without the Tier-2 broker). This guarantees the autonomous run is OAuth/local only (Spec A §4) before codex even launches.
- The autonomous codex invocation must use **interactive codex with `--ask-for-approval`** (a mode that emits the per-command approval prompts the bridge detects), NOT `codex exec` (danger-full-access, no prompts — Spec A §6).

## 6. On-device unknowns Codex MUST probe before/while implementing

These can't be settled from Windows — verify on device and report:
1. **Which codex invocation emits gateable approval prompts?** Confirm that interactive codex + `--ask-for-approval <mode>` actually pauses per command and that the existing screen-inspection detects it for a *scripted/autonomous* (non-hand-typed) session. If only the TUI emits them, define how the autonomous loop drives that TUI.
2. **Command extraction fidelity:** does the existing approval screen-scrape yield the full proposed command reliably? (Drives whether §4's extraction is trustworthy or must fail-closed often.)
3. **Latency:** codex blocks at the prompt while `node` decides — confirm the round-trip is acceptable (it should be; codex is already blocked).
4. **node availability in the FGS context:** confirm the bundled `node` runs from the Kotlin FGS path (it runs from the agent bash script today; confirm the direct-invoke path).

## 7. Acceptance (on-device)

- [ ] Autonomous agent proposing an **in-root write** at L2 → auto-`y`, audit `decision=allow`.
- [ ] Proposing **`rm -rf` / out-of-root write** → auto-`n` (destructive) / `escalate` (boundary), with audit + (for escalate) a human notification.
- [ ] Helper error/timeout → **escalate** (fail-closed), never `y`.
- [ ] Manual/interactive codex session → unchanged (human prompt as today).
- [ ] `audit.jsonl` accumulates redacted entries; no secret appears in it.
- [ ] An autonomous `auto`-tool agent runs as `cli` (resolveForAutonomous), key-free env (Tier-1).

## 8. Out of scope (this contract)

Prompt-injection reader-agent isolation (Spec A §7/§7a, interface stub only), Tier-2 broker (Spec A §7a), Spec B process-persistence (separate). This contract is ONLY the gate↔approval-bridge wiring.
