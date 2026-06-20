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
});
