#!/usr/bin/env node
/*
 * shelly-plan-executor.js - Phase 0 PlanSpec executor canary.
 *
 * This intentionally supports a narrow first slice. It runs one PlanSpec without
 * sourcing run-agent-*.sh, but delegates HTTP and filesystem effects to the
 * capability broker so the broker remains the final security boundary.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLAN_SPEC_SCHEMA_VERSION = 1;
const PLAN_SPEC_KIND = 'shelly.agent.plan';

// 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 (lib/signed-approval/wiring.ts).
// Master dormancy switch for the EXECUTOR half. Mirrors, byte-for-byte in intent,
// lib/signed-approval/wiring.ts's SIGNED_APPROVAL_ENABLED (a separate TS constant
// because this file is plain CommonJS and cannot import .ts at runtime). The two
// constants MUST be flipped together at the flag-ON cutover described there
// (step 2: "the PlanSpec executor's requestActionApproval accept-path calls
// verifyApprovalReply instead of the current runId + requestSha256 equality
// check"). While false, requestActionApproval's accept-path runs the exact
// naive-equality check that shipped before this file existed — byte-identical
// live behavior is the load-bearing invariant here, not the new verifier code
// (which is fully implemented below but never invoked).
const SIGNED_APPROVAL_ENABLED = false;

const EXIT = {
  OK: 0,
  PLAN_DENY: 47,
  TOOL_DENY: 48,
  INTERNAL: 127,
};

const CONFIG_ENV_KEYS = new Set([
  'LOCAL_LLM_URL',
  'LOCAL_LLM_MODEL',
  'GEMINI_MODEL',
  'PERPLEXITY_MODEL',
  'CEREBRAS_MODEL',
  'GROQ_MODEL',
  'SHELLY_AGENT_OUTPUT_TARGET',
  'SHELLY_AGENT_TOPIC_FOLDER',
  'SHELLY_AGENT_CUSTOM_PATH',
  'SHELLY_AGENT_EXEC_CWD',
  'SHELLY_CONTENT_PROJECT',
  'SOURCE_REGISTRY_FILE',
  'OBSIDIAN_VAULT_PATH',
  'SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS',
  'WEBHOOK_TIMEOUT_SECONDS',
  'SHELLY_WEBHOOK_HOST_ALLOWLIST',
  // North Star P0(c) companion fix (2026-07-16): requireActionApprovalTap()
  // reads this to resolve the GLOBAL default approval mode when no per-agent
  // override is present — without it in this allowlist, parseConfigEnv()
  // silently dropped the key on every real run (production .env parsing,
  // not the handcrafted config objects the unit tests pass directly), so a
  // user who enabled "always require manual approval" globally would still
  // have had their unattended orchestrated agents auto-approved here.
  'SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL',
  // social-post (2026-07-22): the user's silent-unattended-dispatch opt-in
  // list, the social twin of SHELLY_WEBHOOK_HOST_ALLOWLIST above.
  'SHELLY_SOCIAL_HOST_ALLOWLIST',
]);

// social-post (2026-07-22): dynamic per-connector config keys — ONLY the
// non-secret HOST/META entries are ever admitted into `config` (parseConfigEnv
// below). Secret fields (tokens/app passwords) are deliberately excluded and
// are read only by loadConnectorSecrets() inside the social-post dispatch
// itself, scoped to the one connector the plan names. No secret field name
// ends in HOST or META (lib/social-connectors.ts's SOCIAL_PLATFORM_FIELDS),
// so this pattern can never admit a secret.
function isSocialConnectorConfigKey(key) {
  return /^SOCIAL_CONNECTOR_[A-Z0-9_]+_(HOST|META)$/.test(key);
}

const REDACT_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{25,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

class PlanFailure extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'PlanFailure';
    this.status = options && options.status ? options.status : 'error';
    this.exitCode = options && typeof options.exitCode === 'number' ? options.exitCode : EXIT.PLAN_DENY;
    this.handled = options && options.handled === true;
  }
}

class ActionSkipped extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionSkipped';
  }
}

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

// app-act (Phase 4): resolves the literal "{{result}}" placeholder in every
// value of `params` against `preview` (already redact()-ed by previewText),
// then redact()s the resolved values a SECOND time as defense-in-depth --
// mirrors lib/agent-executor.ts's resolve_app_act_params exactly. This is the
// first agent action type that can publish content externally (a public X
// post), so it gets an extra redaction pass beyond relying solely on preview
// already being clean.
function resolveAppActParams(params, preview) {
  const out = {};
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      out[k] = typeof v === 'string' ? redact(v.split('{{result}}').join(preview)) : '';
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      args[key] = '1';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function appendJsonl(file, entry) {
  if (!file) return;
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (_) {
    // best-effort audit only
  }
}

function runtimePaths(home, agentId) {
  const shellyDir = path.join(home, '.shelly');
  const agentsDir = path.join(shellyDir, 'agents');
  const tmpDir = path.join(shellyDir, 'tmp');
  const locksDir = path.join(agentsDir, 'locks');
  const logsDir = path.join(agentsDir, 'logs');
  const logDir = path.join(logsDir, agentId);
  return {
    home,
    shellyDir,
    agentsDir,
    tmpDir,
    locksDir,
    logsDir,
    logDir,
    envFile: path.join(agentsDir, '.env'),
    dmPairingsFile: path.join(agentsDir, 'dm-pairings.json'),
    haltSentinel: path.join(agentsDir, '.halted'),
    resultFile: path.join(tmpDir, `agent-result-${agentId}.md`),
    lockFile: path.join(locksDir, `${agentId}.pid`),
    notifyFile: path.join(logDir, 'native-result-notification.json'),
    brokerAuditFile: path.join(logDir, 'agent-driver-audit.jsonl'),
    planAuditFile: path.join(logDir, 'plan-executor-audit.jsonl'),
    actionApprovalDir: path.join(agentsDir, 'action-approvals'),
    actionApprovalReplyDir: path.join(agentsDir, 'action-approval-replies'),
  };
}

function parseConfigEnv(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!CONFIG_ENV_KEYS.has(key) && !isSocialConnectorConfigKey(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1).replace(/'\\''/g, "'");
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    out[key] = val;
  }
  return out;
}

function validatePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new PlanFailure('plan is not an object');
  if (raw.kind !== PLAN_SPEC_KIND) throw new PlanFailure('plan kind mismatch');
  if (raw.schemaVersion !== PLAN_SPEC_SCHEMA_VERSION) throw new PlanFailure('plan schema version mismatch');
  if (!raw.agent || typeof raw.agent.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.agent.id)) {
    throw new PlanFailure('plan agent id is invalid');
  }
  if (typeof raw.prompt !== 'string') throw new PlanFailure('plan prompt is invalid');
  if (!raw.tool || typeof raw.tool.type !== 'string') throw new PlanFailure('plan tool is invalid');
  if (!raw.action || typeof raw.action.type !== 'string') throw new PlanFailure('plan action is invalid');
  if (
    raw.limits &&
    raw.limits.charLimit !== undefined &&
    (typeof raw.limits.charLimit !== 'number' || !Number.isFinite(raw.limits.charLimit))
  ) {
    throw new PlanFailure('plan char limit is invalid');
  }
  if (raw.tool.type === 'unsupported') throw new PlanFailure(redact(raw.tool.unsupportedReason || 'unsupported tool'), { exitCode: EXIT.TOOL_DENY });
  if (raw.action.type === 'unsupported') throw new PlanFailure(redact(raw.action.unsupportedReason || 'unsupported action'), { exitCode: EXIT.TOOL_DENY });
  return raw;
}

function loadPlan(planFile) {
  if (!planFile) throw new PlanFailure('--plan-file is required');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  } catch (e) {
    throw new PlanFailure(`cannot read plan: ${e && e.message ? e.message : e}`);
  }
  return validatePlan(parsed);
}

function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function previewText(text) {
  return redact(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Companion to previewText above, for contexts that need the COMPLETE
// validated content rather than a notification-length preview — the webhook
// dispatch's "result" field ships the full body, not just the 500-char
// preview sitting next to it in the same payload. Mirrors the legacy .sh
// executor's clean_result_full (2026-07-15 North Star P1 fix): same redact()
// call, no truncation. Found 2026-07-16 (adversarial review of the P0(c)
// unattended-webhook widening): write_webhook_payload's "result" field was
// reading raw resultText directly, unredacted — harmless while webhook was
// always refused unattended, but a real secret-leak risk once widened
// unattended dispatch made this reachable without a human ever seeing the
// payload first.
function fullResultText(text) {
  return redact(String(text || ''));
}

// Detect a response that echoes the step-prompt scaffold back verbatim (see
// buildStepPrompt, lib/agent-orchestration.ts) or is refusal boilerplate,
// rather than real content — the on-device failure mode found 2026-07-15 (a
// small local model echoing its own prompt + refusing on an x.post step,
// which then reached the user's confirm card as if it were real post
// content). Mirrors isLowQualityCompletion in lib/agent-escalation-ladder.ts
// (the canonical, unit-tested JS implementation) and is_low_quality_completion
// in the legacy .sh executor (lib/agent-executor.ts's generated script) — all
// three copies must stay in sync (2026-08-06: brought back into sync after a
// Fable5/Codex Hermes-parity re-review independently found this copy had
// stopped at the first two checks below while the other two grew six more
// failure-family detectors over 2026-07-23..28 — see
// lib/agent-escalation-ladder.ts's own doc comments on each pattern set for
// the full on-device repro history; ported verbatim here, not re-derived).
// Checked BEFORE any action that publishes outside the run's own log
// (webhook/dm-reply/app-act) in dispatchActionTrusted below, so a bad
// completion never reaches the human-facing approval card in the first
// place. Runs against the whitespace-collapsed `preview` (see previewText
// above), matching what the .sh path checks (clean_result_preview already
// tr's newlines to spaces there too).
const PROMPT_ECHO_MARKERS = [/#\s*Results from previous steps/, /#\s*This step\b/];
const REFUSAL_PATTERNS = [
  /\bas an ai\b/i,
  /\bi cannot generate\b/i,
  /\bi'm (?:not able|unable) to\b/i,
  /私は\s*ai\s*(なので|として)/i,
  /(生成|投稿)できません/,
];
const DATA_UNAVAILABLE_PATTERNS = [
  /取得できません/,
  /アクセスできず/,
  /アクセスできません/,
  /\bcould not (?:retrieve|access|obtain|fetch)\b/i,
  /\bcouldn't (?:retrieve|access|obtain|fetch)\b/i,
  /\bunable to (?:retrieve|access|obtain|fetch)\b/i,
  /\bno access to\b/i,
  /\bcannot access\b/i,
  /\bdoes not have access to\b/i,
];
const DATA_UNAVAILABLE_MAX_LEN = 200;
const ACTION_META_COMMENTARY_PATTERNS = [
  /(?:通知|お知らせ|メッセージ)を(?:送信します|送信しました|お送りします|お送りしました|完了します|完了しました|実行します|実行しました)/,
  /\bnotification (?:has been |is |was )?(?:sent|completed|delivered)\b/i,
  /\b(?:sending|will send|i(?:'ll| will) send) the notification\b/i,
  /\btask (?:has been |is |was )?completed\b/i,
];
const FABRICATED_EXECUTION_PATTERNS = [
  /\b(?:command|script)\s+(?:was\s+)?executed\b[\s\S]{0,100}\bstatus:\s*success\b/i,
  /\bstatus:\s*success\b[\s\S]{0,100}\b(?:command|script)\s+(?:was\s+)?executed\b/i,
  /\bfile\s+(?:was\s+|is\s+)?created\s+at\b[\s\S]{0,100}\bstatus:\s*success\b/i,
  /\bstatus:\s*success\b[\s\S]{0,100}\bfile\s+(?:was\s+|is\s+)?created\b/i,
  /(?:コマンド|スクリプト)を実行(?:しました|完了しました)[\s\S]{0,60}(?:成功しました|ステータス[:：]\s*成功)/,
  /(?:成功しました|ステータス[:：]\s*成功)[\s\S]{0,60}(?:コマンド|スクリプト)を実行(?:しました|完了しました)/,
  /(?:^|\n)\s*(?:root|\w+)@[\w.-]+:[^\n#$]{0,60}[#$]\s+\S[^\n]{0,120}[>|][^\n]{0,80}/,
];
const BARE_SHELL_COMMAND_VERB_RE =
  /^(?:sudo\s+)?(?:echo|printf|cat|touch|mkdir|rm|mv|cp|curl|wget|tee|dd|chmod|chown|kill|pkill|git|npm|npx|pip3?|python3?|node|bash|sh)\b/i;
const BARE_SHELL_COMMAND_SYNTAX_RE = /[>|;&]/;
const BARE_REDIRECT_ONLY_RE = /^[>|]\s*\S/;

function isBareShellCommandLine(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.length > 200) return false;
  if (BARE_REDIRECT_ONLY_RE.test(trimmed)) return true;
  return BARE_SHELL_COMMAND_VERB_RE.test(trimmed) && BARE_SHELL_COMMAND_SYNTAX_RE.test(trimmed);
}

const FENCED_BLOCK_RE = /^```(\w*)\r?\n([\s\S]*?)\r?\n?```$/;
const FENCE_SHELL_LANG_RE = /^(?:|text|bash|sh|shell|console|plaintext|plain|terminal)$/i;

function isFencedShellCommandBlock(text) {
  const trimmed = text.trim();
  const match = FENCED_BLOCK_RE.exec(trimmed);
  if (!match) return false;
  if (!FENCE_SHELL_LANG_RE.test(match[1])) return false;
  const lines = match[2]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.some(
    (line) => BARE_REDIRECT_ONLY_RE.test(line) || (BARE_SHELL_COMMAND_VERB_RE.test(line) && BARE_SHELL_COMMAND_SYNTAX_RE.test(line)),
  );
}

const EXECUTION_ANNOUNCEMENT_RE =
  /(?:コマンド|スクリプト)(?:を|で)[^\n。]{0,12}実行し(?:ます|ました)|\bi(?:'ll| will) (?:now )?(?:run|execute)\b|\bexecuting the (?:command|script)s?\b/i;
const ANY_FENCED_BLOCK_RE = /```(\w*)[^\S\n]*\r?\n([\s\S]*?)```/g;

function hasFencedShellCommandContent(text) {
  ANY_FENCED_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = ANY_FENCED_BLOCK_RE.exec(text)) !== null) {
    if (!FENCE_SHELL_LANG_RE.test(match[1])) continue;
    const lines = match[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (
      lines.some(
        (line) => BARE_REDIRECT_ONLY_RE.test(line) || (BARE_SHELL_COMMAND_VERB_RE.test(line) && BARE_SHELL_COMMAND_SYNTAX_RE.test(line)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function isFencedShellExecutionNarrative(text) {
  if (!EXECUTION_ANNOUNCEMENT_RE.test(text)) return false;
  return hasFencedShellCommandContent(text);
}

function isLowQualityCompletion(text) {
  if (typeof text !== 'string') return false;
  // Empty/whitespace-only is ALSO low-quality (2026-07-15): a codex-driver
  // step can complete successfully with status "success" yet yield a fully
  // empty preview once its telemetry is stripped (see the .sh executor's
  // clean_result_preview) — previously this matched neither pattern set and
  // silently reached the confirm card blank instead of failing loud.
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PROMPT_ECHO_MARKERS.some((pattern) => pattern.test(text))) return true;
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (trimmed.length <= DATA_UNAVAILABLE_MAX_LEN && DATA_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (trimmed.length <= DATA_UNAVAILABLE_MAX_LEN && ACTION_META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (FABRICATED_EXECUTION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (isBareShellCommandLine(text)) return true;
  if (isFencedShellCommandBlock(text)) return true;
  if (isFencedShellExecutionNarrative(text)) return true;
  return false;
}

// DEFERRED.md「重複コンテンツ検知の欠如(P1)」— ported verbatim from
// lib/agent-escalation-ladder.ts's isDuplicateOfPriorStep/
// normalizeForDuplicateCheck (see that file's doc comment for the full
// on-device incident this catches: an orchestration step whose completion is
// a near-verbatim repeat of the PRIOR step, most often a model that ignored
// its own instruction and echoed the context it was given back). Exported
// for host unit tests only, same convention as isLowQualityCompletion above.
const DUPLICATE_CHECK_MIN_LEN = 20;
const DUPLICATE_CONTAINMENT_MIN_RATIO = 0.6;

function normalizeForDuplicateCheck(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDuplicateOfPriorStep(text, priorStepContent) {
  if (!text || !priorStepContent) return false;
  const a = normalizeForDuplicateCheck(text);
  const b = normalizeForDuplicateCheck(priorStepContent);
  if (a.length < DUPLICATE_CHECK_MIN_LEN || b.length < DUPLICATE_CHECK_MIN_LEN) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length >= DUPLICATE_CONTAINMENT_MIN_RATIO) {
    return true;
  }
  return false;
}

// ─── Orchestration chain mode (Increment 2, 2026-07-15) ────────────────────
//
// Pure, directly-testable ports of lib/agent-orchestration.ts's step-sequencing
// helpers (buildStepPrompt / nextStepGate / reduceStatus / combineFinalPreview),
// used ONLY when the loaded PlanSpec carries the additive `steps` field Increment
// 1 (lib/agent-plan-spec.ts's AgentPlanSpecV1.steps) populates for orchestrated
// agents. A plan with no `steps` field never reaches any of this — run()'s
// single-shot branch below is byte-identical to before this increment.
//
// Deliberately v1-scoped (see docs/superpowers/DEFERRED.md's 2026-07-15 "P0(c)
// 設計調査完了" entry, step ⑤): no per-step ladder/escalation and no per-step
// tool override (NormalizedStep.tool, Phase 5) — every step in a chain uses the
// SAME plan.tool the whole plan was built with. Chaining adds no privilege
// beyond a single run (same invariant lib/agent-orchestration.ts's file header
// states for the attended path): each step is still one broker-mediated model
// call, gated by the same budget/time caps, with the real action dispatched
// only once, on the final step.
//
// The bound constants below MUST stay numerically in sync with
// lib/agent-orchestration.ts's same-named exports — asserted directly (not by
// string-matching source text) in __tests__/plan-executor-parity.test.ts, since
// both sides are reachable from a Jest test via `require`/`import`.
const DEFAULT_MAX_STEPS = 6;
const HARD_MAX_STEPS = 10;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000; // 30 min
const HARD_TOTAL_TIMEOUT_MS = 60 * 60_000; // 1 h ceiling
const STEP_PROMPT_MAX_CHARS = 6000;
const STEP_PROMPT_MAX_RESULT_CARRY_CHARS = 1500;
const STEP_PREVIEW_MAX_CHARS = 500;
// Mirrors lib/agent-orchestration.ts's MAX_STEP_INSTRUCTION_CHARS (module-local
// there too — not exported, so this is its own numerically-in-sync copy, same
// convention as the STEP_* constants above).
const STEP_INSTRUCTION_MAX_CHARS = 500;

function clampToRange(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Defense-in-depth re-clamp of the ALREADY-resolved budget carried in the
// on-disk PlanSpec (plan.steps.budget, computed once at plan-build time by
// lib/agent-orchestration.ts's resolveBudget()). The executor does not trust
// the plan file to have honored these bounds — a stale plan written by an
// older/newer app version, or a corrupted field, must still fail toward the
// SAME hard ceilings resolveBudget() itself enforces, not toward "unbounded".
function resolveStepBudget(rawBudget) {
  const rawMaxSteps = rawBudget && Number.isFinite(rawBudget.maxSteps) ? Math.floor(rawBudget.maxSteps) : DEFAULT_MAX_STEPS;
  const rawTimeout = rawBudget && Number.isFinite(rawBudget.totalTimeoutMs) ? Math.floor(rawBudget.totalTimeoutMs) : DEFAULT_TOTAL_TIMEOUT_MS;
  return {
    maxSteps: clampToRange(rawMaxSteps || 1, 1, HARD_MAX_STEPS),
    totalTimeoutMs: clampToRange(rawTimeout || DEFAULT_TOTAL_TIMEOUT_MS, 1_000, HARD_TOTAL_TIMEOUT_MS),
  };
}

// Verbatim port of lib/agent-orchestration.ts's nextStepGate: decide whether to
// launch the next step. REFUSES (never hangs) when the prior step failed, the
// step budget is reached, or the time budget is exceeded.
function nextStepGate(opts) {
  if (opts.priorFailed) return { proceed: false, reason: 'previous step failed — chain stopped' };
  if (opts.stepIndex >= opts.budget.maxSteps) {
    return { proceed: false, reason: `step budget reached (${opts.budget.maxSteps})` };
  }
  if (opts.now - opts.startedAtMs > opts.budget.totalTimeoutMs) {
    return { proceed: false, reason: 'total time budget exceeded' };
  }
  return { proceed: true };
}

// Verbatim port of lib/agent-orchestration.ts's buildStepPrompt: the base
// prompt + the carried (bounded) prior results + this step's instruction.
//
// 2026-08-04 fix (mirrors buildStepPrompt's matching fix in
// lib/agent-orchestration.ts, found on the SAME real on-device run that
// motivated it): the previous version composed the full string then sliced
// the WHOLE thing to STEP_PROMPT_MAX_CHARS from the front, so a long enough
// carried-results block could push "# This step\n{instruction}" — always the
// last segment — entirely past the cutoff, leaving the step with prior-step
// content and no live instruction. The instruction's budget is now reserved
// first; only the head+carried prefix is truncated to whatever remains.
function buildStepPrompt(basePrompt, instruction, priorResults) {
  const tail = `# This step\n${instruction.trim()}`.slice(0, STEP_PROMPT_MAX_CHARS);
  const headBudget = Math.max(0, STEP_PROMPT_MAX_CHARS - tail.length);
  const head = basePrompt.trim() ? `${basePrompt.trim()}\n\n` : '';
  const carried = priorResults.length
    ? `# Results from previous steps\n${priorResults
        .map((r, i) => `## Step ${i + 1}\n${String(r).replace(/\s+/g, ' ').trim().slice(0, STEP_PROMPT_MAX_RESULT_CARRY_CHARS)}`)
        .join('\n\n')}\n\n---\n\n`
    : '';
  return `${`${head}${carried}`.slice(0, headBudget)}${tail}`;
}

// Verbatim port of lib/agent-orchestration.ts's reduceStatus. Precedence:
// any hard 'error' -> error; else any transient 'unavailable' -> unavailable
// (excluded from the circuit breaker); all 'skipped' -> skipped; else success.
function reduceStatus(records) {
  if (records.length === 0) return 'skipped';
  if (records.some((s) => s.status === 'error')) return 'error';
  if (records.some((s) => s.status === 'unavailable')) return 'unavailable';
  if (records.every((s) => s.status === 'skipped')) return 'skipped';
  return 'success';
}

// Verbatim port of lib/agent-orchestration.ts's combineFinalPreview: the single
// run-log preview for an orchestrated run (bounded to STEP_PREVIEW_MAX_CHARS).
function combineFinalPreview(records, totalSteps) {
  if (records.length === 0) return '';
  // totalSteps (2026-08-03): see lib/agent-orchestration.ts's combineFinalPreview
  // doc comment — a fail-fast chain's records array is "attempted so far", not
  // the planned total, so a 5-step chain dying on step 1 used to render
  // "Step 1/1 failed" instead of "Step 1/5 failed".
  const total = totalSteps === undefined ? records.length : totalSteps;
  const failed = records.find((s) => s.status === 'error');
  if (failed) {
    return `Step ${failed.index + 1}/${total} failed: ${failed.outputPreview}`.slice(0, STEP_PREVIEW_MAX_CHARS);
  }
  const transient = records.find((s) => s.status === 'unavailable');
  if (transient) {
    return `Step ${transient.index + 1}/${total} temporarily unavailable (web backend busy): ${transient.outputPreview}`.slice(
      0,
      STEP_PREVIEW_MAX_CHARS,
    );
  }
  const last = [...records].reverse().find((s) => s.status === 'success');
  const head = `Completed ${records.length} step(s). `;
  return `${head}${last ? last.outputPreview : ''}`.slice(0, STEP_PREVIEW_MAX_CHARS);
}

// Verbatim port of lib/agent-orchestration.ts's apiCallLabel: a human-readable,
// display-only label for an api-call step. NEVER sent to a model.
function apiCallLabel(cfg) {
  return `${cfg.method} ${cfg.host}${cfg.path}`.slice(0, STEP_INSTRUCTION_MAX_CHARS);
}

// Verbatim port of lib/agent-orchestration.ts's resolveApiCallTemplate: plain
// string-replace of the literal "{{result}}" placeholder, no template engine.
// Callers URL-encode lastResult themselves before calling this for `path`
// (this function does no encoding of its own — bodyTemplate must NOT be
// URL-encoded).
function resolveApiCallTemplate(template, lastResult) {
  return String(template == null ? '' : template).split('{{result}}').join(lastResult);
}

function resolveCharLimit(plan) {
  const raw = plan && plan.limits ? plan.limits.charLimit : undefined;
  if (raw === undefined || raw === null) return 0;
  const limit = Number(raw);
  if (!Number.isFinite(limit)) return 0;
  return Math.min(Math.max(Math.floor(limit), 40), 4000);
}

// X-weighted length (full-width = 2, everything else = 1) — mirrors
// lib/agent-pipeline-presets.ts's xWeightedLength/enforceCharLimit. Kept in
// sync manually (three copies: the .ts source, this file, and
// lib/agent-executor.ts's embedded enforce_char_limit_text Node script)
// since these run in three different execution contexts with no shared
// module system.
const PLAN_FULLWIDTH_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
function planXWeightedLength(s) {
  let total = 0;
  for (const ch of Array.from(s)) total += PLAN_FULLWIDTH_RE.test(ch) ? 2 : 1;
  return total;
}

function enforcePlanCharLimit(plan, text) {
  const limit = resolveCharLimit(plan);
  const str = String(text || '');
  if (!limit || planXWeightedLength(str) <= limit) return str;
  const ellipsis = '…';
  const budget = Math.max(limit - 1, 1);
  const chars = Array.from(str);
  let acc = 0;
  let cutIdx = chars.length;
  for (let i = 0; i < chars.length; i += 1) {
    const w = PLAN_FULLWIDTH_RE.test(chars[i]) ? 2 : 1;
    if (acc + w > budget) {
      cutIdx = i;
      break;
    }
    acc += w;
  }
  const head = chars.slice(0, cutIdx);
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (terminators.has(head[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= 0 && planXWeightedLength(head.slice(0, cut + 1).join('')) >= Math.floor(acc * 0.6)) {
    return head.slice(0, cut + 1).join('').trimEnd();
  }
  return head.join('').trimEnd() + ellipsis;
}

function sanitizeRelPath(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9 _./{}-]+/g, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned || '{date}-{slug}';
}

function uniqueRoots(roots) {
  const out = [];
  for (const root of roots) {
    const value = String(root || '').trim();
    if (!value || value[0] !== '/') continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function scopedRoots(paths, config) {
  const obsidianRoot = config.OBSIDIAN_VAULT_PATH || '/sdcard/Documents/ObsidianVault';
  const customRoot = config.SHELLY_AGENT_CUSTOM_PATH || path.join(paths.home, 'agent-output');
  const contentProject = config.SHELLY_CONTENT_PROJECT || path.join(paths.home, 'projects/shelly-content-studio');
  return uniqueRoots([
    paths.tmpDir,
    path.join(paths.home, 'agent-output'),
    path.join(paths.home, 'projects/shelly-content-studio'),
    contentProject,
    obsidianRoot,
    customRoot,
  ]);
}

function writeRootsFile(paths, roots) {
  const rootsFile = path.join(paths.tmpDir, `plan-roots-${process.pid}-${Date.now()}.txt`);
  writeAtomic(rootsFile, roots.join('\n') + '\n');
  return rootsFile;
}

function childEnv(paths, opts) {
  const libDir = opts.libDir || process.env.SHELLY_LIB_DIR || process.env.LD_LIBRARY_PATH || '';
  const env = Object.assign({}, process.env, {
    HOME: paths.home,
    SHELLY_LIB_DIR: libDir,
  });
  if (libDir) {
    env.LD_LIBRARY_PATH = libDir;
    env.PATH = `${libDir}:${libDir}/node_modules/npm/bin:${libDir}/node_modules/.bin:${env.PATH || ''}`;
  }
  // The broker is a leaf bionic-node process: its workspace.exec curates commands
  // in-node (cat/ls/grep/printf/… implemented in JS) and never execs an app-data
  // binary, so it does NOT need the Knox exec-wrapper. Inheriting
  // LD_PRELOAD=libexec_wrapper.so (set globally by shelly-exec.c on the launching
  // shell) BREAKS node's OpenSSL config load on-device — verified on hardware:
  // "BIO_new_file:Bad file descriptor" on openssl.cnf → node aborts → every broker
  // call fails. Drop it here (mirrors the llama-server launcher, which unsets
  // LD_PRELOAD before its own linker64 launch for the same class of reason).
  delete env.LD_PRELOAD;
  return env;
}

function nodeInvocation(script, args, paths, opts) {
  const libDir = opts.libDir || process.env.SHELLY_LIB_DIR || '';
  const androidNode = libDir ? path.join(libDir, 'node') : '';
  if (androidNode && fs.existsSync(androidNode) && fs.existsSync('/system/bin/linker64')) {
    return { file: '/system/bin/linker64', args: [androidNode, script].concat(args) };
  }
  return { file: process.execPath, args: [script].concat(args) };
}

function runBroker(paths, opts, brokerArgs) {
  const broker = opts.broker || path.join(paths.home, '.shelly-capability-broker.js');
  if (!fs.existsSync(broker)) throw new PlanFailure('capability broker is missing', { exitCode: EXIT.TOOL_DENY });
  const invocation = nodeInvocation(broker, brokerArgs, paths, opts);
  const result = spawnSync(invocation.file, invocation.args, {
    env: childEnv(paths, opts),
    encoding: 'utf8',
    timeout: 700000,
  });
  if (result.error) {
    throw new PlanFailure(`capability broker spawn failed: ${redact(result.error.message)}`, { exitCode: EXIT.TOOL_DENY });
  }
  return result.status == null ? EXIT.INTERNAL : result.status;
}

function writeJsonRequest(file, payload) {
  writeAtomic(file, JSON.stringify(payload));
}

function chatEndpoint(base) {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (!url) return 'http://127.0.0.1:8080/v1/chat/completions';
  if (/\/v1\/chat\/completions$/.test(url)) return url;
  return `${url}/v1/chat/completions`;
}

function isLoopbackUrl(urlText) {
  try {
    const u = new URL(urlText);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch (_) {
    return false;
  }
}

function modelRequest(plan, config) {
  const prompt = plan.prompt;
  switch (plan.tool.type) {
    case 'local': {
      const url = chatEndpoint(config.LOCAL_LLM_URL || 'http://127.0.0.1:8080');
      if (!isLoopbackUrl(url)) throw new PlanFailure('local PlanSpec endpoint must be loopback', { exitCode: EXIT.TOOL_DENY });
      return {
        url,
        authRef: '',
        body: {
          model: config.LOCAL_LLM_MODEL || plan.tool.model || 'Qwen3.5-0.8B-Q4_K_M',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
        },
      };
    }
    case 'gemini-api': {
      const model = config.GEMINI_MODEL || plan.tool.model || 'gemini-2.5-flash';
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        authRef: 'gemini',
        body: { contents: [{ parts: [{ text: prompt }] }] },
      };
    }
    case 'perplexity':
      return openAiCompatRequest('https://api.perplexity.ai/chat/completions', 'perplexity', config.PERPLEXITY_MODEL || plan.tool.model || 'sonar', prompt);
    case 'cerebras':
      return openAiCompatRequest('https://api.cerebras.ai/v1/chat/completions', 'cerebras', config.CEREBRAS_MODEL || plan.tool.model || 'gpt-oss-120b', prompt);
    case 'groq':
      return openAiCompatRequest('https://api.groq.com/openai/v1/chat/completions', 'groq', config.GROQ_MODEL || plan.tool.model || 'llama-3.3-70b-versatile', prompt);
    default:
      throw new PlanFailure(`unsupported PlanSpec tool: ${plan.tool.type}`, { exitCode: EXIT.TOOL_DENY });
  }
}

function openAiCompatRequest(url, authRef, model, prompt) {
  return {
    url,
    authRef,
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

function brokerHttp(paths, opts, plan, request) {
  const bodyFile = path.join(paths.tmpDir, `plan-request-${plan.agent.id}-${process.pid}.json`);
  writeJsonRequest(bodyFile, request.body);
  try {
    return brokerHttpBodyFile(paths, opts, plan, {
      url: request.url,
      authRef: request.authRef,
      bodyFile,
      approved: request.approved,
      timeoutSeconds: request.timeoutSeconds,
    });
  } finally {
    try {
      fs.unlinkSync(bodyFile);
    } catch (_) {}
  }
}

function brokerHttpBodyFile(paths, opts, plan, request) {
  const outFile = path.join(paths.tmpDir, `plan-response-${plan.agent.id}-${process.pid}.json`);
  const errFile = path.join(paths.tmpDir, `plan-response-${plan.agent.id}-${process.pid}.err`);
  const args = [
    '--op', 'http.request',
    // Generalized (api-call v1) to carry an optional request.method — default
    // 'POST' so every pre-existing call site (which never passes method)
    // behaves identically to before. The broker already tolerates GET with no
    // body (shelly-capability-broker.js only reads --body-file when method
    // !== 'GET'), so only push --body-file when one is actually supplied.
    '--method', request.method || 'POST',
    '--url', request.url,
    '--secret-env-file', paths.envFile,
    '--audit-log', paths.brokerAuditFile,
    '--budget-file', path.join(paths.tmpDir, `cap-budget-${plan.agent.id}.json`),
    '--timeout-seconds', String(request.timeoutSeconds || (plan.limits && plan.limits.timeoutSeconds ? plan.limits.timeoutSeconds : 600)),
    '--out', outFile,
    '--err', errFile,
  ];
  if (request.bodyFile) args.push('--body-file', request.bodyFile);
  // social-post (2026-07-22): connector Bearer/Basic headers travel via a
  // 0600 JSON header file the broker merges before its own AUTH_REFS
  // resolution — see the broker's --header-file handling for the guarantees.
  if (request.headerFile) args.push('--header-file', request.headerFile);
  if (request.authRef) args.push('--auth-ref', request.authRef);
  if (request.approved) args.push('--approved', '1');
  if (opts.tainted) args.push('--tainted', '1');
  const rc = runBroker(paths, opts, args);
  const response = readFile(outFile);
  const errorText = readFile(errFile);
  if (rc !== 0) {
    const status = rc === 23 ? 'unavailable' : 'error';
    throw new PlanFailure(`HTTP broker failed rc=${rc}: ${redact(errorText || response).slice(0, 300)}`, {
      status,
      exitCode: EXIT.OK,
      handled: true,
    });
  }
  return response;
}

// api-call (v1): dispatch a structured HTTP call to an allowlisted host via
// the SAME capability broker every other egress already goes through — this
// is a new AUTHORING surface (lib/capability-envelope.ts's host allowlist +
// AUTH_REFS still fully own enforcement), not a new enforcement path.
function dispatchApiCallRequest(paths, opts, plan, apiCall, resolvedBodyText) {
  const url = `https://${apiCall.host}${apiCall.path}`;
  // Tainted-run defense-in-depth (2026-07-16 adversarial security review
  // finding): classifyEgress's taint gate (lib/capability-envelope.ts) only
  // requires human approval for a tainted run when EITHER the host is
  // non-allowlisted OR a secret (authRef) is being spent (the documented
  // "trifecta" — see the comment on the broker call below). It does NOT gate
  // `tainted === true, authRef absent, host allowlisted` — that combination
  // falls through to classifyEgress's own 'allow' return. Every PRE-EXISTING
  // caller of the broker's http.request op that reaches a REMOTE allowlisted
  // host always sets a non-empty authRef (modelRequest() hardcodes one for
  // every non-local tool: gemini/perplexity/cerebras/groq), so this exact
  // combination was structurally unreachable before this feature — api-call
  // is the first caller that can legitimately omit authRef while still
  // targeting a remote host (a public/no-auth API is a valid, intended use).
  // That reopens exactly the "poisoned notification directs the agent to
  // leak/post its own output to a real destination" case the taint gate
  // exists to close (see classifyEgress's own doc comment), just without a
  // credential attached. Refuse here, in the executor, rather than widening
  // classifyEgress itself — that is a SHARED primitive every other action
  // type also depends on, deliberately left untouched by this feature (the
  // implementation plan scoped api-call to REUSE existing broker enforcement,
  // not modify it). Loopback is exempt: no network boundary is crossed.
  if (opts.tainted && !apiCall.authRef && !isLoopbackUrl(url)) {
    throw new PlanFailure(
      'api-call to a remote host with no credential is refused on a tainted (notification-triggered) run — requires an authRef or a non-tainted run',
      { handled: true },
    );
  }
  let bodyFile = null;
  if (apiCall.method === 'POST' && resolvedBodyText) {
    bodyFile = path.join(paths.tmpDir, `plan-apicall-${plan.agent.id}-${process.pid}.json`);
    writeAtomic(bodyFile, resolvedBodyText);
  }
  try {
    return brokerHttpBodyFile(paths, opts, plan, {
      url,
      authRef: apiCall.authRef,
      bodyFile,
      method: apiCall.method,
      // Deliberately NOT approved:true. Unlike webhook (whose destination is
      // user-supplied and usually non-allowlisted, so approved:true
      // compensates for that), api-call's host is ALWAYS pre-allowlisted (UI
      // constrains it), so classifyEgress only ever returns 'approve' here in
      // the tainted+secret "trifecta" case (guarded above for the
      // tainted+NO-secret case too) — exactly the case that must stay
      // fail-closed. Do not add approved:true here; that would silently
      // defeat the taint gate. See __tests__/plan-executor-orchestration-chain.test.ts's
      // tainted+authRef regression test and its tainted+no-authRef sibling.
    });
  } finally {
    if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (_) {} }
  }
}

// In-process cache of X's rotated OAuth state, keyed by connectorId — Codex
// review finding: a multi-action PlanSpec with two social-post actions
// against the SAME X connector (dispatchActionsTrusted's fan-out, all within
// this one executor process/invocation) would otherwise refresh twice. X
// rotates the refresh token on EVERY exchange, so the first refresh
// invalidates the token the second call would still read from `secrets`
// (loaded once per-action from the on-disk .env, which the queued
// writePendingConnectorSecretUpdate file hasn't been drained into yet — that
// only happens on the RN layer's next app launch) — the second refresh
// attempt would fail closed with invalid_grant. Reusing the in-memory
// accessToken for a same-run repeat avoids a second (redundant and
// self-defeating) token exchange entirely.
const xAccessTokenCache = new Map();

// Writes a one-shot "please update this SecureStore field" file for the RN
// layer to drain (app/_layout.tsx polls the same directory the deep-link
// queue already uses this pattern for) — JS-executor counterpart of the .sh
// executor's write_pending_connector_secret_update (lib/agent-executor.ts).
// Needed because a detached background process (this executor) can write
// files but cannot call into Expo SecureStore directly. Best-effort: a
// failure to persist here means the NEXT dispatch's token refresh fails
// closed with a clear "reconnect it in Settings" error rather than silently
// posting with a stale/invalid token.
function writePendingConnectorSecretUpdate(paths, connectorId, field, value) {
  try {
    const dir = path.join(paths.home, '.shelly/pending-connector-secret-updates');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${connectorId}-${field}-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ connectorId, field, value }), { mode: 0o600 });
  } catch (_) {
    // best-effort, see doc comment above
  }
}

// Codex review finding (2026-08-06): writePendingConnectorSecretUpdate ALONE
// only queues the rotated value for the RN layer to drain into SecureStore
// on next app launch — but the NEXT scheduled PlanSpec run (which may fire
// again before the app is ever foregrounded) re-reads secrets straight from
// this same on-disk envFile, which the queued update hasn't reached yet.
// That makes X's mandatory refresh-token rotation (every exchange invalidates
// the previous token) a "works once, then breaks until foregrounded" trap
// for a genuinely unattended schedule. This synchronously rewrites the ONE
// matching `KEY='value'` line in envFile in place — belt-and-suspenders with
// the pending-update queue above (SecureStore/Settings-UI still needs that
// eventual-consistency path; this closes the gap for the executor's OWN next
// invocation, which never goes through SecureStore at all). Escaping mirrors
// loadConnectorSecrets' single-quote convention (its unescape is
// `val.replace(/'\\''/g, "'")`) so a value containing a literal `'` survives
// a read-modify-write round trip.
function updateEnvFileSecret(envFile, key, value) {
  try {
    let text = '';
    try {
      text = fs.readFileSync(envFile, 'utf8');
    } catch (_) {
      return;
    }
    const escaped = String(value).replace(/'/g, "'\\''");
    const line = `${key}='${escaped}'`;
    const lines = text.split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`export ${key}=`)) {
        lines[i] = line;
        found = true;
        break;
      }
    }
    if (!found) lines.push(line);
    writeAtomic(envFile, lines.join('\n'));
    fs.chmodSync(envFile, 0o600);
  } catch (_) {
    // best-effort — the pending-update queue above is the fallback path.
  }
}

// social-post (2026-07-22): compose the per-platform request. Returns
// { url, body, headers } — headers null/{} when the platform authenticates
// via the URL (discord/slack webhooks, telegram bot token) or the body
// (misskey's "i"). Throws PlanFailure (handled) on a missing secret or a
// connector-host mismatch. Bluesky performs its createSession exchange HERE
// (through the same broker primitive) so the caller's single dispatch is the
// final createRecord call. Field-name keys are the uppercased env suffixes
// produced by lib/social-connectors.ts's socialConnectorEnvVar.
//
// `isArticle` (2026-08-06): X-only flag threaded from
// plan.action.socialPost.isArticle. X's long-form Articles endpoint needs a
// title + DraftJS content_state built from the post text (see the .sh
// executor's dispatch_social_post x) case), which this JS/unattended
// executor does not implement — refused with a clear message rather than
// silently posting the wrong shape. Regular tweets (POST /2/tweets) ARE
// implemented here: this closes the DEFERRED-tracked asymmetry where an
// orchestrated/scheduled X agent hard-failed with "Unsupported social
// platform: x" while the same platform worked from the manual/.sh path.
function buildSocialPostRequest(paths, opts, plan, platform, host, text, secrets, isArticle) {
  const missing = (what) => new PlanFailure(`${what} — re-register the connector in Settings.`, { handled: true });
  const hostMismatch = () =>
    new PlanFailure("Social-post destination host does not match the connector's registered host.", { handled: true });
  if (platform === 'discord') {
    const url = String(secrets.WEBHOOKURL || '');
    if (!url) throw missing('Discord connector is missing its webhook URL secret');
    if (!socialUrlMatchesHost(url, host)) throw hostMismatch();
    // Discord's payload field is literally "content".
    return { url, body: { content: text }, headers: null };
  }
  if (platform === 'slack') {
    const url = String(secrets.WEBHOOKURL || '');
    if (!url) throw missing('Slack connector is missing its webhook URL secret');
    if (!socialUrlMatchesHost(url, host)) throw hostMismatch();
    return { url, body: { text }, headers: null };
  }
  if (platform === 'telegram') {
    const token = String(secrets.BOTTOKEN || '');
    const chatId = String(secrets.CHATID || '');
    if (!token || !chatId) throw missing('Telegram connector is missing its bot token or chat id');
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    // Catches a telegram connector registered against any host other than
    // api.telegram.org (the URL is fixed; the connector host must agree).
    if (!socialUrlMatchesHost(url, host)) throw hostMismatch();
    return { url, body: { chat_id: chatId, text }, headers: null };
  }
  if (platform === 'mastodon') {
    const token = String(secrets.ACCESSTOKEN || '');
    if (!token) throw missing('Mastodon connector is missing its access token');
    return {
      url: `https://${host}/api/v1/statuses`,
      body: { status: text },
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  if (platform === 'misskey') {
    const token = String(secrets.APITOKEN || '');
    if (!token) throw missing('Misskey connector is missing its API token');
    // Misskey convention: the auth token travels IN the body ("i"), not a header.
    return { url: `https://${host}/api/notes/create`, body: { i: token, text }, headers: null };
  }
  if (platform === 'wordpress') {
    const username = String(secrets.USERNAME || '');
    const appPassword = String(secrets.APPPASSWORD || '');
    if (!username || !appPassword) throw missing('WordPress connector is missing its username or application password');
    const basic = Buffer.from(`${username}:${appPassword}`).toString('base64');
    const title = (text.split('\n')[0] || '').slice(0, 80).trim() || 'Shelly agent post';
    // "status":"publish" matches this action type's auto-POST intent — see
    // the .sh executor's matching comment in dispatch_social_post.
    return {
      url: `https://${host}/wp-json/wp/v2/posts`,
      body: { title, content: text, status: 'publish' },
      headers: { Authorization: `Basic ${basic}` },
    };
  }
  if (platform === 'bluesky') {
    const handle = String(secrets.HANDLE || '');
    const appPassword = String(secrets.APPPASSWORD || '');
    if (!handle || !appPassword) throw missing('Bluesky connector is missing its handle or app password');
    // Step 1: createSession — exchanges handle+app-password for accessJwt+did.
    const sessionBodyFile = path.join(paths.tmpDir, `plan-social-session-${plan.agent.id}-${process.pid}.json`);
    fs.writeFileSync(sessionBodyFile, JSON.stringify({ identifier: handle, password: appPassword }), { mode: 0o600 });
    let sessionRaw = '';
    try {
      sessionRaw = brokerHttpBodyFile(paths, opts, plan, {
        url: `https://${host}/xrpc/com.atproto.server.createSession`,
        bodyFile: sessionBodyFile,
        approved: true,
        timeoutSeconds: 30,
      });
    } catch (e) {
      const detail = e instanceof PlanFailure ? e.message : String(e);
      throw new PlanFailure(`Bluesky session exchange failed: ${redact(detail)}`, { handled: true });
    } finally {
      try { fs.unlinkSync(sessionBodyFile); } catch (_) {}
    }
    let session = null;
    try { session = JSON.parse(sessionRaw); } catch (_) { session = null; }
    const accessJwt = session && typeof session.accessJwt === 'string' ? session.accessJwt : '';
    const did = session && typeof session.did === 'string' ? session.did : '';
    // Fail closed when either field is absent — never post with a partial session.
    if (!accessJwt || !did) throw new PlanFailure('Bluesky session exchange failed: response was missing accessJwt/did.', { handled: true });
    // Step 2: createRecord with the session Bearer.
    return {
      url: `https://${host}/xrpc/com.atproto.repo.createRecord`,
      body: {
        repo: did,
        collection: 'app.bsky.feed.post',
        record: { text, createdAt: new Date().toISOString() },
      },
      headers: { Authorization: `Bearer ${accessJwt}` },
    };
  }
  if (platform === 'x') {
    if (isArticle) {
      throw new PlanFailure(
        'X article (long-form) posting is not supported for unattended/scheduled runs yet — use manual dispatch, or a regular (non-article) post.',
        { handled: true },
      );
    }
    const connectorId = plan.action.socialPost.connectorId;
    let accessToken = xAccessTokenCache.get(connectorId) || '';
    if (!accessToken) {
      // OAuth 2.0 PKCE. Every dispatch exchanges the stored refresh token for
      // a fresh access token — mirrors the .sh executor's x) case exactly
      // (same rationale: X access tokens expire in ~2h, an unattended agent
      // may run for weeks, and X rotates the refresh token on EVERY exchange,
      // so the rotated token must be persisted or the very next post fails
      // closed with invalid_grant).
      const refreshToken = String(secrets.REFRESHTOKEN || '');
      const clientId = String(secrets.CLIENTID || '');
      if (!refreshToken || !clientId) {
        throw new PlanFailure('X connector is missing its refresh token or client id — reconnect it in Settings.', { handled: true });
      }
      const formBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(clientId)}`;
      const tokenBodyFile = path.join(paths.tmpDir, `plan-social-x-token-${plan.agent.id}-${process.pid}.json`);
      const tokenHeaderFile = path.join(paths.tmpDir, `plan-social-x-token-headers-${plan.agent.id}-${process.pid}.json`);
      fs.writeFileSync(tokenBodyFile, formBody, { mode: 0o600 });
      fs.writeFileSync(tokenHeaderFile, JSON.stringify({ 'Content-Type': 'application/x-www-form-urlencoded' }), { mode: 0o600 });
      let tokenRaw = '';
      try {
        tokenRaw = brokerHttpBodyFile(paths, opts, plan, {
          url: `https://${host}/2/oauth2/token`,
          bodyFile: tokenBodyFile,
          headerFile: tokenHeaderFile,
          approved: true,
          timeoutSeconds: 30,
        });
      } catch (e) {
        const detail = e instanceof PlanFailure ? e.message : String(e);
        throw new PlanFailure(`X token refresh failed: ${redact(detail)}`, { handled: true });
      } finally {
        try { fs.unlinkSync(tokenBodyFile); } catch (_) {}
        try { fs.unlinkSync(tokenHeaderFile); } catch (_) {}
      }
      let tokenResponse = null;
      try { tokenResponse = JSON.parse(tokenRaw); } catch (_) { tokenResponse = null; }
      accessToken = tokenResponse && typeof tokenResponse.access_token === 'string' ? tokenResponse.access_token : '';
      const newRefreshToken = tokenResponse && typeof tokenResponse.refresh_token === 'string' ? tokenResponse.refresh_token : '';
      if (!accessToken) {
        throw new PlanFailure('X token refresh failed: response was missing access_token.', { handled: true });
      }
      xAccessTokenCache.set(connectorId, accessToken);
      // Persist the rotated refresh token BEFORE attempting the post itself —
      // a post failure must not strand a valid rotated token unsaved (the old
      // one is already invalid on X's side the moment this exchange succeeded).
      // Both writes are best-effort and independent: the pending-update queue
      // is the eventual-consistency path into SecureStore (Settings UI etc.);
      // updateEnvFileSecret closes the gap for THIS executor's own next
      // invocation, which reads straight from envFile and never touches
      // SecureStore at all — see that function's doc comment.
      if (newRefreshToken) {
        writePendingConnectorSecretUpdate(paths, connectorId, 'refreshToken', newRefreshToken);
        updateEnvFileSecret(paths.envFile, `${socialConnectorEnvPrefix(connectorId)}_REFRESHTOKEN`, newRefreshToken);
      }
    }
    return {
      url: `https://${host}/2/tweets`,
      body: { text },
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }
  throw new PlanFailure(`Unsupported social platform: ${platform}`, { handled: true });
}

function extractModelContent(toolType, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const text = String(raw || '').trim();
    if (text) return text;
    throw new PlanFailure('model response was empty', { handled: true });
  }
  if (toolType === 'gemini-api') {
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const parts = candidates.flatMap((candidate) => {
      const content = candidate && candidate.content;
      return content && Array.isArray(content.parts) ? content.parts : [];
    });
    const text = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n').trim();
    if (text) return text;
  } else {
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : choice && typeof choice.text === 'string'
        ? choice.text
        : '';
    if (content.trim()) return content.trim();
  }
  throw new PlanFailure('model response did not contain assistant content', { handled: true });
}

function brokerFsWrite(paths, opts, roots, dest, src) {
  const rootsFile = writeRootsFile(paths, roots);
  const outFile = path.join(paths.tmpDir, `plan-fs-${process.pid}.out`);
  const errFile = path.join(paths.tmpDir, `plan-fs-${process.pid}.err`);
  const rc = runBroker(paths, opts, [
    '--op', 'fs.write',
    '--path', dest,
    '--input-file', src,
    '--roots-file', rootsFile,
    '--audit-log', paths.brokerAuditFile,
    '--out', outFile,
    '--err', errFile,
  ]);
  const err = readFile(errFile);
  try {
    fs.unlinkSync(rootsFile);
  } catch (_) {}
  if (rc !== 0) {
    throw new PlanFailure(`scoped filesystem write denied: ${redact(err).slice(0, 300)}`, {
      exitCode: EXIT.OK,
      handled: true,
    });
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

function acquireLock(paths) {
  ensureDir(path.dirname(paths.lockFile));
  if (fs.existsSync(paths.lockFile)) {
    const pid = Number(readFile(paths.lockFile).trim());
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (_) {
        // stale
      }
    }
    try {
      fs.unlinkSync(paths.lockFile);
    } catch (_) {}
  }
  writeAtomic(paths.lockFile, `${process.pid}\n`);
  return true;
}

function releaseLock(paths) {
  try {
    if (readFile(paths.lockFile).trim() === String(process.pid)) fs.unlinkSync(paths.lockFile);
  } catch (_) {}
}

function writeNotification(paths, plan, status, preview) {
  writeAtomic(paths.notifyFile, JSON.stringify({
    agentId: plan.agent.id,
    agentName: plan.agent.name,
    toolLabel: plan.tool.label,
    status,
    preview,
    timestamp: Math.floor(Date.now() / 1000),
  }) + '\n');
}

// `steps` (optional): per-step detail for a chain-mode (orchestrated) run —
// mirrors AgentRunLog.steps / AgentRunStep (store/types.ts) field-for-field so
// a future increment can render this the same way the attended path's
// aggregate run log already does. Omitted (undefined) for every non-chain
// call site, so JSON.stringify drops the key entirely and single-shot run-log
// output stays byte-identical to before this increment.
// `actionResults` (optional, 2026-07-23): per-action detail for a multi-
// action fan-out run (>= 2-entry plan.actions) — mirrors AgentRunLog.actionResults
// / AgentActionResult (store/types.ts) field-for-field, same as `steps` above.
// Omitted (undefined) for every ordinary single-action call site, so
// JSON.stringify drops the key entirely and that run-log output stays
// byte-identical to before this field existed.
function writeRunLog(paths, plan, status, preview, durationMs, errorMessage, steps, actionResults, usedTool) {
  const ts = Date.now();
  const log = {
    agentId: plan.agent.id,
    timestamp: ts,
    status,
    outputPreview: previewText(preview),
    durationMs,
    // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
    // 進まない」(3rd-pass Codex review finding): `usedTool` is the actual
    // ladder-resolved tool a caller may pass when it differs from
    // `plan.tool` — see run()'s own comment for why `plan.tool` itself is
    // deliberately NEVER mutated to the retry candidate (trustedNativeLowRiskAction
    // compares plan.tool.type against native's --trusted-tool-type; swapping
    // it would break that trust check for a successful ladder retry).
    toolUsed: (usedTool || plan.tool).label,
    errorMessage: errorMessage ? previewText(errorMessage) : '',
    routeDecision: plan.routeDecision,
    executor: 'planspec',
    ...(steps ? { steps } : {}),
    ...(actionResults ? { actionResults } : {}),
  };
  writeAtomic(path.join(paths.logDir, `${Math.floor(ts / 1000)}.json`), JSON.stringify(log) + '\n');
}

// ─── 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 executor-side verifier ───
//
// Dormant while SIGNED_APPROVAL_ENABLED is false (see the constant's comment up
// top). Everything in this section is a faithful plain-JS port of
// lib/signed-approval/{canonical,verify,nonce-store}.ts — the source of truth —
// plus a DER-key loader mirroring shelly-agent-driver.js's
// ensureEscalationVerifierKey (~line 907 there). Ported, not reinvented, so the
// host-tested TS policy and this executor implementation cannot silently drift:
// same field order, same version tags, same check order, same fail-closed shape.

// Mirrors lib/signed-approval/canonical.ts encodeFields: JSON.stringify of a
// fixed-order array. Deterministic and injective (JSON escapes embedded
// newlines/quotes so no field can shift content across a boundary to forge a
// colliding hash) — see that file's header comment for the full rationale.
function signedApprovalEncodeFields(fields) {
  return JSON.stringify(fields);
}

// Verbatim port of lib/signed-approval/canonical.ts canonicalRequest. Same
// version tag, same field order (fixed order, not JSON key order) as the source.
function canonicalApprovalRequest(request) {
  return signedApprovalEncodeFields([
    'shelly-agent-action-approval-request-v2',
    String(request.runId),
    String(request.agentId),
    String(request.agentName),
    String(request.toolLabel),
    String(request.actionType),
    String(request.preview),
    String(request.destinationHost || ''),
    String(request.command || ''),
    String(request.safetyLevel || ''),
    String(request.safetyReason || ''),
    String(request.payloadPath || ''),
    String(request.intentMode || ''),
    String(request.intentTarget || ''),
    String(request.intentShareText || ''),
    String(request.dmPairingId || ''),
    String(request.dmPairingLabel || ''),
    String(request.dmReplyText || ''),
    String(request.resultPath || ''),
    String(request.ts),
    String(request.expiresAt),
    String(request.nonce),
  ]);
}

// Verbatim port of lib/signed-approval/canonical.ts approvalReplySignatureMessage.
// Same version tag, same field order as the source.
function approvalReplySignatureMessage(fields) {
  return signedApprovalEncodeFields([
    'shelly-agent-action-approval-v2',
    String(fields.runId),
    String(fields.actionType),
    String(fields.decision),
    String(fields.ts || ''),
    String(fields.requestSha256),
    String(fields.nonce),
  ]);
}

// Per-call, in-memory single-use nonce tracker (mirrors
// lib/signed-approval/nonce-store.ts InMemoryNonceStore's semantics exactly:
// true the first time a nonce is seen, false on replay). A durable
// cross-process ledger (like AgentEscalationBridge.registerActionNonce on the
// native/driver side) is NOT needed here: one requestActionApproval call is one
// approval request/reply cycle within a SINGLE executor process invocation (the
// executor requests approval once per action, polls for the one reply file, and
// the process exits shortly after) — there is no second call in this process to
// replay a nonce against, so a Set scoped to the call is sufficient. A future
// reader should not read the lack of durability here as an oversight; it's a
// different lifetime than Tier A's long-lived driver process.
function makeSignedApprovalNonceStore() {
  const used = new Set();
  return {
    consume(nonce) {
      if (!nonce || used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
  };
}

// DER-key loader for the signed-approval verifier key. Mirrors
// shelly-agent-driver.js's ensureEscalationVerifierKey fail-closed shape
// EXACTLY, but is a SEPARATE cache/key from config.escalationVerifierPublicKey
// (that field is the UNRELATED Tier A codex-escalation mechanism's key; this one
// is Tier B action-approval's own key, config.signedApprovalVerifierPublicKey).
// Loads at most once per config object and caches the parsed key so a later
// same-uid overwrite of the DER file cannot swap the trust anchor mid-run.
// Fails closed (leaves the cached key null, so every verify call fails closed)
// if: the file can't be read, OR a configured pin doesn't match the actual
// hash, OR no pin is configured and unpinned keys aren't explicitly allowed.
function ensureSignedApprovalVerifierKey(config, audit) {
  if (config.signedApprovalVerifierLoaded) return;
  config.signedApprovalVerifierLoaded = true;
  let der;
  try {
    der = fs.readFileSync(config.signedApprovalPublicKeyPath);
  } catch (error) {
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_unavailable', {
      path: config.signedApprovalPublicKeyPath,
      error: error.message,
    });
    return;
  }
  const actualSha256 = sha256Hex(der);
  if (config.signedApprovalPublicKeySha256) {
    if (actualSha256 !== config.signedApprovalPublicKeySha256) {
      config.signedApprovalVerifierPublicKey = null;
      audit('signed_approval_verifier_key_untrusted', {
        path: config.signedApprovalPublicKeyPath,
        expectedSha256: config.signedApprovalPublicKeySha256,
        actualSha256,
      });
      return;
    }
  } else if (config.allowUnpinnedSignedApprovalVerifierKey) {
    audit('signed_approval_verifier_key_unpinned', {
      path: config.signedApprovalPublicKeyPath,
      actualSha256,
      note: 'host/dev only: a same-uid agent could swap this key',
    });
  } else {
    // Production default: no pin AND not explicitly allowed → refuse the key so
    // a launcher that forgot to inject the pin fails closed instead of silently
    // trusting a swappable key. (SIGNED_APPROVAL_ENABLED is false today, so this
    // branch cannot yet be reached from a live run — native doesn't pass
    // --signed-approval-public-key-sha256 until Migration step 1 lands.)
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_unpinned_refused', {
      path: config.signedApprovalPublicKeyPath,
      actualSha256,
      note: 'no --signed-approval-public-key-sha256 pin and unpinned keys not allowed; key refused, replies fail closed',
    });
    return;
  }
  try {
    config.signedApprovalVerifierPublicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (error) {
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_parse_error', {
      path: config.signedApprovalPublicKeyPath,
      error: error.message,
    });
  }
}

// Allowlist pinned BEFORE the signature is verified (algorithm-confusion
// defense — mirrors lib/signed-approval/verify.ts's allowedSigAlgs check, which
// itself mirrors Tier A hardcoding RSA-SHA256). NOTE: this is the reply's OWN
// sigAlg string, i.e. the Android Keystore/Java-side algorithm name
// ('SHA256withRSA'), NOT node:crypto's createVerify algorithm name
// ('RSA-SHA256') used below — the two strings name the same scheme from two
// different APIs and must not be swapped.
const SIGNED_APPROVAL_ALLOWED_SIG_ALGS = ['SHA256withRSA'];

// Verbatim port of lib/signed-approval/verify.ts verifyApprovalReply's exact
// check order: decision validity -> author -> sigAlg allowlist (BEFORE the
// signature is verified) -> runId -> actionType -> request hash recomputed from
// canonicalApprovalRequest AND compared against BOTH request.requestSha256 and
// reply.requestSha256 -> expiry -> nonce match -> key pin (fail closed on an
// empty pin) -> signature verify (node:crypto RSA-SHA256, mirroring
// shelly-agent-driver.js verifyEscalationReplySignature's shape) -> nonce
// CONSUMED LAST, only after the signature verifies, so a forged reply can never
// burn a valid nonce.
function verifySignedApprovalReply(request, reply, deps) {
  const fail = (reason) => ({ ok: false, reason });
  const VALID_DECISIONS = new Set(['accept', 'decline']);

  if (!reply || !VALID_DECISIONS.has(reply.decision)) return fail('bad-decision');
  if (reply.by !== (deps.expectedBy || 'human')) return fail('bad-author');
  if (!deps.allowedSigAlgs.includes(reply.sigAlg)) return fail('bad-sig-alg');
  if (reply.runId !== request.runId) return fail('runid-mismatch');
  if (reply.actionType !== request.actionType) return fail('action-mismatch');

  const expectedRequestSha = sha256Hex(canonicalApprovalRequest(request));
  if (request.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');
  if (reply.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');

  if (Date.now() > request.expiresAt) return fail('expired');
  if (reply.nonce !== request.nonce) return fail('nonce-mismatch');

  // Fail closed if the pin itself is empty/unset (a vacuous pin is no pin). The
  // trusted verifier key is the load-bearing side; reply.keySha256 is
  // attacker-controlled and ANDed in, so it can only ever reject, never bypass.
  const publicKey = deps.publicKey;
  if (!deps.expectedKeySha256 || !publicKey || deps.publicKeySha256 !== deps.expectedKeySha256 || reply.keySha256 !== deps.expectedKeySha256) {
    return fail('key-pin-mismatch');
  }

  try {
    const message = approvalReplySignatureMessage(reply);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();
    if (!verifier.verify(publicKey, Buffer.from(reply.signature || '', 'base64'))) {
      return fail('bad-signature');
    }
  } catch (_) {
    return fail('bad-signature');
  }

  // Single-use LAST: only a fully-valid reply consumes the nonce; a replay of an
  // already-consumed nonce fails here instead of at nonce-mismatch.
  if (!deps.nonceStore.consume(reply.nonce)) return fail('nonce-replay');

  return { ok: true, reason: 'ok' };
}

function requestActionApproval(paths, plan, actionType, preview, resultFile, config, details) {
  ensureDir(paths.actionApprovalDir);
  ensureDir(paths.actionApprovalReplyDir);
  // Multi-action fan-out (2026-07-23, dispatchActionsTrusted below): two
  // actions dispatched from the SAME process within the same wall-clock
  // second used to collide on an identical runId (same agent id + timestamp
  // + pid) — a real bug this feature makes reachable for the first time (a
  // single-action plan only ever calls this once per process). A collision
  // would make the two actions share one approval request/reply file path
  // AND make AgentRuntime.kt's approval-notifier "seen" de-dupe silently
  // drop the second action's prompt as an already-shown duplicate. The extra
  // random suffix guarantees uniqueness regardless of call count/timing;
  // nothing parses runId's shape (every consumer treats it as an opaque
  // token captured off the just-written request), so this is safe for the
  // single-action case too.
  const runId = `${plan.agent.id}-${Math.floor(Date.now() / 1000)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const requestFile = path.join(paths.actionApprovalDir, `action-${safeFilePart(runId)}.json`);
  const replyFile = path.join(paths.actionApprovalReplyDir, `action-${safeFilePart(runId)}.reply.json`);
  // 2026-08-05 on-device QA finding (DEFERRED.md 2026-08-05 QAスイープ バグ5):
  // 120s repeatedly timed out in practice before the user even finished
  // reading the notification. Bumped to 300s in lockstep with
  // lib/agent-executor.ts's request_and_wait_approval default — both read the
  // same SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS env var, so an explicit
  // override still works identically for either executor.
  const timeoutSeconds = Number(config.SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS || process.env.SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS || 300);
  const extra = details || {};
  const request = {
    runId,
    agentId: plan.agent.id,
    agentName: plan.agent.name,
    toolLabel: plan.tool.label,
    actionType,
    preview,
    destinationHost: extra.destinationHost || '',
    destinationHostAllowlisted: extra.destinationHostAllowlisted === true,
    command: extra.command || '',
    safetyLevel: extra.safetyLevel || '',
    safetyReason: extra.safetyReason || '',
    payloadPath: extra.payloadPath || '',
    intentMode: extra.intentMode || '',
    intentTarget: extra.intentTarget || '',
    intentShareText: extra.intentShareText || '',
    dmPairingId: extra.dmPairingId || '',
    dmPairingLabel: extra.dmPairingLabel || '',
    dmReplyText: extra.dmReplyText || '',
    appActRecipeId: extra.appActRecipeId || '',
    appActParamsResolved: extra.appActParamsResolved || '',
    // browser-pane (2026-08-04): mirrors appActParamsResolved's plain-string
    // convention -- browserPaneUrlAllowlist carries a JSON-encoded string[]
    // (decoded by lib/agent-browser-pane-review.ts on the RN side), never a
    // nested array field, so this stays a flat string map like every other
    // field here.
    browserPaneActionKind: extra.browserPaneActionKind || '',
    browserPaneSelector: extra.browserPaneSelector || '',
    browserPaneValue: extra.browserPaneValue || '',
    browserPaneUrlAllowlist: extra.browserPaneUrlAllowlist || '',
    // Project owner directive 2026-07-14 (see requireActionApprovalTap /
    // trustedNativeLowRiskAction above): real JSON booleans, not the "1"/"0"
    // strings the rest of this legacy string-map uses, so Kotlin's
    // JSONObject.optBoolean parses both this and the .sh executor's request
    // identically. Not covered by canonicalApprovalRequest's fixed field list
    // (dormant SIGNED_APPROVAL_ENABLED path) — acceptable, these are
    // executor-computed trust hints, not human-reviewable content.
    autoAccept: extra.autoAccept === true,
    autoFireTrusted: extra.autoFireTrusted === true,
    resultPath: resultFile,
    ts: new Date().toISOString(),
    expiresAt: Date.now() + Math.max(1, timeoutSeconds) * 1000,
    // Per-request single-use nonce (Tier A parity, lib/signed-approval/types.ts
    // ApprovalRequest.nonce). Written into the request regardless of
    // SIGNED_APPROVAL_ENABLED so a future signed reply can bind to it; the naive
    // equality path below ignores it entirely, so this is not a behavior change.
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  // 署名付き承認 (SIGNED-APPROVAL): request.requestSha256 is the sha256 of the
  // CANONICAL field encoding (canonicalApprovalRequest, the fixed-order tagged
  // array from lib/signed-approval/canonical.ts) -- NOT of the raw JSON file
  // bytes below. These are two DIFFERENT hashes of the same data for two
  // DIFFERENT consumers: this canonical hash is what a real signer would read
  // from the on-disk request and echo into SignedApprovalReply.requestSha256
  // (lib/signed-approval/types.ts: "sha256 hex of the canonical request, bound
  // into the reply"), and what verifySignedApprovalReply recomputes to check
  // self-consistency + reply-binding. Set BEFORE writeAtomic so a real signer's
  // on-disk view includes it; canonicalApprovalRequest() does not read this
  // field, so setting it here does not change what gets hashed. An earlier
  // version of this fix set request.requestSha256 to sha256File(requestFile)
  // (the FILE-BYTES hash used below by the unrelated naive-equality path) --
  // a structurally different value that would have made the signed-approval
  // accept-path self-DoS on every reply, valid or not. Found and corrected
  // before the flag was ever enabled -- see docs/superpowers/DEFERRED.md.
  request.requestSha256 = sha256Hex(canonicalApprovalRequest(request));
  writeAtomic(requestFile, JSON.stringify(request) + '\n');
  // Unrelated to the above: sha256 of the ACTUAL on-disk file bytes, used ONLY
  // by today's naive equality check a few lines down (`reply.requestSha256 !==
  // requestSha256`) -- untouched, byte-identical to pre-signed-approval
  // behavior. Native's reply-writer independently hashes whatever bytes it
  // reads back from this same file, so adding a field to the request object
  // before writing does not break that comparison (both sides hash the real
  // file, not a fixed shape).
  const requestSha256 = sha256File(requestFile);
  const nonceStore = SIGNED_APPROVAL_ENABLED ? makeSignedApprovalNonceStore() : null;
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(replyFile)) {
      let reply = null;
      try {
        reply = JSON.parse(readFile(replyFile));
      } catch (_) {
        reply = null;
      }
      try {
        fs.unlinkSync(replyFile);
        fs.unlinkSync(requestFile);
      } catch (_) {}

      if (SIGNED_APPROVAL_ENABLED) {
        // Migration step 2 (lib/signed-approval/wiring.ts): once enabled, EVERY
        // reply must carry a valid signature -- fail closed on any reply
        // missing sigAlg/signature/keySha256/nonce rather than falling through
        // to the naive equality check below. Without this explicit rejection,
        // an unsigned (or malformed-signature) reply would silently satisfy
        // the naive runId+requestSha256 check, completely defeating signed
        // approval the moment it's enabled. Dormant: SIGNED_APPROVAL_ENABLED is
        // false today, so this branch never executes in production.
        if (!reply || !reply.sigAlg || !reply.signature || !reply.keySha256 || !reply.nonce) {
          throw new ActionSkipped(`${actionType} action declined`);
        }
        ensureSignedApprovalVerifierKey(config, (event, fields) => appendJsonl(paths.planAuditFile, {
          ts: new Date().toISOString(),
          kind: 'plan.executor',
          event,
          agentId: plan.agent.id,
          ...fields,
        }));
        const result = verifySignedApprovalReply(request, reply, {
          publicKey: config.signedApprovalVerifierPublicKey,
          publicKeySha256: config.signedApprovalVerifierPublicKey ? config.signedApprovalPublicKeySha256 : '',
          expectedKeySha256: config.signedApprovalPublicKeySha256 || '',
          allowedSigAlgs: SIGNED_APPROVAL_ALLOWED_SIG_ALGS,
          nonceStore,
        });
        if (result.ok && reply.decision === 'accept') return;
        throw new ActionSkipped(`${actionType} action declined`);
      }

      // Naive equality check — reached ONLY when SIGNED_APPROVAL_ENABLED is
      // false (the signed branch above always returns/throws and never falls
      // through). Byte-identical to pre-signed-approval behavior.
      if (!reply || reply.runId !== runId || reply.requestSha256 !== requestSha256) {
        continue;
      }
      if (reply.decision === 'accept') return;
      throw new ActionSkipped(`${actionType} action declined`);
    }
    sleepMs(500);
  }
  try {
    fs.unlinkSync(requestFile);
  } catch (_) {}
  throw new ActionSkipped(`${actionType} action approval timed out`);
}

// Project owner directive 2026-07-14: wraps requestActionApproval so
// draft/notify/webhook/cli can skip the round trip ENTIRELY when the
// resolved approval-mode is 'auto' (requireActionApprovalTap === false) — no
// request file is ever written, mirroring lib/agent-executor.ts's
// request_and_wait_approval (.sh executor) exactly, for the same reason: an
// unattended scheduled run must not depend on JS/native being alive to reply.
// intent/dm-reply/app-act are excluded from the skip — they only ever fire
// via RN/native (see each case's own comment in dispatchActionTrusted) — and
// always go through the full requestActionApproval; their own
// autoAccept/autoFireTrusted request fields (set by the caller via `details`)
// drive RN/native's auto-resolution instead.
function maybeRequestActionApproval(paths, plan, actionType, preview, resultFile, config, details) {
  if (
    actionType !== 'intent' &&
    actionType !== 'dm-reply' &&
    actionType !== 'app-act' &&
    actionType !== 'browser-pane' &&
    !requireActionApprovalTap(plan, config)
  ) {
    return;
  }
  requestActionApproval(paths, plan, actionType, preview, resultFile, config, details);
}

function safeFilePart(value) {
  return String(value || '').slice(0, 160).replace(/[^A-Za-z0-9_.=-]/g, '_') || 'request';
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Used by the signed-approval verifier (canonicalApprovalRequest hashing, DER
// key-pin hashing) below; sha256File above hashes file bytes, this hashes an
// already-in-memory string/Buffer.
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Mirrors the .sh save_draft_result destination logic (lib/agent-executor.ts).
// Returns { dest, rel, useGlobalOutput }: `rel` is the content-studio relative
// filename reused by the Obsidian mirror; it is empty for the global-output path.
function resolveDraftDestination(paths, plan, config) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  if (plan.output && plan.output.useGlobalOutput) {
    let base = path.join(paths.home, 'agent-output');
    const target = config.SHELLY_AGENT_OUTPUT_TARGET || 'local';
    if (target === 'obsidian') base = config.OBSIDIAN_VAULT_PATH || '/sdcard/Documents/ObsidianVault';
    if (target === 'custom') base = config.SHELLY_AGENT_CUSTOM_PATH || path.join(paths.home, 'agent-output');
    // The .sh appends SHELLY_AGENT_TOPIC_FOLDER only for obsidian/custom, never local.
    const topic = target === 'obsidian' || target === 'custom' ? sanitizeRelPath(config.SHELLY_AGENT_TOPIC_FOLDER || '') : '';
    const topicPart = topic && topic !== '{date}-{slug}' ? topic : '';
    return { dest: path.join(base, topicPart, date, `${date}_${plan.output.slug}.md`), rel: '', useGlobalOutput: true };
  }
  const template = sanitizeRelPath(plan.output && plan.output.outputNameTemplate);
  let rel = template
    .replace(/\{date\}/g, date)
    .replace(/\{slug\}/g, plan.output && plan.output.slug ? plan.output.slug : plan.agent.id)
    .replace(/\{time\}/g, time);
  if (!/\.(md|markdown|txt)$/i.test(rel)) rel += '.md';
  return { dest: path.join(plan.output.outputDir, rel), rel, useGlobalOutput: false };
}

// Keyword-routed Obsidian subfolder for content-studio agents. Mirrors the
// `case "$OUTPUT_DIR"` map in the .sh save_draft_result (order-sensitive: first
// match wins, matching bash `case`).
function obsidianTargetFor(outputDir) {
  const dir = String(outputDir || '');
  if (dir.includes('drafts/substack')) return '50_Drafts/Substack';
  if (dir.includes('drafts/x')) return '50_Drafts/X';
  if (dir.includes('drafts/articles')) return '50_Drafts/Substack';
  if (dir.includes('sources')) return '20_Literature/Papers';
  if (dir.includes('images/prompts')) return '60_Experiments/Image_Prompts';
  if (dir.includes('evals')) return '90_Log/Agent_Evals';
  return '90_Log/Agent_Output';
}

// The content-studio Obsidian mirror destination, or null when no vault is
// configured/present (the .sh guards on `[ -n "$OBSIDIAN_VAULT_PATH" ] && [ -d ]`
// and silently skips otherwise). The write itself is broker-routed and root-jailed.
function resolveObsidianMirror(plan, config, rel) {
  const vault = String(config.OBSIDIAN_VAULT_PATH || '').trim();
  if (!vault || !rel) return null;
  try {
    if (!fs.statSync(vault).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return path.join(vault, obsidianTargetFor(plan.output && plan.output.outputDir), rel);
}

// Write the draft to its primary destination and (for content-studio) the Obsidian
// mirror, both through the root-jailed broker fs.write. `bestEffort` mirrors the .sh:
// the terminal `draft` action runs save_draft_result under `set -e` (fatal), while an
// orchestration `__suppressed__` step runs it `2>/dev/null || true` (swallow errors).
function writeDraftOutputs(paths, opts, plan, config, roots, bestEffort) {
  const { dest, rel, useGlobalOutput } = resolveDraftDestination(paths, plan, config);
  const targets = [dest];
  if (!useGlobalOutput) {
    const mirror = resolveObsidianMirror(plan, config, rel);
    if (mirror) targets.push(mirror);
  }
  // In bestEffort mode the whole sequence is swallowed on the FIRST failure, matching
  // the .sh `save_draft_result ... || true` under `set -e` (a failed primary write
  // aborts before the mirror). The terminal draft path lets the failure propagate.
  try {
    for (const target of targets) brokerFsWrite(paths, opts, roots, target, paths.resultFile);
    // save_draft_result appends source URLs to the shared dedup registry AFTER the
    // write, inside set -e — a failed write aborts before it. Keep it inside the try
    // so a swallowed bestEffort write failure also skips the registry (parity).
    registerSourceUrls(paths, config, plan);
  } catch (e) {
    if (!bestEffort) throw e;
  }
}

// Mirror of the .sh register_source_urls: append https URLs found in the draft to a
// shared per-project registry TSV (timestamp, agentId, toolLabel, url), deduped on
// the url column, under a mkdir mutex. Fixed path (no model-controlled path), best
// effort — a registry hiccup must never fail the run. No-op when the sources/ dir is
// absent (parity with the .sh, whose `>>` silently fails without it).
function registerSourceUrls(paths, config, plan) {
  try {
    const contentProject = config.SHELLY_CONTENT_PROJECT || path.join(paths.home, 'projects/shelly-content-studio');
    const registryFile = config.SOURCE_REGISTRY_FILE || path.join(contentProject, 'sources', 'source-registry.tsv');

    let text = '';
    try {
      text = fs.readFileSync(paths.resultFile, 'utf8');
    } catch (_) {
      return;
    }
    const seen = new Set();
    // The .sh uses line-oriented `grep -Eo`, so a match never spans a newline; exclude
    // \t\r\n from the class so adjacent-line URLs don't merge into one bogus entry.
    const matches = text.match(/https?:\/\/[^\][ )<>"'\t\r\n]+/g) || [];
    for (const raw of matches) {
      // Match the .sh: `sed 's/[.,;)]$//'` strips exactly one trailing char.
      const url = raw.replace(/[.,;)]$/, '');
      if (url) seen.add(url);
    }
    // `sort -u` in the .sh: unique + sorted before appending.
    const urls = Array.from(seen).sort();
    if (!urls.length) return;

    // The .sh creates the registry dir/file unconditionally at startup (mkdir -p +
    // touch, lib/agent-executor.ts), so register_source_urls always has a target.
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const lockDir = `${registryFile}.lock`;
    let locked = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        fs.mkdirSync(lockDir);
        locked = true;
        break;
      } catch (_) {
        sleepMs(1000);
      }
    }
    try {
      let existing = '';
      try {
        existing = fs.readFileSync(registryFile, 'utf8');
      } catch (_) {
        /* first write */
      }
      const known = new Set(existing.split('\n').map((line) => line.split('\t')[3]).filter(Boolean));
      const toolLabel = (plan.tool && plan.tool.label) || '';
      const ts = new Date().toISOString();
      let append = '';
      for (const url of urls) {
        if (!known.has(url)) {
          append += `${ts}\t${plan.agent.id}\t${toolLabel}\t${url}\n`;
          known.add(url);
        }
      }
      if (append) fs.appendFileSync(registryFile, append);
    } finally {
      if (locked) {
        try {
          fs.rmdirSync(lockDir);
        } catch (_) {}
      }
    }
  } catch (_) {
    /* best-effort registry bookkeeping — never fail the run */
  }
}

