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
 *   - escalations carrying a secret-read or policy-write signal,
 *     indirect-exec (the executed command is not the text checked here) or a
 *     signal this module does not know. destructive (e.g. `rm -rf` inside the
 *     home folder) IS answered (owner decision 2026-11-19); CRITICAL ones
 *     (`rm -rf /` …) are refused by approveAllCommandRefusal;
 *   - commands that are CRITICAL (raw or dequoted) or name Shelly's own
 *     trust state (.shelly*, shared_prefs, no_backup, approval files, the
 *     app's databases) or a credential file;
 *   - prompt-injection defenses: agents marked as MCP-ingress tainted, agents
 *     that read untrusted input (web research, URLs, browser / ClosePaw /
 *     DM steps, notification triggers — runWithoutApprovalAllAllowedFor),
 *     and runs not started by the user from the app (proactive /
 *     notification-triggered) keep today's behaviour;
 *   - POLICY-001 deny / draft_only rules, the proactive floor, a policy file
 *     that cannot be read, and requests that are stale, expired, queued or
 *     whose minted copy does not match. The owner's own "ask" rules ARE
 *     answered (owner decision 2026-11-19; approveAllPolicyBlocks);
 *   - unattended runs (the driver / executor decline before RN sees them).
 *
 * The truth is NATIVE (ApproveAllStore.kt: SharedPreferences + Android
 * Keystore HMAC, fail closed to OFF), not the AsyncStorage setting: a same-uid
 * worker can edit RKStorage, it cannot forge the Keystore HMAC.
 * settings.approveAllWithoutAsking only mirrors native for the Settings row.
 * [isApproveAllWithoutAskingOn] asks native at the moment of each decision
 * (never cached), so turning it off takes effect immediately.
 *
 * ON: only [setApproveAllFromToggle] with `true`, called only by the Settings
 * toggle (ConfigTUI). The native setter is reachable from any RN JS; no extra
 * native confirmation is added because RN JS is already the trusted base (it
 * holds the signing APIs that answer every approval, so injected RN JS could
 * answer each request itself) and the owner's rule is "no extra approval
 * prompts". Load / sync ([syncApproveAllFromNative]) only copies native into
 * the setting; `shelly config set` and every other programmatic path may only
 * turn it OFF (UI_ONLY_ENABLE_SETTINGS). STOP-ALL (native, also at start when
 * `.halted` exists) and MCP token regeneration turn it OFF.
 */
import { checkCommandSafety } from '@/lib/command-safety';
import { classifyProposedCommand, dequoteShellWords } from '@/lib/agent-boundary-policy';
import {
  runWithoutApprovalAllAllowedFor,
  type AutoApproveVerdict,
  type EscalationRequestLike,
  type UntrustedInputAgentLike,
} from '@/lib/agent-run-without-approval';

import { withMcpServerLock } from '@/lib/mcp-token';

export { UI_ONLY_ENABLE_SETTINGS } from '@/lib/ui-only-settings';

type ApproveAllNative = {
  getApproveAllWithoutAsking?: () => Promise<boolean>;
  setApproveAllWithoutAsking?: (enabled: boolean, reason?: string | null) => Promise<boolean>;
  getApproveAllToken?: () => Promise<string | null>;
  resolveApproveAllEscalation?: (runId: string, reqId: string, requestSha256: string, actionNonce: string, token: string) => Promise<boolean>;
  resolveApproveAllAction?: (runId: string, requestSha256: string, actionNonce: string, token: string) => Promise<boolean>;
  checkApproveAllToken?: (token: string) => Promise<boolean>;
};

function nativeModule(): ApproveAllNative | null {
  try {
    // Lazy: keeps this module loadable in pure tests without the native module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require('@/modules/terminal-emulator/src/TerminalEmulatorModule');
    return (m?.default ?? m) as ApproveAllNative;
  } catch {
    return null;
  }
}

function mirrorSetting(value: boolean): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useSettingsStore } = require('@/store/settings-store');
    const st = useSettingsStore.getState();
    if ((st.settings.approveAllWithoutAsking === true) !== value) st.updateSettings({ approveAllWithoutAsking: value });
  } catch {
    // no store (pure tests)
  }
}

