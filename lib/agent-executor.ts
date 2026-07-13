/**
 * lib/agent-executor.ts — Runs agent tasks in isolated tmux sessions.
 * Generates per-agent shell scripts and manages execution lifecycle.
 */
import { Agent, AgentActionType, AgentRouteDecision, ToolChoice } from '@/store/types';
import { resolveAgentRoute, toolChoiceToLabel } from './agent-tool-router';
import { detectRouteSignals } from './agent-router-scoring';
import { requiresApiKeyEnv, resolveForAutonomous } from './agent-credential-policy';
import { getHomePath } from '@/lib/home-path';
import { evaluateAgentActionCommand } from './agent-action-safety';
import { buildAgentPolicy } from './agent-policy';

const MAX_CONCURRENT = 2;

const DEFAULT_TIMEOUT_SEC = 600; // 10 minutes
const AGENT_SCRIPT_VERSION = 10;
const LOCAL_MODEL_LIGHT = 'Qwen3.5-0.8B-Q4_K_M';
const LOCAL_MODEL_BALANCED = 'Qwen3.5-2B-Q4_K_M';
const LOCAL_MODEL_QUALITY = 'Qwen3.5-4B-Q4_K_M';

type ToolCommandOptions = {
  autonomous: boolean;
  actionType: AgentActionType;
  /** B2: the AutonomyPolicy JSON passed to the driver via --policy-json (inline
   *  arg, never a file the agent can read — preserves the §6 invariant). */
  policyJson?: string;
};

