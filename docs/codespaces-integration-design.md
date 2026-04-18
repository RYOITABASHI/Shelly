# Shelly × GitHub Codespaces Integration — Design Doc

**Status**: Phase 1 minimum shipped in BASHRC_VERSION 34 (commit
`15ee5843`). This document captures the broader design for Phase 1.5+
so future work doesn't re-litigate the decisions that landed Phase 1.

## Why this exists

`@anthropic-ai/claude-code@2.1.113` (2026-04 or earlier) replaced the
plain-JS `cli.js` entry point with a Bun-compiled SEA binary
(`bin/claude.exe`). The npm tarball no longer ships `cli.js`, and
`cli-wrapper.cjs` is a 126-line platform-detect+spawn launcher with no
JS fallback. Shelly's bundled bionic `node` can't execute the Bun
binary; `proot`+Alpine chroot worked in v28–v30 but was fragile enough
that v31 never built cleanly.

**Conclusion**: the last claude-code release that runs natively on
Android bionic via Shelly's bundled runtime is **2.1.112**. Shipping
newer versions locally requires either:

1. Reviving the proot+Alpine chroot path (abandoned for compound
   complexity + Samsung Knox seccomp friction)
2. Running claude-code on a real Linux host and tunneling to it from
   Shelly

Option 2 is the sustainable answer. GitHub Codespaces gives every user
a 60-hour/month free tier of Ubuntu compute with their repos pre-cloned
and `.devcontainer/devcontainer.json` support, which is perfect for
"always-latest claude-code on mobile."

## Architecture (Shelly standalone)

```
┌─────────────────────────────────────────────────────────────┐
│ Shelly APK (JNI forkpty + bundled bionic binaries)          │
│                                                              │
│  Terminal Pane  ──────┐                                     │
│  Sidebar → CODESPACES ─┤  (Phase 2)                         │
│  Browser Pane  ────────┤  (OAuth device-flow URL)           │
│  SecureStore  ─────────┤  (Phase 1.5: token bridge)         │
│                        │                                     │
│                        ▼                                     │
│   bundled node ──► $HOME/.shelly-cs/shelly-cs.js            │
│                    │                                         │
│                    ├─► GitHub REST API  (HTTPS, fetch)      │
│                    └─► bundled ssh       (Phase 1.5 SSH)    │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
     GitHub Codespaces VM (Ubuntu 22.04 + claude-code @latest)
```

Key invariants:

- **No gh CLI dependency.** Everything shells out of Shelly's bundled
  node via the REST API. gh is a Go binary we'd have to cross-compile
  for bionic; the ROI is negative given the API covers every op.
- **No Termux dependency.** Shelly is a standalone Android app. `pkg
  install` is not an option; every binary Shelly needs is either in
  `termux-libs/` (APK assets extracted on first launch) or JavaScript
  running under bundled node.
- **OAuth App (not GitHub App).** GitHub Apps support device flow but
  use fixed permissions at the app level; OAuth Apps use dynamic
  scopes at authorization time. Shelly's
  `Ov23liLDXUTGYlzzhlLG` is an OAuth App with device-flow enabled.

## Phase map

### Phase 1 minimum (shipped, `15ee5843`)

- `shelly-cs auth` — OAuth device flow, token saved to
  `$HOME/.shelly-cs/token` (0600)
- `shelly-cs list / create / open / stop / delete / doctor / logout`
- Client ID + default template repo + scope all env-overridable
- `open` uses Android `VIEW` intent to launch OS browser at the
  codespace's `web_url` → user gets the codespace's web terminal with
  claude-code pre-installed
- `ssh` is a placeholder that prints "use `open` for now"

Success criterion: dogfood user can `shelly-cs auth && shelly-cs
create && shelly-cs open <name>` and reach claude-code REPL in the
codespace web terminal within ~3 minutes.

### Phase 1.5 (next sprint)

Goal: **close the UX loop** so the Phase 1 flow doesn't require
context-switching between Shelly and the OS browser.

#### A. Browser Pane auto-open

Replace `am start -a VIEW` with a call into Shelly's in-app Browser
Pane. Pure-bash/node can't reach React Native state directly, so we
need a JSI bridge:

