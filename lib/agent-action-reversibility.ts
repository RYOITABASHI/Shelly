/**
 * lib/agent-action-reversibility.ts — the reversible/irreversible boundary for
 * the OPTIMISTIC (rollback-type) agent execution mode.
 *
 * ─── Why this module exists ────────────────────────────────────────────────
 * Shelly's runtime action gate is PRE-approval: when approval mode is `manual`
 * (AppSettings.defaultRequireActionApproval / Agent.requireActionApproval), the
 * generated run script blocks on a signed human tap BEFORE the action fires
 * (lib/agent-executor.ts's request_and_wait_approval). That is safe but it costs
 * the felt autonomy of a "just do it, I'll undo it if I don't like it" agent.
 *
 * The roadmap entry this implements (docs/superpowers/DEFERRED.md, "次バージョン
 * のロードマップ — Hermes Agent機能ギャップ分析" item 4) asks for a POST-approval
 * mode: auto-savepoint → run immediately → offer "元に戻す" on the result.
 *
 * That trade is only defensible for operations that can ACTUALLY be undone. So
 * the entire feature hinges on one classification, which is what this file is:
 *
 *   reversible   = a file write inside a directory we snapshot with git
 *                  (lib/auto-savepoint.ts) immediately before the run.
 *   irreversible = literally everything else.
 *
 * ─── Per-action-type ruling and its rationale ──────────────────────────────
 * Rulings are keyed off store/types.ts's `AgentActionType`. Each is stated with
 * the reason it is *not* rollback-eligible, because "we could probably undo it"
 * is not the bar — "a git revert in the workspace fully erases the effect" is.
 *
 *  - `draft`        → REVERSIBLE, conditionally. It is the only action type
 *                     whose entire observable effect is writing a markdown file
 *                     to a path Shelly owns. No network egress, no shell, no
 *                     other app. See the extra destination conditions below.
 *  - `notify`       → IRREVERSIBLE. A posted system notification has already
 *                     been seen by the user (and possibly a watch/car/TV
 *                     mirror). There is no git object that un-shows it. It is
 *                     also *harmless*, which is a separate axis — harmlessness
 *                     is not reversibility, and this module only decides
 *                     reversibility. `notify` therefore keeps whatever gate it
 *                     already has; it is simply never routed through rollback.
 *  - `webhook`      → IRREVERSIBLE. An HTTPS POST has left the device. The
 *                     receiving system's state is outside any rollback we own.
 *  - `social-post`  → IRREVERSIBLE. A published post is public the moment it
 *                     lands; deletion is not undo. It additionally carries
 *                     account-level credentials (AgentSocialPostConfig), which
 *                     is a strictly higher risk tier than a local draft.
 *  - `cli`          → IRREVERSIBLE. This is the single most important "no" in
 *                     this file. A `cli` action is an arbitrary shell command
 *                     (`bash -lc "$ACTION_COMMAND"` on the legacy executor path
 *                     — lib/agent-executor.ts's cap_workspace_exec, which is
 *                     only broker-confined when SHELLY_CAP_EXEC=1). It is NOT
 *                     "a file write with extra steps": it can curl, ssh, git
 *                     push, rm outside the workspace, mutate SecureStore-backed
 *                     .env files, or start a background process that outlives
 *                     the run. There is no static way to prove a given command
 *                     is confined to workspace file writes — lib/command-safety
 *                     is a regex DENYLIST whose default verdict is SAFE, so
 *                     "not matched as dangerous" must never be read as "proven
 *                     reversible". Narrowing `cli` to a curated
 *                     workspace-writes-only template allowlist is a possible
 *                     future increment (the capability broker already has such
 *                     an allowlist), but it is deliberately NOT done here.
 *  - `intent`       → IRREVERSIBLE. Launches another app / fires an OS share
 *                     sheet. Off-device, off-app effect.
 *  - `dm-reply`     → IRREVERSIBLE. A sent message cannot be unsent.
 *  - `app-act`      → IRREVERSIBLE. Drives another app's UI via
 *                     AccessibilityService (e.g. publishing a post).
 *  - `api-call`     → IRREVERSIBLE. An outbound HTTP call to an allowlisted
 *                     host; the remote side's state is not ours to revert.
 *  - `browser-pane` → IRREVERSIBLE. Clicks/fills a live, on-screen web page
 *                     (another origin's DOM/session/form state) via a real
 *                     WebView; no git object in our workspace can undo a
 *                     page's own state change (e.g. a submitted form).
 *
 * The switch's DEFAULT branch is `irreversible`, so an action type added in the
 * future is excluded automatically (fail-closed). __tests__ additionally pin an
 * exhaustive per-type table so adding a member to `AgentActionType` fails the
 * suite until someone makes an explicit ruling here.
 *
 * ─── Extra conditions on `draft` ───────────────────────────────────────────
 * Being a file write is necessary but not sufficient — the write must land
 * inside the directory we actually snapshot:
 *
 *  1. `agentOutputTarget` must be the default 'local' ($HOME/agent-output).
 *     'obsidian' writes into the user's Vault (default /sdcard/Documents/
 *     ObsidianVault) and 'custom' into an arbitrary user path. Making those
 *     rollback-eligible would mean running `git init` inside the user's own
 *     document tree — an intrusive, surprising side effect on data Shelly does
 *     not own — and on /sdcard the repo would be world-visible. Refused.
 *  2. The agent must not be a content-studio agent. Those bypass the global
 *     output branch entirely (lib/agent-executor.ts bakes USE_GLOBAL_OUTPUT=0
 *     for them) and write to their own project paths outside agent-output.
 *  3. An orchestrated (multi-step) agent is never eligible: its steps can carry
 *     `apiCall`/cli work whose effects are not modelled by the terminal
 *     action's type at all (see lib/agent-manager.ts's normalizeSteps).
 *  4. For a multi-action fan-out (`Agent.actions`, >= 2 entries) EVERY entry
 *     must be reversible. One irreversible sibling poisons the whole run,
 *     because the actions share a single run and a single approval decision.
 *
 * ─── What this module deliberately does NOT decide ─────────────────────────
 * It does not relax, and must never be used to relax:
 *   - command-safety CRITICAL blocks,
 *   - the secret-guard route forcing,
 *   - the app-act Tier-B autonomous gate,
 *   - agent REGISTRATION confirmation (AppSettings.agentRegistrationRequireConfirm).
 * The 2026-07-14 → 2026-07-24 history is explicit that registration confirm is
 * NOT an approval-frequency knob; this feature loosens run-time workspace-write
 * approval only.
 *
 * Pure and IO-free by design so the boundary is fully unit-testable offline.
 */
