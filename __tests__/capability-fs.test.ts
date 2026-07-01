import { buildFsAudit, classifyFsAccess } from '@/lib/capability-fs';

describe('capability-fs pure core', () => {
  it('allows paths inside a declared root after lexical normalization', () => {
    const verdict = classifyFsAccess({
      op: 'write',
      path: '/home/shelly/agent-output/day/../day/result.md',
      roots: ['/home/shelly/agent-output'],
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.canonicalPath).toBe('/home/shelly/agent-output/day/result.md');
    expect(verdict.matchedRoot).toBe('/home/shelly/agent-output');
  });

  it('denies traversal outside every declared root', () => {
    const verdict = classifyFsAccess({
      op: 'write',
      path: '../../.shelly/agents/.env',
      cwd: '/home/shelly/agent-output/day',
      roots: ['/home/shelly/agent-output'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('outside-root');
  });

  it('redacts free-text audit reasons', () => {
    const verdict = classifyFsAccess({ op: 'read', path: 'x', roots: [] });
    verdict.reason = 'failed with GEMINI_API_KEY=AIzaSECRETSECRETSECRETSECRETSECRETSECRET';
    const audit = buildFsAudit({ ts: '2026-07-01T00:00:00.000Z', op: 'read', path: 'x', verdict });
    expect(audit.reason).toContain('<redacted');
  });
});