```kotlin
// modules/terminal-emulator/android/src/main/java/.../ShellyBridge.kt
@ReactMethod
fun openBrowserPane(url: String, promise: Promise) {
  // Emit event that BrowserPane React component listens for
  // Sets pane URL, focuses the pane, animates in if collapsed.
}
```

```javascript
// shelly-cs.js
async function openUrl(url) {
  // Preferred: Shelly in-app Browser Pane (if the bridge socket is up)
  const bridgeSocket = '/data/user/0/dev.shelly.terminal/files/home/.shelly-bridge.sock';
  if (fs.existsSync(bridgeSocket)) {
    await bridgeRequest('openBrowserPane', { url });
    return;
  }
  // Fallback: OS browser
  spawnSync('am', ['start', '-a', 'android.intent.action.VIEW', '-d', url]);
}
```

Uses a unix socket for the bridge so the JS side doesn't need native
modules.

#### B. Auth completion polling + notification

Currently `shelly-cs auth` polls `/login/oauth/access_token` in a loop
and blocks the terminal. Better: after showing the code, release the
terminal and poll in the background, emitting a Shelly notification
when authorization completes.

```javascript
// Split into two phases:
// shelly-cs auth:begin → show code, save device_code to temp, poll
//                       in a detached `( ... & )` subshell
// Poll job writes status to $HOME/.shelly-cs/auth-status
// On completion: `notify-send`-style Shelly notification via the bridge
```

#### C. Clipboard integration

Auto-copy the device code. Best done via bridge:

```javascript
async function writeClipboard(text) {
  if (bridgeUp) await bridgeRequest('clipboardWrite', { text });
  else spawnSync('am', ['broadcast', '-a', 'clipper.set', '-e', 'text', text]);
}
```

Android ClipboardManager from a child process requires either Termux
Clipper or a proper bridge; we go with the bridge.

#### D. SecureStore bridge

Token currently in `$HOME/.shelly-cs/token` (0600). Move to
expo-secure-store via the same bridge:

```javascript
async function saveToken(token) {
  if (bridgeUp) await bridgeRequest('secureStoreSet', { key: 'shelly-cs.token', value: token });
  else fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}
```

Gracefully degrades to file-based storage if the bridge isn't
available (e.g. running `shelly-cs` from a detached tmux session after
Shelly has been force-stopped).

#### E. SSH tunneling

The tricky one. GitHub Codespaces doesn't expose standard SSH by
default; `gh codespace ssh` uses a proprietary tunnel:

> 1. POST `/user/codespaces/{name}/start` to ensure it's running
> 2. Open a WebSocket to `{codespace-host}/api/codespaces/connect`
> 3. Inside the WebSocket, speak JSON-RPC for session management
> 4. The actual SSH traffic rides an SSH-over-WebSocket stream

Three implementation candidates, in increasing order of fidelity:

