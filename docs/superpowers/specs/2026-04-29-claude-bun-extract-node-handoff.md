# Claude Bun SEA Extracted Node Route Handoff

Date: 2026-04-29
Branch: `feature/claude-bun-extract-node` → merged through
`feature/codex-gemini-runtime-updater` → `main` at `49bbaff4`

## Problem

Claude Code 2.1.113+ ships as a Bun SEA musl binary. Shelly's current
Path C-bis route runs that binary through:

```sh
/system/bin/linker64 shelly_musl_exec ld-musl-aarch64.so.1 claude
```

That path has hit Android/Shelly-specific failures around musl preload,
`__errno_location`, and Claude's Bash tool subprocess handling.

## Reference

`PeroSar/claude-codex-termux` takes a different approach:

1. Download the official Claude Code linux-arm64 Bun SEA.
2. Extract the `.bun` section.
3. Locate the embedded `src/entrypoints/cli.js`.
4. Patch tmpdir literals.
5. Lower `using` / `await using` declarations to `const` for Shelly's
   bundled Node parser.
6. Run the extracted `cli.js` with Node.

This branch adapts that idea for Shelly. The first commit shipped it as
an opt-in route; after Galaxy Z Fold6 smoke tests passed, it became the
default Claude route. BASHRC_VERSION 67 promoted Claude extracted route;
BASHRC_VERSION 68 added the Codex/Gemini follow-up fixes.

## Implementation

### CI

`.github/workflows/build-android.yml`

The existing step still bundles:

```text
modules/terminal-emulator/android/src/main/jniLibs/arm64-v8a/libclaude.so
```

The same step now also creates:

```text
modules/terminal-emulator/android/src/main/assets/claude-extracted.tar.gz
```

The tar contains:

```text
node_modules/@anthropic-ai/claude-code-extracted/cli.js
node_modules/@anthropic-ai/claude-code-extracted/package.json
node_modules/@anthropic-ai/claude-code-extracted/node_modules/...
```

Extraction is fail-loud:

- missing `.bun` section marker fails CI
- unexpected CJS wrapper shape fails CI
- tmpdir patch target drift fails CI
- browser bridge tmpdir target drift fails CI
- `node cli.js --version` fails CI

### App Extraction

`LibExtractor.kt` extracts `claude-extracted.tar.gz` into `termux-libs`
and uses this marker:

```text
node_modules/@anthropic-ai/claude-code-extracted/cli.js
```

### Shell Dispatch

`HomeInitializer.kt` bumps `BASHRC_VERSION` to 68 and runs the extracted
Node route at the top of `claude()` by default:

```sh
claude --version
```

When enabled, Shelly runs:

```sh
_run $libDir/node $libDir/node_modules/@anthropic-ai/claude-code-extracted/cli.js "$@"
```

with:

```text
USE_BUILTIN_RIPGREP=0
DISABLE_AUTOUPDATER=1
DISABLE_INSTALLATION_CHECKS=1
CLAUDE_TMPDIR=$HOME/.claude-tmp
CLAUDE_CODE_TMPDIR=$HOME/.claude-tmp
```

Fallback controls:

```sh
SHELLY_DISABLE_EXTRACTED_CLAUDE=1 claude --version
SHELLY_FORCE_LEGACY_CLAUDE=1 claude --version
```

`SHELLY_DISABLE_EXTRACTED_CLAUDE=1` skips only the extracted route and
falls through to the musl runtime/APK paths. `SHELLY_FORCE_LEGACY_CLAUDE=1`
skips both extracted and musl routes and uses the legacy cli.js chain.

## Device Smoke Plan

Passed on Galaxy Z Fold6 / Shelly APK from this branch:

```sh
claude --version
SHELLY_PREFER_EXTRACTED_CLAUDE=1 claude --version
SHELLY_PREFER_EXTRACTED_CLAUDE=1 claude --print "Say OK"
SHELLY_PREFER_EXTRACTED_CLAUDE=1 claude --print "Use bash to run: echo shelly-ok"
```

After BASHRC_VERSION 67+, re-run without the opt-in:

```sh
claude --version
claude --print "Say OK"
claude --print "Use bash to run: echo shelly-ok"
```

Then test the known PTY/paste case:

```text
以下をそのまま復唱して:
line one
line two
line three
```

## Promotion Evidence

The extracted Node route was promoted to default after all of these passed
on device:

- `--version`
- non-tool `--print`
- Bash tool `--print`
- interactive launch
- paste into Claude Code TUI
- no regression in Codex/Gemini wrappers

Build 764 / commit `49bbaff4` follow-up evidence:

```sh
claude --version
# [shelly] claude: latest via extracted Bun cli.js (Node)
# 2.1.122 (Claude Code)

claude --print "Say OK"
# OK

claude --print "Use bash to run: echo shelly-ok"
# Output: `shelly-ok`

codex --version
# codex-cli 0.125.0-termux

codex -m gpt-5.5 "Say OK"
# OK

gemini --version
# 0.40.0
```

Codex/Gemini follow-up in the same release line:

- CI and `shelly-runtime-update.js` support both the legacy
  `codex-termux-android-arm64-<tag>.tar.gz` layout and the newer
  `mmmbuto-codex-cli-termux-<version>.tgz` npm-pack layout.
- The npm-pack path verifies tarball content against npm `dist.integrity`
  before extraction/promotion.
- `gemini()` resolves the launcher from `package.json` `bin.gemini` rather
  than hardcoding `bundle/gemini.js`.

The musl SEA route remains as fallback for one release cycle before any
APK size reduction removes or lazy-fetches `libclaude.so`.

## Risk

This depends on Anthropic's Bun bundle internals. The branch intentionally
fails CI if the embedded `cli.js` marker or minified tmpdir shapes drift.

It also adds a second Claude payload in assets. If this route becomes the
default, remove or lazy-fetch `libclaude.so` to recover APK size.
