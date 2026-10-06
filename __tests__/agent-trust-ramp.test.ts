import { PolicyRule, describeApprovalRequest, describeCommandAction } from '@/lib/agent-action-policy';
import {
  EMPTY_TRUST_STATE,
  TRUST_RAMP_SUPPRESS_MS,
  TRUST_RAMP_WINDOW_MS,
  TrustState,
  grantTrustAllow,
  parseTrustState,
  recordApprovalOutcome,
  revokeTrustAllow,
  suppressTrustOffer,
  trustKeyOf,
  verifyTrustProposal,
} from '@/lib/agent-trust-ramp';

const cli = (command: string, origin = 'user', agentId = 'agent1') =>
  describeApprovalRequest({ actionType: 'cli', command, agentId, origin });
/** Exact-command trust key for a user-origin cli action. */
const K = (command: string, agentId = 'agent1'): string => {
  const key = trustKeyOf(cli(command, 'user', agentId));
  if (!key) throw new Error(`ineligible: ${command}`);
  return key;
};

function approveN(state: TrustState, n: number, desc = cli('mkdir -p build'), start = 1000, threshold?: number) {
  let s = state;
  let offer = false;
  for (let i = 0; i < n; i += 1) {
    const out = recordApprovalOutcome(s, desc, 'accept', start + i, { threshold });
    s = out.state;
    offer = out.offer;
  }
  return { state: s, offer };
}

describe('trust ramp — eligibility (trustKeyOf)', () => {
  it('keys a user-origin cli action by an exact-command hash + agent', () => {
    expect(K('mkdir -p build')).toMatch(/^cli\|[0-9a-f]{64}\|agent1$/);
    // A read-only command run as a cli ACTION is still an executed process.
    expect(trustKeyOf(cli('git -C x status --short'))).toMatch(/^cli\|[0-9a-f]{64}\|agent1$/);
    expect(trustKeyOf(cli('git -C x status --short'))).not.toBe(trustKeyOf(cli('git status')));
  });

  it('verifyTrustProposal re-derives the key from command + agent (L2)', () => {
    expect(verifyTrustProposal({ key: K('mkdir -p build'), command: 'mkdir -p build', agentId: 'agent1' })).toBe(true);
    expect(verifyTrustProposal({ key: K('mkdir -p build'), command: 'mkdir -p build; id', agentId: 'agent1' })).toBe(false);
    expect(verifyTrustProposal({ key: K('mkdir -p build'), command: 'mkdir -p build', agentId: 'agent2' })).toBe(false);
    expect(verifyTrustProposal({ key: K('mkdir -p build') })).toBe(false);
    expect(verifyTrustProposal({ key: 'cli|mkdir -p build|agent1', command: 'mkdir -p build', agentId: 'agent1' })).toBe(false);
  });

  it('never for proactive origins', () => {
    for (const o of ['schedule', 'notification', 'boot', 'event', '', 'nonsense']) {
      expect(trustKeyOf(cli('mkdir -p build', o))).toBeNull();
    }
  });

  it('never for CRITICAL/HIGH, secrets, payments, posting, messaging, network, git push', () => {
    expect(trustKeyOf(cli('rm -rf /'))).toBeNull();
    expect(trustKeyOf(cli('cat ~/.shelly/agents/.env'))).toBeNull();
    expect(trustKeyOf(cli('node pay-invoice.js'))).toBeNull();
    expect(trustKeyOf(cli('git push origin main'))).toBeNull();
    expect(trustKeyOf(cli('curl https://example.com'))).toBeNull();
    for (const actionType of ['social-post', 'dm-reply', 'webhook', 'api-call', 'browser-pane']) {
      expect(trustKeyOf(describeApprovalRequest({ actionType, agentId: 'a', origin: 'user' }))).toBeNull();
    }
    expect(trustKeyOf(describeApprovalRequest({ actionType: 'intent', intentMode: 'share', agentId: 'a', origin: 'user' }))).toBeNull();
  });

  it('never for read-only actions', () => {
    expect(trustKeyOf(describeApprovalRequest({ actionType: 'draft', agentId: 'a', origin: 'user' }))).toBeNull();
    expect(trustKeyOf(describeCommandAction({ command: 'ls', origin: 'user', cwd: '/w' }))).toBeNull();
  });
});

