/**
 * lib/agent-executor.ts — Runs agent tasks in isolated tmux sessions.
 * Generates per-agent shell scripts and manages execution lifecycle.
 */
import { Agent, AgentAction, AgentActionType, AgentRouteDecision, ToolChoice } from '@/store/types';
import { resolveAgentRoute, toolChoiceToLabel } from './agent-tool-router';
import { detectRouteSignals } from './agent-router-scoring';
import { requiresApiKeyEnv, resolveForAutonomous } from './agent-credential-policy';
import { getHomePath } from '@/lib/home-path';
import { evaluateAgentActionCommand } from './agent-action-safety';
import { buildAgentPolicy } from './agent-policy';
import { compareRouteDecision } from './model-router';
import { logInfo, logWarn } from './debug-logger';
import {
  MAX_PROMPT_CHARS,
  MAX_RESULT_CARRY_CHARS,
  NormalizedStep,
  isOrchestrated,
  normalizeSteps,
  resolveBudget,
} from './agent-orchestration';
import { clampCharLimit } from './agent-pipeline-presets';
import { isSafeConnectorId, socialConnectorEnvPrefix } from './social-connectors';

// MODEL-001 Phase A shadow instrumentation (read-only, observational only —
// see lib/model-router/shadow.ts and lib/model-router/wiring.ts). This wires
// the dormant shadow comparator into the ONE real production call site of
// resolveAgentRoute (generateRunScript below) so it starts accumulating real
// live/shadow parity evidence ahead of any future cutover decision
// (wiring.ts §MIGRATION). It changes NOTHING about which tool a run actually
// uses — MODEL_ROUTER_ENABLED stays false and `routeResolution` below is
// untouched by this call. A running in-memory count (reset on process
// restart — this is diagnostic signal, not a persisted metric) is logged
// alongside each comparison so per-run log lines can be read as a trend.
const modelRouterShadowStats = { total: 0, unexpectedDivergences: 0 };

/**
 * Run the dormant MODEL-001 shadow comparator against the same Agent the live
 * resolveAgentRoute() call just resolved, and log the STRUCTURE of the result
 * (tool-type enums, guard/route labels, rejection reasons, boolean
 * requirements) — never the agent's prompt/description/action text, which
 * lib/debug-logger.ts's logInfo/logWarn additionally redact via
 * redactSecrets() as defense in depth. Errors inside the shadow path (a bug
 * in dormant/experimental code) are caught here and MUST NOT propagate — a
 * failure in this function can never break the real agent run that called it.
 */
function runModelRouterShadowComparison(agent: Agent): void {
  try {
    const result = compareRouteDecision(agent);
    modelRouterShadowStats.total += 1;
    const summary = {
      liveTool: result.live.tool.type,
      liveGuard: result.live.decision.guard,
      liveRoute: result.live.decision.route,
      shadowTool: result.shadow.chosen?.toolType ?? null,
      shadowRejectedReasons: result.shadow.rejected.map((r) => r.reason),
      requirements: result.requirements,
      secretInvariantHolds: result.secretInvariantHolds,
      knownDivergence: result.knownDivergence,
      totalComparisons: modelRouterShadowStats.total,
    };
    if (result.unexpectedDivergence) {
      // THE interesting signal per shadow.ts's own classification — live chose
      // a tool the dormant MODEL-001 selector considers structurally
      // ineligible, or vice versa. Expected/intentional divergences (manual
      // pin, autonomous policy, configured-tool passthrough, affinity
      // ranking, secret-fail-closed-deny) are logged at info level only.
      modelRouterShadowStats.unexpectedDivergences += 1;
      logWarn('ModelRouterShadow', 'unexpected live/shadow routing divergence', {
        ...summary,
        unexpectedDivergence: result.unexpectedDivergence,
        totalUnexpectedDivergences: modelRouterShadowStats.unexpectedDivergences,
      });
    } else {
      logInfo('ModelRouterShadow', 'shadow comparison complete', summary);
    }
  } catch (error) {
    // Dormant/experimental code must never be able to take down a live agent
    // run — swallow and log, don't rethrow.
    logWarn('ModelRouterShadow', 'shadow comparator threw — ignored, live route unaffected', error);
  }
}

const MAX_CONCURRENT = 2;

const DEFAULT_TIMEOUT_SEC = 600; // 10 minutes
// Bump in lockstep with AgentRuntime.kt's CURRENT_SCRIPT_VERSION (native gate
// that refuses to run a stale on-disk script) whenever the generated script's
// runtime BEHAVIOR changes — see __tests__/agent-executor-cap-broker.test.ts's
// "bumps the script version in lockstep with the native gate".
// v13 (bug #155(b)): a real multi-step orchestrated agent whose tool is
// unsupported by the PlanSpec chain executor (e.g. autonomous `auto` ->
// codex CLI) falls back to THIS legacy single-shot script on every scheduled/
// native fire — see ORCHESTRATION_COLLAPSED_NOTE below.
// v14: agent.workspaceRoot now reaches codexDriverCommand()'s DRIVER_CWD
// (previously hardcoded to $PROJECT_DIR), and a new shelly_git() helper
// preloads libexec_wrapper.so scoped to git only so HTTPS git operations
// work from the autonomous runtime the same way the interactive PTY's
// git() already does (DEFERRED.md #2 残り / git-over-HTTPS latent gap).
// v15 (DEFERRED.md #3 ab-article-eval が B2 driver を迂回): articleEvalCommand()'s
// codex leg no longer shells out to a bare `codex exec` (which runs
// danger-full-access, bypassing command-safety/workspace-boundary
// classification for every tool-call codex makes internally) — it now
// routes through the same B2 driver every other codex-resolved autonomous
// tool uses.
// v16 (2026-07-17, bug #155(b) follow-up, DEFERRED.md): a real (>=2 step)
// orchestrated agent whose resolved tool is the codex driver, with every
// attempted step carrying neither a per-step tool pin nor an apiCall step,
// now runs its FULL chain on an unattended/scheduled fire instead of
// silently collapsing to agent.prompt as a single step — see
// codexOrchestrationChainCommand() and canRunOrchestrationChain below.
// ORCHESTRATION_COLLAPSED_NOTE now fires only for the residual unsupported
// cases (a step with its own tool pin or apiCall, or a non-cli/non-PlanSpec
// tool such as ab-article-eval). Bumped because the generated script's
// runtime BEHAVIOR changed for this case (new loop, new helper functions,
// new bash variables), not just cosmetic text.
// v17 (2026-07-17, docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1):
// wait_action_approval() previously trusted a reply file on runId +
// requestSha256 equality alone — both values are derivable by the agent
// script itself (same uid as the reply file it's reading), so the script
// could forge its own action-approval reply and bypass the human-approval
// gate for its own configured action (cli/webhook/notify/etc). Now mirrors
// the escalation-reply signing fix (AgentEscalationBridge / Android Keystore
// RSA + shelly-agent-driver.js's verifier): AgentActionApprovalBridge signs
// every reply with a dedicated (separate-alias) Keystore key, and the new
// verify_action_approval_reply() helper checks that signature via a bundled
// node verifier before wait_action_approval trusts a reply — an unsigned or
// badly-signed reply is now rejected exactly like a runId/requestSha256
// mismatch already was. Bumped because the generated script's runtime
// BEHAVIOR changed (new helper function, new bash variables, new rejection
// path), not just cosmetic text.
// v18 (2026-07-17, docs/superpowers/DEFERRED.md "Capability broker Phase 0"
// mid-run host approval follow-up): http_post_json's SHELLY_CAP_BROKER=1
// invocation now passes --approval-dir/--approval-reply-dir/--agent-id/
// --agent-name/--run-id/--approval-timeout-seconds so a non-allowlisted-host
// 'approve' verdict can be resolved by a human mid-run instead of failing
// closed immediately (scripts/shelly-capability-broker.js's
// requestHostApproval). Flag-gated OFF by default (SHELLY_CAP_BROKER=0), but
// bumped because the generated script's http_post_json BEHAVIOR changed
// (new args at the call site) for the SHELLY_CAP_BROKER=1 case.
// v19 (2026-07-17, on-device bug repro: a Groq-routed agent told to "record
// the current time" wrote a hallucinated 2024 date — no backend's
// model-facing prompt ever carried the real wall-clock date/time; `date` was
// only ever used for internal bookkeeping, e.g. run IDs/log timestamps).
// Every PROMPT_FILE-assembly call site (local/perplexity/cerebras/groq/
// gemini/codex single-shot, the codex orchestration chain, the ab-article-eval
// hybrid path) now leads the assembled prompt with a runtime-computed
// CURRENT_DATETIME_CONTEXT line (device-local date/weekday/time via `date`),
// BEFORE the agent's own prompt text and BEFORE SOURCE_CONTEXT, so it survives
// every backend's `head -c` truncation. Bumped because the generated script's
// prompt-assembly BEHAVIOR changed (new leading line in every model-facing
// prompt), not just cosmetic text.
// v20 (2026-07-18, docs/superpowers/DEFERRED.md "エージェント二重実行レース"
// chain-lock follow-up): closes the remaining native-alarm-vs-attended-chain
// window the JS-side inFlightAgentRuns dedupe (agent-manager.ts) couldn't
// reach — a native AlarmManager fire runs this .sh directly, never through
// runAgentNow. Two changes: (1) a new CHAIN_LOCK_DIR/CHAIN_LOCK_NONCE check,
// ahead of the per-agent lock, skips ("previous run still active") unless the
// live chain-lock's token matches this invocation's baked nonce — see
// lib/agent-manager.ts's acquireChainLock/disarmChainLockToken (the "arm"
// write is folded into materializeAgentBody's own write batch, not a
// separate function — see MaterializeRunOpts.chainLockNonce's doc comment)
// for the JS side that owns this lock across an
// orchestrated chain's/escalation ladder's separate per-step per-invocation
// runs. (2) the pre-existing per-agent LOCK_FILE check's
// `[ -f "$LOCK_FILE" ] ... echo $$ > "$LOCK_FILE"` was a non-atomic
// check-then-act (TOCTOU) — hardened to an mkdir-based atomic gate
// (LOCK_DIR="$LOCK_FILE.lockdir"), mirroring REGISTRY_LOCK's existing
// mkdir pattern, while LOCK_FILE itself keeps its exact prior name/format so
// ACTIVE_COUNT's `find -name '*.pid'` glob and generateStopCommand() are
// unaffected. Bumped because the generated script's runtime BEHAVIOR changed
// (new skip path, new lock primitive), not just cosmetic text.
// v21 (2026-07-21, Fable5 UX consultation): successful draft saves now carry
// their resolved primary/mirror destinations into the run log and completion
// notification. The genuine same-script Codex orchestration loop also writes
// LOG_DIR/current.json immediately before each step dispatch, while cleanup's
// EXIT path removes the marker on success, failure, or crash.
// v22 (2026-07-21, Sidebar RUNNING-row plumbing): fixes a v21 bug where
// LOG_DIR/current.json's "tool" field was double-quoted (CODEX_ORCH_TOOL_JSON
// is already a JSON string literal including its own quotes; the printf
// format wrapped it in a second pair, e.g. `""Codex CLI""`), making the file
// invalid JSON and silently defeating the "STEP n/m · tool" detail line in
// Sidebar's new RUNNING section. No other behavior change.
// v23 (2026-07-22, social auto-post connectors): new 'social-post' action —
// dispatch_agent_action gains a social-post) case + dispatch_social_post()/
// social_connector_env()/social_host_is_allowlisted()/social_require_url_host()
// helpers covering discord/slack/telegram/mastodon/misskey/wordpress/bluesky
// (bluesky is a two-step createSession→createRecord exchange). Connector
// secrets are resolved at RUNTIME from $ENV_FILE (SOCIAL_CONNECTOR_<ID>_<FIELD>
// vars synced by settings-store's addSocialConnector — the PERPLEXITY_API_KEY
// pattern) via bash indirection on the baked ACTION_SOCIAL_ENV_PREFIX, never
// literal-inlined. Approval: a non-allowlisted connector host requires a human
// tap EVERY time regardless of ACTION_APPROVAL_MODE; only hosts opted into
// SHELLY_SOCIAL_HOST_ALLOWLIST (the social twin of
// SHELLY_WEBHOOK_HOST_ALLOWLIST) take the ordinary request_and_wait_approval
// path. http_post_json's SHELLY_CAP_BROKER=1 invocation also gains a
// --header-file pass-through (SHELLY_CAP_HEADER_FILE) so connector
// Bearer/Basic headers survive broker mode. Bumped because the generated
// script's runtime BEHAVIOR changed (new action case, new helper functions,
// new broker arg), not just cosmetic text.
// v24 (2026-07-23, multi-destination action fan-out): a new Agent.actions
// (>= 2 entries — see its own doc comment in store/types.ts) is dispatched as
// a bash loop over dispatch_agent_action(), one call per action, each
// independently re-running the SAME per-type approval/quality-gate/command-
// safety checks a single Agent.action already goes through — no privilege
// widening, only the COUNT of actions a run may dispatch. A fresh
// ACTION_RUN_ID (indexed by loop position) is generated per action so two
// actions in the same run never collide on the same approval request/reply
// file, and so AgentRuntime.kt's approval-notifier `seen` de-dupe cannot drop
// the second action's prompt because it looks like an already-shown request.
// One action's failure/decline does not stop the others (ACTION_DISPATCH_RC
// is captured via `|| ACTION_DISPATCH_RC=$?`, never left to trip `set -e`);
// the run's overall STATUS is reduced per AgentRunLog.status's own doc
// comment (any success -> success, else any hard error -> error, else
// skipped), and every action's individual outcome is recorded in the new
// run-log `actionResults` array. Absent/< 2 `actions` takes the EXACT
// pre-v24 single-action code path — see the "byte-identical for a single-
// action agent" regression test. Bumped because the generated script's
// runtime BEHAVIOR changes for a multi-action agent (new loop, new helper
// variables), not just cosmetic text.
// v25 (2026-07-24, escalation timeout no longer permanently discards a
// missed approval): all three shelly-agent-driver.js invocations now pass
// --escalation-timeout-action queue instead of relying on the driver's own
// 'decline' default. On-device finding: an unattended/scheduled run whose
// boundary-crossing escalation notification wasn't tapped within the
// timeout (2 min default) was declining AND deleting the on-disk request
// file (cleanupEscalationFiles) — so even a human who noticed the
// still-visible Android notification later and tapped "許可" got nothing:
// AgentEscalationBridge.kt's writeHumanReply requires the request file to
// still exist. 'queue' mode keeps that file on disk (marked state:"queued")
// instead of deleting it, so a LATE tap still succeeds and writes a 24h
// single-use pre-approval grant (AgentEscalationBridge's
// DEFAULT_QUEUED_GRANT_TTL_MS) that the agent's NEXT identical-command run
// (e.g. tomorrow's daily fire) can auto-consume without a fresh prompt —
// this grant-issuing code path already existed and needed no changes, it
// was simply unreachable because the request file never survived to be
// read. Today's already-in-flight run still fails/declines either way (the
// process has exited by the time a human responds) — this only fixes
// runs AFTER the one whose notification was missed. Bumped because the
// generated script's driver invocation arguments change.
// v26 (2026-07-24, device-status context injection): every model-facing
// PROMPT_FILE assembly now leads with a DEVICE_STATUS_CONTEXT line (right
// after CURRENT_DATETIME_CONTEXT), built by reading every *.json file under
// $HOME/.shelly/device-status/ — a snapshot AgentRuntime.kt's
// DeviceStatusBridge refreshes natively (currently battery only) before
// this script even starts. On-device finding: a "notify battery level"
// agent asked the model to fetch it, and the model's only option — a shell
// read of /sys/class/power_supply — is denied by SELinux to an unprivileged
// app process (root would be needed), even though the SAME data is
// trivially available to the app itself via the public BatteryManager API.
// This is read here with plain shell BEFORE the model ever runs (never a
// model-proposed command), so neither the boundary-policy classifier nor
// the capability broker is ever involved — see DeviceStatusBridge's own doc
// comment for the full reasoning (mirrors the CURRENT_DATETIME_CONTEXT v19
// precedent exactly). Bumped because the generated script's prompt-assembly
// BEHAVIOR changed (new leading line in every model-facing prompt).
const AGENT_SCRIPT_VERSION = 26;
const LOCAL_MODEL_LIGHT = 'Qwen3.5-0.8B-Q4_K_M';
const LOCAL_MODEL_BALANCED = 'Qwen3.5-2B-Q4_K_M';
const LOCAL_MODEL_QUALITY = 'Qwen3.5-4B-Q4_K_M';

/** bug #155(b) follow-up: the resolved (TS-side) inputs codexOrchestrationChainCommand
 *  needs to bake a real bash-side chain loop. Every NUMBER here is already the
 *  fully-resolved value from lib/agent-orchestration.ts's resolveBudget — the
 *  bash side never reimplements that math, only the (inherently runtime-
 *  dependent) prompt-carry TEXT ASSEMBLY. `steps` is the ALREADY-budget-sliced
 *  attemptable list (see generateRunScript's attemptableOrchestrationSteps);
 *  `totalStepCount` is the FULL (un-sliced) normalized step count, needed to
 *  detect whether a run that budget-capped before its true final step should
 *  suppress the action dispatch (mirrors runAgentOrchestrated's `isFinalStep`). */
export interface OrchestrationChainOptions {
  basePrompt: string;
  steps: NormalizedStep[];
  totalStepCount: number;
  maxSteps: number;
  totalTimeoutMs: number;
}

type ToolCommandOptions = {
  autonomous: boolean;
  actionType: AgentActionType;
  /** B2: the AutonomyPolicy JSON passed to the driver via --policy-json (inline
   *  arg, never a file the agent can read — preserves the §6 invariant). */
  policyJson?: string;
  /** Present only for the exact case generateRunScript's canRunOrchestrationChain
   *  validates (see its own doc comment) — swaps the 'cli' case's single
   *  codexDriverCommand() call for codexOrchestrationChainCommand()'s loop. */
  orchestrationChain?: OrchestrationChainOptions;
};

const ACTION_OUTPUT_INSTRUCTIONS: Record<AgentActionType, string> = {
  draft: 'Write the requested document or content directly. Do not add a preamble saying that a draft was created.',
  notify: 'Write the notification message itself. Unless explicit user instructions request otherwise, keep it to a few words or one sentence.',
  webhook: 'Produce exactly the payload content requested for the webhook.',
  cli: 'Produce exactly the content needed by the requested command or command workflow.',
  intent: 'Produce exactly the text or content needed for the requested app or share action.',
  'dm-reply': 'Write the reply message itself as a natural, short conversational response unless explicit user instructions request otherwise.',
  // Phase 4: real dispatch path, see dispatch_agent_action's app-act) case
  // below and agent-plan-spec.ts toPlanAction's 'app-act' case.
  'app-act': 'Produce exactly the content needed for the requested app action.',
  // api-call (v1) is PlanSpec-executor-only (scripts/shelly-plan-executor.js) —
  // deliberately NOT wired into this legacy .sh executor's dispatch_agent_action
  // (see the plan/DEFERRED.md entry for this feature). This entry exists only
  // to satisfy Record<AgentActionType, string> exhaustiveness now that
  // AgentActionType includes 'api-call'; it is unreachable in practice because
  // lib/agent-manager.ts's runAgentNow refuses to run any agent carrying an
  // api-call action/step through this attended .sh path at all.
  'api-call': 'Produce exactly the content needed for the requested API call.',
  // social-post (2026-07-22): the post text ships as-is (after {{result}}
  // substitution) to the connector's platform — see dispatch_agent_action's
  // social-post) case below.
  'social-post': 'Write the social media post text itself, ready to publish as-is. Unless explicit user instructions request otherwise, keep it short and platform-appropriate.',
};
const ACTION_OUTPUT_RULES = 'Follow explicit user instructions for content, format, length, and tone. When they are not specified, be direct and concise. Output only the requested deliverable. Never add meta-commentary about your reasoning or interpretation of the request.';

