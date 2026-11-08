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

## Saving a draft through ClosePaw

`shelly save-draft` queues one article for the Shelly-trusted ClosePaw build, which saves it in the note or Substack web editor with a fixed routine. There is no LLM in that routine, and it cannot publish. It is not tied to pipelines, so any script can use it.

```bash
shelly save-draft --platform note --title-file title.txt --markdown-file post.md --image header.png
```

From a script without the `shelly` command, such as the hook below: `node ~/.shelly-save-draft.js <same options>`.

- **What happens**: at the next unlock Shelly shows the waiting drafts in one notification, up to five at a time, with one line each: destination, content hash, image hosts and title. Tap Approve (device unlock), or reply `approve <hash>` in Shelly's chat. ClosePaw then saves them one by one on its virtual display.
- **Every batch needs that approval.** Nothing is approved in advance, and the terminal cannot approve. An approval covers those exact files: a draft changed afterwards is not sent. Ignored for 10 minutes, it is asked again at a later unlock. A draft expires after 24 hours.
- **If it does not start**: the phone locked, Chrome on screen, ClosePaw busy or Shizuku stopped keep the draft waiting. Shelly tries again at the next unlock, for up to 6 hours after the approval.
- **`uncertain`**: ClosePaw stopped after writing or timed out, so the draft may or may not exist. Shelly does not send it again. Check your drafts.
- **Follow one**: `shelly closepaw status <requestId>`.
- **Markdown**: headings (levels past 4 become 4), paragraphs, lists (flattened to one level), quotes, code, rules, bold, italic and links. HTML in the Markdown is shown as text.
- **Links**: ordinary `https` addresses only, with no user info, port or IP address. Links to note.com and substack.com must be plain article links (`/<user>/n/<key>`, `/p/<slug>`) with no query or fragment. Any other link keeps its text only, and the command says how many it changed.
- **Images**: on note, pass files with `--image`. An image written in the Markdown keeps only its alt text, because note images never come from the HTML. On Substack, an image in the Markdown is kept when its exact host is in `image_hosts` below; a line holding only an image becomes a figure, and its title the caption. Otherwise it keeps its alt text.
- **Limits**: title 300 characters, HTML 1 MiB, 4 image files of 6 MiB each (JPEG, PNG, WebP or GIF, note only), 16 MiB in all, 16 drafts waiting.

Substack needs a list of allowed subdomains in `~/.shelly/agents/draft-destinations.json`. The queue can only pick an entry, with `--substack`, when there are several. `image_hosts` is optional, up to 8 exact hosts and never a note or Substack host. It lives here because the editor fetches an image with your cookies as soon as it parses the HTML.

```json
{ "version": 1, "substack_subdomains": ["your-subdomain"], "image_hosts": ["images.example.com"] }
```

The gate refuses agent workers any write to this file, and Shelly ignores the file if any folder on its path is a link. Neither is a lock: a process of this app can still edit the file directly. So check the destination and image hosts in the approval notification. Keep in mind that approving an image host means the editor will contact it with your cookies. If the file is missing or broken, Substack drafts wait, and expire after 24 hours.

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
