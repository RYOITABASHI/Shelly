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

#### E. SSH tunneling — concrete implementation plan

**Investigation outcome (2026-04-19)**: GitHub Codespaces do NOT
expose raw TCP to the public internet. Every approach that looked
simpler on paper (sshd devcontainer feature + standard SSH, public
forwarded-port, Codespaces public SSH endpoints) turned out to be a
dead end — the codespace's SSH port is only reachable via Microsoft's
**dev-tunnels relay**, the same mechanism `gh codespace ssh` uses.

See the two agent reports under the "SSH Tunneling" commit history
(2026-04-19 parallel agent run) for the full investigation of gh's
source, the npm ecosystem, and Android-bionic compatibility. The
decision summary:

**Approach A: port gh's tunnel client to Node.js** using the
Microsoft-published TypeScript SDK for dev-tunnels + ssh2 as the SSH
client. This is the ONLY approach that works on Android, and it's
what Phase 1.5's `shelly-cs ssh <name>` will implement.

**Why sshd-feature + raw SSH doesn't work**: the sshd devcontainer
feature installs openssh-server inside the codespace, but port 22 is
private to the codespace. GitHub's public-port surface speaks
HTTP/WebSocket (cookie-auth), not raw TCP — you cannot `CONNECT`
traditional SSH through it.

##### Protocol — what happens under `shelly-cs ssh <name>`

