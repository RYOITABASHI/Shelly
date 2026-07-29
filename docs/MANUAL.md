<p align="right"><a href="MANUAL.ja.md">日本語で読む</a></p>

# Shelly — User Manual

This is the manual. If [README.md](../README.md) is the pitch, this is the walkthrough — what to actually do, in order, the first time you open the app and every time after.

It assumes nothing except that you have the APK installed. If you haven't installed it yet, go do that first: [Quick Start → Install](../README.md#install).

---

## 1. Before you start

Shelly asks for more Android permissions than most apps, and it asks for a reason: it's a terminal, and a terminal that can't touch your files isn't a terminal.

The one that matters most is **All files access** (`MANAGE_EXTERNAL_STORAGE`). Shelly asks for it the moment you open the app for the first time. Say yes. Without it, everything inside the app's own private storage still works — but `/sdcard/Download` and anywhere else on shared storage will throw `Permission denied` the instant you try to `cd` into it or `source` a script from it. That's Android's Scoped Storage doing exactly what it's designed to do, not a Shelly bug.

If you deny it by mistake, it's recoverable but not automatic: go to **Settings → Apps → Shelly → Permissions → Files and media → Allow management of all files**, then fully close and reopen Shelly. The app only re-checks this permission when it opens, not while it's already running.

Everything else — notifications, foreground service, microphone — Shelly asks for individually, closer to the moment you'd actually use the feature, and each one degrades gracefully if you say no. The full breakdown, including exactly what breaks and what doesn't, is in [README → Permissions](../README.md#permissions).

I build and test Shelly on a Galaxy Z Fold6 — that's the only device it's been run through properly, N=1. Most of it will behave identically on your phone. The parts that are genuinely more device-dependent — unattended agent firing while the screen is off, mainly, because it depends on manufacturer-specific battery management — are called out where they come up, both here and in the README's [Status](../README.md#status) table.

---

## 2. Your first session

Open the app. You land on a single terminal pane — a real shell, not a text box pretending to be one. There's a blinking cursor and a prompt, the same as opening a terminal on a laptop.

Type something ordinary first:

```
ls
pwd
git status
```

Nothing about this should surprise you. Underneath everything else Shelly does, there's a real PTY — a pseudo-terminal, the same kind your laptop's terminal talks to — running a real bash, with real coreutils.

Now break something on purpose, and ask about it instead of scrolling up to read the error:

```
npm run build
```

If that fails (it will, in an empty directory), don't go hunting for the stack trace. Look for the **AI pane** — if you only have one pane open, tap the pane-type pill in the header (it says `[TERMINAL ▾]`) and switch to `AI`, or use the Command Palette to add one alongside the terminal. Then say:

> fix the error

When you send that, the AI pane takes a snapshot of the current terminal transcript and reasons over it — you never paste anything. It'll tell you what went wrong and offer a runnable fix with a **[▶ Run]** button. Tap it, and the fix lands directly in the terminal pane and executes.

That loop — break something, ask, tap Run — is why Shelly exists. Everything else in this manual is either making that loop richer (more panes, more context, more AI backends) or making it unnecessary (an agent that runs the loop for you, on a schedule, while your phone sits in your pocket).

---

## 3. Talking to the AI pane

The AI pane can already see your terminal. That's the one thing a general chat app can't do.

**`@mention` picks who answers.** By default, Shelly routes your message to whichever configured provider fits the task. If you want a specific one, say so: `@gemini`, `@cerebras`, `@perplexity`, `@openrouter`, or `@local` for the on-device model. There's also `@team`, which fans the same prompt out to every provider you have configured at once — useful for comparing answers, but it spends credits on all of them simultaneously with no confirmation step, so use it deliberately. (Groq is configurable as a provider and powers voice transcription, but it isn't wired to its own `@groq` mention yet.)

**It reads your terminal, not your intentions.** In a split layout with more than one terminal, it prefers the one immediately to its left, then whichever terminal is currently focused, then the first one — keep the terminal you're asking about visually adjacent to the AI pane if you're running more than one shell.