function webhookDestinationHost(urlText) {
  try {
    const u = new URL(String(urlText || ''));
    if (u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function webhookHostIsAllowlisted(host, config) {
  const candidate = String(host || '').trim().toLowerCase();
  return String(config.SHELLY_WEBHOOK_HOST_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(candidate);
}

// ─── social-post (2026-07-22) ───────────────────────────────────────────────
// Mirrors lib/agent-executor.ts's dispatch_social_post (.sh executor) — the
// per-platform request shapes, the connector-host binding, and the
// "non-allowlisted host always requires a human tap" approval tier must stay
// in sync between the two executors.

// Mirrors lib/social-connectors.ts's socialConnectorEnvPrefix (this file is
// plain CommonJS and cannot import the TS module).
function socialConnectorEnvPrefix(connectorId) {
  return 'SOCIAL_CONNECTOR_' + String(connectorId || '').replace(/-/g, '_').toUpperCase();
}

function socialHostIsAllowlisted(host, config) {
  const candidate = String(host || '').trim().toLowerCase();
  if (!candidate) return false;
  return String(config.SHELLY_SOCIAL_HOST_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(candidate);
}

// Reads ONLY this connector's secret fields from the .env file — never the
// whole file into config (see isSocialConnectorConfigKey's doc comment). The
// non-secret _HOST/_META suffixes are skipped (they live in config instead).
function loadConnectorSecrets(envFile, envPrefix) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch (_) {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key.startsWith(envPrefix + '_')) continue;
    if (key.endsWith('_HOST') || key.endsWith('_META')) continue;
    // Exact-connector match only: a field suffix never contains '_' (fields
    // are uppercased alnum camelCase names), so a suffix WITH '_' belongs to a
    // hyphen-suffixed SIBLING connector id (e.g. prefix …_MASTODON matching
    // …_MASTODON_2_ACCESSTOKEN → suffix "2_ACCESSTOKEN") — skip it.
    if (key.slice(envPrefix.length + 1).includes('_')) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1).replace(/'\\''/g, "'");
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    out[key.slice(envPrefix.length + 1)] = val;
  }
  return out;
}

// Connector secret values are user-shaped (webhook URLs, app passwords) and
// rarely match the fixed REDACT_PATTERNS — strip the exact live values too
// before any error/response text can reach a notification or the run log.
function redactSecretValues(text, values) {
  let out = String(text == null ? '' : text);
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) out = out.split(value).join('<redacted>');
  }
  return out;
}

// The connector's declared host is definitionally its ONLY allowed target
// (lib/capability-envelope.ts's isSocialConnectorHostAllowed): the URL about
// to be POSTed must resolve (https-only) to exactly that host.
function socialUrlMatchesHost(urlText, host) {
  const actual = webhookDestinationHost(urlText);
  return !!actual && actual === String(host || '').trim().toLowerCase();
}

function writeWebhookPayload(file, plan, status, preview, resultText) {
  writeAtomic(file, JSON.stringify({
    agentId: plan.agent.id,
    status,
    preview,
    toolUsed: plan.tool.label,
    timestamp: Math.floor(Date.now() / 1000),
    result: resultText,
  }) + '\n');
}

const CRITICAL_COMMAND_PATTERNS = [
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~\/?\s*$|\/\*|~\/\*)/i,
    reason: 'Root or home directory recursive removal is critical.',
  },
  {
    pattern: /rm\s+-rf\s+\/(?:usr|bin|lib|etc|boot|sys|proc|dev|sbin)/i,
    reason: 'System directory removal is critical.',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: 'Fork bomb command is critical.',
  },
  {
    pattern: /dd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Direct storage overwrite is critical.',
  },
  {
    pattern: /mkfs\s+.*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Storage device format is critical.',
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Direct storage device write is critical.',
  },
  {
    pattern: /shred\s+.*\/dev\//i,
    reason: 'Device shred command is critical.',
  },
];