const ACTION_OUTPUT_INSTRUCTIONS: Record<AgentActionType, string> = {
  draft: 'Write the requested document or content directly. Do not add a preamble saying that a draft was created.',
  notify: 'Write the notification message itself. Unless explicit user instructions request otherwise, keep it to a few words or one sentence.',
  webhook: 'Produce exactly the payload content requested for the webhook.',
  cli: 'Produce exactly the content needed by the requested command or command workflow.',
  intent: 'Produce exactly the text or content needed for the requested app or share action.',
  'dm-reply': 'Write the reply message itself as a natural, short conversational response unless explicit user instructions request otherwise.',
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

/**
 * Generate a per-agent script: run-agent-{id}.sh
 * All values pre-computed in TypeScript, embedded as bash string literals.
 */
export function generateRunScript(agent: Agent, opts: { suppressAction?: boolean; suppressErrorNotification?: boolean; autonomousCloudConsent?: boolean; autonomousCloudStop?: boolean; suppressWebCodexBake?: boolean } = {}): string {
  const { home, tmpDir, locksDir, logsDir, envFile, dmPairingsFile } = paths();
  const agentId = agent.id;
  const resultFile = `${tmpDir}/agent-result-${agentId}.md`;
  const lockFile = `${locksDir}/${agentId}.pid`;
  const logDir = `${logsDir}/${agentId}`;

  const routeResolution = resolveAgentRoute(agent);

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
  const actionCommandSafety = evaluateAgentActionCommand(actionCommand);

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
  const agentPolicyJson = JSON.stringify(buildAgentPolicy(agent, home));
  let toolCommand = generateToolCommand(tool, escapedPrompt, agent.prompt, {
    autonomous: agent.autonomous === true,
    actionType: agent.action?.type ?? 'draft',
    policyJson: agentPolicyJson,
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
if [ ! -f "$BACKEND_ERROR_FILE" ] && ! grep -qE 'https?://' "$RESULT_FILE" 2>/dev/null; then
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
    toolCommand = `${toolCommand}
if [ -f "$BACKEND_ERROR_FILE" ]; then
  WEB_WAS_TRANSIENT=0
  [ -f "$TRANSIENT_ERROR_FILE" ] && WEB_WAS_TRANSIENT=1
  rm -f "$BACKEND_ERROR_FILE" "$TRANSIENT_ERROR_FILE"
  if command -v codex >/dev/null 2>&1; then
    ${codexExecCommand(escapedPrompt, '"$RESULT_FILE"')}
    # North Star guard (baked path): the no-URL check above ran before this Codex
    # escalation, so re-check here — a sourceless Codex essay must also fail-closed
    # rather than ship to the vault on the unattended (alarm-fired) run.
    if [ ! -f "$BACKEND_ERROR_FILE" ] && ! grep -qE 'https?://' "$RESULT_FILE" 2>/dev/null; then
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
RESULT_FILE=${shellQuote(resultFile)}
LOCK_FILE=${shellQuote(lockFile)}
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
ACTION_WEBHOOK_URL=${shellQuote(actionWebhookUrl)}
ACTION_COMMAND=${shellQuote(actionCommand)}
ACTION_INTENT_MODE=${shellQuote(actionIntentMode)}
ACTION_INTENT_TARGET=${shellQuote(actionIntentTarget)}
ACTION_INTENT_SHARE_TEXT=${shellQuote(actionIntentShareText)}
ACTION_DM_PAIRING_ID=${shellQuote(actionDmPairingId)}
ACTION_DM_REPLY_TEXT=${shellQuote(actionDmReplyText)}
ACTION_DM_PAIRING_LABEL=""
ACTION_COMMAND_SAFETY_LEVEL=${shellQuote(actionCommandSafety.level)}
ACTION_COMMAND_SAFETY_REASON=${shellQuote(actionCommandSafety.reason)}
ACTION_COMMAND_AUTO_APPROVABLE=${actionCommandSafety.autoApprovable ? '1' : '0'}
ACTION_NOTIFY_FILE="$LOG_DIR/native-result-notification.json"
ACTION_APPROVAL_DIR="$HOME/.shelly/agents/action-approvals"
ACTION_APPROVAL_REPLY_DIR="$HOME/.shelly/agents/action-approval-replies"
ACTION_RUN_ID="$AGENT_ID-$(date +%s)-$$"
ACTION_APPROVAL_REQUEST_FILE="$ACTION_APPROVAL_DIR/action-$ACTION_RUN_ID.json"
ACTION_APPROVAL_REPLY_FILE="$ACTION_APPROVAL_REPLY_DIR/action-$ACTION_RUN_ID.reply.json"
ACTION_APPROVAL_REQUEST_SHA256=""
ACTION_APPROVAL_TIMEOUT_SECONDS="\${SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS:-120}"
ACTION_DISPATCH_STATUS=""
ACTION_DISPATCH_MESSAGE=""
REGISTRY_LOCK=""
REGISTRY_LOCK_ACQUIRED=0
BACKEND_ERROR_FILE="$RESULT_FILE.backend-error"
TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"
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

# Strip the autonomous driver's structured telemetry (AUDIT/GATE/protocol/STDERR/
# escalation) from a result file so the user-facing preview shows real content,
# never the internal driver_start JSON. Backends that write a plain answer
# (local/perplexity/gemini) have no such lines, so this is a harmless no-op for
# them. Whitespace-collapsed and length-capped for a notification body.
clean_result_preview() {
  file="$1"
  [ -f "$file" ] || return 0
  # Filter the driver telemetry into a temp file FIRST, then head THAT file.
  # Piping sed directly into "head -c 500" SIGPIPEs sed the moment head closes the
  # pipe early (any cleaned result > 500 bytes — i.e. every real answer); under
  # 'set -euo pipefail' that 141 propagates and aborts the whole run. head reading
  # a regular file has no upstream producer to signal, so it is abort-safe.
  cleaned="$file.preview"
  sed -E '/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d' "$file" 2>/dev/null > "$cleaned" || true
  head -c 500 "$cleaned" 2>/dev/null | tr '\\n' ' '
  rm -f "$cleaned"
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
    if SHELLY_WEBHOOK_URL="$url" shelly_node -e 'try { const u = new URL(process.env.SHELLY_WEBHOOK_URL || ""); if (u.protocol !== "https:" || !u.hostname) process.exit(1); process.stdout.write(u.host || u.hostname); } catch (_) { process.exit(1); }' 2>/dev/null; then
      return 0
    fi
  fi
  case "$url" in
    https://*) ;;
    *) return 1 ;;
  esac
  host=$(printf '%s' "$url" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##')
  [ -n "$host" ] || return 1
  printf '%s' "$host"
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
  ts_seconds=$(date +%s)
  expires_at=$(( (ts_seconds + ACTION_APPROVAL_TIMEOUT_SECONDS) * 1000 ))
  tmp="$ACTION_APPROVAL_REQUEST_FILE.tmp"
  cat > "$tmp" << APPROVALEOF
{"runId":"$ACTION_RUN_ID","agentId":"$agent_json","agentName":"$agent_name_json","toolLabel":"$tool_label_json","actionType":"$approval_type_json","preview":"$preview_json","destinationHost":"$destination_json","command":"$command_json","safetyLevel":"$safety_level_json","safetyReason":"$safety_reason_json","payloadPath":"$payload_path_json","resultPath":"$result_path_json","intentMode":"$intent_mode_json","intentTarget":"$intent_target_json","intentShareText":"$intent_share_text_json","dmPairingId":"$dm_pairing_id_json","dmPairingLabel":"$dm_pairing_label_json","dmReplyText":"$dm_reply_text_json","ts":"$(date -Iseconds)","expiresAt":$expires_at}
APPROVALEOF
  mv "$tmp" "$ACTION_APPROVAL_REQUEST_FILE"
  ACTION_APPROVAL_REQUEST_SHA256="$(sha256_file "$ACTION_APPROVAL_REQUEST_FILE" || true)"
}

wait_action_approval() {
  approval_type="$1"
  deadline=$(( $(date +%s) + ACTION_APPROVAL_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    if [ -s "$ACTION_APPROVAL_REPLY_FILE" ]; then
      reply_run_id="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "runId")"
      reply_decision="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "decision")"
      reply_request_sha="$(json_field_file "$ACTION_APPROVAL_REPLY_FILE" "requestSha256")"
      if [ "$reply_run_id" != "$ACTION_RUN_ID" ] ||
        [ -z "$ACTION_APPROVAL_REQUEST_SHA256" ] ||
        [ "$reply_request_sha" != "$ACTION_APPROVAL_REQUEST_SHA256" ]; then
        rm -f "$ACTION_APPROVAL_REPLY_FILE" "$ACTION_APPROVAL_REQUEST_FILE" 2>/dev/null || true
        ACTION_DISPATCH_STATUS="error"
        ACTION_DISPATCH_MESSAGE="$approval_type action approval reply did not match the pending request."
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

save_draft_result() {
  result_file="$1"
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
      # N2: autonomous agents auto-approve a draft→vault save. It is a local file
      # write only (low-risk) — cli/webhook/notify still require an approval tap,
      # and secret-guard has already forced the run on-device, so nothing leaves
      # the device unapproved. Manual (@agent) runs keep the confirm card.
      if [ "\${AGENT_AUTONOMOUS:-0}" != "1" ]; then
        write_action_approval_request "draft" "$preview" "$result_file"
        wait_action_approval "draft" || return 1
      fi
      save_draft_result "$result_file"
      # Post ONE readable completion card after the draft is saved, so the run
      # gives the user closure (matching the notify action). The preview is
      # already telemetry-stripped. Orchestration non-final steps never reach here
      # (they use the __suppressed__ branch above), so a chain still ends with a
      # single completion, not one per step.
      write_native_notification_request "success" "$preview" || true
      return 0
      ;;
    notify)
      write_action_approval_request "notify" "$preview" "$result_file"
      wait_action_approval "notify" || return 1
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
      webhook_payload="$LOG_DIR/webhook-payload-$(date +%s).json"
      webhook_response="$LOG_DIR/webhook-response-$(date +%s).txt"
      webhook_error="$LOG_DIR/webhook-error-$(date +%s).txt"
      write_webhook_payload "$webhook_payload" "success" "$preview" "$result_file"
      write_action_approval_request "webhook" "$preview" "$result_file" "$webhook_host" "$webhook_payload"
      wait_action_approval "webhook" || return 1
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
      write_action_approval_request "cli" "$preview" "$result_file"
      wait_action_approval "cli" || return 1
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
      write_action_approval_request "intent" "$preview" "$result_file"
      wait_action_approval "intent" || return 1
      # No broker/native call here (unlike webhook/cli): RN already fired the
      # intent NATIVELY (fireAgentIntent) BEFORE writing the accept reply that
      # wait_action_approval just observed. Nothing left to execute.
      ACTION_DISPATCH_MESSAGE="Intent fired: $ACTION_INTENT_MODE $ACTION_INTENT_TARGET"
      return 0
      ;;
    dm-reply)
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
      write_action_approval_request "dm-reply" "$preview" "$result_file"
      wait_action_approval "dm-reply" || return 1
      # RN sends natively before publishing the accept reply. There is no
      # post-approval broker or shell side effect here.
      ACTION_DISPATCH_MESSAGE="DM reply sent."
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
  if [ "\${SHELLY_CAP_BROKER:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then
    shelly_node "$HOME/.shelly-capability-broker.js" \\
      --method POST --url "$url" --body-file "$body_file" \\
      --auth-ref "\${SHELLY_CAP_AUTH_REF:-}" --tainted "\${SHELLY_CAP_TAINTED:-0}" --approved "\${SHELLY_CAP_APPROVED:-0}" \\
      --secret-env-file "$ENV_FILE" \\
      --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
      --budget-file "$TMP_DIR/cap-budget-$AGENT_ID.json" \\
      --timeout-seconds "\${HTTP_TIMEOUT_SECONDS:-30}" \\
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
${apiKeyEnvScrub}

PROJECT_DIR="\${SHELLY_CONTENT_PROJECT:-$HOME/projects/shelly-content-studio}"
SOURCE_REGISTRY_FILE="\${SOURCE_REGISTRY_FILE:-$PROJECT_DIR/sources/source-registry.tsv}"
mkdir -p "$(dirname "$SOURCE_REGISTRY_FILE")"
touch "$SOURCE_REGISTRY_FILE"
SOURCE_CONTEXT=""
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
      git -C "$repo" log --oneline -8 2>/dev/null || true
      echo
      echo "### Current git status: $repo"
      git -C "$repo" status --short 2>/dev/null || true
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

# Per-agent concurrency lock
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    TS=$(date +%s)
    TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
    cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"skipped","outputPreview":"previous run still active","durationMs":0,"toolUsed":"$TOOL_LABEL_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

# Acquire lock
echo $$ > "$LOCK_FILE"

# Execute tool
rm -f "$BACKEND_ERROR_FILE" "$TRANSIENT_ERROR_FILE"
# CAP-001: each run opens a fresh egress budget envelope (drop any stale counter).
rm -f "$TMP_DIR/cap-budget-$AGENT_ID.json"
${toolCommand}

# Check result
END_TIME=$(date +%s)
DURATION=$(( (END_TIME - START_TIME) * 1000 ))

if [ -f "$RESULT_FILE" ] && [ -s "$RESULT_FILE" ] && [ ! -f "$BACKEND_ERROR_FILE" ]; then
  PREVIEW=$(clean_result_preview "$RESULT_FILE")
  STATUS="success"
  ERROR_MESSAGE=""

  if ! dispatch_agent_action "$RESULT_FILE" "$PREVIEW"; then
    STATUS="\${ACTION_DISPATCH_STATUS:-error}"
    ERROR_MESSAGE="\${ACTION_DISPATCH_MESSAGE:-agent action dispatch failed}"
    PREVIEW="$ERROR_MESSAGE"
  fi
else
  if [ -f "$RESULT_FILE" ] && [ -s "$RESULT_FILE" ]; then
    PREVIEW=$(clean_result_preview "$RESULT_FILE")
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

# Log run result
TS=$(date +%s)
PREVIEW_JSON=$(json_escape_text "$PREVIEW")
TOOL_LABEL_JSON=$(json_escape_text "$TOOL_LABEL")
ERROR_MESSAGE_JSON=$(json_escape_text "$ERROR_MESSAGE")
cat > "$LOG_DIR/$TS.json" << LOGEOF
{"agentId":"$AGENT_ID","timestamp":\${TS}000,"status":"$STATUS","outputPreview":"$PREVIEW_JSON","durationMs":$DURATION,"toolUsed":"$TOOL_LABEL_JSON","errorMessage":"$ERROR_MESSAGE_JSON","routeDecision":$ROUTE_DECISION_JSON}
LOGEOF

# Prune old logs (keep last 30)
ls -t "$LOG_DIR"/*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

# Cleanup temp
rm -f "$RESULT_FILE" "$BACKEND_ERROR_FILE"
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
      return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
printf '%s\\n%s\\n' '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
DRIVER_CWD="$PROJECT_DIR"
[ -d "$DRIVER_CWD" ] || DRIVER_CWD="$HOME"
if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then
  shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js" \\
    --cwd "$DRIVER_CWD" \\
    --approval-policy untrusted \\
    --policy-json ${shellQuote(options.policyJson ?? '')} \\
    --agent-id "$AGENT_ID" \\
    --escalation-public-key-sha256 "\${SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256:-}" \\
    --audit-log "$LOG_DIR/agent-driver-audit.jsonl" \\
    --prompt-file "$PROMPT_FILE" > ${resultVar} 2>&1 || true
  mirror_driver_audit_to_app_private || true
  mirror_driver_audit_to_sdcard || true
else
  echo 'Shelly agent driver or bundled node is unavailable. Update Shelly runtime, then retry.' > ${resultVar}
fi
rm -f "$PROMPT_FILE"`;
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
	{ printf '%s\\n' '${escapedPrompt}'; printf '%s\\n' "$SOURCE_CONTEXT"; } > "$PROMPT_FILE.full"
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
		printf '%s\\n%s\\n' '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
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
      return articleEvalCommand(rawPrompt, resultVar, systemPromptJson, tool.localModel, tool.codexCmd);
    case 'auto':
      return `if [ -n "\${GEMINI_API_KEY:-}" ]; then
  ${geminiApiCommand(escapedPrompt, resultVar, systemPromptJson)}
elif command -v codex >/dev/null 2>&1; then
  ${codexExecCommand(escapedPrompt, resultVar)}
else
  echo 'No background agent backend is configured. Add a Gemini API key, install Codex, or choose Local LLM/Perplexity explicitly.' > ${resultVar}
fi`;
  }
}

/**
 * Codex `exec` into the result file, GUARDED. Codex prints a usage/rate-limit
 * refusal to stdout with a zero exit (so a naive `> result || true` records that
 * refusal as a real success). We capture the exit code AND scan the output for a
 * usage-limit signature: a non-zero exit → hard backend error; a usage-limit
 * refusal → transient (exit-23 class) so the run is 'unavailable' (retried next
 * schedule, no circuit-breaker trip) instead of a false success. Used by the
 * `auto` backend and the baked autonomous web→Codex ladder (P1).
 */
function codexExecCommand(escapedPrompt: string, resultVar: string): string {
  return `PROMPT_FILE="$HOME/.shelly/tmp/agent-prompt-$AGENT_ID.txt"
  printf '%s\\n%s\\n' '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
  set +e
  timeout "$TIMEOUT" codex exec "$(cat "$PROMPT_FILE")" > ${resultVar} 2>&1
  CODEX_EXIT=$?
  set -e
  rm -f "$PROMPT_FILE"
  if [ "$CODEX_EXIT" -ne 0 ]; then
    mark_http_failure "$CODEX_EXIT"
  elif grep -qiE 'usage limit|rate.?limit|too many requests|quota (exceeded|reached)|you.?ve hit your|\\b429\\b' ${resultVar} 2>/dev/null; then
    mark_http_failure 23
  fi`;
}

function articleEvalCommand(rawPrompt: string, resultVar: string, systemPromptJson: string, localModel?: string, codexCmd?: string): string {
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

cat > "$RUN_DIR/prompt.md" <<'PROMPTEOF'
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
set +e
if command -v "$CODEX_CMD" >/dev/null 2>&1; then
  timeout "$TIMEOUT" "$CODEX_CMD" exec "$(cat "$RUN_DIR/prompt.md")" > "$RUN_DIR/codex.md" 2> "$RUN_DIR/codex.stderr.log"
  CODEX_EXIT=$?
else
  echo "Codex CLI not found: $CODEX_CMD" > "$RUN_DIR/codex.md"
  echo "Codex CLI not found: $CODEX_CMD" > "$RUN_DIR/codex.stderr.log"
  CODEX_EXIT=127
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
	printf '%s\\n%s\\n' '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
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
printf '%s\\n%s\\n' '${escapedPrompt}' "$SOURCE_CONTEXT" > "$PROMPT_FILE"
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
  return `pid_file=${shellQuote(pidFile)}; if [ -f "$pid_file" ]; then pid="$(cat "$pid_file")"; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; sleep 1; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; rm -f "$pid_file"; fi`;
}
