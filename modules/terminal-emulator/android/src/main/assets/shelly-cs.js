#!/usr/bin/env node
// shelly-cs: GitHub Codespaces CLI for Shelly (Android standalone).
//
// Pure Node.js implementation. No external dependencies, no gh CLI.
// All GitHub operations go through the REST API directly using Shelly's
// bundled bionic node. Token is stored in $HOME/.shelly-cs/token (0600).
//
// Phase 1 minimum commands: auth, list, create, open, doctor.
// `ssh` is a placeholder; proper SSH tunneling lands in Phase 1.5.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
//
// All defaults are env-var overridable for dev/staging builds or for
// users running a fork.
//
//   SHELLY_OAUTH_CLIENT_ID   → override the Shelly production OAuth App
//   SHELLY_CS_DEFAULT_REPO   → override the default Codespace template repo
//   SHELLY_CS_SCOPE          → override the OAuth scope string
//   SHELLY_CS_DEBUG          → set any truthy value to print stack traces
//

// Production Shelly OAuth App (public client ID — safe to embed).
const DEFAULT_CLIENT_ID = 'Ov23liLDXUTGYlzzhlLG';
const CLIENT_ID = process.env.SHELLY_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;

// Default template repo used when `shelly-cs create` is called without
// --repo. The template ships a devcontainer.json that installs Node 20
// and @anthropic-ai/claude-code via postCreateCommand, so the created
// codespace has claude-code ready in its web terminal immediately.
const DEFAULT_TEMPLATE_REPO = process.env.SHELLY_CS_DEFAULT_REPO || 'RYOITABASHI/shelly-codespace-template';

// OAuth scope for device flow. codespace=CRUD, repo=template/work repo
// access (needed to resolve repository_id), read:user=display "Authenticated
// as {login}" in the doctor output. Can be tightened to just `codespace repo`
// at the cost of losing the user info in doctor.
const DEVICE_FLOW_SCOPE = process.env.SHELLY_CS_SCOPE || 'codespace repo read:user';

const CONFIG_DIR = path.join(os.homedir(), '.shelly-cs');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const API_VERSION = '2022-11-28';
const USER_AGENT = 'shelly-cs/0.1 (+https://github.com/RYOITABASHI/Shelly)';

// ANSI colors (writable to stderr/stdout regardless of TTY)
const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  green: '\u001b[1;32m',
  yellow: '\u001b[1;33m',
  red: '\u001b[1;31m',
  gray: '\u001b[1;30m',
  cyan: '\u001b[1;36m',
};

// ─────────────────────────────────────────────────────────────
// Token storage (simple file; Phase 1.5 will bridge SecureStore)
// ─────────────────────────────────────────────────────────────

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function saveToken(token) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function deleteToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Config (default codespace, etc.)
// ─────────────────────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function resolveCodespaceName(explicit) {
  // Priority:
  //   1. explicit --repo-name / positional arg (pass-through)
  //   2. config.defaultCodespace (set via `shelly-cs use <name>`)
  //   3. the only Available/Shutdown codespace (if exactly one exists)
  //   4. throw with a helpful hint
  if (explicit) return { name: explicit, source: 'explicit' };
  const config = readConfig();
  if (config.defaultCodespace) return { name: config.defaultCodespace, source: 'default' };
  const { codespaces = [] } = await ghApi('/user/codespaces');
  const candidates = codespaces.filter(c => c.state === 'Available' || c.state === 'Shutdown');
  if (candidates.length === 1) return { name: candidates[0].name, source: 'only' };
  if (candidates.length === 0) {
    throw new Error('No codespaces. Run: shelly-cs create');
  }
  const list = candidates.map(c => `    ${c.name}  (${c.state})`).join('\n');
  throw new Error(
    `Multiple codespaces exist. Pick one:\n${list}\n\n` +
    `  shelly-cs use <name>    set as default\n` +
    `  shelly-cs open <name>   one-off open`
  );
}

// ─────────────────────────────────────────────────────────────
// HTTP helpers (native fetch — Node 18+)
// ─────────────────────────────────────────────────────────────

