/**
 * lib/x-oauth-connect.ts — stateful glue for the X OAuth 2.0 PKCE connect
 * flow: start it (open the authorize URL) and complete it (the
 * shelly://x-oauth-callback deep link lands here, per app/_layout.tsx's
 * handleDeepLink). Deliberately decoupled from the RootLayout effect closure
 * (which owns dispatchExternalBrowser's elaborate Custom-Tabs/Linking/in-app
 * fallback chain for CLI-triggered deep links) — this is always a deliberate,
 * foregrounded user action, so a direct WebBrowser.openBrowserAsync call is
 * enough; worst case the user retries the "Connect X" button.
 *
 * The in-flight PKCE attempt (codeVerifier/state/clientId) lives in a
 * module-level variable, not any store — it is short-lived (seconds to a
 * couple minutes, bounded by how long the user takes in the browser) and
 * MUST NOT survive an app restart (a stale verifier can never complete a
 * token exchange anyway; RFC 7636 ties it to one specific authorize request).
 */
import * as WebBrowser from 'expo-web-browser';
import { generatePkcePair, generateOAuthState } from './x-oauth-crypto-expo';
import {
  X_TOKEN_URL,
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
} from './x-oauth';
import { useSettingsStore } from '@/store/settings-store';
import { logInfo, logError } from './debug-logger';

export const X_OAUTH_REDIRECT_URI = 'shelly://x-oauth-callback';

interface PendingXOAuthAttempt {
  codeVerifier: string;
  state: string;
  clientId: string;
  /** connectorId to reuse if this is a reconnect (missing/invalid refresh
   *  token), or undefined to register a brand-new connector. */
  connectorId?: string;
  startedAt: number;
}

let pending: PendingXOAuthAttempt | null = null;
/** PKCE attempts older than this are refused at callback time — the user
 *  almost certainly abandoned the browser tab; a stale exchange is also just
 *  more time for the one-shot code to have been consumed/expired by X. */
const ATTEMPT_TTL_MS = 10 * 60_000;

export interface StartXOAuthConnectOptions {
  clientId: string;
  /** Pass the existing connector's id to reconnect (e.g. after a revoked/
   *  expired refresh token); omit to register a new connector. */
  connectorId?: string;
}

/** Opens X's authorize page for a fresh PKCE attempt. Call from a "Connect X"
 *  Settings action; completeXOAuthCallback finishes the flow when the
 *  shelly://x-oauth-callback deep link arrives. */
export async function startXOAuthConnect(options: StartXOAuthConnectOptions): Promise<void> {
  const clientId = options.clientId.trim();
  if (!clientId) throw new Error('X client id is required to connect.');
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = await generateOAuthState();
  pending = { codeVerifier, state, clientId, connectorId: options.connectorId, startedAt: Date.now() };
  const url = buildAuthorizeUrl({ clientId, redirectUri: X_OAUTH_REDIRECT_URI, state, codeChallenge });
  logInfo('XOAuth', 'opening authorize URL');
  await WebBrowser.openBrowserAsync(url, {
    toolbarColor: '#0D1117',
    showTitle: true,
    enableBarCollapsing: false,
  });
}

export interface XOAuthCallbackResult {
  ok: boolean;
  connectorId?: string;
  error?: string;
}

/** Type predicate for the success case — prefer this over `result.ok` in a
 *  large/deeply-nested caller (app/_layout.tsx's handleDeepLink): a plain
 *  `if (result.ok)` failed to narrow the (previously union-typed) result
 *  there for reasons that didn't reproduce in isolation, so the shape was
 *  changed to a single interface + explicit predicate rather than chase a
 *  project-specific TS inference quirk further. */
export function isXOAuthSuccess(result: XOAuthCallbackResult): result is { ok: true; connectorId: string; error?: undefined } {
  return result.ok === true;
}

/** Handles shelly://x-oauth-callback?code=...&state=...(&error=...). Verifies
 *  state against the in-flight attempt, exchanges the code for tokens, and
 *  registers/updates the social connector. Always clears `pending`, even on
 *  failure — a failed attempt must not linger to be replayed. */
export async function completeXOAuthCallback(params: {
  code?: string | null;
  state?: string | null;
  error?: string | null;
}): Promise<XOAuthCallbackResult> {
  const attempt = pending;
  pending = null;
  if (params.error) {
    return { ok: false, error: `X authorization was denied or failed: ${params.error}` };
  }
  if (!attempt) {
    return { ok: false, error: 'No X connect attempt is in progress (may have expired or already completed).' };
  }
  if (Date.now() - attempt.startedAt > ATTEMPT_TTL_MS) {
    return { ok: false, error: 'X connect attempt expired — please try connecting again.' };
  }
  if (!params.state || params.state !== attempt.state) {
    logError('XOAuth', 'state mismatch on callback — possible CSRF or stale attempt');
    return { ok: false, error: 'X connect state mismatch — please try connecting again.' };
  }
  if (!params.code) {
    return { ok: false, error: 'X did not return an authorization code.' };
  }

  let response: Response;
  try {
    response = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenExchangeBody({
        code: params.code,
        clientId: attempt.clientId,
        redirectUri: X_OAUTH_REDIRECT_URI,
        codeVerifier: attempt.codeVerifier,
      }),
    });
  } catch (e) {
    logError('XOAuth', 'token exchange request failed', e);
    return { ok: false, error: 'X token exchange request failed (network error).' };
  }
  const raw = await response.text();
  if (!response.ok) {
    logError('XOAuth', `token exchange HTTP ${response.status}`);
    return { ok: false, error: `X token exchange failed (HTTP ${response.status}).` };
  }
  const parsed = parseTokenResponse(raw);
  if (!parsed || !parsed.refresh_token) {
    return { ok: false, error: 'X token response was missing a refresh token (was offline.access granted?).' };
  }

  const settings = useSettingsStore.getState();
  const connectorId = attempt.connectorId && settings.socialConnectors.some((c) => c.id === attempt.connectorId)
    ? attempt.connectorId
    : `x-${Date.now().toString(36)}`;
  try {
    if (settings.socialConnectors.some((c) => c.id === connectorId)) {
      await settings.updateSocialConnectorSecret(connectorId, 'refreshToken', parsed.refresh_token);
      await settings.updateSocialConnectorSecret(connectorId, 'clientId', attempt.clientId);
    } else {
      await settings.addSocialConnector(
        { id: connectorId, platform: 'x', label: 'X', host: 'api.x.com', fields: ['refreshToken', 'clientId'] },
        { refreshToken: parsed.refresh_token, clientId: attempt.clientId },
      );
    }
  } catch (e) {
    logError('XOAuth', 'connector registration failed', e);
    return { ok: false, error: e instanceof Error ? e.message : 'X connector registration failed.' };
  }
  logInfo('XOAuth', `connector ready: ${connectorId}`);
  return { ok: true, connectorId };
}