import type { Agent, AgentAction, AgentActionType, AppSettings } from '@/store/types';
import { agentUsesStudioContext } from '@/lib/agent-executor';
import { isOrchestrated } from '@/lib/agent-orchestration';
import { getHomePath } from '@/lib/home-path';

export { REVERSIBLE_ACTION_TYPES, isReversibleActionType } from '@/lib/agent-reversible-action-types';

export type ReversibilityReason =
  | 'reversible-workspace-file-write'
  | 'irreversible-external-side-effect'
  | 'irreversible-arbitrary-command'
  | 'irreversible-delivered-notification'
  | 'irreversible-unknown-action-type'
  | 'destination-outside-rollback-workspace'
  | 'studio-agent-writes-outside-workspace'
  | 'orchestrated-run-not-eligible'
  | 'no-actions';

export interface ReversibilityVerdict {
  reversible: boolean;
  reason: ReversibilityReason;
  /** Short human-readable explanation, safe to show in a log or the UI. */
  detail: string;
}

/** Settings slice this module needs; a subset of AppSettings so tests stay small. */
export type ReversibilitySettings = Pick<
  AppSettings,
  'agentOutputTarget' | 'agentOptimisticWorkspaceWrites' | 'defaultRequireActionApproval'
>;

/**
 * The ONE directory the rollback tier snapshots. Must stay in lockstep with
 * lib/agent-executor.ts's save_draft_result default OUT_BASE ("$HOME/agent-output")
 * and resolveAgentOutputBase's 'local' branch.
 */
export function agentRollbackWorkspaceRoot(): string {
  return `${getHomePath()}/agent-output`;
}

function irreversible(reason: ReversibilityReason, detail: string): ReversibilityVerdict {
  return { reversible: false, reason, detail };
}

/**
 * Classify a SINGLE action. `undefined` is treated as the implicit 'draft' the
 * Agent.action doc comment documents (absent = write to outputPath), so a legacy
 * action-less agent is judged by the same draft rules rather than falling into a
 * silent third behaviour.
 */
