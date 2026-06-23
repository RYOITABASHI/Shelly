# Local-LLM Autostart Handoff — finish on-device autonomous inference (③ autostart hardening)

Status: **Autostart RESOLVED ✅ — next is C (escalation ladder).** Branch `claude/work-handoff-2qb1xd` (HEAD `46d1a361`), **not merged to main**.
Created: 2026-06-23
Sprint parent: [2026-06-20-secretary-completion-codex-sprint-handoff.md](./2026-06-20-secretary-completion-codex-sprint-handoff.md) · DEFERRED "🔭 Vision — Fork-first plugin ecosystem + ③ capability ladder"

The adb-connected Claude Code session owns logcat / install / on-device verify. Sections §2/§3 below describe the (now-fixed) blockers; read §0-UPDATE first for the current state.

---

## §0-UPDATE (2026-06-23, later) — RESUME HERE

**🎉 The local-LLM autostart blocker is RESOLVED + on-device-verified.** A scheduled/@agent run now cold-starts the 2B server and infers, fully on-device. Verified on build 1612: `linker64` RSS ≈1GB (Qwen3.5-2B fully loaded), port 8080 LISTEN, no `CANNOT LINK`, and the run produced a draft (reached the approval stage). The fix was a 4-commit chain on top of `102ef61` (build 1608):

1. `28f7893a` — **T1/T2/T3**: installed-aware model fallback (8B requested → installed 2B used; readiness check uses the resolved `alias_name`); stale start-lock cleanup (lock dir holds `owner.pid`; cleared if holder dead / old; all `rmdir`→`rm -rf`); cold-start launcher unified to the in-app `.realpath` + `LLAMA_LIB_PATH` + linker64 mechanism.
2. `7b64e903` — **LOCAL_MODEL unbound fix**: the ③a char-cap `case "$LOCAL_MODEL"` was emitted BEFORE the `LOCAL_MODEL=…` assignment → `set -u` abort. Moved the assignment ahead of the case. (This — not lock/model — was what actually dead-ended every local run on 1608; the lock/model reason files were stale.)
3. `80e35d9d` — **T3 lib path**: put the binary's OWN dir (`dirname "$server_bin"`, where all `.so` live) FIRST on `LD_LIBRARY_PATH` (the `find`-based `LLAMA_LIB_PATH` returned empty in the agent exec context → libless plain-exec → "library libllama-server-impl.so not found"). Force the linker64 path when the binary is under `.local/llama.cpp`.
4. `6a72bff7` — **unset LD_PRELOAD**: the agent exec context sets `LD_PRELOAD=libexec_wrapper.so` (shelly-exec.c), inherited into the linker64 launch and breaking llama-server's `.so` resolution. The in-app Start unsets it; the agent now does too. **This was the final piece** — after it, the server loaded + listened. (Confirmed in isolation: `cd …/llama-b9371 && LD_LIBRARY_PATH="$PWD" /system/bin/linker64 "$PWD/llama-server" --version` prints the version with no LD_PRELOAD.)

**On-device THERMAL finding (important for C):** sustained 2B inference on the phone CPU **overheats the device** (Android posted the "端末の過熱 / auto-terminate in 20s" dialog). Thermal throttling also makes inference much slower. This is the strongest argument for **C (escalation)** — don't grind heavy/sustained work on-device; escalate off-device. Local should prefer small/fast tiers + idle-stop. NOTE: only the 2B is installed (no 0.8B), so test light tasks accordingly or install 0.8B.

