/**
 * POLICY-001 security review fixes: pure sha256, the widened policy-write
 * hard-deny (M1), the run-origin registry (M2) and L5 rule-drop handling.
 */
import { createHash } from 'node:crypto';
import { sha256Hex } from '@/lib/sha256';
import { classifyProposedCommand, touchesAgentsConfigDir } from '@/lib/agent-boundary-policy';
import { decideAutoAnswer, parseAutonomyPolicy } from '@/lib/agent-policy';
import {
  __resetRunOriginRegistryForTests,
  markUserRunFinished,
  markUserRunStarted,
  registeredRunOrigin,
} from '@/lib/agent-run-origin-registry';
import { evaluateApprovalRequestPolicy, trustedRequestOrigin } from '@/lib/agent-policy-approval';

describe('sha256Hex matches node crypto', () => {
  it.each(['', 'abc', 'npm test', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '支払い 😀 ü', '\ud800 lone'])('%j', (s) => {
    expect(sha256Hex(s)).toBe(createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'));
  });
});

describe('policy-write hard-deny covers deletes / rewrites of the agents config dir (M1)', () => {
  const ctx = { workspaceRoot: '/home/u/work', level: 'L3' as const, policyPath: '.shelly/agents/policy.json' };
  it.each([
    'rm ~/.shelly/agents/policy.json',
    'rm -f "$HOME/.shelly/agents/policy.json"',
    'unlink /data/user/0/dev.shelly.terminal/files/home/.shelly/agents/policy.json',
    'cd ~/.shelly/agents && rm policy.json',
    'cd ~/.shelly; cd agents; rm policy.json',
    "sed -i 's/deny/ask/' ~/.shelly/agents/policy.json",
    'truncate -s0 ~/.shelly/agents/policy.json',
    "python3 -c \"import os; os.remove('/home/u/.shelly/agents/policy.json')\"",
    "node -e \"require('fs').unlinkSync(process.env.HOME+'/.shelly/agents/policy.json')\"",
    'rm -rf ~/.shelly/agents',
    'mv ~/.shelly/agents ~/.shelly/agents.bak',
    'find ~/.shelly/agents -name "*.json" -delete',
  ])('%j ⇒ deny(policy-write)', (cmd) => {
    expect(touchesAgentsConfigDir(cmd)).toBe(true);
    const v = classifyProposedCommand(cmd, ctx);
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('policy-write');
  });

  it.each([
    'echo x > src/policy.json',
    'rm build/policy.json',
    'cat ~/.shelly/agents/policy.json',
    'ls ~/.shelly/agents',
    'npm test',
  ])('%j is not a policy-write', (cmd) => {
    expect(touchesAgentsConfigDir(cmd)).toBe(false);
  });

  it('the gate answers n for it at every level', () => {
    for (const level of ['L1', 'L2', 'L3']) {
      const p = parseAutonomyPolicy({ level, workspaceRoot: '/home/u/work' }, '/home/u/work');
      expect(decideAutoAnswer('cd ~/.shelly/agents && rm policy.json', p).answer).toBe('n');
    }
  });
});

describe('run-origin registry (M2): the request file origin is never trusted', () => {
  beforeEach(() => __resetRunOriginRegistryForTests());

  it('only agents RN is running for a human are "user"', () => {
    expect(registeredRunOrigin('a1')).toBe('event');
    markUserRunStarted('a1');
    expect(registeredRunOrigin('a1')).toBe('user');
    expect(registeredRunOrigin('a2')).toBe('event');
    markUserRunFinished('a1');
    expect(registeredRunOrigin('a1')).toBe('event');
    expect(registeredRunOrigin(null)).toBe('event');
  });

  it('expires stale marks', () => {
    markUserRunStarted('a1', 0);
    expect(registeredRunOrigin('a1', 3 * 60 * 60_000)).toBe('event');
  });

  it('a forged "origin":"user" in the request file does not make a run user-initiated', () => {
    const forged = { runId: 'r', agentId: 'a1', actionType: 'webhook', origin: 'user' };
    expect(trustedRequestOrigin(forged)).toBe('event');
    // No cached policy ⇒ unavailable, but the proactive layer must win first.
    expect(evaluateApprovalRequestPolicy(forged, null).layer).toBe('proactive');
    markUserRunStarted('a1');
    expect(evaluateApprovalRequestPolicy({ ...forged, origin: 'schedule' }, null).layer).not.toBe('proactive');
  });
});

describe('L5: a partially invalid rules array is unavailable, never silently trimmed', () => {
  it('gate input with one invalid rule escalates side effects', () => {
    const p = parseAutonomyPolicy({
      level: 'L2',
      workspaceRoot: '/root/app',
      actionPolicy: {
        enabled: true,
        origin: 'user',
        rules: [
          { id: 'ok', effect: 'ask', match: { capability: 'payment' }, source: 's', createdAt: 1 },
          { id: 'bad', effect: 'allow', match: { capability: 'exec' }, source: 's', createdAt: 1 },
        ],
      },
    }, '/root/app');
    expect(p.actionPolicy?.rulesUnavailable).toBe(true);
    expect(decideAutoAnswer('echo x > src/o.txt', p).answer).toBe('escalate');
  });
});
