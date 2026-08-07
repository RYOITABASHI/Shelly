import { detectLinks } from '@/lib/link-detector';

describe('detectLinks — URL case sensitivity', () => {
  // 2026-08-07 on-device QA finding (docs/superpowers/DEFERRED.md): a
  // command like `echo "HTTPS://EXAMPLE.COM/PATH"` produced output the old
  // (missing `i` flag) URL_REGEX never matched at all, so an upper-case URL
  // was invisible to link detection entirely — not just unclickable.
  it('detects an all-uppercase URL', () => {
    const links = detectLinks('see HTTPS://EXAMPLE.COM/PATH for details');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ text: 'HTTPS://EXAMPLE.COM/PATH', type: 'url' });
  });

  it('detects a mixed-case URL', () => {
    const links = detectLinks('visit Https://Example.com/Some/Path?q=1');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('Https://Example.com/Some/Path?q=1');
  });

  it('still detects a lower-case URL (no regression)', () => {
    const links = detectLinks('visit https://example.com/path');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/path');
  });

  it('detects an upper-case www. URL', () => {
    const links = detectLinks('go to WWW.EXAMPLE.COM now');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('WWW.EXAMPLE.COM');
  });
});
