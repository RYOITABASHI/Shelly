# Build 782 Security + CLI Runtime Harness

Date: 2026-05-01
Commit: `67b42d89`
Branch: `main`
CI:
- Security docs/redaction run: `25194478816` PASS
- Secret-fixture cleanup run: `25194611736` PASS

Device:
- Galaxy Z Fold6
- Shelly build 782

## Purpose

This is the current release-gate harness for the security hardening added after
the build 780 terminal recovery fix. It extends the build 769 CLI runtime
harness with credential hygiene checks from `shelly-doctor`.

## Required Smoke Commands

Run in a fresh Shelly terminal:

```sh
shelly-doctor
claude --version
claude --print "Use bash to run: echo shelly-ok"
codex --version
codex -m gpt-5.5 "Say OK"
gemini --version
```

Expected output shape:

```text
claude extracted         OK 2.1.126 (Claude Code)
claude musl runtime      WARN missing binary
claude apk               OK 2.1.116 (Claude Code)
claude legacy            OK 2.1.112 (Claude Code)
claude auth root         <timestamp> 0600
claude credentials       <timestamp> 0600

codex runtime            OK codex-exec 0.125.0-termux
codex apk                OK codex-exec 0.121.0-termux
codex auth               ok mode=chatgpt refresh=true

gemini                   OK 0.40.1

download credentials     OK none
.claude.json             OK 0600
.credentials.json        OK 0600
auth.json                OK 0600
api env vars             OK none
```

`claude musl runtime WARN missing binary` is acceptable for build 782. The
default supported route is the extracted Bun `cli.js` running through bundled
Node; the musl SEA route is only a fallback tier.

## Credential Handoff Cleanup

If `shelly-doctor` reports:

```text
download credentials     WARN shelly-claude-root.json, termux-claude-dir.tar, termux-gemini-dir.tar still in /sdcard/Download
```

and credential import has already succeeded, delete only the handoff files:

```sh
rm -f /sdcard/Download/shelly-claude-root.json
rm -f /sdcard/Download/termux-claude-dir.tar
rm -f /sdcard/Download/termux-gemini-dir.tar
shelly-doctor
```

Expected post-cleanup state:

```text
download credentials     OK none
.claude.json             OK 0600
.credentials.json        OK 0600
auth.json                OK 0600
api env vars             OK none
```

## Secret Scanning Notes

Commit `f7cd6c08` intentionally added redaction unit tests. GitHub secret
scanning flagged one dummy Google API key-shaped fixture in
`__tests__/redact-secrets.test.ts`. Commit `67b42d89` rewrote that fixture to
construct the fake key at runtime so the repository no longer contains a
literal `AIza...` test value.

If GitHub still shows historical alerts:

- `__tests__/redact-secrets.test.ts` -> close as `Used in tests`.
- `termux-bridge.test.ts` placeholder values -> close as `Used in tests`.
- Historical committed `node_modules` values -> close as `False positive`
  unless the value is confirmed to be a maintainer-owned credential.

Current tree check:

```sh
rg "AIza[0-9A-Za-z_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|csk-[A-Za-z0-9_-]{20,}" .
```

Expected: no matches for real secret-shaped literals.