function recomputeCliSafety(commandText, declaredSafety) {
  const cleaned = String(commandText || '').replace(/#[^\n]*/g, '').trim();
  for (const { pattern, reason } of CRITICAL_COMMAND_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        level: 'CRITICAL',
        reason,
        message: 'Executor-side command safety blocked a critical command.',
        matchedPattern: pattern.source,
      };
    }
  }
  const safety = declaredSafety && typeof declaredSafety === 'object' ? declaredSafety : {};
  return {
    level: safety.level || 'SAFE',
    reason: safety.reason || 'No critical command pattern matched.',
    message: safety.message || '',
    matchedPattern: safety.matchedPattern || '',
  };
}

function resolveCliCwd(paths, plan, config) {
  const wanted =
    config.SHELLY_AGENT_EXEC_CWD ||
    config.SHELLY_CONTENT_PROJECT ||
    path.join(paths.home, 'projects/shelly-content-studio');
  try {
    if (wanted && path.isAbsolute(wanted) && fs.existsSync(wanted) && fs.statSync(wanted).isDirectory()) return wanted;
  } catch (_) {
    // fall through to the known local output directory
  }
  const fallback = path.join(paths.home, 'agent-output');
  ensureDir(fallback);
  return fallback;
}

function brokerWorkspaceExec(paths, opts, roots, plan, commandText, cwd) {
  const commandFile = path.join(paths.tmpDir, `plan-exec-command-${plan.agent.id}-${process.pid}.txt`);
  const rootsFile = writeRootsFile(paths, roots);
  const outFile = path.join(paths.logDir, `cli-action-output-${Date.now()}.txt`);
  const errFile = path.join(paths.logDir, `cli-action-error-${Date.now()}.txt`);
  writeAtomic(commandFile, commandText);
  const rc = runBroker(paths, opts, [
    '--op', 'workspace.exec',
    '--command-file', commandFile,
    '--cwd', cwd,
    '--roots-file', rootsFile,
    '--audit-log', paths.brokerAuditFile,
    '--timeout-seconds', String(plan.limits && plan.limits.timeoutSeconds ? plan.limits.timeoutSeconds : 600),
    '--out', outFile,
    '--err', errFile,
  ]);
  try {
    fs.unlinkSync(commandFile);
  } catch (_) {}
  try {
    fs.unlinkSync(rootsFile);
  } catch (_) {}
  return { rc, outFile, errFile, out: readFile(outFile), err: readFile(errFile) };
}

