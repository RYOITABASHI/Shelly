/**
 * lib/agent-closepaw-preapproval.ts — "one approval total" for ClosePaw
 * hand-off steps (2026-10-14, explicit user decision).
 *
 * When the user approves an agent registration whose confirmation text said
 * "ClosePaw will operate the phone for: <goal>" (chat OK, notification
 * Approve, or ChatGPT confirm), that same approval pre-approves the agent's
 * ClosePaw hand-off for its future runs — so a recurring agent does not ask
 * again every morning. The pre-approval is bound to the EXACT definition:
 *
 *   (agentId, step index, mode 'closepaw', sanitized goal template,
 *    definitionHash = sha256(stable JSON of prompt + orchestration steps +
 *    action(s)))
 *
 * and is reusable for that binding until the definition changes — any edit
 * of the goal/steps/prompt changes definitionHash, the seal no longer
 * matches, and the run falls back to the normal per-run ClosePaw Review.
 *
 * Integrity: the seals live in the Android-Keystore-backed SecureStore (same
 * pattern as lib/agent-trust-allow-seal.ts), NOT in a file under $HOME that
 * agent processes / Codex (same Linux uid) could forge. The executor only
 * files the approval request; RN's choke point (app/_layout.tsx
 * drainAgentActionApprovalRequests) is the only place a seal is honoured,
 * and it re-checks the minted request against the CURRENT agent definition
 * from the agent store plus the sealed template.
 *
 * Review fixes (2026-10-14): the request FILE is forgeable by any same-uid
 * process, so a seal is honoured only while the app's own AgentRuntime is
 * executing that agent (NativeAgentRunRegistry — process memory) and at most
 * once per such run (closePawRunProvenanceOk); the definition hash also
 * covers schedule / autonomous / notificationTrigger / tool; the seal lands
 * only on the exact agent the confirm created and only when it equals the
 * approved draft (agentMatchesApprovedDraft); the resolved goal is capped at
 * the wire budget and its {{result}} slot at CLOSEPAW_RESULT_SLOT_MAX_CHARS.
 * Residual: a forged request racing a real run of the same sealed agent can
 * still take that run's single hand-off — its goal must match the sealed
 * template, only the capped {{result}} slot differs.
 *
 * Step index: today a ClosePaw hand-off is always the agent's final delivery
 * action (index CLOSEPAW_ACTION_STEP_INDEX); orchestration steps never carry
 * an intent. The field is kept so a future per-step hand-off binds the same way.
 */
import { closePawTaskText, sanitizeClosePawGoal } from './agent-intent-review';
import { stableStringify, agentAddSha256Hex } from './agent-add-approval';

export const CLOSEPAW_ACTION_STEP_INDEX = -1;
const SEAL_KEY = 'shelly_closepaw_preapprovals_v1';
const MAX_SEALS = 200;

export type ClosePawPreapproval = {
  agentId: string;
  stepIndex: number;
  mode: 'closepaw';
  goalTemplate: string;
  definitionHash: string;
  createdAt: number;
  /** 'chat' | 'notification' | 'chatgpt' — audit only. */
  approvedVia: string;
};

/** Structural view of an Agent — only what the binding reads. */
export type ClosePawAgentLike = {
  id: string;
  prompt?: string;
  action?: { type?: string; intentMode?: string; intentShareText?: string } | null;
  actions?: Array<{ type?: string; intentMode?: string; intentShareText?: string } | null> | null;
  orchestration?: unknown;
  schedule?: string | null;
  autonomous?: boolean;
  notificationTrigger?: unknown;
  tool?: unknown;
};

/** Max code points of the {{result}} slot a pre-approved goal may carry
 *  (mirrored by scripts/shelly-plan-executor.js capClosePawResultSlot). The
 *  slot is the agent's own output — possibly web-derived, untrusted text. */
export const CLOSEPAW_RESULT_SLOT_MAX_CHARS = 1200;

export type SealStorage = {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
};

let storage: SealStorage | null = null;
let cache: ClosePawPreapproval[] | null = null;

function getStorage(): SealStorage {
  if (storage) return storage;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require('expo-secure-store');
  storage = {
    get: () => SecureStore.getItemAsync(SEAL_KEY),
    set: (v: string) => SecureStore.setItemAsync(SEAL_KEY, v),
  };
  return storage;
}

/** Test hook. */
export function __setClosePawSealStorageForTests(s: SealStorage | null): void {
  storage = s;
  cache = null;
}

