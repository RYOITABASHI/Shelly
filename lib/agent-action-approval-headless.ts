/**
 * lib/agent-action-approval-headless.ts — "承認なしで実行" for per-run
 * draft / notify action approvals while RootLayout is NOT mounted.
 *
 * Root cause (2026-11-14, on device): the action-approval drain that answers
 * a flagged agent's draft / notify approval lives in RootLayout's useEffect
 * (app/_layout.tsx drainAgentActionApprovalRequests). When the activity is
 * destroyed (a scrcpy virtual display going away, the system reclaiming a
 * backgrounded activity) ReactHost.onHostDestroy unmounts the root, the
 * effect cleanup clears the 500 ms interval AND unsubscribes the keep-alive
 * tick listener — so nothing answers the request, and the attended Run now
 * ends with "draft action approval timed out" after 5 min even though the
 * agent has run-without-approval ON. The JS runtime, the run-origin registry
 * and the native keep-alive ticker all keep running; only the drain is gone.
 *
 * This module is installed once at bundle load (module scope, not a
 * component), driven by the same native keep-alive tick (which only fires
 * while a user run is registered), and does ONLY what the foreground drain's
 * autoApproveActionForFlaggedAgent does: the same decideActionAutoApproval
 * (flag from the Keystore-backed store, bound to the current definition
 * hash; draft / notify only; trusted origin on the drained AND the minted
 * copy; POLICY-001 deny / draft_only / ask blocks), then the same signed
 * accept. Anything it does not accept is left untouched: no decline, no
 * notification, no new prompt — the foreground drain handles it as before
 * once RootLayout is mounted again.
 *
 * The two drains never run at the same time (shared lock below) and the
 * headless one never runs while the foreground drain is mounted, so a
 * request is never minted by both (each native read mints a fresh nonce).
 */
import {
  AUTO_APPROVABLE_ACTION_TYPES,
  auditCommandText,
  decideActionAutoApproval,
  isIngressTaintedForApproval,
  type RunWithoutApprovalSetting,
} from './agent-run-without-approval';

// ── Shared drain coordination ────────────────────────────────────────────

let foregroundMounts = 0;
/** Drain lease: a token + when it was taken. A holder that never returns
 *  (a destroyed RootLayout's drain stuck on an await) must not block every
 *  later pass, so the lease can be taken over once it is older than
 *  DRAIN_LEASE_MS; a release only counts for the current token. */
export const DRAIN_LEASE_MS = 60_000;
let lease: { token: number; acquiredAt: number } | null = null;
let nextLeaseToken = 1;

/** RootLayout calls this when its action-approval drain is set up; the
 *  returned function is called from the effect cleanup. */
export function markForegroundActionDrainMounted(): () => void {
  foregroundMounts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    foregroundMounts = Math.max(0, foregroundMounts - 1);
  };
}

export function isForegroundActionDrainMounted(): boolean {
  return foregroundMounts > 0;
}

/** One drain pass at a time, across the foreground and headless drains.
 *  Returns the lease token, or null while another live lease is held. */
export function tryAcquireActionApprovalDrain(now: number = Date.now()): number | null {
  if (lease && now - lease.acquiredAt < DRAIN_LEASE_MS) return null;
  const token = nextLeaseToken++;
  lease = { token, acquiredAt: now };
  return token;
}

/** True while `token` is still the current lease (not taken over). */
export function holdsActionApprovalDrain(token: number): boolean {
  return lease?.token === token;
}

/** Releases only the caller's own lease; a stale holder's late release
 *  never frees a lease that was taken over. */
export function releaseActionApprovalDrain(token: number): void {
  if (lease?.token === token) lease = null;
}

// ── Request shape (only what this path reads) ────────────────────────────

