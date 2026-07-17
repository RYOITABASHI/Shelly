#!/usr/bin/env node
/**
 * shelly-gemini-auth.js — Google OAuth Custom Tabs trampoline for Gemini
 * CLI's Google sign-in (bug #102/#115 Phase 1.2).
 *
 * Background
 * ──────────
 * Google's OAuth flow rejects Android WebView sign-in: Chromium injects an
 * `X-Requested-With: <package>` header unconditionally on every request
 * made from an embedded WebView, and `accounts.google.com` uses that
 * header to detect "embedded browser" and serve a
 * `disable_webview_sign_in` block page. This is NOT fixable by User-Agent
 * spoofing (established 2026-05-08, see docs/superpowers/DEFERRED.md bug
 * #102/#115). Anthropic and GitHub OAuth both work fine in Shelly's
 * existing in-app WebView (Browser Pane); only Google blocks it.
 *
 * The fix Google itself endorses is Chrome Custom Tabs: a real Chrome
 * process (not a WebView), so no `wv` UA token and no
 * `X-Requested-With` header. `app/_layout.tsx`'s file-queue drain loop
 * already knows how to route a URL there via
 * `WebBrowser.openBrowserAsync()` when the queued entry carries
 * `authMode: "external-browser"` — see the JSON schema documented next to
 * `drainQueue` in that file.
 *
 * What this script is — and is NOT
 * ─────────────────────────────────
 * This script's ONLY job is: notice when Gemini CLI is about to show the
 * user a Google OAuth URL, and make sure that URL reaches the file queue
 * as an `external-browser` entry so it opens in Custom Tabs instead of
 * (or in addition to) whatever Gemini CLI does on its own.
 *
 * It does **NOT**:
 *   - perform the OAuth token exchange (Shelly never has Gemini CLI's
 *     PKCE code_verifier — RFC 7636 makes the exchange fail without it;
 *     the exchange must happen inside the same process that generated
 *     the verifier, which is Gemini CLI itself)
 *   - introduce a `shelly://oauth/callback` custom scheme into Gemini
 *     CLI's flow (Gemini CLI's own redirect_uri, normally an
 *     `http://127.0.0.1:<port>/...` loopback per RFC 8252, is left
 *     completely untouched)
 *   - fall back to the in-app WebView for a Google URL under any
 *     circumstance (Google blocks that path outright — see above)
 *   - write anything to Shelly's SecureStore (`lib/secure-store.ts`).
 *     Gemini CLI reads its own credential file, not SecureStore, so
 *     storing a copy there would just be a second, unreadable-by-CLI
 *     credential no one can use.
 *
 * Relationship to shelly-xdg-open.c
 * ──────────────────────────────────
 * `HomeInitializer.kt` already exports `BROWSER=$HOME/bin/xdg-open` and
 * symlinks that name to the native `shelly_xdg_open` binary (built from
 * `modules/terminal-emulator/android/src/main/jni/shelly-xdg-open.c`).
 * That binary *also* detects `accounts.google.com` /
 * `codeassist.google.com` URLs and upgrades them to the same
 * `external-browser` JSON queue entry — so if Gemini CLI's own `open()`
 * call (the `open` npm package shells out to `xdg-open` on Linux, which
 * resolves to our shim via PATH/$BROWSER) fires correctly, the URL is
 * already routed safely before this script's stdout-scanning logic even
 * has a chance to run. This script exists for the case documented in
 * `phase-1.2/gemini-google-oauth`'s commit message: some CLI OAuth flows
 * print the verification URL to stdout as a fallback (or exclusively, in
 * headless/non-interactive environments) without ever invoking
 * `xdg-open`/`$BROWSER`. Both paths write the exact same JSON schema, so
 * whichever one fires first "wins" — this is a defense-in-depth
 * companion, not a replacement.
 *
 * Invocation
 * ──────────
 *   node shelly-gemini-auth.js [-- <gemini-login-command> [args...]]
 *
 * Defaults to `gemini auth login` if no command is given after `--` (the
 * command real Gemini CLI is expected to expose based on the Phase 1.2
 * design notes; NOT verified on-device — see the header comment in
 * docs/superpowers/DEFERRED.md bug #102/#115 and this repo's Phase 1.2
 * handoff notes). The child process's stdout/stderr are streamed straight
 * through to the terminal (tee'd, not swallowed) so the user sees exactly
 * what Gemini CLI prints, plus a queue-status line whenever a Google
 * OAuth URL is detected.
 *
 * Completion detection
 * ─────────────────────
 * Per the Phase 1.2 design (Codex review point F), Shelly must not treat
 * a Custom Tabs "opened" result as proof of login success — Custom Tabs
 * can fail to report completion/cancellation reliably back to the caller.
 * Instead this script polls `~/.gemini/credentials.json` for an mtime
 * change plus a `gemini --version` smoke invocation once a change is
 * observed (cheap sanity check that the CLI can actually read back what
 * it just wrote — a corrupt/partial credential file would still change
 * mtime but fail this check). Completion is only declared once BOTH are
 * true. This mirrors shelly-codex-auth.js's own polling-loop UX
 * (dot-per-tick progress, colored terminal messages) for consistency.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

// Mirrors shelly-xdg-open.c's is_google_auth_url() host allowlist exactly
// (accounts.google.com for the standard OAuth consent screen,
// codeassist.google.com for Gemini Code Assist's own login variant).
const GOOGLE_OAUTH_HOSTS = new Set(['accounts.google.com', 'codeassist.google.com']);

const POLL_INTERVAL_MS = 2000;
const POLL_DEADLINE_MS = 15 * 60 * 1000; // 15 min — matches shelly-codex-auth.js's device-code deadline
const GEMINI_VERSION_TIMEOUT_MS = 10000;

function geminiHome() {
  if (process.env.GEMINI_HOME) return process.env.GEMINI_HOME;
  const home = process.env.HOME;
  if (!home) return null;
  return path.join(home, '.gemini');
}

function credentialsPath() {
  const home = geminiHome();
  return home ? path.join(home, 'credentials.json') : null;
}

// ─────────────────────────────────────────────────────────────
// Pure logic (unit tested directly via require() — see
// __tests__/shelly-gemini-auth.test.ts)
// ─────────────────────────────────────────────────────────────

/**
 * Scan arbitrary CLI output text for the first http(s) URL whose host is
 * a known Google OAuth host. Returns null if none found.
 *
 * Deliberately host-based (via the URL parser), not a naive substring
 * check — a substring match on "accounts.google.com" would also fire on
 * an unrelated URL that merely mentions the string in a query param or
 * path segment (e.g. a redirect_uri echoed back in an error message).
 */
function extractGoogleOAuthUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const urlPattern = /https?:\/\/[^\s"'<>)]+/g;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    let candidate = match[0];
    // Trim common trailing punctuation that isn't part of the URL when a
    // link appears mid-sentence ("...sign in: https://accounts.google.com/o/oauth2/v2/auth?... .")
    candidate = candidate.replace(/[.,;:!?]+$/, '');
    try {
      const parsed = new URL(candidate);
      if (GOOGLE_OAUTH_HOSTS.has(parsed.host.toLowerCase())) {
        return candidate;
      }
    } catch {
      // Not a valid absolute URL (truncated match, etc.) — keep scanning.
    }
  }
  return null;
}

/**
 * Build the JSON file-queue line app/_layout.tsx's drainQueue expects for
 * an external-browser (Custom Tabs) dispatch. Schema documented next to
 * drainQueue in app/_layout.tsx and in shelly-xdg-open.c's
 * json_open_url_entry().
 */
function buildOpenUrlQueueLine(url, provider) {
  return JSON.stringify({
    type: 'open-url',
    url,
    provider: provider || 'google',
    authMode: 'external-browser',
  });
}

/**
 * Decide whether the completion poller should keep waiting, declare
 * success, or give up. Pure decision function so the polling loop itself
 * stays a thin imperative shell around this.
 *
 *   credentialsExists  — did ~/.gemini/credentials.json exist on this tick?
 *   mtimeMs            — its current mtime (ms since epoch), or null if absent
 *   baselineMtimeMs    — mtime observed BEFORE the OAuth URL was opened
 *                        (null if the file didn't exist yet at that point)
 *   versionCheckOk     — result of the `gemini --version` smoke check,
 *                        only meaningful once mtime has changed (pass null
 *                        if not yet attempted this tick)
 *   elapsedMs / deadlineMs — for timeout detection
 *
 * Returns one of: 'pending' | 'needs-smoke-check' | 'complete' | 'timeout'
 */
function decideCompletionState({
  credentialsExists,
  mtimeMs,
  baselineMtimeMs,
  versionCheckOk,
  elapsedMs,
  deadlineMs,
}) {
  const changed = credentialsExists && mtimeMs != null && mtimeMs !== baselineMtimeMs;
  if (changed) {
    if (versionCheckOk === true) return 'complete';
    if (versionCheckOk === false) {
      // File changed but the CLI can't read it back yet (e.g. we caught a
      // half-written temp-file rename mid-flight). Keep polling rather
      // than declaring failure — a subsequent tick will re-check once the
      // write settles, up to the overall deadline.
      return elapsedMs >= deadlineMs ? 'timeout' : 'pending';
    }
    return 'needs-smoke-check';
  }
  return elapsedMs >= deadlineMs ? 'timeout' : 'pending';
}

