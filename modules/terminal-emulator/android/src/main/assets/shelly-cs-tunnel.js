// shelly-cs-tunnel.js — Phase 1.5 Day 2 library (NOT WIRED YET)
//
// Draft tunnel client module for `shelly-cs ssh`. Reached from cmdSSH
// in shelly-cs.js once the Day 1 lazy-install scaffold has been
// verified on-device. This file is committed as library-only — the
// Day 1 shelly-cs.js does NOT require() this module, so breakage here
// cannot regress the Day 1 checkpoint.
//
// Protocol trace (from gh CLI pkg/cmd/codespace/ssh.go +
// internal/codespaces/connection/connection.go):
//
//   1. fetchTunnelProperties(name, token)
//        GET /user/codespaces/{name}?internal=true&refresh=true
//        → connection.tunnelProperties = {
//            connectAccessToken, managePortsAccessToken, tunnelId,
//            clusterId, domain, serviceUri
//          }
//
//   2. connectTunnel(props)
//        new TunnelRelayTunnelClient()
//          .connect({
//            tunnelId, clusterId, domain,
//            accessTokens: { connect: connectAccessToken }
//          })
//        → wss://{cluster}-data.rel.tunnels.api.visualstudio.com
//          /api/v1/Client/Connect/{tunnelId}
//          subprotocol: tunnel-relay-client
//          Authorization: Tunnel {connectAccessToken}
//
//   3. (Day 3) startSSHServer(client)
//        gRPC channel on port 16634:
//          CodespaceHost.StartSSHServerWithOptions({ publicKey })
//          → { serverPort, sshUser }
//
//   4. (Day 4) spawn local ssh(1) against forwarded localhost:<port>

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONFIG_DIR = path.join(os.homedir(), '.shelly-cs');
const DEPS_DIR = path.join(CONFIG_DIR, 'node_modules');

// Day 3 additions — constants for the gRPC StartRemoteServerAsync flow.
// The codespace's RPC server listens on port 16634 (internal); gh CLI
// forwards it to a local ephemeral port and dials gRPC there insecurely
// (transport security is provided by the tunnel itself).
const CODESPACE_INTERNAL_PORT = 16634;
const SSH_KEY_PATH = path.join(CONFIG_DIR, 'id_ed25519');
const SSH_PUB_PATH = SSH_KEY_PATH + '.pub';
const PROTO_PATH = path.join(CONFIG_DIR, 'ssh_server_host_service.v1.proto');

// Proto definition traced from gh CLI's
// internal/codespaces/rpc/ssh/ssh_server_host_service.v1.proto. Only
// one service + one RPC, so inlining the full schema keeps the library
// self-contained (no APK asset needed — written to disk on first use
// so @grpc/proto-loader's loadSync() has a file path to chew on).
const SSH_PROTO_SRC = `syntax = "proto3";
package Codespaces.Grpc.SshServerHostService.v1;
option go_package = "./ssh";

service SshServerHost {
  rpc StartRemoteServerAsync (StartRemoteServerRequest) returns (StartRemoteServerResponse);
}

message StartRemoteServerRequest  { string UserPublicKey = 1; }
message StartRemoteServerResponse { bool Result = 1; string ServerPort = 2; string User = 3; string Message = 4; }
`;

// ─────────────────────────────────────────────────────────────
// Lazy require — only pull the big deps in when connectTunnel runs.
// Callers should have already called ensureTunnelingDeps() from
// shelly-cs.js so the files exist.
// ─────────────────────────────────────────────────────────────

function requireDep(relPath) {
  try {
    return require(path.join(DEPS_DIR, relPath));
  } catch (e) {
    const err = new Error(
      `Required package not installed: ${relPath}\n` +
      `  Run \`shelly-cs ssh <name>\` once to trigger the lazy install,\n` +
      `  or manually: rm -rf ${CONFIG_DIR}/node_modules && shelly-cs ssh <name>`
    );
    err.cause = e;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Step 1 — fetch tunnel properties
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the `connection.tunnelProperties` block from the Codespaces
 * API. Requires `codespace` scope on the OAuth token (already granted).
 *
 * @param {string} codespaceName — e.g. `sturdy-cod-557j97jgggjc7p4w`.
 * @param {string} token — the shelly-cs OAuth user access token.
 * @returns {Promise<Object>} tunnelProperties
 */
async function fetchTunnelProperties(codespaceName, token) {
  const url = `https://api.github.com/user/codespaces/${codespaceName}?internal=true&refresh=true`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'shelly-cs/0.1',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`Codespace lookup failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const props = data?.connection?.tunnelProperties;
  if (!props) {
    throw new Error(
      `Response did not include connection.tunnelProperties. ` +
      `The codespace may be Shutdown — try \`shelly-cs open ${codespaceName}\` first ` +
      `to start it, then retry.`
    );
  }
  // Validate the fields we'll need downstream.
  const required = ['connectAccessToken', 'tunnelId', 'clusterId', 'domain'];
  const missing = required.filter(f => !props[f]);
  if (missing.length) {
    throw new Error(`tunnelProperties missing fields: ${missing.join(', ')}`);
  }
  return props;
}