function appendCliActionReport(resultFile, commandText, cwd, safety, execResult) {
  const errorText = execResult.err ? `\n[stderr]\n${execResult.err}` : '';
  const combined = `${execResult.out || ''}${errorText}`;
  const safetyLevel = safety && safety.level ? safety.level : '';
  const safetyReason = safety && safety.reason ? safety.reason : '';
  fs.appendFileSync(resultFile, [
    '',
    '## CLI action',
    '',
    `Safety: ${safetyLevel} - ${safetyReason}`,
    '',
    `Cwd: ${cwd}`,
    '',
    'Command:',
    '',
    '```sh',
    commandText,
    '```',
    '',
    `Exit code: ${execResult.rc}`,
    '',
    'Output:',
    '',
    '```text',
    redact(combined).slice(0, 4000),
    '```',
    '',
  ].join('\n'));
}

function argTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function trustedNativeLowRiskAction(args, plan, actionType) {
  const trustedAgentId = String(args['trusted-autonomous-agent-id'] || '').trim();
  const trustedAction = String(args['trusted-autonomous-action'] || '').trim();
  const trustedTool = String(args['trusted-tool-type'] || '').trim();
  if (trustedAgentId !== plan.agent.id) return false;
  // app-act (2026-07-14, docs/superpowers/DEFERRED.md's "app-act Tier-B"
  // entry, resolved): the SAME registration-time consent draft/notify's
  // native fast-path already required (the Autonomous toggle itself) now
  // ALSO covers app-act, with one extra check below: the recipe id native
  // read from the freshly re-read persisted agent.json (--trusted-app-act-
  // recipe-id) must still match what THIS plan carries — defense-in-depth
  // against the plan diverging from the registered/consented recipe between
  // native's read and this executor's own read moments later.
  if (trustedAction !== 'draft' && trustedAction !== 'notify' && trustedAction !== 'app-act') return false;
  if (trustedAction !== actionType) return false;
  if (actionType === 'app-act') {
    const trustedRecipeId = String(args['trusted-app-act-recipe-id'] || '').trim();
    const planRecipeId = String((plan.action && plan.action.appActRecipeId) || '').trim();
    if (!trustedRecipeId || trustedRecipeId !== planRecipeId) return false;
  }
  // Widened 2026-07-14 (round 2) per project owner directive: chat-confirmed
  // agent.autonomous consent is the trust boundary, not the tool backend —
  // "たとえパープレだろうとCodexだろうと" (even Perplexity or Codex). Native
  // no longer restricts trustedTool to 'local' (see AgentRuntime.kt's
  // trustedPlanLaunch); a cloud tool still can't reach this point at all
  // unless autonomousCloudConsent was separately granted at script-generation
  // time (Spec A §4, lib/agent-executor.ts). We still require trustedTool to
  // agree with what THIS plan actually carries — defense-in-depth against the
  // plan's tool diverging from what native read moments earlier.
  return trustedTool !== '' && trustedTool === plan.tool.type;
}