function actionSystemPromptJson(actionType: AgentActionType): string {
  return JSON.stringify(`${ACTION_OUTPUT_INSTRUCTIONS[actionType]} ${ACTION_OUTPUT_RULES}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function paths() {
  const home = getHomePath();
  const shellyDir = `${home}/.shelly`;
  const agentsDir = `${shellyDir}/agents`;
  const tmpDir = `${shellyDir}/tmp`;
  const locksDir = `${agentsDir}/locks`;
  const logsDir = `${agentsDir}/logs`;
  return {
    home,
    shellyDir,
    agentsDir,
    tmpDir,
    locksDir,
    logsDir,
    envFile: `${agentsDir}/.env`,
    dmPairingsFile: `${agentsDir}/dm-pairings.json`,
  };
}

export function selectAutonomousLocalModel(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/\b4b\b|高品質|品質確認|quality|deep|精査|推敲/.test(lower)) {
    return LOCAL_MODEL_QUALITY;
  }
  if (
    /記事|下書き|draft|essay|longform|要約|summarize|比較|compare|評価|eval|検証|review/.test(lower) ||
    prompt.length > 1200
  ) {
    return LOCAL_MODEL_BALANCED;
  }
  if (/fallback|安定|軽量/.test(lower)) {
    return LOCAL_MODEL_LIGHT;
  }
  return LOCAL_MODEL_LIGHT;
}

/**
 * The content-studio context block — source-registry dedup list, recent drafts,
 * and content-studio/Obsidian git state — only helps the article pipeline. It
 * was being prepended (up to ~20KB) to EVERY agent prompt, including ad-hoc
 * `@agent` tasks, which forced the on-device model to prompt-process thousands
 * of irrelevant tokens (a trivial "1+1は?" took ~2 min on the phone CPU). Gate
 * it to agents that actually feed the content pipeline: the article evaluator,
 * or an agent whose output lands in the content-studio project / Obsidian vault.
 */
export function agentUsesStudioContext(agent: Agent): boolean {
  // The article evaluator is always content. Uses the authored tool (resolution
  // to local/cli happens later) so autonomous resolution can't mis-gate it.
  if (agent.tool?.type === 'ab-article-eval') return true;
  // Output landing in the content-studio project / Obsidian vault → content task.
  const out = (agent.outputPath || '').toLowerCase();
  if (
    out.includes('content-studio') ||
    out.includes('obsidianvault') ||
    out.includes('obsidian') ||
    out.includes('/drafts/') ||
    out.includes('30_build_log') ||
    out.includes('90_log')
  ) {
    return true;
  }
  // Content-DRAFTING tasks (write an article/essay/blog/draft) benefit from the
  // AI_CONTEXT + recent-drafts + source-dedup context. A plain web-COLLECTION
  // task ("collect today's news") does NOT — and injecting ~30–50KB of
  // content-studio context into its cloud request blew the model's token budget
  // / tripped the fallback-marker detector, needlessly escalating Gemini→Codex.
  // So gate on the drafting intent, NOT merely on autonomous/scheduled.
  const prompt = (agent.prompt || '').toLowerCase();
  return /記事|下書き|執筆|寄稿|コラム|論説|\bdraft\b|\bessay\b|\bblog\b|\barticle\b|\bcolumn\b/.test(prompt);
}

// Keep a-z 0-9 and CJK (Hiragana / Katakana / CJK ideographs / half-width kana);
// everything else collapses to a separator. A pure-CJK agent name used to slug to
// "" (the old [^a-z0-9] strip), producing "2026-06-24-.md" with an empty title.
const SLUG_DROP_RE = /[^a-z0-9぀-ヿ㐀-鿿ｦ-ﾟ]+/g;

/** Filesystem-safe slug from an agent name; falls back to the id when empty. */
export function computeAgentSlug(name: string, fallback: string): string {
  const s = (name || '')
    .toLowerCase()
    .replace(SLUG_DROP_RE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/** Subset of AppSettings this preview needs — kept structural (not imported
 *  from store/types.ts) so callers can pass either the live store slice or an
 *  ad-hoc literal without a cast. */
export interface AgentOutputBaseSettings {
  agentOutputTarget?: 'local' | 'obsidian' | 'custom';
  agentVaultPath?: string;
  agentTopicFolder?: string;
  agentCustomPath?: string;
}

/**
 * UI-preview mirror of save_draft_result()'s USE_GLOBAL_OUTPUT branch (the
 * OUT_BASE case statement a few hundred lines below, in the generated shell
 * script — "obsidian" / "custom" / default). Reproduces it EXACTLY, including
 * the quirk that the topic folder is appended for the obsidian/custom targets
 * ONLY — the bare 'local' default case never gets a topic suffix, even though
 * the doc comment on AppSettings.agentTopicFolder (store/types.ts) describes a
 * universal "<base>/<topic?>/..." layout. If that's ever unified, update both
 * this function and the shell case statement together.
 *
 * $HOME comes from lib/home-path.ts's getHomePath(), a JS-side best-effort
 * cache resolved asynchronously from the native side at startup — on a cold
 * start before it resolves, this returns the documented fallback constant
 * rather than the real on-device path, so treat the result as a preview, not
 * a guarantee.
 */
export function resolveAgentOutputBase(settings: AgentOutputBaseSettings): string {
  const topic = (settings.agentTopicFolder ?? '').trim();
  const topicSuffix = topic ? `/${topic}` : '';
  switch (settings.agentOutputTarget ?? 'local') {
    case 'obsidian':
      return `${(settings.agentVaultPath ?? '').trim() || '/sdcard/Documents/ObsidianVault'}${topicSuffix}`;
    case 'custom':
      return `${(settings.agentCustomPath ?? '').trim() || `${getHomePath()}/agent-output`}${topicSuffix}`;
    default:
      return `${getHomePath()}/agent-output`;
  }
}

/**
 * Full resolved-path PREVIEW for that same branch:
 * `<base>/<date>/<date>_<slug>.md` — mirrors the SAVED_FILE line right after
 * the OUT_BASE case statement. `<date>` is always a literal placeholder here:
 * the actual save date is a runtime unknown (a scheduled agent may not fire
 * today), so guessing it would misrepresent a preview as a promise. Pass a
 * concrete slug (computeAgentSlug()) for a specific agent's preview, or a
 * generic placeholder such as '<title>' for a settings-screen preview where
 * no agent is in context yet.
 */
export function resolveAgentOutputPathPreview(settings: AgentOutputBaseSettings, slug: string): string {
  return `${resolveAgentOutputBase(settings)}/<date>/<date>_${slug}.md`;
}

/**
 * Sanitize an agent output-filename template. Supports {date} {slug} {time}
 * placeholders and `/` for date-folder layouts (e.g. "{date}/{slug}.md"). Strips
 * absolute paths and `..` traversal so a template can't escape the output dir.
 * Empty/absent → the legacy default "{date}-{slug}".
 */
export function sanitizeOutputTemplate(template: string | null | undefined): string {
  const raw = (template ?? '').trim();
  if (!raw) return '{date}-{slug}';
  const cleaned = raw
    .replace(/[^A-Za-z0-9 _./{}぀-ヿ㐀-鿿ｦ-ﾟ-]+/g, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  return cleaned || '{date}-{slug}';
}

type ActionBakedFields = {
  type: AgentActionType;
  webhookUrl: string;
  command: string;
  intentMode: string;
  intentTarget: string;
  intentShareText: string;
  dmPairingId: string;
  dmReplyText: string;
  appActRecipeId: string;
  appActParamsJson: string;
  socialPlatform: string;
  socialConnectorId: string;
  socialEnvPrefix: string;
  socialText: string;
  commandSafety: ReturnType<typeof evaluateAgentActionCommand>;
};

/**
 * Multi-action fan-out (v24, Agent.actions): bakes ONE AgentAction into the
 * same field shape generateRunScript's single-action path computes inline
 * (see its own `actionType`/`actionWebhookUrl`/… locals just below) — used
 * ONLY to build the per-index bash arrays for a >= 2-entry `actions` run.
 * Deliberately NOT shared with the single-action inline computation (a small
 * duplication, not a refactor of it) so that code path — the one every
 * existing agent/test exercises — stays byte-for-byte untouched by this
 * feature; see the "byte-identical for a single-action agent" regression
 * test this invariant protects.
 */
function bakeActionFields(action: AgentAction | undefined): ActionBakedFields {
  const type = action?.type ?? 'draft';
  const webhookUrl = type === 'webhook' ? action?.webhookUrl ?? '' : '';
  const command = type === 'cli' ? action?.command ?? '' : '';
  const intentMode = type === 'intent' ? (action?.intentMode ?? '') : '';
  const intentTarget = type === 'intent' ? (action?.intentTarget ?? '') : '';
  const intentShareText = type === 'intent' ? (action?.intentShareText ?? '') : '';
  const dmPairingId = type === 'dm-reply' ? action?.dmPairingId ?? '' : '';
  const dmReplyText = type === 'dm-reply' ? action?.dmReplyText ?? '' : '';
  const appActRecipeId = type === 'app-act' ? (action?.appActRecipeId ?? '') : '';
  const appActParamsJson = type === 'app-act' ? JSON.stringify(action?.appActParams ?? {}) : '{}';
  const socialPost = type === 'social-post' ? action?.socialPost : undefined;
  const socialPlatform = socialPost?.platform ?? '';
  const socialConnectorId =
    socialPost && isSafeConnectorId(socialPost.connectorId ?? '') ? socialPost.connectorId : '';
  const socialEnvPrefix = socialConnectorId ? socialConnectorEnvPrefix(socialConnectorId) : '';
  const socialText = socialPost ? (socialPost.text?.trim() ? socialPost.text : '{{result}}') : '';
  const commandSafety = evaluateAgentActionCommand(command);
  return {
    type,
    webhookUrl,
    command,
    intentMode,
    intentTarget,
    intentShareText,
    dmPairingId,
    dmReplyText,
    appActRecipeId,
    appActParamsJson,
    socialPlatform,
    socialConnectorId,
    socialEnvPrefix,
    socialText,
    commandSafety,
  };
}

/** Bakes a bash indexed-array literal from a shell-quoted-per-element list, e.g.
 *  `('a' 'b' 'c')`. Every element goes through shellQuote, matching every other
 *  scalar ACTION_* bake in this file. */
function bashArrayLiteral(values: string[]): string {
  return `(${values.map((v) => shellQuote(v)).join(' ')})`;
}

/**
 * Generate a per-agent script: run-agent-{id}.sh
 * All values pre-computed in TypeScript, embedded as bash string literals.
 */
export function generateRunScript(agent: Agent, opts: { suppressAction?: boolean; suppressErrorNotification?: boolean; autonomousCloudConsent?: boolean; autonomousCloudStop?: boolean; suppressWebCodexBake?: boolean; attended?: boolean; chainLockNonce?: string } = {}): string {
  const { home, tmpDir, locksDir, logsDir, envFile, dmPairingsFile } = paths();
  const agentId = agent.id;
  const resultFile = `${tmpDir}/agent-result-${agentId}.md`;
  const lockFile = `${locksDir}/${agentId}.pid`;
  const logDir = `${logsDir}/${agentId}`;
  // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): mkdir-based
  // atomicity gate for LOCK_FILE's write (see the v20 script-version comment
  // above) — a companion directory next to the existing .pid file, not a
  // rename, so ACTIVE_COUNT's `*.pid` glob and generateStopCommand() below
  // stay unaffected.
  const lockDir = `${lockFile}.lockdir`;
  const chainLockDir = getChainLockDir(agentId);

  const routeResolution = resolveAgentRoute(agent);

  // MODEL-001 Phase A: observe-only. Never affects `routeResolution` / `tool`
  // below, and any error inside is caught internally — see
  // runModelRouterShadowComparison's own doc comment above.
  runModelRouterShadowComparison(agent);

  // Autonomous runs are OAuth/local only (Spec A §4): resolve `auto`→codex and
  // refuse api-key backends — there is no key in the autonomous agent path
  // (use OAuth-Codex/local, or the credential broker). Fail-closed.
  //
  // N1 exception: with the user's informed consent (opts.autonomousCloudConsent),
  // a WEB-MANDATORY autonomous task may keep a keyed WEB backend (Gemini /
  // Perplexity) — these are stateless completions, so the key authenticates the
  // request and never reaches a model/shell. secret-guard still wins (a secret
  // forces routeResolution.tool to local above, so consentWebTool is false then).
  let tool: ToolChoice = routeResolution.tool;
  // P1: when an autonomous web-mandatory run keeps its keyed web backend, bake a
  // Codex fallback into the on-disk script so the UNATTENDED scheduled fire (which
  // runs the .sh directly via AlarmManager — no foreground TS ladder) still
  // escalates web→Codex. Suppressed when the user opted to STOP on free-tier
  // exhaustion (autonomousCloudStop), and when Codex isn't a valid autonomous tool.
  let bakeWebCodexLadder = false;
  if (agent.autonomous) {
    const sig = detectRouteSignals(agent.prompt);
    const consentWebTool =
      opts.autonomousCloudConsent === true &&
      sig.needsWeb &&
      (tool.type === 'gemini-api' || tool.type === 'perplexity');
    if (!consentWebTool) {
      const resolved = resolveForAutonomous(tool);
      if (!resolved) {
        return refusalScript(agentId, resultFile, logDir, routeResolution.decision, tool.type);
      }
      tool = resolved;
    } else {
      // Bake the in-shell web→Codex fallback ONLY for the unattended on-disk
      // script. The foreground TS ladder owns escalation per-attempt and passes
      // suppressWebCodexBake so Codex isn't run twice (in-shell AND as the next
      // ladder hop). Also suppressed when the user opted to STOP on exhaustion.
      bakeWebCodexLadder = opts.autonomousCloudStop !== true && opts.suppressWebCodexBake !== true;
    }
  }
  if (agent.autonomous && tool.type === 'local' && !tool.model) {
    tool = { ...tool, model: selectAutonomousLocalModel(agent.prompt) };
  }

  const toolLabel = toolChoiceToLabel(tool);
  const routeDecision = {
    ...routeResolution.decision,
    toolType: tool.type,
    toolLabel,
    route: tool.type === 'local' ? 'on-device' : tool.type === 'ab-article-eval' ? 'hybrid' : 'cloud',
  };
  const routeDecisionJson = JSON.stringify(routeDecision);
  const apiKeyEnvScrub = requiresApiKeyEnv(tool)
    ? ''
    : 'unset PERPLEXITY_API_KEY GEMINI_API_KEY CEREBRAS_API_KEY GROQ_API_KEY\n';

  // bug #155(b) (docs/superpowers/DEFERRED.md): this function used to have no
  // concept of agent.orchestration.steps at all — a genuinely orchestrated
  // (>=2 step) agent whose resolved tool is unsupported by the PlanSpec chain
  // executor (scripts/shelly-plan-executor.js — an HTTP-request dispatcher
  // with no subprocess-exec capability, so it architecturally cannot run e.g.
  // a `cli:codex` step) falls back to THIS legacy script on every scheduled/
  // native fire (AgentRuntime.kt's shouldRunPlanExecutor correctly excludes
  // it). A 2026-07-16 pass added ORCHESTRATION_COLLAPSED_NOTE as a
  // visibility-only fix (silent collapse -> a note in the run log, execution
  // itself unchanged). This pass (same day, follow-up) adds the REAL chain
  // executor for the one case that visibility fix explicitly deferred: an
  // orchestrated agent whose resolved tool is the codex driver, with every
  // step that will actually run carrying neither a per-step tool pin nor an
  // apiCall step (see codexOrchestrationChainCommand() below for the bash-side
  // loop and its own extensive doc comment).
  //
  // canRunOrchestrationChain's three conditions:
  //  1. isOrchestrated (>=2 normalized steps) — a single-step "chain" already
  //     runs correctly via the plain (non-chain) path below, nothing to fix.
  //  2. tool.type === 'cli' — the resolved AGENT-level tool (post autonomous-
  //     resolution above). This is deliberately narrower than "any tool the
  //     PlanSpec executor can't run": local/gemini-api/perplexity/cerebras/
  //     groq ARE PlanSpec-supported (their orchestrated agents route through
  //     scripts/shelly-plan-executor.js's own chain loop at the native layer
  //     and essentially never execute this .sh file's orchestration branch in
  //     practice), and ab-article-eval has no chain concept at all (out of
  //     scope, unchanged — see the residual note below).
  //  3. every step this run will actually attempt (bounded by the resolved
  //     step budget, see chainStepCount) carries neither `apiCall` (a
  //     structured HTTP call — a materially different, PlanSpec-executor-only
  //     execution model; sending its synthesized display label to codex as a
  //     literal prompt would be silently wrong, not merely unsupported) nor a
  //     per-step `tool` pin (Phase 5 — honoring a step's own tool choice would
  //     require re-resolving and re-dispatching through every backend
  //     generateToolCommand supports, per step; deliberately out of scope for
  //     this pass to keep the new bash surface small and auditable). Both
  //     residual cases keep the OLD single-step collapse + the note.
  const fullOrchestrationSteps: NormalizedStep[] = normalizeSteps(agent.orchestration);
  const orchestrationBudget = resolveBudget(agent.orchestration);
  const chainStepCount = Math.min(fullOrchestrationSteps.length, orchestrationBudget.maxSteps);
  const attemptableOrchestrationSteps = fullOrchestrationSteps.slice(0, chainStepCount);
  const canRunOrchestrationChain =
    isOrchestrated(agent.orchestration) &&
    tool.type === 'cli' &&
    chainStepCount > 0 &&
    attemptableOrchestrationSteps.every((s) => !s.apiCall && !s.tool);

  // Deliberately kept OUT of the actual dispatched/posted content
  // (RESULT_CONTENT_FILE / the `preview` argument dispatch_agent_action passes
  // to resolve_app_act_params's {{result}} substitution) so it can never leak
  // into a live external post (webhook/cli/dm-reply/app-act) — see where
  // PREVIEW is amended, near the run-log write, for why that ordering matters.
  // Only fires for the RESIDUAL collapse cases now (see canRunOrchestrationChain
  // above) — a chain this function can actually run gets no note at all.
  const orchestrationStepCount = fullOrchestrationSteps.length;
  const orchestrationCollapsedNote = isOrchestrated(agent.orchestration) && !canRunOrchestrationChain
    ? `[Shelly] Note: this agent is configured as a ${orchestrationStepCount}-step chain, but this run executed only the base task as a single step — tool "${toolLabel}" cannot run the full chain unattended. Run this agent manually from the app for the complete chain, or switch its tool to Local LLM / Gemini / Perplexity / Cerebras / Groq to enable scheduled multi-step chains.`
    : '';

  const slug = computeAgentSlug(agent.name, agentId);
  const outputNameTemplate = sanitizeOutputTemplate(agent.outputTemplate);
  const outputDir = agent.outputPath.replace(/^~/, home).replace(/^\$HOME/, home);
  // Orchestration: non-final steps suppress the action so only the FINAL step
  // drafts/notifies once (otherwise a 3-step chain fires 3 approval prompts).
  const actionType = opts.suppressAction ? '__suppressed__' : (agent.action?.type ?? 'draft');
  const actionWebhookUrl = actionType === 'webhook' ? agent.action?.webhookUrl ?? '' : '';
  const actionCommand = actionType === 'cli' ? agent.action?.command ?? '' : '';
  const actionIntentMode = actionType === 'intent' ? (agent.action?.intentMode ?? '') : '';
  const actionIntentTarget = actionType === 'intent' ? (agent.action?.intentTarget ?? '') : '';
  const actionIntentShareText = actionType === 'intent' ? (agent.action?.intentShareText ?? '') : '';
  const actionDmPairingId = actionType === 'dm-reply' ? agent.action?.dmPairingId ?? '' : '';
  const actionDmReplyText = actionType === 'dm-reply' ? agent.action?.dmReplyText ?? '' : '';
  const actionAppActRecipeId = actionType === 'app-act' ? (agent.action?.appActRecipeId ?? '') : '';
  // Baked as a JSON string constant (params may carry the literal "{{result}}"
  // placeholder in any value, same convention as intentShareText/dmReplyText).
  // Resolved against the redacted run preview, and redacted a second time as
  // defense-in-depth, entirely at RUNTIME in the shell (resolve_app_act_params) —
  // this is the first agent action type that reaches a real external-posting
  // surface, so it gets an extra redaction pass beyond relying solely on the
  // preview already being clean.
  const actionAppActParamsJson = actionType === 'app-act' ? JSON.stringify(agent.action?.appActParams ?? {}) : '{}';
  // social-post (2026-07-22): only platform/connectorId/text are baked — the
  // connector's host/meta AND its secret fields are resolved at RUNTIME from
  // the sourced $ENV_FILE (SOCIAL_CONNECTOR_<ID>_HOST/_META/_<FIELD>, written
  // by settings-store's addSocialConnector), so (a) no secret ever appears in
  // this script's literal source, and (b) this module stays free of any
  // settings-store import (see the ACTION_APPROVAL_MODE comment above for why
  // that constraint exists). An unsafe connector id bakes as '' → the
  // dispatch case fails closed with a clear message.
  const actionSocialPost = actionType === 'social-post' ? agent.action?.socialPost : undefined;
  const actionSocialPlatform = actionSocialPost?.platform ?? '';
  const actionSocialConnectorId =
    actionSocialPost && isSafeConnectorId(actionSocialPost.connectorId ?? '') ? actionSocialPost.connectorId : '';
  const actionSocialEnvPrefix = actionSocialConnectorId ? socialConnectorEnvPrefix(actionSocialConnectorId) : '';
  const actionSocialText = actionSocialPost ? (actionSocialPost.text?.trim() ? actionSocialPost.text : '{{result}}') : '';
  const actionCommandSafety = evaluateAgentActionCommand(actionCommand);

  // Multi-action fan-out (v24, Agent.actions — see its own doc comment in
  // store/types.ts). Deliberately narrow gate, mirroring
  // lib/agent-plan-spec.ts's buildAgentPlanSpec `multiActions` exactly:
  //  - opts.suppressAction (an orchestration NON-FINAL step) never dispatches
  //    any action, single or multi — the existing `__suppressed__` actionType
  //    above already handles that path untouched, so multi-actions must not
  //    engage here either.
  //  - fewer than 2 entries in agent.actions is not a "multi" run at all;
  //    falls through to the single actionType/actionWebhookUrl/… locals above
  //    exactly as before this field existed.
  // When false, NONE of the ACTION_MULTI_* bash variables below are ever
  // emitted into the generated script — this is what makes a single-action
  // agent's output byte-identical to before v24 (see the regression test).
  const useMultiActions = !opts.suppressAction && !!agent.actions && agent.actions.length >= 2;
  const multiActionFields: ActionBakedFields[] = useMultiActions ? agent.actions!.map(bakeActionFields) : [];
  const hasDraftAction = useMultiActions ? multiActionFields.some((f) => f.type === 'draft') : actionType === 'draft';

  // G6 char-limit guarantee (agent.orchestration.charLimit — see
  // lib/agent-pipeline-presets.ts's clampCharLimit/enforceCharLimit): found in
  // the 2026-07-15 P1 audit to have NO caller anywhere in the foreground JS
  // orchestration path — only scripts/shelly-plan-executor.js's
  // enforcePlanCharLimit/resolveCharLimit enforced it. Mirrors resolveCharLimit
  // exactly: undefined/null/non-finite means "no limit configured" (0, a no-op
  // at runtime below), anything else is clamped the same way (40-4000). For a
  // multi-step chain, agent-manager.ts's runAgentOrchestrated only carries this
  // onto the FINAL step's stepAgent (steps 1..n-1 must NOT be truncated — they
  // feed the next step's context) — see the orchestration field it builds.
  const rawCharLimit = agent.orchestration?.charLimit;
  const resultCharLimit =
    rawCharLimit === undefined || rawCharLimit === null || !Number.isFinite(rawCharLimit)
      ? 0
      : clampCharLimit(rawCharLimit);

  // Project owner directive 2026-07-14: runtime per-action "Runtime Review"
  // approval defaults to OFF (no human tap) — draft/notify/webhook/cli skip
  // the write+wait round trip entirely when 'auto' (see dispatch_agent_action);
  // intent/dm-reply still always write+wait (they can only ever fire via RN,
  // and are already attended-only — see their own unattended hard-refusals
  // below) but are flagged auto-accept so RN resolves them without a human
  // tap. This does NOT relax command-safety CRITICAL / secret-scan /
  // workspace-root gates (lib/command-safety.ts, lib/redact-secrets.ts,
  // realpathWithMissingTail) — those are hard content/action classifiers, not
  // approval-frequency knobs, and nothing here touches them.
  //
  // DEFERRED #2 note: this "Runtime Review" default-off is a DIFFERENT
  // approval surface than the codex/B2-driver out-of-workspace-write gray
  // verdict (agent-policy.ts's decideAutoAnswer + the driver's escalation
  // wait). It is untouched by the unattended fold below (opts.attended).
  // ONLY the per-agent override (a plain field on the `agent` parameter
  // already in scope — no store read needed) is resolved here at
  // script-generation time. The GLOBAL default is intentionally NOT baked:
  // agent-executor.ts must stay free of any settings-store import (pulling it
  // in transitively drags in expo-secure-store, an ESM native module that
  // breaks every non-RN jest suite importing this file for its pure helpers —
  // found the hard way while implementing this). Instead ACTION_APPROVAL_MODE
  // is resolved at SCRIPT RUNTIME below, after `source "$ENV_FILE"` — settings-
  // store already syncs SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL to that file on
  // every change, so this reads the CURRENT global default on every run, not
  // a stale value from whenever the script was last (re)generated.
  const actionApprovalModeOverride: 'manual' | 'auto' | '' =
    agent.requireActionApproval === undefined ? '' : agent.requireActionApproval ? 'manual' : 'auto';
  // app-act Tier-B unattended-allow (docs/superpowers/DEFERRED.md, resolved
  // 2026-07-14, widened same day per project owner directive: "最終的に
  // チャットで条件を示して、ユーザーが良しとしたものは実行で。たとえパープレ
  // だろうとCodexだろうと" — chat-confirmed registration-time consent is the
  // trust boundary, not the tool backend). Deliberately NOT governed by
  // actionApprovalMode above — a wrong external post is not equivalent in
  // risk to a local draft/CLI call, so it needs the SAME registration-time
  // consent draft/notify's existing native fast-path already requires (the
  // Autonomous toggle itself; see AgentRuntime.kt's trustedPlanLaunch and the
  // AgentActionType doc comment in store/types.ts), not the blanket
  // approval-frequency setting. A cloud tool still can't reach this point
  // unless autonomousCloudConsent was separately granted (Spec A §4, N1
  // exception, above) — that gate governs whether an autonomous script may
  // use cloud API keys at all; this flag only governs whether app-act may
  // fire unattended once a script exists. Baked as a constant here (not
  // re-derived at run time) because this exact .sh file is regenerated only
  // through the trusted authoring path (create/update agent) — a scheduled/
  // unattended fire re-executes this file unchanged, so whatever was true
  // when it was last written IS "unchanged since registration".
  const actionAppActAutoFireTrusted = agent.autonomous === true;

  // North Star fix: a web-research / collection agent otherwise receives the bare
  // task utterance as a single user message with no output contract, so the backend
  // DESCRIBES a workflow instead of EXECUTING the collection — it returns a design
  // essay, not sourced results (observed on-device: "…ワークフローの設計。本稿では…").
  // Prepend an explicit execution contract to the prompt. Every backend leads with
  // escapedPrompt (perplexity/gemini/local/codex all `printf '%s' '${escapedPrompt}'`
  // first), so this injects uniformly without per-backend system-message plumbing.
  // Gated on needsWeb so non-research agents (code tasks, file summaries) are
  // untouched (collectionContract === '' → byte-identical to the old prompt).
  const promptSignals = detectRouteSignals(agent.prompt);
  // (A) Output-language guard: deep-research models (Perplexity sonar-deep-research)
  // ignore a soft "same language as the task" hint and answer in English even for a
  // Japanese task. When the task is Japanese, lead with a forceful directive to write
  // the whole answer in Japanese and TRANSLATE non-Japanese source material — language
  // is orthogonal to the report format the model insists on, so it honours this even
  // when it ignores the "bullet list only" shape. (Source URLs stay verbatim.)
  const taskIsJapanese = /[ぁ-んァ-ヶ一-龥]/.test(agent.prompt);
  const languageDirective = taskIsJapanese
    ? 'OUTPUT LANGUAGE (REQUIRED): Write the ENTIRE response in Japanese (日本語). Any non-Japanese source material MUST be translated into natural Japanese and summarised in Japanese — never leave English paragraphs. Source URLs stay verbatim.\n\n'
    : '';
  const collectionContract = promptSignals.needsWeb
    ? languageDirective + 'You are a research-collection agent. EXECUTE this task NOW using live web search — do NOT describe, design, or plan a workflow, and do NOT explain how it could be done. Return ONLY a Markdown bullet list, one line per source, each formatted exactly as:\n- [title](primary_source_url) — concise summary (max 200 characters)\nRules: include at least one item; cite real, verifiable PRIMARY-source URLs (papers, official sites, journals), never search-engine or aggregator links; output no preamble, headings, or closing remarks — only the list.\n\nTask:\n'
    : '';
  const escapedPrompt = (collectionContract + agent.prompt).replace(/'/g, "'\\''");
  const injectStudioContext = agentUsesStudioContext(agent);

  // B2 §6: the driver gates on the agent's configured autonomy level. Build the
  // policy here (level from agent.autonomyLevel; default L2) and hand it to the
  // driver via --policy-json so a configured L1/L3 agent isn't silently run at L2.
  // canonicalRoot is re-anchored to the driver's --cwd at run time, so home is fine.
  //
  // DEFERRED #2 境界: attended is set ONLY by the foreground TS ladder (a human
  // is in-app to answer escalations). Every other materialization — install,
  // restore, startup repair, consent re-bake — writes the STORED script that the
  // AlarmManager fire / native one-tap runs read, so it bakes unattended:true
  // and the driver declines a gray verdict immediately (after grant consumption)
  // instead of leaning on the escalation timeout.
  const agentPolicyJson = JSON.stringify(buildAgentPolicy(agent, home, { unattended: opts.attended !== true }));
  let toolCommand = generateToolCommand(tool, escapedPrompt, agent.prompt, {
    autonomous: agent.autonomous === true,
    actionType: agent.action?.type ?? 'draft',
    policyJson: agentPolicyJson,
    // bug #155(b) follow-up: only set for the exact case validated above
    // (canRunOrchestrationChain) — generateToolCommand's 'cli' case uses this
    // to swap the single codexDriverCommand() call for the real bash-side
    // chain loop. Absent (undefined) for every other agent, including every
    // non-orchestrated one, so their generated script is byte-for-byte
    // unchanged by this feature (see the "no capability regression for a
    // single-step agent" regression test).
    orchestrationChain: canRunOrchestrationChain
      ? {
          basePrompt: agent.prompt,
          steps: attemptableOrchestrationSteps,
          totalStepCount: fullOrchestrationSteps.length,
          maxSteps: orchestrationBudget.maxSteps,
          totalTimeoutMs: orchestrationBudget.totalTimeoutMs,
        }
      : undefined,
  });
  if (promptSignals.needsWeb) {
    // North Star guard: a collection agent that "succeeded" but produced no source
    // URL (the backend wrote a design essay rather than collecting) is a SOFT
    // failure, not a green result. Mark BACKEND_ERROR_FILE so the escalation ladder
    // retries with a stricter backend instead of silently drafting an essay into
    // Obsidian. Runs BEFORE the web→Codex bake so that ladder picks it up. Only when
    // the backend didn't already error (no double-mark). 'https?://' is precise: a
    // contract-compliant result carries real links, an essay does not.
    toolCommand = `${toolCommand}
if [ ! -f "$BACKEND_ERROR_FILE" ] && ! grep -qE 'https?://' "$RESULT_CONTENT_FILE" 2>/dev/null; then
  printf '\\n%s\\n' 'Collection produced no primary-source links (the backend described a workflow instead of collecting). Marked as a soft failure so the run escalates rather than drafting an essay.' >> "$RESULT_FILE"
  touch "$BACKEND_ERROR_FILE"
fi`;
  }
  if (bakeWebCodexLadder) {
    // The web backend already touches BACKEND_ERROR_FILE (+ TRANSIENT_ERROR_FILE on
    // a 429/5xx/network failure) when it fails. Mirror the foreground ladder
    // [web, Codex]: on any web failure, escalate to Codex. Codex re-marks on its
    // own failure (a usage-limit refusal → transient). If Codex is absent, keep
    // the web verdict (preserving its transient/hard classification).
    // This ladder ONLY exists inside the `agent.autonomous` branch above (an
    // unattended alarm-fired run — see the P1 comment there), so route Codex
    // through the SAME B2 driver + --policy-json gate the primary autonomous
    // `cli` path uses (agentPolicyJson, built above for this exact agent) —
    // never bare `codex exec`, which would run danger-full-access on Android
    // (agent-boundary-policy.ts).
    toolCommand = `${toolCommand}
if [ -f "$BACKEND_ERROR_FILE" ]; then
  WEB_WAS_TRANSIENT=0
  [ -f "$TRANSIENT_ERROR_FILE" ] && WEB_WAS_TRANSIENT=1
  rm -f "$BACKEND_ERROR_FILE" "$TRANSIENT_ERROR_FILE"
  if command -v codex >/dev/null 2>&1; then
    ${codexDriverFallbackCommand(escapedPrompt, '"$RESULT_FILE"', agentPolicyJson)}
    # North Star guard (baked path): the no-URL check above ran before this Codex
    # escalation, so re-check here — a sourceless Codex essay must also fail-closed
    # rather than ship to the vault on the unattended (alarm-fired) run.
    if [ ! -f "$BACKEND_ERROR_FILE" ] && ! grep -qE 'https?://' "$RESULT_CONTENT_FILE" 2>/dev/null; then
      touch "$BACKEND_ERROR_FILE"
    fi
  else
    touch "$BACKEND_ERROR_FILE"
    [ "$WEB_WAS_TRANSIENT" = "1" ] && touch "$TRANSIENT_ERROR_FILE"
  fi
fi`;
  }
  const auditMirrorSdcardEligible = agent.autonomous === true && tool.type === 'cli';

  return `#!/bin/bash
# run-agent-${agentId}.sh — Auto-generated by Shelly for agent: ${agent.name}
# Do not edit manually.
SHELLY_AGENT_SCRIPT_VERSION=${AGENT_SCRIPT_VERSION}
set -euo pipefail

AGENT_ID=${shellQuote(agentId)}
AGENT_NAME=${shellQuote(agent.name)}
# DEFERRED.md #2 残り (workspaceRoot → driver --cwd): empty when unset, so the
# driver's DRIVER_CWD "\${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}" fallback below
# is unchanged from today's default ($PROJECT_DIR) — bash's :- treats an empty
# string the same as unset, so this never regresses the no-workspace-root case.
AGENT_WORKSPACE_ROOT=${shellQuote(agent.workspaceRoot ?? '')}
RESULT_FILE=${shellQuote(resultFile)}
LOCK_FILE=${shellQuote(lockFile)}
LOCK_DIR=${shellQuote(lockDir)}
CHAIN_LOCK_DIR=${shellQuote(chainLockDir)}
CHAIN_LOCK_NONCE=${shellQuote(opts.chainLockNonce ?? '')}
LOG_DIR=${shellQuote(logDir)}
TIMEOUT=${DEFAULT_TIMEOUT_SEC}
OUTPUT_DIR=${shellQuote(outputDir)}
SLUG=${shellQuote(slug)}
OUTPUT_NAME_TEMPLATE=${shellQuote(outputNameTemplate)}
TOOL_LABEL=${shellQuote(toolLabel)}
ROUTE_DECISION_JSON=${shellQuote(routeDecisionJson)}
ENV_FILE=${shellQuote(envFile)}
DM_PAIRINGS_FILE=${shellQuote(dmPairingsFile)}
LOCKS_DIR=${shellQuote(locksDir)}
TMP_DIR=${shellQuote(tmpDir)}
MAX_CONCURRENT=${MAX_CONCURRENT}
AUDIT_MIRROR_SDCARD_ELIGIBLE=${auditMirrorSdcardEligible ? '1' : '0'}
ACTION_TYPE=${shellQuote(actionType)}
RESULT_CHAR_LIMIT=${resultCharLimit}
ORCHESTRATION_COLLAPSED_NOTE=${shellQuote(orchestrationCollapsedNote)}
ACTION_WEBHOOK_URL=${shellQuote(actionWebhookUrl)}
ACTION_COMMAND=${shellQuote(actionCommand)}
ACTION_INTENT_MODE=${shellQuote(actionIntentMode)}
ACTION_INTENT_TARGET=${shellQuote(actionIntentTarget)}
ACTION_INTENT_SHARE_TEXT=${shellQuote(actionIntentShareText)}
ACTION_DM_PAIRING_ID=${shellQuote(actionDmPairingId)}
ACTION_DM_REPLY_TEXT=${shellQuote(actionDmReplyText)}
ACTION_DM_PAIRING_LABEL=""
ACTION_APP_ACT_RECIPE_ID=${shellQuote(actionAppActRecipeId)}
ACTION_APP_ACT_PARAMS_JSON=${shellQuote(actionAppActParamsJson)}
ACTION_SOCIAL_PLATFORM=${shellQuote(actionSocialPlatform)}
ACTION_SOCIAL_CONNECTOR_ID=${shellQuote(actionSocialConnectorId)}
ACTION_SOCIAL_ENV_PREFIX=${shellQuote(actionSocialEnvPrefix)}
ACTION_SOCIAL_TEXT=${shellQuote(actionSocialText)}
ACTION_COMMAND_SAFETY_LEVEL=${shellQuote(actionCommandSafety.level)}
ACTION_COMMAND_SAFETY_REASON=${shellQuote(actionCommandSafety.reason)}
ACTION_COMMAND_AUTO_APPROVABLE=${actionCommandSafety.autoApprovable ? '1' : '0'}
ACTION_APPROVAL_MODE_OVERRIDE=${shellQuote(actionApprovalModeOverride)}
ACTION_APPROVAL_MODE="auto"
ACTION_APP_ACT_AUTO_FIRE_TRUSTED=${actionAppActAutoFireTrusted ? '1' : '0'}
${useMultiActions ? `# Multi-action fan-out (v24, Agent.actions): one bash array per baked field,
# indexed identically to agent.actions. Only ever emitted when useMultiActions
# is true (>= 2 real actions, not a suppressed orchestration step) — a
# single-action agent's script has NONE of these lines, byte-identical to
# before this feature existed.
ACTION_MULTI_COUNT=${multiActionFields.length}
ACTION_MULTI_TYPES=${bashArrayLiteral(multiActionFields.map((f) => f.type))}
ACTION_MULTI_WEBHOOK_URLS=${bashArrayLiteral(multiActionFields.map((f) => f.webhookUrl))}
ACTION_MULTI_COMMANDS=${bashArrayLiteral(multiActionFields.map((f) => f.command))}
ACTION_MULTI_INTENT_MODES=${bashArrayLiteral(multiActionFields.map((f) => f.intentMode))}
ACTION_MULTI_INTENT_TARGETS=${bashArrayLiteral(multiActionFields.map((f) => f.intentTarget))}
ACTION_MULTI_INTENT_SHARE_TEXTS=${bashArrayLiteral(multiActionFields.map((f) => f.intentShareText))}
ACTION_MULTI_DM_PAIRING_IDS=${bashArrayLiteral(multiActionFields.map((f) => f.dmPairingId))}
ACTION_MULTI_DM_REPLY_TEXTS=${bashArrayLiteral(multiActionFields.map((f) => f.dmReplyText))}
ACTION_MULTI_APP_ACT_RECIPE_IDS=${bashArrayLiteral(multiActionFields.map((f) => f.appActRecipeId))}
ACTION_MULTI_APP_ACT_PARAMS_JSONS=${bashArrayLiteral(multiActionFields.map((f) => f.appActParamsJson))}
ACTION_MULTI_SOCIAL_PLATFORMS=${bashArrayLiteral(multiActionFields.map((f) => f.socialPlatform))}
ACTION_MULTI_SOCIAL_CONNECTOR_IDS=${bashArrayLiteral(multiActionFields.map((f) => f.socialConnectorId))}
ACTION_MULTI_SOCIAL_ENV_PREFIXES=${bashArrayLiteral(multiActionFields.map((f) => f.socialEnvPrefix))}
ACTION_MULTI_SOCIAL_TEXTS=${bashArrayLiteral(multiActionFields.map((f) => f.socialText))}
ACTION_MULTI_COMMAND_SAFETY_LEVELS=${bashArrayLiteral(multiActionFields.map((f) => f.commandSafety.level))}
ACTION_MULTI_COMMAND_SAFETY_REASONS=${bashArrayLiteral(multiActionFields.map((f) => f.commandSafety.reason))}
ACTION_MULTI_COMMAND_AUTO_APPROVABLES=${bashArrayLiteral(multiActionFields.map((f) => (f.commandSafety.autoApprovable ? '1' : '0')))}
# Set (as [] JSON) unconditionally here, not just inside the dispatch loop
# below, so a run that never reaches dispatch at all (the backend/tool itself
# failed — the "Check result" else-branch further down) still leaves this
# defined under \`set -u\`.
ACTION_RESULTS_JSON="[]"
` : ''}ACTION_NOTIFY_FILE="$LOG_DIR/native-result-notification.json"
ACTION_APPROVAL_DIR="$HOME/.shelly/agents/action-approvals"
ACTION_APPROVAL_REPLY_DIR="$HOME/.shelly/agents/action-approval-replies"
ACTION_RUN_ID="$AGENT_ID-$(date +%s)-$$"
ACTION_APPROVAL_REQUEST_FILE="$ACTION_APPROVAL_DIR/action-$ACTION_RUN_ID.json"
ACTION_APPROVAL_REPLY_FILE="$ACTION_APPROVAL_REPLY_DIR/action-$ACTION_RUN_ID.reply.json"
ACTION_APPROVAL_REQUEST_SHA256=""
# docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1 (2026-07-17):
# reply-signature verification anchor. Both are injected by AgentRuntime.kt as
# readonly env vars before this script is sourced (same pin-injection pattern
# as SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256 above it) — falling back to
# empty here only matters for host/test harnesses that source this script
# directly without going through AgentRuntime.kt, where verify_action_approval_reply
# then fails closed (see node_usable / pin checks there).
ACTION_APPROVAL_PUBLIC_KEY_FILE="\${SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_FILE:-}"
ACTION_APPROVAL_PUBLIC_KEY_SHA256="\${SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_SHA256:-}"
ACTION_APPROVAL_TIMEOUT_SECONDS="\${SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS:-120}"
ACTION_DISPATCH_STATUS=""
ACTION_DISPATCH_MESSAGE=""
REGISTRY_LOCK=""
REGISTRY_LOCK_ACQUIRED=0
BACKEND_ERROR_FILE="$RESULT_FILE.backend-error"
TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"
RESULT_CONTENT_FILE="$RESULT_FILE"
RESULT_CONTENT_IS_DRIVER_ANSWER=0
CODEX_RESULT_ACTIVE=0
LOCAL_LLM_HEARTBEAT_PID=""
LOCAL_LLM_ACTIVE_MARKER=""
FINISH_RAN=0
SUPPRESS_ERROR_NOTIFICATION=${opts.suppressErrorNotification ? '1' : '0'}
STUDIO_CONTEXT=${injectStudioContext ? '1' : '0'}
# General collection agents (non content-studio) honour the global output-target
# setting and a clean <base>/<topic?>/<date>/<date>_<title>.md layout. Studio
# agents keep their explicit paths + keyword Obsidian routing.
USE_GLOBAL_OUTPUT=${injectStudioContext ? '0' : '1'}
AGENT_AUTONOMOUS=${agent.autonomous === true ? '1' : '0'}

START_TIME=$(date +%s)

export HOME="${home}"
export PATH="$HOME/.local/bin:$PATH"

cleanup() {
  local_llm_stop_activity_heartbeat 2>/dev/null || true
  if [ "\${REGISTRY_LOCK_ACQUIRED:-0}" = "1" ] && [ -n "\${REGISTRY_LOCK:-}" ] && [ -d "$REGISTRY_LOCK" ]; then
    rmdir "$REGISTRY_LOCK" 2>/dev/null || true
  fi
  rm -f "$LOCK_FILE"
  rm -f "$LOG_DIR/current.json"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}
shelly_app_binary_path() {
  name="$1"
  if [ -n "\${SHELLY_LIB_DIR:-}" ] && [ -f "$SHELLY_LIB_DIR/$name" ]; then
    printf '%s\\n' "$SHELLY_LIB_DIR/$name"
    return 0
  fi
  resolved=$(command -v "$name" 2>/dev/null || true)
  case "$resolved" in
    /*)
      printf '%s\\n' "$resolved"
      return 0
      ;;
  esac
  return 1
}
shelly_run_app_binary() {
  name="$1"
  shift
  binary=$(shelly_app_binary_path "$name") || return 127
  binary_dir="\${binary%/*}"
  if [ -x /system/bin/linker64 ]; then
    LD_LIBRARY_PATH="\${SHELLY_LD_LIBRARY_PATH:-\${SHELLY_LIB_DIR:-$binary_dir}}" /system/bin/linker64 "$binary" "$@"
    return $?
  fi
  "$binary" "$@"
}
shelly_timeout_app_binary() {
  seconds="$1"
  shift
  name="$1"
  shift
  binary=$(shelly_app_binary_path "$name") || return 127
  binary_dir="\${binary%/*}"
  if [ -x /system/bin/linker64 ]; then
    if command -v timeout >/dev/null 2>&1; then
      LD_LIBRARY_PATH="\${SHELLY_LD_LIBRARY_PATH:-\${SHELLY_LIB_DIR:-$binary_dir}}" timeout "$seconds" /system/bin/linker64 "$binary" "$@"
    else
      LD_LIBRARY_PATH="\${SHELLY_LD_LIBRARY_PATH:-\${SHELLY_LIB_DIR:-$binary_dir}}" /system/bin/linker64 "$binary" "$@"
    fi
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$binary" "$@"
  else
    "$binary" "$@"
  fi
}
shelly_node() {
  shelly_run_app_binary node "$@"
}
shelly_curl() {
  shelly_run_app_binary curl "$@"
}
shelly_git() {
  # DEFERRED.md (自律エージェント制御面レビュー — LD_PRELOAD gap): mirrors
  # HomeInitializer.kt's interactive git() fix (commit 0981cd6d5, BASHRC_VERSION
  # 230). git spawns its HTTPS transport helper (git-remote-https) as a CHILD
  # execve that does not go through shelly_run_app_binary's own linker64
  # launch, so under Knox it can hit the app_data_file exec denial ("cannot
  # exec 'remote-https': Permission denied") on git fetch/push/clone over
  # HTTPS. Preloading libexec_wrapper.so makes the wrapper rewrite that child
  # execve through linker64 too. Scoped to THIS git invocation only — never
  # exported globally, since an inherited LD_PRELOAD corrupts node's own
  # fd/.so resolution (see the driver launch above) and breaks llama-server's
  # (see local_llm_start_server) — same "scoped, never global" invariant the
  # interactive git() uses.
  binary=$(shelly_app_binary_path git) || return 127
  binary_dir="\${binary%/*}"
  git_lib_dir="\${SHELLY_LIB_DIR:-$binary_dir}"
  if [ -x /system/bin/linker64 ]; then
    LD_LIBRARY_PATH="\${SHELLY_LD_LIBRARY_PATH:-$git_lib_dir}" LD_PRELOAD="$git_lib_dir/libexec_wrapper.so" SHELLY_LIB_DIR="$git_lib_dir" /system/bin/linker64 "$binary" "$@"
    return $?
  fi
  LD_PRELOAD="$git_lib_dir/libexec_wrapper.so" SHELLY_LIB_DIR="$git_lib_dir" "$binary" "$@"
}
node_usable() {
  shelly_node -e 'process.exit(0)' >/dev/null 2>&1 || return 1
}
python3_usable() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import sys' >/dev/null 2>&1 || return 1
}
json_escape_text() {
  text="$1"
  if node_usable; then
    if SHELLY_JSON_TEXT="$text" shelly_node -e 'const s = process.env.SHELLY_JSON_TEXT || ""; process.stdout.write(JSON.stringify(s).slice(1, -1));' 2>/dev/null; then
      return 0
    fi
  fi
  text=\${text//\\\\/\\\\\\\\}
  text=\${text//\\"/\\\\\\"}
  text=\${text//$'\\n'/ }
  text=\${text//$'\\r'/ }
  text=\${text//$'\\t'/ }
  printf '%s' "$text"
}
write_failure_log() {
  code="$1"
  line="$2"
  END_TIME=$(date +%s)
  DURATION=$(( (END_TIME - START_TIME) * 1000 ))
  TS=$(date +%s)
  # Deliberately bounded producer (a fixed short message + $PATH) — never exceeds
  # 500 bytes, so this is the one safe printf-into-head -c 500 (no SIGPIPE/141).
  # Do NOT pipe unbounded output (model results) into head; head a file instead.
  PREVIEW=$(printf 'Agent script failed before producing a result. exit=%s line=%s. PATH=%s' "$code" "$line" "$PATH" | head -c 500 | tr '\\n' ' ')
  PREVIEW_JSON=$(json_escape_text "$PREVIEW")
  TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
  cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"error","outputPreview":"$PREVIEW_JSON","durationMs":$DURATION,"toolUsed":"$TOOL_LABEL_JSON","errorMessage":"$PREVIEW_JSON"}
LOGEOF
  if [ -n "\${ROUTE_DECISION_JSON:-}" ]; then
    tmp_log="$LOG_DIR/$TS.json.tmp"
    cat > "$tmp_log" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"error","outputPreview":"$PREVIEW_JSON","durationMs":$DURATION,"toolUsed":"$TOOL_LABEL_JSON","errorMessage":"$PREVIEW_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
    mv "$tmp_log" "$LOG_DIR/$TS.json"
  fi
}
finish() {
  code="\${1:-$?}"
  if [ "\${FINISH_RAN:-0}" = "1" ]; then
    return 0
  fi
  FINISH_RAN=1
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    write_failure_log "$code" "\${BASH_LINENO[0]:-unknown}" || true
  fi
  mirror_driver_audit_to_app_private || true
  mirror_driver_audit_to_sdcard || true
  cleanup
  return 0
}

mirror_driver_audit_to_app_private() {
  audit_file="$LOG_DIR/agent-driver-audit.jsonl"
  [ -s "$audit_file" ] || return 0
  audit_dir="$HOME/.shelly/agents/audits"
  mkdir -p "$audit_dir" 2>/dev/null || true
  cp "$audit_file" "$audit_dir/$AGENT_ID-agent-driver-audit.jsonl" 2>/dev/null || true
}

mirror_driver_audit_to_sdcard() {
  # Debug-only B2 verification aid. Keep disabled by default; audit JSONL may
  # contain escalation commands and should not be mirrored to shared storage
  # unless an operator explicitly opts in for on-device verification.
  [ "\${AUDIT_MIRROR_SDCARD_ELIGIBLE:-0}" = "1" ] || return 0
  case "\${SHELLY_AGENT_AUDIT_MIRROR_SDCARD:-}" in
    1|true|TRUE|yes|YES|on|ON) ;;
    *) return 0 ;;
  esac
  audit_file="$LOG_DIR/agent-driver-audit.jsonl"
  [ -s "$audit_file" ] || return 0
  cp "$audit_file" "/sdcard/b2-autonomous-audit-$AGENT_ID.jsonl" 2>/dev/null || true
}

json_string_file() {
  file="$1"
  if node_usable; then
    if shelly_node -e 'const fs = require("fs"); const file = process.argv[1]; process.stdout.write(JSON.stringify(fs.readFileSync(file, "utf8")));' "$file" 2>/dev/null; then
      return 0
    fi
  fi
  printf '"'
  while IFS= read -r line || [ -n "$line" ]; do
    line=\${line//$'\\r'/ }
    line=\${line//$'\\t'/ }
    line=\${line//\\\\/\\\\\\\\}
    line=\${line//\\"/\\\\\\"}
    printf '%s\\\\n' "$line"
  done < "$file"
  printf '"'
}

# Mirrors scripts/shelly-plan-executor.js's REDACT_PATTERNS/redact() so a live
# agent result gets the same secret-scrubbing guarantee whether it reaches a
# webhook body, notification, intent-share text, or dm-reply text through this
# .sh executor or through the PlanSpec executor. Takes a FILE PATH (not stdin)
# so it composes with clean_result_preview's file-not-pipe SIGPIPE safety below.
redact_secrets_text() {
  file="$1"
  [ -f "$file" ] || return 0
  if node_usable; then
    if shelly_node - "$file" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const file = process.argv[2];
let data = '';
try { data = fs.readFileSync(file, 'utf8'); } catch (_) {}
const patterns = [
  /\\bsk-ant-[A-Za-z0-9_-]{20,}\\b/g,
  /\\bsk-proj-[A-Za-z0-9_-]{20,}\\b/g,
  /\\bsk-[A-Za-z0-9_-]{20,}\\b/g,
  /\\bAIza[0-9A-Za-z_-]{25,}\\b/g,
  /\\bgsk_[A-Za-z0-9_-]{20,}\\b/g,
  /\\bcsk-[A-Za-z0-9_-]{20,}\\b/g,
  /\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b/g,
  /\\bBearer\\s+[A-Za-z0-9._~+/=-]{16,}\\b/gi,
];
let out = data;
for (const p of patterns) out = out.replace(p, '<redacted>');
process.stdout.write(out);
NODEEOF
    then
      return 0
    fi
  fi
  sed -E \\
    -e 's/sk-ant-[A-Za-z0-9_-]{20,}/<redacted>/g' \\
    -e 's/sk-proj-[A-Za-z0-9_-]{20,}/<redacted>/g' \\
    -e 's/sk-[A-Za-z0-9_-]{20,}/<redacted>/g' \\
    -e 's/AIza[0-9A-Za-z_-]{25,}/<redacted>/g' \\
    -e 's/gsk_[A-Za-z0-9_-]{20,}/<redacted>/g' \\
    -e 's/csk-[A-Za-z0-9_-]{20,}/<redacted>/g' \\
    -e 's/gh[pousr]_[A-Za-z0-9_]{20,}/<redacted>/g' \\
    -e 's/[Bb]earer +[A-Za-z0-9._~+/=-]{16,}/<redacted>/g' \\
    "$file" 2>/dev/null || cat "$file" 2>/dev/null || true
}

# app-act (Phase 4): resolves the literal "{{result}}" placeholder in every
# value of $1 (a JSON object string, e.g. '{"text":"Check this: {{result}}"}')
# against $2 (the already-redacted run preview — see clean_result_preview),
# then runs redact_secrets_text over the resolved JSON a SECOND time as
# defense-in-depth. $preview is already redacted by the time it reaches here,
# so this second pass is a deliberate belt-and-suspenders for the first agent
# action type that can publish content externally (a leaked secret in a
# public X post is categorically worse than one in a private draft/notify) —
# not evidence the first pass is believed to be insufficient. Falls back to
# an empty object on any parse/exec failure (fail-closed: an app-act with no
# resolvable params fails its own presence check in dispatch_agent_action
# rather than firing with stale/unresolved "{{result}}" text).
resolve_app_act_params() {
  params_json="$1"
  preview="$2"
  tmp_in="$TMP_DIR/app-act-params-$AGENT_ID-$$.json"
  tmp_resolved="$TMP_DIR/app-act-params-resolved-$AGENT_ID-$$.json"
  printf '%s' "$params_json" > "$tmp_in"
  : > "$tmp_resolved"
  if node_usable; then
    SHELLY_APP_ACT_PREVIEW="$preview" shelly_node - "$tmp_in" <<'NODEEOF' > "$tmp_resolved" 2>/dev/null
const fs = require('fs');
const file = process.argv[2];
const preview = process.env.SHELLY_APP_ACT_PREVIEW || '';
let params = {};
try { params = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { params = {}; }
const out = {};
if (params && typeof params === 'object' && !Array.isArray(params)) {
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === 'string' ? v.split('{{result}}').join(preview) : '';
  }
}
process.stdout.write(JSON.stringify(out));
NODEEOF
  fi
  if [ ! -s "$tmp_resolved" ]; then
    printf '{}' > "$tmp_resolved"
  fi
  redact_secrets_text "$tmp_resolved"
  rm -f "$tmp_in" "$tmp_resolved"
}

# Detect a response that echoes the step-prompt scaffold back verbatim (see
# buildStepPrompt, lib/agent-orchestration.ts), is refusal boilerplate, or is
# empty/whitespace-only — rather than real content. The echo/refusal case is
# the on-device failure mode found 2026-07-15 (a small local model echoing
# its own prompt + refusing on an x.post step, reaching the user's confirm
# card as if it were real post content). The empty case is a SEPARATE bug
# found the same day: the old codex-driver path fed its all-telemetry stdout to
# clean_result_preview, so a successful Codex turn still yielded an empty
# $preview. The driver now writes item/completed agentMessage text to a separate
# .answer file; this empty check remains defense-in-depth for protocol/runtime
# failures that produce no usable answer file.
# Checked BEFORE any action that publishes outside the run's own log
# (app-act/webhook/dm-reply/draft/notify) so a bad completion never reaches a
# human-facing surface in the first place — this is a stronger, EARLIER gate
# than isLowQualityCompletion in lib/agent-escalation-ladder.ts (the JS copy
# is the unit-tested source of truth; this shell copy exists only because
# the pre-dispatch check has to happen here, before request_and_wait_approval,
# not after the run log is read back on the JS side).
is_low_quality_completion() {
  text="$1"
  # Empty/whitespace-only check first, cheaply, in plain shell (works even
  # without node) — trims via shell parameter expansion, no external process.
  trimmed="\${text#"\${text%%[![:space:]]*}"}"
  trimmed="\${trimmed%"\${trimmed##*[![:space:]]}"}"
  if [ -z "$trimmed" ]; then
    return 0
  fi
  if node_usable; then
    if SHELLY_QUALITY_CHECK_TEXT="$text" shelly_node -e '
const text = process.env.SHELLY_QUALITY_CHECK_TEXT || "";
const echoPatterns = [/#\\s*Results from previous steps/, /#\\s*This step\\b/];
const refusalPatterns = [
  /\\bas an ai\\b/i,
  /\\bi cannot generate\\b/i,
  /\\bi\\x27m (?:not able|unable) to\\b/i,
  /私は\\s*ai\\s*(なので|として)/i,
  /(生成|投稿)できません/,
];
const bad = echoPatterns.some((p) => p.test(text)) || refusalPatterns.some((p) => p.test(text));
process.exit(bad ? 0 : 1);
' 2>/dev/null; then
      return 0
    fi
    return 1
  fi
  # No node: coarse ASCII-only fallback — still catches the exact prompt-echo
  # markers (the failure mode actually observed on-device), misses the JA
  # refusal phrasing.
  printf '%s' "$text" | grep -Eqi '# ?Results from previous steps|# ?This step|as an ai|i cannot generate'
}

# File-based twin of is_low_quality_completion() above — same detection logic
# (kept byte-for-byte identical on purpose, so the two can never drift apart),
# but reads the text from a FILE instead of a shell argument/env var. Added for
# the 2026-07-15 P1 audit's webhook-payload gap: is_low_quality_completion's
# $preview argument is clean_result_preview's truncated preview, so a bad
# completion appearing only AFTER that truncation point would never reach
# either check. The webhook case below runs this against the full
# clean_result_full() output (redacted + telemetry-stripped, NOT truncated)
# so the quality gate actually covers everything that ends up in the webhook
# body's "result" field, not just its "preview" field.
is_low_quality_completion_file() {
  file="$1"
  if [ ! -s "$file" ]; then
    return 0
  fi
  if node_usable; then
    if shelly_node - "$file" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const file = process.argv[2];
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
const echoPatterns = [/#\\s*Results from previous steps/, /#\\s*This step\\b/];
const refusalPatterns = [
  /\\bas an ai\\b/i,
  /\\bi cannot generate\\b/i,
  /\\bi\\x27m (?:not able|unable) to\\b/i,
  /私は\\s*ai\\s*(なので|として)/i,
  /(生成|投稿)できません/,
];
const bad = echoPatterns.some((p) => p.test(text)) || refusalPatterns.some((p) => p.test(text));
process.exit(bad ? 0 : 1);
NODEEOF
    then
      return 0
    fi
    return 1
  fi
  grep -Eqi '# ?Results from previous steps|# ?This step|as an ai|i cannot generate' "$file"
}

# Strip the autonomous driver's structured telemetry (AUDIT/GATE/protocol/STDERR/
# escalation) from a result file so the user-facing preview shows real content,
# never the internal driver_start JSON. Backends that write a plain answer
# (local/perplexity/gemini) have no such lines, so this is a harmless no-op for
# them. Whitespace-collapsed and length-capped for a notification body. Also
# secret-redacted (SECRET-001 parity with PlanSpec's previewText()) BEFORE the
# truncation below, so a secret straddling the cut is never half-redacted —
# the .sh executor's clean_result_preview() feeds this preview into webhook
# bodies, notifications, intent-share text, and dm-reply text via {{result}}
# substitution (see write_action_approval_request), so it must never carry a
# live secret from the raw agent-tool result.
#
# The truncation budget below is imported from lib/agent-orchestration.ts's
# MAX_RESULT_CARRY_CHARS (2026-07-15 P1 audit fix) rather than a separately
# hardcoded number: this preview is also what agent-manager.ts's
# runAgentOrchestrated() carries into the NEXT chain step's prompt
# (log.outputPreview -> priorResults -> buildStepPrompt), and that function
# already bounds each carried result to MAX_RESULT_CARRY_CHARS — so a smaller
# number hardcoded here silently made that budget unreachable (every step only
# ever saw the smaller of the two, regardless of what buildStepPrompt allowed).
# Still a BYTE count (head -c), not a character count like the JS budget it
# mirrors, so multi-byte text (Japanese) still yields fewer effective
# characters than a pure JS-string .slice(0, N) would — a real but
# pre-existing shell/JS boundary limitation, not something this fix claims to
# fully resolve.
clean_result_preview() {
  file="$1"
  [ -f "$file" ] || return 0
  # Filter the driver telemetry into a temp file FIRST, then head THAT file.
  # Piping sed directly into "head -c N" SIGPIPEs sed the moment head closes the
  # pipe early (any cleaned result > N bytes — i.e. every real answer); under
  # 'set -euo pipefail' that 141 propagates and aborts the whole run. head reading
  # a regular file has no upstream producer to signal, so it is abort-safe. Same
  # reasoning applies to redact_secrets_text below: it runs against the $cleaned
  # FILE (not a live pipe), so head reading its output FILE stays abort-safe too.
  cleaned="$file.preview"
  redacted="$file.preview.redacted"
  sed -E '/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d' "$file" 2>/dev/null > "$cleaned" || true
  redact_secrets_text "$cleaned" > "$redacted" 2>/dev/null || true
  head -c ${MAX_RESULT_CARRY_CHARS} "$redacted" 2>/dev/null | tr '\\n' ' '
  rm -f "$cleaned" "$redacted"
}

# Same telemetry-strip + secret-redaction pipeline as clean_result_preview
# above, but returns the FULL cleaned text with no length truncation — for
# contexts that need the complete validated content rather than a
# notification-length preview. Added for the 2026-07-15 P1 audit: previously
# only write_webhook_payload's "result" field read $result_file directly
# (raw, unredacted, telemetry-included), bypassing every guarantee
# clean_result_preview provides for its "preview" field sitting right next to
# it in the same JSON payload.
clean_result_full() {
  file="$1"
  out="$2"
  if [ ! -f "$file" ]; then
    : > "$out"
    return 0
  fi
  cleaned="$file.full"
  redacted="$file.full.redacted"
  sed -E '/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d' "$file" 2>/dev/null > "$cleaned" || true
  redact_secrets_text "$cleaned" > "$redacted" 2>/dev/null || true
  mv "$redacted" "$out" 2>/dev/null || cp "$redacted" "$out" 2>/dev/null || : > "$out"
  rm -f "$cleaned" "$redacted"
}

# G6 char-limit guarantee, shell-side. Mirrors lib/agent-pipeline-presets.ts's
# enforceCharLimit() / scripts/shelly-plan-executor.js's enforcePlanCharLimit()
# byte-for-byte in algorithm (sentence-boundary-aware cut, ellipsis fallback) —
# found in the 2026-07-15 P1 audit to have NO caller anywhere in the
# foreground JS orchestration path; only the PlanSpec executor enforced it.
# $2 (limit) is RESULT_CHAR_LIMIT, already clamped (40-4000) at
# script-generation time in generateRunScript from agent.orchestration.charLimit
# — 0/empty means "no limit configured", a no-op. Prints the (possibly
# unchanged) text to stdout; the caller decides whether/how to persist it.
enforce_char_limit_text() {
  file="$1"
  limit="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  case "$limit" in
    ''|0) cat "$file" 2>/dev/null; return 0 ;;
  esac
  if node_usable; then
    if SHELLY_CHAR_LIMIT="$limit" shelly_node - "$file" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const file = process.argv[2];
const limit = Math.floor(Number(process.env.SHELLY_CHAR_LIMIT) || 0);
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
const chars = Array.from(text);
if (!limit || chars.length <= limit) {
  process.stdout.write(text);
} else {
  const ellipsis = '…';
  const budget = Math.max(limit - 1, 1);
  const head = chars.slice(0, budget);
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (terminators.has(head[i])) { cut = i; break; }
  }
  let out;
  if (cut >= Math.floor(budget * 0.6)) {
    out = head.slice(0, cut + 1).join('').replace(/\\s+$/, '');
  } else {
    out = head.join('').replace(/\\s+$/, '') + ellipsis;
  }
  process.stdout.write(out);
}
NODEEOF
    then
      return 0
    fi
  fi
  # No node: coarse BYTE-based fallback (may cut a multi-byte UTF-8 sequence
  # mid-character in this rare no-node case — same trade-off json_string_file's
  # own ASCII fallback already accepts elsewhere in this file).
  head -c "$limit" "$file" 2>/dev/null || cat "$file" 2>/dev/null
}

# Codex app-server answer text is written by shelly-agent-driver.js to a
# dedicated file, separate from the raw protocol/audit stream in RESULT_FILE.
# Redact and truncate that answer directly: never pass it through the telemetry
# prefix filter above, because it is content rather than driver diagnostics.
clean_answer_preview() {
  file="$1"
  [ -f "$file" ] || return 0
  redacted="$file.preview.redacted"
  redact_secrets_text "$file" > "$redacted" 2>/dev/null || true
  head -c ${MAX_RESULT_CARRY_CHARS} "$redacted" 2>/dev/null | tr '\n' ' '
  rm -f "$redacted"
}

result_preview() {
  if [ "$RESULT_CONTENT_IS_DRIVER_ANSWER" = "1" ] && [ -s "$RESULT_CONTENT_FILE" ]; then
    clean_answer_preview "$RESULT_CONTENT_FILE"
    return 0
  fi
  if [ "$CODEX_RESULT_ACTIVE" = "1" ]; then
    printf '%s' 'Codex produced no answer text for this step.'
    return 0
  fi
  clean_result_preview "$1"
}

write_native_notification_request() {
  status="$1"
  preview="$2"
  status_json=$(json_escape_text "$status")
  preview_json=$(json_escape_text "$preview")
  agent_json=$(json_escape_text "$AGENT_ID")
  agent_name_json=$(json_escape_text "$AGENT_NAME")
  tool_label_json=$(json_escape_text "$TOOL_LABEL")
  tmp="$ACTION_NOTIFY_FILE.tmp"
  cat > "$tmp" << NOTIFYEOF
{"agentId":"$agent_json","agentName":"$agent_name_json","toolLabel":"$tool_label_json","status":"$status_json","preview":"$preview_json","timestamp":$(date +%s)}
NOTIFYEOF
  mv "$tmp" "$ACTION_NOTIFY_FILE"
}

# IMPORTANT: $4 (result_file) MUST already be the OUTPUT of clean_result_full
# (telemetry-stripped + secret-redacted), never the raw agent-result file —
# this function does not clean it itself. 2026-07-15 P1 audit finding: this
# used to read $result_file (the raw file) directly via json_string_file,
# shipping un-redacted secrets and internal driver telemetry lines straight
# into an external Discord/Slack/Telegram webhook body, entirely bypassing
# both the redaction that $preview (the "preview" field right next to it)
# always gets AND the is_low_quality_completion gate for any content beyond
# $preview's truncation point. The one call site (dispatch_agent_action's
# webhook case) now passes a clean_result_full()-produced temp file instead.
write_webhook_payload() {
  out_file="$1"
  status="$2"
  preview="$3"
  result_file="$4"
  agent_json=$(json_escape_text "$AGENT_ID")
  status_json=$(json_escape_text "$status")
  preview_json=$(json_escape_text "$preview")
  tool_json=$(json_escape_text "$TOOL_LABEL")
  result_json=$(json_string_file "$result_file")
  cat > "$out_file" << PAYLOADEOF
{"agentId":"$agent_json","status":"$status_json","preview":"$preview_json","toolUsed":"$tool_json","timestamp":$(date +%s),"result":$result_json}
PAYLOADEOF
}

cap_roots_file() {
  roots_file="$TMP_DIR/cap-roots-$AGENT_ID.txt"
  : > "$roots_file"
  cap_add_root() {
    root="$1"
    [ -n "$root" ] || return 0
    printf '%s\\n' "$root" >> "$roots_file"
  }
  cap_add_root "$HOME/agent-output"
  cap_add_root "$TMP_DIR"
  cap_add_root "$HOME/projects/shelly-content-studio"
  cap_add_root "\${SHELLY_CONTENT_PROJECT:-$HOME/projects/shelly-content-studio}"
  cap_add_root "\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}"
  cap_add_root "\${SHELLY_AGENT_CUSTOM_PATH:-$HOME/agent-output}"
  printf '%s\\n' "$roots_file"
}

cap_fs_write_file() {
  dest="$1"
  src="$2"
  if [ "\${SHELLY_CAP_FS:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then
    roots_file="$(cap_roots_file)"
    cap_out="$TMP_DIR/cap-fs-$AGENT_ID-$$.out"
    cap_err="$TMP_DIR/cap-fs-$AGENT_ID-$$.err"
    set +e
    shelly_node "$HOME/.shelly-capability-broker.js" \\
      --op fs.write --path "$dest" --input-file "$src" \\
      --roots-file "$roots_file" \\
      --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
      --out "$cap_out" --err "$cap_err"
    cap_rc=$?
    set -e
    if [ "$cap_rc" -ne 0 ]; then
      ACTION_DISPATCH_STATUS="error"
      ACTION_DISPATCH_MESSAGE="Scoped filesystem write denied for $(basename "$dest"): $(head -c 240 "$cap_err" 2>/dev/null | tr '\\n' ' ')"
      return "$cap_rc"
    fi
    return 0
  fi
  if [ "\${SHELLY_CAP_FS:-0}" = "1" ]; then
    ACTION_DISPATCH_STATUS="error"
    ACTION_DISPATCH_MESSAGE="Scoped filesystem broker requested but unavailable; refusing unbrokered write."
    return 44
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

cap_workspace_exec() {
  command_text="$1"
  cwd="$2"
  out_file="$3"
  err_file="$4"
  if [ "\${SHELLY_CAP_EXEC:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then
    roots_file="$(cap_roots_file)"
    command_file="$TMP_DIR/cap-exec-command-$AGENT_ID-$$.sh"
    printf '%s' "$command_text" > "$command_file"
    set +e
    shelly_node "$HOME/.shelly-capability-broker.js" \\
      --op workspace.exec --command-file "$command_file" --cwd "$cwd" \\
      --roots-file "$roots_file" \\
      --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
      --timeout-seconds "$TIMEOUT" \\
      --out "$out_file" --err "$err_file"
    cap_rc=$?
    set -e
    rm -f "$command_file"
    return "$cap_rc"
  fi
  if [ "\${SHELLY_CAP_EXEC:-0}" = "1" ]; then
    echo "workspace.exec broker requested but unavailable; refusing unbrokered exec." > "$err_file"
    return 44
  fi
  : > "$err_file"
  bash -lc "$command_text" > "$out_file" 2>&1
}

webhook_destination_host() {
  url="$1"
  if node_usable; then
    if SHELLY_WEBHOOK_URL="$url" shelly_node -e 'try { const u = new URL(process.env.SHELLY_WEBHOOK_URL || ""); if (u.protocol !== "https:" || !u.hostname) process.exit(1); process.stdout.write(u.hostname.toLowerCase()); } catch (_) { process.exit(1); }' 2>/dev/null; then
      return 0
    fi
  fi
  case "$url" in
    https://*) ;;
    *) return 1 ;;
  esac
  host=$(printf '%s' "$url" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##; s/:.*$//' | tr '[:upper:]' '[:lower:]')
  [ -n "$host" ] || return 1
  printf '%s' "$host"
}

webhook_host_is_allowlisted() {
  candidate=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  configured=$(printf '%s' "\${SHELLY_WEBHOOK_HOST_ALLOWLIST:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case ",$configured," in
    *",$candidate,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── social-post helpers (2026-07-22) ───────────────────────────────────────
# Connector secrets/meta are resolved at RUNTIME from the sourced $ENV_FILE
# (SOCIAL_CONNECTOR_<ID>_<FIELD> vars written by settings-store's
# addSocialConnector — the exact .env pattern PERPLEXITY_API_KEY already uses)
# via bash indirect expansion on the baked ACTION_SOCIAL_ENV_PREFIX, so a
# secret value never appears in this script's literal source.
social_connector_env() {
  _sce_name="\${ACTION_SOCIAL_ENV_PREFIX}_$1"
  printf '%s' "\${!_sce_name:-}"
}

# Mirrors webhook_host_is_allowlisted above against the social opt-in list.
# SHELLY_SOCIAL_HOST_ALLOWLIST is the user's explicit consent for SILENT
# unattended dispatch to that connector host; a non-allowlisted host always
# requires a human approval tap (see the social-post) dispatch case).
social_host_is_allowlisted() {
  candidate=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  configured=$(printf '%s' "\${SHELLY_SOCIAL_HOST_ALLOWLIST:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case ",$configured," in
    *",$candidate,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# The connector's declared host is definitionally its ONLY allowed target
# (lib/capability-envelope.ts's isSocialConnectorHostAllowed) — verify the URL
# we are about to POST actually resolves to it (https is enforced by
# webhook_destination_host). Catches a discord/slack webhookUrl secret whose
# real host diverges from the registered connector host, and a telegram
# connector registered against any host other than api.telegram.org.
social_require_url_host() {
  _srh_url="$1"
  _srh_expected=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  _srh_actual="$(webhook_destination_host "$_srh_url" 2>/dev/null || true)"
  [ -n "$_srh_actual" ] && [ "$_srh_actual" = "$_srh_expected" ]
}

social_post_error() {
  ACTION_DISPATCH_STATUS="error"
  ACTION_DISPATCH_MESSAGE="$1"
  write_native_notification_request "error" "$1" || true
}

# Composes and sends the per-platform HTTP request for the social-post action.
# $1 = connector host, $2 = resolved post text. Secrets come only from env
# vars (social_connector_env); response/error text is redacted
# (redact_secrets_text) before any of it can reach a message/notification.
# Returns non-zero with ACTION_DISPATCH_STATUS/MESSAGE set on failure.
dispatch_social_post() {
  sp_host="$1"
  sp_text="$2"
  sp_body="$TMP_DIR/social-post-body-$AGENT_ID-$$.json"
  sp_response="$TMP_DIR/social-post-response-$AGENT_ID-$$.txt"
  sp_error="$TMP_DIR/social-post-error-$AGENT_ID-$$.txt"
  sp_url=""
  sp_auth_header=""
  sp_text_json=$(json_escape_text "$sp_text")
  case "$ACTION_SOCIAL_PLATFORM" in
    discord)
      # The full webhook URL IS the secret; Discord's payload field is literally "content".
      sp_url="$(social_connector_env WEBHOOKURL)"
      if [ -z "$sp_url" ]; then
        social_post_error "Discord connector is missing its webhook URL secret."
        return 1
      fi
      printf '{"content":"%s"}' "$sp_text_json" > "$sp_body"
      ;;
    slack)
      sp_url="$(social_connector_env WEBHOOKURL)"
      if [ -z "$sp_url" ]; then
        social_post_error "Slack connector is missing its webhook URL secret."
        return 1
      fi
      printf '{"text":"%s"}' "$sp_text_json" > "$sp_body"
      ;;
    telegram)
      sp_token="$(social_connector_env BOTTOKEN)"
      sp_chat="$(social_connector_env CHATID)"
      if [ -z "$sp_token" ] || [ -z "$sp_chat" ]; then
        social_post_error "Telegram connector is missing its bot token or chat id."
        return 1
      fi
      sp_url="https://api.telegram.org/bot$sp_token/sendMessage"
      sp_chat_json=$(json_escape_text "$sp_chat")
      printf '{"chat_id":"%s","text":"%s"}' "$sp_chat_json" "$sp_text_json" > "$sp_body"
      ;;
    mastodon)
      sp_token="$(social_connector_env ACCESSTOKEN)"
      if [ -z "$sp_token" ]; then
        social_post_error "Mastodon connector is missing its access token."
        return 1
      fi
      sp_url="https://$sp_host/api/v1/statuses"
      sp_auth_header="Bearer $sp_token"
      printf '{"status":"%s"}' "$sp_text_json" > "$sp_body"
      ;;
    misskey)
      sp_token="$(social_connector_env APITOKEN)"
      if [ -z "$sp_token" ]; then
        social_post_error "Misskey connector is missing its API token."
        return 1
      fi
      sp_url="https://$sp_host/api/notes/create"
      sp_token_json=$(json_escape_text "$sp_token")
      # Misskey convention: the auth token travels IN the body ("i"), not a header.
      printf '{"i":"%s","text":"%s"}' "$sp_token_json" "$sp_text_json" > "$sp_body"
      ;;
    wordpress)
      sp_user="$(social_connector_env USERNAME)"
      sp_pass="$(social_connector_env APPPASSWORD)"
      if [ -z "$sp_user" ] || [ -z "$sp_pass" ]; then
        social_post_error "WordPress connector is missing its username or application password."
        return 1
      fi
      if ! node_usable; then
        social_post_error "WordPress posting needs node for Basic-auth encoding."
        return 1
      fi
      sp_basic=$(SOCIAL_BASIC_USER="$sp_user" SOCIAL_BASIC_PASS="$sp_pass" shelly_node -e 'process.stdout.write(Buffer.from((process.env.SOCIAL_BASIC_USER || "") + ":" + (process.env.SOCIAL_BASIC_PASS || "")).toString("base64"));' 2>/dev/null || true)
      if [ -z "$sp_basic" ]; then
        social_post_error "WordPress Basic-auth encoding failed."
        return 1
      fi
      sp_url="https://$sp_host/wp-json/wp/v2/posts"
      sp_auth_header="Basic $sp_basic"
      sp_title=$(printf '%s' "$sp_text" | head -n 1 | head -c 80)
      [ -n "$sp_title" ] || sp_title="Shelly agent post"
      sp_title_json=$(json_escape_text "$sp_title")
      # "status":"publish" matches this action type's auto-POST intent (the
      # whole point is unattended publishing once approved/allowlisted); a
      # review-first workflow should use the draft action, not social-post.
      printf '{"title":"%s","content":"%s","status":"publish"}' "$sp_title_json" "$sp_text_json" > "$sp_body"
      ;;
    bluesky)
      # Two sequential calls: (1) createSession exchanges handle+app-password
      # for accessJwt+did; (2) createRecord posts with the session Bearer.
      sp_handle="$(social_connector_env HANDLE)"
      sp_pass="$(social_connector_env APPPASSWORD)"
      if [ -z "$sp_handle" ] || [ -z "$sp_pass" ]; then
        social_post_error "Bluesky connector is missing its handle or app password."
        return 1
      fi
      sp_handle_json=$(json_escape_text "$sp_handle")
      sp_pass_json=$(json_escape_text "$sp_pass")
      sp_session_body="$TMP_DIR/social-post-session-$AGENT_ID-$$.json"
      sp_session_out="$TMP_DIR/social-post-session-out-$AGENT_ID-$$.json"
      printf '{"identifier":"%s","password":"%s"}' "$sp_handle_json" "$sp_pass_json" > "$sp_session_body"
      set +e
      SHELLY_CAP_APPROVED=1 HTTP_TIMEOUT_SECONDS="\${SOCIAL_POST_TIMEOUT_SECONDS:-30}" http_post_json "https://$sp_host/xrpc/com.atproto.server.createSession" "$sp_session_body" "$sp_session_out" "$sp_error"
      sp_session_rc=$?
      set -e
      rm -f "$sp_session_body"
      sp_jwt=""
      sp_did=""
      if [ "$sp_session_rc" -eq 0 ] && [ -s "$sp_session_out" ]; then
        sp_jwt="$(json_field_file "$sp_session_out" "accessJwt")"
        sp_did="$(json_field_file "$sp_session_out" "did")"
      fi
      rm -f "$sp_session_out"
      if [ -z "$sp_jwt" ] || [ -z "$sp_did" ]; then
        sp_sess_err=$(redact_secrets_text "$sp_error" 2>/dev/null | head -c 240 | tr '\\n' ' ')
        rm -f "$sp_error"
        social_post_error "Bluesky session exchange failed (exit $sp_session_rc): $sp_sess_err"
        return 1
      fi
      sp_auth_header="Bearer $sp_jwt"
      sp_url="https://$sp_host/xrpc/com.atproto.repo.createRecord"
      sp_did_json=$(json_escape_text "$sp_did")
      sp_created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf '{"repo":"%s","collection":"app.bsky.feed.post","record":{"text":"%s","createdAt":"%s"}}' "$sp_did_json" "$sp_text_json" "$sp_created_at" > "$sp_body"
      ;;
    *)
      social_post_error "Unsupported social platform: $ACTION_SOCIAL_PLATFORM"
      return 1
      ;;
  esac
  if ! social_require_url_host "$sp_url" "$sp_host"; then
    rm -f "$sp_body"
    social_post_error "Social-post destination host does not match the connector's registered host ($sp_host)."
    return 1
  fi
  # Broker mode (SHELLY_CAP_BROKER=1): the broker only builds headers from its
  # fixed AUTH_REFS, so a connector's Bearer/Basic header travels via a 0600
  # header file instead (http_post_json forwards it through --header-file).
  sp_header_file=""
  if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ] && [ -n "$sp_auth_header" ]; then
    sp_header_file="$TMP_DIR/social-post-headers-$AGENT_ID-$$.json"
    sp_auth_header_json=$(json_escape_text "$sp_auth_header")
    printf '{"Authorization":"%s"}' "$sp_auth_header_json" > "$sp_header_file"
    chmod 600 "$sp_header_file" 2>/dev/null || true
  fi
  set +e
  if [ -n "$sp_auth_header" ]; then
    SHELLY_CAP_APPROVED=1 SHELLY_CAP_HEADER_FILE="$sp_header_file" HTTP_AUTH_HEADER="$sp_auth_header" HTTP_TIMEOUT_SECONDS="\${SOCIAL_POST_TIMEOUT_SECONDS:-30}" http_post_json "$sp_url" "$sp_body" "$sp_response" "$sp_error"
  else
    SHELLY_CAP_APPROVED=1 HTTP_TIMEOUT_SECONDS="\${SOCIAL_POST_TIMEOUT_SECONDS:-30}" http_post_json "$sp_url" "$sp_body" "$sp_response" "$sp_error"
  fi
  sp_rc=$?
  set -e
  rm -f "$sp_body"
  if [ -n "$sp_header_file" ]; then
    rm -f "$sp_header_file"
  fi
  if [ "$sp_rc" -ne 0 ]; then
    sp_err_txt=$(redact_secrets_text "$sp_error" 2>/dev/null | head -c 240 | tr '\\n' ' ')
    rm -f "$sp_response" "$sp_error"
    social_post_error "Social post to $ACTION_SOCIAL_PLATFORM ($sp_host) failed with exit $sp_rc: $sp_err_txt"
    return 1
  fi
  rm -f "$sp_response" "$sp_error"
  return 0
}

sha256_file() {
  file="$1"
  if node_usable; then
    if shelly_node - "$file" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const crypto = require('crypto');
const file = process.argv[2];
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
NODEEOF
    then
      return 0
    fi
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  return 1
}

json_field_file() {
  file="$1"
  field="$2"
  if node_usable; then
    if shelly_node - "$file" "$field" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const [file, field] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'))[field];
if (typeof value === 'string') process.stdout.write(value);
NODEEOF
    then
      return 0
    fi
  fi
  sed -nE "s/.*\\\"$field\\\"[[:space:]]*:[[:space:]]*\\\"([^\\\"]*)\\\".*/\\1/p" "$file" 2>/dev/null | head -n 1
}

dm_pairing_lookup() {
  file="$1"
  pairing_id="$2"
  node_usable || return 2
  shelly_node - "$file" "$pairing_id" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const [file, id] = process.argv.slice(2);
let list;
try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { process.exit(2); }
if (!Array.isArray(list)) process.exit(2);
const found = list.find((p) => p && typeof p === 'object' && p.id === id);
if (!found) process.exit(1);
if (typeof found.revoked !== 'boolean' || typeof found.label !== 'string') process.exit(2);
process.stdout.write((found.revoked ? '1' : '0') + '\\t' + found.label);
NODEEOF
}

write_action_approval_request() {
  approval_type="$1"
  preview="$2"
  result_file="$3"
  destination_host="\${4:-}"
  payload_path="\${5:-}"
  destination_host_allowlisted="\${6:-false}"
  mkdir -p "$ACTION_APPROVAL_DIR" "$ACTION_APPROVAL_REPLY_DIR" "$LOG_DIR"
  preview_json=$(json_escape_text "$preview")
  agent_json=$(json_escape_text "$AGENT_ID")
  agent_name_json=$(json_escape_text "$AGENT_NAME")
  tool_label_json=$(json_escape_text "$TOOL_LABEL")
  approval_type_json=$(json_escape_text "$approval_type")
  destination_json=$(json_escape_text "$destination_host")
  command_json=$(json_escape_text "$ACTION_COMMAND")
  safety_level_json=$(json_escape_text "$ACTION_COMMAND_SAFETY_LEVEL")
  safety_reason_json=$(json_escape_text "$ACTION_COMMAND_SAFETY_REASON")
  payload_path_json=$(json_escape_text "$payload_path")
  result_path_json=$(json_escape_text "$result_file")
  intent_share_text_resolved="\${ACTION_INTENT_SHARE_TEXT//\\{\\{result\\}\\}/$preview}"
  intent_mode_json=$(json_escape_text "$ACTION_INTENT_MODE")
  intent_target_json=$(json_escape_text "$ACTION_INTENT_TARGET")
  intent_share_text_json=$(json_escape_text "$intent_share_text_resolved")
  dm_reply_text_resolved="\${ACTION_DM_REPLY_TEXT//\{\{result\}\}/$preview}"
  dm_pairing_id_json=$(json_escape_text "$ACTION_DM_PAIRING_ID")
  dm_pairing_label_json=$(json_escape_text "\${ACTION_DM_PAIRING_LABEL:-}")
  dm_reply_text_json=$(json_escape_text "$dm_reply_text_resolved")
  # app-act (Phase 4): resolve_app_act_params substitutes {{result}} in every
  # param value against $preview (already redacted) and redacts the resolved
  # JSON a second time (defense-in-depth for the first agent action type that
  # can publish externally). The resolved JSON is embedded as a plain STRING
  # field (json_escape_text), same shape as intentShareText/dmReplyText, not
  # a nested object — the approval-request record is a flat string map.
  app_act_recipe_id_json=$(json_escape_text "$ACTION_APP_ACT_RECIPE_ID")
  # ACTION_APP_ACT_PARAMS_JSON defaults to '{}' for every non-app-act action
  # (see actionAppActParamsJson in generateRunScript), so resolving it
  # unconditionally here is a harmless no-op for those calls -- no need to
  # branch on $approval_type.
  app_act_params_resolved=$(resolve_app_act_params "$ACTION_APP_ACT_PARAMS_JSON" "$preview")
  app_act_params_resolved_json=$(json_escape_text "$app_act_params_resolved")
  ts_seconds=$(date +%s)
  expires_at=$(( (ts_seconds + ACTION_APPROVAL_TIMEOUT_SECONDS) * 1000 ))
  # auto_accept (project owner directive 2026-07-14): tells RN it may resolve
  # this request itself, no human tap, when the global/per-agent approval-mode
  # default is 'auto'. Only meaningful for intent/dm-reply (the only two types
  # that still always reach here regardless of mode — see dispatch_agent_action)
  # — harmless/unused for every other type.
  auto_accept_flag=$([ "$ACTION_APPROVAL_MODE" != "manual" ] && printf 'true' || printf 'false')
  # auto_fire_trusted: app-act's OWN narrower Tier-B gate (see
  # ACTION_APP_ACT_AUTO_FIRE_TRUSTED above) — deliberately independent of
  # auto_accept_flag/ACTION_APPROVAL_MODE. Native's action-approval notifier
  # (AgentRuntime.kt) only acts on this for actionType=="app-act". Emitted as
  # a real JSON boolean literal (not a quoted string) so Kotlin's
  # JSONObject.optBoolean parses both executors' requests identically.
  auto_fire_trusted_flag=$([ "$ACTION_APP_ACT_AUTO_FIRE_TRUSTED" = "1" ] && printf 'true' || printf 'false')
  tmp="$ACTION_APPROVAL_REQUEST_FILE.tmp"
  cat > "$tmp" << APPROVALEOF
{"runId":"$ACTION_RUN_ID","agentId":"$agent_json","agentName":"$agent_name_json","toolLabel":"$tool_label_json","actionType":"$approval_type_json","preview":"$preview_json","destinationHost":"$destination_json","destinationHostAllowlisted":$destination_host_allowlisted,"command":"$command_json","safetyLevel":"$safety_level_json","safetyReason":"$safety_reason_json","payloadPath":"$payload_path_json","resultPath":"$result_path_json","intentMode":"$intent_mode_json","intentTarget":"$intent_target_json","intentShareText":"$intent_share_text_json","dmPairingId":"$dm_pairing_id_json","dmPairingLabel":"$dm_pairing_label_json","dmReplyText":"$dm_reply_text_json","appActRecipeId":"$app_act_recipe_id_json","appActParamsResolved":"$app_act_params_resolved_json","autoAccept":$auto_accept_flag,"autoFireTrusted":$auto_fire_trusted_flag,"ts":"$(date -Iseconds)","expiresAt":$expires_at}
APPROVALEOF
  mv "$tmp" "$ACTION_APPROVAL_REQUEST_FILE"
  ACTION_APPROVAL_REQUEST_SHA256="$(sha256_file "$ACTION_APPROVAL_REQUEST_FILE" || true)"
}

# Project owner directive 2026-07-14: wraps write_action_approval_request +
# wait_action_approval so draft/notify/webhook/cli can skip the round trip
# ENTIRELY when the approval-mode default is 'auto' — no request file is ever
# written, so there is nothing for a background/asleep JS bridge to wait on
# (unattended scheduled runs must not depend on JS being alive to proceed).
# intent/dm-reply/app-act are excluded from the skip (they only ever fire via
# RN/native — see dispatch_agent_action's own comments on each) and always go
# through the full write+wait; auto-approval for THOSE happens via the
# autoAccept/autoFireTrusted flags above instead, consumed by RN/native.
request_and_wait_approval() {
  approval_type="$1"
  preview="$2"
  result_file="$3"
  destination_host="\${4:-}"
  payload_path="\${5:-}"
  destination_host_allowlisted="\${6:-false}"
  if [ "$ACTION_APPROVAL_MODE" != "manual" ]; then
    case "$approval_type" in
      intent|dm-reply|app-act) ;;
      *) return 0 ;;
    esac
  fi
  write_action_approval_request "$approval_type" "$preview" "$result_file" "$destination_host" "$payload_path" "$destination_host_allowlisted"
  wait_action_approval "$approval_type"
}

# docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1 (2026-07-17): the
# runId+requestSha256 equality wait_action_approval used to rely on alone is
# NOT a secret — requestSha256 is a hash of a file the agent script itself
# wrote, and both files live under the SAME uid's filesystem the script runs
# as, so the script could forge its own reply. Mirrors AgentEscalationBridge's
# fix for the analogous escalation-reply forgery: AgentActionApprovalBridge
# now signs every reply with an Android Keystore RSA key whose private
# material never leaves the keystore, and this verifies that signature before
# trusting a reply. Fails CLOSED (returns 1 / "invalid") on every negative
# signal — missing signature, wrong algorithm, unpinned/mismatched public key,
# unparseable key, or a signature that doesn't verify — exactly like a
# runId/requestSha256 mismatch already did. $ACTION_APPROVAL_PUBLIC_KEY_SHA256
# empty (host harness / a launcher that forgot to inject the pin) fails closed
# too, matching the escalation verifier's own "no pin -> refuse the key"
# production default (scripts/shelly-agent-driver.js's ensureEscalationVerifierKey).
verify_action_approval_reply() {
  run_id="$1"
  decision="$2"
  request_ts="$3"
  request_sha256="$4"
  sig_alg="$5"
  signature="$6"
  case "$decision" in
    accept|decline) ;;
    *) return 1 ;;
  esac
  [ "$sig_alg" = "SHA256withRSA" ] || return 1
  [ -n "$signature" ] || return 1
  [ -n "$ACTION_APPROVAL_PUBLIC_KEY_SHA256" ] || return 1
  [ -n "$ACTION_APPROVAL_PUBLIC_KEY_FILE" ] && [ -s "$ACTION_APPROVAL_PUBLIC_KEY_FILE" ] || return 1
  node_usable || return 1
  shelly_node - "$run_id" "$decision" "$request_ts" "$request_sha256" "$signature" \
    "$ACTION_APPROVAL_PUBLIC_KEY_FILE" "$ACTION_APPROVAL_PUBLIC_KEY_SHA256" <<'NODEEOF' 2>/dev/null