async function ghApi(apiPath, opts = {}) {
  const token = readToken();
  if (!token) {
    throw new Error(`Not authenticated. Run: ${C.cyan}shelly-cs auth${C.reset}`);
  }
  const url = 'https://api.github.com' + apiPath;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    let msg;
    try { msg = JSON.parse(text).message || text; } catch { msg = text; }
    if (res.status === 401) {
      deleteToken();
      throw new Error(`Auth expired or invalid (${res.status}). Run: ${C.cyan}shelly-cs auth${C.reset}`);
    }
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// ─────────────────────────────────────────────────────────────
// Android helpers (clipboard + browser)
// ─────────────────────────────────────────────────────────────

function openUrl(url) {
  // Preferred: in-app Browser Pane via the `shelly://browser?url=...` deep
  // link. app/_layout.tsx registers a Linking listener that routes matching
  // hosts into useBrowserStore.openUrl() + useMultiPaneStore.addPane('browser'),
  // so the URL lands in Shelly's WebView instead of kicking to Chrome.
  //
  // We fire the deep link first and accept it will launch Shelly (the
  // intent target is Shelly itself via the scheme registration in
  // android/app/src/main/AndroidManifest.xml). If the deep-link intent
  // fails for any reason — scheme not registered on this build, Shelly
  // foregrounded by another activity that swallows the VIEW — fall back
  // to the raw URL so users still reach the destination.
  const deepLink = `shelly://browser?url=${encodeURIComponent(url)}`;
  try {
    const r = spawnSync('am', ['start', '-a', 'android.intent.action.VIEW', '-d', deepLink], { stdio: 'ignore' });
    if (r && r.status === 0) return;
  } catch {
    // fall through to external
  }
  try {
    spawnSync('am', ['start', '-a', 'android.intent.action.VIEW', '-d', url], { stdio: 'ignore' });
  } catch {
    // Silent fallback — the URL is printed anyway.
  }
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

async function cmdAuth() {
  // OAuth 2.0 Device Authorization Grant (RFC 8628) for GitHub OAuth App.
  const params = new URLSearchParams({ client_id: CLIENT_ID, scope: DEVICE_FLOW_SCOPE });
  const r1 = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: params.toString()
  });
  if (!r1.ok) {
    throw new Error(`Device code request failed: ${r1.status} ${r1.statusText}`);
  }
  const d = await r1.json();

  const line = '─'.repeat(48);
  console.log('');
  console.log(`  ┌${line}┐`);
  console.log(`  │  ${C.bold}GitHub Authorization${C.reset}`.padEnd(62, ' ') + '│');
  console.log(`  │  Code: ${C.green}${d.user_code}${C.reset}`.padEnd(62, ' ') + '│');
  console.log(`  │  URL:  ${d.verification_uri}`.padEnd(51, ' ') + '│');
  console.log(`  └${line}┘`);
  console.log('');
  console.log(`  ${C.gray}Opening ${d.verification_uri} in browser…${C.reset}`);
  openUrl(d.verification_uri);
  console.log(`  ${C.gray}Enter the code above, authorize, then come back here.${C.reset}`);
  console.log('');
  process.stdout.write('  Waiting for authorization');

  const deadline = Date.now() + d.expires_in * 1000;
  let intervalSec = d.interval;
  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000);
    process.stdout.write('.');
    const r2 = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }).toString()
    });
    const t = await r2.json();
    if (t.access_token) {
      saveToken(t.access_token);
      const user = await ghApi('/user');
      console.log('');
      console.log('');
      console.log(`  ${C.green}✓${C.reset} Authenticated as ${C.bold}${user.login}${C.reset}`);
      console.log(`  ${C.gray}Token saved to ${TOKEN_FILE}${C.reset}`);
      console.log('');
      return;
    }
    if (t.error === 'authorization_pending') continue;
    if (t.error === 'slow_down') { intervalSec += 5; continue; }
    if (t.error === 'expired_token') throw new Error('Device code expired — run `shelly-cs auth` again');
    if (t.error === 'access_denied') throw new Error('Authorization denied by user');
    throw new Error(`OAuth error: ${t.error_description || t.error}`);
  }
  throw new Error('Authorization timed out after 15 minutes');
}

