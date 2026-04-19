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

const path = require('node:path');
const os = require('node:os');

const CONFIG_DIR = path.join(os.homedir(), '.shelly-cs');
const DEPS_DIR = path.join(CONFIG_DIR, 'node_modules');

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
 * @returns {Promise<Object>} connected tunnel client
 */
async function connectTunnel(props) {
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

module.exports = {
  fetchTunnelProperties,
  connectTunnel,
  probeTunnel,
  DEPS_DIR,
  CONFIG_DIR,
};