const fs = require('fs');
const crypto = require('crypto');
const [runId, decision, requestTs, requestSha256, signatureB64, keyFile, keySha256] = process.argv.slice(2);
try {
  const der = fs.readFileSync(keyFile);
  const actualSha256 = crypto.createHash('sha256').update(der).digest('hex');
  if (!keySha256 || actualSha256 !== keySha256) process.exit(1);
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const message = [runId, decision, requestTs, requestSha256].join('\\n');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(message, 'utf8');
  verifier.end();
  const signature = Buffer.from(signatureB64 || '', 'base64');
  if (signature.length < 16 || !verifier.verify(publicKey, signature)) process.exit(1);
  process.exit(0);
} catch (_err) {
  process.exit(1);
}
NODEEOF
}

wait_action_approval() {
  approval_type="$1"
  deadline=$(( $(date +%s) + ACTION_APPROVAL_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    if [ -s "$ACTION_APPROVAL_REPLY_FILE" ]; then
      reply_run_id="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "runId")"
      reply_decision="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "decision")"
      reply_request_sha="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "requestSha256")"
      reply_request_ts="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "requestTs")"
      reply_sig_alg="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "sigAlg")"
      reply_signature="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "signature")"
      if [ "$reply_run_id" != "$ACTION_RUN_ID" ] ||
        [ -z "$ACTION_APPROVAL_REQUEST_SHA256" ] ||
        [ "$reply_request_sha" != "$ACTION_APPROVAL_REQUEST_SHA256" ]; then
        rm -f "$ACTION_APPROVAL_REPLY_FILE" "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="$approval_type action approval reply did not match the pending request."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if ! verify_action_approval_reply "$ACTION_RUN_ID" "$reply_decision" "$reply_request_ts" "$reply_request_sha" "$reply_sig_alg" "$reply_signature"; then
        rm -f "$ACTION_APPROVAL_REPLY_FILE" "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="$approval_type action approval reply signature could not be verified."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ "$reply_decision" = "accept" ]; then
        rm -f "$ACTION_APPROVAL_REPLY_FILE" "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
        return 0
      fi
      rm -f "$ACTION_APPROVAL_REPLY_FILE" "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
      ACTION_DISPATCH_STATUS="skipped"
      ACTION_DISPATCH_MESSAGE="$approval_type action was declined."
      write_native_notification_request "skipped" "$ACTION_DISPATCH_MESSAGE" || true
      return 1
    fi
    sleep 1
  done
  rm -f "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
  ACTION_DISPATCH_STATUS="skipped"
  ACTION_DISPATCH_MESSAGE="$approval_type action approval timed out."
  write_native_notification_request "skipped" "$ACTION_DISPATCH_MESSAGE" || true
  return 1
}

register_source_urls() {
  result_file="$1"
  REGISTRY_LOCK="$SOURCE_REGISTRY_FILE.lock"
  REGISTRY_LOCK_ACQUIRED=0
  lock_attempt=0
  until mkdir "$REGISTRY_LOCK" 2>/dev/null; do
    lock_attempt=$((lock_attempt + 1))
    if [ "$lock_attempt" -ge 30 ]; then
      break
    fi
    sleep 1
  done
  if [ "$lock_attempt" -lt 30 ]; then
    REGISTRY_LOCK_ACQUIRED=1
  fi
  { grep -Eo 'https?://[^][ )<>"'"'"']+' "$result_file" 2>/dev/null || true; } | sed 's/[.,;)]$//' | sort -u | while read -r url; do
    [ -n "$url" ] || continue
    if ! awk -F '\\t' -v url="$url" '$4 == url { found=1 } END { exit found ? 0 : 1 }' "$SOURCE_REGISTRY_FILE"; then
      printf '%s\\t%s\\t%s\\t%s\\n' "$(date -Iseconds)" "$AGENT_ID" "$TOOL_LABEL" "$url" >> "$SOURCE_REGISTRY_FILE"
    fi
  done
  if [ "$REGISTRY_LOCK_ACQUIRED" = "1" ] && [ -d "$REGISTRY_LOCK" ]; then
    rmdir "$REGISTRY_LOCK" 2>/dev/null || true
    REGISTRY_LOCK_ACQUIRED=0
    REGISTRY_LOCK=""
  fi
}

resolve_saved_path() {
  saved_candidate="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$saved_candidate" 2>/dev/null && return 0
  fi
  case "$saved_candidate" in
    /*) printf '%s\n' "$saved_candidate" ;;
    *) printf '%s/%s\n' "$HOME" "$saved_candidate" ;;
  esac
}

save_draft_result() {
  result_file="$1"
  SAVED_PATH=""
  SAVED_PATH_MIRROR=""
  DATE=$(date +%Y-%m-%d)
  TIME=$(date +%H%M%S)

  # General collection agents: write to the user-chosen destination with a clean,
  # findable layout <base>/<topic?>/<date>/<date>_<title>.md. The .sh sources
  # ~/.shelly/agents/.env, so these globals (written by Settings) are in scope.
  # Default target 'local' lands in $HOME/agent-output (NOT the old buried
  # ~/.shelly/agents/<name>/output.md path that was hard to find).
  if [ "\${USE_GLOBAL_OUTPUT:-0}" = "1" ]; then
    case "\${SHELLY_AGENT_OUTPUT_TARGET:-local}" in
      obsidian)
        OUT_BASE="\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}"
        [ -n "\${SHELLY_AGENT_TOPIC_FOLDER:-}" ] && OUT_BASE="$OUT_BASE/$SHELLY_AGENT_TOPIC_FOLDER"
        ;;
      custom)
        OUT_BASE="\${SHELLY_AGENT_CUSTOM_PATH:-$HOME/agent-output}"
        [ -n "\${SHELLY_AGENT_TOPIC_FOLDER:-}" ] && OUT_BASE="$OUT_BASE/$SHELLY_AGENT_TOPIC_FOLDER"
        ;;
      *)
        OUT_BASE="$HOME/agent-output"
        ;;
    esac
    SAVED_FILE="$OUT_BASE/$DATE/\${DATE}_$SLUG.md"
    cap_fs_write_file "$SAVED_FILE" "$result_file"
    SAVED_PATH=$(resolve_saved_path "$SAVED_FILE")
    register_source_urls "$result_file"
    return 0
  fi

  # Content-studio agents: keep the explicit per-agent OUTPUT_DIR + template, and
  # the keyword-routed Obsidian mirror below.
  # Resolve the output-filename template ({date}/{slug}/{time}); '/' yields a
  # date-folder layout. SLUG/DATE/TIME contain no '|' so it is a safe sed
  # delimiter. The template was sanitized in TS (no leading '/' or '..').
  REL_NAME=$(printf '%s' "$OUTPUT_NAME_TEMPLATE" | sed -e "s|{date}|$DATE|g" -e "s|{slug}|$SLUG|g" -e "s|{time}|$TIME|g")
  case "$REL_NAME" in
    *.md|*.markdown|*.txt) ;;
    *) REL_NAME="$REL_NAME.md" ;;
  esac
  SAVED_FILE="$OUTPUT_DIR/$REL_NAME"
  cap_fs_write_file "$SAVED_FILE" "$result_file"
  SAVED_PATH=$(resolve_saved_path "$SAVED_FILE")

  if [ -n "\${OBSIDIAN_VAULT_PATH:-}" ] && [ -d "$OBSIDIAN_VAULT_PATH" ]; then
    OBSIDIAN_TARGET="90_Log/Agent_Output"
    case "$OUTPUT_DIR" in
      *drafts/substack*) OBSIDIAN_TARGET="50_Drafts/Substack" ;;
      *drafts/x*) OBSIDIAN_TARGET="50_Drafts/X" ;;
      *drafts/articles*) OBSIDIAN_TARGET="50_Drafts/Substack" ;;
      *sources*) OBSIDIAN_TARGET="20_Literature/Papers" ;;
      *images/prompts*) OBSIDIAN_TARGET="60_Experiments/Image_Prompts" ;;
      *evals*) OBSIDIAN_TARGET="90_Log/Agent_Evals" ;;
    esac
    OBSIDIAN_DEST="$OBSIDIAN_VAULT_PATH/$OBSIDIAN_TARGET/$REL_NAME"
    cap_fs_write_file "$OBSIDIAN_DEST" "$SAVED_FILE"
    SAVED_PATH_MIRROR=$(resolve_saved_path "$OBSIDIAN_DEST")
  fi

  register_source_urls "$result_file"
}

dispatch_agent_action() {
  result_file="$1"
  preview="$2"
  ACTION_DISPATCH_STATUS=""
  ACTION_DISPATCH_MESSAGE=""

  case "$ACTION_TYPE" in
    __suppressed__)
      # Orchestration non-final step: still save the draft result for the next
      # step to read, but DO NOT request approval or fire a notification.
      save_draft_result "$result_file" 2>/dev/null || true
      return 0
      ;;
    ""|draft)
      if is_low_quality_completion "$preview"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Draft content looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      # N2: autonomous agents auto-approve a draft→vault save. It is a local file
      # write only (low-risk) — cli/webhook/notify still require an approval tap,
      # and secret-guard has already forced the run on-device, so nothing leaves
      # the device unapproved. Manual (@agent) runs keep the confirm card.
      if [ "\${AGENT_AUTONOMOUS:-0}" != "1" ]; then
        request_and_wait_approval "draft" "$preview" "$result_file" || return 1
      fi
      save_draft_result "$result_file"
      # Post ONE readable completion card after the draft is saved, so the run
      # gives the user closure (matching the notify action). The preview is
      # already telemetry-stripped. Orchestration non-final steps never reach here
      # (they use the __suppressed__ branch above), so a chain still ends with a
      # single completion, not one per step.
      if [ -n "$SAVED_PATH" ]; then
        SAVED_DISPLAY_PATH="$SAVED_PATH"
        if [ -n "\${OBSIDIAN_VAULT_PATH:-}" ]; then
          case "$SAVED_PATH" in
            "$OBSIDIAN_VAULT_PATH"/*) SAVED_DISPLAY_PATH="\${SAVED_PATH#"$OBSIDIAN_VAULT_PATH"/}" ;;
          esac
        fi
        if [ "$SAVED_DISPLAY_PATH" = "$SAVED_PATH" ]; then
          case "$SAVED_PATH" in
            "$HOME"/*) SAVED_DISPLAY_PATH="\${SAVED_PATH#"$HOME"/}" ;;
          esac
        fi
        write_native_notification_request "success" "保存: $SAVED_DISPLAY_PATH $preview" || true
      else
        write_native_notification_request "success" "$preview" || true
      fi
      return 0
      ;;
    notify)
      if is_low_quality_completion "$preview"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Notify content looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      request_and_wait_approval "notify" "$preview" "$result_file" || return 1
      write_native_notification_request "success" "$preview"
      return 0
      ;;
    webhook)
      if [ -z "$ACTION_WEBHOOK_URL" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Webhook action is missing an https URL."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      case "$ACTION_WEBHOOK_URL" in
        https://*) ;;
        *)
          ACTION_DISPATCH_STATUS="error"
          ACTION_DISPATCH_MESSAGE="Webhook action requires an https URL."
          write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
          return 1
          ;;
      esac
      if ! webhook_host="$(webhook_destination_host "$ACTION_WEBHOOK_URL" 2>/dev/null)"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Webhook action URL is invalid."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if is_low_quality_completion "$preview"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Webhook payload looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      # 2026-07-15 P1 audit fix: the ABOVE check only covers $preview (the
      # first MAX_RESULT_CARRY_CHARS bytes, see clean_result_preview) — the
      # webhook body's "result" field ships the FULL cleaned content, so a bad
      # completion appearing only past that truncation point must be caught
      # too, or the quality gate could pass on a short clean-looking preview
      # while the actual dispatched body differs. Compute the full
      # telemetry-stripped + secret-redacted text ONCE here, gate on it, and
      # reuse the same file for write_webhook_payload below (no second pass).
      webhook_clean_result="$LOG_DIR/webhook-result-clean-$(date +%s)-$$.txt"
      clean_result_full "$result_file" "$webhook_clean_result"
      if is_low_quality_completion_file "$webhook_clean_result"; then
        rm -f "$webhook_clean_result"
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Webhook payload looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      webhook_payload="$LOG_DIR/webhook-payload-$(date +%s).json"
      webhook_response="$LOG_DIR/webhook-response-$(date +%s).txt"
      webhook_error="$LOG_DIR/webhook-error-$(date +%s).txt"
      write_webhook_payload "$webhook_payload" "success" "$preview" "$webhook_clean_result"
      rm -f "$webhook_clean_result"
      webhook_host_allowlisted=false
      if webhook_host_is_allowlisted "$webhook_host"; then webhook_host_allowlisted=true; fi
      request_and_wait_approval "webhook" "$preview" "$result_file" "$webhook_host" "$webhook_payload" "$webhook_host_allowlisted" || return 1
      set +e
      SHELLY_CAP_APPROVED=1 HTTP_TIMEOUT_SECONDS="\${WEBHOOK_TIMEOUT_SECONDS:-30}" http_post_json "$ACTION_WEBHOOK_URL" "$webhook_payload" "$webhook_response" "$webhook_error"
      webhook_rc=$?
      set -e
      if [ "$webhook_rc" -ne 0 ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Webhook dispatch failed with exit $webhook_rc: $(head -c 240 "$webhook_error" 2>/dev/null | tr '\\n' ' ')"
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      ACTION_DISPATCH_MESSAGE="Webhook delivered to $webhook_host"
      return 0
      ;;
    cli)
      if [ -z "$ACTION_COMMAND" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="CLI action is missing a command."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ "\${SHELLY_CAP_EXEC:-0}" = "1" ] && [ "$ACTION_COMMAND_SAFETY_LEVEL" = "CRITICAL" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="CLI action was blocked by command safety: $ACTION_COMMAND_SAFETY_REASON"
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      request_and_wait_approval "cli" "$preview" "$result_file" || return 1
      cli_output="$LOG_DIR/cli-action-output-$(date +%s).txt"
      cli_error="$LOG_DIR/cli-action-error-$(date +%s).txt"
      CLI_EXEC_CWD="\${SHELLY_AGENT_EXEC_CWD:-$PROJECT_DIR}"
      if [ ! -d "$CLI_EXEC_CWD" ]; then
        CLI_EXEC_CWD="$HOME/agent-output"
        mkdir -p "$CLI_EXEC_CWD"
      fi
      set +e
      cap_workspace_exec "$ACTION_COMMAND" "$CLI_EXEC_CWD" "$cli_output" "$cli_error"
      cli_rc=$?
      set -e
      if [ -s "$cli_error" ]; then
        {
          printf '\\n[stderr]\\n'
          cat "$cli_error"
        } >> "$cli_output"
      fi
      {
        printf '\\n## CLI action\\n\\n'
        printf 'Safety: %s - %s\\n\\n' "$ACTION_COMMAND_SAFETY_LEVEL" "$ACTION_COMMAND_SAFETY_REASON"
        if [ "\${SHELLY_CAP_EXEC:-0}" = "1" ]; then
          printf 'Cwd: %s\\n\\n' "$CLI_EXEC_CWD"
        fi
        printf 'Command:\\n\\n\`\`\`sh\\n%s\\n\`\`\`\\n\\n' "$ACTION_COMMAND"
        printf 'Exit code: %s\\n\\n' "$cli_rc"
        printf 'Output:\\n\\n\`\`\`text\\n'
        head -c 4000 "$cli_output" 2>/dev/null || true
        printf '\\n\`\`\`\\n'
      } >> "$result_file"
      if [ "$cli_rc" -ne 0 ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="CLI action failed with exit $cli_rc."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      ACTION_DISPATCH_MESSAGE="CLI action completed."
      return 0
      ;;
    intent)
      if [ "\${AGENT_AUTONOMOUS:-0}" = "1" ] || [ "\${SHELLY_RUN_UNATTENDED:-0}" = "1" ]; then
        ACTION_DISPATCH_STATUS="skipped"
        ACTION_DISPATCH_MESSAGE="Intent actions require an attended Review."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ -z "$ACTION_INTENT_MODE" ] || { [ "$ACTION_INTENT_MODE" != "launch" ] && [ "$ACTION_INTENT_MODE" != "share" ]; }; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Intent action has an invalid mode."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ "$ACTION_INTENT_MODE" = "launch" ] && [ -z "$ACTION_INTENT_TARGET" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Intent action is missing a launch target."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ "$ACTION_INTENT_MODE" = "share" ] && [ -z "$ACTION_INTENT_SHARE_TEXT" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Intent action is missing share text."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      request_and_wait_approval "intent" "$preview" "$result_file" || return 1
      # No broker/native call here (unlike webhook/cli): RN already fired the
      # intent NATIVELY (fireAgentIntent) BEFORE writing the accept reply that
      # wait_action_approval just observed. Nothing left to execute.
      ACTION_DISPATCH_MESSAGE="Intent fired: $ACTION_INTENT_MODE $ACTION_INTENT_TARGET"
      return 0
      ;;
    dm-reply)
      if [ "\${AGENT_AUTONOMOUS:-0}" = "1" ] || [ "\${SHELLY_RUN_UNATTENDED:-0}" = "1" ]; then
        ACTION_DISPATCH_STATUS="skipped"
        ACTION_DISPATCH_MESSAGE="DM-reply actions require an attended Review."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ -z "$ACTION_DM_PAIRING_ID" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="DM-reply action is missing a paired conversation."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      set +e
      dm_lookup_output="$(dm_pairing_lookup "$DM_PAIRINGS_FILE" "$ACTION_DM_PAIRING_ID")"
      dm_lookup_rc=$?
      set -e
      if [ "$dm_lookup_rc" -eq 1 ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="DM-reply target is no longer paired."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ "$dm_lookup_rc" -ne 0 ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="Could not verify the DM-reply pairing."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      ACTION_DM_PAIRING_REVOKED="\${dm_lookup_output%%$'\\t'*}"
      ACTION_DM_PAIRING_LABEL="\${dm_lookup_output#*$'\\t'}"
      if [ "$ACTION_DM_PAIRING_REVOKED" = "1" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="DM-reply target is no longer paired."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if is_low_quality_completion "$preview"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="DM-reply content looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      request_and_wait_approval "dm-reply" "$preview" "$result_file" || return 1
      # RN sends natively before publishing the accept reply. There is no
      # post-approval broker or shell side effect here.
      ACTION_DISPATCH_MESSAGE="DM reply sent."
      return 0
      ;;
    app-act)
      # app-act is the first agent action that can publish content to an
      # external, human-facing surface (e.g. a public X post) rather than a
      # private draft/notification. store/types.ts documents app-act as
      # Tier-B/unattended-capable (its recipe+target+params are fixed and
      # consented to once at registration time, unlike intent/dm-reply's
      # runtime-resolved targets) -- resolved 2026-07-14 per
      # docs/superpowers/DEFERRED.md's design: the unattended-allow is gated
      # SOLELY on ACTION_APP_ACT_AUTO_FIRE_TRUSTED (agent.autonomous===true,
      # baked at script-generation time — see generateRunScript; widened
      # 2026-07-14 to drop the tool.type==='local' restriction per project
      # owner directive, chat-confirmed consent is the boundary regardless of
      # tool backend), the SAME registration-time consent draft/notify's
      # existing native fast-path already requires. It is NOT governed by
      # ACTION_APPROVAL_MODE (the blanket approval-tap default) — a wrong
      # external post is not equivalent in risk to a local draft/CLI call, so
      # flipping the global "skip the tap" setting alone must never unlock
      # this. When trusted, native (AgentRuntime.kt's action-approval
      # notifier) fires AppActExecutor directly and writes an auto reply, so
      # this still goes through the ordinary write+wait below — only WHO
      # resolves the approval changes, not whether one is required.
      if { [ "\${AGENT_AUTONOMOUS:-0}" = "1" ] || [ "\${SHELLY_RUN_UNATTENDED:-0}" = "1" ]; } && [ "$ACTION_APP_ACT_AUTO_FIRE_TRUSTED" != "1" ]; then
        ACTION_DISPATCH_STATUS="skipped"
        ACTION_DISPATCH_MESSAGE="App-action actions require an attended Review."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if [ -z "$ACTION_APP_ACT_RECIPE_ID" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="App-action is missing a recipe."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      app_act_params_check=$(resolve_app_act_params "$ACTION_APP_ACT_PARAMS_JSON" "$preview")
      if [ -z "$app_act_params_check" ] || [ "$app_act_params_check" = "{}" ]; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="App-action is missing its recipe parameters."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      if is_low_quality_completion "$preview"; then
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="App-action content looks like a prompt echo or AI refusal, not real content — escalating."
        write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
        return 1
      fi
      request_and_wait_approval "app-act" "$preview" "$result_file" || return 1
      # No broker/native call here (mirrors intent/dm-reply): RN or, for a
      # trusted unattended fire, native itself already fired the recipe
      # (fireAgentAppAct / AgentActionApprovalBridge's auto-fire, driving
      # ShellyAccessibilityService via AppActExecutor) BEFORE writing the
      # accept reply that wait_action_approval just observed. Nothing left
      # to execute.
      ACTION_DISPATCH_MESSAGE="App action fired: $ACTION_APP_ACT_RECIPE_ID"
      return 0
      ;;
    social-post)
      # social-post (2026-07-22): API auto-post via a registered connector —
      # the free-API alternative to app-act's AccessibilityService route.
      # Approval tier: a NON-allowlisted destination host requires a human
      # approval tap EVERY time, regardless of ACTION_APPROVAL_MODE (these
      # connectors carry account-level credentials — WordPress app passwords,
      # Mastodon/Misskey access tokens — so a wrong external post is not
      # equivalent in risk to a local draft). Only a host the user explicitly
      # opted into SHELLY_SOCIAL_HOST_ALLOWLIST (the social twin of
      # SHELLY_WEBHOOK_HOST_ALLOWLIST, synced via ~/.shelly/agents/.env) takes
      # the ordinary request_and_wait_approval path, where 'auto' mode may
      # dispatch silently unattended. On an unattended run with nobody to tap,
      # the non-allowlisted write+wait times out → fail-closed skip.
      if [ -z "$ACTION_SOCIAL_PLATFORM" ] || [ -z "$ACTION_SOCIAL_CONNECTOR_ID" ] || [ -z "$ACTION_SOCIAL_ENV_PREFIX" ]; then
        social_post_error "Social-post action is missing its platform or connector."
        return 1
      fi
      social_host="$(social_connector_env HOST | tr '[:upper:]' '[:lower:]')"
      case "$social_host" in
        ''|*[!a-z0-9.-]*)
          social_post_error "Social-post connector host is missing or invalid. Re-register the connector in Settings."
          return 1
          ;;
      esac
      if is_low_quality_completion "$preview"; then
        social_post_error "Social-post content looks like a prompt echo or AI refusal, not real content — escalating."
        return 1
      fi
      social_text_resolved="\${ACTION_SOCIAL_TEXT//\\{\\{result\\}\\}/$preview}"
      if [ -z "$social_text_resolved" ]; then
        social_post_error "Social-post action resolved to empty text."
        return 1
      fi
      # Approval payload: platform/host/text only — NEVER a secret. Bodies
      # that must carry a credential (misskey's "i", telegram's URL token) are
      # composed post-approval inside dispatch_social_post.
      social_payload="$LOG_DIR/social-post-payload-$(date +%s).json"
      social_text_resolved_json=$(json_escape_text "$social_text_resolved")
      social_platform_json=$(json_escape_text "$ACTION_SOCIAL_PLATFORM")
      social_host_json=$(json_escape_text "$social_host")
      printf '{"platform":"%s","host":"%s","text":"%s"}' "$social_platform_json" "$social_host_json" "$social_text_resolved_json" > "$social_payload"
      social_host_allowlisted=false
      if social_host_is_allowlisted "$social_host"; then social_host_allowlisted=true; fi
      if [ "$social_host_allowlisted" = "true" ]; then
        request_and_wait_approval "social-post" "$preview" "$result_file" "$social_host" "$social_payload" "$social_host_allowlisted" || return 1
      else
        write_action_approval_request "social-post" "$preview" "$result_file" "$social_host" "$social_payload" "$social_host_allowlisted"
        wait_action_approval "social-post" || return 1
      fi
      dispatch_social_post "$social_host" "$social_text_resolved" || return 1
      ACTION_DISPATCH_MESSAGE="Posted to $ACTION_SOCIAL_PLATFORM ($social_host)"
      write_native_notification_request "success" "$ACTION_DISPATCH_MESSAGE: $preview" || true
      return 0
      ;;
    *)
      ACTION_DISPATCH_STATUS="error"
      ACTION_DISPATCH_MESSAGE="Unknown agent action: $ACTION_TYPE"
      write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true
      return 1
      ;;
  esac
}

http_post_json() {
  url="$1"
  body_file="$2"
  out_file="$3"
  err_file="$4"
  # CAP-001/SECRET-001/HTTP-001 strangler seam. When SHELLY_CAP_BROKER=1, route
  # the send through the capability broker: it enforces the egress allowlist,
  # resolves an opaque \${SHELLY_CAP_AUTH_REF} to a real auth header by reading
  # \$ENV_FILE ITSELF (so no raw "Bearer \$KEY" is built in this shell), caps the
  # run's egress budget, and appends a redacted audit line. Flag defaults off, so
  # the live path below is unchanged unless a device operator opts in.
  # 2026-07-17 follow-up: also passes the ACTION_APPROVAL_* dir/timeout +
  # AGENT_ID/AGENT_NAME/ACTION_RUN_ID the broker needs to offer a mid-run
  # human approval (Allow/Deny) for a non-allowlisted host instead of failing
  # closed immediately — see requestHostApproval in
  # scripts/shelly-capability-broker.js. Reuses the SAME
  # ACTION_APPROVAL_DIR/ACTION_APPROVAL_REPLY_DIR the action-approval flow
  # already writes into (distinguished by filename prefix "cap-" vs "action-"
  # and by a "type":"cap-broker-host" field in the JSON body), not a new
  # directory, so there is only one place a native watcher needs to poll.
  if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then
    shelly_node "$HOME/.shelly-capability-broker.js" \\
      --method POST --url "$url" --body-file "$body_file" \\
      --auth-ref "\${SHELLY_CAP_AUTH_REF:-}" --tainted "\${SHELLY_CAP_TAINTED:-0}" --approved "\${SHELLY_CAP_APPROVED:-0}" \\
      --secret-env-file "$ENV_FILE" \\
      --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
      --budget-file "$TMP_DIR/cap-budget-$AGENT_ID.json" \\
      --timeout-seconds "\${HTTP_TIMEOUT_SECONDS:-30}" \\
      --approval-dir "$ACTION_APPROVAL_DIR" --approval-reply-dir "$ACTION_APPROVAL_REPLY_DIR" \\
      --agent-id "$AGENT_ID" --agent-name "$AGENT_NAME" --run-id "$ACTION_RUN_ID" \\
      --approval-timeout-seconds "$ACTION_APPROVAL_TIMEOUT_SECONDS" \\
      --header-file "\${SHELLY_CAP_HEADER_FILE:-}" \\
      --out "$out_file" --err "$err_file"
    return $?
  fi
  # Fail-closed: if the broker was REQUESTED (flag on) but is unavailable (node
  # unusable or the asset failed to extract), do NOT silently fall through to the
  # legacy path — in broker mode the call site set SHELLY_CAP_AUTH_REF but no raw
  # auth header, so the legacy send would go out unauthenticated. Refuse instead.
  if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ]; then
    echo "capability broker requested (SHELLY_CAP_BROKER=1) but unavailable; refusing to send unbrokered." > "$err_file"
    return 44
  fi
  if node_usable; then
    shelly_node - "$url" "$body_file" > "$out_file" 2> "$err_file" <<'NODEEOF'
const fs = require('fs');
const http = require('http');
const https = require('https');

const [urlText, bodyFile] = process.argv.slice(2);
const body = fs.readFileSync(bodyFile);
const url = new URL(urlText);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;
const timeoutSeconds = Number(process.env.HTTP_TIMEOUT_SECONDS || '0');
const headers = {
  'Content-Type': 'application/json',
  'Content-Length': String(body.length),
};
if (process.env.HTTP_AUTH_HEADER) {
  headers.Authorization = process.env.HTTP_AUTH_HEADER;
}
if (process.env.HTTP_EXTRA_HEADERS) {
  for (const line of process.env.HTTP_EXTRA_HEADERS.split('\\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
}

const req = client.request({
  method: 'POST',
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
  headers,
}, (res) => {
  res.setEncoding('utf8');
  res.on('data', (chunk) => process.stdout.write(chunk));
  res.on('end', () => {
    const code = res.statusCode || 0;
    if (code < 400) {
      process.exitCode = 0;            // success (2xx/3xx)
    } else if (code === 429 || code >= 500) {
      process.exitCode = 23;           // transient: rate-limited / server overloaded
    } else {
      process.exitCode = 22;           // permanent: other 4xx (bad request, auth, etc.)
    }
  });
});

req.on('error', (err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 23;               // network/DNS/reset → treat as transient (retryable)
});
if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
  req.setTimeout(timeoutSeconds * 1000, () => {
    req.destroy(new Error('request timed out'));
  });
}
req.write(body);
req.end();
NODEEOF
    return $?
  fi

  echo "No HTTP client available: node is missing or unavailable." > "$err_file"
  return 127
}

# Wraps http_post_json with bounded retry on transient failures (exit 23 =
# HTTP 429 / 5xx / network error / timeout). Permanent failures (exit 22 =
# other 4xx) and success (0) return immediately — no point retrying a 400/401.
# Up to 3 attempts total, sleeping 2s then 4s between them (no sleep after the
# final attempt), so a brief upstream overload (e.g. Gemini "503 high demand,
# UNAVAILABLE") rides through unattended without a long stall.
http_post_json_retry() {
  _hpr_url="$1"
  _hpr_body="$2"
  _hpr_out="$3"
  _hpr_err="$4"
  _hpr_attempt=1
  _hpr_max=3
  _hpr_delay=2
  while : ; do
    http_post_json "$_hpr_url" "$_hpr_body" "$_hpr_out" "$_hpr_err"
    _hpr_rc=$?
    if [ "$_hpr_rc" -ne 23 ]; then
      return $_hpr_rc
    fi
    if [ "$_hpr_attempt" -ge "$_hpr_max" ]; then
      return 23
    fi
    echo "[Shelly] transient HTTP failure (attempt $_hpr_attempt/$_hpr_max), retrying in \${_hpr_delay}s..." >> "$_hpr_err"
    sleep "$_hpr_delay"
    _hpr_attempt=$((_hpr_attempt + 1))
    _hpr_delay=$((_hpr_delay * 2))
  done
}

# Records a backend failure. Always touches BACKEND_ERROR_FILE so the run is not
# finalized as success; additionally touches TRANSIENT_ERROR_FILE when the HTTP
# exit code is 23 (429 / 5xx / network / timeout, after retry) so the run is
# reported as 'unavailable' rather than a hard 'error'.
mark_http_failure() {
  touch "$BACKEND_ERROR_FILE"
  if [ "\${1:-0}" -eq 23 ]; then
    touch "$TRANSIENT_ERROR_FILE"
  fi
}

http_get_ok() {
  url="$1"
  err_file="$2"
  timeout_seconds="\${3:-5}"
  if node_usable; then
    HTTP_TIMEOUT_SECONDS="$timeout_seconds" shelly_node - "$url" > /dev/null 2> "$err_file" <<'NODEEOF'
const http = require('http');
const https = require('https');

const url = new URL(process.argv[2]);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;
const timeoutSeconds = Number(process.env.HTTP_TIMEOUT_SECONDS || '5');

const req = client.request({
  method: 'GET',
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
}, (res) => {
  res.resume();
  res.on('end', () => {
    process.exitCode = res.statusCode && res.statusCode < 500 ? 0 : 22;
  });
});

req.on('error', (err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
req.setTimeout(timeoutSeconds * 1000, () => {
  req.destroy(new Error('request timed out'));
});
req.end();
NODEEOF
    return $?
  fi

  echo "No HTTP client available: node is missing or unavailable." > "$err_file"
  return 127
}

http_get_text() {
  url="$1"
  out_file="$2"
  err_file="$3"
  timeout_seconds="\${4:-5}"
  if node_usable; then
    HTTP_TIMEOUT_SECONDS="$timeout_seconds" shelly_node - "$url" > "$out_file" 2> "$err_file" <<'NODEEOF'
const http = require('http');
const https = require('https');

const url = new URL(process.argv[2]);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;
const timeoutSeconds = Number(process.env.HTTP_TIMEOUT_SECONDS || '5');

const req = client.request({
  method: 'GET',
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
}, (res) => {
  res.setEncoding('utf8');
  res.on('data', (chunk) => process.stdout.write(chunk));
  res.on('end', () => {
    process.exitCode = res.statusCode && res.statusCode < 500 ? 0 : 22;
  });
});

req.on('error', (err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
req.setTimeout(timeoutSeconds * 1000, () => {
  req.destroy(new Error('request timed out'));
});
req.end();
NODEEOF
    return $?
  fi

  echo "No HTTP client available: node is missing or unavailable." > "$err_file"
  return 127
}

local_llm_is_loopback_url() {
  case "$1" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

local_llm_ready() {
  base_url="$1"
  timeout_seconds="\${2:-5}"
  err_file="\${3:-$TMP_DIR/local-llm-ready.err}"
  http_get_ok "\${base_url%/}/health" "$err_file" "$timeout_seconds" && return 0
  http_get_ok "\${base_url%/}/v1/models" "$err_file" "$timeout_seconds" && return 0
  return 1
}

local_llm_server_matches_model() {
  base_url="$1"
  expected_model="$2"
  timeout_seconds="\${3:-5}"
  err_file="\${4:-$TMP_DIR/local-llm-models.err}"
  out_file="$TMP_DIR/local-llm-models-$AGENT_ID.json"
  [ -n "$expected_model" ] || return 1
  if ! http_get_text "\${base_url%/}/v1/models" "$out_file" "$err_file" "$timeout_seconds"; then
    return 1
  fi
  EXPECTED_MODEL="$expected_model" shelly_node - "$out_file" <<'NODEEOF'
const fs = require('fs');

function normalize(value) {
  const base = String(value || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const expected = normalize(process.env.EXPECTED_MODEL);
if (!expected) process.exit(1);

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (_) {
  process.exit(1);
}

const ids = [];
if (Array.isArray(parsed?.data)) {
  for (const item of parsed.data) {
    if (item?.id) ids.push(item.id);
    if (item?.root) ids.push(item.root);
    if (item?.name) ids.push(item.name);
  }
}
if (parsed?.model) ids.push(parsed.model);

const ok = ids
  .map(normalize)
  .filter(Boolean)
  .some((id) => id === expected);
process.exit(ok ? 0 : 1);
NODEEOF
}

local_llm_port() {
  base_url="$1"
  port=$(printf '%s\\n' "$base_url" | sed -n 's#^http://127\\.0\\.0\\.1:\\([0-9][0-9]*\\).*#\\1#p; s#^http://localhost:\\([0-9][0-9]*\\).*#\\1#p' | head -n 1)
  printf '%s' "\${port:-8080}"
}

local_llm_touch_activity() {
  activity_file="\${LLAMA_SERVER_ACTIVITY:-$HOME/models/llama-server.activity}"
  mkdir -p "$(dirname "$activity_file")" 2>/dev/null || true
  touch "$activity_file" 2>/dev/null || true
}

local_llm_start_activity_heartbeat() {
  interval="\${1:-10}"
  case "$interval" in ''|*[!0-9]*) interval=10 ;; esac
  active_dir="\${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  mkdir -p "$active_dir" 2>/dev/null || true
  LOCAL_LLM_ACTIVE_MARKER="$active_dir/agent-$AGENT_ID-$$-$RANDOM.active"
  : > "$LOCAL_LLM_ACTIVE_MARKER" 2>/dev/null || true
  local_llm_touch_activity
  (
    parent_pid=$$
    trap 'rm -f "$LOCAL_LLM_ACTIVE_MARKER" 2>/dev/null || true' EXIT INT TERM
    while kill -0 "$parent_pid" 2>/dev/null; do
      touch "$LOCAL_LLM_ACTIVE_MARKER" 2>/dev/null || true
      local_llm_touch_activity
      sleep "$interval"
    done
  ) >/dev/null 2>&1 &
  LOCAL_LLM_HEARTBEAT_PID=$!
}

local_llm_stop_activity_heartbeat() {
  heartbeat_pid="\${1:-\${LOCAL_LLM_HEARTBEAT_PID:-}}"
  active_marker="\${2:-\${LOCAL_LLM_ACTIVE_MARKER:-}}"
  if [ -n "$heartbeat_pid" ] && kill -0 "$heartbeat_pid" 2>/dev/null; then
    kill "$heartbeat_pid" 2>/dev/null || true
  fi
  [ -n "$active_marker" ] && rm -f "$active_marker" 2>/dev/null || true
  LOCAL_LLM_HEARTBEAT_PID=""
  LOCAL_LLM_ACTIVE_MARKER=""
  local_llm_touch_activity
}

local_llm_cleanup_stale_active_users() {
  active_dir="\${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  [ -d "$active_dir" ] || return 0
  find "$active_dir" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true
}

local_llm_wait_for_no_active_users() {
  active_dir="\${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  wait_seconds="\${LOCAL_LLM_RESTART_WAIT_SECONDS:-120}"
  case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=0 ;; esac
  [ "$wait_seconds" -gt 0 ] || return 0
  [ -d "$active_dir" ] || return 0
  _wait_i=0
  while [ "$_wait_i" -lt "$wait_seconds" ]; do
    local_llm_cleanup_stale_active_users
    active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
    [ "\${active_count:-0}" = "0" ] && return 0
    sleep 1
    _wait_i=$((_wait_i + 1))
  done
  local_llm_cleanup_stale_active_users
  active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "\${active_count:-0}" != "0" ]; then
    return 1
  fi
  return 0
}

local_llm_runtime_profile() {
  model_name="$(printf '%s' "\${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$model_name" in
    *0.8b*|*0-8b*) printf '8192 2 1800\\n' ;;
    *1.7b*|*1-7b*) printf '8192 3 1800\\n' ;;
    *2b*) printf '8192 4 1800\\n' ;;
    *4b*) printf '4096 4 900\\n' ;;
    *9b*|*8b*) printf '4096 3 600\\n' ;;
    *) printf '4096 3 900\\n' ;;
  esac
}

local_llm_stop_watcher() {
  watcher_pid_file="\${LLAMA_SERVER_WATCHER_PID:-$HOME/models/llama-server-watcher.pid}"
  if [ -f "$watcher_pid_file" ]; then
    watcher_pid="$(cat "$watcher_pid_file" 2>/dev/null || true)"
    if [ -n "$watcher_pid" ] && kill -0 "$watcher_pid" 2>/dev/null; then
      kill "$watcher_pid" 2>/dev/null || true
    fi
    rm -f "$watcher_pid_file"
  fi
}

local_llm_stop_server() {
  pid_file="\${1:-$HOME/models/llama-server.pid}"
  local_llm_wait_for_no_active_users || return 1
  local_llm_stop_watcher
  if [ -f "$pid_file" ]; then
    server_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
      kill "$server_pid" 2>/dev/null || true
      sleep 1
      kill -0 "$server_pid" 2>/dev/null && kill -9 "$server_pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  old_pid="$(ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | awk '{print $2}' | head -n1)"
  if [ -n "$old_pid" ]; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
    kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null || true
  fi
}

local_llm_start_idle_watcher() {
  server_pid="$1"
  idle_timeout="$2"
  pid_file="$3"
  log_file="$4"
  activity_file="\${LLAMA_SERVER_ACTIVITY:-$HOME/models/llama-server.activity}"
  active_dir="\${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  watcher_pid_file="\${LLAMA_SERVER_WATCHER_PID:-$HOME/models/llama-server-watcher.pid}"
  case "$idle_timeout" in ''|*[!0-9]*) idle_timeout=0 ;; esac
  [ "$idle_timeout" -gt 0 ] || return 0
  local_llm_touch_activity
  (
    while kill -0 "$server_pid" 2>/dev/null; do
      find "$active_dir" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true
      active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
      if [ "\${active_count:-0}" != "0" ]; then
        sleep 15
        continue
      fi
      now="$(date +%s)"
      last="$(stat -c %Y "$activity_file" 2>/dev/null || echo "$now")"
      case "$last" in ''|*[!0-9]*) last="$now" ;; esac
      if [ $((now - last)) -ge "$idle_timeout" ]; then
        echo "llama-server idle timeout after $idle_timeout seconds" >> "$log_file" 2>/dev/null || true
        kill "$server_pid" 2>/dev/null || true
        sleep 1
        kill -0 "$server_pid" 2>/dev/null && kill -9 "$server_pid" 2>/dev/null || true
        rm -f "$pid_file"
        break
      fi
      sleep 15
    done
  ) >/dev/null 2>&1 &
  echo $! > "$watcher_pid_file"
}

find_llama_server_bin() {
  if [ -n "\${LLAMA_SERVER_BIN:-}" ] && [ -x "$LLAMA_SERVER_BIN" ]; then
    printf '%s\\n' "$LLAMA_SERVER_BIN"
    return 0
  fi
  # T3: prefer the app-installed REAL ELF via its .realpath metadata. The
  # $HOME/.local/bin/llama-server entry is a wrapper SCRIPT (not an ELF), so the
  # linker64 launch below needs the real binary; direct-exec of the wrapper in
  # the agent's exec context fails to resolve shared libs (cold-start blocker C).
  if [ -s "$HOME/.local/bin/llama-server.realpath" ]; then
    _real_bin="$(cat "$HOME/.local/bin/llama-server.realpath" 2>/dev/null || true)"
    if [ -x "$_real_bin" ]; then
      printf '%s\\n' "$_real_bin"
      return 0
    fi
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return 0
  fi
  for candidate in "$HOME/.local/bin/llama-server" "$HOME/bin/llama-server"; do
    if [ -x "$candidate" ]; then
      printf '%s\\n' "$candidate"
      return 0
    fi
  done
  return 1
}

local_llm_normalize_model_token() {
  value="\${1:-}"
  value="\${value##*/}"
  value="\${value%.gguf}"
  printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g'
}

local_llm_path_matches_model() {
  path_token="$(local_llm_normalize_model_token "\${1:-}")"
  model_token="$(local_llm_normalize_model_token "\${2:-}")"
  [ -n "$path_token" ] || return 1
  [ -n "$model_token" ] || return 0
  [ "$path_token" = "$model_token" ] && return 0
  case "$path_token" in *"$model_token"*) return 0 ;; esac
  case "$model_token" in *"$path_token"*) return 0 ;; esac
  return 1
}

