const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeWebhookHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.includes('/') || trimmed.includes(':') || !HOST_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeWebhookHostAllowlist(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeWebhookHost).filter((host): host is string => Boolean(host)))).sort();
}

export function isWebhookHostAllowlisted(host: string | null | undefined, allowlist: readonly string[]): boolean {
  const normalized = host ? normalizeWebhookHost(host) : null;
  return normalized !== null && normalizeWebhookHostAllowlist(allowlist).includes(normalized);
}
