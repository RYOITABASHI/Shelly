# Local-LLM Autostart Handoff — finish on-device autonomous inference (③ autostart hardening)

Status: **Active** — continue here. Branch `claude/work-handoff-2qb1xd` (HEAD `102ef61`, build 1608), **not merged to main**.
Created: 2026-06-23
Sprint parent: [2026-06-20-secretary-completion-codex-sprint-handoff.md](./2026-06-20-secretary-completion-codex-sprint-handoff.md) · DEFERRED "🔭 Vision — Fork-first plugin ecosystem + ③ capability ladder"

The adb-connected Claude Code session owns logcat / install / on-device verify. Everything below is grounded to exact lines on this branch.

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
