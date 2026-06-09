# Shelly Content Agent Status

Updated: 2026-05-17

## Goal

Shelly単体で、Shelly/Chelly開発ログとSTEAM x AI発信をスマホだけで半自動運用する。

## Current Runtime

- Scheduler: Shelly native Android AlarmManager.
- Source collection:
  - Substack: Perplexity `sonar-deep-research`.
  - X: local Shelly/Chelly development context only. Perplexity is not used for X.
- Drafting:
  - Substack: `sonar-deep-research` first, Codex CLI for article reasoning when installed.
  - X: local Qwen3.5-4B from Git history, build logs, Obsidian notes, and agent outputs.
  - Local comparison: Qwen3.5-4B vs Codex via the A/B eval agent.
- Local LLM:
  - Agents use the OpenAI-compatible endpoint at `LOCAL_LLM_URL`.
  - For loopback URLs such as `http://127.0.0.1:8080`, agents can auto-start `llama-server` with Qwen3.5-4B when the binary and GGUF model are present.
  - Auto-start does not kill an existing healthy `llama-server`; concurrent starts are guarded by a lock.
- Publishing:
  - X API is not used.
  - X agents do not use Perplexity, paid APIs, or web scraping.
  - Outputs are drafts in Obsidian / Shelly files.

## Default Agent Cadence

- Monday 06:00: academic source collection.
- Monday 08:00: Substack deep-research draft.
- Monday 10:00: Codex article draft.
- Daily 07:00: X dev-log source collection.
- Daily 08:00: X casual draft.

## Output Paths

Shelly project:

```text
~/projects/shelly-content-studio
```

Obsidian mirror:

```text
/sdcard/Documents/ObsidianVault/20_Literature/Papers
/sdcard/Documents/ObsidianVault/50_Drafts/Substack
/sdcard/Documents/ObsidianVault/50_Drafts/X
/sdcard/Documents/ObsidianVault/90_Log/Agent_Output
```

Duplicate source registry:

```text
~/projects/shelly-content-studio/sources/source-registry.tsv
```

## Remaining Risks

- `PERPLEXITY_API_KEY` is required only for Substack academic/deep-research agents.
- X agents require `llama-server`, Node, and a Qwen3.5 GGUF model when using local Qwen3.5-4B. Set `LOCAL_LLM_MODEL_PATH` if the model is not in the standard search paths.
- Codex CLI must be installed and logged in inside Shelly before the Codex drafting agent can run.
- Android debug APK packaging passes after regenerating the Gradle transform cache and stabilizing the Shelly AAPT2 wrapper.
