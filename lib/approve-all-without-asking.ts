/**
 * lib/approve-all-without-asking.ts — the owner's master switch
 * settings.approveAllWithoutAsking ("Skip all approvals", default OFF).
 *
 * When ON, every approval prompt React Native can answer is answered
 * "allow" without being shown, through the SAME signed-reply paths the
 * per-agent "run without approval" option already uses (no new signing),
 * and each auto-allow leaves a log line and, for agent approvals, a chat
 * audit line ("All approvals skipped: auto-allowed …").
 *
 * What it never lifts (the decisions below, plus everything upstream that
 * never reaches RN):
 *   - gate denies (CRITICAL, POLICY-001 deny / draft_only, policy-write,
 *     MCP gate refusals, classifyWorkspaceExec CRITICAL) — the driver /
 *     executor / MCP gate refuse those before any prompt exists;
 *   - escalations carrying an UNGRANTABLE boundary signal (secret-read,
 *     destructive, policy-write), indirect-exec (the executed command is not
 *     the text checked here) or a signal this module does not know;
 *   - commands that are CRITICAL (raw or dequoted) or name Shelly's own
 *     trust state (.shelly*, shared_prefs, no_backup, approval files, the
 *     app's databases) or a credential file;
 *   - prompt-injection defenses: agents marked as MCP-ingress tainted, agents
 *     that read untrusted input (web research, URLs, browser / ClosePaw /
 *     DM steps, notification triggers — runWithoutApprovalAllAllowedFor),
 *     and runs not started by the user from the app (proactive /
 *     notification-triggered) keep today's behaviour;
 *   - POLICY-001 user rules (deny / draft_only / ask) and requests that are
 *     stale, expired, queued or whose minted copy does not match;
 *   - unattended runs (the driver / executor decline before RN sees them).
 *
 * The switch is read at the moment of each decision (never cached), so
 * turning it off takes effect immediately. It can only be turned ON from the
 * Settings UI (ConfigTUI); `shelly config set` and every other programmatic
 * path may only turn it OFF (UI_ONLY_ENABLE_SETTINGS).
 */
import { checkCommandSafety } from '@/lib/command-safety';
import { dequoteShellWords } from '@/lib/agent-boundary-policy';
import {
  runWithoutApprovalAllAllowedFor,
  type AutoApproveVerdict,
  type EscalationRequestLike,
  type UntrustedInputAgentLike,
} from '@/lib/agent-run-without-approval';

export { UI_ONLY_ENABLE_SETTINGS } from '@/lib/ui-only-settings';

/** The master switch, read now from the settings store (never cached). */
export function isApproveAllWithoutAskingOn(): boolean {
  try {
    // Lazy: keeps this module loadable in pure tests without the store.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useSettingsStore } = require('@/store/settings-store');
    return useSettingsStore.getState().settings.approveAllWithoutAsking === true;
  } catch {
    return false;
  }
}

/** Boundary signals the master switch may answer. Anything else (secret-read,
 *  destructive, policy-write, indirect-exec, an unknown signal) asks. */
export const APPROVE_ALL_ESCALATION_SIGNALS: ReadonlySet<string> = new Set([
  'leaves-root',
  'write-or-exec',
  'network-send',
  'opaque-script-exec',
]);

/** Action types answered with a plain signed accept (the executor performs
 *  the side effect after reading it). */
export const APPROVE_ALL_ACCEPT_ONLY_ACTION_TYPES = ['draft', 'notify', 'webhook', 'api-call', 'social-post', 'cli'] as const;
/** Action types whose side effect RN itself performs on accept (only a
 *  non-ClosePaw intent here; dm-reply / browser-pane / ClosePaw belong to
 *  agents that read untrusted input and are never answered). */
export const APPROVE_ALL_RN_FIRED_ACTION_TYPES = ['intent'] as const;

