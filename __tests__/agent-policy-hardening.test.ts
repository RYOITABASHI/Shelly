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

describe('re-review: policy-write deny is NARROW with the flag OFF, WIDE with it ON', () => {
  const root = '/home/u/work';
  const gate = (cmd: string, flagOn: boolean) => {
    const p = parseAutonomyPolicy(
      {
        level: 'L3',
        workspaceRoot: root,
        ...(flagOn ? { actionPolicy: { enabled: true, origin: 'user', rules: [], homeDir: '/home/u' } } : {}),
      },
      root,
    );
    return decideAutoAnswer(cmd, p).verdict;
  };
  const isPolicyWrite = (cmd: string, flagOn: boolean) => {
    const v = gate(cmd, flagOn);
    return v.decision === 'deny' && v.signals.includes('policy-write');
  };

  it.each([
    'grep x ~/.shelly/agents/logs/agent1/run.log > out.txt',
    "node -e \"console.log(1)\" ~/.shelly/agents/logs/agent1/run.log",
    'echo hi > ~/.shelly/agents/agent1/output.md',
    'mkdir -p ~/.shelly/agents/agent1/out',
    'cat ~/.shelly/agents/agent1.json',
    "node -e \"console.log(require(process.env.HOME+'/.shelly/agents/agent1.json').name)\"",
    'tail -n 50 ~/.shelly/agents/logs/agent1/agent-driver-audit.jsonl',
  ])('flag OFF: legit %j is NOT a policy-write (no regression)', (cmd) => {
    expect(isPolicyWrite(cmd, false)).toBe(false);
  });

  it.each([
    'rm ~/.shelly/agents/policy.json',
    'cd ~/.shelly/agents && rm policy.json',
    "sed -i 's/deny/ask/' ~/.shelly/agents/policy.json",
    'truncate -s0 ~/.shelly/agents/policy.json',
    'echo {} > ~/.shelly/agents/policy.json',
    "python3 -c \"import os; os.remove('/home/u/.shelly/agents/policy.json')\"",
    'rm ~/.shelly/agents/agent1.json',
    'mv ~/.shelly/agents/agent1.json /tmp/',
    'echo {} > ~/.shelly/agents/agent1.json',
    'rm /data/data/dev.shelly.terminal/shared_prefs/shelly_agent_policy.xml',
    'rm /data/data/dev.shelly.terminal/shared_prefs/SecureStore.xml',
  ])('policy / agent-definition / seal mutation %j is denied in BOTH modes', (cmd) => {
    expect(isPolicyWrite(cmd, false)).toBe(true);
    expect(isPolicyWrite(cmd, true)).toBe(true);
  });

  it.each([
    'rm -rf ~/.shelly/agents',
    'cd ~/.shelly; cd agents; rm -rf logs',
    'find ~/.shelly/agents -name "*.json" -delete',
    'rm -rf /data/data/dev.shelly.terminal/shared_prefs',
  ])('flag ON only: wide form %j is denied', (cmd) => {
    expect(isPolicyWrite(cmd, true)).toBe(true);
  });
});

describe('policy-write hard-deny covers deletes / rewrites of the agents config dir (M1)', () => {
  const ctx = { workspaceRoot: '/home/u/work', level: 'L3' as const, policyPath: '.shelly/agents/policy.json', strictPolicyPaths: true };
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
  });

  it('re-review M2: user only when the registry AND the file both say user (tighter of two)', () => {
    markUserRunStarted('a1');
    const req = (origin: string | null) => ({ runId: 'r', agentId: 'a1', actionType: 'webhook', origin });
    expect(trustedRequestOrigin(req('user'))).toBe('user');
    expect(trustedRequestOrigin(req(' USER '))).toBe('user');
    // A proactive fire landing while RN's mark is still set:
    expect(trustedRequestOrigin(req('schedule'))).toBe('event');
    expect(trustedRequestOrigin(req('notification'))).toBe('event');
    expect(trustedRequestOrigin(req(null))).toBe('event');
    expect(trustedRequestOrigin(req('widget'))).toBe('event');
    expect(evaluateApprovalRequestPolicy(req('schedule'), null).layer).toBe('proactive');
    expect(evaluateApprovalRequestPolicy(req('user'), null).layer).not.toBe('proactive');
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
