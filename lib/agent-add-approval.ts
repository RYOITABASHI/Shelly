/**
 * lib/agent-add-approval.ts — approval bindings for `shelly agent add`
 * requests (2026-10-14). Pure logic; crypto is injectable for tests.
 *
 * Once the in-app `@agent` flow has parsed a terminal-originated request into
 * a concrete draft (name, schedule, action(s), steps), lib/agent-add-flow.ts
 * creates ONE binding per request here. A binding pins:
 *   - the exact parsed definition: draftHash = sha256 of a stable JSON of the
 *     draft the summary/notification showed. Every approval re-hashes the
 *     draft that is still pending in the chat and refuses on any difference.
 *   - two notification nonces (approve / reject, 128-bit, single use), sent
 *     only inside immutable PendingIntents, never logged or written to disk.
 *   - expiry (AGENT_ADD_APPROVAL_TTL_MS) and single use (any decision
 *     consumes the binding).
 *
 * Approving from the ChatGPT conversation (explicit user decision,
 * 2026-10-14) is by TEXT, with no secret: `shelly agent add` prints the
 * parsed summary, the requestId and the first 8 hex chars of draftHash;
 * `shelly agent confirm <requestId> <hash8>` registers. The hash prefix is a
 * BINDING, not a secret — it guarantees the confirm is for the definition
 * that was shown, not a different one. Because the LLM on the other side can
 * run that command itself, the mitigations are: the Settings toggle
 * agentApproveFromChatGpt (refused when OFF), a 10-minute window, a minimum
 * interval + attempt cap per request, an audit notification with a one-tap
 * Disable after every ChatGPT approval, and a plain-text record in the chat
 * (lib/agent-add-flow.ts). Residual risk (documented in DEFERRED.md): a
 * prompt-injected Codex can self-approve a definition the user never read.
 *
 * Risk tier (documented choice): drafts whose delivery is `draft`, `notify`
 * or a ClosePaw hand-off (explicit user decision: ClosePaw is approvable from
 * the notification / ChatGPT like any other plan, and that approval also
 * pre-approves its runs — lib/agent-closepaw-preapproval.ts), that are NOT
 * autonomous, have no notification trigger, no explicit API-call step, no
 * CLI/Codex engine, no per-step tool pin, no custom output path, no reused
 * skill recipe (review fix 2026-10-14), and have a fireable schedule may be
 * approved remotely. Everything else —
 * social-post, webhook, api-call, cli, other intent modes (launch/share),
 * dm-reply, browser-pane, unknown types, autonomous/unattended mode,
 * notification-triggered runs — is review-in-Shelly only. Per-run action
 * approval for those types is unchanged.
 */

export const AGENT_ADD_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const AGENT_ADD_HASH_PREFIX_LENGTH = 8;
export const AGENT_ADD_MAX_CONFIRM_ATTEMPTS = 5;
export const AGENT_ADD_CONFIRM_MIN_INTERVAL_MS = 2_000;

export type AgentAddCrypto = {
  sha256Hex: (input: string) => Promise<string>;
  randomBytes: (n: number) => Uint8Array;
};

let cryptoImpl: AgentAddCrypto | null = null;

function getCrypto(): AgentAddCrypto {
  if (cryptoImpl) return cryptoImpl;
  // Lazy so Jest can inject a Node implementation without loading expo.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Crypto = require('expo-crypto');
  cryptoImpl = {
    sha256Hex: (input: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input),
    randomBytes: (n: number) => Crypto.getRandomBytes(n),
  };
  return cryptoImpl;
}

/** Test hook. */
export function __setAgentAddCryptoForTests(impl: AgentAddCrypto | null): void {
  cryptoImpl = impl;
}