1. **Port gh's tunnel client logic to Node.** The reference is
   [`github.com/cli/cli/pkg/cmd/codespace/`](https://github.com/cli/cli/tree/trunk/pkg/cmd/codespace).
   Estimated 1,500–2,500 LoC of JS. Uses `ws` library (no WebSocket in
   bundled node built-ins pre-v22 — bundling adds ~20 KB).

2. **Enable Codespaces SSH-server feature + use direct SSH.** The
   template repo can include `"features": { "ghcr.io/devcontainers/
   features/sshd:1": {} }`. The codespace then listens on a forwarded
   port; Shelly's bundled `ssh` connects to `ssh.github.com` with the
   port forwarded. Needs SSH key generation + upload to
   `/user/keys` first.

3. **Use the `web_url` + terminal browser automation.** Not really an
   SSH; script the web terminal via Selenium-equivalent. Ugly.

Ranking: (2) is the cleanest if the feature is stable in
devcontainers. (1) is the most faithful to how users expect `gh cs
ssh` to behave. (3) is a no-go.

**Phase 1.5 target**: (2) for key-based SSH via the
sshd devcontainer feature. Phase 2+ may add (1) for feature parity.

SSH key generation:

```javascript
async function ensureSSHKey() {
  const priv = path.join(CONFIG_DIR, 'id_ed25519');
  const pub = priv + '.pub';
  if (!fs.existsSync(priv)) {
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv, '-C', `shelly-cs on ${os.hostname()}`]);
    const pubKey = fs.readFileSync(pub, 'utf8').trim();
    await ghApi('/user/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `shelly-cs (${os.hostname()})`, key: pubKey })
    });
  }
  return priv;
}
```

### Phase 2 (Sidebar integration)

New `CODESPACES` sidebar section between `WORKTREES` and `FILE TREE`.
Reuses the Worktrees pattern:

```tsx
// components/layout/CodespacesSection.tsx
// - 30s polling against shelly-cs list (or WebSocket)
// - Tap codespace name → opens Terminal Pane, runs `shelly-cs ssh <name>`
// - Long press → menu: Start / Stop / Rebuild / Delete / Copy name
// - [+ Create] → in-app wizard that calls shelly-cs create
```

### Phase 3 (transparent claude routing)

The north star. Users type `claude "fix this bug"` in Shelly's
Terminal Pane and Shelly transparently:

1. Notices local `cli.js` is 2.1.112 (frozen)
2. Checks if there's a default Codespace configured in
   `$HOME/.shelly-cs/config.json`
3. If yes and the codespace is reachable: routes the command through
   the SSH tunnel; stdout streams back to the Terminal Pane
4. If no: prompts "No default Codespace. Run `shelly-cs use <name>` or
   set up Codespaces (`shelly-cs auth && shelly-cs create`)"

Implementation: extend the `claude()` bash function in `.bashrc` with
a Tier 0 that precedes the existing three-tier local fallback.

## Security model

- **Client ID** is public and embedded in APK — safe by OAuth design.
- **Client Secret** is not used (device flow doesn't require it).
- **User access token** is per-user, obtained via device flow, scope
  `codespace repo read:user`. Stored in `$HOME/.shelly-cs/token`
  (0600); Phase 1.5 moves it to SecureStore.
- **SSH private key** (Phase 1.5) is generated on device, passphrase-free
  (mobile UX), but protected by file permissions + SecureStore-backed
  storage once the bridge lands.
- **No secrets leave the device** beyond the device-flow authorization
  dance; all tokens live in SecureStore.

## Free tier budget

GitHub Codespaces:

- Free: 120 core-hours/month (2-core) or 60 hours of 2-core time
- Pro: 180 hours/month
- Codespaces auto-stop after 30 min inactivity (configurable)

For a typical mobile user:

- 10 hours of active coding per week ≈ 40 hours/month → fits in
  Codespaces free tier
- Shelly doesn't need to proactively stop codespaces (GitHub does it)
- `shelly-cs doctor` can surface remaining hours if/when the API
  exposes them reliably

## Non-goals

- **Offline codespace access.** Phase 1 is honest about needing network.
  Future `proot-distro` integration (Phase 4+?) could add an offline
  mode but is explicitly out of scope for now.
- **Multi-user codespaces / org support.** Personal use only in Phase
  1/1.5. Org integration is Phase 3+ if there's demand.
- **VS Code extension parity.** Shelly is a terminal/chat-first IDE.
  Codespaces integration delivers terminal access, not a full VS
  Code-alike.

## Open questions

1. **SSH vs web_url trade-off** for Phase 2 default tap action. SSH
   gives better UX (stays in Shelly) but requires Phase 1.5 completion.
   Before Phase 1.5 lands, `open` → web browser is the fallback.
2. **Template repo maintenance.** If claude-code's `@latest` changes
   packaging again (we've seen 2.1.112 → 2.1.113 break things), the
   template's `postCreateCommand` might fail. Should the template pin a
   known-working version? Probably yes — at least until we observe
   stability for a quarter.
3. **Codespace idle auto-stop UX.** When a user returns to Shelly 40
   minutes after last use, their codespace is Shutdown. `open` starts
   it (~30s). Should we pre-start on Shelly launch? Too aggressive
   (eats hours). Status pill in Sidebar Phase 2 seems right.
