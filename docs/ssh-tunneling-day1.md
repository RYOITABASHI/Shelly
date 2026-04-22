# SSH Tunneling — Day 1 Plan

Living plan for the `feat/ssh-tunneling` branch. Keep edits committed
alongside the code changes so the next session reopens the branch and
finds the current step.

## Commit plan (one commit per bullet)

### Commit 1 — Lazy-install skeleton + version pins ✅ (shipped on branch)
- [x] `shelly-cs.js`: `ensureTunnelingDeps()` — checks for marker file
      + sentinel (node_modules actually populated), writes a
      `package.json` with an `overrides: { websocket: 'npm:ws@^8' }`
      into `$HOME/.shelly-cs/`, then runs the bundled
      `node npm-cli.js install --prefix $CONFIG_DIR --no-audit --no-fund
      --no-save @microsoft/dev-tunnels-connections@^1.3
      @grpc/grpc-js@^1.9 ssh2@^1.15 ws@^8`. Marker at
      `$HOME/.shelly-cs/.tunnel-deps-installed` on success.
- [x] `cmdSSH` — after `ensureTunnelingDeps()`, tries to `require()`
      each of the three key packages from `$HOME/.shelly-cs/node_modules/`.
      On success, prints the Day 1 checkpoint message and exits.
      Subsequent `shelly-cs ssh` invocations skip the install.
- [x] `shelly-cs doctor` — new row:
      `SSH tunneling:  ✓ deps installed` (or `(not installed yet)`).

**Commit SHA**: (filled in on push)
**Device verification status**: pending — needs an APK built from this
branch. Local `npm install` works on dev machine but the real test is
that the bundled Android bionic node actually resolves the packages,
that `websocket` → `ws` override is honored, and that `ssh2`'s optional
`cpu-features` binding is correctly skipped on bionic.

### Commit 2 — Vendor .proto + generate gRPC stubs
- [ ] Copy `codespaceHost.proto` + `sshServer.proto` from
      [gh CLI master](https://github.com/cli/cli/tree/trunk/internal/codespaces/rpc)
      to `modules/.../assets/shelly-cs/proto/` (verbatim, with the same
      filenames + path so future re-syncs are trivial).
- [ ] Vendor notes: commit hash + date of the copy.
- [ ] CI step: `node $libDir/node_modules/@grpc/proto-loader/cli.js ...`
      at runtime is preferable to build-time stub generation (keeps CI
      unchanged). Test in-device first.

### Commit 3 — Tunnel connection wired
- [ ] `shelly-cs-tunnel.js` — `connectTunnel(props)` wraps
      `TunnelRelayTunnelClient.connect()`. Logs "connected" on success.
- [ ] `cmdSSH` — fetch `tunnelProperties` via
      `GET /user/codespaces/{name}?internal=true&refresh=true`,
      call `connectTunnel`, log success, disconnect.
- [ ] Test device flow: `shelly-cs ssh <name>` should report
      "connected to tunnel tunnelId=… cluster=… [OK]" and exit.

### Commit 4 — gRPC StartSSHServer
- [ ] `shelly-cs-rpc.js` — open a gRPC channel on port 16634 via
      dev-tunnels-connections, call `CodespaceHost.StartSSHServerWithOptions`
      passing the public key.
- [ ] Log `{ serverPort, sshUser }` and exit.
- [ ] Test: output should be `SSH server ready on remote port NNNN`.

### Commit 5 — Local SSH bridge
- [ ] `ensureSSHKey()` — generate `$HOME/.shelly-cs/id_ed25519` if
      missing. `spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '',
      '-f', priv, '-C', 'shelly-cs'])`.
- [ ] Tunnel port forwarding: bind local TCP listener, pipe bytes to
      the codespace `serverPort` via dev-tunnels.
- [ ] Spawn `$libDir/ssh -i ~/.shelly-cs/id_ed25519 -p <localPort> -o
      NoHostAuthenticationForLocalhost=yes <sshUser>@localhost`
      with stdio inherit. User should see bash prompt.

### Commit 6 — UX polish
- [ ] Progress spinner during tunnel dial / start / key-install.
- [ ] Error classifications: tunnel dial fail, RPC timeout, SSH
      auth fail, codespace Shutdown (suggest `cs open` first).
- [ ] `shelly-cs doctor` — add a "tunnel reachable" health check that
      actually attempts a dial + immediately disconnect.
- [ ] Document SSH shortcut in the Ask Pane curated docs.

### Commit 7 — Merge + tag v0.1.1-rc1
- [ ] Rebase onto latest main, squash into ~3 clean commits.
- [ ] Run the full device verification script from scripts/test-v34.md
      plus new "shelly-cs ssh" items.
- [ ] Tag v0.1.1-rc1, upload APK to GitHub Release.

## Open risks to resolve in Commit 1

1. **npm install on device**: does the bundled npm-cli.js correctly
   resolve `@microsoft/*` packages? Test by running
   `node $libDir/node_modules/npm/bin/npm-cli.js install --prefix /tmp/x
   @microsoft/dev-tunnels-connections@1.3.41` on device.
2. **websocket → ws override**: pnpm / npm honor `overrides` in
   `package.json`, but the install call happens at runtime with npm,
   not pnpm. Confirm `npm install --prefix` respects overrides. If
   not, swap for `ws` explicitly via a post-install patch step.
3. **bionic bionic**: `@grpc/grpc-js` is pure JS (confirmed in the
   agent report), so no node-gyp drama. `ssh2` is also pure JS with
   `cpu-features` being optional — test `--no-optional` install.
4. **APK size budget**: lazy install writes to `$HOME/.shelly-cs/
   node_modules/` which is user storage, NOT APK. Zero APK growth.

## Reference links

- gh CLI SSH source: https://github.com/cli/cli/blob/trunk/pkg/cmd/codespace/ssh.go
- gh CLI connection: https://github.com/cli/cli/blob/trunk/internal/codespaces/connection/connection.go
- dev-tunnels-connections npm: https://www.npmjs.com/package/@microsoft/dev-tunnels-connections
- ssh2 API: https://github.com/mscdex/ssh2#client-methods
