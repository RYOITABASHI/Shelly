/**
 * lib/agent-policy-approval.ts — POLICY-001 at the RN action-approval choke
 * point (app/_layout.tsx drainAgentActionApprovalRequests /
 * resolvePendingAgentActionApproval).
 *
 * This is the only enforcement point that sees the FULL approval request, so
 * it applies the fine-grained evaluator (lib/agent-action-policy.ts):
 *   - deny / draft_only rule match ⇒ the request is declined without a prompt;
 *   - proactive origin or an ask rule ⇒ never auto-accepted (autoAccept off);
 *   - trust-ramp allow ⇒ a `cli` request is accepted without a prompt — the
 *     ONLY place a trust allow is ever honoured (executors never see allows).
 * And it is where human decisions are COUNTED for the trust ramp (B).
 *
 * Origin (security review M2): NEVER the request file's own `origin` field —
 * the executor writes that file, so the agent's uid could forge it. The
 * origin is lib/agent-run-origin-registry.ts's record of which agents RN is
 * itself running for a human right now; everything else is proactive.
 */
import {
  ApprovalRequestLike,
  PolicyVerdict,
  describeApprovalRequest,
  evaluateActionPolicy,
} from '@/lib/agent-action-policy';
import { TRUST_RAMP_THRESHOLD_DEFAULT, recordApprovalOutcome, trustCommandOf, trustKeyOf, trustLabelOf } from '@/lib/agent-trust-ramp';
import { registeredRunOrigin } from '@/lib/agent-run-origin-registry';
import { ShellRunner, getCachedUserPolicy, loadUserPolicy, mutateUserPolicy } from '@/lib/agent-user-policy-store';
import { logInfo, logWarn } from '@/lib/debug-logger';

/** The trusted origin for a request: RN's own run registry, never the file. */
export function trustedRequestOrigin(req: { agentId?: string | null }): 'user' | 'event' {
  return registeredRunOrigin(req.agentId);
}

/** Make sure the policy cache is warm (cheap no-op once loaded). */
export async function ensureUserPolicyLoaded(run: ShellRunner): Promise<void> {
  if (!getCachedUserPolicy()) await loadUserPolicy(run);
}

/**
 * Evaluate one approval request against the cached user policy. A cold cache
 * is treated as "rules unavailable": side effects escalate, no trust allow.
 * `sealedAllowKeys` is the SecureStore seal (lib/agent-trust-allow-seal.ts):
 * a trust allow is honoured only when its key is in BOTH the file and the
 * seal; null (seal not loaded) ⇒ no trust allow at all.
 */
export function evaluateApprovalRequestPolicy(
  req: ApprovalRequestLike & { runId: string },
  sealedAllowKeys: ReadonlySet<string> | null,
  homeDir = '',
): PolicyVerdict {
  const cached = getCachedUserPolicy();
  const desc = describeApprovalRequest({ ...req, origin: trustedRequestOrigin(req) });
  const allows = (cached?.data.trust.allows ?? []).filter((a) => !!sealedAllowKeys && sealedAllowKeys.has(a.key));
  return evaluateActionPolicy(desc, {
    enabled: true,
    rules: cached?.data.rules ?? [],
    trustAllows: allows,
    homeDir,
    rulesUnavailable: !cached || cached.unavailable,
  });
}

export interface TrustOffer {
  key: string;
  /** Listing label (exact command + agent name). */
  label: string;
  /** The exact command the allow would cover — shown verbatim in the prompt. */
  command: string;
  agentId: string;
  agentName: string;
  count: number;
}

/**
 * Count one HUMAN decision for the trust ramp. Returns an offer to post in
 * chat when the exact command just reached the threshold, else null. Never
 * throws.
 */
export async function recordHumanApprovalDecision(
  req: ApprovalRequestLike & { runId: string; agentName?: string | null },
  decision: 'accept' | 'decline',
  run: ShellRunner,
  opts: { threshold?: number; homeDir?: string } = {},
): Promise<TrustOffer | null> {
  const desc = describeApprovalRequest({ ...req, origin: trustedRequestOrigin(req) });
  // Ineligible actions (proactive, CRITICAL/HIGH, secrets, payments, outbound
  // posting/messaging, chained / trampoline commands…) never touch the file.
  if (!trustKeyOf(desc)) return null;
  const threshold = Math.max(1, Math.floor(opts.threshold ?? TRUST_RAMP_THRESHOLD_DEFAULT));
  const label = trustLabelOf(desc, req.agentName);
  let offer: TrustOffer | null = null;
  try {
    await mutateUserPolicy(run, (data) => {
      const out = recordApprovalOutcome(data.trust, desc, decision, Date.now(), {
        threshold,
        rules: data.rules,
        homeDir: opts.homeDir,
        label,
      });
      if (out.offer && out.key) {
        offer = {
          key: out.key,
          label,
          command: trustCommandOf(desc),
          agentId: req.agentId || '',
          agentName: req.agentName || req.agentId || '',
          count: out.state.counters[out.key]?.approvals ?? threshold,
        };
      }
      return { ...data, trust: out.state };
    });
  } catch (e) {
    logWarn('Policy', 'trust-ramp counter update failed', e);
    return null;
  }
  if (offer) logInfo('Policy', `trust-ramp threshold reached key=${(offer as TrustOffer).key}`);
  return offer;
}