download_file_node() {
  url="$1"
  out_file="$2"
  err_file="$3"
  if ! node_usable; then
    echo "node is required for download" > "$err_file"
    return 127
  fi
  shelly_node - "$url" "$out_file" > /dev/null 2> "$err_file" <<'NODEEOF'
const fs = require('fs');
const http = require('http');
const https = require('https');

const [urlText, outFile] = process.argv.slice(2);

function download(urlText, redirects) {
  const url = new URL(urlText);
  const client = url.protocol === 'https:' ? https : http;
  const req = client.get(url, {
    headers: { 'User-Agent': 'Shelly-local-llm-installer/1' },
  }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
      res.resume();
      if (redirects <= 0) {
        console.error('too many redirects');
        process.exit(1);
        return;
      }
      download(new URL(res.headers.location, url).toString(), redirects - 1);
      return;
    }
    if (!res.statusCode || res.statusCode >= 400) {
      console.error('download failed: HTTP ' + res.statusCode);
      res.resume();
      process.exit(1);
      return;
    }
    const tmp = outFile + '.part';
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        fs.renameSync(tmp, outFile);
      });
    });
    file.on('error', (err) => {
      console.error(err && err.message ? err.message : String(err));
      try { fs.unlinkSync(tmp); } catch (_) {}
      process.exit(1);
    });
  });
  req.on('error', (err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
  req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
}

download(urlText, 5);
NODEEOF
}

extract_zip_file() {
  zip_file="$1"
  dest_dir="$2"
  err_file="$3"
  mkdir -p "$dest_dir"
  if command -v unzip >/dev/null 2>&1; then
    unzip -o "$zip_file" -d "$dest_dir" > /dev/null 2> "$err_file"
    return $?
  fi
  if python3_usable; then
    if python3 - "$zip_file" "$dest_dir" > /dev/null 2> "$err_file" <<'PYEOF'
import sys
import zipfile

zip_file, dest_dir = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_file) as z:
    z.extractall(dest_dir)
PYEOF
    then
      return 0
    else
      return $?
    fi
  fi
  echo "unzip or python3 is required to extract llama-server" > "$err_file"
  return 127
}

extract_archive_file() {
  archive_file="$1"
  dest_dir="$2"
  err_file="$3"
  mkdir -p "$dest_dir"
  case "$archive_file" in
    *.zip) extract_zip_file "$archive_file" "$dest_dir" "$err_file"; return $? ;;
  esac
  if command -v tar >/dev/null 2>&1; then
    tar -xzf "$archive_file" -C "$dest_dir" > /dev/null 2> "$err_file"
    return $?
  fi
  if python3_usable; then
    if python3 - "$archive_file" "$dest_dir" > /dev/null 2> "$err_file" <<'PYEOF'
import sys
import tarfile

archive_file, dest_dir = sys.argv[1], sys.argv[2]
with tarfile.open(archive_file, "r:*") as t:
    t.extractall(dest_dir)
PYEOF
    then
      return 0
    else
      return $?
    fi
  fi
  echo "tar or python3 is required to extract llama-server archive" > "$err_file"
  return 127
}

