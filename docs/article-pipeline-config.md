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
- **Optional fields**: `lintTerms`, `nameLint`, `lintSources` and `quality` flag a draft and never rewrite it. `engines.agent` sets the agent's own tool. `voice` adds a ghostwritten author view (see below).
- **Digest**: an optional top-level `digest` lists each day's drafts in one note, with `name`, `prompt`, `lang`, `schedule`, `outputFolder`, `footer`, `engine` and `streams` (`[{ "folder": "Garden", "label": "Garden" }]`, folders next to the digest's own). Ask for it with the id `digest`.

The agent only ever saves a draft. It never publishes and is never autonomous, Its runs always go through the PlanSpec executor. Run now (the sidebar ▶ or `@agent run <name>`) starts that same executor on the same saved plan the schedule uses, so you can test a pipeline right away. A Run now while the scheduled run is still going is refused with "previous run still active" instead of starting a second run.

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

## Ghostwritten author view

A draft can keep one section for your own view, holding the marker `【本人の材料: 未記入】` until you write it. With `voice`, a text-only CLI ghostwrites that section from a profile you wrote and reviewed, after the last revision. Without the key nothing changes.

```json
"voice": {
  "profile": "Drafts/_voice-profile.md",
  "profileSha256": "<sha256 of the profile file>",
  "author": "Your Name",
  "review": { "type": "gemini-api" }
}
```

- **`profile`** is a `.md` file inside your vault, given relative to it, in plain folder names. It must be a regular file, not a link, with no link in its folders, and 8,000 characters at most. The digest does not list it.
- **The profile** is yours to write. Its frontmatter needs `reviewed: <date>` (for example `reviewed: 2026-11-08`), which you set after reading every line; without it the step does not run. Write your values, positioning, tone and what you would never say. Put what you have actually done under a heading with "Experience" (or 経験) in it, one item a line, and personal facts the section may use under "Allowed private facts" (or 公開してよい). Lines under a heading with "Values", "Tone" (価値観, 口調, 文体) are material the section may use. Every other line (positioning, private facts, what you would never say) may guide the model, but a section sentence that copies or paraphrases it is refused. The whole profile goes to the model vendors in the prompt, so leave out anything you would not send them. Numbers the section may use must be written in the profile.
- **`profileSha256`** pins the profile you reviewed: its SHA-256 in lower-case hex (`sha256sum Drafts/_voice-profile.md` in the vault). The step runs only while the profile has that hash, and it reads the pin again from this config file at run time, because agent workers cannot write this file (the gate refuses a write that names it, any write through a wildcard or partial name under `~/.shelly/agents/`, such as `article-pipe*.json`, a name split by quotes or backslashes, and any write near `~/.shelly` with a `$` or backtick word it cannot read). That is a match on the command text, not a lock. After you edit the profile, review it, update the hash here and ask for the pipeline again.
- **`engine`** is optional: Claude Code by default, or `{ "type": "cli", "cli": "codex", "textOnly": true, "model": "..." }`. It runs text-only, as above. **`review`** is an HTTP engine (`gemini-api`, `cerebras`, `groq` or `perplexity`), so the reviewer is never the writer's family. **`author`** is the name in the footer.
- **The marker** must stand alone in its own paragraph, with a blank line before and after, outside code, comments, quotes, lists and links. Anywhere else, or twice, and no section is written.
- **What it does**: the CLI gets the final article and the profile as data and writes the section only: views stated as views, at most 400 characters in Japanese or 80 words in English. Anything about you (experience, background, personal facts) comes from the profile alone; the article is never evidence about you, whatever it says. The reviewer checks it with the `VERDICT:` contract, with one rewrite at most. Then Shelly checks it itself, with allow-lists:
  - plain text in letters, digits, ①-⑩ and ordinary punctuation only: no `[ ] @ { } < > # ` or backtick, no markup, no URL, no dotted host name, no `word:word` token like `id:x`, no indented or underlined line, no invisible or bidi character, and not the word "verdict";
  - the style is free: polite or plain endings (です・ます, 〜なんですよね), short sentences, a trailing "…", plain statements about the topic without "I think", and one short list told as a joke — lines that start with ①-⑩ or `1. ` (at most 10, each at most 40 characters or 12 words, plain text only; no `-` bullets, `1)`, indented or nested items). Each list counts from 1 by one in one style (`1.`, `2.` … or ①, ② …; `30.` or a gap is refused). A list marker, and a circled number that points back to one of the section's own markers and is followed by a particle or punctuation ("③のせいで", "①と②を"), is not a number; a circled number used as a count ("③倍") and numbers in the item text still are;
  - nothing places the section in your life unless an allowed, values or experience line of the profile holds the word: no time or habit words in any sentence (週末, 去年, 先週, 毎朝, 普段, 以前; last week, weekends, every morning, years ago), no places or things of your own (我が家, 行きつけ, 手元, 通勤, 趣味, お気に入り; at home, my desk, commute, hobby, favourites, mine), no personal activity at the end of a clause (〜めぐりです, 〜集めです), no change of taste or habit (好きになりました, 住むようになりました), and no feeling that wraps an action (〜するのが好きです, "I like visiting"). An English sentence that starts with a past verb and no subject ("Got one", "Moved to …") is refused;
  - no plain risky assertion under your name, from a short conservative word list: health or medical effects (効きます, 治る, cures), money promises (必ず値上がり, 儲かる, risk-free), legal conclusions (違法, illegal) and accusations (偽物を売っています, 偽物ばかり, 詐欺, scam). This only catches the plain word forms; **the reviewer remains the main defense for factual assertions**, and its prompt says so;
  - no sentence reads as something you did. The first person appears only as the holder of an opinion or a feeling at the end of the sentence (私は…と感じます, 私は…が好きです, "I think", "I like", "I find", "I'm curious"), and never with a habit or time word (毎朝, 普段, 以前, 週末). Apart from that, no active past or perfect (した, 使いました, した結果) unless it is a change of a thing (〜な時代になりました), a copula with a subject (当時は〜でした) or its subject is the article or a third party the article names (工場は〜を優先していました), no action without a subject of its own, plain, polite or a verbal noun (書く, 書きます, 使っています, 行きました, 〜を使用), no writer, team or author acting (筆者, チーム, この記事を書いた人, the writer, the team), no "my", "our" or "we", and no "having used" or "after years of". Verbs of use and building (使う, 使い込む, 導入する, 書く, 作る, 開発する, 運用する, 動かす, 試す; use, build, run, deploy, write, try, test, buy, collect) take no past, perfect or progressive form, and no conditional or temporal clause (〜すると, 〜する中で, 〜するうちに), anywhere in the sentence; "since launch", "for years", "daily" and "in production" are refused too. Passive and potential forms are fine (紹介された取り組み, 選ばれた方式, 試せる, 使うかどうか), a sentence about the section itself (理由を並べてみました) is fine, and 自分で means "yourself". An Experience line quoted word for word is the one exception;
  - people: a family or relation word (妻, 子ども, 友人, 同僚, 上司; wife, kid, friend, colleague, boss), a name (a capitalized Latin word or a katakana word outside common vocabulary) or a self-description (〜の親として, 研究職として, "as a parent") must appear in the article or in the profile's Values, Experience or allowed lines;
  - every number (digits, full-width, kanji numerals including 大字 and 半, ordinals such as "first", 第1 or 一番目, Roman numerals, English number words, "a dozen", "a score of", "a couple of", "a few years", ranges) must be in the profile's lines; vague words like 数年 are fine;
  - no sentence copies or paraphrases a profile line outside Values, Tone, Experience and the allowed private facts (3 shared kanji or katakana bigrams, or 2 shared English content words).
  The writer's prompt asks for this style (です・ます, short sentences, one twist, a light "…", sometimes a short list as a joke) and lists these rules with example sentences and one list example per language, so ordinary output passes.
