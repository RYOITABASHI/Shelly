/**
 * lib/deep-link-queue-policy.ts — routing policy for `$HOME/.shelly-deep-link-queue`.
 *
 * The queue is the shell→RN bridge (Knox blocks `am start` from the app uid, see
 * modules/terminal-emulator/android/src/main/jni/shelly-xdg-open.c). Each line is
 * either a bare URL (legacy) or a JSON object:
 *
 *   { "type": "open-url", "url": "https://…", "provider": "google",
 *     "authMode": "in-app" | "external-browser" }
 *
 * `authMode: "external-browser"` means "hand this URL to Chrome Custom Tabs" —
 * i.e. the user's REAL browser process, with the user's real cookies and
 * sessions. `in-app` means the sandboxed Browser Pane WebView. Promoting a URL
 * from the second to the first is a privilege increase, so the host decision
 * has to be made HERE, on parsed-URL host equality, and it has to be made for
 * BOTH directions.
 *
 * ── Why this file exists (adversarial review 2026-07-28, DEFERRED bug #102/#115
 *    phase 1.2) ─────────────────────────────────────────────────────────────
 * The logic used to live inline in app/_layout.tsx's drainQueue, where the host
 * check ran ONLY inside `if (authMode === 'in-app')` — it was an *upgrade* rule,
 * never a *validation* rule. An entry that already declared
 * `"authMode":"external-browser"` was dispatched to the real browser after only
 * a `^https?://` check. shelly-xdg-open.c decides that flag with a
 * `strstr(url, "://accounts.google.com/")` SUBSTRING match, which also fires on
 * e.g. `https://evil.example/r?next=https://accounts.google.com/` — so the C
 * substring match was effectively authoritative for real-browser dispatch and
 * the documented "the JS side re-validates" mitigation did not actually exist
 * on that path.
 *
 * (Severity was bounded because the queue file lives in the app's own HOME and
 * anything running in the app sandbox can append to it directly — the native
 * binary is not a privilege boundary. This module still closes the gap so the
 * declared invariant "only Google OAuth hosts reach the external browser" is
 * actually enforced somewhere.)
 */

/**
 * Hosts allowed to reach the external browser / Custom Tabs.
 *
 * Mirrors shelly-xdg-open.c's `is_google_auth_url()` and
 * assets/shelly-gemini-auth.js's `GOOGLE_OAUTH_HOSTS` exactly. These are the
 * Google sign-in hosts that refuse to render inside an Android WebView (they
 * detect it via the `X-Requested-With` header Chromium injects unconditionally,
 * which UA spoofing cannot remove).
 */
export const EXTERNAL_BROWSER_HOSTS: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'codeassist.google.com',
]);

/**
 * Anthropic (Claude Code) OAuth authorize endpoints, host → exact path.
 * Claude Code glibc S2: `claude setup-token` / `/login` sign-in URLs, queued by
 * OAuthHyperlinkBridge.kt from the OSC 8 hyperlink Claude renders. Unlike the
 * Google hosts these are gated on host AND path (only the authorize endpoint,
 * never arbitrary claude.ai pages), https only, default port, no userinfo, AND
 * on the OAuth parameters: client_id must be Claude Code's public client and
 * redirect_uri must be Claude Code's manual-code callback or its localhost
 * listener. Even then the drain never opens one unprompted: the user has to
 * tap "Open" (`requiresConfirm`), and only while a shelly-claude-glibc session
 * is armed (app/_layout.tsx). Must mirror OAuthHyperlinkBridge.kt.
 */
export const ANTHROPIC_OAUTH_AUTHORIZE: ReadonlyMap<string, string> = new Map([
  ['claude.ai', '/oauth/authorize'],
  ['claude.com', '/cai/oauth/authorize'],
  ['platform.claude.com', '/oauth/authorize'],
  ['console.anthropic.com', '/oauth/authorize'],
]);

/** Claude Code's public OAuth client (CLIENT_ID in the 2.1.314 binary). */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Claude Code's MANUAL_REDIRECT_URL (setup-token / paste-the-code flow). */
export const CLAUDE_CODE_MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const LOCALHOST_CALLBACK = /^http:\/\/localhost:\d{1,5}\/callback$/;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Host + path is an Anthropic authorize endpoint (parameters not checked). */
export function isAnthropicAuthorizeEndpoint(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u) return false;
  const want = ANTHROPIC_OAUTH_AUTHORIZE.get(u.hostname.toLowerCase());
  return want !== undefined && u.pathname === want;
}