**Also landed `46d1a361` (D + B), build pending (CI run 28009045184), device-test pending:**
- **D** — Sidebar `QUICK_FOLDERS` "AGENT" shortcut → `~/.shelly/agents` (each agent's result is under `<name>/output`; default outputPath is `~/.shelly/agents/<name>/output`, TerminalPane.tsx:1379). Lets the user SEE a draft result without the approval round-trip.
- **B** — native approval-notification dispatch: `TerminalSessionService` (agent FGS) now runs a `FileObserver` on the action-approval request dir, posting the notification via `NotificationDispatcher` independent of the RN 500ms JS poll (which dies when backgrounded/thermal-killed). CC-reviewed (no blockers). The earlier "通知が来ない" was largely a THERMAL symptom (the run/app died before/with the RN poll), not an approval-code bug.

**Device-test checklist for `46d1a361`:** (1) Sidebar → Files → AGENT shows agent output dirs; (2) run a LIGHT @agent draft, background the app → the approval notification still appears (FGS observer). Avoid heavy 2B runs for the B test (thermal confounds).

### Next chunk — C (③b-2 escalation ladder) [DESIGNED, not yet implemented]
Replace the `local_context_fallback` dead-end (`lib/agent-executor.ts:1901`/`1911`) with **escalation**. Decision: **TS-orchestrated** (agent-manager re-runs with the next allowed tool, reusing the single-shot model + `resolveForAutonomous` gating + the G6 orchestration re-run pattern; the cloud backends already emit a `BACKEND_ERROR_FILE` for the ladder, agent-executor.ts:2134).
- Ladder: `local 2B(→0.8/4/8 if installed) → [non-autonomous only: Cerebras → Groq] → Codex(last)`; domain overrides: academic→Perplexity, image→Gemini (non-autonomous only).
- **Autonomous = local → Codex ONLY** (Cerebras/Groq/Perplexity/Gemini are `credentialClass='api-key'` → fail-closed; secret-guard always blocks cloud send; L3 silent relaxes prompt frequency only).
- Escalate on: model-not-found / API-key-missing / 429 (upfront AND mid-work) / ctx-overflow / server-can't-start / run error. Codex last (quota-preserving), never fake success on a Codex usage limit ("unlocks in N h"). Surface the route + why-escalated in the engine line + run history (existing `12647fd` pattern).

### Roadmap after C (to the acceptance North Star)
The North Star ("Mon/Fri STEAM×AI papers via Perplexity → primary source + summary into a dated Obsidian folder → re-summarize within X's limit, fully unattended") still needs, beyond C:
- **autonomous-cloud opt-in** (the crux): the North Star requires Perplexity web search, but autonomous is local→Codex-only. Need a per-agent, pre-approved, secret-guard-preserving opt-in to let a specific autonomous agent use cloud search.
- **auto-approval for in-Vault writes** (so an unattended run saves to the Vault without the approval gate).
- **multi-step orchestration (G6)** for the search→fetch→summarize→re-summarize chain.
- **dated-folder / weekly output templates.**
Rough distance: ~72-75% — the on-device brain works; the unattended end-to-end run needs the four integrations above.

---

## 1. Where we are

- **Branch:** `claude/work-handoff-2qb1xd` @ `102ef615`. Contains G1–G6 + this session's 7 commits. main未マージ; continue on this branch.
- **Build:** versionCode **1608** / gitSha `102ef615`; installed on device. latest.json → 1608.
  Direct DL: `https://github.com/RYOITABASHI/Shelly/releases/download/android-dev/Shelly-android-v6.0.0-1608-27992037105-1-102ef615eb13.apk`
- Updater DownloadManager 0B-stall is a known prior issue; device-side fallback is `curl -L -o /sdcard/Download/shelly-1608.apk "<url>"` then tap-install.

### This session's 7 commits (all CC-reviewed)
1. `94e9f02` readable, deduplicated agent notifications (name + plain text + telemetry-stripped preview; raw agent-id removed). ✅ device-verified.
2. `6d6a9db` one completion card after an approved draft (closure for silent finishes).
3. `12647fd` execution-engine line in notifications (route transparency: "Engine: Local LLM / Codex CLI"). ✅ device-verified.
4. `0202380` ③a: local LLM ctx 1024→8192/4096 + tier-aware cap on injected context (root-cause of the 7806-token overflow). ✅ ctx overflow gone (llama-server.log n_ctx=8192, zero "exceeds context size").
5. `c40a7bc` docs: fork-first culture + ③ ladder → DEFERRED.
6. `6e9e4aa` ③b-1: Cerebras/Groq as agent backends (OpenAI-compatible; `credentialClass='api-key'` → autonomous fail-closed rejects; non-autonomous OK; keys only via .env→env).
7. `102ef61` persistence: reuse a live local server even on model mismatch (stop destructive restart) + idle 180s→1800s.

---

## 2. On-device reality — the remaining blocker (start here)

✅ **Won:** ctx overflow eliminated (verified in llama-server.log).
❌ **Not yet:** a real on-device answer from a *cold* start. The reason files (`~/.shelly/tmp/local-llm-start-*.reason`) named three root causes, all in `lib/agent-executor.ts` `ensure_local_llm_server` (line 1330):

- **(A) start-lock leak** — `lib/agent-executor.ts:1359-1379`. The lock is a bare `mkdir "$LOCKS_DIR/local-llm-server-start.lock"`. If a prior run is killed while holding it (between mkdir@1363 and rmdir@1384/1442), the dir leaks; the 30×1s retry then gives up with *"could not acquire start lock"* and every later agent abandons autostart. **No stale-lock detection** (no holder PID, no age check).
- **(B) requested model not installed** — `lib/agent-executor.ts:1404-1409`. `find_local_llm_model "$model_name"` returns empty → *"GGUF model not found for $model_name"*. The scorer/LOCAL_LLM_MODEL asks for `Qwen3-8B-Q4_K_M` but only `Qwen3.5-2B` is installed. **No installed-aware fallback.**
- **(C) cold-start launcher incompatibility** — `lib/agent-executor.ts:1432` launches `"$server_bin"` directly, where `find_llama_server_bin` (1018-1030) returns `$HOME/.local/bin/llama-server`. The in-app Setup installs llama.cpp under `$HOME/.local/llama.cpp/` and launches via `.realpath` + `LLAMA_LIB_PATH` + `linker64` (`lib/llamacpp-setup.ts:233-262`, `REAL_LLAMA_SERVER_BIN_INIT`/`SERVER_BIN`). The agent's direct exec skips that, so shared libs don't resolve and cold start fails. **102ef61's reuse only helps if a server is already up** (manual Start → reuse → real answer; unverified). Unattended/scheduled cold-start is blocked by (A)(B)(C).

### First on-device check (prove the reuse path — user's hands + adb logcat)
1. In the Shelly terminal: `rm -rf ~/.shelly/agents/locks/local-llm-server-start.lock`
2. Settings → LOCAL LLM → Stop → Start (2B Running)
3. AI chat: `@agent 1たす1は?` → a real answer ("2") proves reuse. If it falls back, collect `cat ~/.shelly/tmp/local-llm-start-*.reason` + `tail -30 ~/models/llama-server.log`.
   adb backup: `adb logcat -d -s HomeInitializer:* Shelly:* AgentRuntime:* | tail -80`.

---

## 3. Next implementation — autostart robustness (T1–T3), all in `lib/agent-executor.ts`

- **T1 — installed-aware model fallback.** When `find_local_llm_model "$model_name"` (1404) is empty, fall back to the nearest installed GGUF tier (scan `$HOME/models` + `/sdcard/Download` + `/sdcard/.../ShellyModels`), pick the best available (8B→2B→0.8B order), record the substitution in the reason/log, and proceed instead of failing. The user repeatedly wanted "honor what's installed."
- **T2 — stale-lock cleanup.** Write the holder PID (and a timestamp) into the lock dir on acquire; before giving up (and ideally before the retry loop), if the lock's holder PID is dead OR its age exceeds a threshold, `rm -rf` it and retry. Never let a leaked lock permanently block autostart.
- **T3 — unify the cold-start launcher.** Make the agent launch use the same mechanism as the app: if `$HOME/.local/bin/llama-server.realpath` exists, read the real binary, compute `LLAMA_LIB_PATH` from `$HOME/.local/llama.cpp` `.so` files, and launch via `/system/bin/linker64 "$REAL_BIN"` with `LD_LIBRARY_PATH=$LLAMA_LIB_PATH` (port `REAL_LLAMA_SERVER_BIN_INIT`/`SERVER_BIN` from `lib/llamacpp-setup.ts:233-262`). With this, "manual Start" is no longer required — scheduled fire → autostart → inference → idle stop runs unattended.
  The fire mechanism is already robust: `AgentAlarmReceiver` `setExactAndAllowWhileIdle(RTC_WAKEUP)` → FGS(RUN_AGENT) → 35-min WakeLock → AgentRuntime → `.sh`; fires under Doze. Only server startup at that moment is the gap.

---

## 4. Roadmap after autostart (③ remainder — DEFERRED Vision is the source of truth)

- **③b-2 auto-escalation ladder:** scorer picks local(0.8→2→4) → Cerebras → Groq → Codex(terminal). Escalate on ctx-overflow / unreachable / 429 (upfront or mid-run). Codex last (quota-preserving); Cerebras/Groq only within free tier (429→next). Codex terminal limit must NOT fake success — notify "unlocks in N h". Escalation reason shows in the engine line.
- **③c:** inline `[ローカル]`/`[Codex]`/`[Perplexity]` pins (manual-pin guard; autonomous still rejects key-class even when pinned) + domain routing (academic→Perplexity, image→Gemini, non-autonomous only) + small fixes (raw-id in failure notices / fake-success on fallback).
- **Acceptance north star:** "Every Mon/Fri, search the latest STEAM×AI papers via Perplexity → primary source + summary into a dated Obsidian folder → re-summarize within X's char limit" completes fully unattended. Remaining unlocks: autostart (T1-T3) + autonomous-cloud opt-in + auto-approve for in-Vault writes + multi-day/dated-folder output templates.

---

## 5. Invariants (never relax under autonomy)

- Autonomous(unattended) = **local → Codex(OAuth) only**. Cerebras/Groq/Perplexity/Gemini = key-billed = **fail-closed** (`credentialClass='api-key'`). secret-guard always force-blocks cloud send.
- **L3 silent relaxes prompt *frequency* only** — never secret-scan / diff-review / command-safety(5-level) / workspace-root hard-deny.
- `cli` never one-tap (always in-app confirm). Approvals: run-id-bound, single-use, expiring, requestSha256-anchored.

## 6. Loop (strict)

implement → **mandatory agent review before push** (native / exec-path / Android-security strictest) → fix all → `tsc --noEmit` + eslint clean + jest green → push to `claude/work-handoff-2qb1xd` → `gh workflow run "Build Android APK" --ref claude/work-handoff-2qb1xd` → green → **STOP, hand the user a device-test checklist** (this session also self-installs + verifies via adb where possible). Rate-limit interrupt → WIP commit (never leave uncommitted).

Start: read CLAUDE.md → sprint handoff → DEFERRED Vision, prove the reuse path on-device, then implement T1.
