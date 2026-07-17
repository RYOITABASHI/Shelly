import { scanForPii } from '@/lib/memory/pii-guard';
import { scanForSecrets } from '@/lib/secret-guard';

describe('scanForPii', () => {
  it('flags a physical home address', () => {
    const result = scanForPii('Please ship the replacement to 742 Evergreen Terrace, Apt 4');
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('physical-address');
  });

  it('flags a standalone phone number (no email present, unlike secret-guard)', () => {
    const text = 'call me at +1 415 555 0101 when you land';
    expect(scanForSecrets(text).hasSecret).toBe(false); // secret-guard needs email+phone together
    const result = scanForPii(text);
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('phone-number');
  });

  it('flags a health-condition disclosure that has no secret-pattern shape at all', () => {
    const text = 'remember I was diagnosed with anxiety disorder last spring, go easy on scheduling';
    expect(scanForSecrets(text).hasSecret).toBe(false);
    const result = scanForPii(text);
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('health-condition');
  });

  it('flags an employment-sensitive disclosure', () => {
    const result = scanForPii('note: I got fired from my last job over this exact bug');
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('employment-sensitive');
  });

  it('flags a financial-detail disclosure', () => {
    const result = scanForPii('my annual salary is $128,000 as of this year');
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('financial-detail');
  });

  it('flags a government-id shape (US SSN)', () => {
    const result = scanForPii('SSN on file: 123-45-6789');
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('government-id');
  });

  it('flags a full-name self-disclosure', () => {
    const result = scanForPii('Hi, my name is Alice Johnson, please remember that');
    expect(result.hasPii).toBe(true);
    expect(result.kinds).toContain('full-name-disclosure');
  });

  it('flags Japanese health/address/employment prose', () => {
    expect(scanForPii('先月うつ病と診断されました').hasPii).toBe(true);
    expect(scanForPii('東京都渋谷区1-2-3に住んでいます').hasPii).toBe(true);
    expect(scanForPii('先週懲戒処分を受けました').hasPii).toBe(true);
  });

  it('records only KINDS, never the matched value (mirrors secret-guard\'s contract)', () => {
    const result = scanForPii('call me at +1 415 555 0101');
    expect(JSON.stringify(result)).not.toContain('415 555 0101');
  });

  it('does not flag ordinary task prompts', () => {
    expect(scanForPii('deploy target is the fold6 device').hasPii).toBe(false);
    expect(scanForPii('user prefers concise answers').hasPii).toBe(false);
    expect(scanForPii('api base url is example.com').hasPii).toBe(false);
    expect(scanForPii('今日のニュースを要約して下書きにして').hasPii).toBe(false);
  });

  it('does not flag ordinary Japanese status updates', () => {
    expect(scanForPii('明日のミーティングの資料を用意してください').hasPii).toBe(false);
  });
});