- **When it passes**, the section replaces the marker, the draft gets `material: ghostwritten` and `voice_sha` (the profile's SHA-256), and the footer becomes a fixed disclosure that names `author` and says the section was ghostwritten by AI. The model never writes the footer, and text in the article cannot set `material`. The agent's audit log (`logs/<id>/plan-executor-audit.jsonl`) gets a `voice_passed` line with the hash, the executor's own record of the pass. The digest marks the draft 代筆.
- **When anything fails** (no reviewed profile, a hash that does not match, a misplaced marker, a failed turn, a review that does not pass, a local check, too little time), the marker stays, the draft is saved with `material: missing`, no `voice_sha`, your own footer, and the reason in `review_note` after `代筆なし:`. The run itself does not fail.
- **Limits**: the checks are strict on purpose, so a fine section is sometimes refused; the marker then stays for you. They read word forms, not meaning: a general opinion that implies use without naming it ("この道具は手になじむと思う") passes. The review and your own read cover the rest; publishing without your read relies on that residual risk being acceptable to you.

## Saving a draft through ClosePaw

`shelly save-draft` queues one article for the Shelly-trusted ClosePaw build, which saves it in the note or Substack web editor with a fixed routine. There is no LLM in that routine, and it cannot publish. It is not tied to pipelines, so any script can use it.

```bash
shelly save-draft --platform note --title-file title.txt --markdown-file post.md --image header.png
```

From a script without the `shelly` command, such as the hook below: `node ~/.shelly-save-draft.js <same options>`.

- **What happens**: at the next unlock Shelly shows the waiting drafts in one notification, up to five at a time, with one line each: destination, content hash, image hosts and title. Tap Approve (device unlock), or reply `approve <hash>` in Shelly's chat. ClosePaw then saves them one by one on its virtual display.
- **Every batch needs that approval, unless you turn it off for a destination.** The terminal cannot approve. An approval covers those exact files: a draft changed afterwards is not sent. Ignored for 10 minutes, it is asked again at a later unlock. A draft expires after 24 hours.
- **Without approval, per destination**: type in Shelly's chat `save drafts to note and Substack without approval` (or `note と Substack の下書き保存は承認なしで`). Add `up to 3 a day` / `1日3件まで` to change the daily cap, which is 5 per destination by default and at most 20. For Substack, name the subdomain (`substack:your-subdomain`) when `draft-destinations.json` lists more than one. From then on, drafts for that destination are sent at the first unlock with no tap, and a notification afterwards lists what was saved, with links to your drafts. Drafts over the cap, drafts with Substack image hosts and every other destination still ask. Only your own typing in the chat turns it on: not the terminal, a file, voice or an agent. Turn it off with `stop saving drafts without approval` / `承認なしをやめて`, or in Settings > Drafts (ClosePaw). It never publishes. While it is on, whatever a script queues for that destination becomes a draft without you seeing it first, so check your drafts before publishing.
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
