import {
  AUTH_REFS,
  EGRESS_ALLOWLIST,
  DEFAULT_BUDGET,
  buildEgressAudit,
  checkBudget,
  classifyEgress,
  hostFromUrl,
  isAllowlistedHost,
} from '@/lib/capability-envelope';

describe('capability-envelope: host parsing + allowlist (HTTP-001)', () => {
  it('extracts and lowercases the host', () => {
    expect(hostFromUrl('https://API.Perplexity.AI/chat/completions')).toBe('api.perplexity.ai');
    expect(hostFromUrl('not a url')).toBeNull();
  });

  it('every backend host is on the allowlist', () => {
    expect(isAllowlistedHost('api.perplexity.ai')).toBe(true);
    expect(isAllowlistedHost('generativelanguage.googleapis.com')).toBe(true);
    expect(isAllowlistedHost('api.cerebras.ai')).toBe(true);
    expect(isAllowlistedHost('api.groq.com')).toBe(true);
    expect(isAllowlistedHost('127.0.0.1')).toBe(true);
    expect(isAllowlistedHost('evil.example.com')).toBe(false);
  });

  it('every auth_ref host is present in the allowlist', () => {
    for (const spec of Object.values(AUTH_REFS)) {
      expect(EGRESS_ALLOWLIST).toContain(spec.host);
    }
  });
});

describe('capability-envelope: classifyEgress (CAP-001 §4.3 structural rule)', () => {
  it('allows an allowlisted https host with no secret/taint', () => {
    const v = classifyEgress({ url: 'https://api.groq.com/openai/v1/chat/completions' });
    expect(v.decision).toBe('allow');
  });

  it('allows loopback over http', () => {
    const v = classifyEgress({ url: 'http://127.0.0.1:8080/v1/chat/completions' });
    expect(v.decision).toBe('allow');
  });

  it('denies non-loopback plaintext http', () => {
    const v = classifyEgress({ url: 'http://api.groq.com/x' });
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('insecure-scheme');
  });

  it('denies an unparseable URL', () => {
    const v = classifyEgress({ url: 'http://' });
    expect(v.decision).toBe('deny');
  });

  it('requires approval for a non-allowlist host (e.g. a webhook)', () => {
    const v = classifyEgress({ url: 'https://hooks.example.com/incoming' });
    expect(v.decision).toBe('approve');
    expect(v.signals).toContain('non-allowlist-host');
  });

  it('allows a secret spent against its bound host', () => {
    const v = classifyEgress({ url: 'https://api.perplexity.ai/chat/completions', authRef: 'perplexity' });
    expect(v.decision).toBe('allow');
    expect(v.signals).toContain('secret-spend');
  });

  it('HARD-denies a secret spent against a different host (exfil guard)', () => {
    const v = classifyEgress({ url: 'https://evil.example.com/steal', authRef: 'perplexity' });
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('ref-host-mismatch');
  });

  it('HARD-denies a secret spent against ANOTHER allowlisted backend host', () => {
    // A gemini ref must not be spendable at groq's host even though both are allowlisted.
    const v = classifyEgress({ url: 'https://api.groq.com/openai/v1/chat/completions', authRef: 'gemini' });
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('ref-host-mismatch');
  });

  it('denies an unknown auth_ref', () => {
    const v = classifyEgress({ url: 'https://api.groq.com/x', authRef: 'made-up' });
    expect(v.decision).toBe('deny');
  });

  it('flags taint on a non-allowlist send (trifecta case → approve, not auto)', () => {
    const v = classifyEgress({ url: 'https://hooks.example.com/incoming', tainted: true });
    expect(v.decision).toBe('approve');
    expect(v.signals).toContain('tainted');
    expect(v.signals).toContain('non-allowlist-host');
  });
});

describe('capability-envelope: checkBudget (CAP-001 fail-closed)', () => {
  const t0 = 1_000_000;
  it('allows an in-budget call', () => {
    expect(checkBudget({ calls: 0, startedAtMs: t0 }, DEFAULT_BUDGET, t0).ok).toBe(true);
  });
  it('fails closed at the call cap', () => {
    const r = checkBudget({ calls: DEFAULT_BUDGET.maxCalls, startedAtMs: t0 }, DEFAULT_BUDGET, t0);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/call budget/);
  });
  it('fails closed past the wall-time cap', () => {
    const r = checkBudget({ calls: 1, startedAtMs: t0 }, DEFAULT_BUDGET, t0 + DEFAULT_BUDGET.maxWallMs + 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/wall-time budget/);
  });
});

describe('capability-envelope: buildEgressAudit (CAP-001 redacted audit)', () => {
  it('records ref NAME and host/path but drops the query string', () => {
    const entry = buildEgressAudit({
      ts: '2026-07-01T00:00:00.000Z',
      method: 'post',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSECRETSECRETSECRETSECRETSECRETSEC',
      authRef: 'gemini',
      verdict: classifyEgress({
        url: 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
        authRef: 'gemini',
      }),
      status: 200,
      ok: true,
    });
    expect(entry.method).toBe('POST');
    expect(entry.host).toBe('generativelanguage.googleapis.com');
    expect(entry.authRef).toBe('gemini');
    expect(entry.status).toBe(200);
    // The audit must never carry the key that rode in the query string.
    expect(JSON.stringify(entry)).not.toContain('AIzaSECRET');
    expect(entry.path).not.toContain('key=');
  });
});
