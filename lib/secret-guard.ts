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
  | 'anthropic-key'
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
    // Anthropic keys carry their own prefix — label them precisely instead of
    // the generic openai-like bucket (G1 follow-up: detection was already
    // correct, only the reason-log label was misleading).
    // {12,} not {16,}: the old bare-`sk` branch counted `ant-` toward its 16-char
    // minimum (sk- + 16 = sk-ant- + 12), so a tighter minimum here would shrink
    // the detection set — a fail-open regression on this hard-stop guard.
    kind: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/,
  },
  {
    kind: 'openai-like-key',
    // The sk-ant exclusion applies to the bare `sk` branch ONLY (it would
    // otherwise double-label every Anthropic key). Scoping it to all branches
    // would drop gsk-ant-*/csk-ant-*/pplx-ant-* keys the old pattern caught.
    pattern: /\b(?:(?:sk-proj|gsk|csk|pplx)-|sk-(?!ant-))[A-Za-z0-9_-]{16,}\b/,
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