// North Star P0(c) fix (docs/superpowers/DEFERRED.md's "スケジュール実行が
// 多段オーケストレーションを使わない問題"): AgentRuntime.kt now routes ANY
// scheduled/unattended fire for an agent with orchestration.steps through
// this executor (not just agent.autonomous ones taking the old draft/notify/
// app-act native fast-path), so this gate's policy must match what the
// legacy .sh executor's request_and_wait_approval already does unattended
// for the SAME action types — otherwise a real orchestrated agent that
// today fires successfully (collapsed to one step) via .sh would newly be
// silently skipped here after the routing change, a strict regression.
// The .sh executor's policy (lib/agent-executor.ts's dispatch_agent_action):
// draft/notify/webhook/cli fire unattended whenever ACTION_APPROVAL_MODE is
// "auto" (the default), with NO dependency on agent.autonomous; intent/
// dm-reply are always hard-refused unattended; app-act requires
// AGENT_AUTONOMOUS=1. Mirror that exactly here — requireActionApprovalTap()
// is this executor's equivalent of ACTION_APPROVAL_MODE != "manual", and
// trustedNativeLowRiskAction() is what already gates the app-act
// agent.autonomous requirement (via AgentRuntime.kt's trustedPlanLaunch).
function unattendedPreflightFailure(args, plan, config = {}) {
  if (!argTruthy(args.unattended)) return '';
  const actionType = plan.action.type;
  if (actionType === '__suppressed__') return '';
  if (actionType === 'intent' || actionType === 'dm-reply' || actionType === 'browser-pane') {
    // browser-pane (2026-08-04): joins intent/dm-reply's hard unattended
    // refusal, with NO app-act-style Tier-B exception -- there is no
    // BrowserPane UI surface (nothing rendered, nothing on screen) during an
    // unattended/alarm-fired PlanSpec run for trustedNativeLowRiskAction to
    // even meaningfully vouch for. See store/types.ts's
    // AgentAction.browserPaneAction doc comment for the full rationale.
    return `unsupported unattended PlanSpec action: ${actionType}`;
  }
  if (actionType === 'app-act') {
    return trustedNativeLowRiskAction(args, plan, actionType)
      ? ''
      : `${actionType} action is not trusted for unattended PlanSpec execution`;
  }
  if (actionType === 'social-post') {
    // social-post's unattended gate is the host opt-in, not agent.autonomous:
    // only a connector host the user explicitly consented to via
    // SHELLY_SOCIAL_HOST_ALLOWLIST may dispatch silently unattended (mirrors
    // the .sh executor, where a non-allowlisted host's mandatory approval
    // wait would just time out fail-closed on an unattended fire).
    const social = plan.action.socialPost || {};
    const envPrefix = socialConnectorEnvPrefix(social.connectorId);
    const host = String(config[envPrefix + '_HOST'] || '').trim().toLowerCase();
    if (!socialHostIsAllowlisted(host, config)) {
      return 'social-post destination host is not opted into SHELLY_SOCIAL_HOST_ALLOWLIST and cannot run unattended';
    }
    if (requireActionApprovalTap(plan, config)) {
      return 'social-post action requires manual approval and cannot run unattended';
    }
    return '';
  }
  if (actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli' && actionType !== 'api-call') {
    return `unsupported unattended PlanSpec action: ${actionType}`;
  }
  if (requireActionApprovalTap(plan, config)) {
    return `${actionType} action requires manual approval and cannot run unattended`;
  }
  return '';
}