async function cmdList() {
  const r = await ghApi('/user/codespaces');
  const codespaces = r.codespaces || [];
  if (!codespaces.length) {
    console.log(`  ${C.gray}(no codespaces — run \`shelly-cs create\`)${C.reset}`);
    return;
  }
  const defaultName = readConfig().defaultCodespace;
  console.log('');
  for (const cs of codespaces) {
    const icon = {
      Available: C.green + '●' + C.reset,
      Shutdown:  C.gray  + '○' + C.reset,
      Starting:  C.yellow + '⏳' + C.reset,
      Created:   C.yellow + '⏳' + C.reset,
      Queued:    C.yellow + '⋯' + C.reset,
      Failed:    C.red    + '✗' + C.reset,
    }[cs.state] || '?';
    const repo = cs.repository?.full_name || '(unknown)';
    const machine = cs.machine?.display_name || cs.machine?.name || 'unknown';
    const lastUsed = cs.last_used_at ? new Date(cs.last_used_at).toISOString().slice(0, 16).replace('T', ' ') : '—';
    const star = (cs.name === defaultName) ? ` ${C.yellow}★ default${C.reset}` : '';
    console.log(`  ${icon}  ${C.bold}${cs.name}${C.reset}  ${C.gray}(${cs.state})${C.reset}${star}`);
    console.log(`      ${repo}  ·  ${machine}`);
    console.log(`      last used: ${lastUsed}`);
    console.log('');
  }
  if (!defaultName && codespaces.length > 1) {
    console.log(`  ${C.gray}Hint: \`shelly-cs use <name>\` to set a default. Then \`cs\` is enough.${C.reset}`);
    console.log('');
  }
}

async function cmdCreate(args) {
  // Default to the Shelly template repo when --repo is omitted. The
  // template has a devcontainer.json that pre-installs claude-code, so
  // `shelly-cs create` with no args gets a ready-to-code environment.
  const repo = args['--repo'] || DEFAULT_TEMPLATE_REPO;
  if (!repo.includes('/')) {
    throw new Error('Usage: shelly-cs create [--repo <owner/repo>] [--machine basicLinux32gb]');
  }
  const machine = args['--machine'] || 'basicLinux32gb';

  const isDefaultTemplate = repo === DEFAULT_TEMPLATE_REPO && !args['--repo'];
  if (isDefaultTemplate) {
    console.log(`  ${C.gray}Using default Shelly template: ${repo}${C.reset}`);
    console.log(`  ${C.gray}Override with --repo <owner/repo>${C.reset}`);
    console.log('');
  }

  process.stdout.write(`  Looking up ${repo}… `);
  const r = await ghApi(`/repos/${repo}`);
  console.log(C.green + '✓' + C.reset);

  console.log(`  Creating codespace (${C.bold}${machine}${C.reset})…`);
  const cs = await ghApi('/user/codespaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository_id: r.id,
      machine
    })
  });

  const startTime = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000;
  let lastState = '';
  while (true) {
    const current = await ghApi(`/user/codespaces/${cs.name}`);
    if (current.state !== lastState) {
      // Clear previous line and redraw
      process.stdout.write(`\r  ${cs.name}: ${current.state}` + ' '.repeat(20));
      lastState = current.state;
    }
    if (current.state === 'Available') {
      console.log(`\n  ${C.green}✓${C.reset} Ready: ${C.bold}${cs.name}${C.reset}`);
      console.log(`    ${C.gray}web: ${current.web_url}${C.reset}`);
      console.log('');
      console.log(`  Next: ${C.cyan}shelly-cs open ${cs.name}${C.reset}`);
      return;
    }
    if (current.state === 'Failed' || current.state === 'Unknown') {
      throw new Error(`Codespace creation failed (state: ${current.state})`);
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Codespace creation timed out (10 min)');
    }
    await sleep(5000);
  }
}

async function cmdOpen(args) {
  const resolved = await resolveCodespaceName(args._[0]);
  const name = resolved.name;
  if (resolved.source !== 'explicit') {
    console.log(`  ${C.gray}(using ${resolved.source === 'default' ? 'default' : 'only'}: ${name})${C.reset}`);
  }

  let cs = await ghApi(`/user/codespaces/${name}`);
  if (cs.state !== 'Available') {
    console.log(`  Starting ${cs.name} (current state: ${cs.state})…`);
    await ghApi(`/user/codespaces/${name}/start`, { method: 'POST' });
    const startTime = Date.now();
    while (true) {
      await sleep(5000);
      cs = await ghApi(`/user/codespaces/${name}`);
      process.stdout.write(`\r  ${cs.name}: ${cs.state}` + ' '.repeat(20));
      if (cs.state === 'Available') break;
      if (cs.state === 'Failed') throw new Error('Codespace failed to start');
      if (Date.now() - startTime > 5 * 60 * 1000) throw new Error('Start timeout (5 min)');
    }
    console.log('');
  }
  console.log(`  ${C.green}✓${C.reset} ${cs.name} is running`);
  console.log(`  Opening ${cs.web_url}…`);
  openUrl(cs.web_url);
}