/** Shared SHA-256 (hex) for the agent-add / ClosePaw pre-approval modules. */
export function agentAddSha256Hex(input: string): Promise<string> {
  return getCrypto().sha256Hex(input);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare (equal length required). */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Deterministic JSON: sorted object keys, undefined dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export async function hashAgentDraft(draft: unknown): Promise<string> {
  return getCrypto().sha256Hex(`shelly-agent-add-draft-v1\n${stableStringify(draft)}`);
}

/** Loose structural view of ParsedAgentDraft — only what the tiering reads. */
export type AgentAddDraftLike = {
  name?: string;
  prompt?: string;
  schedule?: string | null;
  action?: { type?: string; intentMode?: string } | null;
  actions?: Array<{ type?: string; intentMode?: string } | null> | null;
  autonomous?: boolean;
  notificationTrigger?: { packageNames?: string[] } | null;
  orchestrationSteps?: Array<string | { instruction?: string; apiCall?: unknown; tool?: unknown }> | null;
  closePawRouting?: { clause: string; app: string; routed: boolean } | null;
  tool?: { type?: string; [key: string]: unknown } | null;
  /** The user named the tool (ParsedAgentDraft.toolExplicit). */
  toolExplicit?: boolean;
  outputPath?: string;
  matchedSkill?: unknown;
};

/** Reasons a draft is review-in-Shelly only. Empty = remotely approvable
 *  (subject to a fireable schedule, checked by the caller). Fail-closed: a
 *  missing or unknown action type is a reason. */
export function assessAgentDraftRisk(draft: AgentAddDraftLike): string[] {
  const reasons: string[] = [];
  const actions = Array.isArray(draft.actions) && draft.actions.length > 0 ? draft.actions : [draft.action];
  for (const action of actions) {
    const type = action && typeof action.type === 'string' ? action.type : 'unknown';
    const remoteOk = type === 'draft' || type === 'notify' || (type === 'intent' && action?.intentMode === 'closepaw');
    if (!remoteOk) {
      const reason = `action:${type}`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  if (draft.autonomous === true) reasons.push('autonomous');
  if (draft.notificationTrigger && Array.isArray(draft.notificationTrigger.packageNames) && draft.notificationTrigger.packageNames.length > 0) {
    reasons.push('notification-trigger');
  }
  if (Array.isArray(draft.orchestrationSteps) && draft.orchestrationSteps.some((s) => !!s && typeof s === 'object' && 'apiCall' in s && !!s.apiCall)) {
    reasons.push('api-call-step');
  }
  // Review fix: anything that widens what a run can touch stays in-app only —
  // a CLI/Codex engine (incl. the A/B article evaluator, which runs a Codex
  // command), per-step tool pins, a custom output path, a reused skill recipe.
  const toolType = draft.tool && typeof draft.tool === 'object' ? draft.tool.type : undefined;
  if (toolType === 'cli' || toolType === 'ab-article-eval') reasons.push('tool:cli');
  if (Array.isArray(draft.orchestrationSteps) && draft.orchestrationSteps.some((s) => !!s && typeof s === 'object' && 'tool' in s && !!s.tool)) {
    reasons.push('step-tool');
  }
  if (typeof draft.outputPath === 'string' && draft.outputPath.trim()) reasons.push('output-path');
  if (draft.matchedSkill) reasons.push('skill');
  return reasons;
}

/** The ClosePaw part of a draft, for every confirmation surface. */
export function closePawStepText(draft: AgentAddDraftLike & { action?: { intentShareText?: string } | null }): string | null {
  if (draft.closePawRouting?.routed) return draft.closePawRouting.clause;
  const a = draft.action as { type?: string; intentMode?: string; intentShareText?: string } | null | undefined;
  if (a && a.type === 'intent' && a.intentMode === 'closepaw') return String(a.intentShareText ?? '');
  return null;
}

export type AgentAddBinding = {
  reqId: string;
  conversationKey: string;
  messageId: string;
  draftHash: string;
  createdAt: number;
  expiresAt: number;
  /** Remote (notification / ChatGPT) approval allowed. */
  approvable: boolean;
  riskReasons: string[];
  fireable: boolean;
  confirmAttempts: number;
  lastConfirmAttemptAt: number;
  approveNonce: string | null;
  rejectNonce: string;
  consumed: boolean;
};

const bindings = new Map<string, AgentAddBinding>();

export function draftHashPrefix(binding: Pick<AgentAddBinding, 'draftHash'>): string {
  return binding.draftHash.slice(0, AGENT_ADD_HASH_PREFIX_LENGTH);
}

function reqIdTimestamp(reqId: string): number {
  return /^[0-9]{10,16}-[0-9a-f]{8}$/.test(reqId) ? Number(reqId.split('-')[0]) : 0;
}

/**
 * Create the binding for a request, or refresh it when the SAME request's
 * draft is re-presented (e.g. after a slot-fill answer). Returns null — and
 * never resurrects anything — when the request was already decided
 * (consumed), when its 10-minute window (counted from the request's own
 * timestamp, not from now) is over, or when `isFinalized(reqId)` says the
 * outcome was already recorded. A refresh keeps the attempt counter and the
 * original expiry.
 */
export async function createAgentAddBinding(params: {
  reqId: string;
  conversationKey: string;
  messageId: string;
  draft: AgentAddDraftLike;
  fireable: boolean;
  now?: number;
  isFinalized?: (reqId: string) => boolean;
}): Promise<AgentAddBinding | null> {
  const now = params.now ?? Date.now();
  const issuedAt = reqIdTimestamp(params.reqId);
  if (!issuedAt) return null;
  const expiresAt = issuedAt + AGENT_ADD_APPROVAL_TTL_MS;
  if (now > expiresAt) return null;
  if (params.isFinalized?.(params.reqId)) return null;
  const previous = bindings.get(params.reqId);
  if (previous?.consumed) return null;
  const crypto = getCrypto();
  const riskReasons = assessAgentDraftRisk(params.draft);
  const approvable = riskReasons.length === 0 && params.fireable === true;
  const binding: AgentAddBinding = {
    reqId: params.reqId,
    conversationKey: params.conversationKey,
    messageId: params.messageId,
    draftHash: await hashAgentDraft(params.draft),
    createdAt: now,
    expiresAt,
    approvable,
    riskReasons,
    fireable: params.fireable === true,
    confirmAttempts: previous?.confirmAttempts ?? 0,
    lastConfirmAttemptAt: previous?.lastConfirmAttemptAt ?? Number.NEGATIVE_INFINITY,
    approveNonce: approvable ? toHex(crypto.randomBytes(16)) : null,
    rejectNonce: toHex(crypto.randomBytes(16)),
    consumed: false,
  };
  bindings.set(params.reqId, binding);
  return binding;
}

export function getAgentAddBinding(reqId: string): AgentAddBinding | null {
  return bindings.get(reqId) ?? null;
}

export function findAgentAddBindingByMessage(conversationKey: string, messageId: string): AgentAddBinding | null {
  for (const b of bindings.values()) {
    if (b.conversationKey === conversationKey && b.messageId === messageId && !b.consumed) return b;
  }
  return null;
}

/** Single use: any decision (approve/reject/cancel in chat) consumes it. */
export function consumeAgentAddBinding(reqId: string): void {
  const b = bindings.get(reqId);
  if (b) {
    b.consumed = true;
    b.approveNonce = null;
  }
}

export function sweepAgentAddBindings(now: number = Date.now()): void {
  for (const [reqId, b] of bindings) {
    if (now > b.expiresAt + AGENT_ADD_APPROVAL_TTL_MS) bindings.delete(reqId);
  }
}

/** Test hook. */
export function __resetAgentAddBindingsForTests(): void {
  bindings.clear();
}

export type AgentAddConfirmCheck =
  | { ok: true; binding: AgentAddBinding }
  | {
      ok: false;
      reason: 'disabled' | 'unknown' | 'expired' | 'used' | 'high-risk' | 'not-approvable' | 'hash-mismatch' | 'locked' | 'rate-limited';
      attemptsLeft?: number;
      binding?: AgentAddBinding;
    };

/**
 * `shelly agent confirm <requestId> <hash8>` from the ChatGPT conversation.
 * `allowed` is AppSettings.agentApproveFromChatGpt. On success the binding
 * is consumed (single use).
 */
export function verifyAgentAddTextConfirm(
  reqId: string,
  hashPrefix: string,
  opts: { allowed: boolean; now?: number },
): AgentAddConfirmCheck {
  const now = opts.now ?? Date.now();
  if (opts.allowed !== true) return { ok: false, reason: 'disabled' };
  const b = bindings.get(reqId);
  if (!b) return { ok: false, reason: 'unknown' };
  if (b.consumed) return { ok: false, reason: 'used', binding: b };
  if (now > b.expiresAt) return { ok: false, reason: 'expired', binding: b };
  if (b.riskReasons.length > 0) return { ok: false, reason: 'high-risk', binding: b };
  if (!b.approvable) return { ok: false, reason: 'not-approvable', binding: b };
  if (b.confirmAttempts >= AGENT_ADD_MAX_CONFIRM_ATTEMPTS) return { ok: false, reason: 'locked', binding: b };
  if (now - b.lastConfirmAttemptAt < AGENT_ADD_CONFIRM_MIN_INTERVAL_MS) {
    return { ok: false, reason: 'rate-limited', binding: b };
  }
  b.lastConfirmAttemptAt = now;
  const prefix = String(hashPrefix ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(prefix) || !safeEqual(prefix, draftHashPrefix(b))) {
    b.confirmAttempts += 1;
    if (b.confirmAttempts >= AGENT_ADD_MAX_CONFIRM_ATTEMPTS) return { ok: false, reason: 'locked', binding: b, attemptsLeft: 0 };
    return { ok: false, reason: 'hash-mismatch', binding: b, attemptsLeft: AGENT_ADD_MAX_CONFIRM_ATTEMPTS - b.confirmAttempts };
  }
  consumeAgentAddBinding(reqId);
  return { ok: true, binding: b };
}

export type AgentAddNonceCheck =
  | { ok: true; binding: AgentAddBinding }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'not-approvable' | 'bad-nonce' };

/** Verify a notification action deep link. Approve requires an approvable
 *  binding and its approve nonce; reject its reject nonce. Consumes on success. */
export function verifyAgentAddNotificationDecision(
  reqId: string,
  decision: 'approve' | 'reject',
  nonce: string,
  now: number = Date.now(),
  opts: { consume?: boolean } = {},
): AgentAddNonceCheck {
  const b = bindings.get(reqId);
  if (!b) return { ok: false, reason: 'unknown' };
  if (b.consumed) return { ok: false, reason: 'used' };
  if (now > b.expiresAt) return { ok: false, reason: 'expired' };
  if (decision === 'approve') {
    if (!b.approvable || !b.approveNonce) return { ok: false, reason: 'not-approvable' };
    if (!safeEqual(String(nonce ?? ''), b.approveNonce)) return { ok: false, reason: 'bad-nonce' };
  } else if (!safeEqual(String(nonce ?? ''), b.rejectNonce)) {
    return { ok: false, reason: 'bad-nonce' };
  }
  // consume:false = verify only (the caller consumes once the pane handler
  // and the pending draft are actually there, e.g. on a cold start).
  if (opts.consume !== false) consumeAgentAddBinding(reqId);
  return { ok: true, binding: b };
}

/** The definition the user is about to approve must be identical (by hash)
 *  to the one the summary/notification showed. */
export async function isDraftStillBound(binding: AgentAddBinding, currentDraft: unknown): Promise<boolean> {
  if (currentDraft == null) return false;
  return safeEqual(await hashAgentDraft(currentDraft), binding.draftHash);
}

// ── Shell-facing summary (NEVER contains a nonce) ──────────────────────────

export type AgentAddSummary = {
  ok: true;
  code: 'parsed' | 'registered' | 'rejected';
  requestId: string;
  /** First 8 hex of the definition hash — the binding `confirm` must quote. */
  definitionHash: string;
  name: string;
  schedule: string;
  steps: string[];
  actions: string[];
  /** The part ClosePaw will do by operating the phone, if any. */
  closePaw: string | null;
  /** Disclosure shown with `closePaw` (untrusted content, standing approval). */
  closePawNote: string | null;
  highRisk: string[];
  approvableFromChat: boolean;
  expiresAt: number;
  message: string;
  /** Engine the agent will be stored with (review L2), e.g. "Perplexity API". */
  tool: string;
  /** true when the user named that engine in the request. */
  toolPinned: boolean;
  /** Disclosure shown with `tool` (e.g. a substituted engine), or null. */
  toolNote: string | null;
};

function clip(s: string, max: number): string {
  const cps = Array.from(s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim());
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : cps.join('');
}

/** Build the summary `shelly agent add` / `shelly agent show` print. Pure. */
export function buildAgentAddSummary(
  binding: Pick<AgentAddBinding, 'reqId' | 'riskReasons' | 'approvable' | 'expiresAt' | 'fireable' | 'draftHash'>,
  draft: AgentAddDraftLike & { scheduleLabel?: string },
  scheduleText: string,
  status: AgentAddSummary['code'] = 'parsed',
  /** false: a ClosePaw step with the Shelly-trusted variant installed —
   *  ChatGPT/terminal text cannot approve it (user decision, option 3). */
  /** `tool`: the engine disclosure (lib/agent-tool-router.ts
   *  describeDraftTool, computed by the caller so this module stays pure). */
  opts: { textConfirmAllowed?: boolean; tool?: { label: string; pinned: boolean; note: string | null } } = {},
): AgentAddSummary {
  const textConfirmAllowed = opts.textConfirmAllowed !== false;
  const steps: string[] = [];
  if (Array.isArray(draft.orchestrationSteps) && draft.orchestrationSteps.length > 0) {
    for (const s of draft.orchestrationSteps.slice(0, 12)) {
      const text = typeof s === 'string' ? s : s && typeof s.instruction === 'string' ? s.instruction : '';
      if (text) steps.push(clip(text, 200));
    }
  } else if (typeof draft.prompt === 'string' && draft.prompt) {
    steps.push(clip(draft.prompt, 300));
  }
  const actionList = Array.isArray(draft.actions) && draft.actions.length > 0 ? draft.actions : [draft.action];
  const actions = actionList.map((a) =>
    a && typeof a.type === 'string' ? (a.type === 'intent' && a.intentMode ? `intent:${a.intentMode}` : a.type) : 'unknown',
  );
  const closePawText = closePawStepText(draft as AgentAddDraftLike & { action?: { intentShareText?: string } | null });
  const hash8 = binding.draftHash.slice(0, AGENT_ADD_HASH_PREFIX_LENGTH);
  let message: string;
  if (status === 'registered') message = 'Registered — the user approved this agent.';
  else if (status === 'rejected') message = 'Rejected — nothing was registered.';
  else if (binding.approvable && !textConfirmAllowed) {
    message =
      "This agent includes a ClosePaw step and the Shelly-trusted ClosePaw build is installed, so it can't be approved from here. " +
      `Ask the user to tap Approve in the Shelly notification (device unlock required) or reply OK to the draft in Shelly's chat (reject with: shelly agent reject ${binding.reqId}).`;
  } else if (binding.approvable) {
    message =
      `Show this summary to the user. Only if they approve it, run: shelly agent confirm ${binding.reqId} ${hash8}` +
      ` (or they can approve / reject it in Shelly's notification or chat; reject with: shelly agent reject ${binding.reqId})`;
  } else if (binding.riskReasons.length > 0) {
    message = `This agent includes steps that need review in Shelly itself (${binding.riskReasons.join(', ')}); it cannot be approved from here.`;
  } else {
    message = 'This agent has no confirmed schedule yet; finish and approve it in Shelly itself.';
  }
  return {
    ok: true,
    code: status,
    requestId: binding.reqId,
    definitionHash: hash8,
    name: clip(String(draft.name ?? ''), 120),
    schedule: clip(scheduleText, 120),
    steps,
    actions,
    closePaw: closePawText ? clip(closePawText, 300) : null,
    closePawNote: closePawText
      ? "ClosePaw operates the phone for this step. What it is given is built from this agent's own results (can include untrusted web text). Approving the agent also approves this step for its future runs until the agent is edited."
      : null,
    highRisk: [...binding.riskReasons],
    approvableFromChat: binding.approvable && textConfirmAllowed && status === 'parsed',
    expiresAt: binding.expiresAt,
    message,
    tool: clip(opts.tool?.label ?? 'Auto', 120),
    toolPinned: opts.tool?.pinned === true,
    toolNote: opts.tool?.note ? clip(opts.tool.note, 400) : null,
  };
}
