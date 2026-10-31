/**
 * "承認なしで実行" × run origin (2026-10-31 on-device finding, build 2739):
 * a flagged agent's attended run had its boundary escalation auto-approved
 * but its final draft-save action approval handed to the human, with no log.
 *
 * Root cause: native AgentActionApprovalBridge.toMap (the minted copy RN
 * reads via readAgentActionApprovalRequest) did not carry the request's
 * `origin`, so trustedRequestOrigin(minted) was always 'event' and the
 * minted re-check refused silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decideActionAutoApproval, type ActionAutoApproveRequestLike } from '@/lib/agent-run-without-approval';
import { trustedRequestOrigin } from '@/lib/agent-policy-approval';
import {
  __resetRunOriginRegistryForTests,
  markUserRunFinished,
  markUserRunStarted,
} from '@/lib/agent-run-origin-registry';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const AGENT = 'agent-mvvx3o28';
const NOW = 1_793_447_919_000;

const drained = (over: Partial<ActionAutoApproveRequestLike> = {}): ActionAutoApproveRequestLike => ({
  runId: `${AGENT}-1793447919-30484`,
  agentId: AGENT,
  actionType: 'draft',
  origin: 'user',
  requestSha256: null,
  actionNonce: null,
  expiresAt: NOW + 300_000,
  ...over,
});
/** What native's readAgentActionApprovalRequest returns, parsed. */
const minted = (over: Partial<ActionAutoApproveRequestLike> = {}): ActionAutoApproveRequestLike => ({
  ...drained(),
  requestSha256: 'a'.repeat(64),
  actionNonce: 'nonce-1',
  ...over,
});

const decide = (
  parsedReq: ActionAutoApproveRequestLike,
  mintedReq: ActionAutoApproveRequestLike | null,
  over: { enabled?: boolean; policyBlocksAutoAccept?: boolean } = {},
) =>
  decideActionAutoApproval(parsedReq, {
    enabled: over.enabled ?? true,
    policyBlocksAutoAccept: over.policyBlocksAutoAccept ?? false,
    originOf: trustedRequestOrigin,
    readMinted: async () => mintedReq,
    now: NOW,
  });

describe('run-without-approval: draft save of a user run', () => {
  beforeEach(() => __resetRunOriginRegistryForTests());

  it('is approved when the minted copy carries the origin (fixed native)', async () => {
    markUserRunStarted(AGENT);
    const verdict = await decide(drained(), minted());
    expect(verdict.ok).toBe(true);
  });

  it('is approved with an older native build whose minted copy has no origin field (the build-2739 case)', async () => {
    markUserRunStarted(AGENT);
    const verdict = await decide(drained(), minted({ origin: null }));
    expect(verdict).toEqual({ ok: true, minted: expect.objectContaining({ runId: drained().runId }) });
  });

  it('a request filed late in the run (action phase) still reads "user" while RN runs the agent', async () => {
    markUserRunStarted(AGENT, NOW - 30 * 60_000); // run started 30 min ago
    expect(trustedRequestOrigin({ agentId: AGENT, origin: 'user' })).toBe('user');
    expect((await decide(drained(), minted())).ok).toBe(true);
  });

  it('a proactive fire of the same agent stays "event"', async () => {
    // No RN mark: an alarm / notification / widget fire.
    expect(await decide(drained(), minted())).toEqual({ ok: false, reason: 'proactive' });
    expect(await decide(drained({ origin: 'schedule' }), minted({ origin: 'schedule' }))).toEqual({ ok: false, reason: 'proactive' });
    // RN mark set, but the request comes from a proactive fire (file origin).
    markUserRunStarted(AGENT);
    expect(await decide(drained({ origin: 'notification' }), minted({ origin: 'notification' }))).toEqual({ ok: false, reason: 'proactive' });
    // Minted bytes say proactive even though the drained read said user.
    expect(await decide(drained(), minted({ origin: 'schedule' }))).toEqual({ ok: false, reason: 'minted-proactive' });
    // The mark is gone once the run finished.
    markUserRunFinished(AGENT);
    expect(await decide(drained(), minted())).toEqual({ ok: false, reason: 'proactive' });
  });

  it('a forged origin alone never reads as "user"', async () => {
    expect(trustedRequestOrigin({ agentId: AGENT, origin: 'user' })).toBe('event');
    markUserRunStarted('some-other-agent');
    expect(await decide(drained(), minted())).toEqual({ ok: false, reason: 'proactive' });
  });
});

describe('run-without-approval: every refusal names its reason', () => {
  beforeEach(() => {
    __resetRunOriginRegistryForTests();
    markUserRunStarted(AGENT);
  });

  it.each([
    ['flag-off', drained(), minted(), { enabled: false }],
    ['policy-ask', drained(), minted(), { policyBlocksAutoAccept: true }],
    ['review-required', drained({ actionType: 'cli' }), minted({ actionType: 'cli' }), {}],
    ['not-local-only', drained({ actionType: 'webhook' }), minted({ actionType: 'webhook' }), {}],
    ['minted-unreadable', drained(), null, {}],
    ['minted-unreadable', drained(), minted({ actionNonce: null }), {}],
    ['minted-expired', drained(), minted({ expiresAt: NOW - 1 }), {}],
    ['minted-mismatch', drained(), minted({ actionType: 'notify' }), {}],
    ['minted-mismatch', drained(), minted({ agentId: 'agent-other' }), {}],
  ] as const)('%s', async (reason, parsedReq, mintedReq, over) => {
    expect(await decide(parsedReq, mintedReq, over)).toEqual({ ok: false, reason });
  });

  it('the RN choke points log the reason (action and escalation)', () => {
    const layout = read('app/_layout.tsx');
    const action = layout.slice(layout.indexOf('const autoApproveActionForFlaggedAgent = async'), layout.indexOf('const drainAgentActionApprovalRequests = async'));
    expect(action).toMatch(/decideActionAutoApproval\(parsed, \{/);
    expect(action).toMatch(/run-without-approval not applied run=\$\{parsed\.runId\} action=\$\{parsed\.actionType\} reason=\$\{decision\.reason\}/);
    const esc = layout.slice(layout.indexOf('const autoApproveEscalation = async'), layout.indexOf('const drainAgentEscalationRequests = async'));
    expect(esc).toMatch(/run-without-approval not applied run=\$\{parsed\.runId\} req=\$\{parsed\.reqId\} reason=\$\{reason\}/);
    expect(esc).toMatch(/notApplied\('proactive'\)/);
    expect(esc).toMatch(/reason=\$\{verdict\.reason\}/);
  });
});

describe('native minted copy carries the origin', () => {
  it('AgentActionApprovalBridge parses and maps "origin"', () => {
    const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/AgentActionApprovalBridge.kt');
    expect(kt).toMatch(/val origin: String\? = null/);
    expect(kt).toMatch(/"origin" to request\.origin,/);
    expect(kt).toMatch(/origin = raw\.optString\("origin"\)\.trim\(\)\.takeIf \{ it\.isNotBlank\(\) \}/);
  });
});

describe('run-log reader ignores non-run-log JSON in the log dir', () => {
  it('only <digits>….json files are read (native-result-notification.json would end the wait early)', () => {
    const src = read('lib/agent-manager.ts');
    const fn = src.slice(src.indexOf('async function readAgentRunLogs('), src.indexOf('async function readAgentRunLogs(') + 2000);
    expect(fn).toMatch(/-name '\[0-9\]\*\.json'/);
    expect(fn).not.toMatch(/-name '\*\.json'/);
  });
});
