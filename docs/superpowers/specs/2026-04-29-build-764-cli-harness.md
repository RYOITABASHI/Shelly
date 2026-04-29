# Build 764 CLI Runtime Harness

Date: 2026-04-29
Commit: `49bbaff4`
Branch: `main`
CI:
- Feature run: `25087584820` PASS
- Main push run: `25088538827` started after fast-forward

Device:
- Galaxy Z Fold6
- Android 16
- Shelly build 764

## Purpose

This is the current release-gate harness for Shelly's three AI CLIs.
It supersedes the older v34 harness rows that expected Claude 2.1.112 and
Codex 0.121.0-termux.

## Required Smoke Commands

Run in a fresh Shelly terminal:

```sh
claude --version
claude --print "Say OK"
claude --print "Use bash to run: echo shelly-ok"

codex --version
codex -m gpt-5.5 "Say OK"

gemini --version
```

Expected output:

```text
[shelly] claude: APK extracted Bun cli.js (Node)
2.1.122 (Claude Code)
OK
Output: `shelly-ok`
codex-cli 0.125.0-termux
Codex replies OK with model gpt-5.5
0.40.0
```

Version numbers may move forward after a later verified update. Claude may
print either of these banners depending on whether the runtime updater has
already promoted a newer extracted bundle:

```text
[shelly] claude: verified latest via extracted Bun cli.js (Node)
[shelly] claude: APK extracted Bun cli.js (Node)
```

The following must remain true:

- Claude uses the extracted Node route by default, not the musl SEA route.
- Claude Bash tool can execute `echo shelly-ok`.
- Codex does not reject `gpt-5.5` with "requires a newer version of Codex".
- Gemini starts from the package `bin` entry and prints a valid semver.

## Fallback Checks

Use these only when debugging routing:

```sh
SHELLY_DISABLE_EXTRACTED_CLAUDE=1 claude --version
SHELLY_FORCE_LEGACY_CLAUDE=1 claude --version
tail -n 160 ~/.shelly-runtime/update.log
tail -n 160 ~/.shelly-cli/install.log
```

Expected behavior:

- `SHELLY_DISABLE_EXTRACTED_CLAUDE=1` skips only the extracted Claude route
  and falls through to musl/runtime/APK fallback tiers.
- `SHELLY_FORCE_LEGACY_CLAUDE=1` skips extracted and musl routes and uses the
  legacy `cli.js` chain when available.

## Implementation Notes

- Claude: CI extracts `cli.js` from the official linux-arm64 musl Bun SEA,
  patches Shelly tmpdir assumptions, lowers `using` declarations for bundled
  Node, then packages `claude-extracted.tar.gz`.
- Codex: CI and runtime updater support both legacy
  `codex-termux-android-arm64-<tag>.tar.gz` and new
  `mmmbuto-codex-cli-termux-<version>.tgz` assets. The npm-pack path is
  verified against npm `dist.integrity`.
- Gemini: `gemini()` resolves `@google/gemini-cli/package.json` `bin.gemini`
  at runtime instead of hardcoding `bundle/gemini.js`.

## Size Note

Build 764 is a correctness build, not a size-reduction build. It still ships
the musl Claude SEA fallback (`libclaude.so`) and large Codex native binaries.
The next size pass should remove or lazy-fetch `libclaude.so` first, because
the extracted Claude Node route is now the verified default.
