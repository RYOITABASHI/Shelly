/**
 * lib/social-connectors.ts — pure helpers for social auto-post connectors
 * (2026-07-22, free-API alternative to the AccessibilityService app-act path).
 *
 * Deliberately dependency-free (types only) so it can be imported by
 * lib/agent-executor.ts (which must stay free of settings-store /
 * expo-secure-store transitive imports — see the ACTION_APPROVAL_MODE comment
 * there) as well as by store/settings-store.ts and lib/secure-store.ts.
 *
 * Naming contract (mirrored by scripts/shelly-plan-executor.js, which is plain
 * CommonJS and cannot import this file):
 *  - SecureStore key:  shelly_social-connector.<id>.<field>
 *    (expo-secure-store keys only allow [A-Za-z0-9._-], so the spec's
 *    illustrative `social-connector:<id>:<field>` colons become dots)
 *  - .env variable:    SOCIAL_CONNECTOR_<ID>_<FIELD>
 *    where <ID> = id with '-'→'_' then uppercased, <FIELD> = field uppercased.
 *    Two reserved non-secret suffixes per connector: _HOST (the declared API
 *    host) and _META (a JSON blob {platform,host,fields} — never secrets).
 *    No secret field name ends in HOST or META (see SOCIAL_PLATFORM_FIELDS),
 *    so scripts can safely admit only *_HOST/*_META into config surfaces.
 */
import type { SocialConnectorMeta, SocialPlatform } from '@/store/types';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = Object.freeze([
  'discord',
  'slack',
  'telegram',
  'mastodon',
  'misskey',
  'wordpress',
  'bluesky',
]);

/**
 * The secret fields each platform's connector needs. The VALUES of these
 * fields are secrets (SecureStore + .env only, never in SocialConnectorMeta).
 */
export const SOCIAL_PLATFORM_FIELDS: Readonly<Record<SocialPlatform, readonly string[]>> = Object.freeze({
  discord: ['webhookUrl'],
  slack: ['webhookUrl'],
  telegram: ['botToken', 'chatId'],
  mastodon: ['accessToken'],
  misskey: ['apiToken'],
  wordpress: ['username', 'appPassword'],
  bluesky: ['handle', 'appPassword'],
});

/** Union of every known secret field name across platforms — used by
 *  deleteAllConnectorSecrets when no explicit field list is available. */
export const SOCIAL_ALL_FIELDS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(SOCIAL_PLATFORM_FIELDS).flat())),
);

/** Default (fixed) hosts for the non-federated platforms. mastodon/misskey/
 *  wordpress have no default — the user's own instance/site is the host.
 *  bluesky defaults to bsky.social but stays user-editable (custom PDS). */
export const SOCIAL_DEFAULT_HOSTS: Readonly<Partial<Record<SocialPlatform, string>>> = Object.freeze({
  discord: 'discord.com',
  slack: 'hooks.slack.com',
  telegram: 'api.telegram.org',
  bluesky: 'bsky.social',
});

const SAFE_CONNECTOR_ID_RE = /^[A-Za-z0-9-]+$/;
// Field names are fixed camelCase identifiers (see SOCIAL_PLATFORM_FIELDS).
const SAFE_CONNECTOR_FIELD_RE = /^[A-Za-z0-9]+$/;
// Bare hostname (no scheme/path/port/userinfo). Ports are deliberately not
// supported: the host doubles as the allowlist/audit identity and must match
// URL.hostname (which strips the port) exactly.
const CONNECTOR_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** alphanumeric+hyphen only — matches lib/agent-manager.ts's agent-id rigor;
 *  the id is used in SecureStore keys and .env variable names. */
export function isSafeConnectorId(id: string): boolean {
  return SAFE_CONNECTOR_ID_RE.test(id);
}

export function isSafeConnectorField(field: string): boolean {
  return SAFE_CONNECTOR_FIELD_RE.test(field);
}

export function isValidConnectorHost(host: string): boolean {
  return typeof host === 'string' && host.length > 0 && host.length <= 253 && CONNECTOR_HOST_RE.test(host);
}

export function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/** SOCIAL_CONNECTOR_<ID> — the shared .env variable prefix for one connector.
 *  '-'→'_' is injective because ids never contain '_' (isSafeConnectorId). */
export function socialConnectorEnvPrefix(connectorId: string): string {
  if (!isSafeConnectorId(connectorId)) {
    throw new Error(`refusing social-connector env prefix for unsafe id: ${connectorId}`);
  }
  return `SOCIAL_CONNECTOR_${connectorId.replace(/-/g, '_').toUpperCase()}`;
}

/** Full .env variable name for one secret field of one connector. */
export function socialConnectorEnvVar(connectorId: string, field: string): string {
  if (!isSafeConnectorField(field)) {
    throw new Error(`refusing social-connector env var for unsafe field: ${field}`);
  }
  return `${socialConnectorEnvPrefix(connectorId)}_${field.toUpperCase()}`;
}

/** The non-secret META payload synced to .env alongside the secrets — lets the
 *  generated run script / PlanSpec executor say "Posted to Mastodon
 *  (mastodon.social)" without ever touching a secret value. */
export function socialConnectorMetaEnvValue(meta: Pick<SocialConnectorMeta, 'platform' | 'host' | 'fields'>): string {
  return JSON.stringify({ platform: meta.platform, host: meta.host, fields: [...meta.fields] });
}
