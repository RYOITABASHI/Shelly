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

- **Engines** are yours to pick, and there are no defaults. Each is `gemini-api`, `cerebras`, `groq` or `perplexity`, with an optional `model`. Use the same API keys as the rest of Shelly. A CLI and the local LLM cannot run these steps. When review and writing come from the same engine family, the draft is marked unresolved, so pick different families.
- **`outputFolder`** must be inside your Obsidian vault (Settings, default `/sdcard/Documents/ObsidianVault`) or your custom output folder (default `~/agent-output`). A pipeline with `queue` and the digest must be inside the vault, because those are read only from there. Use plain folder names: letters, digits, `_`, `-` and `.`, no spaces.
- **Instructions** hold 500 characters each. A longer one is refused, not cut. A research instruction that mentions the web gets source capture.
- **`queue`** takes each run's topic from `_queue.md` in the output folder, as `- [ ] topic` lines. `instructions.topics` also refills that queue through Gemini when it runs low.
- **Optional fields**: `lintTerms`, `nameLint`, `lintSources` and `quality` flag a draft and never rewrite it. `engines.agent` sets the agent's own tool.
- **Digest**: an optional top-level `digest` lists each day's drafts in one note, with `name`, `prompt`, `lang`, `schedule`, `outputFolder`, `footer`, `engine` and `streams` (`[{ "folder": "Garden", "label": "Garden" }]`, folders next to the digest's own). Ask for it with the id `digest`.

The agent only ever saves a draft. It never publishes and is never autonomous, and its runs are scheduled only: Run now is refused, so set a time a few minutes ahead to test one.

## After-draft hook

If `~/.shelly/agents/after-draft-hook.js` exists, Shelly runs it with `node` once after a pipeline or digest run has saved its draft, ticked its queue item and been recorded. Without the file, nothing happens.

```js
// process.argv[2] is the saved draft's absolute path.
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
```

- **When it runs**: only after a run that saved a draft. A run skipped because today's draft exists, a failed run and any other agent do not call it.
- **What it gets**: the saved path as its one argument, your home as its working folder, and a short environment (`HOME`, `PATH`, locale, time zone, certificate paths). No API keys and no `NODE_OPTIONS`.
- **What it cannot do**: fail or hold up the run. It is stopped after 120 seconds and by Stop All, its output is discarded, and it sends no notice. The agent's audit log (`logs/<id>/plan-executor-audit.jsonl`) gets one `after_draft_hook` line with a status: `ok`, `failed`, `timeout`, `halted`, `refused`, `spawn-error`, `too-late` or `error`.
- **Requirements**: a regular file owned by the app, with one hard link, not a symlink, and not writable by group or others (`chmod 600`). Anything else is `refused`.
- **Who can change it**: you. The gate refuses agent workers any command that names the file, unless it is a plain read.
