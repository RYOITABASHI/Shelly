#!/usr/bin/env node
/**
 * shelly-codex-auth.js — ChatGPT subscription device-auth for Codex CLI.
 *
 * Background
 * ──────────
 * The upstream openai/codex CLI ships a `codex login --device-auth`
 * subcommand (codex-rs/login/src/device_code_auth.rs) that logs the user
 * in with their ChatGPT Plus/Pro/Team/Enterprise subscription and writes
 * `~/.codex/auth.json`. Shelly bundles codex-termux, a community rebuild
 * that has the `login` subcommand compiled out. This script implements
 * the exact same HTTP flow in pure JavaScript so that bundled bionic
 * node can drive it without any native dependency.
 *
 * After running this script, `codex "<prompt>"` picks up the auth.json
 * and runs under the user's ChatGPT subscription — no OpenAI API key,
 * no paid API usage, matching the user's policy (no paid APIs except
 * Perplexity).
 *
 * Flow (three HTTP calls against https://auth.openai.com):
 *   1. POST /api/accounts/deviceauth/usercode  — get device_auth_id + user_code + interval
 *   2. POLL /api/accounts/deviceauth/token      — 403/404 while pending, 200 when user authorises
 *   3. POST /oauth/token                        — form-encoded exchange for final JWT tokens
 *
 * auth.json schema (written with mode 0o600):
 *   {
 *     "OPENAI_API_KEY": null,
 *     "tokens": { "id_token", "access_token", "refresh_token", "account_id" },
 *     "last_refresh": "<ISO-8601 UTC>",
 *     "auth_mode": "chatgpt"
 *   }
 *
 * Reference: https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs
 *
 * Invocation
 * ──────────
 *   node shelly-codex-auth.js [--open]
 *
 * With `--open`, the verification URL is handed to the Shelly Browser
 * Pane via the `shelly://browser?url=...` deep link so the user doesn't
 * have to switch apps. Default behaviour prints the URL and code to
 * stdout and waits.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

// These constants are cloned verbatim from codex-rs/login/src/auth/mod.rs
// (CLIENT_ID) and codex-rs/login/src/server.rs (DEFAULT_ISSUER). OpenAI's
// public OAuth client for the Codex CLI.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const VERIFY_URL_BASE = `${ISSUER}/codex/device`;
const POLL_DEADLINE_MS = 15 * 60 * 1000; // 15 min, matches upstream

const openBrowser = process.argv.includes('--open');

// ─────────────────────────────────────────────────────────────
// Terminal UI helpers
// ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  cyan:  '\x1b[36m',
};
const tty = process.stdout.isTTY;
const paint = (c, s) => tty ? `${c}${s}${C.reset}` : s;

function die(msg, code = 1) {
  process.stderr.write(paint(C.red, `✗ ${msg}\n`));
  process.exit(code);
}

function info(msg) { process.stdout.write(`${msg}\n`); }
function ok(msg)   { process.stdout.write(paint(C.green, `✓ ${msg}\n`)); }

// ─────────────────────────────────────────────────────────────
// HTTP primitives — Node's native fetch (Node 18+). We rely on
// NODE_EXTRA_CA_CERTS exported by .bashrc to augment the otherwise
// empty TLS root set on bionic node (v39).
// ─────────────────────────────────────────────────────────────

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

// ─────────────────────────────────────────────────────────────
// Step 1 — request usercode
// ─────────────────────────────────────────────────────────────

async function requestUserCode() {
  const r = await postJson(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    client_id: CLIENT_ID,
  });
  if (!r.ok || !r.json) {
    die(`usercode request failed (${r.status}): ${r.text || '<empty>'}`);
  }
  const j = r.json;
  if (!j.device_auth_id || !j.user_code) {
    die(`usercode response missing fields: ${r.text}`);
  }
  return {
    device_auth_id: j.device_auth_id,
    user_code: j.user_code,
    // server returns interval as a string; codex parses as u64
    interval: Number(j.interval) || 5,
  };
}

// ─────────────────────────────────────────────────────────────
// Step 2 — poll for authorization code. Upstream returns 403/404 while
// the user is still completing the browser flow; anything else is a
// hard failure.
// ─────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollForCode(device_auth_id, user_code, interval) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let dotCount = 0;
  while (Date.now() < deadline) {
    const r = await postJson(`${ISSUER}/api/accounts/deviceauth/token`, {
      device_auth_id, user_code,
    });
    if (r.ok && r.json && r.json.authorization_code) {
      if (tty && dotCount > 0) process.stdout.write('\n');
      return r.json;
    }
    if (r.status !== 403 && r.status !== 404) {
      die(`poll failed (${r.status}): ${r.text || '<empty>'}`);
    }
    if (tty) { process.stdout.write(paint(C.dim, '.')); dotCount++; }
    await sleep(interval * 1000);
  }
  die('device authorization timed out (15 min). Run again to retry.');
}

// ─────────────────────────────────────────────────────────────
// Step 3 — exchange for final tokens. This is a standard OAuth
// authorization_code grant, form-encoded per RFC 6749.
// ─────────────────────────────────────────────────────────────

async function exchangeTokens(codeResp) {
  const r = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: 'authorization_code',
    code: codeResp.authorization_code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    // PKCE verifier is supplied BY THE SERVER in step 2 (unusual but
    // this is how codex-rs does it — the server pre-picks the challenge
    // pair so the device never has to transmit the verifier over an
    // insecure channel).
    code_verifier: codeResp.code_verifier,
  });
  if (!r.ok || !r.json) {
    die(`token exchange failed (${r.status}): ${r.text || '<empty>'}`);
  }
  if (!r.json.access_token || !r.json.id_token) {
    die(`token response missing fields: ${r.text}`);
  }
  return r.json;
}

// ─────────────────────────────────────────────────────────────
// JWT claim extraction. The id_token's middle segment is base64url
// JSON and contains the ChatGPT account id under a namespaced claim.
// codex rehydrates this on every load; we pre-extract once and cache
// so refresh cycles don't have to re-parse.
// ─────────────────────────────────────────────────────────────

function extractAccountId(idToken) {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    // Node 16+ supports 'base64url' buffer encoding
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'];
    return auth?.chatgpt_account_id ?? null;
  } catch (e) {
    process.stderr.write(paint(C.yellow,
      `⚠ could not parse id_token for account_id: ${e.message}\n`));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Write ~/.codex/auth.json with 0o600. Mirrors AuthDotJson in
// codex-rs/login/src/auth/storage.rs exactly.
// ─────────────────────────────────────────────────────────────

function saveAuth(tok) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const authPath = path.join(codexHome, 'auth.json');
  const account_id = extractAccountId(tok.id_token);
  const body = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      account_id,
    },
    last_refresh: new Date().toISOString(),
    auth_mode: 'chatgpt',
  };
  fs.writeFileSync(authPath, JSON.stringify(body, null, 2), { mode: 0o600 });
  return { authPath, account_id };
}

// ─────────────────────────────────────────────────────────────
// Optional deep-link open — mirrors the shelly-cs.js pattern.
// Shelly's app/_layout.tsx handles `shelly://browser?url=...` by
// opening the Browser Pane with that URL loaded. If the deep link
// handler isn't present (e.g. script run from vanilla Termux for
// testing), falls through and shows the URL on stdout anyway.
// ─────────────────────────────────────────────────────────────

function openViaDeepLink(url) {
  // am start -a android.intent.action.VIEW -d "shelly://browser?url=<encoded>"
  // We use exec so this works whether or not `am` is shelly-wrapped;
  // any failure is non-fatal because the URL is also printed.
  const deepLink = `shelly://browser?url=${encodeURIComponent(url)}`;
  const cmd = `am start -a android.intent.action.VIEW -d "${deepLink}"`;
  exec(cmd, { timeout: 3000 }, () => { /* best-effort */ });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  info(paint(C.cyan, '━'.repeat(60)));
  info(paint(C.bold, '  Codex ChatGPT subscription login (device auth)'));
  info(paint(C.cyan, '━'.repeat(60)));
  info('');

  info(paint(C.dim, '• requesting device code...'));
  const uc = await requestUserCode();

  info('');
  info(`  1. Open this URL in your browser:`);
  info('');
  info(`     ${paint(C.blue, VERIFY_URL_BASE)}`);
  info('');
  info(`  2. Enter this code:`);
  info('');
  info(`     ${paint(C.bold + C.green, uc.user_code)}`);
  info('');
  info(paint(C.dim, `  (code expires in 15 minutes. polling every ${uc.interval}s)`));
  info('');

  if (openBrowser) {
    openViaDeepLink(VERIFY_URL_BASE);
    info(paint(C.dim, '  → opened Shelly Browser Pane'));
    info('');
  }

  process.stdout.write(paint(C.dim, '  waiting'));
  const codeResp = await pollForCode(uc.device_auth_id, uc.user_code, uc.interval);

  info(paint(C.dim, '• exchanging authorization code...'));
  const tok = await exchangeTokens(codeResp);

  info(paint(C.dim, '• writing ~/.codex/auth.json...'));
  const { authPath, account_id } = saveAuth(tok);

  info('');
  ok(`codex login successful`);
  info(paint(C.dim, `  wrote ${authPath} (mode 0600)`));
  if (account_id) {
    info(paint(C.dim, `  ChatGPT account: ${account_id}`));
  }
  info('');
  info(`  Try it:`);
  info(`    ${paint(C.bold, 'codex "hello"')}`);
  info('');
}

main().catch(e => {
  die(`unexpected error: ${e?.stack || e?.message || String(e)}`);
});
