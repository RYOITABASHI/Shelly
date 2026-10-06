import {
  PolicyRule,
  PolicyState,
  commandCapabilities,
  commandClassOf,
  compilePolicyRuleLines,
  describeApprovalRequest,
  describeCommandAction,
  evaluateActionPolicy,
  evaluateCompiledLines,
  isProactiveOrigin,
  normalizeDomain,
  normalizeRulePath,
  normalizeRunOrigin,
  parseStoredRules,
  ruleMatches,
  validatePolicyRule,
} from '@/lib/agent-action-policy';
import { trustKeyOf } from '@/lib/agent-trust-ramp';

const rule = (effect: PolicyRule['effect'], match: PolicyRule['match'], id = `r-${effect}`): PolicyRule => ({
  id,
  effect,
  match,
  source: `${effect} rule`,
  createdAt: 1,
});

const state = (rules: PolicyRule[], extra: Partial<PolicyState> = {}): PolicyState => ({
  enabled: true,
  rules,
  homeDir: '/home/u',
  trustKeyOf,
  ...extra,
});

describe('run origin (A) — fail-closed', () => {
  it('only user and widget are non-proactive', () => {
    expect(isProactiveOrigin('user')).toBe(false);
    expect(isProactiveOrigin('widget')).toBe(false);
    expect(isProactiveOrigin(' USER ')).toBe(false);
    for (const o of ['schedule', 'notification', 'boot', 'event']) expect(isProactiveOrigin(o)).toBe(true);
  });

  it('missing / unknown / forged / non-string origin is proactive', () => {
    for (const o of [undefined, null, '', 'admin', 'user;rm', 'users', 1, {}, ['user']]) {
      expect(isProactiveOrigin(o)).toBe(true);
    }
    expect(normalizeRunOrigin('garbage')).toBe('unknown');
  });
});

