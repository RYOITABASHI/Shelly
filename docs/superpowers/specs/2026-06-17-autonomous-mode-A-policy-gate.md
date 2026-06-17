# Autonomous Mode — Spec A: Policy Gate & Sandbox (MVP, write first)

Status: **Ready to build (MVP of autonomous mode)** — agent-reviewed 2026-06-17, GO-WITH-CHANGES
Created: 2026-06-17
Series: A (this) → [B process-persistence](./2026-06-17-autonomous-mode-B-process-persistence.md) → [C cloud-offload](./2026-06-17-autonomous-mode-C-cloud-offload.md). **C is gated behind A.**
Related: [Hermes secretary north-star](./2026-06-16-hermes-secretary-north-star.md), [MVP Phase-0](./2026-06-16-hermes-secretary-mvp-phase0.md)

> Autonomous mode = an agent runs multi-step **without per-step human approval**. It must be **NARROWER than the manual terminal, never wider.** Manual terminal behavior is unchanged. This doc is the foundation: neither B nor C is safe without A.

---

## 0. Threat model (Android reality)

Shelly runs Codex CLI natively at **app uid**, no container, no Termux, no on-device VM/gVisor (infeasible on Android — documented as out-of-scope). The only isolation available is Linux process-group + Android FGS. Therefore safety is enforced at the **tool-invocation layer** (the commands the agent emits), not at the syscall layer. Reference policy model: OpenClaw "auto mode" — policy runs first, low-risk passes, gray → human-in-the-loop, full access is opt-in.

## 1. Ground-truth inventory (verified 2026-06-17 — what we build ON)

| Capability | Reality |
|---|---|
| Background-agent approval gate | **NONE.** Scheduled agents run silently; no approval, no safety check before `codex exec` ([agent-executor.ts:867](../../../lib/agent-executor.ts)). The only existing gate is for **live interactive Codex PTY y/n prompts** (NotificationDispatcher → ScouterWidgetPromptActivity writes `y\r`/`n\r`). "Approval Proxy" is a README/feature-gate name, not a runtime class. → **Background gate = NET-NEW** (but reuse the PTY-approval + push infra). |
| `command-safety.ts` | **EXISTS & comprehensive** (5 levels, detects rm -rf/dd/mkfs/git push --force/chmod -R) **but is imported NOWHERE in the agent exec path.** ([command-safety.ts](../../../lib/command-safety.ts)) |
| Workspace-root / canonical-path / symlink+`..` boundary | **DOES NOT EXIST anywhere.** NET-NEW. |
| Secret redaction | **EXISTS** ([redact-secrets.ts](../../../lib/redact-secrets.ts): sk-/sk-ant-/AIza/JWT/`*_API_KEY=`; Kotlin `redactForScouter`). |
| Codex auth | **OAuth (ChatGPT subscription)**, `~/.codex/auth.json` (`auth_mode="chatgpt"`, `OPENAI_API_KEY:null`). Read **ambiently** via `$HOME`, no access control. |
| API keys in agent path | **VIOLATION EXISTS:** `perplexity`/`gemini-api` tool types inject `PERPLEXITY_API_KEY`/`GEMINI_API_KEY` into the run env via `~/.shelly/agents/.env` ([agent-executor.ts:907,1099](../../../lib/agent-executor.ts)). The `auto` router **prefers** the Gemini API-key branch *before* falling back to OAuth-Codex ([agent-executor.ts:928](../../../lib/agent-executor.ts)). |

## 2. The cross-cutting invariant (governs A, B, and C)

> **"Silent" (L3) ever only relaxes *prompt frequency*. It NEVER relaxes secret-scan, diff-review, command-safety, or boundary hard-denies.**

This single rule is what keeps "auto-routing" from sliding into "auto-exfiltration." Every level, every phase, obeys it.

## 3. Autonomy levels (user-chosen, persisted, shown in Scouter)

- **L1 read-only** — reads auto; every write/exec → approval.
- **L2 workspace (default)** — r/w/exec **inside the canonical workspace root** auto; crossing the boundary → approval.
- **L3 full** — explicit opt-in only, one-time warning on first enable, never the default.

The level is **set by the human out-of-band (ConfigTUI)** and passed into the run as **immutable input** — never read from a file the run can mutate (see §6).

## 4. Tool-set allowlist — **autonomous = OAuth/local only** `[MUST-FIX #1]`

Autonomous execution tool set = **`cli` (OAuth-Codex) + `local` (Qwen) ONLY.** `perplexity` and `gemini-api` are **excluded** from autonomous runs (they carry long-lived plaintext API keys in env — a silent autonomous loop with an ambient Google key is a worse exfil channel than the gated cloud offload in C). They remain available in **manual/foreground** agent runs where a human is present.