// ─────────────────────────────────────────────────────────────
// Step 2 — connect via the Microsoft dev-tunnels relay
// ─────────────────────────────────────────────────────────────

/**
 * Open a WebSocket-based tunnel connection to the codespace and return
 * the connected TunnelRelayTunnelClient instance. Caller is responsible
 * for disposing the client (call `.dispose()` when done).
 *
 * @param {Object} props tunnelProperties from fetchTunnelProperties()
 * @param {Object} [opts]
 * @param {boolean} [opts.acceptLocalConnections=false] — when true, the
 *   tunnel client binds local TCP listeners for forwarded remote ports
 *   so downstream clients can dial `127.0.0.1:<localPort>`. MUST be set
 *   BEFORE `.connect()` per dev-tunnels-connections docs; Day 3's gRPC
 *   call requires this to be on.
 * @returns {Promise<Object>} connected tunnel client
 */
async function connectTunnel(props, opts = {}) {
  // Exact class name and import path — double-check against the
  // installed @microsoft/dev-tunnels-connections version. The API has
  // shifted between minor releases (1.1 → 1.2 renamed the primary
  // entry from `TunnelClient` to `TunnelRelayTunnelClient`).
  const devTunnels = requireDep('@microsoft/dev-tunnels-connections');
  const TunnelRelayTunnelClient =
    devTunnels.TunnelRelayTunnelClient ?? devTunnels.default?.TunnelRelayTunnelClient;
  if (!TunnelRelayTunnelClient) {
    throw new Error(
      `TunnelRelayTunnelClient export not found. Installed version may be ` +
      `incompatible. Check: node -e "console.log(Object.keys(require('@microsoft/dev-tunnels-connections')))"`
    );
  }

  const client = new TunnelRelayTunnelClient();
  if (opts.acceptLocalConnections) {
    // Per dev-tunnels-connections source: flipping this flag after
    // connect() only affects ports forwarded FROM THEN ON; ports
    // already negotiated during connect() don't retroactively get
    // local listeners. Day 3 needs 16634 to have a local listener,
    // so this must be set here, before connect().
    client.acceptLocalConnectionsForForwardedPorts = true;
  }
  await client.connect({
    tunnelId: props.tunnelId,
    clusterId: props.clusterId,
    domain: props.domain,
    // Some versions expect `accessTokens: { connect: ... }`, others
    // `accessToken` (singular). Pass both defensively; extraneous
    // fields are typically ignored.
    accessTokens: { connect: props.connectAccessToken },
    accessToken: props.connectAccessToken,
  });
  return client;
}

// ─────────────────────────────────────────────────────────────
// Step 3 — SSH key + proto file on-demand writers
// ─────────────────────────────────────────────────────────────

/**
 * Generate an ed25519 keypair at ~/.shelly-cs/id_ed25519 (private, 0600)
 * and ~/.shelly-cs/id_ed25519.pub (public, 0644) if they don't already
 * exist. Uses ssh2's utils.generateKeyPairSync which emits OpenSSH
 * format directly — matches what the codespace gRPC server expects
 * for the UserPublicKey field (literal file contents, same as what
 * ~/.ssh/id_*.pub looks like).
 */
function ensureSshKeyPair() {
  if (fs.existsSync(SSH_KEY_PATH) && fs.existsSync(SSH_PUB_PATH)) return;
  const ssh2 = requireDep('ssh2');
  const kp = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'shelly-cs' });
  fs.writeFileSync(SSH_KEY_PATH, kp.private, { mode: 0o600 });
  fs.writeFileSync(SSH_PUB_PATH, kp.public, { mode: 0o644 });
}

/**
 * Write the inline proto definition to disk so @grpc/proto-loader has
 * a file path to load from. Idempotent — skips if already written.
 */
function ensureProtoFile() {
  if (!fs.existsSync(PROTO_PATH)) {
    fs.writeFileSync(PROTO_PATH, SSH_PROTO_SRC);
  }
}

// ─────────────────────────────────────────────────────────────
// Step 4 — gRPC StartRemoteServerAsync
// ─────────────────────────────────────────────────────────────

/**
 * Over the connected tunnel, dial the codespace's internal gRPC port
 * (16634) and request that it start an SSH server. Returns the remote
 * server port + Linux user to connect as.
 *
 * The client MUST have been created with `acceptLocalConnections: true`
 * so that the tunnel binds a local TCP listener when forwarding 16634.
 * gRPC-js only accepts `host:port` strings, not arbitrary streams, so
 * the local-listener path is the pragmatic choice (mirrors gh CLI).
 *
 * Auth on the gRPC channel is a literal "Bearer token" placeholder —
 * the server checks for the header's PRESENCE, not its value; transport
 * security is already provided by the tunnel. Extracted verbatim from
 * gh's internal/codespaces/rpc/invoker.go.
 *
 * @param {Object} client — connected TunnelRelayTunnelClient
 * @param {string} publicKey — OpenSSH format public key (file contents)
 * @returns {Promise<{serverPort:number, sshUser:string, message?:string}>}
 */