async function cmdUse(args) {
  const name = args._[0];
  if (!name) {
    const config = readConfig();
    if (config.defaultCodespace) {
      console.log(`  Default codespace: ${C.bold}${config.defaultCodespace}${C.reset}`);
      console.log(`  ${C.gray}Change: shelly-cs use <name>${C.reset}`);
      console.log(`  ${C.gray}Clear:  shelly-cs use --clear${C.reset}`);
    } else {
      console.log(`  ${C.gray}No default codespace set.${C.reset}`);
      console.log(`  ${C.gray}Set one with: shelly-cs use <name>${C.reset}`);
    }
    return;
  }
  if (args['--clear']) {
    const config = readConfig();
    delete config.defaultCodespace;
    writeConfig(config);
    console.log(`  ${C.green}✓${C.reset} Default codespace cleared`);
    return;
  }
  // Verify the codespace exists (throws 404 if not)
  await ghApi(`/user/codespaces/${name}`);
  const config = readConfig();
  config.defaultCodespace = name;
  writeConfig(config);
  console.log(`  ${C.green}✓${C.reset} Default codespace: ${C.bold}${name}${C.reset}`);
  console.log(`  ${C.gray}Next: \`shelly-cs open\` (no args) opens it. \`cs\` also works.${C.reset}`);
}

async function cmdStop(args) {
  const name = args._[0];
  if (!name) throw new Error('Usage: shelly-cs stop <codespace-name>');
  console.log(`  Stopping ${name}…`);
  await ghApi(`/user/codespaces/${name}/stop`, { method: 'POST' });
  console.log(`  ${C.green}✓${C.reset} ${name} stopped (billing paused)`);
}

async function cmdDelete(args) {
  const name = args._[0];
  if (!name) throw new Error('Usage: shelly-cs delete <codespace-name>');
  if (!args['--yes']) {
    throw new Error(`Refusing to delete without --yes flag. Run: shelly-cs delete ${name} --yes`);
  }
  console.log(`  Deleting ${name}…`);
  await ghApi(`/user/codespaces/${name}`, { method: 'DELETE' });
  console.log(`  ${C.green}✓${C.reset} ${name} deleted`);
}

async function cmdSSH() {
  // Phase 1.5: implement SSH tunneling via GitHub's connection infrastructure.
  // Options under evaluation:
  //   1. Port gh CLI's tunnel client logic (WebSocket + JSON-RPC).
  //   2. Enable SSH Server feature in the codespace + public key auth.
  //   3. Use Codespace's forwarded ports API with a local proxy.
  console.log(`  ${C.yellow}ssh is Phase 1.5 — use${C.reset} ${C.cyan}shelly-cs open <name>${C.reset} ${C.yellow}for now.${C.reset}`);
  console.log(`  ${C.gray}(Opens the codespace's web terminal in the browser.)${C.reset}`);
}

async function cmdDoctor() {
  console.log('');
  console.log(`  ${C.bold}shelly-cs doctor${C.reset}`);
  console.log('  ' + '─'.repeat(48));
  const cfg = readConfig();
  console.log(`    Client ID:      ${CLIENT_ID.slice(0, 10)}…${CLIENT_ID.slice(-4)}${CLIENT_ID === DEFAULT_CLIENT_ID ? C.gray + ' (default)' + C.reset : C.yellow + ' (overridden)' + C.reset}`);
  console.log(`    Template repo:  ${DEFAULT_TEMPLATE_REPO}`);
  console.log(`    Scope:          ${DEVICE_FLOW_SCOPE}`);
  console.log(`    Config dir:     ${CONFIG_DIR}`);
  console.log(`    Token:          ${readToken() ? C.green + '✓ present' + C.reset : C.red + '✗ missing' + C.reset + C.gray + ' (run `shelly-cs auth`)' + C.reset}`);
  console.log(`    Default CS:     ${cfg.defaultCodespace ? C.bold + cfg.defaultCodespace + C.reset : C.gray + '(unset — \`shelly-cs use <name>\`)' + C.reset}`);
  try {
    const user = await ghApi('/user');
    console.log(`    Authenticated:  ${C.green}✓${C.reset} ${user.login}  ${C.gray}(${user.email || 'email hidden'})${C.reset}`);
  } catch (e) {
    console.log(`    Authenticated:  ${C.red}✗${C.reset} ${C.gray}${e.message}${C.reset}`);
  }
  console.log(`    Node:           ${process.version}`);
  console.log(`    Platform:       ${process.platform} ${process.arch}`);
  console.log(`    Script:         ${__filename}`);
  console.log('');
}