export function classifyActionReversibility(
  action: AgentAction | undefined,
  settings: ReversibilitySettings
): ReversibilityVerdict {
  const type: AgentActionType = action?.type ?? 'draft';
  switch (type) {
    case 'draft': {
      // Only the default 'local' target lands inside agentRollbackWorkspaceRoot().
      const target = settings.agentOutputTarget ?? 'local';
      if (target !== 'local') {
        return irreversible(
          'destination-outside-rollback-workspace',
          `draft output target is "${target}"; rollback only covers the local agent-output workspace`
        );
      }
      return {
        reversible: true,
        reason: 'reversible-workspace-file-write',
        detail: 'writes a markdown draft inside the local agent-output workspace',
      };
    }
    case 'notify':
      return irreversible(
        'irreversible-delivered-notification',
        'a delivered system notification cannot be un-shown'
      );
    case 'webhook':
    case 'api-call':
    case 'social-post':
    case 'intent':
    case 'dm-reply':
    case 'app-act':
    case 'browser-pane':
      return irreversible(
        'irreversible-external-side-effect',
        `"${type}" leaves the device or another app; no local snapshot can undo it`
      );
    case 'cli':
      return irreversible(
        'irreversible-arbitrary-command',
        'a cli action is an arbitrary shell command; it cannot be proven to be a workspace-only file write'
      );
    default:
      // Fail-closed: an AgentActionType added later is irreversible until
      // someone rules on it here explicitly.
      return irreversible(
        'irreversible-unknown-action-type',
        `unrecognised action type "${String(type)}" — treated as irreversible`
      );
  }
}

/**
 * Classify a whole RUN. Reversible only when every action the run will dispatch
 * is reversible AND the agent's shape keeps its writes inside the snapshotted
 * workspace. This is the function the run path must consult — never
 * classifyActionReversibility alone, which sees one action out of context.
 */
export function classifyRunReversibility(
  agent: Pick<Agent, 'action' | 'actions' | 'orchestration' | 'prompt' | 'name'> & Partial<Agent>,
  settings: ReversibilitySettings
): ReversibilityVerdict {
  // (3) orchestrated chains: steps carry work the terminal action doesn't model.
  // Uses the SAME predicate the run path uses to decide it is a chain
  // (lib/agent-orchestration.isOrchestrated), so the two can never disagree.
  if (isOrchestrated(agent.orchestration)) {
    return irreversible(
      'orchestrated-run-not-eligible',
      'multi-step orchestrated runs are outside the rollback tier in v1'
    );
  }
  // (2) content-studio agents write outside $HOME/agent-output entirely.
  if (agentUsesStudioContext(agent as Agent)) {
    return irreversible(
      'studio-agent-writes-outside-workspace',
      'content-studio agents write to their own project paths, not the rollback workspace'
    );
  }
  // (4) multi-action fan-out: ALL entries must be reversible.
  const multi = agent.actions;
  if (Array.isArray(multi) && multi.length >= 2) {
    for (const entry of multi) {
      const verdict = classifyActionReversibility(entry, settings);
      if (!verdict.reversible) return verdict;
    }
    return {
      reversible: true,
      reason: 'reversible-workspace-file-write',
      detail: `all ${multi.length} actions write drafts inside the local agent-output workspace`,
    };
  }
  if (Array.isArray(multi) && multi.length === 1) {
    // <2 entries falls back to `action` in the executor; judge what will run.
    return classifyActionReversibility(agent.action ?? multi[0], settings);
  }
  return classifyActionReversibility(agent.action, settings);
}

/**
 * The single predicate the run path calls. Rollback-type (post-approval)
 * execution is allowed only when ALL of these hold:
 *   a) the user opted in (AppSettings.agentOptimisticWorkspaceWrites, default OFF),
 *   b) the run is classified reversible by classifyRunReversibility.
 *
 * NOTE the deliberate absence of a "…and approval mode is manual" condition:
 * eligibility is a property of the RUN, not of the current gate setting. The
 * caller decides whether an approval tap was going to happen at all; this
 * function only answers "may this run be executed optimistically and undone".
 */
export function isRollbackEligibleRun(
  agent: Pick<Agent, 'action' | 'actions' | 'orchestration' | 'prompt' | 'name'> & Partial<Agent>,
  settings: ReversibilitySettings
): boolean {
  if (settings.agentOptimisticWorkspaceWrites !== true) return false;
  return classifyRunReversibility(agent, settings).reversible;
}

/**
 * Whether this run would otherwise block on a pre-approval tap — i.e. whether
 * switching it to the rollback tier actually changes anything. Mirrors the
 * script's ACTION_APPROVAL_MODE resolution (lib/agent-executor.ts:
 * ACTION_APPROVAL_MODE_OVERRIDE from Agent.requireActionApproval, else
 * SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).
 */
export function runWouldRequireApprovalTap(
  agent: Pick<Agent, 'requireActionApproval'>,
  settings: ReversibilitySettings
): boolean {
  return agent.requireActionApproval ?? settings.defaultRequireActionApproval === true;
}