// Project owner directive 2026-07-14: resolves whether the mandatory
// "Runtime Review" approval TAP defaults on or off for THIS plan/action —
// independent of trustedNativeLowRiskAction (which governs whether the
// action may run unattended at all, and for app-act specifically whether it
// may auto-fire with no reply-waiter at all). plan.agent.requireActionApproval
// is the per-agent override baked at plan-build time (lib/agent-plan-spec.ts);
// config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL is the global default, read
// live from .env (settings-store.ts syncs it on every change) so toggling it
// applies to already-generated plans without needing an agent re-save.
function requireActionApprovalTap(plan, config) {
  if (typeof plan.agent.requireActionApproval === 'boolean') return plan.agent.requireActionApproval;
  return argTruthy(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL);
}

function dispatchActionTrusted(paths, opts, plan, config, roots, resultText, args) {
  const actionType = plan.action.type;
  const preview = previewText(resultText);
  if (actionType === '__suppressed__') {
    // Single-process-PER-STEP callers (the older, attended per-step
    // invocation model — see e.g. __tests__/plan-executor.test.ts's "saves
    // the draft ... for a __suppressed__ orchestration step" and
    // __tests__/plan-executor-orchestration.test.ts) rely on this write:
    // each step there is a genuinely separate `run()` process invocation
    // with no shared memory, so the NEXT step's process needs this step's
    // output back off disk. Still save the draft (so the next step can
    // read it) but request no approval and fire no notification.
    // Best-effort, like the .sh.
    //
    // runOrchestrationChain (Increment 2, in-process chain mode) does NOT
    // route its own non-final steps through this branch — see its own
    // comment for why (resolveDraftDestination has no per-step
    // differentiation, so writing here from a chain's intermediate step
    // would land at the exact same destination the chain's FINAL step
    // uses, which caused a real stale-content bug, 2026-07-15).
    writeDraftOutputs(paths, opts, plan, config, roots, true);
    return { status: 'success', preview };
  }
  if (actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli' && actionType !== 'intent' && actionType !== 'dm-reply' && actionType !== 'app-act' && actionType !== 'api-call' && actionType !== 'social-post' && actionType !== 'browser-pane') {
    throw new PlanFailure(`unsupported PlanSpec action: ${actionType}`, { exitCode: EXIT.TOOL_DENY });
  }
  // draft/notify have no per-type validation branch below (unlike
  // webhook/dm-reply/app-act), so the quality gate has to sit here instead —
  // before the trust shortcut AND before the approval-request fallback below,
  // so a bad completion is blocked no matter which path a run takes. Mirrors
  // the .sh executor's is_low_quality_completion call placed at the top of
  // each case, before request_and_wait_approval / save_draft_result.
  if ((actionType === 'draft' || actionType === 'notify') && isLowQualityCompletion(preview)) {
    const message = actionType === 'draft'
      ? 'Draft content looks like a prompt echo or AI refusal, not real content — escalating.'
      : 'Notify content looks like a prompt echo or AI refusal, not real content — escalating.';
    writeNotification(paths, plan, 'error', message);
    return { status: 'error', preview: message, errorMessage: message };
  }
  // app-act is deliberately EXCLUDED from this trust shortcut (unlike
  // draft/notify): its own case below always runs so it can still validate +
  // write an approval request carrying the resolved post content — trust
  // there only ever skips the human/JS WAIT (via autoFireTrusted, resolved by
  // native), never the request itself, because native still needs the
  // resolved params to actually fire the recipe. Trusting the shortcut here
  // the same way draft/notify do would silently report "success" without the
  // recipe ever having been dispatched.
  // social-post joins app-act in this exclusion for the same reason: its case
  // below performs the ACTUAL dispatch — trusting the shortcut would report
  // "success" without anything ever having been posted.
  if (actionType !== 'app-act' && actionType !== 'social-post' && trustedNativeLowRiskAction(args, plan, actionType)) {
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'action_trusted_allow',
      agentId: plan.agent.id,
      actionType,
      toolType: plan.tool.type,
    });
  } else {
    // Project owner directive 2026-07-14: draft/notify/webhook/cli skip the
    // approval request ENTIRELY when the resolved approval-mode is 'auto' —
    // no dependency on JS/native being alive to reply (unattended scheduled
    // runs must not block on that). intent/dm-reply always request (they can
    // only ever fire via RN) but pass autoAccept so RN resolves them without
    // a human tap. app-act always requests too, with its own narrower
    // autoFireTrusted flag (NOT governed by requireActionApprovalTap — see
    // that function's doc comment). maybeRequestActionApproval below
    // encapsulates the skip decision so every case's validation code is
    // unchanged either way.
    if (actionType === 'webhook') {
      const webhookUrl = String(plan.action.webhookUrl || '').trim();
      const host = webhookDestinationHost(webhookUrl);
      if (!webhookUrl) {
        const message = 'Webhook action is missing an https URL.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (!host) {
        const message = 'Webhook action requires a valid https URL.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      // The check above the 500-char preview only covers what fits in
      // `preview` — check the FULL redacted body too, since that's what
      // actually ships in the webhook's "result" field (see fullResultText's
      // doc comment). Compute once, reuse for both the quality gate and the
      // payload itself.
      const webhookResultFull = fullResultText(resultText);
      if (isLowQualityCompletion(preview) || isLowQualityCompletion(webhookResultFull)) {
        const message = 'Webhook payload looks like a prompt echo or AI refusal, not real content — escalating.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const payloadFile = path.join(paths.logDir, `webhook-payload-${Date.now()}.json`);
      writeWebhookPayload(payloadFile, plan, 'success', preview, webhookResultFull);
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        destinationHost: host,
        destinationHostAllowlisted: webhookHostIsAllowlisted(host, config),
        payloadPath: path.basename(payloadFile),
      });
      try {
        brokerHttpBodyFile(paths, opts, plan, {
          url: webhookUrl,
          bodyFile: payloadFile,
          approved: true,
          timeoutSeconds: Number(config.WEBHOOK_TIMEOUT_SECONDS || 30),
        });
      } catch (e) {
        const message = e instanceof PlanFailure ? redact(e.message) : redact(String(e));
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      return { status: 'success', preview };
    }
    if (actionType === 'cli') {
      const commandText = String(plan.action.command || '').trim();
      const safety = recomputeCliSafety(commandText, plan.action.safety || {});
      if (!commandText) {
        const message = 'CLI action is missing a command.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (safety.level === 'CRITICAL') {
        const message = `CLI action was blocked by command safety: ${safety.reason || 'critical command'}`;
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        command: commandText,
        safetyLevel: safety.level || '',
        safetyReason: safety.reason || '',
      });
      const cwd = resolveCliCwd(paths, plan, config);
      const execResult = brokerWorkspaceExec(paths, opts, roots, plan, commandText, cwd);
      appendCliActionReport(paths.resultFile, commandText, cwd, safety, execResult);
      if (execResult.rc !== 0) {
        const message = `CLI action failed with exit ${execResult.rc}.`;
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      return { status: 'success', preview };
    }
    if (actionType === 'intent') {
      const intentMode = String(plan.action.intentMode || '').trim();
      const intentTarget = String(plan.action.intentTarget || '').trim();
      if (intentMode !== 'launch' && intentMode !== 'share') {
        const message = 'Intent action has an invalid mode.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (intentMode === 'launch' && !intentTarget) {
        const message = 'Intent action is missing a launch target.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const resolvedShareText = String(plan.action.intentShareText || '').split('{{result}}').join(preview);
      if (intentMode === 'share' && !resolvedShareText.trim()) {
        const message = 'Intent action is missing share text.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        intentMode, intentTarget, intentShareText: resolvedShareText,
        // Attended-only (see unattendedPreflightFailure — intent is never
        // reached here when unattended). RN is always alive by construction,
        // so autoAccept just decides whether it shows the UI card or
        // resolves silently.
        autoAccept: !requireActionApprovalTap(plan, config),
      });
      // Side effect already happened in RN before the accept reply appeared —
      // no broker/native call here, unlike webhook/cli.
      return { status: 'success', preview };
    }
    if (actionType === 'dm-reply') {
      const dmPairingId = String(plan.action.dmPairingId || '').trim();
      if (!dmPairingId) {
        const message = 'DM-reply action is missing a paired conversation.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      let pairings;
      try { pairings = JSON.parse(readFile(paths.dmPairingsFile)); } catch (_) { pairings = null; }
      if (!Array.isArray(pairings)) {
        const message = 'Could not verify the DM-reply pairing.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const pairing = pairings.find((p) => p && typeof p === 'object' && p.id === dmPairingId);
      if (!pairing) {
        const message = 'DM-reply target is no longer paired.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (typeof pairing.revoked !== 'boolean' || typeof pairing.label !== 'string') {
        const message = 'Could not verify the DM-reply pairing.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (pairing.revoked) {
        const message = 'DM-reply target is no longer paired.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (isLowQualityCompletion(preview)) {
        const message = 'DM-reply content looks like a prompt echo or AI refusal, not real content — escalating.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const dmReplyText = String(plan.action.dmReplyText || '').split('{{result}}').join(preview);
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        dmPairingId,
        dmPairingLabel: pairing.label,
        dmReplyText,
        // Attended-only, same reasoning as intent above.
        autoAccept: !requireActionApprovalTap(plan, config),
      });
      return { status: 'success', preview };
    }
    if (actionType === 'app-act') {
      // Unattended dispatch is refused upstream by unattendedPreflightFailure()
      // unless trustedNativeLowRiskAction(args, plan, 'app-act') passes (see
      // that function) -- this case still ALWAYS runs (app-act is excluded
      // from the outer trust shortcut above) so it can validate + write the
      // approval request carrying the resolved post content; autoFireTrusted
      // below tells native it may fire+reply itself with no human/JS wait.
      // Deliberately NOT governed by requireActionApprovalTap — see that
      // function's doc comment for why a blanket "skip the tap" default must
      // never alone unlock an external post.
      const recipeId = String(plan.action.appActRecipeId || '').trim();
      if (!recipeId) {
        const message = 'App-action is missing a recipe.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const resolvedParams = resolveAppActParams(plan.action.appActParams, preview);
      if (Object.keys(resolvedParams).length === 0) {
        const message = 'App-action is missing its recipe parameters.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (isLowQualityCompletion(preview)) {
        const message = 'App-action content looks like a prompt echo or AI refusal, not real content — escalating.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        appActRecipeId: recipeId,
        appActParamsResolved: JSON.stringify(resolvedParams),
        autoFireTrusted: trustedNativeLowRiskAction(args, plan, 'app-act'),
      });
      // Side effect already happened in RN before the accept reply appeared —
      // no broker/native call here, unlike webhook/cli (mirrors intent/dm-reply).
      return { status: 'success', preview };
    }
    if (actionType === 'browser-pane') {
      // browser-pane (2026-08-04): drives a LIVE, on-screen Browser Pane
      // WebView through lib/browser-pane-automation.ts's closed
      // click/fill/extractText set. Unattended dispatch is refused upstream
      // by unattendedPreflightFailure() unconditionally (no Tier-B exception
      // exists for this type, unlike app-act) -- this case only ever runs on
      // an attended fire. The actual side effect happens in RN
      // (fireReviewedAgentBrowserPaneAction) at the moment the human taps
      // Allow, BEFORE the accept reply appears -- mirrors intent/dm-reply/
      // app-act's "fire-then-reply" invariant; no broker/native call here.
      const browserAction = plan.action.browserPaneAction;
      const kind = browserAction && String(browserAction.kind || '').trim();
      const selector = browserAction && String(browserAction.selector || '').trim();
      if (kind !== 'click' && kind !== 'fill' && kind !== 'extractText') {
        const message = 'Browser action has an invalid kind.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (!selector) {
        const message = 'Browser action is missing a CSS selector.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const urlAllowlist = Array.isArray(plan.action.browserPaneUrlAllowlist)
        ? plan.action.browserPaneUrlAllowlist.filter((entry) => typeof entry === 'string' && entry.length > 0)
        : [];
      if (urlAllowlist.length === 0) {
        const message = 'Browser action is missing its URL allowlist.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      // Only the fill kind's value may carry {{result}} — the selector never
      // does (it is a CSS selector, not content), mirroring intent/dm-reply's
      // convention for which fields get the substitution.
      const value = kind === 'fill'
        ? String((browserAction && browserAction.value) || '').split('{{result}}').join(preview)
        : '';
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        browserPaneActionKind: kind,
        browserPaneSelector: selector,
        browserPaneValue: value,
        browserPaneUrlAllowlist: JSON.stringify(urlAllowlist),
        // Deliberately ALWAYS false, unlike intent/dm-reply's
        // !requireActionApprovalTap(plan, config) -- a blind click/fill
        // against a live page is a higher risk tier than launching a known
        // app or replying to a known paired contact; see
        // store/types.ts's AgentAction.browserPaneAction doc comment.
        autoAccept: false,
      });
      return { status: 'success', preview };
    }
    if (actionType === 'api-call') {
      const apiCall = plan.action.apiCall;
      const host = apiCall && String(apiCall.host || '').trim();
      const method = apiCall && String(apiCall.method || '').trim();
      const apiPath = apiCall && String(apiCall.path || '').trim();
      if (!apiCall || !host || (method !== 'GET' && method !== 'POST') || !apiPath) {
        const message = 'API-call action is missing a host, method, or path.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      // The FULL redacted result (not just the 500-char preview) feeds
      // {{result}} in both path (URL-encoded) and, for POST only,
      // bodyTemplate (raw) — mirrors webhook's fullResultText usage above, so
      // a long draft isn't silently truncated before it reaches the
      // templated request.
      const apiResultFull = fullResultText(resultText);
      if (isLowQualityCompletion(preview) || isLowQualityCompletion(apiResultFull)) {
        const message = 'API-call payload looks like a prompt echo or AI refusal, not real content — escalating.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const resolvedApiCall = Object.assign({}, apiCall, {
        path: resolveApiCallTemplate(apiCall.path, encodeURIComponent(apiResultFull)),
      });
      const resolvedBody = method === 'POST' ? resolveApiCallTemplate(apiCall.bodyTemplate, apiResultFull) : '';
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        destinationHost: host,
        // api-call's host is ALWAYS pre-allowlisted by construction (the UI
        // constrains authoring to EGRESS_ALLOWLIST) — unlike webhook, where
        // this reflects an OPTIONAL user-vetted allowlist entry.
        destinationHostAllowlisted: true,
        // Track F (docs/superpowers/DEFERRED.md, api-call authoring surface
        // v1): reuses the generic `command` field (also used by the "cli"
        // action type) to carry "METHOD /resolved/path" so the native
        // approval-tap notification (NotificationDispatcher.kt's "api-call"
        // branch) can show method+path to the approver, not just the host.
        // Uses resolvedApiCall.path (the {{result}}-templated path actually
        // sent), not the raw apiCall.path template, so the approver sees the
        // real outbound request.
        command: `${method} ${resolvedApiCall.path}`,
      });
      let response;
      try {
        response = dispatchApiCallRequest(paths, opts, plan, resolvedApiCall, resolvedBody);
      } catch (e) {
        const message = e instanceof PlanFailure ? redact(e.message) : redact(String(e));
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const responsePreview = redact(response).slice(0, 20000);
      if (!responsePreview.trim()) {
        const message = 'API-call response was empty.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      writeAtomic(paths.resultFile, responsePreview + (responsePreview.endsWith('\n') ? '' : '\n'));
      // Reuses the SAME persistence path 'draft' uses — no new persistence
      // mechanism invented for api-call's response content.
      writeDraftOutputs(paths, opts, plan, config, roots, false);
      writeNotification(paths, plan, 'success', responsePreview);
      return { status: 'success', preview: responsePreview };
    }
    if (actionType === 'social-post') {
      // Mirrors the .sh executor's social-post) case (lib/agent-executor.ts):
      // a NON-allowlisted destination host requires a human approval tap
      // EVERY time, regardless of the approval-mode default (these
      // connectors carry account-level credentials); only a host opted into
      // SHELLY_SOCIAL_HOST_ALLOWLIST takes the ordinary
      // maybeRequestActionApproval path, where 'auto' may dispatch silently.
      const social = plan.action.socialPost || {};
      const platform = String(social.platform || '').trim();
      const connectorId = String(social.connectorId || '').trim();
      if (!platform || !/^[A-Za-z0-9-]+$/.test(connectorId)) {
        const message = 'Social-post action is missing its platform or connector.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const envPrefix = socialConnectorEnvPrefix(connectorId);
      const host = String(config[envPrefix + '_HOST'] || '').trim().toLowerCase();
      if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
        const message = 'Social-post connector host is missing or invalid. Re-register the connector in Settings.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (isLowQualityCompletion(preview)) {
        const message = 'Social-post content looks like a prompt echo or AI refusal, not real content — escalating.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const socialTemplate = typeof social.text === 'string' && social.text.trim() ? social.text : '{{result}}';
      const socialText = socialTemplate.split('{{result}}').join(preview);
      if (!socialText.trim()) {
        const message = 'Social-post action resolved to empty text.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (socialHostIsAllowlisted(host, config)) {
        maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
          destinationHost: host,
          destinationHostAllowlisted: true,
        });
      } else {
        // Mandatory tap: bypasses the maybe- skip entirely. Unattended runs
        // never reach here (unattendedPreflightFailure refuses first).
        requestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
          destinationHost: host,
          destinationHostAllowlisted: false,
        });
      }
      // Secrets are loaded ONLY now (post-approval), scoped to this one
      // connector, and their live values join the redaction set for any
      // error text that could reach a notification or the run log.
      const socialSecrets = loadConnectorSecrets(paths.envFile, envPrefix);
      const socialSecretValues = Object.values(socialSecrets);
      const redactSocial = (t) => redactSecretValues(redact(t), socialSecretValues);
      let socialRequest;
      try {
        socialRequest = buildSocialPostRequest(paths, opts, plan, platform, host, socialText, socialSecrets, social.isArticle === true);
      } catch (e) {
        const message = redactSocial(e instanceof PlanFailure ? e.message : String(e));
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const socialBodyFile = path.join(paths.tmpDir, `plan-social-body-${plan.agent.id}-${process.pid}.json`);
      fs.writeFileSync(socialBodyFile, JSON.stringify(socialRequest.body), { mode: 0o600 });
      let socialHeaderFile = '';
      if (socialRequest.headers && Object.keys(socialRequest.headers).length > 0) {
        socialHeaderFile = path.join(paths.tmpDir, `plan-social-headers-${plan.agent.id}-${process.pid}.json`);
        fs.writeFileSync(socialHeaderFile, JSON.stringify(socialRequest.headers), { mode: 0o600 });
      }
      try {
        brokerHttpBodyFile(paths, opts, plan, {
          url: socialRequest.url,
          bodyFile: socialBodyFile,
          headerFile: socialHeaderFile,
          approved: true,
          timeoutSeconds: Number(config.WEBHOOK_TIMEOUT_SECONDS || 30),
        });
      } catch (e) {
        const message = redactSocial(e instanceof PlanFailure ? e.message : String(e));
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      } finally {
        try { fs.unlinkSync(socialBodyFile); } catch (_) {}
        if (socialHeaderFile) { try { fs.unlinkSync(socialHeaderFile); } catch (_) {} }
      }
      writeNotification(paths, plan, 'success', `Posted to ${platform} (${host}): ${preview}`);
      return { status: 'success', preview };
    }
    maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config);
  }
  if (actionType === 'draft') {
    // Terminal draft: primary + (content-studio) Obsidian mirror, fatal on failure
    // (parity with the .sh save_draft_result under `set -euo pipefail`).
    writeDraftOutputs(paths, opts, plan, config, roots, false);
  }
  if (actionType === 'draft' || actionType === 'notify') {
    writeNotification(paths, plan, 'success', preview);
  }
  return { status: 'success', preview };
}