export function isAnthropicOAuthAuthorizeUrl(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  if (!isAnthropicAuthorizeEndpoint(raw)) return false;
  const clientIds = u.searchParams.getAll('client_id');
  const redirects = u.searchParams.getAll('redirect_uri');
  if (clientIds.length !== 1 || clientIds[0] !== CLAUDE_CODE_CLIENT_ID) return false;
  if (redirects.length !== 1) return false;
  return redirects[0] === CLAUDE_CODE_MANUAL_REDIRECT || LOCALHOST_CALLBACK.test(redirects[0]);
}

export type DeepLinkAuthMode = 'in-app' | 'external-browser';

export interface DeepLinkQueueEntry {
  url: string;
  provider: string | null;
  authMode: DeepLinkAuthMode;
  /** the parsed, lower-cased host — for logging / callers that want it */
  host: string;
  /**
   * true for Claude Code sign-in URLs: never opened automatically; the drain
   * asks the user (tap "Open"), and only while a shelly-claude-glibc session is
   * armed.
   */
  requiresConfirm: boolean;
}

export interface DeepLinkQueueResolution {
  /** null when the line was rejected; `reason` then says why. */
  entry: DeepLinkQueueEntry | null;
  /** rejection reason, present iff `entry` is null. */
  reason?: string;
  /** set when the policy changed the emitter's declared authMode. */
  note?: 'upgraded-to-external' | 'downgraded-to-in-app';
}

const reject = (reason: string): DeepLinkQueueResolution => ({ entry: null, reason });

/**
 * Parse + policy-check one queue line.
 *
 * Ordering matters and is deliberate:
 *   1. shape (JSON vs legacy bare URL)
 *   2. scheme allowlist (http/https only — `file:`/`content:`/`intent:` must
 *      never reach either dispatcher)
 *   3. host parse (a URL that survives step 2 but not `new URL()` is rejected
 *      rather than dispatched, because every downstream decision keys off host)
 *   4. DOWNGRADE any external-browser request whose host is not on the
 *      allowlist  ← the check that was missing entirely
 *   5. UPGRADE any in-app request whose host IS on the allowlist (defense in
 *      depth for emitters that push a bare/legacy line for an OAuth host —
 *      those would otherwise hit the WebView path Google hard-blocks)
 */
export function resolveQueueLine(rawLine: string): DeepLinkQueueResolution {
  const line = rawLine.trim();
  if (!line) return reject('empty line');

  let url: string;
  let provider: string | null = null;
  let declaredExternal = false;

  if (line.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return reject('malformed JSON line');
    }
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    if (!obj || typeof obj.url !== 'string') {
      return reject('JSON line without url field');
    }
    url = obj.url;
    if (typeof obj.provider === 'string') provider = obj.provider;
    declaredExternal = obj.authMode === 'external-browser';
  } else {
    // Legacy plain-URL format (still emitted by shelly-xdg-open.c for the
    // non-Google case and by shelly-codex-auth.js). Always in-app by default.
    url = line;
  }

  if (!/^https?:\/\//i.test(url)) {
    return reject('non-http(s) url');
  }

  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return reject('unparseable url');
  }
  if (!host) return reject('url without host');

  const anthropicAuth = isAnthropicOAuthAuthorizeUrl(url);
  if (!anthropicAuth && isAnthropicAuthorizeEndpoint(url)) {
    // An Anthropic consent page that is not Claude Code's own client/redirect
    // (or not https / has userinfo / odd port): the shape of a code-phishing
    // attempt. Never dispatch it anywhere, not even in-app.
    return reject('anthropic authorize url failed client_id/redirect_uri check');
  }
  const requiresConfirm = anthropicAuth;
  const allowed = EXTERNAL_BROWSER_HOSTS.has(host) || anthropicAuth;

  if (declaredExternal && !allowed) {
    // The emitter asked for the real browser for a host that is not an OAuth
    // host. Do not honour it — fall back to the sandboxed pane. Not a hard
    // reject: the URL itself may be perfectly legitimate, it just doesn't get
    // the privilege it asked for.
    return {
      entry: { url, provider, authMode: 'in-app', host, requiresConfirm: false },
      note: 'downgraded-to-in-app',
    };
  }

  if (!declaredExternal && allowed) {
    return {
      entry: {
        url,
        provider: provider ?? (anthropicAuth ? 'anthropic' : 'google'),
        authMode: 'external-browser',
        host,
        requiresConfirm,
      },
      note: 'upgraded-to-external',
    };
  }

  return {
    entry: { url, provider, authMode: declaredExternal ? 'external-browser' : 'in-app', host, requiresConfirm },
  };
}
