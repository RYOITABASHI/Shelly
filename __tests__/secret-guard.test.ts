import { scanForSecrets } from '@/lib/secret-guard';

describe('scanForSecrets', () => {
  it('detects common API/token shapes without returning the secret value', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCDE1234567890',
      'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
      `GOOGLE_API_KEY=${'AIza' + 'A'.repeat(35)}`,
    ].join('\n');

    const result = scanForSecrets(text);

    expect(result.hasSecret).toBe(true);
    expect(result.kinds).toEqual(expect.arrayContaining([
      'bearer-token',
      'github-token',
      'aws-access-key',
      'google-api-key',
    ]));
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('detects private keys and combined email/phone PII', () => {
    const result = scanForSecrets([
      '-----BEGIN PRIVATE KEY-----',
      'abc',
      '-----END PRIVATE KEY-----',
      'Contact alice@example.com at +1 415 555 0101',
    ].join('\n'));

    expect(result.hasSecret).toBe(true);
    expect(result.kinds).toEqual(expect.arrayContaining(['private-key', 'email-and-phone']));
  });

  it('does not flag ordinary article prompts', () => {
    expect(scanForSecrets('今日のニュースを要約して下書きにして').hasSecret).toBe(false);
  });

  it('labels Anthropic keys precisely, not as the generic openai-like bucket (G1 follow-up)', () => {
    const result = scanForSecrets('use key sk-ant-api03-AAAABBBBCCCCDDDD');
    expect(result.hasSecret).toBe(true);
    expect(result.kinds).toContain('anthropic-key');
    expect(result.kinds).not.toContain('openai-like-key');
  });

  it('still labels OpenAI-style and other sk-/gsk-/pplx- keys as openai-like', () => {
    for (const key of [
      'sk-abcdefghijklmnop123456',
      'sk-proj-abcdefghijklmnop1234',
      'gsk-abcdefghijklmnop123456',
      'pplx-abcdefghijklmnop123456',
    ]) {
      const result = scanForSecrets(`export KEY=${key}`);
      expect(result.hasSecret).toBe(true);
      expect(result.kinds).toContain('openai-like-key');
      expect(result.kinds).not.toContain('anthropic-key');
    }
  });

  it('detection coverage never shrinks: inputs the OLD pattern caught stay caught (review regression)', () => {
    // A truncated sk-ant fragment (12 chars after the prefix): the old bare-sk
    // branch counted `ant-` toward its 16-char minimum, so this WAS detected —
    // the split patterns must keep it (fail-closed hard-stop guard).
    const truncated = scanForSecrets('key sk-ant-abcdefghij12');
    expect(truncated.hasSecret).toBe(true);
    expect(truncated.kinds).toContain('anthropic-key');
    // gsk-ant-* (a non-Anthropic key whose body happens to start with `ant-`):
    // the exclusion must apply to the bare `sk` branch only.
    const gskAnt = scanForSecrets('key gsk-ant-abcdefghijklmnop');
    expect(gskAnt.hasSecret).toBe(true);
    expect(gskAnt.kinds).toContain('openai-like-key');
  });
});