export type HeadlessActionRequest = {
  runId: string;
  agentId: string;
  actionType: string;
  preview?: string | null;
  ts?: string | null;
  expiresAt?: number | null;
  requestSha256?: string | null;
  actionNonce?: string | null;
  origin?: string | null;
  command?: string | null;
  destinationHost?: string | null;
  safetyLevel?: string | null;
  /** Same fields the foreground parser hands describeApprovalRequest. */
  intentMode?: string | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
  dmReplyText?: string | null;
};

/** Minimal parser. Returns null for anything that is not a well-formed
 *  draft / notify request — the only types this path may answer. */
export function parseHeadlessActionRequest(raw: unknown): HeadlessActionRequest | null {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!value) return null;
  const str = (field: string) => (typeof value[field] === 'string' ? (value[field] as string).trim() : '');
  const runId = str('runId');
  const agentId = str('agentId');
  const actionType = str('actionType');
  if (!runId || !agentId) return null;
  if (!(AUTO_APPROVABLE_ACTION_TYPES as readonly string[]).includes(actionType)) return null;
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : null;
  return {
    runId,
    agentId,
    actionType,
    preview: str('preview') || null,
    ts: str('ts') || null,
    expiresAt,
    requestSha256: str('requestSha256') || null,
    actionNonce: str('actionNonce') || null,
    origin: typeof value.origin === 'string' ? value.origin : null,
    command: str('command') || null,
    destinationHost: str('destinationHost') || null,
    safetyLevel: str('safetyLevel') || null,
    intentMode: str('intentMode') || null,
    intentTarget: str('intentTarget') || null,
    intentShareText: str('intentShareText') || null,
    dmReplyText: typeof value.dmReplyText === 'string' ? value.dmReplyText : null,
  };
}

// ── Drain ────────────────────────────────────────────────────────────────

export type HeadlessPolicyDecision = 'deny' | 'draft_only' | 'ask' | 'allow' | 'default' | string;

export interface HeadlessActionDrainDeps {
  /** Raw JSON of every `action-*.json` request file currently on disk. */
  listRequests: () => Promise<unknown[]>;
  /** Native readAgentActionApprovalRequest (mints the nonce). */
  readMinted: (runId: string) => Promise<unknown>;
  /** Native resolveAgentActionApproval (signed reply). */
  resolve: (runId: string, decision: 'accept', requestSha256: string, actionNonce: string) => Promise<unknown>;
  /** The CURRENT agent definition (agent store), or null. */
  agentFor: (agentId: string) => unknown | null;
  /** lib/agent-run-without-approval getRunWithoutApprovalSetting. */
  getSetting: (agent: unknown | null) => Promise<RunWithoutApprovalSetting>;
  /** lib/agent-policy-approval trustedRequestOrigin. */
  originOf: (req: { agentId?: string | null; origin?: string | null }) => 'user' | 'event';
  /** POLICY-001 engine on? When on, evaluatePolicy decides blocking. */
  policyEngineEnabled: () => boolean;
  evaluatePolicy: (req: HeadlessActionRequest) => Promise<HeadlessPolicyDecision>;
  audit: (agentId: string, setting: RunWithoutApprovalSetting, what: string) => void;
  log: (line: string) => void;
  now?: () => number;
  /** MCP ingress taint (Inc 5); defaults to isIngressTaintedForApproval (fails closed). */
  isIngressTainted?: (agentId: string) => Promise<boolean>;
}

/** Keys already handled by this drain (accepted or refused), so a request is
 *  minted at most once here. Pruned when its file is gone. */
const attempted = new Set<string>();

const requestKey = (r: HeadlessActionRequest) =>
  JSON.stringify([r.runId, r.agentId, r.actionType, r.ts ?? '', r.requestSha256 ?? '', r.expiresAt ?? 0]);

export type HeadlessDrainOutcome = 'foreground' | 'busy' | 'done';