/** The master switch, asked of native now (never cached). Any error ⇒ OFF. */
export async function isApproveAllWithoutAskingOn(): Promise<boolean> {
  try {
    return (await nativeModule()?.getApproveAllWithoutAsking?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Answering through the master switch is atomic with the switch itself
 * (ApprovalSwitchCore.kt): a decision takes a token when it starts
 * ([approveAllToken]: null = off or STOP-ALL) and is answered ONLY through
 * [resolveApproveAllEscalation] / [resolveApproveAllAction], which re-check —
 * under the native lock that enable / disable / STOP-ALL also take — that the
 * switch is still on, `.halted` is absent and nothing was written since. A
 * decision made before an OFF can therefore never be answered after it. The
 * master-switch paths never call the generic resolve APIs.
 */
export async function approveAllToken(): Promise<string | null> {
  try {
    const t = await nativeModule()?.getApproveAllToken?.();
    return typeof t === 'string' && /^[0-9]{1,19}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Signed accept of a CLI-step escalation, only while [token] is current. False ⇒ nothing was written. */
export async function resolveApproveAllEscalation(runId: string, reqId: string, requestSha256: string, actionNonce: string, token: string): Promise<boolean> {
  const fn = nativeModule()?.resolveApproveAllEscalation;
  if (typeof fn !== 'function') return false;
  return (await fn(runId, reqId, requestSha256, actionNonce, token)) === true;
}

/** Signed accept of a per-run action, only while [token] is current. False ⇒ nothing was written. */
export async function resolveApproveAllAction(runId: string, requestSha256: string, actionNonce: string, token: string): Promise<boolean> {
  const fn = nativeModule()?.resolveApproveAllAction;
  if (typeof fn !== 'function') return false;
  return (await fn(runId, requestSha256, actionNonce, token)) === true;
}

/** Before RN performs a side effect itself (an intent): is [token] still current? */
export async function checkApproveAllToken(token: string): Promise<boolean> {
  try {
    return (await nativeModule()?.checkApproveAllToken?.(token)) === true;
  } catch {
    return false;
  }
}

/** The Settings toggle: the only caller allowed to turn native ON. Resolves (and mirrors) the verified state. */
export async function setApproveAllFromToggle(enabled: boolean): Promise<boolean> {
  const n = nativeModule();
  let state = false;
  try {
    const set = async () => typeof n?.setApproveAllWithoutAsking === 'function' &&
      (await n.setApproveAllWithoutAsking(enabled, 'settings toggle')) === true;
    state = await (enabled ? withMcpServerLock(set) : set());
  } catch {
    state = await isApproveAllWithoutAskingOn();
  }
  mirrorSetting(state);
  return state;
}

/** OFF from anywhere (STOP-ALL mirror, token regeneration). Throws when native still says ON. */
export async function turnOffApproveAll(reason: string): Promise<void> {
  const n = nativeModule();
  const reset = await n?.setApproveAllWithoutAsking?.(false, reason);
  const durable = await n?.getApproveAllWithoutAsking?.();
  if (reset !== false || durable !== false) throw new Error('could not turn off Skip all approvals');
  mirrorSetting(false);
}

/** Load / foreground: copy native into the setting (never turns native on). */
export async function syncApproveAllFromNative(): Promise<boolean> {
  const state = await isApproveAllWithoutAskingOn();
  mirrorSetting(state);
  return state;
}

/** Boundary signals the master switch may answer. Anything else (secret-read,
 *  policy-write, indirect-exec, opaque-script-exec, an unknown signal) asks:
 *  for an opaque script (`python ~/payload.py`) the text checked here is not
 *  what runs. destructive inside the home folder IS answered (owner decision
 *  2026-11-19; CRITICAL ones are refused by approveAllCommandRefusal). */
export const APPROVE_ALL_ESCALATION_SIGNALS: ReadonlySet<string> = new Set([
  'leaves-root',
  'write-or-exec',
  'network-send',
  'destructive',
]);

/** Boundary signals that keep a `cli` action asking under the master switch
 *  (the executed program is not the text checked here). */
export const APPROVE_ALL_CLI_REFUSED_SIGNALS: ReadonlySet<string> = new Set(['opaque-script-exec', 'indirect-exec']);

/** A POLICY-001 verdict as evaluateActionPolicy returns it. */
export type ApproveAllPolicyVerdictLike = { decision: string; layer?: string | null; ruleId?: string | null } | null | undefined;

/**
 * Does this POLICY-001 verdict keep the master switch from answering?
 * deny / draft_only: yes. An "ask" from one of the owner's own rules
 * (layer ask-rule with a ruleId): no — the owner chose to skip those too.
 * Any other ask (the proactive floor, an unreadable policy file): yes.
 */
export function approveAllPolicyBlocks(verdict: ApproveAllPolicyVerdictLike): boolean {
  if (!verdict) return false;
  if (verdict.decision === 'deny' || verdict.decision === 'draft_only') return true;
  if (verdict.decision === 'ask') return !(verdict.layer === 'ask-rule' && typeof verdict.ruleId === 'string' && verdict.ruleId !== '');
  return false;
}

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

/**
 * A `cli` action whose executed program is not the checked text: the boundary
 * classifier (classifyProposedCommand, the gate's own) flags it
 * opaque-script-exec (python / node / bash script.sh / piped interpreter) or
 * indirect-exec ($(…), eval, xargs …). Judged on the raw and the dequoted
 * text. null ⇒ fine; otherwise the refusal reason.
 */
export function approveAllCliSignalRefusal(command: string): string | null {
  const raw = String(command ?? '');
  for (const text of [raw, dequoteShellWords(raw)]) {
    const verdict = classifyProposedCommand(text, { workspaceRoot: '/', level: 'L2' });
    const hit = verdict.signals.find((sig) => APPROVE_ALL_CLI_REFUSED_SIGNALS.has(sig));
    if (hit) return `signal:${hit}`;
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
  /** approveAllPolicyBlocks(verdict): deny / draft_only / a non-owner ask. */
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
  // The boundary classifier's own gray, or one of the owner's own POLICY-001
  // "ask" rules on an otherwise allowed command (the gate's reason starts
  // "user rule: "). The proactive read-only floor and an unreadable policy
  // file carry other reasons and keep asking.
  const reasonText = String(request.reason ?? '');
  const userAskRule = /^user rule: /.test(reasonText);
  if (!userAskRule && !/^boundary: /.test(reasonText)) return { ok: false, reason: 'not-boundary-gray' };
  const command = String(request.command ?? '').trim();
  if (!command) return { ok: false, reason: 'no-command' };
  const signals = Array.isArray(request.signals) ? request.signals.map((s) => String(s).trim()).filter(Boolean) : [];
  if (signals.length === 0 && !userAskRule) return { ok: false, reason: 'no-signals' };
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
  /** approveAllPolicyBlocks(verdict), or a proactive origin. */
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
    const hard = approveAllCommandRefusal(command) ?? approveAllCliSignalRefusal(command);
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
    isOn: () => boolean | Promise<boolean>;
    readMinted: () => Promise<T | null>;
    now?: number;
  },
): Promise<ApproveAllActionDecision<T>> {
  const first = approveAllActionVerdict(parsed, { ...opts, allowRnFired: false });
  if (first.ok === false) return first;
  const minted = await opts.readMinted();
  const refusal = approveAllMintedRefusal(parsed, minted, { ...opts, on: (await opts.isOn()) === true, allowRnFired: false }, opts.now ?? Date.now());
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, minted: minted as T };
}

/** i18n key of the master switch's chat audit line. */
export const APPROVE_ALL_AUDIT_KEY = 'approve_all.auto_allowed';
