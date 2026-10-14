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

export type DeepLinkAuthMode = 'in-app' | 'external-browser';

export interface DeepLinkQueueEntry {
  url: string;
  provider: string | null;
  authMode: DeepLinkAuthMode;
  /** the parsed, lower-cased host — for logging / callers that want it */
  host: string;
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

  const allowed = EXTERNAL_BROWSER_HOSTS.has(host);

  if (declaredExternal && !allowed) {
    // The emitter asked for the real browser for a host that is not an OAuth
    // host. Do not honour it — fall back to the sandboxed pane. Not a hard
    // reject: the URL itself may be perfectly legitimate, it just doesn't get
    // the privilege it asked for.
    return {
      entry: { url, provider, authMode: 'in-app', host },
      note: 'downgraded-to-in-app',
    };
  }

  if (!declaredExternal && allowed) {
    return {
      entry: { url, provider: provider ?? 'google', authMode: 'external-browser', host },
      note: 'upgraded-to-external',
    };
  }

  return {
    entry: { url, provider, authMode: declaredExternal ? 'external-browser' : 'in-app', host },
  };
}