// Multi-action fan-out (2026-07-23, mirrors lib/agent-executor.ts's
// generateRunScript `useMultiActions` bash loop): plan.actions (>= 2 entries
// — see AgentPlanSpecV1's own doc comment) is dispatched as N INDEPENDENT
// calls to dispatchActionTrusted above, one per entry, each re-running its
// own approval/quality-gate/command-safety checks from scratch — no
// privilege widening, only the COUNT of actions a run may dispatch. Absent
// plan.actions (or < 2 entries) falls straight through to a single
// dispatchActionTrusted(plan) call, UNCHANGED from before this function
// existed — every existing single-shot/chain call site keeps its exact
// pre-2026-07-23 behavior for a single-action plan.
function dispatchActionsTrusted(paths, opts, plan, config, roots, resultText, args) {
  if (!Array.isArray(plan.actions) || plan.actions.length < 2) {
    return dispatchActionTrusted(paths, opts, plan, config, roots, resultText, args);
  }
  const results = [];
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  for (let i = 0; i < plan.actions.length; i += 1) {
    const subAction = plan.actions[i];
    // Object.assign (not JSON.parse(JSON.stringify(...))) — every OTHER field
    // (agent/tool/paths/policy/routeDecision/…) must be the SAME reference
    // every action dispatches against; only `action` differs per entry.
    const subPlan = Object.assign({}, plan, { action: subAction });
    let outcome;
    // unattendedPreflightFailure's top-level call in run() is skipped
    // entirely for a multi-action plan (see that call site's own comment) —
    // gate EACH action individually here instead, so one action ineligible
    // for unattended dispatch (e.g. intent/dm-reply, or a social-post host
    // not opted into SHELLY_SOCIAL_HOST_ALLOWLIST) is recorded as its own
    // 'skipped' outcome without blocking the others.
    const gateFailure = unattendedPreflightFailure(args, subPlan, config);
    if (gateFailure) {
      outcome = { status: 'skipped', preview: redact(gateFailure), errorMessage: redact(gateFailure) };
    } else {
      try {
        outcome = dispatchActionTrusted(paths, opts, subPlan, config, roots, resultText, args);
      } catch (e) {
        // A single action's decline/timeout (ActionSkipped) or a classified
        // PlanFailure must not abort the loop — the whole point of `actions`
        // is that one destination's failure/decline does not stop the
        // others from dispatching. An unexpected (non-classified) throw is
        // ALSO caught and recorded as this action's own failure rather than
        // escaping the loop, for the same reason — it must never silently
        // swallow the run (the caught error is redact()ed into this
        // action's own error message, not lost), but it also must not take
        // down every other action's independent delivery.
        if (e instanceof ActionSkipped) {
          outcome = { status: 'skipped', preview: redact(e.message), errorMessage: redact(e.message) };
        } else if (e instanceof PlanFailure) {
          // AgentActionResult (store/types.ts) has no 'unavailable' status —
          // that value is reserved for model/backend transport failures, not
          // action delivery — so a transient PlanFailure here still folds to
          // this action's own 'error', matching the results[] contract.
          const message = redact(e.message);
          outcome = { status: 'error', preview: message, errorMessage: message };
        } else {
          const message = redact(e && e.message ? e.message : String(e));
          outcome = { status: 'error', preview: message, errorMessage: message };
        }
      }
    }
    const status = outcome.status === 'success' ? 'success' : outcome.status === 'skipped' ? 'skipped' : 'error';
    if (status === 'success') successCount += 1;
    else if (status === 'skipped') skippedCount += 1;
    else errorCount += 1;
    results.push({
      index: i,
      actionType: subAction.type,
      status,
      message: String(outcome.preview || outcome.errorMessage || ''),
    });
  }
  // Partial-success reduction — mirrors AgentRunLog.status's own doc comment
  // (store/types.ts) and lib/agent-executor.ts's identical ACTION_MULTI_*
  // bash reduction EXACTLY: any success -> success (partial delivery is
  // still a useful outcome and must not trip the circuit breaker, which
  // only counts 'error' — lib/agent-circuit-breaker.ts); else any hard
  // failure -> error; else (every action gated as skipped) -> skipped.
  const status = successCount > 0 ? 'success' : errorCount > 0 ? 'error' : (skippedCount > 0 ? 'skipped' : 'success');
  const summary = `${successCount}/${plan.actions.length} actions delivered`;
  const preview = status === 'success' ? summary : `${summary}.`;
  // writeNotification overwrites paths.notifyFile — every per-action
  // dispatchActionTrusted call above may already have written its OWN
  // notification; native reads this file ONCE, after the whole process
  // exits, so this final write deliberately replaces whatever the last
  // action wrote with the ONE consolidated outcome for the whole run
  // (mirrors the .sh executor's identical "last write wins" design for the
  // same reason).
  writeNotification(paths, plan, status, preview);
  return { status, preview, errorMessage: status === 'success' ? '' : preview, actionResults: results };
}

function mirrorBrokerAudit(paths, plan) {
  if (!fs.existsSync(paths.brokerAuditFile)) return;
  try {
    const auditDir = path.join(paths.agentsDir, 'audits');
    ensureDir(auditDir);
    fs.copyFileSync(paths.brokerAuditFile, path.join(auditDir, `${plan.agent.id}-agent-driver-audit.jsonl`));
  } catch (_) {
    // best-effort parity with the shell path
  }
}

// Tool types runOrchestrationChain (below) can actually dispatch a step
// through — exactly the set modelRequest()/extractModelContent() have real
// cases for. A step.tool of any OTHER type (namely `cli`, e.g. a step that
// names "Codex" in its own text) falls back to plan.tool rather than being
// attempted, since this JS executor has no shell-exec / non-HTTP dispatch
// path at all (that's the legacy bash executor's job, lib/agent-executor.ts).
const STEP_TOOL_DISPATCHABLE_TYPES = ['local', 'gemini-api', 'perplexity', 'cerebras', 'groq'];

// DEFERRED.md「PlanSpec executor 経由の無人発火は、品質ゲートでlocalが弾かれても
// エスカレーションラダーへ進まない」: requests model content for `plan`, retrying
// across `plan.toolLadder` (baked once by lib/agent-plan-spec.ts's
// buildAgentPlanSpec — see AgentPlanSpecV1.toolLadder's doc comment; this
// executor carries NO routing logic of its own, only a plain ordered array to
// walk) when an attempt fails with a hard error/unavailable status, or — when
// `checkQuality` is true — a low-quality completion (isLowQualityCompletion).
// Both call sites (run()'s single-shot branch and runOrchestrationChain's
// per-step loop, final step included) pass `checkQuality: true` — a
// low-quality completion from the FINAL step is exactly the bug this feature
// exists to fix (2nd-pass Codex review caught an earlier cut that only
// checked non-final steps, leaving the originally-reported dead-end
// unfixed). dispatchActionTrusted's own later per-action-type gate still
// runs on whatever this returns; re-checking the same predicate there is
// harmless once this helper has already found acceptable content. A
// TOOL_DENY PlanFailure (modelRequest()'s own policy/config refusals, e.g.
// "local PlanSpec endpoint must be loopback") is NEVER retried — see the
// catch block below; that guard's whole point is to stop the run, not hand
// off to a different backend. Each retry swaps ONLY `plan.tool`; every other
// field (prompt, action, limits, ...) is unchanged, matching how the
// attended path's runLadderAttempts (lib/agent-manager.ts) also only ever
// swaps the tool between attempts.
//
// Returns `{resultText, usedTool}` on the first attempt that produces
// acceptable content. Throws the LAST attempt's PlanFailure once every
// candidate (plan.tool followed by plan.toolLadder, in order) has been
// tried — with plan.toolLadderExhaustedNote appended to the message when
// present, so a chain that exhausted its HTTP-dispatchable candidates says
// WHY it stopped (the ladder continues to Codex, which this executor cannot
// spawn) instead of reading like an unexplained final failure.
//
// `priorStepContent` (2026-08-06, DEFERRED.md「重複コンテンツ検知の欠如(P1)」
// follow-up): the immediately preceding orchestration step's resultText, or
// undefined for a non-orchestrated single-shot run / a chain's first step —
// mirrors attemptFailed's own optional third argument in
// lib/agent-escalation-ladder.ts. When `checkQuality` is also true, a
// completion that is a near-verbatim repeat of this prior content is treated
// exactly like a low-quality completion: retried across plan.toolLadder, not
// silently accepted. Found missing entirely in a 2026-08-06 Fable5/Codex
// Hermes-parity re-review: the attended path (lib/agent-manager.ts) already
// threaded this through, but this unattended/scheduled executor had no
// equivalent wiring, so the exact on-device incident isDuplicateOfPriorStep
// was built to catch (a notify step echoing the summarize step verbatim)
// could still slip through for a run nobody was watching.
function requestModelContentWithLadder(paths, opts, plan, config, checkQuality, priorStepContent) {
  const candidates = [plan.tool].concat(Array.isArray(plan.toolLadder) ? plan.toolLadder : []);
  let lastError = new PlanFailure('no tool candidates to try', { handled: true });
  for (let i = 0; i < candidates.length; i += 1) {
    const attemptPlan = i === 0 ? plan : Object.assign({}, plan, { tool: candidates[i] });
    try {
      const request = modelRequest(attemptPlan, config);
      const response = brokerHttp(paths, opts, attemptPlan, request);
      let resultText = extractModelContent(attemptPlan.tool.type, response);
      resultText = enforcePlanCharLimit(attemptPlan, resultText);
      if (checkQuality) {
        const preview = previewText(resultText);
        // Codex review finding (2026-08-06): previewText whitespace-collapses
        // ALL newlines, but the fenced-shell-block / execution-narrative
        // detectors ported into isLowQualityCompletion above are
        // newline-DEPENDENT (they match a fence's opening/inner/closing
        // lines) — checking `preview` alone let a fenced-shell fabrication
        // sail through undetected, since by the time isLowQualityCompletion
        // saw it the fence had no line breaks left to recognize. Mirrors the
        // established pattern dispatchActionTrusted's own webhook/api-call
        // gates already use below (isLowQualityCompletion(preview) ||
        // isLowQualityCompletion(webhookResultFull/apiResultFull)):
        // fullResultText redacts but preserves newlines and does not
        // truncate, so the structural checks see the real shape.
        if (isLowQualityCompletion(preview) || isLowQualityCompletion(fullResultText(resultText))) {
          lastError = new PlanFailure(
            'completion looks like a prompt echo or AI refusal, not real content',
            { handled: true },
          );
          continue;
        }
        if (isDuplicateOfPriorStep(preview, priorStepContent)) {
          lastError = new PlanFailure(
            'completion is a near-verbatim repeat of the prior step, not a new result',
            { handled: true },
          );
          continue;
        }
      }
      return { resultText: resultText, usedTool: attemptPlan.tool };
    } catch (error) {
      if (!(error instanceof PlanFailure)) throw error;
      // Codex review finding: a PlanFailure with exitCode TOOL_DENY is a
      // structural/policy refusal (e.g. modelRequest()'s "local PlanSpec
      // endpoint must be loopback" guard, or an unsupported tool type) — NOT
      // a backend that failed to produce a good response. Retrying past it
      // would silently escalate a fail-closed policy denial to a different
      // (possibly cloud) backend instead of stopping the run, defeating the
      // guard's whole purpose. These must propagate immediately, exactly as
      // they did before toolLadder existed — never added to the ladder walk.
      if (error.exitCode === EXIT.TOOL_DENY) throw error;
      lastError = error;
    }
  }
  if (plan.toolLadderExhaustedNote) {
    throw new PlanFailure(lastError.message + ' ' + plan.toolLadderExhaustedNote, {
      status: lastError.status,
      handled: lastError.handled,
    });
  }
  throw lastError;
}

// Chain-mode execution (Increment 2, 2026-07-15): walk plan.steps.list as an
// ORDERED LINEAR sequence within this single process/execSubprocess call — the
// unattended (scheduled/native-fired) counterpart to the attended path's
// runAgentOrchestrated() (lib/agent-manager.ts), which does the same sequencing
// but as N separate JS-driven re-invocations of a single-step run. Each step
// here is still exactly one broker-mediated model call + (for the final step
// only) one real action dispatch through the SAME dispatchActionTrusted() the
// single-shot path already uses — chaining adds no privilege.
//
// Returns an `action`-shaped object ({status, preview, errorMessage, steps})
// so run()'s shared epilogue (writeRunLog + plan_finish audit line) can treat
// a chain run exactly like a single-shot run's dispatchActionTrusted() result.
// Only ONE aggregate run log / (at most one) notification is written for the
// whole chain — see the `dispatchedFinal` tracking below — matching the
// attended path's own "collapse all per-step logs into one aggregate" contract
// (lib/agent-manager.ts's runAgentOrchestrated doc comment).
function runOrchestrationChain(paths, opts, plan, config, roots, args, startedAt) {
  const budget = resolveStepBudget(plan.steps.budget);
  const priorResults = [];
  const records = [];
  let priorFailed = false;
  // True once dispatchActionTrusted has actually been invoked for the FINAL
  // step — at that point notification-on-success-or-error is entirely
  // dispatchActionTrusted's own responsibility (exactly as it already is for
  // a single-shot run of that same action type), so the fallback aggregate
  // notification below must NOT also fire (one notification per chain, not
  // two). Stays false when the chain stops before reaching the final step
  // (budget/time cutoff, a network failure, or a non-final step's quality
  // gate rejection) — in that case nothing else in this run has notified yet,
  // so the fallback fires exactly once with the aggregate outcome.
  let dispatchedFinal = false;
  // Multi-action fan-out (2026-07-23): set only when the final step's
  // dispatch was itself a >= 2-entry Agent.actions fan-out (dispatchActionsTrusted
  // returns `actionResults` in that case, undefined otherwise) — threaded into
  // this chain's own return value below so writeRunLog's `actionResults` param
  // is populated for an orchestrated agent's fan-out final step exactly like
  // the non-chain single-shot path already does.
  let finalActionResults;
  // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
  // 進まない」: the tool that ACTUALLY produced the final step's content, once
  // it differs from plan.tool (a ladder retry happened) — threaded into this
  // chain's return value so run()'s writeRunLog call reports the real tool,
  // not the original (failed) primary. undefined when the final step never
  // retried (or the chain never reached/dispatched a final step at all).
  let finalUsedTool;

  for (let i = 0; i < plan.steps.list.length; i += 1) {
    const gate = nextStepGate({ stepIndex: i, budget, startedAtMs: startedAt, now: Date.now(), priorFailed });
    if (!gate.proceed) break;

    const step = plan.steps.list[i];
    const isFinal = i === plan.steps.list.length - 1;
    // Phase 7 (2026-08-03): a step's own tool pin (step.tool) is now honored
    // here, when present and dispatchable — before this it was unconditionally
    // ignored ("not a bug", the old comment said, because nothing on this side
    // vetted it against Autonomous Cloud consent). It's safe now because
    // lib/agent-plan-spec.ts's buildAgentPlanSpec already ran EVERY step.tool
    // through the exact same resolveForAutonomous() gate the agent-level
    // plan.tool went through, at plan-BUILD time — this executor never makes
    // that credential decision itself, it only ever consumes an
    // already-vetted value from disk. STEP_TOOL_DISPATCHABLE_TYPES additionally
    // guards against a step pinned to a tool this JS executor has no dispatch
    // code for at all (`cli`, e.g. "Codex" — codex-resolved AGENTS never reach
    // this executor per AgentRuntime.kt's routing, but a step WITHIN a
    // perplexity/gemini/local/etc-resolved agent can still legally name codex
    // in its own text); such a step silently falls back to plan.tool exactly
    // as every step did before this change, rather than throwing.
    // Only the FINAL step carries the plan's real action; every earlier step's
    // stepPlan.action is `__suppressed__` (mirroring toPlanAction's shape,
    // lib/agent-plan-spec.ts) purely for the model request/prompt shape — it
    // is NOT dispatched through dispatchActionTrusted below (see that call
    // site's own comment for why).
    const stepPrompt = buildStepPrompt(plan.prompt, step.instruction, priorResults);
    const stepAction = isFinal ? plan.action : { type: '__suppressed__' };
    const stepTool = (step.tool && STEP_TOOL_DISPATCHABLE_TYPES.indexOf(step.tool.type) !== -1)
      ? step.tool
      : plan.tool;
    const stepPlan = Object.assign({}, plan, { prompt: stepPrompt, action: stepAction, tool: stepTool });
    const stepStart = Date.now();

    // api-call step (v1, non-final only — see AgentOrchestrationStep.apiCall's
    // doc comment in store/types.ts; the FINAL step's real action is always
    // plan.action, so an apiCall set on the last step index is a no-op by
    // construction here). Skips the model-call branch below entirely: no
    // prompt is built and no model is called — this step's carried "result"
    // is the HTTP response body itself, dispatched through the SAME
    // capability broker every model call already uses.
    if (!isFinal && step.apiCall) {
      const lastResult = priorResults.length ? priorResults[priorResults.length - 1] : '';
      const resolvedApiCall = Object.assign({}, step.apiCall, {
        path: resolveApiCallTemplate(step.apiCall.path, encodeURIComponent(lastResult)),
      });
      const resolvedBody = step.apiCall.method === 'POST'
        ? resolveApiCallTemplate(step.apiCall.bodyTemplate, lastResult)
        : '';
      try {
        const response = dispatchApiCallRequest(paths, opts, stepPlan, resolvedApiCall, resolvedBody);
        const preview = redact(response).slice(0, 20000);
        // Deliberately do NOT run isLowQualityCompletion here (unlike the
        // model-call branch's quality gate below): that heuristic targets
        // LLM refusal/echo patterns and would false-positive on ordinary
        // JSON/API response bodies. Empty is still a hard failure.
        if (!preview.trim()) {
          throw new PlanFailure('api-call response was empty', { handled: true });
        }
        records.push({ index: i, instruction: step.instruction, status: 'success', durationMs: Date.now() - stepStart, outputPreview: preview });
        priorResults.push(preview);
      } catch (error) {
        if (!(error instanceof PlanFailure)) throw error;
        const status = error.status === 'unavailable' ? 'unavailable' : 'error';
        const message = redact(error.message);
        records.push({ index: i, instruction: step.instruction, status, durationMs: Date.now() - stepStart, outputPreview: previewText(message) });
        priorFailed = true;
      }
      continue;
    }

    let resultText;
    try {
      // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
      // 進まない」: requestModelContentWithLadder retries plan.toolLadder on a
      // hard error/unavailable status automatically, and (checkQuality: true,
      // for EVERY step, final included — 2nd-pass Codex review finding) on a
      // low-quality completion too. Non-final steps need this because
      // dispatchActionTrusted's `__suppressed__` branch has NO quality gate
      // of its own (by design — a silent, best-effort intermediate save with
      // no human-facing surface to gate), so a non-final step relies on THIS
      // check alone to keep a bad completion from poisoning every later
      // step's prompt (the exact on-device failure mode this whole
      // quality-gate effort started from, 2026-07-15). The FINAL step needs
      // it for the ORIGINAL reported bug this feature exists to fix: a
      // low-quality primary completion must retry through the ladder, not
      // dead-end — checking it here and then again inside
      // dispatchActionTrusted below (its own per-action-type gate) is
      // harmless double-checking of the same isLowQualityCompletion
      // predicate, never a behavior conflict. priorStepContent (2026-08-06)
      // is the immediately preceding step's resultText — undefined for the
      // chain's first step, exactly matching isDuplicateOfPriorStep's own
      // "no prior content" no-op case — so a step that merely echoes what
      // the PRIOR step already produced retries the ladder too, not just a
      // prompt-echo/refusal shape.
      const priorStepContent = priorResults.length ? priorResults[priorResults.length - 1] : undefined;
      const attempt = requestModelContentWithLadder(paths, opts, stepPlan, config, true, priorStepContent);
      resultText = attempt.resultText;
      // 3rd-pass Codex review finding (see run()'s own comment above its
      // `let usedTool;` declaration for the full trust-check rationale):
      // `stepPlan.tool` is deliberately NEVER mutated to the retry
      // candidate — the FINAL step's `dispatchActionsTrusted` call below
      // (a few lines down) runs the SAME trustedNativeLowRiskAction() check
      // against `stepPlan.tool.type`, which must stay the ORIGINAL primary
      // tool native vouched for. `finalUsedTool` (below) carries the actual
      // tool forward for `toolUsed` reporting only, via run()'s own
      // writeRunLog call.
      if (isFinal) finalUsedTool = attempt.usedTool;
    } catch (error) {
      // Model/broker-level failure for this step (every ladder candidate
      // exhausted). Mirrors the single-shot path's own outer catch (below): a
      // PlanFailure with status 'unavailable' is a transient web outage
      // (still stops the chain, but reduceStatus folds it away from the
      // circuit breaker); anything else is a hard 'error'. Never let a
      // non-PlanFailure exception (a real bug) be silently absorbed here —
      // rethrow it to run()'s own outer catch.
      if (!(error instanceof PlanFailure)) throw error;
      const status = error.status === 'unavailable' ? 'unavailable' : 'error';
      const message = redact(error.message);
      records.push({ index: i, instruction: step.instruction, status, durationMs: Date.now() - stepStart, outputPreview: previewText(message) });
      priorFailed = true;
      continue;
    }

    writeAtomic(paths.resultFile, resultText + (resultText.endsWith('\n') || resolveCharLimit(stepPlan) ? '' : '\n'));
    const preview = previewText(resultText);

    // Non-final steps skip dispatchActionTrusted's shared `__suppressed__`
    // branch entirely (rather than routing through it, as `stepAction`'s
    // shape might suggest) — that branch's writeDraftOutputs call is real
    // infrastructure other callers depend on (the older, attended per-step
    // invocation model — see dispatchActionTrusted's own comment), but
    // resolveDraftDestination has no per-step differentiation, so writing
    // from HERE would land at the exact same destination this chain's own
    // FINAL step uses. `priorResults` (below) is this executor's actual
    // continuity mechanism — everything runs in one process, so no step
    // ever needs to re-read another step's output back off disk. A real
    // stale-content bug this exact collision caused, found by CI 2026-07-15
    // (case (d) in __tests__/plan-executor-orchestration-chain.test.ts): a
    // rejected chain still left an earlier step's draft sitting at the
    // terminal output location, looking like a completed draft despite the
    // run's status being 'error'.
    // dispatchActionsTrusted (not dispatchActionTrusted directly): stepPlan
    // carries plan.actions forward unchanged (Object.assign above copies
    // every own property of `plan`, `action`/`prompt` are the only fields
    // overridden per-step), so a >= 2-entry Agent.actions fan-out dispatches
    // on the chain's FINAL step exactly like the non-chain single-shot path
    // below — see that function's own doc comment.
    const action = isFinal
      ? dispatchActionsTrusted(paths, opts, stepPlan, config, roots, resultText, args)
      : { status: 'success', preview };
    if (isFinal) {
      dispatchedFinal = true;
      if (action.actionResults) finalActionResults = action.actionResults;
    }
    records.push({ index: i, instruction: step.instruction, status: action.status, durationMs: Date.now() - stepStart, outputPreview: action.preview });
    if (action.status === 'success') priorResults.push(action.preview);
    else priorFailed = true;
  }

  const status = reduceStatus(records);
  const preview = combineFinalPreview(records, plan.steps.list.length);
  if (!dispatchedFinal) {
    // The chain never reached (or never actually dispatched) its final step —
    // fire the ONE notification for the whole chain here. When the final step
    // WAS reached, dispatchActionTrusted already notified (or deliberately
    // didn't, for action types that only notify on error) exactly as a
    // single-shot run of that action type would — do not double-notify.
    writeNotification(paths, plan, status, preview);
  }
  return {
    status,
    preview,
    errorMessage: status === 'success' ? '' : preview,
    steps: records,
    ...(finalActionResults ? { actionResults: finalActionResults } : {}),
    ...(finalUsedTool ? { usedTool: finalUsedTool } : {}),
  };
}