resolve_llama_server_download_url() {
  err_file="$TMP_DIR/llama-server-release-$AGENT_ID.err"
  if [ -n "\${LLAMA_SERVER_DOWNLOAD_URL:-}" ]; then
    printf '%s\\n' "$LLAMA_SERVER_DOWNLOAD_URL"
    return 0
  fi
  if ! node_usable; then
    echo "node is required to resolve latest llama-server release" > "$err_file"
    return 127
  fi
  shelly_node - > "$TMP_DIR/llama-server-url-$AGENT_ID.txt" 2> "$err_file" <<'NODEEOF'
const https = require('https');

const req = https.get('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
  headers: { 'User-Agent': 'Shelly-local-llm-installer/1' },
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    if (!res.statusCode || res.statusCode >= 400) {
      console.error('release lookup failed: HTTP ' + res.statusCode);
      process.exit(1);
      return;
    }
    const release = JSON.parse(body);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => /bin-android-arm64\\.(tar\\.gz|tgz|zip)$/i.test(a.name || ''));
    if (!asset || !asset.browser_download_url) {
      console.error('release lookup failed: android arm64 llama.cpp asset not found');
      process.exit(1);
      return;
    }
    process.stdout.write(asset.browser_download_url);
  });
});
req.setTimeout(8000, () => {
  req.destroy(new Error('release lookup timed out'));
});
req.on('error', (err) => {
  console.error('release lookup failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
NODEEOF
  if [ ! -s "$TMP_DIR/llama-server-url-$AGENT_ID.txt" ]; then
    return 1
  fi
  cat "$TMP_DIR/llama-server-url-$AGENT_ID.txt"
}

install_llama_server_bin() {
  err_file="$TMP_DIR/llama-server-install-$AGENT_ID.err"
  mkdir -p "$HOME/.local/bin" "$TMP_DIR"
  extract_dir="$TMP_DIR/llama-server-android-arm64"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"

  url=$(resolve_llama_server_download_url || true)
  if [ -z "$url" ]; then
    echo "auto-install failed: could not resolve latest Android arm64 llama-server asset: $(head -c 300 "$TMP_DIR/llama-server-release-$AGENT_ID.err" 2>/dev/null | tr '\\n' ' ')"
    return 1
  fi
  case "$url" in
    *.zip) archive_file="$TMP_DIR/llama-server-android-arm64.zip" ;;
    *.tgz) archive_file="$TMP_DIR/llama-server-android-arm64.tgz" ;;
    *) archive_file="$TMP_DIR/llama-server-android-arm64.tar.gz" ;;
  esac
  if ! download_file_node "$url" "$archive_file" "$err_file"; then
    echo "auto-install failed: could not download llama-server from $url: $(head -c 300 "$err_file" 2>/dev/null | tr '\\n' ' ')"
    return 1
  fi
  if ! extract_archive_file "$archive_file" "$extract_dir" "$err_file"; then
    echo "auto-install failed: could not extract llama-server archive: $(head -c 300 "$err_file" 2>/dev/null | tr '\\n' ' ')"
    return 1
  fi

  extracted=$(find "$extract_dir" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  if [ -z "$extracted" ]; then
    echo "auto-install failed: llama-server binary was not found inside downloaded archive"
    return 1
  fi

  install_dir="$HOME/.local/llama.cpp"
  install_tmp="$HOME/.local/llama.cpp.tmp"
  rm -rf "$install_tmp"
  mkdir -p "$install_tmp"
  cp -R "$extract_dir"/. "$install_tmp"/
  installed_binary=$(find "$install_tmp" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  if [ -z "$installed_binary" ]; then
    echo "auto-install failed: llama-server binary disappeared during install copy"
    return 1
  fi
  chmod +x "$installed_binary"
  rm -rf "$install_dir"
  mv "$install_tmp" "$install_dir"
  installed_binary=$(find "$install_dir" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  binary_dir=$(dirname "$installed_binary")
  lib_dirs=$(find "$install_dir" -type f -name '*.so*' -exec dirname {} \\; 2>/dev/null | sort -u | tr '\\n' ':' || true)

cat > "$HOME/.local/bin/llama-server" <<WRAPPEREOF
#!/system/bin/sh
cd "$binary_dir" || exit 1
export LD_LIBRARY_PATH="\${lib_dirs}\${binary_dir}:\${install_dir}:\${install_dir}/lib:\\\${LD_LIBRARY_PATH:-}"
unset LD_PRELOAD
if [ -x /system/bin/linker64 ]; then
  exec /system/bin/linker64 "$installed_binary" "\\$@"
fi
exec "$installed_binary" "\\$@"
WRAPPEREOF
  chmod +x "$HOME/.local/bin/llama-server"
  printf '%s\\n' "$HOME/.local/bin/llama-server"
}

find_local_llm_model() {
  model_name="\${1:-Qwen3.5-0.8B-Q4_K_M}"
  if [ -n "\${LOCAL_LLM_MODEL_PATH:-}" ] &&
    [ -f "$LOCAL_LLM_MODEL_PATH" ] &&
    local_llm_path_matches_model "$LOCAL_LLM_MODEL_PATH" "$model_name"; then
    printf '%s\\n' "$LOCAL_LLM_MODEL_PATH"
    return 0
  fi

  case "$model_name" in
    *.gguf) model_file="$model_name" ;;
    *) model_file="$model_name.gguf" ;;
  esac

  for dir in "$HOME/models" "$HOME" "$HOME/.local/share/shelly/models" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/$model_file" ]; then
      printf '%s\\n' "$dir/$model_file"
      return 0
    fi
  done

  search_pattern='Qwen3.*0[._-]*8B.*Q4_K_M\\|Qwen3.*Q4_K_M.*0[._-]*8B'
  case "$(printf '%s' "$model_name" | tr '[:upper:]' '[:lower:]')" in
    *0.8b*) search_pattern='Qwen3.*0[._-]*8B.*Q4_K_M\\|Qwen3.*Q4_K_M.*0[._-]*8B' ;;
    *1.7b*) search_pattern='Qwen3.*1[._-]*7B.*Q4_K_M\\|Qwen3.*Q4_K_M.*1[._-]*7B' ;;
    *2b*) search_pattern='Qwen3.*2B.*Q4_K_M\\|Qwen3.*Q4_K_M.*2B' ;;
    *8b*) search_pattern='Qwen3.*8B.*Q4_K_M\\|Qwen3.*Q4_K_M.*8B' ;;
    *4b*) search_pattern='Qwen3.*4B.*Q4_K_M\\|Qwen3.*Q4_K_M.*4B' ;;
  esac

  for dir in "$HOME/models" "$HOME" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    found=$(find "$dir" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null | grep -i "$search_pattern" | head -n 1 || true)
    if [ -n "$found" ]; then
      printf '%s\\n' "$found"
      return 0
    fi
  done

  # T1: installed-aware fallback. The requested tier is not present; rather than
  # fail (which blocks ALL autostart — root cause B), use the first installed
  # Qwen Q4_K_M model. llama.cpp serves whatever it loads regardless of the
  # request's model field, and the caller re-derives the alias + readiness check
  # from the returned path, so a tier substitution is safe.
  for dir in "$HOME/models" "$HOME" "$HOME/.local/share/shelly/models" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    found=$(find "$dir" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null | grep -iE 'qwen3?[._-].*q4_k_m' | head -n 1 || true)
    if [ -n "$found" ]; then
      printf '%s\\n' "$found"
      return 0
    fi
  done

  return 1
}

# Remove a stale local-LLM start lock so a lock leaked by a killed starter cannot
# permanently block autostart (root cause A). Stale = holder PID dead, or no live
# holder and older than a short just-created grace window. The lock dir holds
# owner.pid written by the acquirer.
local_llm_clear_stale_start_lock() {
  _ld="$1"
  [ -d "$_ld" ] || return 0
  _owner="$(cat "$_ld/owner.pid" 2>/dev/null || true)"
  if [ -n "$_owner" ] && kill -0 "$_owner" 2>/dev/null; then
    return 0
  fi
  _now="$(date +%s 2>/dev/null || echo 0)"
  _mtime="$(stat -c %Y "$_ld" 2>/dev/null || echo 0)"
  if [ -z "$_owner" ] && [ "$_now" -gt 0 ] && [ "$_mtime" -gt 0 ] && [ "$((_now - _mtime))" -lt 20 ]; then
    return 0
  fi
  rm -rf "$_ld" 2>/dev/null || true
}