Implementation: when `autonomous === true`, the `auto` router **drops the `GEMINI_API_KEY`-first branch** ([agent-executor.ts:928](../../../lib/agent-executor.ts)) and resolves only to `cli`/`local`. Enforced as an allowlist, not a comment.

## 5. Canonical workspace-root boundary `[NET-NEW]`

- At session start, resolve a **canonical workspace root** (realpath, fully resolved).
- Every agent-emitted file op: resolve **symlinks and `..` FIRST**, then compare against root. Outside root = **boundary event**.
- This logic does not exist today — it is the core net-new primitive of A.

## 6. Policy-first approval gate (the heart) `[NET-NEW, reuse approval infra]`

Classify **each agent-emitted operation**. **Boundary operations** =
`{ leaves workspace root | network send | reads secrets (auth.json, Keystore/expo-secure-store) | destructive cmd (rm -rf, dd, mkfs, git push --force, chmod -R) }`.

- **Policy = declarative DATA, not code** (a rule set file).
- **allow → run · explicit-deny → block + audit-log · gray → approval gate.**
- Approval gate reuses the existing PTY-approval + push-notification infra; the prompt shows **dry-run/diff**; the agent is **blocked until decide**.
- Wire **`command-safety.ts` into the exec path** (currently absent) — its CRITICAL/HIGH classifications feed the deny/gray decision.

**Secret-read boundary — narrowed `[MUST-FIX #5]`:** auth.json read by **codex's own runtime is implicitly ALLOWED** (intrinsic to running codex; cannot be gated without a syscall sandbox we don't have). The boundary op is any **agent-emitted command** that reads the secret file (`cat ~/.codex/auth.json`, `grep` over `$HOME`, etc.). Rule: *secret read by an agent-emitted command = boundary; read by the runtime itself = allowed.* Enforceable by path-match on tool-invoked commands.

**Policy file is itself boundary-protected `[MUST-FIX #6]`:** the policy file + autonomy level are **read-only to the agent**; any agent-emitted write to the policy path is a **hard-deny** (not gray, not self-approvable). Only the human UI mutates them. A prompt-injected agent must not be able to self-escalate. The §8 scan-hook should flag instruction-file content that names autonomy levels or policy paths.

## 7. Secret isolation & prompt-injection

- No ambient secret access for agent-emitted ops; auth.json/Keystore read = boundary even at L2 (per §6 narrowing).
- Continue secret redaction in all logs (reuse `redact-secrets.ts`).
- **Prompt-injection:** treat terminal output / file content the agent reads as **untrusted evidence, not instructions.** Ship a **stub hook** that scans skill/instruction files before use (interface now, impl later — cf. OpenClaw SkillSpector). MVP = interface stub only.

## 7a. Credential brokering & isolation `[grounded 2026-06-17]`

Industry precedent (OpenClaw — 21k leaked keys; Hermes Tool Gateway; Akamai): **never put secrets where the LLM can read them.** Achieve this in two tiers, sequenced cheapest-first.

### Tier 1 — Strip keys from the agent env (do first, ~5 lines, no native work) `[CHEAP-FIX]`
The single `source "$ENV_FILE"` at [agent-executor.ts:707](../../../lib/agent-executor.ts) is **tool-agnostic**, so a codex/local-only agent ALSO carries `PERPLEXITY_API_KEY`/`GEMINI_API_KEY` in its env — the exact OpenClaw leak surface. **Make the `.env` source conditional on tool type**: only HTTP-API tools (perplexity/gemini/auto/ab-eval) source it; the `cli`(codex)/`local` autonomous path runs with a **minimal, key-free env**. The JNI envp is already key-free and parent-independent ([shelly-exec.c:163](../../../modules/terminal-emulator/android/src/main/jni/shelly-exec.c)), so this needs zero native change and **closes the autonomous-path policy violation immediately, even before any broker exists.** This is the highest-leverage change in the whole credential story.