/** Shelly's own trust / approval state and app-private storage. */
const TRUST_STATE_RE = /shared_prefs|no_backup|(?:^|[\s/'"=:<>])\.shelly|shelly-agent-(?:escalation|preapproval|action)|RKStorage|(?:^|[\s/'"=:<>])databases(?:$|[\s/'"])|dev\.shelly\.terminal\/(?!files\/home(?:$|[\s/'"]))/i;
/** Credential / key files, anywhere in the text. */
const SECRET_TEXT_RE = /(?:^|[\s/'"=:(])(?:id_(?:rsa|dsa|ecdsa|ed25519)|auth\.json|\.netrc|\.git-credentials|credentials(?:\.json)?|\.npmrc|\.pypirc)(?=$|[\s'"),;:&|<>])|\/\.env(?=$|[\s.'"),;:&|<>])|(?:^|[\s/'"=])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[\s'"),;:&|<>])|\.(?:pem|p12|pfx|jks|keystore)(?=$|[\s'"),;:&|<>])/i;

/**
 * The hard checks on a command text (escalation command, `cli` action
 * command). null ⇒ nothing hard; otherwise the refusal reason.
 */
export function approveAllCommandRefusal(command: string, extra: readonly (string | null | undefined)[] = []): string | null {
  const raw = String(command ?? '');
  const dequoted = dequoteShellWords(raw);
  for (const text of [raw, dequoted]) {
    const level = checkCommandSafety(text).level;
    if (level === 'CRITICAL') return 'safety:CRITICAL';
  }
  for (const text of [raw, dequoted, ...extra.map((e) => String(e ?? ''))]) {
    if (TRUST_STATE_RE.test(text)) return 'trust-state-path';
    if (SECRET_TEXT_RE.test(text)) return 'secret-file';
  }
  return null;
}

export type ApproveAllEscalationOpts = {
  /** The master switch, read at the moment of the decision. */
  on: boolean;
  /** RN's own run registry says the user started this run from the app. */
  attended: boolean;
  /** MCP ingress taint (fails closed). */
  ingressTainted: boolean;
  /** The CURRENT agent definition (agent store), or null. */
  agent: UntrustedInputAgentLike | null | undefined;
  /** POLICY-001 deny / draft_only / ask, or a proactive origin. */
  policyBlocksAutoAccept?: boolean;
};

/**
 * Master-switch decision for a CLI-step boundary escalation (gray verdict
 * of the gate on an ATTENDED run). Unlike the per-agent "all" level there is
 * no soft-reason list: anything not refused below is allowed.
 */
export function approveAllEscalationVerdict(request: EscalationRequestLike, opts: ApproveAllEscalationOpts): AutoApproveVerdict {
  if (!opts.on) return { ok: false, reason: 'approve-all-off' };
  if (opts.ingressTainted) return { ok: false, reason: 'ingress-tainted' };
  if (!opts.attended) return { ok: false, reason: 'proactive' };
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  if (!runWithoutApprovalAllAllowedFor(opts.agent)) return { ok: false, reason: 'untrusted-input' };
  // A queued request belongs to a run that already declined and moved on.
  if (request.state) return { ok: false, reason: 'not-live' };
  // Only the boundary classifier's own gray; a POLICY-001 ask rule or the
  // proactive read-only floor carry their own reason and keep asking.
  if (!/^boundary: /.test(String(request.reason ?? ''))) return { ok: false, reason: 'not-boundary-gray' };
  const command = String(request.command ?? '').trim();
  if (!command) return { ok: false, reason: 'no-command' };
  const signals = Array.isArray(request.signals) ? request.signals.map((s) => String(s).trim()).filter(Boolean) : [];
  if (signals.length === 0) return { ok: false, reason: 'no-signals' };
  const foreign = signals.find((s) => !APPROVE_ALL_ESCALATION_SIGNALS.has(s));
  if (foreign) return { ok: false, reason: `signal:${foreign}` };
  const hard = approveAllCommandRefusal(command, [request.cwd]);
  if (hard) return { ok: false, reason: hard };
  return { ok: true, kind: 'all' };
}

/** The fields of a per-run action approval request this decision reads. */
export type ApproveAllActionRequestLike = {
  runId: string;
  agentId: string;
  actionType?: string | null;
  requestSha256?: string | null;
  actionNonce?: string | null;
  expiresAt?: number | null;
  origin?: string | null;
  command?: string | null;
  intentMode?: string | null;
};

export type ApproveAllActionOpts = {
  on: boolean;
  ingressTainted: boolean;
  /** POLICY-001 deny / draft_only / ask, or a proactive origin. */
  policyBlocksAutoAccept: boolean;
  /** lib/agent-policy-approval.ts trustedRequestOrigin. */
  originOf: (req: { agentId?: string | null; origin?: string | null }) => 'user' | 'event';
  /** The CURRENT agent definition for an agent id, or null. */
  agentFor: (agentId: string) => UntrustedInputAgentLike | null | undefined;
  /** Also answer the types RN fires itself (intent). The headless drain cannot. */
  allowRnFired?: boolean;
};

/** Master-switch decision on ONE copy of a per-run action request. */
export function approveAllActionVerdict(request: ApproveAllActionRequestLike, opts: ApproveAllActionOpts): AutoApproveVerdict {
  if (!opts.on) return { ok: false, reason: 'approve-all-off' };
  if (opts.ingressTainted) return { ok: false, reason: 'ingress-tainted' };
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  if (opts.originOf(request) !== 'user') return { ok: false, reason: 'proactive' };
  if (!runWithoutApprovalAllAllowedFor(opts.agentFor(request.agentId))) return { ok: false, reason: 'untrusted-input' };
  const type = String(request.actionType ?? '');
  const acceptOnly = (APPROVE_ALL_ACCEPT_ONLY_ACTION_TYPES as readonly string[]).includes(type);
  const rnFired = opts.allowRnFired === true && (APPROVE_ALL_RN_FIRED_ACTION_TYPES as readonly string[]).includes(type);
  if (!acceptOnly && !rnFired) return { ok: false, reason: `type:${type || 'unknown'}` };
  // A ClosePaw hand-off reads the screen back into the run (untrusted input).
  if (type === 'intent' && request.intentMode === 'closepaw') return { ok: false, reason: 'closepaw' };
  if (type === 'cli') {
    const command = String(request.command ?? '').trim();
    if (!command) return { ok: false, reason: 'no-command' };
    const hard = approveAllCommandRefusal(command);
    if (hard) return { ok: false, reason: hard };
  }
  return { ok: true, kind: 'all' };
}

/**
 * The minted copy (the exact bytes the signed reply is bound to) must still
 * describe the request that was judged, be unexpired and pass the same
 * verdict. null ⇒ fine; otherwise the refusal reason.
 */
export function approveAllMintedRefusal<T extends ApproveAllActionRequestLike>(
  parsed: T,
  minted: T | null | undefined,
  opts: ApproveAllActionOpts,
  now: number = Date.now(),
): string | null {
  if (!minted || !minted.requestSha256 || !minted.actionNonce) return 'minted-unreadable';
  if (minted.expiresAt && minted.expiresAt < now) return 'minted-expired';
  if (minted.runId !== parsed.runId || minted.agentId !== parsed.agentId || minted.actionType !== parsed.actionType) return 'minted-mismatch';
  if ((minted.command ?? '') !== (parsed.command ?? '')) return 'minted-mismatch';
  const verdict = approveAllActionVerdict(minted, opts);
  return verdict.ok === false ? `minted-${verdict.reason}` : null;
}

export type ApproveAllActionDecision<T> = { ok: true; minted: T } | { ok: false; reason: string };

/** The whole decision for an accept-only action: drained copy, then minted. */
export async function decideApproveAllActionApproval<T extends ApproveAllActionRequestLike>(
  parsed: T,
  opts: ApproveAllActionOpts & {
    /** Re-read of the switch right before minting / answering. */
    isOn: () => boolean;
    readMinted: () => Promise<T | null>;
    now?: number;
  },
): Promise<ApproveAllActionDecision<T>> {
  const first = approveAllActionVerdict(parsed, { ...opts, allowRnFired: false });
  if (first.ok === false) return first;
  const minted = await opts.readMinted();
  const refusal = approveAllMintedRefusal(parsed, minted, { ...opts, on: opts.isOn(), allowRnFired: false }, opts.now ?? Date.now());
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, minted: minted as T };
}

/** i18n key of the master switch's chat audit line. */
export const APPROVE_ALL_AUDIT_KEY = 'approve_all.auto_allowed';