export async function drainHeadlessRunWithoutApproval(deps: HeadlessActionDrainDeps): Promise<HeadlessDrainOutcome> {
  if (isForegroundActionDrainMounted()) return 'foreground';
  const now = deps.now ?? Date.now;
  const token = tryAcquireActionApprovalDrain(now());
  if (token === null) return 'busy';
  try {
    let raws: unknown[] = [];
    try {
      raws = await deps.listRequests();
    } catch (e) {
      deps.log(`headless drain: list failed (${(e as Error)?.constructor?.name ?? 'Error'})`);
      return 'done';
    }
    const present = new Set<string>();
    for (const raw of raws) {
      // The foreground drain may have mounted meanwhile: stop, it owns them.
      if (isForegroundActionDrainMounted()) break;
      // Lease taken over (this pass outlived DRAIN_LEASE_MS): stop.
      if (!holdsActionApprovalDrain(token)) break;
      const parsed = parseHeadlessActionRequest(raw);
      if (!parsed) continue;
      const key = requestKey(parsed);
      present.add(key);
      if (attempted.has(key)) continue;
      if (parsed.expiresAt && parsed.expiresAt < now()) continue;
      attempted.add(key);
      try {
        let policyBlocks = false;
        if (deps.policyEngineEnabled()) {
          const decision = await deps.evaluatePolicy(parsed);
          if (decision === 'deny' || decision === 'draft_only' || decision === 'ask') policyBlocks = true;
        }
        const agent = deps.agentFor(parsed.agentId);
        const setting = await deps.getSetting(agent);
        // Inc 5: a marked agent's action is never accepted here; the
        // foreground drain declines it with a logged reason once mounted
        // (or the executor's wait times out into a decline).
        const ingressTainted = await (deps.isIngressTainted ?? isIngressTaintedForApproval)(parsed.agentId).catch(() => true);
        const decision = await decideActionAutoApproval(parsed, {
          ingressTainted,
          enabled: setting !== 'off',
          policyBlocksAutoAccept: policyBlocks,
          originOf: deps.originOf,
          readMinted: async () => parseHeadlessActionRequest(await deps.readMinted(parsed.runId)),
          now: now(),
        });
        if (decision.ok === false) {
          deps.log(`headless run-without-approval not applied run=${parsed.runId} action=${parsed.actionType} reason=${decision.reason}`);
          continue;
        }
        const minted = decision.minted;
        if (!minted.requestSha256 || !minted.actionNonce) continue;
        await deps.resolve(minted.runId, 'accept', minted.requestSha256, minted.actionNonce);
        const what = minted.preview ? `${minted.actionType}: ${auditCommandText(minted.preview, 120)}` : minted.actionType;
        deps.audit(minted.agentId, setting, what);
        deps.log(`headless run-without-approval auto-accepted run=${minted.runId} action=${minted.actionType}`);
      } catch (e) {
        deps.log(`headless run-without-approval failed run=${parsed.runId} (${(e as Error)?.constructor?.name ?? 'Error'})`);
      }
    }
    for (const key of attempted) if (!present.has(key)) attempted.delete(key);
    return 'done';
  } finally {
    releaseActionApprovalDrain(token);
  }
}

let installed: (() => void) | null = null;

/**
 * Install once (module scope). `subscribeTick` is lib/agent-keepalive
 * onAgentKeepAliveTick — the native ticker runs only while a user run is
 * registered, so outside attended runs this costs nothing.
 */
export function installHeadlessRunWithoutApprovalDrain(
  subscribeTick: (listener: () => void) => () => void,
  deps: HeadlessActionDrainDeps,
): () => void {
  if (installed) return installed;
  const off = subscribeTick(() => {
    void drainHeadlessRunWithoutApproval(deps).catch(() => undefined);
  });
  installed = () => {
    off();
    installed = null;
  };
  return installed;
}

/** Test hook. */
export function __resetHeadlessActionDrainForTests(): void {
  foregroundMounts = 0;
  lease = null;
  attempted.clear();
  installed?.();
  installed = null;
}