async function startRemoteSshServer(client, publicKey) {
  const grpc = requireDep('@grpc/grpc-js');
  const protoLoader = requireDep('@grpc/proto-loader');
  ensureProtoFile();

  // Wait for the codespace to publish port 16634 through the tunnel,
  // then refresh our forwarded-ports table so the ForwardedPort record
  // (with its auto-assigned localPort) is visible to us.
  await client.waitForForwardedPort(CODESPACE_INTERNAL_PORT);
  await client.refreshPorts();
  const fp = client.forwardedPorts?.find(p => p.remotePort === CODESPACE_INTERNAL_PORT);
  if (!fp || !fp.localPort) {
    throw new Error(
      `remote port ${CODESPACE_INTERNAL_PORT} not forwarded. The codespace ` +
      `may not have finished booting — try \`shelly-cs open <name>\` first ` +
      `to wake it, wait ~15s, then retry.`
    );
  }

  const def = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String });
  const pkg = grpc.loadPackageDefinition(def).Codespaces.Grpc.SshServerHostService.v1;
  const stub = new pkg.SshServerHost(`127.0.0.1:${fp.localPort}`, grpc.credentials.createInsecure());

  const md = new grpc.Metadata();
  md.set('Authorization', 'Bearer token'); // literal placeholder per gh CLI

  const resp = await new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 30_000);
    stub.StartRemoteServerAsync(
      { UserPublicKey: publicKey },
      md,
      { deadline },
      (err, r) => err ? reject(err) : resolve(r)
    );
  });
  try { stub.close?.(); } catch { /* best-effort */ }

  if (!resp.Result) {
    throw new Error(`StartRemoteServerAsync failed: ${resp.Message || '(no message)'}`);
  }
  // The returned User will end up as the SSH login, so screen for
  // anything that could be shell-metacharacter-interpreted.
  if (!/^[a-zA-Z0-9_][-.a-zA-Z0-9_]*$/.test(resp.User)) {
    throw new Error(`server returned suspicious user: ${JSON.stringify(resp.User)}`);
  }
  return {
    serverPort: Number(resp.ServerPort),
    sshUser: resp.User,
    message: resp.Message || undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Entry point for one-shot "connect and disconnect" smoke test
// (used by Day 2 `shelly-cs ssh --probe-tunnel` for dogfood).
// ─────────────────────────────────────────────────────────────

async function probeTunnel(codespaceName, token) {
  const props = await fetchTunnelProperties(codespaceName, token);
  const client = await connectTunnel(props);
  try {
    // Return a small object the CLI can log.
    return {
      tunnelId: props.tunnelId,
      cluster: props.clusterId,
      domain: props.domain,
      serviceUri: props.serviceUri,
      connected: true,
    };
  } finally {
    try { await client.dispose?.(); } catch {}
  }
}

/**
 * Day 3 end-to-end probe: fetch tunnel props → connect (with local
 * forwarding) → request SSH server → return connection info.
 *
 * The returned client is DISPOSED before this function returns —
 * actually ssh'ing to `sshUser@127.0.0.1:<?>` requires Day 4's
 * reconnect + port-forward + ssh(1) spawn layer. Day 3 is purely the
 * "we can ask the codespace to start sshd and get back valid details"
 * checkpoint.
 */
async function probeSshServer(codespaceName, token) {
  ensureSshKeyPair();
  const publicKey = fs.readFileSync(SSH_PUB_PATH, 'utf8').trim();
  const props = await fetchTunnelProperties(codespaceName, token);
  const client = await connectTunnel(props, { acceptLocalConnections: true });
  try {
    const result = await startRemoteSshServer(client, publicKey);
    return {
      tunnelId: props.tunnelId,
      cluster: props.clusterId,
      domain: props.domain,
      sshServerPort: result.serverPort,
      sshUser: result.sshUser,
      sshMessage: result.message,
      publicKeyPath: SSH_PUB_PATH,
      privateKeyPath: SSH_KEY_PATH,
    };
  } finally {
    try { await client.dispose?.(); } catch {}
  }
}

module.exports = {
  fetchTunnelProperties,
  connectTunnel,
  probeTunnel,
  probeSshServer,
  ensureSshKeyPair,
  ensureProtoFile,
  startRemoteSshServer,
  CODESPACE_INTERNAL_PORT,
  SSH_KEY_PATH,
  SSH_PUB_PATH,
  PROTO_PATH,
  DEPS_DIR,
  CONFIG_DIR,
};