export async function loadClosePawPreapprovals(): Promise<ClosePawPreapproval[]> {
  if (cache) return cache;
  try {
    const raw = await getStorage().get();
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? parsed.filter(
          (s): s is ClosePawPreapproval =>
            !!s && typeof s.agentId === 'string' && s.mode === 'closepaw' && typeof s.goalTemplate === 'string' && typeof s.definitionHash === 'string',
        )
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(list: ClosePawPreapproval[]): Promise<void> {
  const trimmed = list.slice(-MAX_SEALS);
  await getStorage().set(JSON.stringify(trimmed));
  cache = trimmed;
}

function closePawAction(agent: ClosePawAgentLike) {
  const actions = Array.isArray(agent.actions) && agent.actions.length > 0 ? agent.actions : [agent.action];
  const found = actions.filter((a) => a && a.type === 'intent' && a.intentMode === 'closepaw');
  return found.length === 1 ? found[0]! : null;
}

/** Hash of everything that decides what the agent does. */
/** JSON round-trip: exactly what survives being written to and read back from
 *  ~/.shelly/agents/<id>.json (undefined dropped, -0 → 0, etc.). */
function asPersisted(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * The canonical, persistence-stable form of everything the seal covers. The
 * SAME normalization runs at seal time (the in-memory agent just created)
 * and at check time (the agent the store rebuilt from its on-disk JSON after
 * an app restart), so a reload never invalidates a seal while any real edit
 * does. Only the orchestration STEPS are covered (not runtime knobs the app
 * may clamp/add later); empty/absent collections normalize to null.
 */
export function normalizeClosePawDefinition(agent: ClosePawAgentLike): Record<string, unknown> {
  const actions = asPersisted(agent.actions);
  const orchestration = agent.orchestration && typeof agent.orchestration === 'object'
    ? asPersisted((agent.orchestration as { steps?: unknown }).steps)
    : null;
  return {
    id: agent.id,
    prompt: agent.prompt ?? '',
    action: asPersisted(agent.action),
    actions: Array.isArray(actions) && actions.length > 0 ? actions : null,
    orchestrationSteps: Array.isArray(orchestration) && orchestration.length > 0 ? orchestration : null,
    // Review fix: when / how autonomously / on what trigger / with which
    // engine it runs are part of what the user approved too.
    schedule: agent.schedule ?? null,
    autonomous: agent.autonomous === true,
    notificationTrigger: asPersisted(agent.notificationTrigger),
    tool: asPersisted(agent.tool),
  };
}

export async function closePawDefinitionHash(agent: ClosePawAgentLike): Promise<string> {
  return agentAddSha256Hex(`shelly-closepaw-preapproval-v3\n${stableStringify(normalizeClosePawDefinition(agent))}`);
}

/** Seal the pre-approval for a just-registered agent. No-op unless the agent
 *  has exactly one ClosePaw hand-off. Replaces any older seal for the agent. */
export async function sealClosePawPreapproval(agent: ClosePawAgentLike, approvedVia: string, now: number = Date.now()): Promise<boolean> {
  const action = closePawAction(agent);
  if (!action) return false;
  const goalTemplate = sanitizeClosePawGoal(action.intentShareText);
  if (!goalTemplate) return false;
  const seal: ClosePawPreapproval = {
    agentId: agent.id,
    stepIndex: CLOSEPAW_ACTION_STEP_INDEX,
    mode: 'closepaw',
    goalTemplate,
    definitionHash: await closePawDefinitionHash(agent),
    createdAt: now,
    approvedVia,
  };
  const list = (await loadClosePawPreapprovals()).filter((s) => s.agentId !== agent.id);
  await save([...list, seal]);
  return true;
}

export async function revokeClosePawPreapproval(agentId: string): Promise<void> {
  const list = await loadClosePawPreapprovals();
  if (list.some((s) => s.agentId === agentId)) await save(list.filter((s) => s.agentId !== agentId));
}

/** Does a resolved goal (with {{result}} substituted at run time) come from
 *  the sealed template? It is first capped exactly like the wire goal
 *  (closePawTaskText: CLOSEPAW_GOAL_MAX_CHARS minus the fixed prefix), so
 *  what is matched is what ClosePaw would receive; a cap that cuts the
 *  template's tail therefore fails (→ per-run Review). Literal parts must
 *  match exactly and the {{result}} slot may carry at most
 *  CLOSEPAW_RESULT_SLOT_MAX_CHARS code points. */
export function goalMatchesTemplate(resolvedGoal: string, template: string): boolean {
  const resolved = closePawTaskText(resolvedGoal);
  if (!resolved) return false;
  const parts = template.split('{{result}}');
  if (parts.length === 1) return resolved === closePawTaskText(template);
  const head = sanitizeClosePawGoal(parts[0]).trimEnd();
  const tail = sanitizeClosePawGoal(parts[parts.length - 1]).trimStart();
  if (!resolved.startsWith(head)) return false;
  if (!resolved.endsWith(tail)) return false;
  if (resolved.length < head.length + tail.length) return false;
  const slot = resolved.slice(head.length, resolved.length - tail.length);
  if (Array.from(slot.trim()).length > CLOSEPAW_RESULT_SLOT_MAX_CHARS) return false;
  // Middle literal parts (rare: more than one placeholder) must appear in order.
  let cursor = head.length;
  for (const mid of parts.slice(1, -1).map((p) => sanitizeClosePawGoal(p).trim()).filter(Boolean)) {
    const at = resolved.indexOf(mid, cursor);
    if (at < 0) return false;
    cursor = at + mid.length;
  }
  return true;
}

/**
 * The RN choke-point check. `agent` must be the CURRENT definition (agent
 * store); `request` the minted approval request. True only when a seal for
 * this agent exists, the definition hash still matches, the agent's goal
 * template is the sealed one, and the resolved goal comes from it.
 */
export async function isClosePawPreapproved(
  request: { agentId?: string | null; actionType?: string | null; intentMode?: string | null; intentShareText?: string | null },
  agent: ClosePawAgentLike | null | undefined,
): Promise<boolean> {
  if (!agent || request.actionType !== 'intent' || request.intentMode !== 'closepaw') return false;
  if (!request.agentId || request.agentId !== agent.id) return false;
  const seal = (await loadClosePawPreapprovals()).find((s) => s.agentId === agent.id);
  if (!seal) return false;
  const action = closePawAction(agent);
  if (!action) return false;
  if (sanitizeClosePawGoal(action.intentShareText) !== seal.goalTemplate) return false;
  if ((await closePawDefinitionHash(agent)) !== seal.definitionHash) return false;
  return goalMatchesTemplate(request.intentShareText ?? '', seal.goalTemplate);
}

function stepTexts(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => (typeof s === 'string' ? s : s && typeof s === 'object' ? String((s as { instruction?: unknown }).instruction ?? '') : ''));
}

/**
 * Review fix: before sealing, the created agent must be exactly what the
 * user approved — same sanitized ClosePaw goal, same prompt, same steps.
 * (An edited confirm card that changed any of them registers WITHOUT a seal,
 * so the per-run ClosePaw Review stays.)
 */
export function agentMatchesApprovedDraft(
  agent: ClosePawAgentLike,
  draft: {
    prompt?: string;
    action?: { type?: string; intentMode?: string; intentShareText?: string } | null;
    actions?: Array<{ type?: string; intentMode?: string; intentShareText?: string } | null> | null;
    orchestrationSteps?: unknown;
  },
): boolean {
  const agentAction = closePawAction(agent);
  const draftAction = closePawAction({ id: '', action: draft.action ?? null, actions: draft.actions ?? null });
  if (!agentAction || !draftAction) return false;
  if (sanitizeClosePawGoal(agentAction.intentShareText) !== sanitizeClosePawGoal(draftAction.intentShareText)) return false;
  if ((agent.prompt ?? '') !== (draft.prompt ?? '')) return false;
  const agentSteps = stepTexts((agent.orchestration as { steps?: unknown } | null | undefined)?.steps);
  const draftSteps = stepTexts(draft.orchestrationSteps);
  if (agentSteps.length !== draftSteps.length) return false;
  return agentSteps.every((t, i) => t === draftSteps[i]);
}

/**
 * Review fix: the seal is honoured only for a run that the app's own
 * AgentRuntime is executing right now for this agent (process memory —
 * NativeAgentRunRegistry — never a file a same-uid process could forge), and
 * at most once per such run (one hand-off per schedule slot).
 */
export function closePawRunProvenanceOk(params: {
  activeRunStartedAt: number | null | undefined;
  /** NativeAgentRunRegistry.closePawHandoffAvailable — the once-per-run flag
   *  is owned natively so a JS reload cannot reset it; the actual fire is
   *  preceded by an atomic native claim. */
  handoffAvailable: boolean;
}): boolean {
  const started = params.activeRunStartedAt;
  if (typeof started !== 'number' || !Number.isFinite(started) || started <= 0) return false;
  return params.handoffAvailable === true;
}