// Shared epilogue for the pre-run refuse paths (kill-switch, unattended-not-trusted):
// notify + run log + a `plan_finish status:skipped` audit line, then exit cleanly.
function finishSkipped(paths, plan, startedAt, message) {
  const durationMs = Date.now() - startedAt;
  writeNotification(paths, plan, 'skipped', message);
  writeRunLog(paths, plan, 'skipped', message, durationMs, message);
  appendJsonl(paths.planAuditFile, {
    ts: new Date().toISOString(),
    kind: 'plan.executor',
    event: 'plan_finish',
    status: 'skipped',
    reason: message,
    durationMs,
  });
  return EXIT.OK;
}

function run(args) {
  let plan = loadPlan(args['plan-file']);
  const expectedAgentId = String(args['agent-id'] || '').trim();
  if (expectedAgentId && expectedAgentId !== plan.agent.id) {
    throw new PlanFailure(`plan agent id mismatch: expected ${expectedAgentId}`, { exitCode: EXIT.PLAN_DENY });
  }
  const home = args.home || process.env.HOME;
  if (!home || !path.isAbsolute(home)) {
    throw new PlanFailure('--home or absolute HOME is required', { exitCode: EXIT.PLAN_DENY });
  }
  const paths = runtimePaths(home, plan.agent.id);
  const opts = {
    libDir: args['lib-dir'] || process.env.SHELLY_LIB_DIR || '',
    broker: args.broker || '',
    // Mirrors the legacy .sh executor's http_post_json, which always forwards
    // "${SHELLY_CAP_TAINTED:-0}" to the broker's --tainted flag. Native sets
    // this env var for notification-triggered (tainted) runs (see
    // AgentRuntime.kt's runPlanAgent) so classifyEgress's tainted-secret-spend
    // gate applies on the PlanSpec path too, not just the legacy .sh path.
    tainted: process.env.SHELLY_CAP_TAINTED === '1',
  };
  ensureDir(paths.tmpDir);
  ensureDir(paths.locksDir);
  ensureDir(paths.logDir);

  const config = parseConfigEnv(paths.envFile);
  // 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 dormant wiring. Native does
  // not pass these flags yet (Migration step 1, AgentActionApprovalBridge signing,
  // is explicitly deferred), so these default to empty/unavailable. Harmless
  // while SIGNED_APPROVAL_ENABLED is false: ensureSignedApprovalVerifierKey /
  // verifySignedApprovalReply are only ever reached from that dormant branch.
  config.signedApprovalPublicKeyPath = args['signed-approval-public-key'] || '';
  config.signedApprovalPublicKeySha256 = args['signed-approval-public-key-sha256'] || '';
  config.allowUnpinnedSignedApprovalVerifierKey = argTruthy(args['allow-unpinned-signed-approval-verifier-key']);
  const roots = scopedRoots(paths, config);
  const startedAt = Date.now();
  appendJsonl(paths.planAuditFile, {
    ts: new Date().toISOString(),
    kind: 'plan.executor',
    event: 'plan_start',
    agentId: plan.agent.id,
    schemaVersion: plan.schemaVersion,
    toolType: plan.tool.type,
    actionType: plan.action.type,
    unattended: argTruthy(args.unattended),
  });

  // Global kill-switch (STOP ALL). haltAllAgents drops a `.halted` sentinel and
  // uninstalls schedules; this is the native/executor-side defense in depth so a
  // still-in-flight alarm or a direct `am` fire is refused before any model IO,
  // not just JS-initiated runs. Fail-closed: refuse (skip), never run.
  if (fs.existsSync(paths.haltSentinel)) {
    return finishSkipped(paths, plan, startedAt, 'All agents are stopped (global kill-switch is on).');
  }

  // Multi-action fan-out (2026-07-23): this top-level gate only ever inspects
  // plan.action.type (the single legacy field) — for a >= 2-entry
  // plan.actions run, plan.action is a compat placeholder never actually
  // dispatched (see AgentPlanSpecV1.action's own doc comment), so gating the
  // WHOLE run on it here would refuse a perfectly runnable multi-action plan
  // (or worse, silently gate it on the wrong single action). Each entry of
  // plan.actions gets its OWN unattendedPreflightFailure check instead,
  // inside dispatchActionsTrusted, so one ineligible action is recorded as
  // its own 'skipped' outcome without blocking the others.
  const isMultiActionPlan = Array.isArray(plan.actions) && plan.actions.length >= 2;
  const unattendedFailure = isMultiActionPlan ? '' : unattendedPreflightFailure(args, plan, config);
  if (unattendedFailure) {
    return finishSkipped(paths, plan, startedAt, redact(unattendedFailure));
  }

  if (!acquireLock(paths)) {
    const message = 'previous run still active';
    writeRunLog(paths, plan, 'skipped', message, 0, message);
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status: 'skipped',
      reason: message,
    });
    return EXIT.OK;
  }

  // Each run opens a fresh CAP-001 egress budget envelope. The broker's budget file
  // (cap-budget-<agentId>.json) is keyed per-agent and persists across runs; without
  // this reset the wall-time budget is measured from the first-ever run, so every run
  // spuriously fails rc=42 "wall-time budget exhausted" ~10 min after the first
  // (found in device-verify). The .sh path already rm's it at run start; mirror it.
  try {
    fs.rmSync(path.join(paths.tmpDir, `cap-budget-${plan.agent.id}.json`), { force: true });
  } catch (_) {}

  // Chain mode (Increment 2): present ONLY when Increment 1's additive
  // `steps` field is on the loaded plan (isOrchestrated agents). Absent
  // `steps` (every plan today, and every non-orchestrated plan going
  // forward) takes the untouched single-shot branch below — byte-identical
  // to this executor's behavior before this increment.
  const hasChain = !!(plan.steps && Array.isArray(plan.steps.list) && plan.steps.list.length > 0);

  // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
  // 進まない」(3rd-pass Codex review finding): the tool that ACTUALLY produced
  // the run's content, tracked SEPARATELY from `plan.tool` — `plan.tool`
  // itself must never be mutated here. trustedNativeLowRiskAction() (called
  // from inside dispatchActionsTrusted below, for app-act/draft/notify's
  // unattended fast-path) compares `plan.tool.type` against native's own
  // `--trusted-tool-type`, fixed at launch time for the ORIGINAL primary
  // tool native already vouched for. Swapping `plan.tool` to a retry
  // candidate would make a successful ladder retry silently fail THAT check
  // — an unattended app-act run that should auto-fire would instead fall
  // through to a stalled/declined approval wait despite content generation
  // having genuinely succeeded. `usedTool` is threaded into writeRunLog
  // explicitly below instead, for `toolUsed` reporting only.
  let usedTool;
  try {
    let action;
    if (hasChain) {
      action = runOrchestrationChain(paths, opts, plan, config, roots, args, startedAt);
      usedTool = action.usedTool;
    } else {
      // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
      // 進まない」: retries plan.toolLadder on a hard error/unavailable status,
      // AND (checkQuality: true — 2nd-pass Codex review finding; the original
      // cut passed false here, which left the exact bug this feature exists
      // to fix — a low-quality primary completion dead-ending instead of
      // escalating — unfixed for every single-shot run) on a low-quality
      // completion too. dispatchActionTrusted below still runs its own
      // per-action-type gate on whatever this returns — harmless double-
      // checking of the same isLowQualityCompletion predicate once this
      // helper has already found acceptable content. enforcePlanCharLimit
      // (G6 hard-clamp) already applied inside the helper.
      const attempt = requestModelContentWithLadder(paths, opts, plan, config, true);
      const resultText = attempt.resultText;
      usedTool = attempt.usedTool;
      writeAtomic(paths.resultFile, resultText + (resultText.endsWith('\n') || resolveCharLimit(plan) ? '' : '\n'));
      action = dispatchActionsTrusted(paths, opts, plan, config, roots, resultText, args);
    }
    const durationMs = Date.now() - startedAt;
    writeRunLog(paths, plan, action.status, action.preview, durationMs, action.errorMessage || '', action.steps, action.actionResults, usedTool);
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status: action.status,
      durationMs,
    });
    return EXIT.OK;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    if (e instanceof ActionSkipped) {
      const message = redact(e.message);
      writeNotification(paths, plan, 'skipped', message);
      writeRunLog(paths, plan, 'skipped', message, durationMs, message);
      appendJsonl(paths.planAuditFile, {
        ts: new Date().toISOString(),
        kind: 'plan.executor',
        event: 'plan_finish',
        status: 'skipped',
        reason: message,
        durationMs,
      });
      return EXIT.OK;
    }
    const status = e instanceof PlanFailure && e.status ? e.status : 'error';
    const message = redact(e && e.message ? e.message : String(e));
    writeAtomic(paths.resultFile, message + '\n');
    writeNotification(paths, plan, status, message);
    writeRunLog(paths, plan, status, message, durationMs, message);
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status,
      reason: message,
      durationMs,
    });
    if (e instanceof PlanFailure && e.handled) return EXIT.OK;
    return e instanceof PlanFailure ? e.exitCode : EXIT.INTERNAL;
  } finally {
    mirrorBrokerAudit(paths, plan);
    releaseLock(paths);
  }
}

function main() {
  try {
    process.exit(run(parseArgs(process.argv.slice(2))));
  } catch (e) {
    process.stderr.write(redact(e && e.stack ? e.stack : e && e.message ? e.message : String(e)) + '\n');
    process.exit(e instanceof PlanFailure ? e.exitCode : EXIT.INTERNAL);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PLAN_SPEC_SCHEMA_VERSION,
  PLAN_SPEC_KIND,
  validatePlan,
  runtimePaths,
  parseConfigEnv,
  isLoopbackUrl,
  // 署名付き承認 (SIGNED-APPROVAL) Migration step 2 — exported for host unit tests
  // only (see __tests__/plan-executor-signed-approval.test.ts). Not part of the
  // executor's CLI surface; SIGNED_APPROVAL_ENABLED gates all production use.
  SIGNED_APPROVAL_ENABLED,
  SIGNED_APPROVAL_ALLOWED_SIG_ALGS,
  canonicalApprovalRequest,
  approvalReplySignatureMessage,
  verifySignedApprovalReply,
  makeSignedApprovalNonceStore,
  ensureSignedApprovalVerifierKey,
  // Project owner directive 2026-07-14 (runtime approval default-off) —
  // exported for host unit tests only (see
  // __tests__/plan-executor-approval-default.test.ts), same convention as
  // the signed-approval exports above. Not part of the executor's CLI surface.
  trustedNativeLowRiskAction,
  unattendedPreflightFailure,
  requireActionApprovalTap,
  // 2026-07-15 quality gate (prompt-echo/refusal detection before
  // webhook/dm-reply/app-act dispatch) — exported for host unit tests only,
  // same convention as the exports above. See isLowQualityCompletion's doc
  // comment near previewText for the three-copy sync requirement.
  isLowQualityCompletion,
  // 2026-08-06 duplicate-content detection (DEFERRED.md「重複コンテンツ検知の
  // 欠如(P1)」follow-up) — exported for host unit tests only, same convention
  // as the exports above.
  isDuplicateOfPriorStep,
  // 2026-07-16 webhook full-body redaction (P0(c) adversarial review fix) —
  // exported for host unit tests only, same convention as the exports above.
  fullResultText,
  // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
  // 進まない」— exported for host unit tests only, same convention as the
  // exports above.
  requestModelContentWithLadder,
  // Orchestration chain mode (Increment 2, 2026-07-15) — exported for host unit
  // tests only (see __tests__/plan-executor-orchestration-chain.test.ts). The
  // four bound constants are asserted equal to lib/agent-orchestration.ts's
  // same-named exports (parity, not just structural-shape parity); the
  // functions are asserted to behave identically to their TS originals for
  // the same inputs. Not part of the executor's CLI surface.
  DEFAULT_MAX_STEPS,
  HARD_MAX_STEPS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  HARD_TOTAL_TIMEOUT_MS,
  resolveStepBudget,
  nextStepGate,
  buildStepPrompt,
  reduceStatus,
  combineFinalPreview,
  runOrchestrationChain,
  // api-call (v1, 2026-07-16) — exported for host unit tests only, same
  // convention as the exports above. Not part of the executor's CLI surface.
  apiCallLabel,
  resolveApiCallTemplate,
  dispatchApiCallRequest,
  dispatchActionTrusted,
  // social-post (2026-07-22) — exported for host unit tests only, same
  // convention as the exports above. Not part of the executor's CLI surface.
  socialConnectorEnvPrefix,
  socialHostIsAllowlisted,
  loadConnectorSecrets,
  redactSecretValues,
  buildSocialPostRequest,
  // x (Twitter) in-process token cache (2026-08-06 Codex review finding) —
  // exported for host unit tests only, same convention as the exports above.
  xAccessTokenCache,
  updateEnvFileSecret,
};