module.exports = {
  GOOGLE_OAUTH_HOSTS,
  extractGoogleOAuthUrl,
  buildOpenUrlQueueLine,
  decideCompletionState,
};

// ─────────────────────────────────────────────────────────────
// Everything below only runs when this file is executed directly (`node
// shelly-gemini-auth.js`), never on require() — keeps the pure functions
// above safely unit-testable without side effects.
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch((e) => {
    die(`unexpected error: ${(e && e.stack) || (e && e.message) || String(e)}`);
  });
}

// ─────────────────────────────────────────────────────────────
// Terminal UI helpers (mirrors shelly-codex-auth.js)
// ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};
const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `${c}${s}${C.reset}` : s);

function die(msg, code = 1) {
  process.stderr.write(paint(C.red, `✗ ${msg}\n`));
  process.exit(code);
}
function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function ok(msg) {
  process.stdout.write(paint(C.green, `✓ ${msg}\n`));
}
function warn(msg) {
  process.stderr.write(paint(C.yellow, `⚠ ${msg}\n`));
}

// ─────────────────────────────────────────────────────────────
// File-queue emission (same bridge shelly-codex-auth.js and
// shelly-xdg-open.c use — see app/_layout.tsx's drainQueue).
// ─────────────────────────────────────────────────────────────

const queuedUrls = new Set();

function enqueueExternalBrowserUrl(url) {
  if (queuedUrls.has(url)) return; // don't spam duplicate lines if the URL repeats in output
  const home = process.env.HOME;
  if (!home) {
    warn('$HOME unset — cannot queue Custom Tabs open; copy the URL above manually');
    return;
  }
  const queuePath = path.join(home, '.shelly-deep-link-queue');
  const line = buildOpenUrlQueueLine(url, 'google');
  try {
    fs.appendFileSync(queuePath, line + '\n', { mode: 0o600 });
    queuedUrls.add(url);
    info(paint(C.dim, `  → queued for Chrome Custom Tabs (Google blocks in-app WebView sign-in)`));
  } catch (e) {
    warn(`could not queue Custom Tabs open (${e.message}) — copy the URL above manually`);
  }
}

// ─────────────────────────────────────────────────────────────
// Completion poller
// ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function statMtimeMs(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, mtimeMs: null };
  }
}

/** `gemini --version` smoke check — cheap sanity that the binary can
 * actually start and read back the credential it just wrote, not just
 * that a file changed on disk. */
