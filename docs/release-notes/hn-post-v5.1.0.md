# HN post draft — Shelly v5.1.0

## Title options (Show HN format, max 80 chars)

Pick one before submission. All three are factual; (1) leans on the
build/decision angle (HN-friendly), (2) leans on the technology angle,
(3) leans on the user-value angle.

1. **Show HN: Shelly – Android terminal IDE with bundled Claude/Codex/Gemini**
   (62 chars)

2. **Show HN: Shelly v5.1.0 – Termux-free Android terminal with JNI forkpty**
   (69 chars)

3. **Show HN: Shelly – Run Claude Code, Codex, and Gemini CLI on your phone**
   (69 chars)

Recommend **(1)** as the safest/clearest. (3) gets click-rate but
people will assume "another wrapper" and bounce; (1) signals technical
depth without sounding hype.

## Body (~250 words, paste into HN body field)

```
Shelly is an Android terminal IDE that bundles bash, Node, Python, git,
curl, ssh, sqlite3, ripgrep, jq, tmux, vim, less, and make as native
.so libraries inside the APK, plus Claude Code, Codex, and Gemini CLI
preinstalled. No Termux dependency, no proot, no root.

The technical angle that might interest this crowd:

- PTY is JNI forkpty + termios — Termux's bridge had IPC overhead and
  Phantom Process Killer killed sessions on app switch. Direct fork
  + ptsname has neither problem.

- Android 10+ SELinux blocks execve() on app_data_file ELFs (the W^X /
  noexec policy). Workaround: LD_PRELOAD a wrapper that rewrites
  exec() targets through /system/bin/linker64 (which uses mmap, which
  IS allowed). Same trick for `/bin/sh` — the wrapper rewrites it to
  `/system/bin/sh` so any tool that hard-codes Linux paths works.

- Claude Code 2.1.113+ ships as a Bun SEA (statically linked ~220 MB
  ELF). Android bionic can't exec ET_EXEC directly. Pair it with a
  Shelly-patched musl ld.so (resolv.conf path baked at build time
  because bionic doesn't have one) and a separately-compiled
  musl-targeted exec_wrapper, and the Bash tool works inside the SEA.

- Three-tier CLI promotion: bundled "golden" inside APK, NPM-tier
  staging with all-three smoke test before atomic rename promote, plus
  a native-runtime updater for Claude/Codex with verified-latest
  walk-back. A bad upstream release can't brick the CLI.

Built and tested on a Galaxy Z Fold6 (Android 16, OneUI 6). Open
source. Release notes have the full smoke-test gauntlet and known
limitations.

Release: <PASTE_RELEASE_URL_HERE>
GitHub: https://github.com/RYOITABASHI/Shelly
```

## Notes for actual submission

- **Submit directly from a hidden tab on a desktop** — HN's algorithm
  is more friendly to non-mobile submissions in the first hour
- **Day / time**: Tuesday-Thursday, 09:00-11:00 PT is the historical
  "front-page-friendly" window. Avoid Mondays (weekend backlog) and
  weekends (low engagement)
- **First-comment self-introduction** is allowed and encouraged on
  Show HN. Brief, no marketing, ideally one paragraph that explains
  WHY this exists and what you'd love feedback on. Suggested:

  ```
  (OP here.) The motivation was wanting Claude Code on a phone for
  small fixes / on-call work without lugging a laptop. Termux works
  but it's manual setup every time and you fight Phantom Process
  Killer. Shelly gives up Termux compatibility in exchange for a
  one-tap install that just works.
  
  Would especially love feedback on (a) the LD_PRELOAD exec
  redirection — Codex audit caught a few things (in DEFERRED.md), and
  I'm sure there's more — and (b) whether the Bun SEA Bash-tool path
  is the right way to follow upstream Claude releases or whether we
  should just track the cli.js fork.
  ```

- **Don't submit twice**. If first submission doesn't trend in 90 min,
  it's done — coming back next week with a different framing is fine

- **Be ready for "why not just use Termux + npm install"**. The honest
  answer is: zero-install for non-power-users, plus the Phantom Process
  Killer issue, plus IPC-free PTY. Don't argue, just answer.

- **Don't argue about the AnyClaw / OpenClaude comparison**. If
  someone brings it up, point them at the licensing/provenance
  difference and move on. Don't characterize their project negatively.
