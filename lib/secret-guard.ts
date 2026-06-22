/**
 * Offline guard for task text that must not leave the device.
 *
 * This is intentionally cheap and conservative: it records only match kinds,
 * never the matched secret value, so run logs do not become a new leak surface.
 */

export type SecretGuardKind =
  | 'private-key'
  | 'bearer-token'
  | 'api-key-assignment'
  | 'openai-like-key'
  | 'github-token'
  | 'aws-access-key'
  | 'google-api-key'
  | 'cloud-service-account'
  | 'email-and-phone';

export interface SecretGuardResult {
  hasSecret: boolean;
  kinds: SecretGuardKind[];
}

type SecretPattern = {
  kind: SecretGuardKind;
  pattern: RegExp;
};

const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/m,
  },
  {
    kind: 'cloud-service-account',
    pattern: /"type"\s*:\s*"service_account"[\s\S]{0,300}"private_key"\s*:/i,
  },
  {
    kind: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  },
  {
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    kind: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    kind: 'openai-like-key',
    pattern: /\b(?:sk|sk-proj|sk-ant|gsk|csk|pplx)-[A-Za-z0-9_-]{16,}\b/,
  },
  {
    kind: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  },
  {
    kind: 'api-key-assignment',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  },
];

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?:\+?\d[\d .()_-]{7,}\d)/;

export function scanForSecrets(text: string): SecretGuardResult {
  const kinds = new Set<SecretGuardKind>();
  for (const { kind, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      kinds.add(kind);
    }
  }
  if (EMAIL_RE.test(text) && PHONE_RE.test(text)) {
    kinds.add('email-and-phone');
  }
  return {
    hasSecret: kinds.size > 0,
    kinds: [...kinds],
  };
}