**AI Edit is the golden path for actually changing files.** Tap a file in the sidebar's File Tree — non-Markdown files open in the Preview pane's Code tab (Markdown files open in a separate Markdown pane that doesn't currently support AI Edit staging). Hit the **`[✨ AI]`** button in the Code tab's toolbar, which stages that file into the AI pane's context, then describe the change in plain language: "add error handling to the fetch call," whatever you need. The model replies with a unified diff, and Shelly renders it as an **InlineDiff**: green additions, red removals, an **Accept** / **Reject** button on every hunk. Accept a hunk and it's written to disk immediately. The Preview pane doesn't always repaint itself automatically after that write — if what you see doesn't look updated, switch the Diff/Full toggle or reopen the file. If a later hunk's line numbers have drifted because an earlier hunk already changed the file, Shelly searches forward from where it's currently reading for the hunk's original context to re-anchor it; it only searches forward, so a hunk that needs to land earlier in the file than the last edit won't be found, and you'll see a "regenerate" prompt for it instead.

**Voice works the same way.** Long-press the mic icon in the terminal's action bar to open VoiceChat — speech goes through Groq's transcription, the text goes through the same input router your keyboard uses. (Voice input itself is confirmed working.)

**Local means local.** `@local` routes to whatever GGUF model you have running through the bundled llama.cpp / llama-server integration — no network call, full privacy, at the cost of being slower and less capable than the cloud providers. Qwen3.5-2B is the default that balances speed and quality on-device; there are lighter and heavier options in Settings.

---

## 4. Building your layout

Folded, Shelly is a single terminal, and that's a complete way to use the app. But a phone screen — especially a foldable's inner screen — can hold more than one thing open at once, so the layout system exists.

Tap the **`+`** button in the AgentBar (the top bar) — it opens a sheet with an ADD tab and a LAYOUT tab; switch to LAYOUT to pick an arrangement. You can go up to four live panes at once (at most three of them can be terminals), in eight preset shapes: single, two-column, top/bottom split, three-way splits from either side or top/bottom, or a full four-pane grid. Switching to a smaller preset doesn't close your other panes — they're hidden, not lost, and come back if you switch to a bigger preset. Each pane has a type pill in its header (`[TERMINAL ▾]`, `[AI ▾]`, `[BROWSER ▾]`, …) you can tap to swap what that slot shows in place.

**On a Fold-class device, the full grid is the layout Shelly is designed around.** Folded, you get the single-pane terminal — a genuinely good phone terminal on its own. Unfold, and the same live session — same shell, same scrollback, same running processes — expands into up to four panes without restarting anything: sidebar for repos and files, terminal doing the work, AI pane reading over its shoulder, browser pane for docs or a `localhost:3000` preview.

One caveat: folding and unfolding rapidly *while* a CLI stream is actively printing (mid-build, mid-AI-response) isn't something Shelly guarantees survives cleanly — Android can recreate the underlying Activity. If something long-running is in flight, let it finish or interrupt it (Ctrl-C) before you fold or unfold. Ordinary use — fold at the end of a session, unfold to start the next — is fine.

The sidebar (visible whenever there's room for it) holds more than repos and files: Tasks (your registered and running agents), Skills, Quick Launch shortcuts, recent Codex sessions, your repositories, worktrees, the file tree, quick-access device folders, and saved SSH profiles. Tapping a repository re-roots the File Tree to it — it changes what you're browsing, not the working directory of your existing terminal panes.

---

## 5. Setting up your AI providers

Shelly draws a hard line between two different kinds of AI access, and it's worth understanding why before you configure anything.

**Codex is the foreground CLI.** It runs your ChatGPT subscription — Plus, Pro, Business, or Enterprise — over the native terminal, the same way it would on a laptop. Sign in by typing bare `codex` (with no arguments) in any terminal pane: if `~/.codex/auth.json` doesn't exist yet, Shelly opens a device-code login page right inside the app's own Browser pane. Approve it there, and Shelly writes the auth file and drops you into the normal Codex TUI. No API key — this rides the subscription you already pay for. The flow times out after 15 minutes if you leave it sitting; just run `codex` again. `shelly-doctor` reports whether the auth file exists.

**Everything else is an explicit API key**, deliberately. Gemini, Cerebras, Groq, Perplexity, OpenRouter, and OpenAI-compatible local servers are configured through **Settings → API Keys** (or `shelly config` from any terminal), one masked field per provider. This is a compliance boundary, not an implementation accident: background agents and the AI pane's automated routing never reuse your Codex subscription silently. If a background agent needs cloud intelligence, it needs its own key, configured by you, explicitly. (OpenRouter is stricter still: it's attended-only — even with a key set, an unattended agent run never routes through it.)

You don't need every provider. A reasonable starting set: Codex signed in, one fast API key for the AI pane (Gemini or Cerebras both work well), and Perplexity if you want an agent that can research and cite sources. If you want zero network dependency at all, skip API keys and set up the local model instead — see `@local` in [Talking to the AI pane](#3-talking-to-the-ai-pane).

---

## 6. Registering your first autonomous agent

Everything up to this chapter has been you, present, typing. This is the part that runs without you.

An agent is a plain-language instruction plus a schedule. You register one by typing `@agent` followed by both, in a single sentence, in any pane. Here's the one I actually run:

```
@agent every weekday at 8am, collect the latest STEAM×AI education papers and news,
and write the primary-source links + a short summary to my Obsidian vault
```

Send that, and Shelly parses the schedule and the task separately, shows you what it understood, and — once you confirm — registers a real Android alarm. From that point on, nothing needs to be open. When the alarm fires, the phone wakes just enough to run the task and drops the result where you told it to; a notification confirms it ran, and the agent's own row in the sidebar's Tasks section shows last-run and next-run times, with a missed-run flag in the row's detail view if an expected run didn't happen.

One thing to set up before an agent like this will actually do what it says: **by default, unattended runs are only allowed to use Codex and on-device tools, not cloud API keys.** An agent registered exactly as above will, when it fires unattended, fall back to researching through Codex instead of Perplexity unless you turn on **Settings → Autonomous Cloud** (off by default) — that setting is the one place you explicitly allow a scheduled agent to spend a configured cloud API key while you're not watching. Turn it on if you want the agent above to actually use Perplexity when it fires on its own.

A few more things worth knowing:

**Vague requests get a clarifying question, not a bad guess** — if you type `@agent help me out` with no object and no domain, Shelly asks what you actually want done before it asks when. (This clarifying check runs on the local model; if the local model isn't currently running, Shelly falls back to asking about scheduling directly instead.)

**"Starting next week" means what it says** — `@agent starting next week, check the news every morning` registers the agent immediately but holds its first fire until the resolved date. The relative-start vocabulary currently understands "next week / next month / tomorrow / in N days" — day-of-week phrasing like "starting Monday" isn't recognized yet. (The registration behavior itself is confirmed.)

**A schedule isn't the only trigger** — phrasing like `@agent when I get a notification, summarize it and save it as a memo` registers an agent that fires when a matching app notification arrives instead of on a clock; during registration Shelly asks which app's notifications should trigger it. By default only the notification's *arrival* triggers the run — the notification text itself is not read. If you long-press the agent's row and add exact sender display-names, the text is passed to the agent only when the sender matches exactly, always marked as untrusted data rather than instructions; notifications from anyone else are dropped without being read.

**Output isn't limited to a note** — an agent's result can go to a notification, an Obsidian draft, or out to Bluesky, Discord, Slack, Telegram, Mastodon, Misskey, WordPress, or a webhook, configured with that platform's key once. One agent posts to one platform today — posting the same result to several platforms at once from a single agent isn't supported yet. Bluesky is verified against a real account. Unless you've added the destination host to an allowlist, a social post also waits for your approval tap before it actually goes out — it doesn't post unattended by default.

**Successful runs can be remembered and reused.** Put "remember the result" in an agent's instruction and each successful run leaves a note the agent recalls on later runs. Shelly can also distill a successful run into a reusable skill — the steps, provider, and budget that worked — and quietly reuses that plan when you ask for something similar later. Attended runs ask before saving ("Save as skill?"); an unattended run of a remembering agent saves the skill automatically and posts a notification with a one-tap **Delete skill** action instead of interrupting you. There's also a shared layer: `@agent remember across all agents that I prefer short answers` — it needs both the remember phrasing and an explicit all-agents phrase, and Shelly asks you to confirm before it writes anything every agent will recall.

**The honest caveat that matters most:** unattended background execution on Android depends on manufacturer-specific battery management, and it varies. Samsung, Xiaomi, Oppo, and OnePlus all freeze background work more or less aggressively depending on settings you don't control from inside any single app — and if Android denies Shelly the precise-alarm permission, it silently falls back to a less exact alarm rather than failing loudly. Grant the battery-optimization exemption when Android offers it, and check the agent's run history the first few times until you trust it on your specific phone.

---

## 7. The terminal itself

Everything above sits on top of an actual terminal, and most of what makes a terminal usable on a phone has to be rebuilt from scratch. Here's what that produced.

**It's bundled, not fetched.** bash, GNU coreutils, Node.js, Python 3, git, curl, ssh, sqlite3, ripgrep, jq, tmux, vim, make, less, `gh`, nano, and unzip all ship inside the APK as real compiled binaries, extracted to app-private storage on first launch. There's no Termux dependency, no distro bootstrap, no `pkg install` step standing between opening the app and having a working toolchain. (Termux itself works fine *alongside* Shelly if you need something outside the bundled set — `busybox` and `htop` are two examples that aren't included.)

**Autocomplete and highlighting exist because a phone keyboard is slow.** Start typing a command and a Fig-style popup suggests subcommands and flags as you go; terminal output is colorized by content type; tapping a file path or a stack-trace line jumps you straight to it. The **SmartKeyBar** above the keyboard swaps between five context-adaptive key sets — Default, Vim, Git, REPL, Navigate — so the symbols you actually need (`|`, `~`, `Ctrl`, arrow keys) are one tap away instead of buried in a symbol picker.

**Sessions survive backgrounding.** tmux keeps your shell alive underneath when you switch apps or the screen locks, and you can resume any named session later exactly where you left it — including mid-edit in vim, cursor position and unsaved buffer intact.

**Git status is ambient in the sidebar**, and every file edit — whether you typed it or an AI Edit hunk wrote it — is auto-committed to a hidden savepoint index in the background, so you can revert to any point with one tap without touching your real git history. A pre-commit secret scanner blocks API keys and private keys from landing in a savepoint before you'd ever notice they were there.

**SSH profiles live in the sidebar.** Save a connection once — host, user, port, key file — and tapping it inserts the full `ssh -i KEY user@host -p PORT` command into your active terminal pane, ready to run. Long-press to edit or delete. `Import from ~/.ssh/config` bulk-adds every host you already have configured elsewhere. Only key-file auth is supported; Shelly never persists a password or a passphrase.

**Snippets** are short commands you use often, saved once and dispatched from the Command Palette. The in-app authoring UI for creating them isn't built yet — for now, add them by editing `~/.shelly/snippets.json` directly, or through `shelly config`.

---

## 8. When things go wrong

Something will eventually not work the way you expect. Here's the order to check things in.

**Run `shelly-doctor` first.** It checks whether the app's core native binaries are present, and — separately — whether Codex actually responds to `--version`. It's a quick sanity check, though it's worth knowing its limits: it doesn't probe whether a local LLM server is actually reachable (it only reports the addresses it *would* check), and it doesn't run any of the bundled shell tools to confirm they work — it's a presence/liveness check, not a full smoke test.

**If it's specifically Codex**, run `shelly-codex-diagnose` for deeper smoke/canary/edit/patch checks, or `shelly-update-clis codex --check-only` to probe which runtime is actually active. If `codex --version` fails outright, **Settings → Updates → Repair Codex / Reset** falls back to the runtime that shipped inside the APK, which is guaranteed to at least start.

**If `/sdcard` paths throw `Permission denied`**, that's almost always the All Files Access permission — see [Chapter 1](#1-before-you-start) for the exact Settings path, and remember to fully reopen the app afterward.

**If a scheduled agent didn't fire**, open the agent's row in the sidebar's Tasks section for a missed-run flag, then check whether your phone's battery-optimization settings exempted Shelly — this is the single most device-dependent part of the app, covered honestly in [Chapter 6](#6-registering-your-first-autonomous-agent).

**If something feels dangerous and Shelly let you type it anyway** — command-safety in Shelly is a regex-based risk classifier with five severity levels, not a sandbox. It's a seatbelt, not a firewall. Read commands before you run them, especially ones an AI generated for you. The full threat model is in [SECURITY.md](../SECURITY.md).

**For anything this manual and `shelly-doctor` don't resolve**, the [issue tracker](https://github.com/RYOITABASHI/Shelly/issues) is the fallback — and the [Known Limitations](../README.md#known-limitations) section of the README documents every rough edge that's already known about, so it's worth a search there first.

---

## 9. Updating, security, and where the rest of the detail lives

**Updating** happens from inside the app — the cloud-download icon in the top bar, or **Settings → Updates**. It reads a public release manifest, checks the SHA-256 of the downloaded APK before handing it to Android's installer, and Android will still ask you to confirm the install because Shelly is distributed outside the Play Store. It's a normal in-place Android app upgrade — your data and settings are untouched.

The **Codex runtime updates separately from the app**, on its own release lane, so it isn't stuck waiting for the next full APK release. Shelly verifies a candidate runtime's hash and smoke-tests it (`--version`, `exec --help`) before promoting it to active.

**Security, briefly:** Shelly is a normal Android app sandbox, not a hardened VM — terminal commands and approved AI-agent actions run as the app's own uid and can touch whatever the app can touch. API keys are stored through Expo's SecureStore, Keystore-encrypted where the device supports it, and are never written to logs. There's no telemetry — no analytics, no crash reporting, no usage tracking — though note that when you message a cloud AI provider, Shelly's on-device usage-pattern profile is included in that request to improve response quality (you can turn this off in Settings). The full picture is in [README → Security](../README.md#security) and [SECURITY.md](../SECURITY.md).

Every capability described in this manual is one I use myself, and where it's incomplete or flaky, I've tried to say so plainly instead of rounding up. [`docs/superpowers/DEFERRED.md`](superpowers/DEFERRED.md) is the project's own running ledger of what's shipped, what's flag-gated off, and what's known-broken — when this manual hedges, that's where the hedge comes from. If something here still doesn't match what the app does, [open an issue](https://github.com/RYOITABASHI/Shelly/issues).
