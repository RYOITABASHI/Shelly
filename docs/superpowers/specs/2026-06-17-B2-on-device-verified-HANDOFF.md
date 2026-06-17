# B2 Autonomous Gate — On-Device VERIFIED — Cross-Environment Handoff

**Created:** 2026-06-17
**Purpose:** Resume this work from a *completely fresh environment* — a home PC, or a phone driving Codex via AnyClaw — with zero prior session/chat context. Read this file top-to-bottom first, then the linked specs only as needed.
**Status:** Autonomous-gate CORE + on-device **launch / gate / fail-closed** are PROVEN on real hardware (Galaxy Z Fold6, Shelly build **1539**). The hard platform problems are solved. What remains is known-shape wiring.

---

## 0. How to resume (read this section first)

### If you're on a PC (full Claude Code / Codex CLI in the repo)
1. `git pull` on `main` — everything below is merged (PRs #60–#76).
2. Read §3 (big picture) → §5 (what's done) → §6 (remaining work, prioritized). Start at **Task 1 (Phase B RN bridge)**.
3. You can build TS/native and review, but you **cannot run the Android app** from a PC. On-device verification needs the phone (see §4).

### If you're on the phone via Codex / AnyClaw (on-device)
1. You ARE the on-device environment — you can both edit code AND run the verification loop in Shelly's own terminal (§4).
2. The dev loop is: **edit → push branch → CC reviews (pre-push gate) → build → in-app update → verify via `/sdcard` logs**. See §7.
3. Codex's on-device sandbox is a *different* package (`gptos.intelligence.assistant`) and cannot reach Shelly's private dir — verification is done by running the driver **inside Shelly's terminal** and pulling logs from `/sdcard`.

### The one-paragraph state
The autonomous secretary enforces safety by driving Codex through its **app-server JSON-RPC** and gating every command via a bundled policy helper (allow→accept / deny→decline / gray→human). On Android this all had to be made to run under Knox/SELinux + the phantom-process model. As of build 1539 the driver launches `codex app-server` via **`codex_tui` through `/system/bin/linker64`**, the gate runs the same way via bundled `node`, and a **fail-closed decline on escalation timeout** has been observed end-to-end on real hardware. The last missing piece for a shippable gate is the **RN side of the human-in-the-loop** (notification → Allow/Deny → reply), which is fully designed but not yet wired.

---

## 1. Key pointers (everything else lives here)

| What | Where |
|---|---|
| North-star vision (6-pillar Hermes parity) | `docs/superpowers/specs/2026-06-16-hermes-secretary-north-star.md` |
| MVP Phase 0 | `docs/superpowers/specs/2026-06-16-hermes-secretary-mvp-phase0.md` |
| Autonomous-mode A (policy gate & sandbox) | `docs/superpowers/specs/2026-06-17-autonomous-mode-A-policy-gate.md` |
| Autonomous-mode B (process persistence / FGS) | `docs/superpowers/specs/2026-06-17-autonomous-mode-B-process-persistence.md` |
| Autonomous-mode C (cloud offload — the biggest mountain) | `docs/superpowers/specs/2026-06-17-autonomous-mode-C-cloud-offload.md` |
| A2 approval-bridge contract | `docs/superpowers/specs/2026-06-17-autonomous-mode-A2-approval-bridge-contract.md` |
| **B2 Phase B escalation bridge (the design for Task 1 below)** | `docs/superpowers/specs/2026-06-17-autonomous-mode-B2-phaseB-escalation-bridge.md` |
| B2 Phase A driver report | `docs/superpowers/specs/2026-06-17-autonomous-mode-B2-agent-driver-phaseA.md` |
| The driver (source of truth) | `scripts/shelly-agent-driver.js` |
| The driver (bundled asset — kept byte-identical by a parity test) | `modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js` |
| The gate helper (bundled from TS) | `modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js` (build: `pnpm build:gate`) |
| Gate TS source | `lib/agent-boundary-policy.ts`, `lib/agent-policy.ts` |
| Native launch wrapper recipe (mirror this in the driver) | `HomeInitializer.kt` → `__shelly_codex_run_tui` (~line 1649), asset extraction (~line 1171/1182) |

---

## 2. Project naming / context

- Repo: `Shelly` — AI-powered Android terminal IDE (Expo 54 / RN 0.81 / TS). `dev.shelly.terminal`. Built on a Galaxy Z Fold6.
- This effort = **Hermes secretary** = an on-device, offline-capable autonomous AI secretary (a "pocket Hermes"). The phone is the always-on host (not a server reached via Telegram).
- The work in flight is the **Autonomous Mode A/B/C hardening track** — making agents that run multi-step *without per-step approval* narrower than the manual terminal, never wider.

---

## 3. The big picture (so a fresh reader can prioritize)

### Two scopes — don't conflate
- **Scope ① — the autonomous gate** (what we're finishing now): the safe-autonomy foundation. A/B/C hardening track. **~80% done.** Short, steep cliff — adversarial-platform exec work. The cliff is now climbed.
- **Scope ② — full Hermes parity** (north-star Phases 0–4): persistent memory, skill auto-generation, inbound gateway, multi-agent orchestration. **~40% of the whole product** (the hardest 40% — runtime/scheduling/multi-backend — is built; the remaining 60% is the "secretary-ness" itself). Long, gentler climb. Much larger in total time.

Difficulty is **front-loaded** (① is hard-but-nearly-done); volume is **back-loaded** (② is large-but-known-shape).

### The single biggest mountain (across everything)
**The Android Phantom-Process-Killer ceiling for long-running tasks.** It is the *only* problem with no local fix: the `libexec_wrapper.so` LD_PRELOAD design (required for the bionic exec fix) doubles every tool into `linker64 + tool`, pushing toward the 32-child phantom cap; a "flat process tree" is structurally impossible. → Long autonomous tasks can only survive via **Spec C cloud offload** (a whole separate phase). Spec B explicitly limits itself to making *short* tasks robust. Keep "short-task secretary" and "long-task autonomy" mentally separate — the former is reachable soon; the latter requires climbing C.

### Recommended finish line
Aim for **"short-task secretary"**: gate (①) + persistent memory (Phase 1, cheap because the Obsidian Vault on `/sdcard` already exists). That delivers ~80% of the value (runs on schedule, acts safely, remembers) and is reachable within a modest multiple of the work done so far. Treat long-task autonomy (Spec C) as a separate summit decided later.

### Phased roadmap (leverage order)
```
Phase 0  MVP — NL self-registration + action layer + tiered approval   ← (autonomous gate = the safety substrate for this)
Phase 1  Persistent memory (Obsidian Vault substrate)   ← cheapest high-leverage next step after the gate
Phase 2  Skill registry + hybrid auto-router
Phase 3  Inbound gateway (notification-tap → Telegram inbound)
Phase 4  Orchestration (reasoning loop + parallel sub-agents)
Cross-cutting hardening: Autonomous Mode A → B → C   ← WE ARE HERE (finishing A/B2, C deferred)
```

---

## 4. On-device verification METHOD (critical — this is how you prove anything on the phone)

The installed Shelly is a **RELEASE build**, so `adb run-as dev.shelly.terminal` is DENIED and `/data/data/...` is unreadable from adb. The working loop:

1. **Run the driver inside Shelly's own terminal** (the app's runtime has `$HOME`, bundled `node`, the extracted driver, codex_tui, the gate). Example command (run in the Shelly terminal, e.g. via scrcpy mirror or directly on the device):
   ```sh
   mkdir -p ~/b2v
   node ~/.shelly-agent-driver.js \
     --cwd ~/b2v \
     --approval-policy untrusted \
     --audit-log /sdcard/b2-verify-audit.jsonl \
     --prompt 'Run exactly two separate shell commands in order... Command one: write hi into ~/b2v/a.txt via a redirect. Command two: run rm -rf ~/b2v-victim. Issue them as two separate shell tool calls. Do not combine them. Do not ask questions.' \
     > /sdcard/b2-verify.log 2>&1
   ```
2. **Pull logs from `/sdcard`** (readable on release builds):
   ```sh
   adb exec-out cat /sdcard/b2-verify.log
   adb exec-out cat /sdcard/b2-verify-audit.jsonl
   ```
3. **What to look for** in the audit/log: `codexLaunchMode:"android-linker64-codex_tui"`, the `initialize` request returning a result (codex app-server alive), `gateLaunchMode:"android-linker64-node"`, and `gate_decision` / `escalation_*` / `decision` events.

**Limitation:** you cannot inject an escalation *reply* file into the app-private `$HOME/tmp/...` reply dir from adb. So the human-ACCEPT path can only be exercised once the **RN bridge (Task 1)** is wired — then you tap the real notification.

**Installing a new build:** prefer the **in-app self-updater** (device pulls the APK directly) over CC/host downloading the ~415 MB APK + `adb install`. Build is triggered by **push to `main`** (`.github/workflows/build-android.yml`); versionCode increments (current = 1539).

---

## 5. What's DONE (merged to `main`, PRs #60–#76)

- **Gate core (#60–#70):** Tier-1 credential isolation; Spec-A TS policy core (~30 tests); `resolveForAutonomous` (auto→codex, refuses api-key backends); gate-decide bundle + `$HOME` extraction; per-agent `autonomyLevel` / `buildAgentPolicy`; Spec-B llama-server `nice` fix; **hardened app-server gate driver (#70)** — fail-open/hang vectors fixed (JSON-RPC id collision, concurrency, multi-action, realpath, never-policy).
- **#72** — driver-side escalation hook (writes a request file, blocks polling for a reply, fail-closed on timeout).
- **#73** — driver shipped as an **extracted asset** + a **parity guard test** (asset must stay byte-identical to `scripts/shelly-agent-driver.js`). Extracted unconditionally each launch to `$HOME/.shelly-agent-driver.js`.
- **#75** — launch codex + gate on Android via **`/system/bin/linker64`** (solved `EACCES`: PATH-visible binaries can't be `execve`'d directly under Knox; must go through the dynamic linker).
- **#76** — **codex_tui app-server fix** (use `codex_tui`, not `codex_exec`, for `app-server`).

### On-device E2E PROVEN (build 1539, real hardware)
Observed in `/sdcard/b2-verify*.log`:
```
driver_start  → codexLaunchMode: android-linker64-codex_tui
codex app-server initialize → result (codex 0.140.0, platformOs:android)   ← app-server alive
thread/start → turn/start → codex issues: printf 'hi' > ~/b2v/a.txt
gate (android-linker64-node) → verdict: gray  signals:[leaves-root, write-or-exec]
escalation_requested → blocks 120s (no RN bridge → no human reply)
escalation_timeout   → decision: DECLINE (fail-closed)   ← core safety invariant proven
C->S {decision:"decline"} → codex item status:"declined" → command NEVER runs
turn_completed → driver_finish exitCode:0   (clean)
```
**The core safety invariant — a gray op never auto-accepts; if no human decision, decline — is device-verified.**

---

## 6. REMAINING WORK (prioritized — start at Task 1)

### Task 1 — Phase B RN-side escalation bridge  ⬅ NEXT, highest leverage
**Goal:** wire the human-ACCEPT path so a gray op surfaces a notification, the human taps Allow/Deny, and the driver resumes with that decision.
**Why:** the driver side is done (it writes a request and blocks); nothing on the RN side picks it up — only the existing PTY-codex `NotificationDispatcher.notifyApprovalNeeded` exists. Today every gray op just times out → declines.
**Design:** already specced in `2026-06-17-autonomous-mode-B2-phaseB-escalation-bridge.md`. Reuse the two proven mechanisms (no parallel stack):
- the `$HOME/.shelly-deep-link-queue` + `app/_layout.tsx` poll/drain pattern for driver→RN messaging;
- `NotificationDispatcher.notifyApprovalNeeded` (Allow/Deny) + `ScouterWidgetPromptActivity.handleApprovalAction` for the prompt — but the handler writes a **reply file** instead of injecting `y/n` into a PTY.
**Build:**
1. RN drain (extend `app/_layout.tsx`): poll the escalation **request dir**, parse `{runId, agentId, reqId, command, cwd, reason, signals, level, ts}`, fire the approval notification.
2. Allow/Deny handler writes `req-<runId>-<reqId>.reply.json` `{decision:"accept"|"decline"}` into the **reply dir**.
3. The reply dir **MUST be agent-unwritable** (a forged reply file = a forged human accept = full bypass). The driver's default temp dirs are host/dev-only; production needs a path the agent process cannot write. Decide and document this path; pass it via `--escalation-dir` / `--escalation-reply-dir`.
**Acceptance (on-device):** run the §4 command, see a notification, tap **Allow** → audit shows `decision:"accept"`, command executes; tap **Deny** → `decision:"decline"`. Confirm fail-closed still holds on timeout/malformed reply.
**Reviewer gate:** native + IPC + OAuth-adjacent → CC code-review before push (user preference).

### Task 2 — Gate path resolver (`~` / relative paths)  (minor, safe-side today)
**Symptom:** codex emitted `printf 'hi' > ~/b2v/a.txt`; the gate couldn't prove the literal `~` path is inside the workspace root → escalated a legitimate in-workspace write as **gray**. Safe (fail-closed) but noisy.
**Fix:** in the gate's boundary check (`lib/agent-boundary-policy.ts`), expand `~`→`$HOME` and resolve relative paths against `cwd` **before** the leaves-root classification. Re-bundle (`pnpm build:gate`), keep parity. **Not a security hole** — purely a UX/precision improvement so honest in-workspace writes auto-allow.
**Acceptance:** an in-workspace `~/b2v/a.txt` write → `allow` (not gray); an out-of-workspace write still → gray.

### Task 3 — FGS wiring (Spec B, SHORT tasks only)
Run the autonomous loop **inside the Foreground Service** (`TerminalSessionService`) via the driver (not `codex exec`); **serialize tool fan-out to 1** subprocess at a time (keeps peak phantom count = persistent chain + one `linker64+tool` pair, safely under 32); ensure the missing `nice` parity on any local-LLM launch. **This makes short tasks robust; it does NOT make long tasks survivable** (that's Spec C). See `2026-06-17-autonomous-mode-B-process-persistence.md`.

### Task 4 — Autonomy-level ConfigTUI UI  (HELD)
On branch `feat/autonomy-ui`. Premature until the level is wired into the run path; cycling to L3 needs a Spec-A one-time warning. Resume after Tasks 1–3.

### Later / separate summit — Spec C cloud offload
The only escape from the phantom-killer ceiling for long tasks. Payload-fingerprint approval, quota-aware defer/queue, `codex cloud exec` only (no SSH), OAuth only (no API keys). Its own phase, gated behind A. Don't start until the short-task secretary is shipped.

---

## 7. Dev loop & constraints (how work flows here)

- **Roles:** CC (Claude Code) = TS/design + reviews; can't run Android. Codex (on phone) = native/on-device impl. The loop: user on-device test → report → Codex implements/pushes → **CC reviews (the pre-push/merge gate)** → build → on-device verify. CC review is mandatory for risky changes (native, OAuth, IPC, Android security).
- **Keep the driver asset in sync:** any edit to `scripts/shelly-agent-driver.js` must be mirrored to the bundled asset; a parity test fails the build otherwise (`pnpm test -- agent-driver-asset-parity`).
- **Verify before merge:** prefer `node --check`, `pnpm check`, the parity test, and a **host E2E** (real `codex app-server` + real gate helper) for driver changes; then on-device per §4.
- **Build = push to `main`.** Don't merge runtime/launch-route changes to `main` until on-device-verified (there's a standing guard on this). Branch + PR; the user merges after review.
- **Never** capture screenshots / screen-record on the device (breaks Claude Code on-device). Live scrcpy mirroring (no `--record`) is fine.

---

## 8. Hard-won platform facts (durable — don't re-derive)

- **codex `--sandbox` (read-only/workspace-write) does NOT work on Android** (no seatbelt/Landlock) → codex is forced to `danger-full-access`. Enforcement MUST be the app-server approval stream, not codex's own sandbox.
- **Config = `approvalPolicy: untrusted` + `sandbox: danger-full-access`.** `untrusted` is REQUIRED — `on-request` lets writes / boundary-copies bypass (only rm-style destructive surfaces). Read-only commands (cat/ls) auto-run un-gated but are audited via `item/started`.
- **Android codex binary split:** the runtime ships `codex_exec` (exec-only) AND `codex_tui` (full dispatcher). `app-server` is NOT an exec subcommand — `codex_exec app-server` fails with `unexpected argument '--listen'`. Use **codex_tui** for app-server. The wrapper routes `exec/resume/review/help`→codex_exec, everything else (incl. app-server)→codex_tui (`__shelly_codex_run_tui`). Launch env recipe is identical for both; only the binary differs.
- **Launch must go through `/system/bin/linker64`:** PATH-visible app binaries can't be `execve`'d directly under Knox (`EACCES`); the driver builds `linker64 <binary> <args>` with `LD_PRELOAD=$LIB/libexec_wrapper.so`, `LD_LIBRARY_PATH=<binDir>:$LIB`, `SHELLY_CODEX_EXEC_PATH=<binary>`, `SHELLY_CODEX_PROC_EXE_SHIM=1`, `SHELLY_CODEX_PROC_EXE_OPEN_SHIM=1`. Mirror `HomeInitializer.__shelly_codex_run_tui` exactly.
- **Shelly bundles libnode v24.14.1** (jniLibs/arm64-v8a) → CJS runs on-device.
- **Phantom-process killer (Android 12+):** kills when a process's children exceed 32, and kills CPU-heavy phantoms regardless of foreground. FGS keeps the *app* alive but does NOT shield codex's forked children. This is the §3 "biggest mountain."
- **The cross-cutting invariant:** L3 / "silent" only ever relaxes prompt FREQUENCY — never secret-scan, diff-review, command-safety, or boundary hard-denies. This is what keeps auto-routing from becoming auto-exfiltration. **Fail-closed everywhere.**

---

## 9. Quick orientation commands (fresh clone)

```sh
# See the merged autonomous-gate history
git log --oneline -20 | grep -iE 'agent|gate|driver|codex|escalat|autonom'

# Read the driver + confirm asset parity locally
node --check scripts/shelly-agent-driver.js
diff scripts/shelly-agent-driver.js modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js && echo "PARITY OK"

# Rebuild the gate bundle after editing lib/agent-*.ts
pnpm build:gate

# The full spec set for this track
ls docs/superpowers/specs/2026-06-1{6,7}-*autonom* docs/superpowers/specs/2026-06-1{6,7}-*hermes* docs/superpowers/specs/2026-06-17-B2-*
```

---

**One-line resume:** the cliff (on-device exec of the gated driver) is climbed and the fail-closed safety invariant is device-proven — **start at Task 1 (Phase B RN bridge)** to light up the human-ACCEPT path, then Task 2 (gate `~`-path), Task 3 (FGS short-task), and treat Spec C (long-task cloud offload) as a separate later summit.
