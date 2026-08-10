/**
 * __tests__/command-safety.test.ts
 *
 * Regression coverage for a code-quality audit finding (2026-08-10):
 *
 * 1. checkCommandSafety() stripped comments with a naive regex replace
 *    (strip from the first # to end of line, with no quote awareness).
 *    A # inside a single/double-quoted string (e.g.
 *    echo "hello # not a comment") was treated as a comment start, and
 *    everything after it — including a real, dangerous command chained with
 *    && — was silently dropped from the string being checked. That is a
 *    detection gap: a genuinely dangerous command tail could be smuggled
 *    past the checker inside a quoted string containing #.
 *
 * 2. The dangerous-rm patterns assumed the -r/-f flags were combined
 *    into a single token (-rf, -fr, ...). "rm -r -f path" / "rm -f -r
 *    path" (flags split across separate argv tokens — a perfectly normal
 *    way to invoke rm) slipped through undetected.
 *
 * command-safety.ts is documented as an auxiliary warning layer, not the
 * real execution boundary (lib/agent-boundary-policy.ts is), so these tests
 * check for improved detection, not airtight shell parsing.
 */
import { checkCommandSafety, needsConfirmation } from '@/lib/command-safety';

describe('checkCommandSafety — quote-aware comment stripping', () => {
  it('still strips a real trailing comment (regression: baseline behavior preserved)', () => {
    const result = checkCommandSafety('ls -la # rm -rf /');
    expect(result.level).toBe('SAFE');
  });

  it('does not treat a # inside a double-quoted string as a comment start', () => {
    // Old buggy behavior: `command.replace(/#[^\n]*/g, '')` cuts everything
    // from the first `#` onward — INCLUDING the real `&& rm -rf /` that
    // follows the closing quote — leaving only `echo "safe ` to check.
    // That command would have come back SAFE, which is the security gap.
    const result = checkCommandSafety('echo "safe # marker" && rm -rf /');
    expect(result.level).toBe('CRITICAL');
  });

  it('does not treat a # inside a single-quoted string as a comment start', () => {
    const result = checkCommandSafety("echo 'safe # marker' && rm -rf /");
    expect(result.level).toBe('CRITICAL');
  });

  it('a lone quoted # with no dangerous tail stays SAFE', () => {
    const result = checkCommandSafety('echo "hello # not a comment"');
    expect(result.level).toBe('SAFE');
  });

  it('a real comment following a quoted string is still stripped', () => {
    // The quoted `#` must not flip the parser into "always inside string"
    // mode for the rest of the line — the comment after the closing quote
    // should still be recognized and stripped.
    const result = checkCommandSafety('echo "safe # marker" # rm -rf /');
    expect(result.level).toBe('SAFE');
  });
});

describe('checkCommandSafety — separated rm flags', () => {
  // Note: a bare-slash absolute path after -rf already hits the CRITICAL
  // "root/home wipe" pattern regardless of how the flags were spelled (that
  // pattern's target group isn't end-anchored — a pre-existing, unrelated
  // characteristic of this file, not something introduced or fixed here).
  // These cases use a relative path so they exercise the HIGH
  // "recursive force delete" pattern specifically.

  it('detects `rm -r -f <path>` (flags split into separate tokens) as HIGH', () => {
    const result = checkCommandSafety('rm -r -f some-dir');
    expect(result.level).toBe('HIGH');
  });

  it('detects `rm -f -r <path>` (reverse order, split) as HIGH', () => {
    const result = checkCommandSafety('rm -f -r some-dir');
    expect(result.level).toBe('HIGH');
  });

  it('detects `rm -r -f /` (split flags targeting root) as CRITICAL', () => {
    const result = checkCommandSafety('rm -r -f /');
    expect(result.level).toBe('CRITICAL');
  });

  it('detects `rm -r -f <absolute path>` (split flags, non-root absolute path) as at least CRITICAL/HIGH', () => {
    // Documents the pre-existing bare-slash-triggers-CRITICAL behavior noted
    // above — still confirms the split-flag case is *detected*, which is
    // this fix's actual scope (needsConfirmation must be true either way).
    const result = checkCommandSafety('rm -r -f /tmp/some-dir');
    expect(needsConfirmation(result)).toBe(true);
  });

  it('still detects the already-combined `rm -rf /` form (no regression)', () => {
    const result = checkCommandSafety('rm -rf /');
    expect(result.level).toBe('CRITICAL');
  });

  it('a plain `rm <file>` (no recursive+force) stays below HIGH', () => {
    const result = checkCommandSafety('rm /tmp/one-file.txt');
    expect(result.level).not.toBe('HIGH');
    expect(result.level).not.toBe('CRITICAL');
  });
});

describe('checkCommandSafety — no loosening of existing detections', () => {
  it('fork bomb is still CRITICAL', () => {
    expect(checkCommandSafety(':(){ :|:& };:').level).toBe('CRITICAL');
  });

  it('git push --force is still HIGH', () => {
    expect(checkCommandSafety('git push --force origin main').level).toBe('HIGH');
  });

  it('git reset --hard is still HIGH', () => {
    expect(checkCommandSafety('git reset --hard').level).toBe('HIGH');
  });

  it('needsConfirmation is true for HIGH/CRITICAL/MEDIUM', () => {
    expect(needsConfirmation(checkCommandSafety('rm -r -f /tmp/x'))).toBe(true);
    expect(needsConfirmation(checkCommandSafety('rm -rf /'))).toBe(true);
    expect(needsConfirmation(checkCommandSafety('sudo apt update'))).toBe(true);
  });
});
