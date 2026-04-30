# Security Policy

Shelly is an Android terminal + AI editor that executes shell commands, reaches
external LLM APIs, and stores API keys and SSH profile metadata on-device. That
means the attack surface is small but not zero. This document explains how to
report a problem and what to expect.

## Threat model (short version)

- **On-device**: Shelly runs as a normal unprivileged Android app. Keys and
  profile metadata live in the app sandbox. API keys are stored through
  `expo-secure-store`; non-secret preferences live in AsyncStorage. SSH private
  keys are *not* copied into the app — Shelly only holds the filesystem path.
- **Network**: Shelly talks HTTPS to the LLM providers you configure
  (Anthropic, OpenAI, Google, Perplexity, local llama.cpp). No Shelly-operated
  server sits in the middle.
- **Shell execution**: Commands you type or agents you schedule run under the
  same uid as the app. They can read anything the app can read. Do not run
  untrusted commands or register agents you didn't write.
- **AI agents**: Claude Code, Codex, Gemini CLI, and API-backed agents are
  developer tools with shell/file access once you approve their actions or turn
  on auto-approval. Shelly is not a hardened sandbox around those agents.
- **Credential import**: Claude Code and Gemini CLI OAuth do not fully complete
  inside Shelly yet. The supported workaround is credential transplant from
  Termux, desktop, or Codespaces into Shelly's app sandbox. `/sdcard/Download`
  is only a temporary handoff location; delete copied credential archives after
  import.
- **Out of scope**: physical access to an unlocked device, compromised upstream
  packages, and bugs in Android / Expo / React Native themselves.

## API keys and credentials

- API keys configured in Settings are saved with `expo-secure-store` and are
  stripped from the AsyncStorage settings blob.
- Shelly does not send API keys to a Shelly-operated backend. Keys are sent only
  to the provider endpoints you explicitly use, such as Cerebras, Groq, Google,
  Perplexity, OpenAI, or Anthropic-compatible tools.
- `shelly-doctor` reports only whether credential files exist and whether their
  permissions are private. It must not print token contents.
- Debug logs redact common API key/token patterns before writing to logcat.
- The credential import UI does not auto-delete files from `/sdcard/Download`.
  Users must remove those handoff copies after confirming the import works.

## Local checks

Run this from Shelly when auditing a device:

```sh
shelly-doctor
shelly-doctor --json
```

Important warnings:

- `download credentials WARN` means credential handoff files are still present
  in `/sdcard/Download`.
- `*.json WARN 0644` or similar means a credential file is readable by more
  than the app uid and should be changed to private mode.
- `api env vars WARN` means an API key is present in the process environment.
  This is not automatically a leak, but environment variables are easier to
  expose through shell commands than SecureStore-backed settings.

## Reporting a vulnerability

**Please do not open public GitHub issues for security bugs.**

Instead, report privately via one of:

1. **GitHub private security advisory** — preferred.
   <https://github.com/RYOITABASHI/Shelly/security/advisories/new>
2. **Email** — open an issue titled "security contact request" without
   details and we'll follow up with an address. (Shelly is a solo OSS project,
   so response is best-effort.)

Include:

- Affected version (commit SHA or release tag)
- Reproduction steps or proof-of-concept
- Your assessment of severity and impact

## What to expect

- **Acknowledgement** within 7 days.
- **Triage** — we'll confirm whether it's in scope and agree on a disclosure
  timeline. 90 days is the default; critical issues get a shorter window.
- **Credit** — if you want it, we'll name you in the release notes and
  CHANGELOG entry that ships the fix. If you prefer anonymity, just say so.
- **No bounty** — Shelly is an unfunded solo OSS project and can't offer
  monetary rewards. Thanks in advance for reporting anyway.

## Good-faith safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service disruption while testing
- Only test against their own devices and their own API keys
- Give us reasonable time to fix the issue before public disclosure
- Do not exploit the vulnerability beyond what is necessary to confirm it
