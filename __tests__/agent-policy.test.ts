import {
  parseAutonomyPolicy,
  decideAutoAnswer,
  buildAgentPolicy,
  DEFAULT_POLICY,
  AutonomyPolicy,
} from '@/lib/agent-policy';
import { Agent } from '@/store/types';

const ROOT = '/data/user/0/dev.shelly.terminal/files/home/projects/app';
const policy = (over: Partial<AutonomyPolicy> = {}): AutonomyPolicy => ({
  ...DEFAULT_POLICY,
  workspaceRoot: ROOT,
  ...over,
});

describe('parseAutonomyPolicy', () => {
  it('fills defaults from empty/garbage input', () => {
    const p = parseAutonomyPolicy(null, ROOT);
    expect(p.level).toBe('L2');
    expect(p.workspaceRoot).toBe(ROOT);
    expect(p.secretPaths).toEqual(DEFAULT_POLICY.secretPaths);
  });
  it('accepts valid fields, rejects bad ones', () => {
    const p = parseAutonomyPolicy({ level: 'L3', denyPatterns: ['foo'], secretPaths: 123 }, ROOT);
    expect(p.level).toBe('L3');
    expect(p.denyPatterns).toEqual(['foo']);
    expect(p.secretPaths).toEqual(DEFAULT_POLICY.secretPaths); // 123 invalid → default
  });
  it('falls back on an invalid level', () => {
    expect(parseAutonomyPolicy({ level: 'ROOT' }, ROOT).level).toBe('L2');
  });

  it('unattended is strict `=== true` — malformed/absent values stay attended (DEFERRED #2)', () => {
    expect(parseAutonomyPolicy({ unattended: true }, ROOT).unattended).toBe(true);
    expect(parseAutonomyPolicy({ unattended: false }, ROOT).unattended).toBe(false);
    expect(parseAutonomyPolicy({}, ROOT).unattended).toBe(false);
    expect(parseAutonomyPolicy({ unattended: 1 }, ROOT).unattended).toBe(false);
    expect(parseAutonomyPolicy({ unattended: 'true' }, ROOT).unattended).toBe(false);
  });
});

describe('decideAutoAnswer', () => {
  it('maps allow→y, deny→n, gray→escalate', () => {
    expect(decideAutoAnswer('cat src/a.ts', policy({ level: 'L2' })).answer).toBe('y');
    expect(decideAutoAnswer('rm -rf /', policy({ level: 'L2' })).answer).toBe('n');
    expect(decideAutoAnswer('cp src/a.ts /sdcard/x', policy({ level: 'L2' })).answer).toBe('escalate');
  });

  it('operator denyPattern hard-denies even an otherwise-allowed command', () => {
    const o = decideAutoAnswer('git push origin feature', policy({ level: 'L3', denyPatterns: ['git\\s+push'] }));
    expect(o.answer).toBe('n');
    expect(o.verdict.decision).toBe('deny');
  });

  it('operator allowPattern upgrades a gray to allow', () => {
    const o = decideAutoAnswer('cp src/a.ts /sdcard/x', policy({ level: 'L2', allowPatterns: ['/sdcard/x'] }));
    expect(o.answer).toBe('y');
  });

  it('allowPattern NEVER overrides a hard-deny (the invariant)', () => {
    const o = decideAutoAnswer('rm -rf /', policy({ level: 'L3', allowPatterns: ['rm'] }));
    expect(o.answer).toBe('n');
  });

  it('redacts secrets in the audit entry', () => {
    const o = decideAutoAnswer('export SOME_SECRET=topsecretvalue123', policy({ level: 'L2' }));
    expect(o.audit.command).not.toContain('topsecretvalue123');
  });

  it('audit records decision, signals, level', () => {
    const o = decideAutoAnswer('cp src/a.ts /sdcard/x', policy({ level: 'L2' }));
    expect(o.audit.decision).toBe('gray');
    expect(o.audit.signals).toContain('leaves-root');
    expect(o.audit.level).toBe('L2');
  });
});

describe('buildAgentPolicy', () => {
  const mkAgent = (over: Partial<Agent> = {}): Agent => ({
    id: 'a', name: 'A', description: '', prompt: 'p', schedule: null,
    tool: { type: 'cli', cli: 'codex' }, outputPath: '~/out', outputTemplate: null,
    enabled: true, lastRun: null, lastResult: null, createdAt: 0, version: 1, ...over,
  });

  it('uses the agent level + canonical root, defaults elsewhere', () => {
    const p = buildAgentPolicy(mkAgent({ autonomyLevel: 'L3' }), ROOT);
    expect(p.level).toBe('L3');
    expect(p.workspaceRoot).toBe(ROOT);
    expect(p.secretPaths).toEqual(DEFAULT_POLICY.secretPaths);
    expect(p.policyPath).toBe(DEFAULT_POLICY.policyPath);
  });

  it('defaults to L2 when the agent has no level', () => {
    expect(buildAgentPolicy(mkAgent(), ROOT).level).toBe('L2');
  });

  it('bakes unattended from opts, defaulting to attended (DEFERRED #2)', () => {
    expect(buildAgentPolicy(mkAgent(), ROOT).unattended).toBe(false);
    expect(buildAgentPolicy(mkAgent(), ROOT, { unattended: true }).unattended).toBe(true);
    expect(buildAgentPolicy(mkAgent(), ROOT, { unattended: false }).unattended).toBe(false);
  });
});