### Tier 2 — Broker (Hermes Tool-Gateway analog) for when a Codex agent must call an API itself `[BUILDABLE]`
When an autonomous Codex agent needs `research()` (perplexity) etc. **without holding the key**: the key stays in Shelly; the agent calls a tool that round-trips to a Shelly-held broker which executes the API call and returns **only the result text**.
- **Cheapest channel = a new authenticated route on the existing Scouter `HookHttpServer`** (`ServerSocket(127.0.0.1:ephemeral)`, `X-Scouter-Token` auth, thread pool; port/token already discoverable agent-side via `shelly scouter hooks`). Add `/broker/<capability>`; agent-side `shelly research "q"` curls it and blocks naturally on the response.
- **Why not the obvious alternatives:** `codex exec` is a one-shot black box (no MCP/tool-callback configured — `~/.codex/config.toml` only sets `check_for_update_on_startup`); Shelly hosts no MCP server (client-only); the RN-side `pseudo-shell.ts` that holds keys is **unreachable from a background agent's bash** (the on-PATH `shelly` binary is keyless/scouter-only). A local MCP server is the "most Hermes-correct" path but by far the most work and has unverified codex-exec-drives-MCP assumptions.
- **Open design decision:** `HookHttpServer` on/off is gear-menu controlled; a credential broker probably wants a **decoupled always-on listener** (or to guarantee the broker route survives Scouter being disabled). Also: keys are read RN-side today ([secure-store.ts](../../../lib/secure-store.ts)), so either move the brokered API call to RN (Kotlin enqueues → RN handles → responds) or expose the key to the Kotlin server process. Decide before building Tier 2.

### Hardening that applies to every surface that keeps a key `[NET-NEW, extend existing primitives]`
- **Lock agent-controlled loader overrides:** today `exec-wrapper.c` manages `LD_*` for its own redirection but does **not** reject agent-set `LD_PRELOAD`/`LD_LIBRARY_PATH`. Extend the existing `scrub_*_envp` primitives to reject agent-origin `LD_*`/`DYLD_*` (OpenClaw parity).
- **Enforced workspace-`.env` guard:** the script sources only `~/.shelly/agents/.env` and cwd=`$HOME` today, so a repo `.env` can't auto-inject — but this is *incidental*, not enforced. Add an explicit guard so a future `cd`-into-repo can't let a workspace `.env` override broker/gateway credentials.
- **Reader-agent isolation (prompt-injection blast-radius):** implement the §7 untrusted-evidence rule concretely as a **second restricted `codex exec`** (tools-disabled pass) that summarizes untrusted web/file content; only the summary feeds the main agent loop. Pure script orchestration (BUILDABLE); needs a one-line probe of whether codex-termux honors a no-tools flag. MVP = interface stub (per §7); real impl later.

## 8. Kill-switch + audit log `[MUST-FIX #4 — missing entirely from original]`

- **Kill-switch / mid-run abort:** a user-triggered hard-stop from the FGS notification that kills the codex **process group** (`kill -TERM -<pgid>`; children are in a `setsid` group, [shelly-exec.c:115](../../../modules/terminal-emulator/android/src/main/jni/shelly-exec.c)) and tears down children. Today the only bound is `timeout … || true` — there is no brake. Net-new, required.
- **Audit log:** every boundary-op decision (allow/deny/gray→approved/denied), every command run, timestamped, **redacted via `redact-secrets`**. An autonomous agent with no tamper-evident action log is unauditable after an incident.

## 9. MVP scope (Spec A = shippable autonomous mode for SHORT local tasks)

Build: canonical workspace-root + symlink/`..` resolution (§5) · `command-safety.ts` wired into exec path + allow/deny/gray gate reusing PTY-approval infra (§6) · tool-type allowlist (§4) · secret-read-boundary scoped to agent-emitted reads (§6) · policy-as-data, agent-read-only (§6) · L1/L2/L3 levels in ConfigTUI + Scouter display (§3) · kill-switch + audit log (§8) · prompt-injection scan = **interface stub** (§7).

**Out of MVP:** long-running task persistence (→ B), cloud offload (→ C), real prompt-injection scanner impl.

## 10. Acceptance / tests

- [ ] Symlink/`..` escape out of workspace root is detected and gated (boundary test).
- [ ] A `rm -rf` / `git push --force` emitted by the agent hits command-safety and is denied/gated.
- [ ] Approval gate blocks the agent until decide; deny is logged.
- [ ] An agent-emitted `cat ~/.codex/auth.json` is a boundary op; codex's own token read still works.
- [ ] Agent-emitted write to the policy file is hard-denied; level cannot be self-escalated.
- [ ] perplexity/gemini-api are unreachable in an autonomous run; `auto` resolves to cli/local only.
- [ ] Kill-switch terminates the whole process group mid-run.
- [ ] Audit log records every boundary decision, secrets redacted.

## 11. Docs to update (per task)

SECURITY.md + README "Runtime, permissions & execution": autonomy levels, threat model, "cloud Codex is the only external execution path (see C), no SSH, no API keys — OAuth subscription only." Note on-device container/VM and isolatedProcess are out-of-scope (with reasons).

## 12. Verification rule

Touches native (kill-switch process-group signaling, approval bridge) + the exec path → **on-device smoke test before merge** (boundary escape, gate block/resume, secret-read block, kill-switch). `-p`/`--version` checks are insufficient for the agentic path.
