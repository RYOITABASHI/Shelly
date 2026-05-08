#!/usr/bin/env node
/**
 * shelly-xdg-open.js — route URL opens to Shelly's in-app Browser Pane
 * via the shelly://browser deep link handler in app/_layout.tsx.
 *
 * Background
 * ──────────
 * Bionic Android has no native xdg-open. Linux/Android desktop CLIs
 * default to spawning xdg-open or honoring $BROWSER, so any tool that
 * tries to "open this URL in the user's browser" silently fails with
 * ENOENT. Two concrete victims:
 *
 *   - Claude Code's `/login` calls i3() → spawn(BROWSER ?? "xdg-open",
 *     [url]) and ignores the return code (cli.js ~ offset 6880697).
 *     Without this shim the user only sees "Browser didn't open?
 *     Use the url below to sign in" after a 3 s timeout and has to
 *     copy-paste manually into an external browser, which is what
 *     produces the README #102 "OAuth error: status code 400" trap
 *     (redirect_uri mismatch on token exchange).
 *
 *   - Gemini CLI's authWithWeb() spawns xdg-open via google-auth-
 *     library; same ENOENT, same workaround required.
 *
 * With this shim, the auth URL opens directly in Shelly's Browser
 * Pane. The user signs in without leaving the app, then pastes the
 * `code#state` token shown by Anthropic / Google's success page back
 * into the CLI's manual paste UI. This completes the loopback OAuth
 * dance without ever leaving the manual-redirect_uri code path
 * (matching what the CLI sends on token exchange — no mismatch).
 *
 * Reference: HomeInitializer.kt creates `$HOME/bin/xdg-open` as a
 * sh wrapper that exec's this script via the bundled bionic node.
 *
 * Invocation
 * ──────────
 *   xdg-open <url>     (http or https only)
 *
 * The bundled CLIs that invoke us ignore the exit code, but we still
 * exit 1 on validation errors so tools that DO check (e.g. wsl-open,
 * desktop launchers) see a sensible failure mode.
 */

'use strict';

const { exec } = require('child_process');

const url = process.argv[2];
if (!url) {
  process.stderr.write('xdg-open: missing URL argument\n');
  process.exit(1);
}
if (!/^https?:\/\//i.test(url)) {
  // Android intent firing for arbitrary schemes is a privilege-
  // escalation hazard — file://, content://, intent:// can all be
  // weaponised. Restrict to http/https; the cli use cases we care
  // about (OAuth flows) are 100 % http(s).
  const preview = url.length > 64 ? url.slice(0, 64) + '…' : url;
  process.stderr.write(`xdg-open: only http/https URLs are supported on Shelly (got: ${preview})\n`);
  process.exit(1);
}

const deepLink = `shelly://browser?url=${encodeURIComponent(url)}`;
// The deep link lands in app/_layout.tsx handleDeepLink which dispatches
// to useBrowserStore.getState().openUrl(target). If the Browser Pane
// isn't open yet, useDeepLinkAutoCreatePane creates one. Best-effort —
// Claude Code's i3() ignores return code; we mirror that by using exec
// with a short timeout and not blocking the caller.
const cmd = `am start -a android.intent.action.VIEW -d "${deepLink}"`;

exec(cmd, { timeout: 3000 }, (err) => {
  process.exit(err ? 1 : 0);
});