ensure_local_llm_server() {
  base_url="$1"
  model_name="\${2:-Qwen3.5-0.8B-Q4_K_M}"
  reason_file="$TMP_DIR/local-llm-start-$AGENT_ID.reason"
  : > "$reason_file"

  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
    # Reuse ANY already-running local server, regardless of which model tier it
    # serves. llama.cpp serves its loaded model irrespective of the request's
    # "model" field, so a mismatch is harmless. Restarting a healthy in-app-started
    # server was the root cause of on-device failures: the in-app "Start" launches
    # llama-server through a linker64 + LLAMA_LIB_PATH wrapper, but the agent's own
    # start exec's the binary directly and cannot relaunch it — so a tier mismatch
    # (scorer wants 0.8B, user has 2B running) made the agent kill the working
    # server and fail to bring it back. Reusing whatever is up is strictly better
    # than a dead server.
    local_llm_touch_activity
    return 0
  fi

  if ! local_llm_is_loopback_url "$base_url"; then
    echo "auto-start skipped: LOCAL_LLM_URL is not loopback ($base_url)" > "$reason_file"
    return 1
  fi
  if [ "\${LOCAL_LLM_AUTOSTART:-1}" = "0" ]; then
    echo "auto-start disabled: LOCAL_LLM_AUTOSTART=0" > "$reason_file"
    return 1
  fi

  lock_dir="$LOCKS_DIR/local-llm-server-start.lock"
  local_llm_clear_stale_start_lock "$lock_dir"
  lock_acquired=0
  _i=0
	while [ "$_i" -lt 30 ]; do
	  if mkdir "$lock_dir" 2>/dev/null; then
	    lock_acquired=1
	    break
	  fi
	  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
	    # Another starter won the race and a server is up — reuse it (any tier; see
	    # the top reuse path). Consistent with not killing a healthy server.
	    local_llm_touch_activity
	    return 0
	  fi
	  sleep 1
	  _i=$((_i + 1))
	done
  if [ "$lock_acquired" != "1" ]; then
    echo "auto-start skipped: could not acquire start lock $lock_dir (held by a live starter)" > "$reason_file"
    return 1
  fi
  echo $$ > "$lock_dir/owner.pid" 2>/dev/null || true

  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
    # Server came up while we held the lock — reuse it (any tier).
    local_llm_touch_activity
    rm -rf "$lock_dir" 2>/dev/null || true
    return 0
  fi

  server_bin=$(find_llama_server_bin || true)
  if [ -z "$server_bin" ]; then
    if [ "\${LOCAL_LLM_INSTALL_LLAMA_SERVER:-0}" != "1" ]; then
      echo "auto-start failed: llama-server binary not found in PATH, $HOME/.local/bin, or $HOME/bin" > "$reason_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 1
    fi
    install_result=$(install_llama_server_bin || true)
    server_bin=$(find_llama_server_bin || true)
    if [ -z "$server_bin" ]; then
      echo "auto-start failed: llama-server binary not found and auto-install did not produce an executable. $install_result" > "$reason_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 1
    fi
  fi

  model_path=$(find_local_llm_model "$model_name" || true)
  if [ -z "$model_path" ]; then
    echo "auto-start failed: GGUF model not found for $model_name. Set LOCAL_LLM_MODEL_PATH or place it under $HOME/models or /sdcard/Download." > "$reason_file"
    rm -rf "$lock_dir" 2>/dev/null || true
    return 1
  fi

  port=$(local_llm_port "$base_url")
  log_file="\${LLAMA_SERVER_LOG:-$HOME/models/llama-server.log}"
  pid_file="\${LLAMA_SERVER_PID:-$HOME/models/llama-server.pid}"
  mkdir -p "$(dirname "$log_file")" "$(dirname "$pid_file")"
  if ! local_llm_stop_server "$pid_file"; then
    echo "auto-start skipped: another local LLM request is still active; refusing to restart llama-server" > "$reason_file"
    rm -rf "$lock_dir" 2>/dev/null || true
    return 1
  fi
  alias_name="\${model_path##*/}"
  alias_name="\${alias_name%.gguf}"
  # T1: if find_local_llm_model fell back to a different installed tier, the
  # readiness check below must match the model we actually load (alias_name),
  # NOT the requested model_name — else the just-started 2B server would be
  # rejected for not being the requested 8B and the start would "time out".
  _req_norm="$(printf '%s' "$model_name" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
  _got_norm="$(printf '%s' "$alias_name" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
  if [ "$_req_norm" != "$_got_norm" ]; then
    echo "note: requested model $model_name is not installed; using installed $alias_name" >> "$reason_file"
  fi
  profile="$(local_llm_runtime_profile "$alias_name")"
  set -- $profile
  default_ctx_size="$1"
  default_threads="$2"
  default_idle_timeout="$3"
  ctx_size="\${LOCAL_LLM_CTX_SIZE:-$default_ctx_size}"
  threads="\${LOCAL_LLM_THREADS:-$default_threads}"
  idle_timeout="\${LOCAL_LLM_IDLE_TIMEOUT_SECONDS:-$default_idle_timeout}"
  local_llm_touch_activity

  # T3: app-installed llama.cpp needs its shared libs on LD_LIBRARY_PATH and a
  # linker64 launch (the same mechanism as the in-app Start). Without it the
  # agent's exec context can't resolve the .so files and cold-start fails
  # (blocker C). Self-contained binaries (PATH / agent-installed wrapper) have an
  # empty llama_lib_path and fall through to a plain exec.
  # The binary's OWN dir holds all its .so files (libggml*, libllama-server-impl,
  # …). Put that absolute dir FIRST on LD_LIBRARY_PATH so lib resolution never
  # depends on the find succeeding in the agent's exec context (where it returned
  # empty, dropping to a libless plain exec → "CANNOT LINK EXECUTABLE … library
  # not found"). The find still contributes any sibling lib dirs. Trigger the
  # linker64 path whenever the binary lives under .local/llama.cpp.
  server_dir="$(dirname "$server_bin")"
  llama_lib_path="$(find "$HOME/.local/llama.cpp" -type f \\( -name '*.so' -o -name '*.so.*' \\) -exec dirname {} \\; 2>/dev/null | sort -u | tr '\\n' ':')"
  use_linker64=0
  case "$server_bin" in "$HOME/.local/llama.cpp"/*) use_linker64=1 ;; esac
  if [ -n "$llama_lib_path" ]; then use_linker64=1; fi
  if [ "$use_linker64" = 1 ] && [ -x /system/bin/linker64 ]; then
    (
      cd "$server_dir" 2>/dev/null || true
      # The agent exec context sets LD_PRELOAD=libexec_wrapper.so (shelly-exec.c);
      # inherited into the linker64 launch it breaks llama-server's own .so
      # resolution ("library libllama-server-impl.so not found"). The in-app Start
      # unsets it for the same reason — mirror that.
      unset LD_PRELOAD
      export LD_LIBRARY_PATH="$server_dir:\${llama_lib_path}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
      nohup /system/bin/nice -n 5 /system/bin/linker64 "$server_bin" --model "$model_path" --alias "$alias_name" --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --threads "$threads" --log-disable \${LLAMA_SERVER_EXTRA_ARGS:-} > "$log_file" 2>&1 &
      echo $! > "$pid_file"
    )
  else
    nohup /system/bin/nice -n 5 "$server_bin" --model "$model_path" --alias "$alias_name" --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --threads "$threads" --log-disable \${LLAMA_SERVER_EXTRA_ARGS:-} > "$log_file" 2>&1 &
    echo $! > "$pid_file"
  fi

  ready_seconds="\${LOCAL_LLM_START_TIMEOUT_SECONDS:-90}"
  _i=0
  while [ "$_i" -lt "$ready_seconds" ]; do
    if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err" &&
      local_llm_server_matches_model "$base_url" "$alias_name" 3 "$TMP_DIR/local-llm-models-$AGENT_ID.err"; then
      local_llm_touch_activity
      local_llm_start_idle_watcher "$(cat "$pid_file" 2>/dev/null || true)" "$idle_timeout" "$pid_file" "$log_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 0
    fi
    sleep 1
    _i=$((_i + 1))
  done

  {
    echo "auto-start failed: llama-server did not become ready within $ready_seconds seconds"
    echo "server: $server_bin"
    echo "model: $model_path"
    echo "endpoint: $base_url"
    echo "log: $log_file"
    echo "log tail:"
    tail -n 40 "$log_file" 2>/dev/null || true
  } > "$reason_file"
  rm -rf "$lock_dir" 2>/dev/null || true
  return 1
}

extract_ai_content() {
  file="$1"
  if node_usable; then
    if shelly_node - "$file" <<'NODEEOF'
const fs = require('fs');

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
let data;
try {
  data = JSON.parse(text);
} catch (_) {
  process.stdout.write(text);
  process.exit(0);
}

let content;
try {
  content = data?.choices?.[0]?.message?.content;
} catch (_) {}
if (!content) {
  try {
    content = data?.choices?.[0]?.text;
  } catch (_) {}
}
if (!content) {
  // Reasoning models (Qwen3 thinking) may leave message.content empty and put the
  // text in reasoning_content (esp. when truncated at max_tokens). Surface that
  // rather than dumping the raw JSON envelope into the result.
  try {
    content = data?.choices?.[0]?.message?.reasoning_content;
  } catch (_) {}
}
if (!content) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    content = parts.map((part) => part && part.text ? part.text : '').filter(Boolean).join('\\n');
  } catch (_) {}
}

// Perplexity (sonar) returns its source URLs in a SIDECAR field — search_results
// (array of {title,url,date}) or legacy citations (array of url strings) — never
// inline in message.content (which carries only [1][2] markers). Append them as a
// "## Sources" list so the result actually carries the primary-source URLs (the
// collection goal) AND the no-URL guard doesn't false-fire and escalate to Codex.
// Data-driven: other backends lack these keys, so this is a no-op for them.
let sourcesBlock = '';
try {
  const sr = Array.isArray(data && data.search_results) && data.search_results.length ? data.search_results : null;
  const cites = !sr && Array.isArray(data && data.citations) && data.citations.length ? data.citations : null;
  const entries = sr || cites || [];
  const seen = {};
  const lines = [];
  for (const e of entries) {
    if (lines.length >= 20) break;
    const url = typeof e === 'string' ? e : (e && typeof e.url === 'string' ? e.url : '');
    const clean = url.trim().replace(/[).,;]+$/, '');
    const isUrl = clean.slice(0, 7) === 'http://' || clean.slice(0, 8) === 'https://';
    if (!isUrl || seen[clean]) continue;
    seen[clean] = 1;
    const title = (e && typeof e === 'object' && typeof e.title === 'string' && e.title.trim()) ? e.title.trim() : clean;
    lines.push('[' + (lines.length + 1) + '] ' + title + ' — ' + clean);
  }
  if (lines.length) sourcesBlock = '\\n\\n## Sources\\n' + lines.join('\\n');
} catch (_) {}

const err = data?.error || data?.message;
if (content) {
  process.stdout.write(content + sourcesBlock);
} else if (err) {
  process.stdout.write('API error: ' + (typeof err === 'string' ? err : JSON.stringify(err)));
  process.exit(2);
} else {
  process.stdout.write(text);
}
NODEEOF
    then
      return 0
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then
        return 2
      fi
    fi
  fi
  if python3_usable; then
    if python3 - "$file" <<'PYEOF'
import json
import sys

path = sys.argv[1]
text = open(path, "r", encoding="utf-8", errors="replace").read()
try:
    data = json.loads(text)
except Exception:
    sys.stdout.write(text)
    raise SystemExit(0)

content = None
try:
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
except Exception:
    content = None
if not content:
    try:
        content = data.get("choices", [{}])[0].get("text")
    except Exception:
        content = None
if not content:
    try:
        content = data.get("choices", [{}])[0].get("message", {}).get("reasoning_content")
    except Exception:
        content = None
if not content:
    try:
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        content = "\\n".join(part.get("text", "") for part in parts if part.get("text"))
    except Exception:
        content = None

# Perplexity sources live in a sidecar field (search_results / citations), not
# inline in content — mirror the node branch and append them as "## Sources".
sources_block = ""
try:
    entries = None
    sr = data.get("search_results")
    if isinstance(sr, list) and sr:
        entries = sr
    else:
        cites = data.get("citations")
        if isinstance(cites, list) and cites:
            entries = cites
    if entries:
        seen = set()
        lines = []
        for e in entries:
            if len(lines) >= 20:
                break
            if isinstance(e, str):
                url, title = e, None
            elif isinstance(e, dict):
                url, title = e.get("url") or "", e.get("title")
            else:
                continue
            clean = url.strip().rstrip(").,;")
            if not (clean.startswith("http://") or clean.startswith("https://")) or clean in seen:
                continue
            seen.add(clean)
            label = title.strip() if isinstance(title, str) and title.strip() else clean
            lines.append("[" + str(len(lines) + 1) + "] " + label + " — " + clean)
        if lines:
            sources_block = "\\n\\n## Sources\\n" + "\\n".join(lines)
except Exception:
    sources_block = ""

err = data.get("error") or data.get("message")
if content:
    sys.stdout.write(content + sources_block)
elif err:
    sys.stdout.write("API error: " + (err if isinstance(err, str) else json.dumps(err, ensure_ascii=False)))
    raise SystemExit(2)
else:
    sys.stdout.write(text)
PYEOF
    then
      return 0
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then
        return 2
      fi
    fi
  fi
  if grep -q '"error"' "$file" 2>/dev/null; then
    printf 'API error response: '
    head -c 4000 "$file"
    return 2
  fi
  cat "$file"
}
local_context_fallback() {
  local reason="$1"
  echo "# Local Context Fallback"
  echo
  echo "Local LLM was unavailable, so Shelly saved a local-context digest instead of failing silently."
  echo
  echo "- reason: $reason"
  echo "- script version: \${SHELLY_AGENT_SCRIPT_VERSION:-unknown}"
  echo "- auto-install llama-server: \${LOCAL_LLM_INSTALL_LLAMA_SERVER:-0}"
  echo "- expected endpoint: \${LOCAL_URL%/}/v1/chat/completions"
  echo "- expected model: \${LOCAL_MODEL:-unknown}"
  echo "- PATH head: $(printf '%s' "$PATH" | cut -d: -f1-4)"
  echo
  echo "## Candidate Hooks"
  if [ -s "\${LOCAL_CONTEXT_FILE:-}" ]; then
    grep -E '^(###|####|- |[0-9a-f]{7,12} )' "$LOCAL_CONTEXT_FILE" 2>/dev/null | head -n 80 || true
  else
    echo "- No local context file was generated."
  fi
  echo
  echo "## Next Fix"
  echo "Start the same local OpenAI-compatible Qwen server used by the AI pane, or set LOCAL_LLM_URL / LOCAL_LLM_MODEL in ~/.shelly/agents/.env."
}

# Create directories before installing the failure trap so JSON logs have a target.
mkdir -p '${tmpDir}' '${locksDir}' "$LOG_DIR"
trap finish EXIT

# Source environment
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
# Project owner directive 2026-07-14: resolve the global runtime-approval
# default LIVE from the just-sourced .env (settings-store syncs
# SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL on every settings change) so toggling
# it applies to every agent's NEXT run without needing a re-save/re-bake. A
# per-agent override baked at generation time (ACTION_APPROVAL_MODE_OVERRIDE,
# from Agent.requireActionApproval) always wins when set.
if [ -n "$ACTION_APPROVAL_MODE_OVERRIDE" ]; then
  ACTION_APPROVAL_MODE="$ACTION_APPROVAL_MODE_OVERRIDE"
elif [ "\${SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL:-0}" = "1" ]; then
  ACTION_APPROVAL_MODE="manual"
else
  ACTION_APPROVAL_MODE="auto"
fi
${apiKeyEnvScrub}

PROJECT_DIR="\${SHELLY_CONTENT_PROJECT:-$HOME/projects/shelly-content-studio}"
SOURCE_REGISTRY_FILE="\${SOURCE_REGISTRY_FILE:-$PROJECT_DIR/sources/source-registry.tsv}"
mkdir -p "$(dirname "$SOURCE_REGISTRY_FILE")"
touch "$SOURCE_REGISTRY_FILE"
SOURCE_CONTEXT=""
# 2026-07-17 bug fix: a background agent asked to record "the current time"
# hallucinated a plausible-but-wrong 2024 date because no backend's
# model-facing prompt ever carried the real wall-clock date/time — only
# internal bookkeeping (run IDs, log timestamps) used \`date\`. Every backend
# below leads $PROMPT_FILE with this line, BEFORE the agent's own prompt
# (escapedPrompt) and BEFORE $SOURCE_CONTEXT, so a "今日"/"現在時刻"/"now" question
# is grounded in the actual run-time device-local date instead of being
# confabulated. Computed via the shell's own \`date\` (already used elsewhere in
# this script for run IDs/log timestamps) — no hardcoded timezone, whatever
# the device's \`date\` returns is what "today" means here. Every call site
# references it defensively (\${CURRENT_DATETIME_CONTEXT:-}) so a bash fragment
# extracted and run in isolation (see
# __tests__/agent-executor-chain-execution.test.ts's extractChainSnippet,
# which slices the script starting AFTER this preamble) degrades to an empty
# leading line instead of aborting under \`set -u\`.
CURRENT_DATETIME_CONTEXT_WDAY_NUM=$(date +%u 2>/dev/null || echo 0)
case "$CURRENT_DATETIME_CONTEXT_WDAY_NUM" in
  1) CURRENT_DATETIME_CONTEXT_WDAY='月' ;;
  2) CURRENT_DATETIME_CONTEXT_WDAY='火' ;;
  3) CURRENT_DATETIME_CONTEXT_WDAY='水' ;;
  4) CURRENT_DATETIME_CONTEXT_WDAY='木' ;;
  5) CURRENT_DATETIME_CONTEXT_WDAY='金' ;;
  6) CURRENT_DATETIME_CONTEXT_WDAY='土' ;;
  7) CURRENT_DATETIME_CONTEXT_WDAY='日' ;;
  *) CURRENT_DATETIME_CONTEXT_WDAY='?' ;;
esac
CURRENT_DATETIME_CONTEXT="[Current date/time: $(date '+%Y年%m月%d日')(\${CURRENT_DATETIME_CONTEXT_WDAY}) $(date '+%H:%M %Z')]"
# v26 (2026-07-24, device-status context injection): AgentRuntime.kt's
# DeviceStatusBridge refreshes $HOME/.shelly/device-status/*.json (currently
# battery.json only) natively, once per run, BEFORE this script starts —
# see that class's own doc comment for why this is read here with plain
# shell (never a model-proposed command) rather than left for the model to
# fetch itself. Each file is a single-line compact JSON object with its own
# top-level key (e.g. {"battery":{...}}); merged here by stripping each
# file's outer braces and joining with commas — deliberately NOT jq (kept
# dependency-free, mirrors this script's general preference for plain shell
# over an external tool where the format is simple/self-controlled). A
# malformed/unexpected file merges in verbatim rather than aborting — this
# context is advisory, never parsed back out, so a bad file just makes one
# ugly line in the prompt instead of breaking the run.
DEVICE_STATUS_CONTEXT=""
DEVICE_STATUS_DIR="$HOME/.shelly/device-status"
if [ -d "$DEVICE_STATUS_DIR" ]; then
  DEVICE_STATUS_JSON=""
  for f in "$DEVICE_STATUS_DIR"/*.json; do
    [ -f "$f" ] || continue
    DEVICE_STATUS_PART=$(tr -d '\\n' < "$f" 2>/dev/null || true)
    [ -n "$DEVICE_STATUS_PART" ] || continue
    DEVICE_STATUS_INNER="\${DEVICE_STATUS_PART#\\{}"
    DEVICE_STATUS_INNER="\${DEVICE_STATUS_INNER%\\}}"
    if [ -z "$DEVICE_STATUS_JSON" ]; then
      DEVICE_STATUS_JSON="$DEVICE_STATUS_INNER"
    else
      DEVICE_STATUS_JSON="$DEVICE_STATUS_JSON,$DEVICE_STATUS_INNER"
    fi
  done
  if [ -n "$DEVICE_STATUS_JSON" ]; then
    DEVICE_STATUS_CONTEXT="[Device status (read-only, refreshed by Shelly just now — treat as authoritative, do not attempt to re-derive via shell commands): {$DEVICE_STATUS_JSON}]"
  fi
fi
LOCAL_CONTEXT_FILE="$TMP_DIR/local-context-$AGENT_ID.txt"
# Studio context (source-registry dedup + recent drafts + content-studio/Obsidian
# git state) is only built for content-pipeline agents. For ad-hoc @agent tasks
# it would prepend ~20KB of irrelevant tokens and stall the on-device model.
if [ "\${STUDIO_CONTEXT:-0}" = "1" ]; then
  if [ -s "$SOURCE_REGISTRY_FILE" ]; then
    SOURCE_CONTEXT=$(printf '\\n\\nKnown source URLs already used. Avoid duplicates unless essential:\\n'; tail -n 120 "$SOURCE_REGISTRY_FILE" | awk -F '\\t' '{ if ($4 != "") print "- " $4 " (" $1 ", " $2 ")" }')
  fi
  {
    echo
    echo "## Local project context"
    if [ -f "$PROJECT_DIR/AI_CONTEXT.md" ]; then
      echo
      echo "### AI_CONTEXT.md"
      head -c 8000 "$PROJECT_DIR/AI_CONTEXT.md" || true
      echo
    fi
    for dir in "$PROJECT_DIR/drafts/x" "$PROJECT_DIR/sources/x" "$PROJECT_DIR/drafts/articles" "\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}/30_Build_Log" "\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}/90_Log/Agent_Output"; do
      [ -d "$dir" ] || continue
      echo
      echo "### Recent files: $dir"
      find "$dir" -type f -name '*.md' 2>/dev/null | sort | tail -n 6 | while read -r file; do
        echo
        echo "#### $file"
        head -c 3000 "$file" || true
        echo
      done
    done
    for repo in "$HOME/hw" "$HOME/projects/shelly-content-studio"; do
      [ -d "$repo/.git" ] || continue
      echo
      echo "### Recent git log: $repo"
      shelly_git -C "$repo" log --oneline -8 2>/dev/null || true
      echo
      echo "### Current git status: $repo"
      shelly_git -C "$repo" status --short 2>/dev/null || true
    done
  } > "$LOCAL_CONTEXT_FILE"
  if [ -s "$LOCAL_CONTEXT_FILE" ]; then
    SOURCE_CONTEXT="$SOURCE_CONTEXT\\n\\n$(head -c 20000 "$LOCAL_CONTEXT_FILE")"
  fi
fi

# Global concurrency check. NOTE: must NOT use find -exec sh -c with a {} inside
# the sh -c string — Android toybox find does not substitute {} there, so it ran
# cat on a literal "{}" ("cat: {}: No such file or directory") and, under
# set -euo pipefail, aborted the whole run once any .pid lock existed. A
# find | while-read loop substitutes correctly and is abort-safe.
ACTIVE_COUNT=$({ find "$LOCKS_DIR" -name '*.pid' 2>/dev/null || true; } | while IFS= read -r _pidf; do _p="$(cat "$_pidf" 2>/dev/null || true)"; if [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null; then echo 1; fi; done | wc -l | tr -d ' ')
if [ "$ACTIVE_COUNT" -ge "$MAX_CONCURRENT" ]; then
  TS=$(date +%s)
  TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
  cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"skipped","outputPreview":"global concurrency limit reached","durationMs":0,"toolUsed":"$TOOL_LABEL_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
  exit 0
fi

# Chain-level lock check (docs/superpowers/DEFERRED.md "エージェント二重実行
# レース"): an attended multi-step/multi-attempt run
# (lib/agent-manager.ts's runAgentOrchestrated/runEscalatingAttempts) holds
# CHAIN_LOCK_DIR — an mkdir-based directory lock acquired/released from JS,
# spanning ALL of that chain's separate per-step/per-candidate script
# invocations — for as long as it is active. A native AlarmManager fire runs
# this .sh directly and never sets CHAIN_LOCK_NONCE, so it always mismatches
# a live chain and is skipped here exactly like the per-agent LOCK_FILE busy
# case below — closing the window where the on-disk script used to sit
# lock-free between two chain steps. The chain's OWN step/candidate launches
# carry a live-matching CHAIN_LOCK_NONCE: the JS side rotates + immediately
# invalidates this token per attempt (materializeAgentBody bakes + arms the
# next one, disarmChainLockToken in lib/agent-manager.ts invalidates the
# just-finished one) rather than baking one constant value for the whole
# chain, because a chain-lifetime-constant nonce
# would ALSO match a native alarm that happens to read the same still-on-disk
# transient script during the inter-step gap.
if [ -d "$CHAIN_LOCK_DIR" ]; then
  CHAIN_LOCK_LIVE_TOKEN=$(cat "$CHAIN_LOCK_DIR/token" 2>/dev/null || true)
  if [ -z "$CHAIN_LOCK_NONCE" ] || [ -z "$CHAIN_LOCK_LIVE_TOKEN" ] || [ "$CHAIN_LOCK_LIVE_TOKEN" != "$CHAIN_LOCK_NONCE" ]; then
    TS=$(date +%s)
    TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
    cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"skipped","outputPreview":"previous run still active","durationMs":0,"toolUsed":"$TOOL_LABEL_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
    exit 0
  fi
fi

# Per-agent concurrency lock. Hardened (docs/superpowers/DEFERRED.md
# "エージェント二重実行レース"): a bare '[ -f "$LOCK_FILE" ] ... echo $$ >
# "$LOCK_FILE"' is a non-atomic check-then-act — two invocations starting
# within the same instant can both pass the '[ -f ]' check before either
# writes. LOCK_DIR is an mkdir-based atomic gate for that same write, mirroring
# REGISTRY_LOCK's mkdir pattern (register_source_urls() below) — mkdir
# succeeds for exactly one invocation, so only the winner ever reaches
# 'echo $$ > "$LOCK_FILE"'. $LOCK_FILE keeps its exact prior name/content
# format (a bare PID) so ACTIVE_COUNT above and generateStopCommand()
# (lib/agent-executor.ts) are unaffected — only the acquisition GATE is new.
shelly_try_acquire_lock_file() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_FILE"
    return 0
  fi
  return 1
}
if ! shelly_try_acquire_lock_file; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    TS=$(date +%s)
    TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
    cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"skipped","outputPreview":"previous run still active","durationMs":0,"toolUsed":"$TOOL_LABEL_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
    exit 0
  fi
  # Stale (holder's PID is gone, or LOCK_FILE unreadable) — reclaim atomically.
  rm -rf "$LOCK_DIR"
  rm -f "$LOCK_FILE"
  if ! shelly_try_acquire_lock_file; then
    # Lost the race to a third invocation that reclaimed it first — treat the
    # same as busy rather than looping.
    TS=$(date +%s)
    TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
    cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"skipped","outputPreview":"previous run still active","durationMs":0,"toolUsed":"$TOOL_LABEL_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
    exit 0
  fi
fi

# Execute tool
rm -f "$BACKEND_ERROR_FILE" "$TRANSIENT_ERROR_FILE"
# CAP-001: each run opens a fresh egress budget envelope (drop any stale counter).
rm -f "$TMP_DIR/cap-budget-$AGENT_ID.json"
${toolCommand}

# Check result
END_TIME=$(date +%s)
DURATION=$(( (END_TIME - START_TIME) * 1000 ))

if [ -f "$RESULT_CONTENT_FILE" ] && [ -s "$RESULT_CONTENT_FILE" ] && [ ! -f "$BACKEND_ERROR_FILE" ]; then
  # G6 char-limit guarantee (2026-07-15 P1 audit fix): clamp the raw result to
  # RESULT_CHAR_LIMIT (0 = no limit configured) BEFORE anything derives from
  # it — preview, webhook body, app-act/{{result}} substitution, draft save —
  # so a multi-step chain's final "re-summarize within N chars for X" step
  # actually enforces that budget here, not just as a soft prompt instruction.
  # Mirrors scripts/shelly-plan-executor.js's own ordering (enforcePlanCharLimit
  # runs before dispatchActionTrusted). Operates on RESULT_CONTENT_FILE (not
  # the raw RESULT_FILE) so a Codex-driver step's real answer text
  # ($RESULT_FILE.answer) is what gets clamped for a codex-routed step — the
  # raw RESULT_FILE stays the untouched telemetry stream either way.
  if [ -n "$RESULT_CHAR_LIMIT" ] && [ "$RESULT_CHAR_LIMIT" -gt 0 ] 2>/dev/null; then
    charlimit_tmp="$RESULT_CONTENT_FILE.charlimit"
    if enforce_char_limit_text "$RESULT_CONTENT_FILE" "$RESULT_CHAR_LIMIT" > "$charlimit_tmp" 2>/dev/null; then
      mv "$charlimit_tmp" "$RESULT_CONTENT_FILE"
    else
      rm -f "$charlimit_tmp"
    fi
  fi
  PREVIEW=$(result_preview "$RESULT_FILE")
  STATUS="success"
  ERROR_MESSAGE=""

${useMultiActions ? `  # Multi-action fan-out (v24, Agent.actions): dispatch EVERY action
  # independently through the SAME dispatch_agent_action() every single-
  # action agent already uses — one call per action, each re-running its own
  # approval/quality-gate/command-safety checks from scratch. A failure in
  # one action must not stop the loop (dispatch_agent_action's return code is
  # captured via "|| ACTION_MULTI_RC=$?", never left bare under set -e).
  ACTION_MULTI_SUCCESS_COUNT=0
  ACTION_MULTI_ERROR_COUNT=0
  ACTION_MULTI_SKIPPED_COUNT=0
  ACTION_RESULTS_PARTS=""
  ACTION_MULTI_IDX=0
  while [ "$ACTION_MULTI_IDX" -lt "$ACTION_MULTI_COUNT" ]; do
    ACTION_TYPE="\${ACTION_MULTI_TYPES[$ACTION_MULTI_IDX]}"
    ACTION_WEBHOOK_URL="\${ACTION_MULTI_WEBHOOK_URLS[$ACTION_MULTI_IDX]}"
    ACTION_COMMAND="\${ACTION_MULTI_COMMANDS[$ACTION_MULTI_IDX]}"
    ACTION_INTENT_MODE="\${ACTION_MULTI_INTENT_MODES[$ACTION_MULTI_IDX]}"
    ACTION_INTENT_TARGET="\${ACTION_MULTI_INTENT_TARGETS[$ACTION_MULTI_IDX]}"
    ACTION_INTENT_SHARE_TEXT="\${ACTION_MULTI_INTENT_SHARE_TEXTS[$ACTION_MULTI_IDX]}"
    ACTION_DM_PAIRING_ID="\${ACTION_MULTI_DM_PAIRING_IDS[$ACTION_MULTI_IDX]}"
    ACTION_DM_REPLY_TEXT="\${ACTION_MULTI_DM_REPLY_TEXTS[$ACTION_MULTI_IDX]}"
    ACTION_DM_PAIRING_LABEL=""
    ACTION_APP_ACT_RECIPE_ID="\${ACTION_MULTI_APP_ACT_RECIPE_IDS[$ACTION_MULTI_IDX]}"
    ACTION_APP_ACT_PARAMS_JSON="\${ACTION_MULTI_APP_ACT_PARAMS_JSONS[$ACTION_MULTI_IDX]}"
    ACTION_SOCIAL_PLATFORM="\${ACTION_MULTI_SOCIAL_PLATFORMS[$ACTION_MULTI_IDX]}"
    ACTION_SOCIAL_CONNECTOR_ID="\${ACTION_MULTI_SOCIAL_CONNECTOR_IDS[$ACTION_MULTI_IDX]}"
    ACTION_SOCIAL_ENV_PREFIX="\${ACTION_MULTI_SOCIAL_ENV_PREFIXES[$ACTION_MULTI_IDX]}"
    ACTION_SOCIAL_TEXT="\${ACTION_MULTI_SOCIAL_TEXTS[$ACTION_MULTI_IDX]}"
    ACTION_COMMAND_SAFETY_LEVEL="\${ACTION_MULTI_COMMAND_SAFETY_LEVELS[$ACTION_MULTI_IDX]}"
    ACTION_COMMAND_SAFETY_REASON="\${ACTION_MULTI_COMMAND_SAFETY_REASONS[$ACTION_MULTI_IDX]}"
    ACTION_COMMAND_AUTO_APPROVABLE="\${ACTION_MULTI_COMMAND_AUTO_APPROVABLES[$ACTION_MULTI_IDX]}"
    # Fresh per-action approval identity: a constant ACTION_RUN_ID across
    # >= 2 dispatches in the same run would (a) let two actions collide on
    # the SAME approval request/reply file path, and (b) make
    # AgentRuntime.kt's approval-notifier "seen" de-dupe treat the second
    # action's approval prompt as already shown for the first, silently
    # dropping it. Appending the loop index guarantees uniqueness even when
    # two actions dispatch within the same wall-clock second under the same pid.
    ACTION_RUN_ID="$AGENT_ID-$(date +%s)-$$-$ACTION_MULTI_IDX"
    ACTION_APPROVAL_REQUEST_FILE="$ACTION_APPROVAL_DIR/action-$ACTION_RUN_ID.json"
    ACTION_APPROVAL_REPLY_FILE="$ACTION_APPROVAL_REPLY_DIR/action-$ACTION_RUN_ID.reply.json"
    ACTION_APPROVAL_REQUEST_SHA256=""

    ACTION_MULTI_RC=0
    dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW" || ACTION_MULTI_RC=$?

    if [ "$ACTION_MULTI_RC" -eq 0 ]; then
      ACTION_RESULT_STATUS="success"
      ACTION_MULTI_SUCCESS_COUNT=$((ACTION_MULTI_SUCCESS_COUNT + 1))
    else
      ACTION_RESULT_STATUS="\${ACTION_DISPATCH_STATUS:-error}"
      case "$ACTION_RESULT_STATUS" in
        skipped) ACTION_MULTI_SKIPPED_COUNT=$((ACTION_MULTI_SKIPPED_COUNT + 1)) ;;
        *) ACTION_RESULT_STATUS="error"; ACTION_MULTI_ERROR_COUNT=$((ACTION_MULTI_ERROR_COUNT + 1)) ;;
      esac
    fi
    ACTION_RESULT_MESSAGE="\${ACTION_DISPATCH_MESSAGE:-}"
    if [ -z "$ACTION_RESULT_MESSAGE" ] && [ "$ACTION_RESULT_STATUS" = "success" ]; then
      ACTION_RESULT_MESSAGE="$PREVIEW"
    fi
    ACTION_TYPE_RESULT_JSON=$(json_escape_text "$ACTION_TYPE")
    ACTION_RESULT_STATUS_JSON=$(json_escape_text "$ACTION_RESULT_STATUS")
    ACTION_RESULT_MESSAGE_JSON=$(json_escape_text "$ACTION_RESULT_MESSAGE")
    ACTION_RESULT_PART="{\\"index\\":$ACTION_MULTI_IDX,\\"actionType\\":\\"$ACTION_TYPE_RESULT_JSON\\",\\"status\\":\\"$ACTION_RESULT_STATUS_JSON\\",\\"message\\":\\"$ACTION_RESULT_MESSAGE_JSON\\"}"
    if [ -z "$ACTION_RESULTS_PARTS" ]; then
      ACTION_RESULTS_PARTS="$ACTION_RESULT_PART"
    else
      ACTION_RESULTS_PARTS="$ACTION_RESULTS_PARTS,$ACTION_RESULT_PART"
    fi
    ACTION_MULTI_IDX=$((ACTION_MULTI_IDX + 1))
  done
  ACTION_RESULTS_JSON="[$ACTION_RESULTS_PARTS]"

  # Partial-success reduction (mirrors AgentRunLog.status's own doc comment,
  # store/types.ts — no new status value, just a precedence order over N
  # independent outcomes): at least one delivered action -> success (a
  # partially-delivered run, e.g. posted to Bluesky but X failed, is still a
  # useful outcome and must not trip the circuit breaker, which only counts
  # 'error'; the granular per-action detail lives in $ACTION_RESULTS_JSON,
  # recorded in the run log below). Zero successes with at least one hard
  # failure -> error. Zero successes and zero failures (every action was
  # gated as "skipped", e.g. intent/dm-reply/app-act on an unattended fire)
  # -> skipped, never silently reported as success.
  if [ "$ACTION_MULTI_SUCCESS_COUNT" -gt 0 ]; then
    STATUS="success"
  elif [ "$ACTION_MULTI_ERROR_COUNT" -gt 0 ]; then
    STATUS="error"
  elif [ "$ACTION_MULTI_SKIPPED_COUNT" -gt 0 ]; then
    STATUS="skipped"
  else
    STATUS="success"
  fi
  ACTION_MULTI_SUMMARY="$ACTION_MULTI_SUCCESS_COUNT/$ACTION_MULTI_COUNT actions delivered"
  if [ "$STATUS" = "success" ]; then
    PREVIEW="$ACTION_MULTI_SUMMARY. $PREVIEW"
    ERROR_MESSAGE=""
  else
    ERROR_MESSAGE="$ACTION_MULTI_SUMMARY."
    PREVIEW="$ERROR_MESSAGE"
  fi
  # Native reads $ACTION_NOTIFY_FILE ONCE, after this whole script process
  # exits (AgentRuntime.kt's postAgentResultNotificationIfRequested) — every
  # per-action write inside dispatch_agent_action above already happened and
  # would otherwise leave only the LAST action's notification visible. This
  # final write deliberately overwrites that with the ONE consolidated
  # outcome for the whole run, exactly mirroring the "last write wins"
  # mechanism the single-action path already relies on.
  write_native_notification_request "$STATUS" "$PREVIEW" || true
` : `  if ! dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW"; then
    STATUS="\${ACTION_DISPATCH_STATUS:-error}"
    ERROR_MESSAGE="\${ACTION_DISPATCH_MESSAGE:-agent action dispatch failed}"
    PREVIEW="$ERROR_MESSAGE"
  fi
`}else
  if [ "$CODEX_RESULT_ACTIVE" = "1" ]; then
    PREVIEW=$(result_preview "$RESULT_FILE")
  elif [ -f "$RESULT_FILE" ] && [ -s "$RESULT_FILE" ]; then
    PREVIEW=$(result_preview "$RESULT_FILE")
  else
    PREVIEW="Agent produced no output. Check backend configuration and required commands. Tool=$TOOL_LABEL PATH=$PATH"
  fi
  ERROR_MESSAGE="$PREVIEW"
  # A purely transient failure (HTTP 429 / 5xx / network) after bounded retry is
  # reported as 'unavailable' — distinct from a real 'error'. The ladder still
  # climbs on it, but the circuit breaker must NOT trip (an overloaded upstream
  # is not the agent misbehaving), and the notification stays truthful.
  if [ -f "$TRANSIENT_ERROR_FILE" ]; then
    STATUS="unavailable"
  else
    STATUS="error"
  fi
  # ③b-2: a NON-final escalation attempt fails silently (no error notification) so
  # the user only sees the final outcome — the next tool's success, or the last
  # tool's failure. The TS run loop sets this for every attempt but the last.
  if [ "\${SUPPRESS_ERROR_NOTIFICATION:-0}" != "1" ]; then
    write_native_notification_request "$STATUS" "$PREVIEW" || true
  fi
fi

# bug #155(b): both branches above (success/failure) have already used
# $PREVIEW for everything that can reach a live external surface — the
# approval-card preview, dispatch_agent_action's quality gate, the webhook
# payload's "preview" field, and (success/notify only) the actual push
# notification body via write_native_notification_request. Amending it here,
# AFTER all of that has already run, means this note can NEVER reach
# resolve_app_act_params's {{result}} substitution (app-act is the one action
# type that splices $preview into a live external post) or any
# already-dispatched notification/webhook content — it only reaches the
# run-log record below (Sidebar's agent detail popup renders outputPreview/
# errorMessage from this same log; also readable directly from
# ~/.shelly/agents/logs/$AGENT_ID/*.json). Prepended (not appended) so it
# survives the UI's 120/160-char inline truncation regardless of how long the
# real result is.
if [ -n "$ORCHESTRATION_COLLAPSED_NOTE" ]; then
  PREVIEW="$ORCHESTRATION_COLLAPSED_NOTE $PREVIEW"
  if [ "$STATUS" != "success" ]; then
    ERROR_MESSAGE="$ORCHESTRATION_COLLAPSED_NOTE $ERROR_MESSAGE"
  fi
fi

# Log run result
TS=$(date +%s)
PREVIEW_JSON=$(json_escape_text "$PREVIEW")
TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
ERROR_MESSAGE_JSON=$(json_escape_text "$ERROR_MESSAGE")
${hasDraftAction ? `
  SAVED_PATH_JSON=$(json_escape_text "\${SAVED_PATH:-}")
  if [ -n "\${SAVED_PATH_MIRROR:-}" ]; then
    SAVED_PATH_MIRROR_JSON=$(json_escape_text "$SAVED_PATH_MIRROR")
    SAVED_PATH_FIELDS=",\"savedPath\":\"$SAVED_PATH_JSON\",\"savedPathMirror\":\"$SAVED_PATH_MIRROR_JSON\""
  elif [ -n "\${SAVED_PATH:-}" ]; then
    SAVED_PATH_FIELDS=",\"savedPath\":\"$SAVED_PATH_JSON\""
  else
    SAVED_PATH_FIELDS=""
  fi
` : 'SAVED_PATH_FIELDS=""'}
${useMultiActions ? 'ACTION_RESULTS_FIELDS=",\\"actionResults\\":$ACTION_RESULTS_JSON"\n' : ''}cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"$STATUS","outputPreview":"$PREVIEW_JSON","durationMs":$DURATION,"toolUsed":"$TOOL_LABEL_JSON","errorMessage":"$ERROR_MESSAGE_JSON","routeDecision":$ROUTE_DECISION_JSON$SAVED_PATH_FIELDS${useMultiActions ? '$ACTION_RESULTS_FIELDS' : ''}}
LOGEOF

# Prune old logs (keep last 30)
ls -t "$LOG_DIR"/*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

# Cleanup temp
rm -f "$RESULT_FILE" "$RESULT_FILE.answer" "$BACKEND_ERROR_FILE"
finish 0
`;
}

/**
 * Fail-closed script for an autonomous agent whose tool has no autonomous form
 * (an api-key backend — no key allowed in the autonomous path). Records the
 * refusal and exits non-zero so the run is logged as a failure, not silent.
 */
function refusalScript(
  agentId: string,
  resultFile: string,
  logDir: string,
  decision: AgentRouteDecision,
  toolType: string,
): string {
  const msg = `autonomous mode does not allow the '${toolType}' backend — no API keys in the autonomous agent path (Spec A). Use OAuth-Codex/local, or route via the credential broker.`;
  const toolLabel = toolChoiceToLabel({ type: toolType as ToolChoice['type'] } as ToolChoice);
  const routeDecisionJson = JSON.stringify({ ...decision, toolType, toolLabel });
  return `#!/bin/bash
# run-agent-${agentId}.sh — Shelly autonomous-mode refusal
SHELLY_AGENT_SCRIPT_VERSION=${AGENT_SCRIPT_VERSION}
ROUTE_DECISION_JSON=${shellQuote(routeDecisionJson)}
echo ${shellQuote(`[REFUSED] ${msg}`)} >&2
mkdir -p "$(dirname ${shellQuote(resultFile)})"
mkdir -p ${shellQuote(logDir)}
echo ${shellQuote(`[REFUSED] ${msg}`)} > ${shellQuote(resultFile)}
TS=$(date +%s)
cat > ${shellQuote(`${logDir}`)}/$TS.json << LOGEOF
{"agentId":${shellQuote(JSON.stringify(agentId))},"timestamp":\${TS}000,"status":"error","outputPreview":${shellQuote(JSON.stringify(`[REFUSED] ${msg}`))},"durationMs":0,"toolUsed":${shellQuote(JSON.stringify(toolLabel))},"errorMessage":${shellQuote(JSON.stringify(`[REFUSED] ${msg}`))},"routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
exit 1
`;
}

function generateToolCommand(
  tool: ToolChoice,
  escapedPrompt: string,
  rawPrompt: string,
  options: ToolCommandOptions = { autonomous: false, actionType: 'draft' },
): string {
  const resultVar = '"$RESULT_FILE"';
  const systemPromptJson = actionSystemPromptJson(options.actionType);
  switch (tool.type) {
    case 'cli':
      return options.orchestrationChain
        ? codexOrchestrationChainCommand(options.orchestrationChain, resultVar, options.policyJson ?? '')
        : codexDriverCommand(escapedPrompt, resultVar, options.policyJson ?? '');
    case 'gemini-api': {
      // Web-mandatory general tasks (collect current news) need Google Search
      // grounding — otherwise plain Gemini hallucinates like a non-web LLM.
      const sig = detectRouteSignals(rawPrompt);
      const grounded = sig.needsWeb && sig.webDomain === 'general';
      return geminiApiCommand(escapedPrompt, resultVar, systemPromptJson, tool.model, grounded);
    }
    case 'local':
      const localModel = (tool.model || (options.autonomous ? selectAutonomousLocalModel(rawPrompt) : LOCAL_MODEL_LIGHT)).replace(/"/g, '\\"');
      const localModelAssignment = options.autonomous
        ? `LOCAL_MODEL="\${SHELLY_AGENT_LOCAL_MODEL:-${localModel}}"`
        : `LOCAL_MODEL="\${LOCAL_LLM_MODEL:-${localModel}}"`;
      return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
	REQUEST_FILE="$HOME/.shelly/tmp/agent-request-$AGENT_ID.json"
	${localModelAssignment}
	# Cap the combined prompt + injected context so it cannot overflow the local
	# model's context window. The instruction (printed first) is always preserved;
	# only the trailing project/source context is truncated. A real run sent 7806
	# tokens into a small window and was rejected ("exceeds context size").
	# The cap is tier-aware: the small "work" tiers (0.8B/1.7B/2B) have an 8192
	# window, the heavier 4B/9B tiers only 4096, so they get a smaller char budget.
	# With a 2048 response reserve, ~16000 chars (~5k tokens) fits 8192 and ~7000
	# chars fits 4096. Genuinely large tasks escalate to a cloud backend (bigger
	# window) rather than being silently truncated to uselessness.
	# Match the small tiers FIRST: "0.8B" ends in the literal "8B", so a bare
	# *8[bB]* heavy-tier glob would false-match 0.8B and starve it. Mirror the
	# ordering in local_llm_runtime_profile, which lists 0.8b before 8b.
	case "$LOCAL_MODEL" in
	  *0.8[bB]*|*0-8[bB]*|*1.7[bB]*|*1-7[bB]*|*2[bB]*) LOCAL_PROMPT_MAX_CHARS="\${LOCAL_LLM_PROMPT_MAX_CHARS:-16000}" ;;
	  *4[bB]*|*8[bB]*|*9[bB]*) LOCAL_PROMPT_MAX_CHARS="\${LOCAL_LLM_PROMPT_MAX_CHARS:-7000}" ;;
	  *) LOCAL_PROMPT_MAX_CHARS="\${LOCAL_LLM_PROMPT_MAX_CHARS:-16000}" ;;
	esac
	# Write to a regular file first, THEN truncate by reading that file. Piping the
	# producers directly into "head -c" would SIGPIPE the printf writers once head
	# closes the pipe early (large context > pipe buffer) → exit 141 → under
	# 'set -euo pipefail' the whole run aborts BEFORE the fallback. Reading a
	# regular file with head has no producer to signal, so it is abort-safe.
	{ printf '%s\\n' "\${CURRENT_DATETIME_CONTEXT:-}"; printf '%s\\n' "\${DEVICE_STATUS_CONTEXT:-}"; printf '%s\\n' '${escapedPrompt}'; printf '%s\\n' "$SOURCE_CONTEXT"; } > "$PROMPT_FILE.full"
	head -c "$LOCAL_PROMPT_MAX_CHARS" "$PROMPT_FILE.full" > "$PROMPT_FILE"
	rm -f "$PROMPT_FILE.full"
	PROMPT_JSON=$(json_string_file "$PROMPT_FILE")
	SYSTEM_PROMPT_JSON=${shellQuote(systemPromptJson)}
	LOCAL_URL="\${LOCAL_LLM_URL:-http://127.0.0.1:8080}"
	printf '{\\"model\\":\\"%s\\",\\"messages\\":[{\\"role\\":\\"system\\",\\"content\\":%s},{\\"role\\":\\"user\\",\\"content\\":%s}],\\"max_tokens\\":2048,\\"chat_template_kwargs\\":{\\"enable_thinking\\":false}}' "$LOCAL_MODEL" "$SYSTEM_PROMPT_JSON" "$PROMPT_JSON" > "$REQUEST_FILE"
		if ! ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"; then
		  START_REASON=$(head -c 800 "$TMP_DIR/local-llm-start-$AGENT_ID.reason" 2>/dev/null | tr '\\n' ' ')
		  local_context_fallback "local llm start failed: $START_REASON" > ${resultVar}
		  touch "$BACKEND_ERROR_FILE"
		else
		  local_llm_start_activity_heartbeat 10
		  set +e
		  HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json "\${LOCAL_URL%/}/v1/chat/completions" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
		  LOCAL_EXIT=$?
		  set -e
		  local_llm_stop_activity_heartbeat
		  if [ "$LOCAL_EXIT" -ne 0 ] || [ ! -s "$RESULT_FILE.response.json" ]; then
		    START_REASON=$(head -c 800 "$TMP_DIR/local-llm-start-$AGENT_ID.reason" 2>/dev/null | tr '\\n' ' ')
		    local_context_fallback "http exit=$LOCAL_EXIT $START_REASON $(head -c 240 "$RESULT_FILE.stderr" 2>/dev/null | tr '\\n' ' ')" > ${resultVar}
		    touch "$BACKEND_ERROR_FILE"
		  else
		    extract_ai_content "$RESULT_FILE.response.json" > ${resultVar} 2>> "$RESULT_FILE.stderr" || { touch "$BACKEND_ERROR_FILE"; [ -s ${resultVar} ] || cat "$RESULT_FILE.stderr" > ${resultVar}; }
		  fi
		fi
		rm -f "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
		rm -f "$PROMPT_FILE" "$REQUEST_FILE"`;
    case 'perplexity':
      const perplexityModel = tool.model || 'sonar';
		      return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
		REQUEST_FILE="$HOME/.shelly/tmp/agent-request-$AGENT_ID.json"
		printf '%s\\n%s\\n%s\\n%s\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}" '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
		PROMPT_JSON=$(json_string_file "$PROMPT_FILE")
		SYSTEM_PROMPT_JSON=${shellQuote(systemPromptJson)}
		MODEL='${perplexityModel.replace(/'/g, "'\\''")}'
		if [ -z "\${PERPLEXITY_API_KEY:-}" ]; then
		  echo 'Perplexity API key is not set. Add PERPLEXITY_API_KEY to ~/.shelly/agents/.env.' > ${resultVar}
		  touch "$BACKEND_ERROR_FILE"
		else
		printf '{\\"model\\":\\"%s\\",\\"messages\\":[{\\"role\\":\\"system\\",\\"content\\":%s},{\\"role\\":\\"user\\",\\"content\\":%s}]}' "$MODEL" "$SYSTEM_PROMPT_JSON" "$PROMPT_JSON" > "$REQUEST_FILE"
		set +e
		if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ]; then
			  SHELLY_CAP_AUTH_REF=perplexity HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.perplexity.ai/chat/completions" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
			else
			  HTTP_AUTH_HEADER="Bearer $PERPLEXITY_API_KEY" HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.perplexity.ai/chat/completions" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
			fi
		API_EXIT=$?
		set -e
		if [ "$API_EXIT" -ne 0 ] || [ ! -s "$RESULT_FILE.response.json" ]; then
		  mark_http_failure "$API_EXIT"
		  echo "Perplexity API call failed with exit $API_EXIT: $(head -c 240 "$RESULT_FILE.stderr" 2>/dev/null | tr '\\n' ' ')" > ${resultVar}
		else
		  extract_ai_content "$RESULT_FILE.response.json" > ${resultVar} 2>> "$RESULT_FILE.stderr" || { touch "$BACKEND_ERROR_FILE"; [ -s ${resultVar} ] || cat "$RESULT_FILE.stderr" > ${resultVar}; }
		fi
		rm -f "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
		fi
		rm -f "$PROMPT_FILE" "$REQUEST_FILE"`;
    case 'cerebras':
      // Free-tier cloud tier of the ③ ladder (OpenAI-compatible). Used after
      // local when local can't fit/handle the task, BEFORE Codex (quota-preserving).
      return openAiCompatApiCommand(escapedPrompt, resultVar, systemPromptJson, {
        keyVar: 'CEREBRAS_API_KEY',
        envModelVar: 'CEREBRAS_MODEL',
        keyHint: 'Add CEREBRAS_API_KEY in Settings → API Keys (free tier at cloud.cerebras.ai).',
        url: 'https://api.cerebras.ai/v1/chat/completions',
        model: tool.model || 'qwen-3-235b-a22b-instruct-2507',
        label: 'Cerebras',
        authRef: 'cerebras',
      });
    case 'groq':
      return openAiCompatApiCommand(escapedPrompt, resultVar, systemPromptJson, {
        keyVar: 'GROQ_API_KEY',
        envModelVar: 'GROQ_MODEL',
        keyHint: 'Add GROQ_API_KEY in Settings → API Keys (free tier at console.groq.com).',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: tool.model || 'llama-3.3-70b-versatile',
        label: 'Groq',
        authRef: 'groq',
      });
    case 'ab-article-eval':
      return articleEvalCommand(rawPrompt, resultVar, systemPromptJson, tool.localModel, tool.codexCmd, options.policyJson ?? '');
    case 'auto':
      // `auto` never actually resolves to this arm in a live run today —
      // resolveAgentRoute (autonomous) and scoreRoutes (non-autonomous) both
      // collapse `auto` to a concrete tool BEFORE generateToolCommand is
      // called (see agent-tool-router.ts / agent-credential-policy.ts). Kept
      // driver-gated anyway (never bare `codex exec`) as defense-in-depth: if
      // a future caller ever reaches this arm with an unresolved `auto` tool,
      // it must not regress to danger-full-access Codex.
      return `if [ -n "\${GEMINI_API_KEY:-}" ]; then
  ${geminiApiCommand(escapedPrompt, resultVar, systemPromptJson)}
elif command -v codex >/dev/null 2>&1; then
  ${codexDriverFallbackCommand(escapedPrompt, resultVar, options.policyJson ?? '')}
else
  echo 'No background agent backend is configured. Add a Gemini API key, install Codex, or choose Local LLM/Perplexity explicitly.' > ${resultVar}
fi`;
  }
}

/**
 * Codex `exec`, ROUTED THROUGH THE B2 DRIVER — the SAME `--policy-json` /
 * `--approval-policy untrusted` gate the primary `cli` tool case uses (Spec A
 * / agent-boundary-policy.ts). On Android codex's native --sandbox does not
 * work, so a bare `codex exec` runs danger-full-access: every shell tool-call
 * codex makes internally bypasses this app's command-safety/workspace-boundary
 * classification entirely. Never invoke `codex exec` directly from an
 * unattended/autonomous run — always through here.
 *
 * `|| true` is intentionally NOT used on the invocation itself (that would
 * make the exit code unrecoverable under `set -e`); `set +e`/`set -e` brackets
 * it instead so the script never aborts but DRIVER_EXIT is still captured.
 */