Traced from [`cli/cli/pkg/cmd/codespace/ssh.go`](https://github.com/cli/cli/blob/trunk/pkg/cmd/codespace/ssh.go),
[`internal/codespaces/connection/connection.go`](https://github.com/cli/cli/blob/trunk/internal/codespaces/connection/connection.go),
[`internal/codespaces/rpc/invoker.go`](https://github.com/cli/cli/blob/trunk/internal/codespaces/rpc/invoker.go):

1. **Fetch tunnel properties** — `GET /user/codespaces/{name}?internal=true&refresh=true`
   returns `connection.tunnelProperties` with fields
   `{ connectAccessToken, managePortsAccessToken, serviceUri,
   tunnelId, clusterId, domain }`.

2. **Open dev-tunnels WebSocket** — dial
   `wss://{cluster}-data.rel.tunnels.api.visualstudio.com/api/v1/Client/Connect/{tunnelId}`
   with subprotocol `tunnel-relay-client`, header
   `Authorization: Tunnel {connectAccessToken}`. This is the only
   public ingress point Microsoft exposes for codespace tunnels.

3. **SSH-over-tunnel** — the relay wraps a dev-tunnels-ssh channel.
   Inside this channel, open a gRPC connection on the codespace's
   internal port `16634` and call
   `CodespaceHost.StartSSHServerWithOptions({publicKey})`. The
   codespace-side agent adds `publicKey` to its `authorized_keys`,
   spawns `sshd` on an ephemeral port, and returns
   `{ serverPort, sshUser }`.

4. **Local SSH client** — open a second dev-tunnels channel that
   pipes bytes to the ephemeral `serverPort` on the codespace side,
   bind a local TCP listener, forward the two together, then exec
   the bundled `$libDir/ssh` against `localhost:<localPort>` with
   `-i ~/.shelly-cs/id_ed25519` and the returned `sshUser`. The
   SSH handshake goes through the tunnel and the user sees a bash
   prompt in Shelly's Terminal Pane.

##### npm dependencies

```
@microsoft/dev-tunnels-connections  ~365 KB   tunnel transport
@microsoft/dev-tunnels-management   ~200 KB   tunnel metadata
@grpc/grpc-js                       ~450 KB   StartSSHServer RPC
ssh2                                ~500 KB   SSH client (pure JS, no native crypto)
ws                                  ~50 KB    WebSocket (override for `websocket`)
                                    ─────────
total added                         ~1.5 MB
```

**Override needed**: `@microsoft/dev-tunnels-connections@^1.3` pulls
`websocket@1.x` transitively, which wants the native `bufferutil` +
`utf-8-validate` addons. Add a `"overrides"` block in `package.json`
to force `ws` instead — pure JS, no node-gyp, clean on bionic.

**Vendored .proto files**: `codespaceHost.proto`, `sshServer.proto`
are checked into gh's tree. Copy them into
`modules/terminal-emulator/android/src/main/assets/shelly-cs/proto/`
and generate gRPC stubs at build time with `grpc-tools`.

##### Lazy install (no APK bloat for non-users)

Don't ship 1.5 MB of npm packages to every user. Instead, install
them on first `shelly-cs ssh <name>` invocation:

```javascript
// shelly-cs.js
async function ensureTunnelingDeps() {
  const marker = path.join(CONFIG_DIR, 'tunnels-installed');
  if (fs.existsSync(marker)) return;
  console.log('  [one-time] Installing SSH tunneling deps (~30s, ~1.5 MB)…');
  const r = spawnSync(process.execPath, [
    NPM_CLI_JS, 'install',
    '--prefix', CONFIG_DIR,
    '@microsoft/dev-tunnels-connections@^1.3',
    '@grpc/grpc-js@^1.9',
    'ssh2@^1.15',
    'ws@^8',
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm install failed');
  fs.writeFileSync(marker, new Date().toISOString());
}
```

First `shelly-cs ssh` takes ~30s extra. Subsequent invocations are
instant. No APK size increase for users who only use the web-URL
path via `shelly-cs open`.

##### SSH key lifecycle

```javascript
async function ensureSSHKey() {
  const priv = path.join(CONFIG_DIR, 'id_ed25519');
  if (!fs.existsSync(priv)) {
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv,
      '-C', `shelly-cs-${os.hostname()}-${Date.now()}`]);
  }
  return priv;
}
```

Public key is passed to `StartSSHServerWithOptions` RPC per
connection — gh CLI does the same. No need to upload to
`/user/keys` globally.

##### Expected timings

- Cold codespace (Shutdown): `/start` (~30-60s) → tunnel dial
  (~800ms) → SSH handshake (~500ms) → **~40s total to bash prompt**.
- Warm codespace (Available): tunnel dial (~800ms) → RPC + key
  install (~400ms) → SSH handshake (~500ms) → **~1.7s to bash
  prompt**, matches `gh codespace ssh` benchmarks.
- Tunnel reconnect on disconnect: ~2s, automatic via library.

##### Risks / maintenance cost

- **Undocumented RPC schema**. `codespaceHost.proto` /
  `sshServer.proto` are in gh's tree, not Microsoft's public docs.
  Breaking changes have happened roughly every 6 months in the past
  (gh CLI ships the update synchronously — we'd lag).
- **Undocumented `tunnelProperties` response shape**. Safe for now
  (shipped to gh users for 3+ years) but could silently change.
- **Microsoft SDK churn** — `@microsoft/dev-tunnels-*` packages are
  on v1.x but have rewritten their API twice in the last year.
  Pin exact minor versions.

Mitigations: pin npm package minors, vendor .proto files (don't
fetch at runtime), add a health-check step in `shelly-cs doctor`
that actually attempts a tunnel dial and reports the protocol
version mismatch if anything has shifted.

##### Estimated Phase 1.5 SSH implementation

- `shelly-cs-tunnel.js` — tunnel client wiring, ~200 LoC.
- `shelly-cs-rpc.js` — gRPC + proto consumption, ~150 LoC.
- `shelly-cs.js ssh` — integration, ~100 LoC.
- `ssh2` pty + shell + stdin/stdout forwarding, ~200 LoC.
- Error handling + retries + disconnect UI, ~100 LoC.
- **Total ~750 LoC + 1.5 MB deps (lazy install)**.
- **Calendar time: 3-5 days** for a working prototype, add 2 days
  for polish + error handling + dogfood iteration.

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
