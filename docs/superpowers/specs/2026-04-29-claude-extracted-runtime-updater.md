# Claude Extracted Runtime Updater

Date: 2026-04-29
Branch: `feature/claude-extracted-runtime-updater`

## Goal

Make Claude Code match Codex/Gemini's verified-latest behavior without
requiring a Shelly APK update every time Anthropic publishes a compatible
release.

Before this branch:

- Claude default route used the CI-extracted Bun `cli.js` packaged in the APK.
- Codex and Gemini could update on-device after smoke checks.
- Claude could only reliably move forward when CI rebuilt the APK.

After this branch:

- `shelly-runtime-update.js` downloads
  `@anthropic-ai/claude-code-linux-arm64-musl@latest`.
- It verifies npm integrity.
- It parses the ELF section table in Node and extracts the `.bun` section
  directly, with no `objcopy` dependency on-device.
- It locates `src/entrypoints/cli.js`, applies the same tmpdir/browser-bridge
  patches as CI, lowers `using` / `await using`, and writes:

```text
~/.shelly-runtime/claude-extracted/<version>/node_modules/@anthropic-ai/claude-code-extracted/cli.js
```

- It copies the dependency set from the previous runtime extraction or the
  APK-bundled extracted package.
- It runs `node cli.js --version`; optional
  `SHELLY_UPDATER_FUNCTIONAL_CHECK=1` also runs `node cli.js --print`.
- On PASS, it promotes:

```text
~/.shelly-runtime/claude-extracted/current
```

## Shell Routing

`claude()` now prefers:

1. `~/.shelly-runtime/claude-extracted/current/.../cli.js`
2. APK-bundled `termux-libs/node_modules/@anthropic-ai/claude-code-extracted/cli.js`
3. musl SEA runtime fallback
4. APK musl fallback
5. legacy `cli.js` fallback

Expected banners:

```text
[shelly] claude: verified latest via extracted Bun cli.js (Node)
[shelly] claude: APK extracted Bun cli.js (Node)
```

## Local Extractor Validation

On desktop, the Node extractor was tested against npm latest:

```text
@anthropic-ai/claude-code-linux-arm64-musl@2.1.123
#!/usr/bin/env node
bytes=13949760
```

The validation checked:

- extracted marker present
- `CLAUDE_TMPDIR` patch present
- browser bridge tmpdir patch present
- `using` / `await using` lowered

## Device Harness

After installing the branch build:

```sh
shelly-update-clis claude --force
tail -n 160 ~/.shelly-runtime/update.log
claude --version
claude --print "Say OK"
claude --print "Use bash to run: echo shelly-ok"
```

Expected:

- update log shows `promoted <latest>`.
- `claude --version` prints the verified-latest extracted banner.
- Bash tool prints `shelly-ok`.

## Size Impact

This branch does not remove `libclaude.so`; it only removes the need for an
APK update to advance Claude. Once this survives device testing, the next size
branch can remove or lazy-fetch `libclaude.so` because the updater-managed
extracted route is the primary path.
