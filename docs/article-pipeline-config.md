# Article pipeline config

Shelly can run a long-form writing chain on a schedule: research, write, two rounds of review and revision, then save a draft. It ships no series. Your topics, prompts, engines, schedule and folders live in one file on your device, `~/.shelly/agents/article-pipelines.json`.

Then ask in chat: `@agent article pipeline <id>` or `@agent 記事パイプライン <id>`. Shelly shows the plan and registers the agent after your OK. Without the file, it tells you so and creates nothing.

```json
{
  "version": 1,
  "pipelines": [
    {
      "id": "garden-notes",
      "name": "Garden notes draft",
      "prompt": "A weekly note for home gardeners. Plain English. Write only what the sources say.",
      "lang": "en",
      "schedule": "0 7 * * 1",
      "scheduleLabel": "Mondays 7:00",
      "outputFolder": "/sdcard/Documents/ObsidianVault/Drafts/Garden",
      "footer": "Written with AI tools.",
      "queue": true,
      "instructions": {
        "research": "Search the web for the topic and write notes from at least 3 sources.",
        "write": "Using the notes, write a post. The first line is a heading starting with \"# \". Mark facts with their Sources number [n].",
        "review": "The notes are the only evidence. Flag claims that are not in them.",
        "revise": "Apply every finding and output only the full revised post."
      },
      "engines": {
        "research": { "type": "gemini-api" },
        "write": { "type": "groq" },
        "review": { "type": "cerebras" }
      }
    }
  ]
}
```

- **Engines** are yours to pick, and there are no defaults. Each is `gemini-api`, `cerebras`, `groq` or `perplexity`, with an optional `model`. Use the same API keys as the rest of Shelly. `write` and `review` can also be a text-only CLI (see below). The local LLM cannot run these steps. When review and writing come from the same engine family, the draft is marked unresolved, so pick different families. Claude Code and Codex each count as their own family.
- **`outputFolder`** must be inside your Obsidian vault (Settings, default `/sdcard/Documents/ObsidianVault`) or your custom output folder (default `~/agent-output`). A pipeline with `queue` and the digest must be inside the vault, because those are read only from there. Use plain folder names: letters, digits, `_`, `-` and `.`, no spaces.
- **Instructions** hold 500 characters each. A longer one is refused, not cut. A research instruction that mentions the web gets source capture.
- **`queue`** takes each run's topic from `_queue.md` in the output folder, as `- [ ] topic` lines. `instructions.topics` also refills that queue through Gemini when it runs low.
- **Optional fields**: `lintTerms`, `nameLint`, `lintSources` and `quality` flag a draft and never rewrite it. `engines.agent` sets the agent's own tool.
- **Digest**: an optional top-level `digest` lists each day's drafts in one note, with `name`, `prompt`, `lang`, `schedule`, `outputFolder`, `footer`, `engine` and `streams` (`[{ "folder": "Garden", "label": "Garden" }]`, folders next to the digest's own). Ask for it with the id `digest`.

The agent only ever saves a draft. It never publishes and is never autonomous, and its runs are scheduled only: Run now is refused, so set a time a few minutes ahead to test one.

## Text-only CLI engines

`engines.write` and `engines.review` can name Claude Code or Codex, so writing, review and revision can use your subscription. Revision uses the `write` engine. Research stays on an HTTP engine, and `engines.agent` and the digest's `engine` cannot be a CLI.

```json
"engines": {
  "research": { "type": "perplexity" },
  "write": { "type": "cli", "cli": "claude", "textOnly": true },
  "review": { "type": "cli", "cli": "codex", "textOnly": true, "model": "gpt-5.5" }
}
```

- **`textOnly` must be `true`.** These steps get text from the web in their prompt, so the CLI runs with no tools: no shell, no web, no MCP, and the model cannot ask for a file. It can only answer. If it tries anything else, or starts with any tool available, the turn stops and the step fails. Prompt text cannot pull in your files either: Claude Code's `@path` is refused, and Codex runs with an empty home and working folder, so a `$skill-name` finds no skill. Two limits: with a subscription, Claude Code puts your account email in the turn, and no setting removes it. A skill folder for all users (`/etc/codex/skills`) would still load, which does not apply on Android.
- **`model`** is optional for Claude Code. Codex needs one here or as `model` in `~/.codex/config.toml`, or the step fails.
- **What it needs**: the build agents run (`claude-install --agent` for Claude Code, the bundled build for Codex). Claude Code signs in as it does for any agent: your Anthropic API key if one is set, otherwise your subscription, and with the setting "Claude subscription for unattended runs" off a scheduled run is refused. Codex uses your ChatGPT login.
- **When a step fails**, nothing falls back to another engine. A failed write fails the run. A failed review or revision keeps the last good version and marks the draft unresolved.
- **Time**: one run has 30 minutes, the CLI steps included. When less than 2 minutes remain, or a call runs into the last minute, the review loop stops and the last good version is saved as unresolved. Each engine takes one text-only step at a time across agents, so two agents at the same minute wait for each other.

## After-draft hook

If `~/.shelly/agents/after-draft-hook.js` exists, Shelly runs it with `node` once after a pipeline run has saved its draft, ticked its queue item and been recorded. Without the file, nothing happens.

```js
// process.argv[2] is the saved draft's absolute path.
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
```

- **When it runs**: only after a run that saved a draft. That includes a draft saved with `review: unresolved`, so read the frontmatter before acting on one. A run skipped because today's draft exists, a failed run, a digest and any other agent do not call it.
- **What it gets**: the saved path as its one argument, your home as its working folder, and a short environment (`HOME`, `PATH`, locale, time zone, certificate paths). The environment holds no API keys and no `NODE_OPTIONS`. That covers the environment only: the hook runs as the app, so it can read any file the app can, including `~/.shelly/agents/.env`.
- **What it cannot do**: fail or hold up the run. It is stopped after 120 seconds and by Stop All, anything it started is stopped when it exits, its output is discarded, and it sends no notice. The agent's audit log (`logs/<id>/plan-executor-audit.jsonl`) gets one `after_draft_hook` line with a status: `ok`, `failed`, `timeout`, `halted`, `refused`, `spawn-error`, `too-late` or `error`.
- **Requirements**: a regular file owned by the app, with one hard link, not a symlink, and not writable by group or others (`chmod 600`). Anything else is `refused`.
- **Who can change it**: the gate refuses agent workers any command that names the file, unless it is a plain read. This is a match on the command text, not a lock. A worker able to run code of its own in a workspace could build the path at run time, and files the hook loads or calls are not protected at all. The file's content is not sealed, so treat it as code that runs without you, and do not give it credentials you would not give an agent.
