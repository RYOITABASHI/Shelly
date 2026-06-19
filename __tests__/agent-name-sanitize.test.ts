import { sanitizeAgentName } from '@/lib/sanitize-agent-name';

// Regression guard for the pre-push review BLOCKER: a free-text agent name
// (from the NL confirm card) lands verbatim in the generated run script's
// comment line (agent-executor.ts). An interior newline would close the `#`
// comment and turn the next bytes into executable shell. sanitizeAgentName
// (called by createAgent at the single write-boundary) must strip control chars.
const hasControlChar = (s: string): boolean =>
  [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 0x1f || n === 0x7f;
  });

describe('sanitizeAgentName — shell-comment breakout guard', () => {
  it('strips a newline injected to break out of the comment line', () => {
    const out = sanitizeAgentName('report\nrm -rf ~');
    expect(hasControlChar(out)).toBe(false);
    expect(out.includes('\n')).toBe(false);
  });

  it('strips CR / tab / other control chars', () => {
    expect(hasControlChar(sanitizeAgentName('a\r\tbc'))).toBe(false);
  });

  it('keeps an ordinary (spaced) name intact', () => {
    expect(sanitizeAgentName('Daily blog draft')).toBe('Daily blog draft');
  });

  it('collapses the whitespace left by stripped control chars', () => {
    expect(sanitizeAgentName('a\n\n\tb')).toBe('a b');
  });

  it('uses the fallback when the name is empty after stripping', () => {
    expect(sanitizeAgentName('\n\n\t', 'agent-x')).toBe('agent-x');
    expect(hasControlChar(sanitizeAgentName(''))).toBe(false);
    expect(sanitizeAgentName('').length).toBeGreaterThan(0);
  });
});