describe('trust ramp — counting', () => {
  it('offers exactly when the threshold (default 3) is reached', () => {
    expect(approveN(EMPTY_TRUST_STATE, 1).offer).toBe(false);
    expect(approveN(EMPTY_TRUST_STATE, 2).offer).toBe(false);
    const three = approveN(EMPTY_TRUST_STATE, 3);
    expect(three.offer).toBe(true);
    expect(three.state.counters[K('mkdir -p build')].approvals).toBe(3);
  });

  it('the threshold is configurable', () => {
    expect(approveN(EMPTY_TRUST_STATE, 2, cli('mkdir -p build'), 1000, 2).offer).toBe(true);
    expect(approveN(EMPTY_TRUST_STATE, 4, cli('mkdir -p build'), 1000, 5).offer).toBe(false);
  });

  it('a decline resets the count to zero ("no denials")', () => {
    const two = approveN(EMPTY_TRUST_STATE, 2).state;
    const declined = recordApprovalOutcome(two, cli('mkdir -p build'), 'decline', 5000).state;
    expect(declined.counters[K('mkdir -p build')].approvals).toBe(0);
    expect(approveN(declined, 2, cli('mkdir -p build'), 6000).offer).toBe(false);
    expect(approveN(declined, 3, cli('mkdir -p build'), 6000).offer).toBe(true);
  });

  it('classes are counted independently (command class and agent scope)', () => {
    let s = approveN(EMPTY_TRUST_STATE, 2, cli('mkdir -p build')).state;
    s = approveN(s, 2, cli('touch notes.txt')).state;
    s = approveN(s, 2, cli('mkdir -p build', 'user', 'agent2')).state;
    expect(s.counters[K('mkdir -p build')].approvals).toBe(2);
    expect(s.counters[K('touch notes.txt')].approvals).toBe(2);
    expect(s.counters[K('mkdir -p build', 'agent2')].approvals).toBe(2);
  });

  it('approvals older than the window restart the count', () => {
    const two = approveN(EMPTY_TRUST_STATE, 2, cli('mkdir -p build'), 0).state;
    const late = recordApprovalOutcome(two, cli('mkdir -p build'), 'accept', TRUST_RAMP_WINDOW_MS + 10);
    expect(late.state.counters[K('mkdir -p build')].approvals).toBe(1);
    expect(late.offer).toBe(false);
  });

  it('excluded classes never touch the state', () => {
    const out = recordApprovalOutcome(EMPTY_TRUST_STATE, cli('git push'), 'accept', 1);
    expect(out.key).toBeNull();
    expect(out.state).toBe(EMPTY_TRUST_STATE);
  });

  it('no offer while suppressed, once allowed, or when a user rule covers the action', () => {
    const suppressed = suppressTrustOffer(EMPTY_TRUST_STATE, K('mkdir -p build'), 1000);
    expect(approveN(suppressed, 5, cli('mkdir -p build'), 2000).offer).toBe(false);
    expect(approveN(suppressed, 3, cli('mkdir -p build'), 1000 + TRUST_RAMP_SUPPRESS_MS + 1).offer).toBe(true);

    const allowed = grantTrustAllow(EMPTY_TRUST_STATE, K('mkdir -p build'), 'mkdir -p build', 1, 'a1');
    expect(approveN(allowed, 3).offer).toBe(false);

    const askExec: PolicyRule = { id: 'r1', effect: 'ask', match: { capability: 'exec' }, source: 's', createdAt: 1 };
    let s = EMPTY_TRUST_STATE;
    let offer = false;
    for (let i = 0; i < 3; i += 1) {
      const out = recordApprovalOutcome(s, cli('mkdir -p build'), 'accept', i, { rules: [askExec] });
      s = out.state;
      offer = out.offer;
    }
    expect(offer).toBe(false);
  });
});

describe('trust ramp — grant / revoke / parse', () => {
  it('grant is idempotent per key and clears the counter; revoke removes by id', () => {
    const counted = approveN(EMPTY_TRUST_STATE, 3).state;
    const g = grantTrustAllow(counted, K('mkdir -p build'), 'mkdir -p build', 10, 'a1');
    expect(g.allows).toHaveLength(1);
    expect(g.counters[K('mkdir -p build')]).toBeUndefined();
    expect(grantTrustAllow(g, K('mkdir -p build'), 'mkdir -p build', 11, 'a2').allows).toHaveLength(1);
    const r = revokeTrustAllow(g, 'a1');
    expect(r.removed?.id).toBe('a1');
    expect(r.state.allows).toHaveLength(0);
    expect(revokeTrustAllow(g, 'zzz').removed).toBeNull();
  });

  it('grant refuses malformed keys', () => {
    expect(grantTrustAllow(EMPTY_TRUST_STATE, 'not a key', 'x', 1, 'a1').allows).toHaveLength(0);
  });

  it('parseTrustState drops malformed and excluded-kind entries (hand-edited file)', () => {
    const parsed = parseTrustState({
      counters: { [K('mkdir -p build')]: { approvals: 2, firstAt: 1, lastAt: 2, label: 'x' }, bad: { approvals: 1 } },
      allows: [
        { id: 'a1', key: K('mkdir -p build'), label: 'mkdir -p build', createdAt: 1 },
        { id: 'a2', key: 'social-post|social-post|agent1', label: 'post', createdAt: 1 },
        { id: 'a3', key: K('mkdir -p build'), label: 'dup', createdAt: 1 },
        { id: 'bad id', key: 'cli|ls|a', label: 'x', createdAt: 1 },
      ],
    });
    expect(Object.keys(parsed.counters)).toEqual([K('mkdir -p build')]);
    expect(parsed.allows.map((a) => a.id)).toEqual(['a1']);
    expect(parseTrustState('junk')).toEqual({ counters: {}, allows: [] });
  });
});
