/**
 * "承認なしで実行" for draft / notify while RootLayout is unmounted
 * (2026-11-14, on device: an attended Run now of an article agent with the
 * option ON ended "draft action approval timed out" after its activity was
 * destroyed — the only drain that answered lived in RootLayout's effect).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  __resetHeadlessActionDrainForTests,
  drainHeadlessRunWithoutApproval,
  installHeadlessRunWithoutApprovalDrain,
  markForegroundActionDrainMounted,
  parseHeadlessActionRequest,
  releaseActionApprovalDrain,
  tryAcquireActionApprovalDrain,
  type HeadlessActionDrainDeps,
} from '@/lib/agent-action-approval-headless';

const NOW = 1_800_000_000_000;

const draftReq = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  agentId: 'agent-a',
  actionType: 'draft',
  preview: 'notes/article.md',
  ts: '2026-11-14T13:10:00Z',
  expiresAt: NOW + 300_000,
  origin: 'user',
  ...over,
});

function makeDeps(over: Partial<HeadlessActionDrainDeps> = {}, files: unknown[] = [draftReq()]) {
  const resolved: Array<[string, string, string, string]> = [];
  const audits: string[] = [];
  const logs: string[] = [];
  let mints = 0;
  const deps: HeadlessActionDrainDeps = {
    listRequests: async () => files,
    readMinted: async (runId) => {
      mints += 1;
      const f = files.find((x) => (x as { runId: string }).runId === runId) as Record<string, unknown> | undefined;
      return f ? { ...f, requestSha256: 'sha-' + runId, actionNonce: `nonce-${mints}` } : null;
    },
    resolve: async (runId, decision, sha, nonce) => {
      resolved.push([runId, decision, sha, nonce]);
      return true;
    },
    agentFor: (id) => ({ id }),
    getSetting: async () => 'standard',
    originOf: () => 'user',
    policyEngineEnabled: () => false,
    evaluatePolicy: async () => 'default',
    audit: (agentId, setting, what) => audits.push(`${agentId}|${setting}|${what}`),
    log: (l) => logs.push(l),
    now: () => NOW,
    ...over,
  };
  return { deps, resolved, audits, logs, mints: () => mints };
}

beforeEach(() => __resetHeadlessActionDrainForTests());

describe('headless run-without-approval drain', () => {
  it('accepts a flagged agent draft with the minted sha/nonce while RootLayout is unmounted', async () => {
    const h = makeDeps();
    expect(await drainHeadlessRunWithoutApproval(h.deps)).toBe('done');
    expect(h.resolved).toEqual([['run-1', 'accept', 'sha-run-1', 'nonce-1']]);
    expect(h.audits).toEqual(['agent-a|standard|draft: notes/article.md']);
  });

  it('mints a request at most once (no re-mint on the next tick)', async () => {
    const h = makeDeps({ getSetting: async () => 'off' });
    await drainHeadlessRunWithoutApproval(h.deps);
    await drainHeadlessRunWithoutApproval(h.deps);
    expect(h.resolved).toEqual([]);
    expect(h.mints()).toBe(0);
    __resetHeadlessActionDrainForTests();
    const h2 = makeDeps({ originOf: (r) => (r.origin === 'user' && h2.mints() === 0 ? 'user' : 'event') });
    await drainHeadlessRunWithoutApproval(h2.deps);
    await drainHeadlessRunWithoutApproval(h2.deps);
    expect(h2.mints()).toBe(1);
    expect(h2.resolved).toEqual([]);
  });

  it('does nothing while the foreground drain is mounted', async () => {
    const release = markForegroundActionDrainMounted();
    const h = makeDeps();
    expect(await drainHeadlessRunWithoutApproval(h.deps)).toBe('foreground');
    expect(h.resolved).toEqual([]);
    release();
    expect(await drainHeadlessRunWithoutApproval(h.deps)).toBe('done');
    expect(h.resolved).toHaveLength(1);
  });

  it('never runs concurrently with another drain pass (shared lock)', async () => {
    expect(tryAcquireActionApprovalDrain()).toBe(true);
    const h = makeDeps();
    expect(await drainHeadlessRunWithoutApproval(h.deps)).toBe('busy');
    expect(h.resolved).toEqual([]);
    releaseActionApprovalDrain();
  });

  it('leaves OFF / proactive / policy-blocked / expired requests untouched (no decline, no prompt)', async () => {
    for (const over of [
      { getSetting: async () => 'off' as const },
      { originOf: () => 'event' as const },
      { policyEngineEnabled: () => true, evaluatePolicy: async () => 'ask' },
      { policyEngineEnabled: () => true, evaluatePolicy: async () => 'deny' },
      { policyEngineEnabled: () => true, evaluatePolicy: async () => 'draft_only' },
      { agentFor: () => null, getSetting: async (a: unknown) => (a ? 'standard' as const : 'off' as const) },
    ]) {
      __resetHeadlessActionDrainForTests();
      const h = makeDeps(over as Partial<HeadlessActionDrainDeps>);
      await drainHeadlessRunWithoutApproval(h.deps);
      expect(h.resolved).toEqual([]);
      expect(h.audits).toEqual([]);
    }
    const expired = makeDeps({}, [draftReq({ expiresAt: NOW - 1 })]);
    await drainHeadlessRunWithoutApproval(expired.deps);
    expect(expired.resolved).toEqual([]);
  });

  it('only answers draft / notify — never review-required or outward-sending types', async () => {
    for (const actionType of ['webhook', 'api-call', 'cli', 'intent', 'dm-reply', 'browser-pane', 'social-post']) {
      __resetHeadlessActionDrainForTests();
      const h = makeDeps({}, [draftReq({ actionType })]);
      await drainHeadlessRunWithoutApproval(h.deps);
      expect(h.resolved).toEqual([]);
      expect(h.mints()).toBe(0);
    }
    const notify = makeDeps({}, [draftReq({ actionType: 'notify', preview: '' })]);
    await drainHeadlessRunWithoutApproval(notify.deps);
    expect(notify.resolved).toHaveLength(1);
  });

  it('refuses when the minted copy differs (type / agent) from the drained one', async () => {
    const h = makeDeps({
      readMinted: async () => ({ ...draftReq({ agentId: 'agent-b' }), requestSha256: 's', actionNonce: 'n' }),
    });
    await drainHeadlessRunWithoutApproval(h.deps);
    expect(h.resolved).toEqual([]);
    const h2 = makeDeps({
      readMinted: async () => ({ ...draftReq({ actionType: 'webhook' }), requestSha256: 's', actionNonce: 'n' }),
    });
    await drainHeadlessRunWithoutApproval(h2.deps);
    expect(h2.resolved).toEqual([]);
  });

  it('install is idempotent and drives the drain from the keep-alive tick', async () => {
    const listeners = new Set<() => void>();
    const subscribe = (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    };
    const h = makeDeps();
    installHeadlessRunWithoutApprovalDrain(subscribe, h.deps);
    installHeadlessRunWithoutApprovalDrain(subscribe, h.deps);
    expect(listeners.size).toBe(1);
    for (const l of listeners) l();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.resolved).toHaveLength(1);
  });

  it('parser rejects malformed requests', () => {
    expect(parseHeadlessActionRequest(null)).toBeNull();
    expect(parseHeadlessActionRequest({ runId: 'r', actionType: 'draft' })).toBeNull();
    expect(parseHeadlessActionRequest({ runId: 'r', agentId: 'a', actionType: 'cli' })).toBeNull();
    expect(parseHeadlessActionRequest({ runId: 'r', agentId: 'a', actionType: 'draft' })?.actionType).toBe('draft');
  });
});

describe('app/_layout.tsx wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app/_layout.tsx'), 'utf8');

  it('installs the headless drain at module scope (outside RootLayout)', () => {
    const install = src.indexOf('installHeadlessRunWithoutApprovalDrain(onAgentKeepAliveTick');
    const component = src.indexOf('export default function RootLayout');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(component);
  });

  it('the foreground drain shares the lock and marks itself mounted / unmounted', () => {
    expect(src).toContain('if (!tryAcquireActionApprovalDrain()) return;');
    expect(src).toContain('releaseActionApprovalDrain();');
    expect(src).toContain('const releaseForegroundActionDrain = markForegroundActionDrainMounted();');
    expect(src).toContain('releaseForegroundActionDrain();');
    expect(src).not.toContain('isDrainingActionApprovals');
  });
});
