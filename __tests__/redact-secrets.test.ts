import { redactSecrets } from '../lib/redact-secrets';

describe('redactSecrets', () => {
  it('redacts provider key patterns without dropping context', () => {
    const input = 'keys sk-proj-abcdefghijklmnopqrstuvwxyz123456 gsk_abcdefghijklmnopqrstuvwxyz csk-abcdefghijklmnopqrstuvwxyz AIzaabcdefghijklmnopqrstuvwxyz123456789';
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

