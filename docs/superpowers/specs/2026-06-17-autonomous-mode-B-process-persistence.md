# Autonomous Mode — Spec B: Process Persistence (depends on A)

Status: **MVP-thin, but scoped to SHORT tasks only** — agent-reviewed 2026-06-17
Created: 2026-06-17
Series: [A policy-gate](./2026-06-17-autonomous-mode-A-policy-gate.md) → B (this) → [C cloud-offload](./2026-06-17-autonomous-mode-C-cloud-offload.md)

> **Headline finding (do not soften):** the foreground service keeps the *app* process alive, but it is **NOT a phantom-process shield for codex's child processes.** "Flat process tree" is **structurally unachievable** while the `libexec_wrapper.so` LD_PRELOAD design exists. Therefore **long autonomous tasks cannot be made survivable locally — cloud offload (C) is the only real escape from the phantom-killer ceiling.** B makes *short* tasks robust; it does not make *long* tasks safe.

---

## 1. Ground-truth inventory (verified 2026-06-17)

**The two killers (don't conflate):** (1) ordinary cached/empty reclaim; (2) **Phantom Process Killer (Android 12+)** — kills when a process's children exceed **32**, and kills CPU-heavy phantoms regardless of fore/background.

**Process model of one `codex exec` run:**
- Launch chain: `AgentAlarmReceiver` → `startForegroundService` → `TerminalSessionService.runAgentInBackground` (daemon thread + 35-min `PARTIAL_WAKE_LOCK`) → `AgentRuntime.runAgent` → `ShellyJNI.execSubprocess` → single `fork()` + `setsid()` + `execve(linker64, …)` ([shelly-exec.c:102,115,184](../../../modules/terminal-emulator/android/src/main/jni/shelly-exec.c)).
- **`LD_PRELOAD=libexec_wrapper.so` re-execs EVERY tool through `/system/bin/linker64`** → each leaf tool = **2 phantom-pool entries** (`linker64` + tool). Persistent chain ≈ **5–7 processes**; every codex helper (`git`, `apply_patch`) adds a `linker64+tool` pair. Local-LLM agents fork a persistent `llama-server` sibling. Confirmed on real hardware (logcat `PhantomProcessRecord` entries).
- **The doubling actively pushes runs toward the 32 cap.** You cannot remove the wrapper — it is the bionic open()/exec fix.

**FGS:** EXISTS — `TerminalSessionService`, `foregroundServiceType="specialUse"`, persistent notification (id 7734), 35-min wakelock, execution on an in-process daemon thread ([TerminalSessionService.kt:210](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt)). **But** the forked codex children are separate `setsid` Linux process groups the phantom killer counts independently — the FGS does **not** shield them.

**Phantom mitigation today:** ZERO runtime. Only [process-guard.ts](../../../lib/process-guard.ts) detects SIGKILL and shows a wizard telling the user to run an adb command. The agent-executor's `llama-server` launch even **lacks the `nice -n 5`** that the TS autostart path has ([agent-executor.ts:601](../../../lib/agent-executor.ts) vs [llamacpp-setup.ts:550](../../../lib/llamacpp-setup.ts)).

**isolatedProcess:** does not exist (NET-NEW; deferred — note IPC cost).

## 2. What B delivers (honest scope)

1. **Run the autonomous loop inside the FGS** (already the case for scheduled agents — keep it, ensure the autonomous loop also uses it, proper type + ongoing notification). This IS a native advantage Termux can't cleanly hold; implement it properly.
2. **Serialize tool fan-out to 1** `[MUST-FIX #2 / #5]`: the agent runs **at most one tool subprocess at a time**, so peak phantom count = the persistent chain + one `linker64+tool` pair. This keeps a **short** task safely under 32. It does **not** make a long task safe.
3. **Throttle local-LLM CPU** so the agent isn't flagged as a CPU-heavy phantom: add the missing `nice` to the agent-executor `llama-server` launch (parity with [llamacpp-setup.ts:550](../../../lib/llamacpp-setup.ts)); bound `--threads`; intermittent/duty-cycle execution where feasible.
4. **Phantom budget accounting:** track an estimated live-phantom count during a run (chain + active tool pair + llama-server) and surface it; refuse to spawn a new tool when near a conservative ceiling (well under 32).

## 3. The load-bearing position (state plainly in spec & docs)

- **"Flat tree" → reframed as "serialized, fan-out = 1, peak ≤ N phantoms."** True flatness is impossible with the wrapper.
- **FGS ≠ phantom shield for children.** Say so explicitly.
- **Long autonomous tasks are OUT of local execution.** They are **refused or queued pending C** (cloud offload). Do not write B as if FGS solves long-run persistence — it does not.
- **Do NOT depend on the user disabling the phantom killer** via adb/developer options — OEM-fragile, reverts. Document only as an optional power-user note, never the strategy.

## 4. Routing consequence (feeds C)

The phantom ceiling is *why* duration is a routing axis in C: **long → cloud** is not a preference, it's the only way a long task survives. The quota-tight + long-task **dead cell** (can't cloud, can't survive locally) is handled in C via **defer/queue** — see [C §quota](./2026-06-17-autonomous-mode-C-cloud-offload.md).

## 5. Acceptance / tests

- [ ] Autonomous loop runs inside the FGS with the ongoing notification; survives app backgrounding for a short task.
- [ ] Fan-out is serialized: assert ≤1 active tool subprocess; assert peak phantom count stays under the conservative ceiling.
- [ ] `llama-server` launched by the agent path carries `nice`; CPU duty-cycle keeps it off the CPU-heavy-phantom flag.
- [ ] A task estimated as "long" is refused/queued locally (not silently run into a phantom-kill).
- [ ] Kill-switch (from A §8) tears down the whole process group including llama-server.

## 6. Out of scope (documented)

isolatedProcess split (future; note IPC cost), on-device container/VM (infeasible on Android), removing the linker64 wrapper (it's the bionic exec fix — can't).
