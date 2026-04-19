# Shelly v0.1.0-rc3 — Release Notes draft

> Incremental RC3 on top of [rc2](./RELEASE-v0.1.0-rc2.md). rc2 notes
> still apply; this document covers only what changed.

## 🎯 Headline

**All three AI CLIs now work natively on-device.** Claude Code,
Gemini, and Codex authenticate and converse without leaving Shelly.
No SSH, no cloud hop, no Codespace. This is the milestone the project
has been driving toward since v0.1.0 scope was set.

## TL;DR for the impatient

```
claude                            # launches, then /login for OAuth
gemini                            # /auth for Google login
codex-login  [--open]             # NEW — ChatGPT subscription device-auth
codex "hello"                     # picks up ~/.codex/auth.json automatically
```

## What changed since rc2

### Added

- **`codex-login` — ChatGPT subscription native login.** Codex has
  been the last CLI that needed an SSH-attached Linux host to get
  authenticated because the codex-termux rebuild we bundle has the
  `login` subcommand compiled out of its Rust binary. v39 ships a
  pure-JS driver (`~/.shelly-codex-auth.js`, 250 LoC) that walks the
  exact three-step device-auth flow defined in
  `openai/codex-rs/login/src/device_code_auth.rs`:
  1. `POST /api/accounts/deviceauth/usercode` to request a device code
  2. Poll `POST /api/accounts/deviceauth/token` for completion
  3. `POST /oauth/token` for the final tokens (form-encoded)
  4. Write `~/.codex/auth.json` with mode 0600 in the exact
     `auth_mode:"chatgpt"` schema codex reads
  `codex-login --open` hands the verification URL to the Shelly
  Browser Pane via the `shelly://browser?url=…` deep link so the
  user never leaves the app. Reference commit: `6f0b4e16`.

- **Mozilla CA bundle (226 KiB) bundled as an APK asset.** Extracted
  to `~/.shelly-ssl/ca-certificates.crt` on every launch. Wires five
  environment variables in `.bashrc`:
  - `SSL_CERT_FILE` (openssl, rustls)
  - `SSL_CERT_DIR`
  - `CURL_CA_BUNDLE` (bundled curl)
  - `NODE_EXTRA_CA_CERTS` (bundled node — fetch, undici, https)
  - `REQUESTS_CA_BUNDLE` (bundled python)
  Without this, Android's system trust store lives somewhere
  openssl/rustls don't probe by default, and rustls in particular
  bails with "no native root CA certificates found" — observed as
  the root cause of `codex login` failures during the 2026-04-19
  smoke test. Side effect: all bundled TLS clients that used to
  fail silently against HTTPS endpoints now succeed.

### Fixed

- **MOTD login hints were wrong.** The first-launch welcome message
  used to suggest `claude auth login` and `gemini auth login`, which
  are not actual subcommands. Claude authenticates via `/login`
  inside the interactive REPL; Gemini via `/auth`. Corrected to
  match actual UX, and added a `codex-login` entry.

- **Correction to rc2 notes: the "Anthropic OAuth ban" was a false
  alarm.** Claude Code 2.1.112 continues to authenticate fine via
  the standard OAuth Device Flow. A previous RC draft
  speculated about an OAuth policy change on 2026-04-04 after a
  single 400 response; field verification against a fresh Claude
  Max login on 2026-04-19 confirmed no such restriction exists.
  Native Claude Code is a first-class supported path on Shelly, not
  a deprecated one.

### Docs

- Release notes: this file (`docs/RELEASE-v0.1.0-rc3.md`).
- DEFERRED.md does not gain or lose items; rc3 is pure-forward.

## Still deferred (unchanged from rc2)

- `shelly-cs ssh` real tunneling — branch `feat/ssh-tunneling`
  continues. Day 2 library drafted, wiring in progress. v0.1.1
  target.
- Ask Pane Stage 3 (dedup search, category labels, history, voice
  input, full-text ingestion).
- Sidebar CODESPACES section — follows Worktrees pattern, depends on
  SSH dogfood.

## BASHRC_VERSION bump

`38 → 39`. Forces `.bashrc` regeneration on next shell launch so the
new `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` /
`REQUESTS_CA_BUNDLE` / `SSL_CERT_DIR` exports propagate and the new
`codex-login` shell function is defined. The old cli-update marker is
cleared so the background CLI update pipeline re-runs (idempotent).

## Verification (device smoke test for rc3)

```
# 1. All three CLIs should launch without error and auth interactively.
claude           # then /login         (expect: "Login successful")
gemini           # then /auth          (expect: Google browser flow)
codex-login      # follow URL + code   (expect: "codex login successful")

# 2. Round-trip each CLI.
claude -p "say hi in 5 words"           # Claude Max subscription
gemini -p "say hi in 5 words"           # Gemini Google login
codex       "say hi in 5 words"         # ChatGPT subscription

# 3. Confirm TLS plumbing is in effect:
curl -sI https://api.openai.com/ | head -1       # expect: HTTP/2 200 or 401
echo "$NODE_EXTRA_CA_CERTS"                      # expect: /data/.../home/.shelly-ssl/...
cat ~/.codex/auth.json | head -3                 # expect: {"OPENAI_API_KEY": null, "tokens": {...
```

If `curl` fails with `SSL certificate problem: unable to get local
issuer certificate`, the CA bundle didn't extract — check
`ls -la ~/.shelly-ssl/ca-certificates.crt`. If that file exists but
is 0 bytes, re-install the APK (the asset probably got blocked
during the copy).

If `codex-login` fails at step 1 (usercode) with a TLS error, the
`NODE_EXTRA_CA_CERTS` export isn't reaching the node process — check
`env | grep NODE_EXTRA_CA_CERTS` and verify `~/.bashrc_version` reads
`39` or higher.

If `codex "hello"` returns `401 Unauthorized` after a successful
login, check `~/.codex/auth.json` exists and contains
`"auth_mode": "chatgpt"`. codex-termux reads that file on every
invocation; any schema drift shows up here first.

## Upgrade notes

- APK upgrade preserves the `~/.shelly-cli/` tree (claude/gemini/
  codex installs), `~/.shelly-cs/token`, and `~/.codex/auth.json`
  if previously written. Users who were already authenticated
  through some other path do not need to re-login.
- The CA bundle is fresh on every launch (overwrite), so cert
  rotation in future APKs propagates automatically.
- No action required from users upgrading from rc2 apart from
  installing the APK and running `codex-login` if they want Codex
  native (no one had working Codex native before rc3).

## Known issues

- `codex-login --open` opens the Browser Pane but currently does not
  auto-copy the `user_code` to the clipboard. Manual copy/paste
  required. Tracked for rc4 polish (clipboard deep link already
  exists — just needs hooking up in `shelly-codex-auth.js`).
- Claude Code OAuth token persists in `~/.claude/` under the app
  data directory. Wiping app data requires re-login; a SecureStore
  bridge is deferred.
