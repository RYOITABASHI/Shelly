const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'OpenAI project key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Anthropic token', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{25,}\b/g },
  { label: 'Groq API key', pattern: /\bgsk_[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Cerebras API key', pattern: /\bcsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    label: 'named secret',
    pattern: /\b([A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*(['"]?)[^\s'"]{8,}\2/gi,
  },
];

function redactString(input: string): string {
  let out = input;
  for (const { label, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, name) => {
      if (label === 'named secret' && typeof name === 'string') {
        return `${name}=<redacted>`;
      }
      const tail = match.length >= 4 ? match.slice(-4) : '';
      return `<redacted:${label}${tail ? `:...${tail}` : ''}>`;
    });
  }
  return out;
}

/** String-typed entry point for callers that already know they have a plain
 *  string and want a string back without the `unknown`-typed redactSecrets()
 *  cast. Same SECRET_PATTERNS, same redaction behavior — just avoids `as
 *  string` at every call site. Added for lib/agent-nl-parser.ts's deriveName()
 *  (auto-derived agent display name — see its call site for the 2026-07-27
 *  on-device finding that motivated this) and agent-executor.ts's
 *  computeAgentSlug() (filename derivation), so both reuse this pattern list
 *  instead of duplicating it. */
export function redactSecretsText(input: string): string {
  return redactString(input);
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value == null) return value;
  if (value instanceof Error) {
    const redacted = new Error(redactString(value.message));
    redacted.name = value.name;
    if (value.stack) redacted.stack = redactString(value.stack);
    return redacted;
  }
  try {
    return redactString(JSON.stringify(value));
  } catch {
    return '<redacted:unserializable>';
  }
}