function geminiVersionSmokeCheck() {
  const res = spawnSync('gemini', ['--version'], {
    timeout: GEMINI_VERSION_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (res.error) return false;
  return res.status === 0;
}

/**
 * Poll ~/.gemini/credentials.json for a post-baseline mtime change,
 * confirmed by a `gemini --version` smoke check. Resolves 'complete' or
 * 'timeout'. Never rejects.
 */
async function pollForCompletion() {
  const credPath = credentialsPath();
  if (!credPath) {
    warn('$HOME/$GEMINI_HOME unset — cannot watch for credential file, skipping completion detection');
    return 'unknown';
  }
  const baseline = statMtimeMs(credPath);
  const baselineMtimeMs = baseline.exists ? baseline.mtimeMs : null;

  const start = Date.now();
  let dotCount = 0;
  process.stdout.write(paint(C.dim, '  waiting for Google sign-in to complete'));
  for (;;) {
    const elapsedMs = Date.now() - start;
    const current = statMtimeMs(credPath);
    let versionCheckOk = null;
    const changed = current.exists && current.mtimeMs !== baselineMtimeMs;
    if (changed) {
      versionCheckOk = geminiVersionSmokeCheck();
    }
    const state = decideCompletionState({
      credentialsExists: current.exists,
      mtimeMs: current.mtimeMs,
      baselineMtimeMs,
      versionCheckOk,
      elapsedMs,
      deadlineMs: POLL_DEADLINE_MS,
    });
    if (state === 'complete') {
      if (tty && dotCount > 0) process.stdout.write('\n');
      return 'complete';
    }
    if (state === 'timeout') {
      if (tty && dotCount > 0) process.stdout.write('\n');
      return 'timeout';
    }
    if (tty) {
      process.stdout.write(paint(C.dim, '.'));
      dotCount++;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─────────────────────────────────────────────────────────────
// Child process: run the real Gemini CLI login flow, tee its output,
// and scan for a Google OAuth URL to fast-path into the queue (in case
// shelly-xdg-open.c's own detection, triggered by Gemini CLI's `open()`
// call, doesn't fire — e.g. a headless/non-TTY invocation that only
// prints the URL as text).
// ─────────────────────────────────────────────────────────────

function runGeminiLogin(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    // Rolling buffer per stream so a URL split across two stdout chunks
    // (rare but possible with fast interleaved writes) still matches; capped
    // so a long-running interactive session doesn't grow this unbounded.
    let stdoutBuf = '';
    let stderrBuf = '';
    const MAX_BUF = 4096;

    const handleChunk = (chunk, bufRef, mirror) => {
      const text = chunk.toString('utf8');
      mirror.write(chunk);
      let combined = bufRef.value + text;
      const url = extractGoogleOAuthUrl(combined);
      if (url) enqueueExternalBrowserUrl(url);
      if (combined.length > MAX_BUF) combined = combined.slice(-MAX_BUF);
      bufRef.value = combined;
    };

    const stdoutRef = { value: stdoutBuf };
    const stderrRef = { value: stderrBuf };
    child.stdout.on('data', (chunk) => handleChunk(chunk, stdoutRef, process.stdout));
    child.stderr.on('data', (chunk) => handleChunk(chunk, stderrRef, process.stderr));
    child.on('error', (e) => {
      warn(`could not start "${cmd} ${args.join(' ')}": ${e.message}`);
      resolve({ exitCode: null, spawnError: e });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, spawnError: null });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const dashIdx = process.argv.indexOf('--');
  const trailing = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
  // `gemini auth login` is the command name assumed by the Phase 1.2
  // design notes (docs/superpowers/DEFERRED.md bug #102/#115,
  // phase-1.2/gemini-google-oauth branch history). NOT verified against a
  // real Gemini CLI build on-device — override with `-- <cmd> [args...]`
  // if the actual subcommand differs.
  const cmd = trailing[0] || 'gemini';
  const args = trailing.length > 0 ? trailing.slice(1) : ['auth', 'login'];

  info(paint(C.cyan, '━'.repeat(60)));
  info(paint(C.bold, '  Gemini CLI — Google sign-in (Custom Tabs trampoline)'));
  info(paint(C.cyan, '━'.repeat(60)));
  info('');
  info(paint(C.dim, `• running: ${cmd} ${args.join(' ')}`));
  info('');

  const pollPromise = pollForCompletion();
  const childPromise = runGeminiLogin(cmd, args);

  const childResult = await childPromise;

  if (childResult.spawnError) {
    die(
      `could not launch "${cmd}" — is Gemini CLI installed? ` +
        `(${childResult.spawnError.message})`,
    );
  }

  // Give the poller a short grace window after the child exits: the
  // credential write can lag slightly behind the child process reporting
  // success (fsync + rename), and we'd rather wait a few more ticks than
  // trust a browser/process exit signal on its own (Codex design review
  // point F: don't rely solely on process/browser completion signals).
  const GRACE_MS = 10000;
  let pollResult = await Promise.race([pollPromise, sleep(GRACE_MS).then(() => 'grace-expired')]);
  if (pollResult === 'grace-expired') {
    pollResult = await pollPromise;
  }

  info('');
  if (pollResult === 'complete') {
    ok('Gemini sign-in successful');
    const credPath = credentialsPath();
    if (credPath) info(paint(C.dim, `  credentials confirmed at ${credPath}`));
    info('');
    info('  Try it:');
    info(`    ${paint(C.bold, 'gemini "hello"')}`);
    info('');
    process.exit(0);
  } else if (pollResult === 'timeout') {
    if (childResult.exitCode === 0) {
      warn(
        'gemini exited successfully but credentials.json was not observed to update within 15 min — ' +
          'sign-in may still be pending in the browser, or Gemini CLI stores credentials elsewhere on this build.',
      );
      process.exit(0);
    }
    die('Google sign-in timed out (15 min). Run again to retry.');
  } else {
    // 'unknown' — $HOME wasn't set, so we couldn't watch the credential
    // file at all. Fall back to the child's own exit code as the only
    // signal we have.
    if (childResult.exitCode === 0) {
      ok('gemini exited successfully (credential file watch unavailable — could not verify)');
      process.exit(0);
    }
    die(`gemini exited with code ${childResult.exitCode}`);
  }
}
