import { redactSecrets } from '../lib/redact-secrets';

describe('redactSecrets', () => {
  it('redacts provider key patterns without dropping context', () => {
    // Build fake keys at runtime so repository secret scanning does not flag
    // test fixtures as live credentials.
    const fakeOpenAi = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
    const fakeGroq = ['gsk_', 'abcdefghijklmnopqrstuvwxyz'].join('');
    const fakeCerebras = ['csk-', 'abcdefghijklmnopqrstuvwxyz'].join('');
    const fakeGoogle = ['AI', 'za', 'abcdefghijklmnopqrstuvwxyz123456789'].join('');
    const input = `keys ${fakeOpenAi} ${fakeGroq} ${fakeCerebras} ${fakeGoogle}`;
    const output = redactSecrets(input);

    expect(output).toContain('<redacted:OpenAI');
    expect(output).toContain('<redacted:Groq');
    expect(output).toContain('<redacted:Cerebras');
    expect(output).toContain('<redacted:Google');
    expect(output).toContain('keys');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('redacts named environment-style secrets', () => {
    const output = redactSecrets('PERPLEXITY_API_KEY=pplx-very-secret-value');

    expect(output).toBe('PERPLEXITY_API_KEY=<redacted>');
  });
});