function codexDriverCommand(escapedPrompt: string, resultVar: string, policyJson: string): string {
  return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
printf '%s\\n%s\\n%s\\n%s\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}" '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
# workspaceRoot (DEFERRED.md #2 残り): when the agent has a configured
# workspace, run the driver there instead of the content-studio default —
# the B2 driver re-anchors AutonomyPolicy.workspaceRoot to whatever --cwd it
# receives (scripts/shelly-agent-driver.js), so this --cwd IS the workspace
# boundary the gate enforces. AGENT_WORKSPACE_ROOT is empty when unset, and
# bash's \${VAR:-default} falls through on empty exactly like unset, so this
# is a no-op (today's $PROJECT_DIR default) when workspaceRoot isn't set.
DRIVER_CWD="\${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"
[ -d "$DRIVER_CWD" ] || DRIVER_CWD="$HOME"
if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then
  rm -f "$RESULT_FILE.answer"
  set +e
  shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js" \\
    --cwd "$DRIVER_CWD" \\
    --approval-policy untrusted \\
    --policy-json ${shellQuote(policyJson)} \\
    --agent-id "$AGENT_ID" \\
    --escalation-public-key-sha256 "\${SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256:-}" \\
    --escalation-timeout-action queue \\
    --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
    --answer-file "$RESULT_FILE.answer" \\
    --prompt-file "$PROMPT_FILE" > ${resultVar} 2>&1
  DRIVER_EXIT=$?
  set -e
  mirror_driver_audit_to_app_private || true
  mirror_driver_audit_to_sdcard || true
  CODEX_RESULT_ACTIVE=1
  if [ -s "$RESULT_FILE.answer" ]; then
    RESULT_CONTENT_FILE="$RESULT_FILE.answer"
    RESULT_CONTENT_IS_DRIVER_ANSWER=1
  else
    RESULT_CONTENT_FILE="$RESULT_FILE"
    RESULT_CONTENT_IS_DRIVER_ANSWER=0
    touch "$BACKEND_ERROR_FILE"
  fi
else
  echo 'Shelly agent driver or bundled node is unavailable. Update Shelly runtime, then retry.' > ${resultVar}
  DRIVER_EXIT=1
fi
rm -f "$PROMPT_FILE"`;
}

/**
 * bug #155(b) follow-up (docs/superpowers/DEFERRED.md, 2026-07-16): real
 * bash-side multi-step chain execution for an orchestrated agent whose
 * resolved tool is the codex driver (autonomous `auto` -> `{type:'cli',
 * cli:'codex'}` is the DEFAULT autonomous route for any agent that hasn't
 * explicitly pinned a cloud API tool — see ORCHESTRATION_COLLAPSED_NOTE's
 * history in generateRunScript above). Runs EVERY step through the SAME
 * B2-driver-gated invocation codexDriverCommand() uses (identical
 * --policy-json / --approval-policy untrusted gate, identical
 * command-safety/boundary classification per driver tool-call inside codex —
 * chaining adds NO privilege over a single manual run, same invariant
 * lib/agent-orchestration.ts's file comment states for the JS-side loop this
 * mirrors). Semantics are ported from lib/agent-manager.ts's
 * runAgentOrchestrated: budget/gate from resolveBudget/nextStepGate (both
 * already evaluated in TS by the caller — every NUMBER below is a baked
 * literal, never bash-side math), prompt carry-forward shaped exactly like
 * buildStepPrompt (same MAX_RESULT_CARRY_CHARS/MAX_PROMPT_CHARS budgets),
 * stop-immediately-on-first-failure (no retry, no continuing), and only the
 * TRUE FINAL step's result reaching the existing dispatch_agent_action call
 * that runs after this block returns (generateRunScript's "Check result"
 * section, unmodified).
 *
 * This is ported to bash (not simply calling into the JS loop) because the
 * unattended/scheduled fire path (AgentRuntime.kt) executes this .sh file
 * directly via a native subprocess — there is no foreground TS loop running
 * for that fire, so runAgentOrchestrated itself is unreachable from here.
 *
 * The one deliberate behavior gap vs. the single-shot path (documented, not a
 * security concern): this loop does NOT re-apply generateRunScript's North-
 * Star web-collection-contract / output-language directive
 * (collectionContract/languageDirective, derived from detectRouteSignals
 * against the full composed prompt in the reference JS path) to each step's
 * prompt. Porting detectRouteSignals' keyword classification into bash was
 * judged out of scope for this pass — a chain step that needs live web
 * collection may return a descriptive "workflow" answer instead of executing
 * it, same as this whole feature's behavior before the North Star fix. Left
 * as a documented follow-up (DEFERRED.md bug #155) rather than guessed at.
 */
function codexOrchestrationChainCommand(
  chain: OrchestrationChainOptions,
  resultVar: string,
  policyJson: string,
): string {
  const instructionsArray = chain.steps.map((s) => `  ${shellQuote(s.instruction)}`).join('\n');
  const totalTimeoutSec = Math.max(1, Math.floor(chain.totalTimeoutMs / 1000));
  return `CODEX_ORCH_BASE_PROMPT=${shellQuote(chain.basePrompt.trim())}
CODEX_ORCH_INSTRUCTIONS=(
${instructionsArray}
)
CODEX_ORCH_STEP_TOTAL=${chain.totalStepCount}
CODEX_ORCH_MAX_STEPS=${chain.maxSteps}
CODEX_ORCH_TOTAL_TIMEOUT_SEC=${totalTimeoutSec}
CODEX_ORCH_MAX_RESULT_CARRY_CHARS=${MAX_RESULT_CARRY_CHARS}
CODEX_ORCH_MAX_PROMPT_CHARS=${MAX_PROMPT_CHARS}
CODEX_ORCH_TOOL_JSON=${shellQuote(JSON.stringify(toolChoiceToLabel({ type: 'cli', cli: 'codex' })))}
CODEX_ORCH_CARRY_FILE="$TMP_DIR/agent-orch-carry-$AGENT_ID.txt"
: > "$CODEX_ORCH_CARRY_FILE"
CODEX_ORCH_FAILED=0
CODEX_ORCH_STEP_INDEX=0

# Mirrors buildStepPrompt's \`r.replace(/\\s+/g, ' ').trim().slice(0, N)\` —
# collapse every whitespace run to a single space, trim, then truncate to N
# BYTES (head -c; same acknowledged bytes-vs-JS-UTF16-chars gap
# MAX_RESULT_CARRY_CHARS's own doc comment in lib/agent-orchestration.ts
# flags — a non-ASCII prior result carries fewer effective characters than the
# JS budget implies, never more, so this can only under-carry, not overflow).
# Redacts through redact_secrets_text FIRST (same as clean_answer_preview /
# result_preview elsewhere in this file): a non-final step's raw driver
# answer can echo a secret a tool call surfaced (env var dump, file read,
# etc.), and that text becomes the NEXT step's prompt — sent off-device to
# the codex backend. Every other place a driver answer is carried forward in
# this file goes through this same redaction; the chain loop must too.
codex_orch_collapse_and_truncate() {
  orch_redacted="$1.orch-redacted"
  redact_secrets_text "$1" > "$orch_redacted" 2>/dev/null || cp "$1" "$orch_redacted" 2>/dev/null || : > "$orch_redacted"
  tr -s '[:space:]' ' ' < "$orch_redacted" | sed -e 's/^ *//' -e 's/ *$//' | head -c "$2"
  rm -f "$orch_redacted"
}

# Mirrors buildStepPrompt(basePrompt, instruction, priorResults) exactly: base
# prompt (if any) + a "# Results from previous steps" block (if any prior
# step already succeeded) + "# This step" + this step's instruction, the
# whole thing capped to CODEX_ORCH_MAX_PROMPT_CHARS. Writes the composed
# prompt to $PROMPT_FILE — the SAME file codexDriverCommand's single-shot
# path writes — so every downstream driver invocation is byte-for-byte the
# same shape as the non-chain path, just re-run per step. One deliberate
# addition vs. buildStepPrompt: a leading CURRENT_DATETIME_CONTEXT line (see
# the preamble comment near SOURCE_CONTEXT's own assignment) so every step of
# a multi-step chain — not just the single-shot codexDriverCommand path — is
# grounded in the real run-time date. Re-emitted on EVERY step (not baked
# once) since a long chain may cross a day/midnight boundary between steps.
codex_orch_build_prompt() {
  {
    printf '%s\\n%s\\n\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}"
    if [ -n "$CODEX_ORCH_BASE_PROMPT" ]; then
      printf '%s\\n\\n' "$CODEX_ORCH_BASE_PROMPT"
    fi
    if [ -s "$CODEX_ORCH_CARRY_FILE" ]; then
      printf '# Results from previous steps\\n'
      cat "$CODEX_ORCH_CARRY_FILE"
      printf '\\n\\n---\\n\\n'
    fi
    printf '# This step\\n%s' "$1"
  } > "$PROMPT_FILE.orch-full"
  head -c "$CODEX_ORCH_MAX_PROMPT_CHARS" "$PROMPT_FILE.orch-full" > "$PROMPT_FILE"
  rm -f "$PROMPT_FILE.orch-full"
}

PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
# workspaceRoot (DEFERRED.md #2 残り): same DRIVER_CWD resolution
# codexDriverCommand uses, computed ONCE here and reused for every step —
# every step in one chain runs in the same workspace boundary.
DRIVER_CWD="\${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"
[ -d "$DRIVER_CWD" ] || DRIVER_CWD="$HOME"

while [ "$CODEX_ORCH_STEP_INDEX" -lt "\${#CODEX_ORCH_INSTRUCTIONS[@]}" ]; do
  # nextStepGate mirror (lib/agent-orchestration.ts): REFUSE further steps —
  # never retry, never hang — on a prior failure, the resolved step-count
  # cap, or the resolved total time budget. Checked BEFORE launching a step,
  # exactly like the JS gate (an already-in-flight step is never preempted).
  [ "$CODEX_ORCH_FAILED" = "1" ] && break
  [ "$CODEX_ORCH_STEP_INDEX" -ge "$CODEX_ORCH_MAX_STEPS" ] && break
  CODEX_ORCH_NOW=$(date +%s)
  if [ $((CODEX_ORCH_NOW - START_TIME)) -gt "$CODEX_ORCH_TOTAL_TIMEOUT_SEC" ]; then
    break
  fi

  codex_orch_build_prompt "\${CODEX_ORCH_INSTRUCTIONS[$CODEX_ORCH_STEP_INDEX]}"
  rm -f "$BACKEND_ERROR_FILE" "$TRANSIENT_ERROR_FILE" "$RESULT_FILE.answer"
  if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then
    CODEX_ORCH_STEP_NUM=$((CODEX_ORCH_STEP_INDEX + 1))
    CURRENT_STEP_TMP="$LOG_DIR/current.json.tmp"
    # CODEX_ORCH_TOOL_JSON is already a JSON string literal (JSON.stringify'd
    # at generation time, including its own quotes) - %s here must NOT add a
    # second pair of quotes around it, or "tool" comes out double-quoted
    # (invalid JSON, found during Sidebar RUNNING-row current.json plumbing).
    printf '{"step":%s,"total":%s,"tool":%s,"startedAt":%s,"phase":"dispatch"}\n' \
      "$CODEX_ORCH_STEP_NUM" "$CODEX_ORCH_STEP_TOTAL" "$CODEX_ORCH_TOOL_JSON" "$(date +%s)" > "$CURRENT_STEP_TMP"
    mv "$CURRENT_STEP_TMP" "$LOG_DIR/current.json"
    set +e
    shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js" \\
      --cwd "$DRIVER_CWD" \\
      --approval-policy untrusted \\
      --policy-json ${shellQuote(policyJson)} \\
      --agent-id "$AGENT_ID" \\
      --escalation-public-key-sha256 "\${SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256:-}" \\
      --escalation-timeout-action queue \\
      --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
      --answer-file "$RESULT_FILE.answer" \\
      --prompt-file "$PROMPT_FILE" > ${resultVar} 2>&1
    DRIVER_EXIT=$?
    set -e
    mirror_driver_audit_to_app_private || true
    mirror_driver_audit_to_sdcard || true
    CODEX_RESULT_ACTIVE=1
    if [ -s "$RESULT_FILE.answer" ]; then
      RESULT_CONTENT_FILE="$RESULT_FILE.answer"
      RESULT_CONTENT_IS_DRIVER_ANSWER=1
    else
      RESULT_CONTENT_FILE="$RESULT_FILE"
      RESULT_CONTENT_IS_DRIVER_ANSWER=0
      touch "$BACKEND_ERROR_FILE"
    fi
  else
    echo 'Shelly agent driver or bundled node is unavailable. Update Shelly runtime, then retry.' > ${resultVar}
    RESULT_CONTENT_FILE="$RESULT_FILE"
    RESULT_CONTENT_IS_DRIVER_ANSWER=0
    DRIVER_EXIT=1
    touch "$BACKEND_ERROR_FILE"
  fi

  CODEX_ORCH_STEP_NUM=$((CODEX_ORCH_STEP_INDEX + 1))
  if [ -s "$RESULT_CONTENT_FILE" ] && [ ! -f "$BACKEND_ERROR_FILE" ]; then
    # Only carry a result forward when a LATER attempted step will actually
    # consume it — the final attempted step's carry entry would never be read.
    if [ "$CODEX_ORCH_STEP_NUM" -lt "\${#CODEX_ORCH_INSTRUCTIONS[@]}" ]; then
      CODEX_ORCH_CARRY_ENTRY=$(codex_orch_collapse_and_truncate "$RESULT_CONTENT_FILE" "$CODEX_ORCH_MAX_RESULT_CARRY_CHARS")
      [ -s "$CODEX_ORCH_CARRY_FILE" ] && printf '\\n\\n' >> "$CODEX_ORCH_CARRY_FILE"
      printf '## Step %s\\n%s' "$CODEX_ORCH_STEP_NUM" "$CODEX_ORCH_CARRY_ENTRY" >> "$CODEX_ORCH_CARRY_FILE"
    fi
  else
    CODEX_ORCH_FAILED=1
  fi
  CODEX_ORCH_STEP_INDEX=$CODEX_ORCH_STEP_NUM
done
rm -f "$PROMPT_FILE" "$CODEX_ORCH_CARRY_FILE"

# Only the TRUE FINAL step's completion may reach the configured action
# (draft/notify/webhook/cli/dm-reply/app-act) — mirrors runAgentOrchestrated's
# "only the last step's completion becomes the actual action content". If the
# resolved step-count cap or time budget stopped this chain before its true
# final step (index CODEX_ORCH_STEP_TOTAL-1) ever ran, and it did not fail
# outright (a failure is already handled by the existing BACKEND_ERROR_FILE
# check below — dispatch never fires for it either way), suppress the action
# for whatever the last-ATTEMPTED step produced. dispatch_agent_action's own
# __suppressed__ branch still saves the draft result to disk and returns
# success — it just never requests approval or fires a notification/webhook/
# app-act for a run that never reached its configured final step.
if [ "$CODEX_ORCH_STEP_INDEX" -lt "$CODEX_ORCH_STEP_TOTAL" ] && [ "$CODEX_ORCH_FAILED" != "1" ]; then
  ACTION_TYPE="__suppressed__"
fi`;
}

/**
 * codexDriverCommand + the P1/`auto`-fallback failure contract: a non-zero
 * driver exit is a hard backend error; a usage/rate-limit refusal surfaced in
 * the driver's captured output (it still contains codex's own text, just
 * interleaved with AUDIT/GATE telemetry lines — the substring scan below is
 * unaffected by that) is classified transient (exit-23 class) so the run is
 * 'unavailable' — retried next schedule, no circuit-breaker trip — instead of
 * a false success. Mirrors the classification the old bare-`codex exec`
 * helper used, now evaluated against the driver-gated invocation. Used by the
 * baked autonomous web→Codex ladder (P1) and the (unreachable-today) `auto`
 * arm above.
 */
function codexDriverFallbackCommand(escapedPrompt: string, resultVar: string, policyJson: string): string {
  return `${codexDriverCommand(escapedPrompt, resultVar, policyJson)}
if [ "$DRIVER_EXIT" -ne 0 ]; then
  mark_http_failure "$DRIVER_EXIT"
elif grep -qiE 'usage limit|rate.?limit|too many requests|quota (exceeded|reached)|you.?ve hit your|\\b429\\b' ${resultVar} 2>/dev/null; then
  mark_http_failure 23
fi`;
}

/**
 * A/B article evaluator: runs the SAME fixed, code-defined editorial rubric
 * against local Qwen and Codex, side by side, for manual comparison. Only the
 * `## User Request` + `## Recent Sources` sections are agent/user-supplied
 * (never model-chosen commands); everything else — the rubric, the run
 * layout, both invocations — is authored here, not generated at runtime.
 *
 * The Codex side used to shell out to a bare `codex exec "$(cat prompt.md)"`.
 * That is EXACTLY the invariant codexDriverCommand()'s doc comment warns
 * about: Android codex has no working native --sandbox, so an un-driven
 * `codex exec` runs danger-full-access — every shell tool-call codex makes
 * internally (not just the fixed prompt text) bypasses command-safety /
 * workspace-boundary classification entirely. The "Recent Sources" block
 * folded into the prompt (lib/agent-executor.ts, context.md builder above)
 * is file content this app did not author (scraped articles / vault notes),
 * so it is exactly the kind of untrusted text a prompt-injection could hide
 * in — the same class of risk the B2 driver's gate exists to catch. `ab-
 * article-eval` is autonomous-allowed (agent-credential-policy.ts), so this
 * is a real unattended exposure, not merely a manual/foreground nicety.
 * Routed through the same B2 driver (audit log, --policy-json boundary gate,
 * AGENT_WORKSPACE_ROOT --cwd anchoring) as every other codex-resolved tool —
 * see DEFERRED.md "#3 ab-article-eval が B2 driver を迂回". The article-eval
 * capability surface (fixed rubric + local/codex A/B compare, nothing else)
 * is unchanged; only HOW codex is invoked changed.
 */
function articleEvalCommand(rawPrompt: string, resultVar: string, systemPromptJson: string, localModel?: string, codexCmd?: string, policyJson = ''): string {
  const promptMarker = `SHELLY_AB_PROMPT_${Math.random().toString(36).slice(2)}`;
  const localModelValue = (localModel || LOCAL_MODEL_BALANCED).replace(/"/g, '\\"');
  const codexCmdValue = (codexCmd || 'codex').replace(/"/g, '\\"');
  return `PROJECT_DIR="\${SHELLY_CONTENT_PROJECT:-$HOME/projects/shelly-content-studio}"
LOCAL_URL="\${LOCAL_LLM_URL:-http://127.0.0.1:8080}"
LOCAL_MODEL="\${SHELLY_AGENT_ARTICLE_EVAL_LOCAL_MODEL:-${localModelValue}}"
CODEX_CMD="\${CODEX_CMD:-${codexCmdValue}}"
RUN_TS=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$PROJECT_DIR/evals/$RUN_TS-$SLUG"
mkdir -p "$RUN_DIR"

cat > "$RUN_DIR/user-request.md" <<'${promptMarker}'
${rawPrompt}
${promptMarker}

{
  echo '# Project Context'
  if [ -f "$PROJECT_DIR/AI_CONTEXT.md" ]; then cat "$PROJECT_DIR/AI_CONTEXT.md"; fi
  echo
  echo '# Recent Sources'
  for dir in "$PROJECT_DIR/sources" "\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}/20_Literature/Papers" "\${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}/30_Build_Log"; do
    [ -d "$dir" ] || continue
    find "$dir" -type f -name '*.md' 2>/dev/null | sort | tail -n 8 | while read -r file; do
      echo
      echo "## Source: $file"
      head -c 6000 "$file" || true
      echo
    done
  done
} > "$RUN_DIR/context.md"

# 2026-07-17 bug fix: leading run-time date/time line (see the preamble
# comment near SOURCE_CONTEXT's own assignment) — written first, then the
# fixed rubric heredoc below APPENDS (>>) rather than overwrites, so this
# stays the very first line of prompt.md exactly like every other backend's
# PROMPT_FILE.
printf '%s\\n%s\\n\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}" > "$RUN_DIR/prompt.md"
cat >> "$RUN_DIR/prompt.md" <<'PROMPTEOF'
あなたは日本語のSubstack記事の編集者です。

目的:
STEAM x AIを、AI導入論ではなく「AIを理解したうえで基礎学力を再定義する議論」として記事化してください。

必須観点:
- 語彙力
- 読解力
- 想像力 / 創造力
- 判断力 / 批判的思考
- 公教育で長く重視されてきた基礎学力との接続

制約:
- 事実と解釈を分ける
- 引用元やURLが文脈に含まれる場合は活用する
- 過剰な断定やAI万能論を避ける
- 日本語で、公開前の下書きとして使える密度にする

PROMPTEOF
{
  echo
  echo '# User Request'
  cat "$RUN_DIR/user-request.md"
  echo
  cat "$RUN_DIR/context.md"
} >> "$RUN_DIR/prompt.md"

PROMPT_JSON=$(json_string_file "$RUN_DIR/prompt.md")
SYSTEM_PROMPT_JSON=${shellQuote(systemPromptJson)}
LOCAL_REQUEST_FILE="$RUN_DIR/local-request.json"
printf '{\\"model\\":\\"%s\\",\\"messages\\":[{\\"role\\":\\"system\\",\\"content\\":%s},{\\"role\\":\\"user\\",\\"content\\":%s}],\\"temperature\\":0.7,\\"max_tokens\\":4096,\\"chat_template_kwargs\\":{\\"enable_thinking\\":false}}' "$LOCAL_MODEL" "$SYSTEM_PROMPT_JSON" "$PROMPT_JSON" > "$LOCAL_REQUEST_FILE"

LOCAL_START=$(date +%s)
if ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"; then
  local_llm_start_activity_heartbeat 10
  set +e
  HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json "\${LOCAL_URL%/}/v1/chat/completions" "$LOCAL_REQUEST_FILE" "$RUN_DIR/local.response.json" "$RUN_DIR/local.stderr.log"
  LOCAL_EXIT=$?
  set -e
  local_llm_stop_activity_heartbeat
else
  LOCAL_EXIT=127
  START_REASON=$(head -c 800 "$TMP_DIR/local-llm-start-$AGENT_ID.reason" 2>/dev/null | tr '\\n' ' ')
  echo "Local LLM start failed: $START_REASON" > "$RUN_DIR/local.stderr.log"
fi
LOCAL_END=$(date +%s)
if [ "$LOCAL_EXIT" -eq 0 ]; then
  extract_ai_content "$RUN_DIR/local.response.json" > "$RUN_DIR/local-qwen.md" 2>> "$RUN_DIR/local.stderr.log" || true
else
  echo "Local LLM failed with exit $LOCAL_EXIT" > "$RUN_DIR/local-qwen.md"
fi

CODEX_START=$(date +%s)
# Same B2 driver every other codex-resolved autonomous tool routes through
# (codexDriverCommand() above) — audit log, --policy-json boundary gate,
# AGENT_WORKSPACE_ROOT --cwd anchoring — instead of a bare "$CODEX_CMD" exec.
# See the doc comment on articleEvalCommand() for why this exposure was real.
ARTICLE_EVAL_DRIVER_CWD="\${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"
[ -d "$ARTICLE_EVAL_DRIVER_CWD" ] || ARTICLE_EVAL_DRIVER_CWD="$HOME"
set +e
if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then
  rm -f "$RUN_DIR/codex.md"
  shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js" \\
    --cwd "$ARTICLE_EVAL_DRIVER_CWD" \\
    --approval-policy untrusted \\
    --policy-json ${shellQuote(policyJson)} \\
    --codex-bin "$CODEX_CMD" \\
    --agent-id "$AGENT_ID" \\
    --escalation-public-key-sha256 "\${SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256:-}" \\
    --escalation-timeout-action queue \\
    --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
    --answer-file "$RUN_DIR/codex.md" \\
    --prompt-file "$RUN_DIR/prompt.md" > "$RUN_DIR/codex.stderr.log" 2>&1
  CODEX_EXIT=$?
  mirror_driver_audit_to_app_private || true
  mirror_driver_audit_to_sdcard || true
  if [ ! -s "$RUN_DIR/codex.md" ]; then
    cp "$RUN_DIR/codex.stderr.log" "$RUN_DIR/codex.md" 2>/dev/null || echo "Codex driver produced no answer (exit $CODEX_EXIT)" > "$RUN_DIR/codex.md"
  fi
else
  echo 'Shelly agent driver or bundled node is unavailable. Update Shelly runtime, then retry.' > "$RUN_DIR/codex.md"
  echo 'Shelly agent driver or bundled node is unavailable. Update Shelly runtime, then retry.' > "$RUN_DIR/codex.stderr.log"
  CODEX_EXIT=1
fi
set -e
CODEX_END=$(date +%s)

local_bytes=$(wc -c < "$RUN_DIR/local-qwen.md" | tr -d ' ')
codex_bytes=$(wc -c < "$RUN_DIR/codex.md" | tr -d ' ')
local_headings=$(grep -c '^#' "$RUN_DIR/local-qwen.md" 2>/dev/null || true)
codex_headings=$(grep -c '^#' "$RUN_DIR/codex.md" 2>/dev/null || true)
local_links=$(grep -Eo 'https?://[^ )]+' "$RUN_DIR/local-qwen.md" 2>/dev/null | wc -l | tr -d ' ')
codex_links=$(grep -Eo 'https?://[^ )]+' "$RUN_DIR/codex.md" 2>/dev/null | wc -l | tr -d ' ')

cat > "$RUN_DIR/metrics.json" <<METRICSEOF
{"agentId":"$AGENT_ID","timestamp":"$RUN_TS","localModel":"$LOCAL_MODEL","codexCmd":"$CODEX_CMD","localExit":$LOCAL_EXIT,"codexExit":$CODEX_EXIT,"localDurationSec":$((LOCAL_END - LOCAL_START)),"codexDurationSec":$((CODEX_END - CODEX_START)),"localBytes":$local_bytes,"codexBytes":$codex_bytes,"localHeadings":$local_headings,"codexHeadings":$codex_headings,"localLinks":$local_links,"codexLinks":$codex_links}
METRICSEOF

cat > "$RUN_DIR/eval.md" <<EVALEOF
# A/B Evaluation

## Metrics
\`\`\`json
$(cat "$RUN_DIR/metrics.json")
\`\`\`

## Quick Read
- Qwen/local output: $RUN_DIR/local-qwen.md
- Codex output: $RUN_DIR/codex.md
- Prompt: $RUN_DIR/prompt.md
- Context: $RUN_DIR/context.md

## Manual Rubric
- Thesis alignment: AI-era STEAM = foundational academic ability
- Source faithfulness
- Japanese readability
- Article structure
- Originality
- Publishability
EVALEOF

cat > ${resultVar} <<RESULTEOF
# Qwen3 local vs Codex A/B Article Eval

Run directory: $RUN_DIR

## Verdict Stub
Review \`eval.md\`, \`local-qwen.md\`, and \`codex.md\`.

## Metrics
\`\`\`json
$(cat "$RUN_DIR/metrics.json")
\`\`\`

## Local Qwen Preview
$(head -n 40 "$RUN_DIR/local-qwen.md")

## Codex Preview
$(head -n 40 "$RUN_DIR/codex.md")
RESULTEOF`;
}

/**
 * OpenAI-compatible chat-completions backend (Cerebras / Groq). Mirrors the
 * perplexity flow: source key from env, POST, extract content, fail-closed if no
 * key (graceful error + BACKEND_ERROR_FILE so the ladder can escalate). The key
 * is read from env (synced from Settings) and never logged.
 */
function openAiCompatApiCommand(
  escapedPrompt: string,
  resultVar: string,
  systemPromptJson: string,
  opts: { keyVar: string; envModelVar: string; keyHint: string; url: string; model: string; label: string; authRef: string },
): string {
  const model = opts.model.replace(/"/g, '\\"');
  const keyHint = opts.keyHint.replace(/'/g, "'\\''");
  const url = opts.url.replace(/"/g, '\\"');
  const label = opts.label.replace(/"/g, '\\"');
  return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
	REQUEST_FILE="$HOME/.shelly/tmp/agent-request-$AGENT_ID.json"
	printf '%s\\n%s\\n%s\\n%s\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}" '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
	PROMPT_JSON=$(json_string_file "$PROMPT_FILE")
	SYSTEM_PROMPT_JSON=${shellQuote(systemPromptJson)}
	MODEL="\${${opts.envModelVar}:-${model}}"
	if [ -z "\${${opts.keyVar}:-}" ]; then
	  echo '${keyHint}' > ${resultVar}
	  touch "$BACKEND_ERROR_FILE"
	else
	printf '{\\"model\\":\\"%s\\",\\"messages\\":[{\\"role\\":\\"system\\",\\"content\\":%s},{\\"role\\":\\"user\\",\\"content\\":%s}]}' "$MODEL" "$SYSTEM_PROMPT_JSON" "$PROMPT_JSON" > "$REQUEST_FILE"
	set +e
	if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ]; then
	SHELLY_CAP_AUTH_REF=${opts.authRef} HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "${url}" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
	else
	HTTP_AUTH_HEADER="Bearer $${opts.keyVar}" HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "${url}" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
	fi
	API_EXIT=$?
	set -e
	if [ "$API_EXIT" -ne 0 ] || [ ! -s "$RESULT_FILE.response.json" ]; then
	  mark_http_failure "$API_EXIT"
	  echo "${label} API call failed with exit $API_EXIT: $(head -c 240 "$RESULT_FILE.stderr" 2>/dev/null | tr '\\n' ' ')" > ${resultVar}
	else
	  extract_ai_content "$RESULT_FILE.response.json" > ${resultVar} 2>> "$RESULT_FILE.stderr" || { touch "$BACKEND_ERROR_FILE"; [ -s ${resultVar} ] || cat "$RESULT_FILE.stderr" > ${resultVar}; }
	fi
	rm -f "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
	fi
	rm -f "$PROMPT_FILE" "$REQUEST_FILE"`;
}

function geminiApiCommand(escapedPrompt: string, resultVar: string, systemPromptJson: string, model?: string, grounded = false): string {
  // gemini-2.5-flash: the 2.0-flash free tier is limit:0 (no free quota); 2.5-flash
  // has a working free tier AND supports Google Search grounding (verified 2026-06-24).
  const defaultModel = model || 'gemini-2.5-flash';
  // Google Search grounding: only added for web-mandatory tasks so routine
  // Gemini calls aren't forced onto the search tool.
  const toolsFragment = grounded ? '\\"tools\\":[{\\"google_search\\":{}}],' : '';
  return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
REQUEST_FILE="$HOME/.shelly/tmp/agent-request-$AGENT_ID.json"
printf '%s\\n%s\\n%s\\n%s\\n' "\${CURRENT_DATETIME_CONTEXT:-}" "\${DEVICE_STATUS_CONTEXT:-}" '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
PROMPT_JSON=$(json_string_file "$PROMPT_FILE")
SYSTEM_PROMPT_JSON=${shellQuote(systemPromptJson)}
MODEL="\${GEMINI_MODEL:-${defaultModel.replace(/"/g, '\\"')}}"
# The 2.0-flash free tier is limit:0 (no free quota) → 429s and (in autonomous
# runs) needlessly escalates to Codex. Older installs may have GEMINI_MODEL pinned
# to it in ~/.shelly/agents/.env, so migrate any stale 2.0-flash pin to 2.5-flash.
case "$MODEL" in gemini-2.0-flash|gemini-2.0-flash-001|gemini-2.0-flash-exp) MODEL="gemini-2.5-flash" ;; esac
if [ -z "\${GEMINI_API_KEY:-}" ]; then
  echo 'Gemini API key is not set. Add it in Settings before running background agents.' > ${resultVar}
  touch "$BACKEND_ERROR_FILE"
else
  printf '{\\"systemInstruction\\":{\\"parts\\":[{\\"text\\":%s}]},\\"contents\\":[{\\"role\\":\\"user\\",\\"parts\\":[{\\"text\\":%s}]}],${toolsFragment}\\"generationConfig\\":{\\"maxOutputTokens\\":8192,\\"temperature\\":0.7}}' "$SYSTEM_PROMPT_JSON" "$PROMPT_JSON" > "$REQUEST_FILE"
  set +e
  if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ]; then
    SHELLY_CAP_AUTH_REF=gemini HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://generativelanguage.googleapis.com/v1beta/models/$MODEL:generateContent" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
  else
    HTTP_EXTRA_HEADERS="x-goog-api-key: $GEMINI_API_KEY" HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://generativelanguage.googleapis.com/v1beta/models/$MODEL:generateContent" "$REQUEST_FILE" "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
  fi
  API_EXIT=$?
  set -e
  if [ "$API_EXIT" -ne 0 ] || [ ! -s "$RESULT_FILE.response.json" ]; then
    mark_http_failure "$API_EXIT"
    echo "Gemini API call failed with exit $API_EXIT: $(head -c 240 "$RESULT_FILE.stderr" 2>/dev/null | tr '\\n' ' ')" > ${resultVar}
  else
    extract_ai_content "$RESULT_FILE.response.json" > ${resultVar} 2>> "$RESULT_FILE.stderr" || { touch "$BACKEND_ERROR_FILE"; [ -s ${resultVar} ] || cat "$RESULT_FILE.stderr" > ${resultVar}; }
  fi
  rm -f "$RESULT_FILE.response.json" "$RESULT_FILE.stderr"
fi
rm -f "$PROMPT_FILE" "$REQUEST_FILE"`;
}

export function getScriptPath(agentId: string): string {
  return `${paths().agentsDir}/run-agent-${agentId}.sh`;
}

/**
 * DEFERRED.md エージェント二重実行レース (chain-lock follow-up): single source
 * of truth for the chain-scoped mkdir lock's directory path, shared by
 * generateRunScript (bakes it as CHAIN_LOCK_DIR for the runtime check) and
 * lib/agent-manager.ts's acquireChainLock/releaseChainLock/
 * disarmChainLockToken/materializeAgentBody (which touch it via runCommand
 * from the JS/native orchestration layer — this lock is held across MULTIPLE
 * separate script invocations, so it cannot live inside the generated bash).
 */
export function getChainLockDir(agentId: string): string {
  return `${paths().locksDir}/${agentId}.chain.lock`;
}

export function generateInstallCommands(agent: Agent): string[] {
  const { agentsDir, tmpDir, locksDir, logsDir } = paths();
  const scriptPath = getScriptPath(agent.id);
  return [
    `mkdir -p '${agentsDir}' '${tmpDir}' '${locksDir}' '${logsDir}/${agent.id}'`,
    `chmod +x '${scriptPath}'`,
  ];
}

export function generateStopCommand(agentId: string): string {
  const pidFile = `${paths().locksDir}/${agentId}.pid`;
  const lockDir = `${pidFile}.lockdir`;
  return `pid_file=${shellQuote(pidFile)}; if [ -f "$pid_file" ]; then pid="$(cat "$pid_file")"; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; sleep 1; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; rm -f "$pid_file"; fi; rm -rf ${shellQuote(lockDir)} 2>/dev/null || true`;
}