describe('rule schema validation (C) — tighten-only, closed', () => {
  it('accepts the three tightening effects', () => {
    for (const effect of ['ask', 'deny', 'draft_only']) {
      expect(validatePolicyRule({ effect, match: { capability: 'post' } }).ok).toBe(true);
    }
  });

  it('rejects every grant-shaped effect', () => {
    for (const effect of ['allow', 'grant', 'permit', 'auto', '', null, 1, 'ALLOW']) {
      expect(validatePolicyRule({ effect, match: { capability: 'exec' } }).ok).toBe(false);
    }
  });

  it('rejects unknown top-level / match keys (no smuggled "allow")', () => {
    expect(validatePolicyRule({ effect: 'ask', match: { capability: 'exec' }, allow: true }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'ask', match: { capability: 'exec', allow: ['cli'] } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'ask', match: { capability: 'root' } }).ok).toBe(false);
  });

  it('rejects an empty match and malformed values', () => {
    expect(validatePolicyRule({ effect: 'deny', match: {} }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny' }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { domain: 'not a host' } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { pathPrefix: 'relative/x' } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { pathPrefix: '~/a/../../etc' } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { keywords: ['a|b'] } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { keywords: ['$(x)'] } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { keywords: ['ok', 'x'.repeat(41)] } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { pathPrefix: '~/a', outsidePath: '~/b' } }).ok).toBe(false);
    expect(validatePolicyRule({ effect: 'deny', match: { capability: 'post', outsidePath: '~/w' } }).ok).toBe(false);
    expect(validatePolicyRule('deny').ok).toBe(false);
    expect(validatePolicyRule([]).ok).toBe(false);
  });

  it('normalises domains and paths', () => {
    expect(normalizeDomain('https://www.X.com/home?q=1')).toBe('x.com');
    expect(normalizeDomain('api.github.com')).toBe('api.github.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeRulePath('~/work/')).toBe('~/work');
    expect(normalizeRulePath('/sdcard//Docs')).toBe('/sdcard/Docs');
    const v = validatePolicyRule({ effect: 'ask', match: { keywords: ['  PAY ', 'pay'] } });
    expect(v.ok && v.rule.match.keywords).toEqual(['pay']);
  });

  it('parseStoredRules drops invalid entries instead of repairing them', () => {
    const rules = parseStoredRules([
      { id: 'ok1', effect: 'ask', match: { capability: 'payment' }, source: 's', createdAt: 2 },
      { id: 'bad1', effect: 'allow', match: { capability: 'exec' } },
      { id: 'bad id!', effect: 'deny', match: { capability: 'exec' } },
      'junk',
      null,
    ]);
    expect(rules.map((r) => r.id)).toEqual(['ok1']);
    expect(parseStoredRules('nope')).toEqual([]);
  });
});

describe('command classification', () => {
  it('classifies reads, writes, network, push, payment and secrets', () => {
    expect(commandCapabilities('ls -la')).toEqual(['read']);
    expect(commandCapabilities('git status')).toEqual(['read']);
    expect(commandCapabilities('rm -rf build')).toEqual(expect.arrayContaining(['fs-write', 'exec']));
    expect(commandCapabilities('echo hi > out.txt')).toContain('fs-write');
    expect(commandCapabilities('find . -delete')).toContain('fs-write');
    expect(commandCapabilities('git push origin main')).toContain('git-push');
    expect(commandCapabilities('curl -X POST https://api.x.com/2/tweets -d @b')).toEqual(expect.arrayContaining(['network', 'post']));
    expect(commandCapabilities('curl https://example.com')).toContain('network');
    expect(commandCapabilities('node pay-invoice.js')).toContain('payment');
    expect(commandCapabilities('cat ~/.shelly/agents/.env')).toContain('secret');
    expect(commandCapabilities('ls; rm x')).not.toEqual(['read']);
    expect(commandCapabilities('python3 script.py')).toContain('exec');
  });

  it('derives a normalised command class', () => {
    expect(commandClassOf('git -C repo push origin')).toBe('git push');
    expect(commandClassOf('/usr/bin/ls -la /tmp')).toBe('ls');
    expect(commandClassOf('FOO=1 npm test')).toBe('npm test');
    expect(commandClassOf('sudo make build')).toBe('make build');
    expect(commandClassOf('')).toBe('');
  });

  it('describes approval requests with capabilities and the WORSE danger level', () => {
    const d = describeApprovalRequest({ actionType: 'cli', command: 'rm -rf /', safetyLevel: 'LOW', agentId: 'a1', origin: 'user' });
    expect(d.dangerLevel).toBe('CRITICAL');
    expect(describeApprovalRequest({ actionType: 'social-post', destinationHost: 'api.x.com', origin: 'user' }).hosts).toContain('api.x.com');
    expect(describeApprovalRequest({ actionType: 'webhook', preview: '請求書の支払いを実行', origin: 'user' }).capabilities).toContain('payment');
    expect(describeApprovalRequest({ actionType: 'mystery' }).capabilities).toEqual(['exec']);
    expect(describeApprovalRequest({ actionType: 'cli', command: 'ls' }).capabilities).toContain('exec');
  });
});

describe('rule matching', () => {
  const home = '/home/u';
  const cmd = (command: string, cwd = '/home/u/work/repo') => describeCommandAction({ command, origin: 'user', cwd });

  it('outsidePath matches only side effects whose targets leave the prefix', () => {
    const r = rule('deny', { capability: 'fs-write', outsidePath: '~/work' });
    expect(ruleMatches(r, cmd('touch /home/u/work/a.txt'), home)).toBe(false);
    expect(ruleMatches(r, cmd('touch /home/u/other/a.txt'), home)).toBe(true);
    expect(ruleMatches(r, cmd('touch ~/notes.md'), home)).toBe(true);
    // No explicit path ⇒ the cwd stands in.
    expect(ruleMatches(r, cmd('npm install', '/home/u/work/repo'), home)).toBe(false);
    expect(ruleMatches(r, cmd('npm install', '/sdcard/x'), home)).toBe(true);
    // Lexical traversal cannot escape the check.
    expect(ruleMatches(r, cmd('touch /home/u/work/../secret.txt'), home)).toBe(true);
    // Pure reads never violate a write rule.
    expect(ruleMatches(r, cmd('cat /etc/hosts'), home)).toBe(false);
  });

  it('domain matches the host and its subdomains only', () => {
    const r = rule('draft_only', { capability: 'post', domain: 'x.com' });
    const req = (host: string) => describeApprovalRequest({ actionType: 'social-post', destinationHost: host, origin: 'user' });
    expect(ruleMatches(r, req('x.com'))).toBe(true);
    expect(ruleMatches(r, req('api.x.com'))).toBe(true);
    expect(ruleMatches(r, req('notx.com'))).toBe(false);
    expect(ruleMatches(r, req('x.com.evil.io'))).toBe(false);
  });

  it('a network rule also covers post/message/git-push', () => {
    const r = rule('ask', { capability: 'network' });
    expect(ruleMatches(r, describeApprovalRequest({ actionType: 'dm-reply', origin: 'user' }))).toBe(true);
    expect(ruleMatches(r, cmd('git push'))).toBe(true);
    expect(ruleMatches(r, cmd('ls'))).toBe(false);
  });

  it('keywords are case-insensitive OR', () => {
    const r = rule('ask', { keywords: ['invoice', '支払'] });
    expect(ruleMatches(r, describeApprovalRequest({ actionType: 'webhook', preview: 'Send INVOICE now', origin: 'user' }))).toBe(true);
    expect(ruleMatches(r, describeApprovalRequest({ actionType: 'webhook', preview: '明日の支払い', origin: 'user' }))).toBe(true);
    expect(ruleMatches(r, describeApprovalRequest({ actionType: 'webhook', preview: 'weather', origin: 'user' }))).toBe(false);
  });
});

describe('precedence matrix: deny > proactive > ask > trust allow > default', () => {
  const cliReq = (origin: string, command = 'npm test') =>
    describeApprovalRequest({ actionType: 'cli', command, agentId: 'agent1', origin });
  const allowFor = (origin = 'user', command = 'npm test') => ({ id: 'a1', key: trustKeyOf(cliReq(origin, command)) || 'none' });

  const denyExec = rule('deny', { capability: 'exec' }, 'deny1');
  const draftExec = rule('draft_only', { capability: 'exec' }, 'draft1');
  const askExec = rule('ask', { capability: 'exec' }, 'ask1');

  it('disabled ⇒ no opinion at all', () => {
    expect(evaluateActionPolicy(cliReq('schedule'), { enabled: false, rules: [denyExec] }).decision).toBe('default');
  });

  it('deny rule beats everything (proactive, ask, trust allow)', () => {
    const v = evaluateActionPolicy(cliReq('user'), state([askExec, denyExec], { trustAllows: [allowFor()] }));
    expect(v).toMatchObject({ decision: 'deny', layer: 'deny-rule', ruleId: 'deny1' });
    expect(evaluateActionPolicy(cliReq('schedule'), state([denyExec])).decision).toBe('deny');
  });

  it('deny beats draft_only; draft_only beats proactive and ask', () => {
    expect(evaluateActionPolicy(cliReq('user'), state([draftExec, denyExec])).decision).toBe('deny');
    expect(evaluateActionPolicy(cliReq('schedule'), state([draftExec, askExec])).decision).toBe('draft_only');
  });

  it('proactive floor beats ask rules and trust allows', () => {
    const v = evaluateActionPolicy(cliReq('notification'), state([askExec], { trustAllows: [allowFor()] }));
    expect(v).toMatchObject({ decision: 'ask', layer: 'proactive' });
    expect(evaluateActionPolicy(cliReq(''), state([], { trustAllows: [allowFor()] })).layer).toBe('proactive');
  });

  it('proactive floor never blocks read-only actions', () => {
    const notify = describeApprovalRequest({ actionType: 'notify', origin: 'schedule' });
    const draft = describeApprovalRequest({ actionType: 'draft', origin: 'boot' });
    expect(evaluateActionPolicy(notify, state([])).decision).toBe('default');
    expect(evaluateActionPolicy(draft, state([])).decision).toBe('default');
    expect(evaluateActionPolicy(describeCommandAction({ command: 'cat README.md', origin: 'schedule' }), state([])).decision).toBe('default');
  });

  it('ask rule beats a trust allow', () => {
    const v = evaluateActionPolicy(cliReq('user'), state([askExec], { trustAllows: [allowFor()] }));
    expect(v).toMatchObject({ decision: 'ask', layer: 'ask-rule', ruleId: 'ask1' });
  });

  it('trust allow applies only for its exact class, user origin, non-HIGH/CRITICAL', () => {
    expect(evaluateActionPolicy(cliReq('user'), state([], { trustAllows: [allowFor()] }))).toMatchObject({ decision: 'allow', layer: 'trust-allow' });
    // Different command class ⇒ no allow.
    expect(evaluateActionPolicy(cliReq('user', 'npm publish'), state([], { trustAllows: [allowFor()] })).decision).toBe('default');
    // Same class but now classified CRITICAL ⇒ no allow (re-checked at use time).
    const forged = { id: 'a2', key: 'cli|rm|agent1' };
    expect(evaluateActionPolicy(cliReq('user', 'rm -rf /'), state([], { trustAllows: [forged] })).decision).toBe('default');
  });

  it('unreadable policy file escalates side effects and ignores trust allows', () => {
    const v = evaluateActionPolicy(cliReq('user'), state([], { rulesUnavailable: true, trustAllows: [allowFor()] }));
    expect(v.decision).toBe('ask');
    expect(evaluateActionPolicy(describeApprovalRequest({ actionType: 'notify', origin: 'user' }), state([], { rulesUnavailable: true })).decision).toBe('default');
  });

  it('draft_only does not constrain read-only actions', () => {
    const r = rule('draft_only', { keywords: ['report'] });
    expect(evaluateActionPolicy(describeApprovalRequest({ actionType: 'draft', preview: 'report', origin: 'user' }), state([r])).decision).toBe('default');
    expect(evaluateActionPolicy(describeApprovalRequest({ actionType: 'webhook', preview: 'report', origin: 'user' }), state([r])).decision).toBe('draft_only');
  });
});

describe('compiled executor lines', () => {
  it('compiles capability/domain/keyword rules to effect|type|domain|keyword lines', () => {
    const lines = compilePolicyRuleLines([
      rule('draft_only', { capability: 'post', domain: 'x.com' }),
      rule('ask', { capability: 'payment' }),
      rule('deny', { capability: 'fs-write', outsidePath: '~/work' }),
    ]);
    expect(lines).toContain('draft_only|social-post|x.com|');
    expect(lines).toContain('draft_only|webhook|x.com|');
    expect(lines).toContain('ask|webhook||支払');
    // Path-scoped rules compile to ask:cli (the codex gate enforces the precise deny).
    expect(lines).toContain('ask|cli||');
    expect(lines.some((l) => l.startsWith('deny|'))).toBe(false);
    for (const l of lines) expect(l.split('|')).toHaveLength(4);
  });

  it('evaluateCompiledLines picks the strongest matching effect', () => {
    const lines = ['ask|webhook||', 'draft_only|webhook|x.com|', 'deny|webhook||secretword'];
    expect(evaluateCompiledLines(lines, 'webhook', 'hooks.slack.com', 'hello')).toBe('ask');
    expect(evaluateCompiledLines(lines, 'webhook', 'api.x.com', 'hello')).toBe('draft_only');
    expect(evaluateCompiledLines(lines, 'webhook', 'api.x.com', 'the SECRETWORD')).toBe('deny');
    expect(evaluateCompiledLines(lines, 'cli', 'api.x.com', 'secretword')).toBe('');
    expect(evaluateCompiledLines(['allow|cli||', 'grant|cli||'], 'cli', '', '')).toBe('');
  });
});