async function cmdLogout() {
  deleteToken();
  console.log(`  ${C.green}✓${C.reset} Logged out`);
}

// ─────────────────────────────────────────────────────────────
// Argument parser + dispatch
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key, val;
      if (a.includes('=')) {
        [key, val] = a.split(/=(.*)/).slice(0, 2);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        key = a; val = argv[++i];
      } else {
        key = a; val = true;
      }
      result[key] = val;
    } else {
      result._.push(a);
    }
  }
  return result;
}

function usage() {
  console.error(`${C.bold}shelly-cs${C.reset} — GitHub Codespaces CLI for Shelly`);
  console.error('');
  console.error('Quick start:');
  console.error(`  ${C.cyan}shelly-cs auth${C.reset}                 sign in with GitHub`);
  console.error(`  ${C.cyan}shelly-cs create${C.reset}               make a codespace (default template)`);
  console.error(`  ${C.cyan}shelly-cs use <name>${C.reset}           remember it as your default`);
  console.error(`  ${C.cyan}cs${C.reset}                             open default in Browser Pane (then claude ready)`);
  console.error('');
  console.error('Commands:');
  console.error(`  ${C.cyan}auth${C.reset}                                      OAuth device-flow sign-in`);
  console.error(`  ${C.cyan}list${C.reset}                                      List your codespaces (★ marks default)`);
  console.error(`  ${C.cyan}create${C.reset} [--repo <owner/repo>] [--machine X]  Create a codespace`);
  console.error(`                                            ${C.gray}(default: ${DEFAULT_TEMPLATE_REPO})${C.reset}`);
  console.error(`  ${C.cyan}use${C.reset} <name> | --clear                      Set or clear default codespace`);
  console.error(`  ${C.cyan}open${C.reset} [name]                               Open codespace web URL in Browser Pane`);
  console.error(`                                            ${C.gray}(no arg → default / only running)${C.reset}`);
  console.error(`  ${C.cyan}stop${C.reset} <name>                               Stop codespace (pauses billing)`);
  console.error(`  ${C.cyan}delete${C.reset} <name> --yes                       Delete codespace (requires --yes)`);
  console.error(`  ${C.cyan}ssh${C.reset} <name>                                SSH to codespace (Phase 1.5)`);
  console.error(`  ${C.cyan}doctor${C.reset}                                    Diagnose configuration issues`);
  console.error(`  ${C.cyan}logout${C.reset}                                    Clear saved credentials`);
  console.error('');
  console.error('Env overrides:');
  console.error('  SHELLY_OAUTH_CLIENT_ID   OAuth App Client ID (default: production Shelly)');
  console.error('  SHELLY_CS_DEFAULT_REPO   Default template repo (default: RYOITABASHI/shelly-codespace-template)');
  console.error('  SHELLY_CS_SCOPE          OAuth scope (default: codespace repo read:user)');
  console.error('  SHELLY_CS_DEBUG          Set any truthy value for stack traces');
  process.exit(1);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const commands = {
    auth: cmdAuth,
    list: cmdList,
    ls: cmdList,
    create: cmdCreate,
    'new': cmdCreate,
    use: cmdUse,
    open: cmdOpen,
    stop: cmdStop,
    'delete': cmdDelete,
    rm: cmdDelete,
    ssh: cmdSSH,
    doctor: cmdDoctor,
    logout: cmdLogout,
    help: () => usage(),
  };
  // No args → if authenticated, fall through to `open` with smart
  // defaults (makes `cs` a zero-arg one-shot to your codespace).
  // If not authenticated, show usage so newcomers discover `auth`.
  let effectiveCmd = cmd;
  let effectiveArgs = args;
  if (!cmd) {
    if (readToken()) {
      effectiveCmd = 'open';
      effectiveArgs = { _: [] };
    } else {
      usage();
    }
  } else if (!commands[cmd]) {
    usage();
  }
  try {
    await commands[effectiveCmd](effectiveArgs);
  } catch (e) {
    console.error('');
    console.error(`  ${C.red}✗${C.reset} ${e.message}`);
    if (process.env.SHELLY_CS_DEBUG) console.error(e.stack);
    process.exit(1);
  }
})();
