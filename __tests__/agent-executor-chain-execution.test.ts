jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { MAX_RESULT_CARRY_CHARS } from '@/lib/agent-orchestration';
import { Agent, AgentOrchestrationConfig, ToolChoice } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-exec-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const baseAgent = (tool: ToolChoice, orchestration?: AgentOrchestrationConfig, autonomous = true): Agent => ({
  id: 'chain-agent',
  name: 'Chain Agent',
  description: '',
  prompt: 'base task prompt',
  schedule: null,
  tool,
  autonomous,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  orchestration,
});

/**
 * Extract just the codexOrchestrationChainCommand()-emitted bash (the
 * CODEX_ORCH_* block) out of the FULL generated script, so it can be executed
 * standalone with stub driver/helper functions — running the whole script
 * would require faking the entire agent runtime (locks, env sourcing, output
 * routing, notification dispatch, etc.), none of which this feature touches.
 */
function extractChainSnippet(script: string): string {
  const start = script.indexOf('CODEX_ORCH_BASE_PROMPT=');
  expect(start).toBeGreaterThan(-1);
  const end = script.indexOf('\n\n# Check result', start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

/**
 * Run the extracted chain snippet with a FAKE shelly_timeout_app_binary that
 * records every invocation's --prompt-file content (copied to
 * "$WORKDIR/captured-prompt-N.txt") and, unless N === failAtStep, writes a
 * deterministic "ANSWER-FOR-STEP-N" to --answer-file (simulating a successful
 * driver turn). N === failAtStep instead writes nothing (simulating a driver
 * turn with no usable answer — the same condition codexDriverCommand itself
 * treats as BACKEND_ERROR_FILE-worthy). Returns parsed RESULT::* markers plus
 * each captured prompt file's raw text.
 */
function runChain(
  snippet: string,
  opts: { failAtStep?: number; initialActionType?: string } = {},
): { stepIndex: number; failed: boolean; actionType: string; callCount: number; prompts: string[] } {
  const failAtStep = opts.failAtStep ?? 0;
  const initialActionType = opts.initialActionType ?? 'draft';
  const harness = `set -euo pipefail
WORKDIR=$(mktemp -d)
HOME="$WORKDIR/home"
TMP_DIR="$WORKDIR/tmp"
PROJECT_DIR="$WORKDIR/project"
LOG_DIR="$WORKDIR/log"
mkdir -p "$HOME/.shelly/tmp" "$TMP_DIR" "$PROJECT_DIR" "$LOG_DIR"
: > "$HOME/.shelly-agent-driver.js"
AGENT_ID="chain-agent"
RESULT_FILE="$WORKDIR/result.md"
TIMEOUT=600
START_TIME=$(date +%s)
AGENT_WORKSPACE_ROOT=""
BACKEND_ERROR_FILE="$RESULT_FILE.backend-error"
TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"
RESULT_CONTENT_FILE="$RESULT_FILE"
RESULT_CONTENT_IS_DRIVER_ANSWER=0
CODEX_RESULT_ACTIVE=0
ACTION_TYPE=${JSON.stringify(initialActionType)}
node_usable() { return 0; }
mirror_driver_audit_to_app_private() { return 0; }
mirror_driver_audit_to_sdcard() { return 0; }
FAIL_AT_STEP=${failAtStep}
CALL_COUNT_FILE="$TMP_DIR/call-count.txt"
echo 0 > "$CALL_COUNT_FILE"
shelly_timeout_app_binary() {
  shift # seconds
  shift # binary name ("node")
  answer_file=""
  prompt_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --answer-file) answer_file="$2"; shift 2 ;;
      --prompt-file) prompt_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  n=$(( $(cat "$CALL_COUNT_FILE") + 1 ))
  echo "$n" > "$CALL_COUNT_FILE"
  cp "$prompt_file" "$WORKDIR/captured-prompt-$n.txt"
  if [ "$n" = "$FAIL_AT_STEP" ]; then
    return 1
  fi
  printf 'ANSWER-FOR-STEP-%s' "$n" > "$answer_file"
  return 0
}

${snippet}

echo "RESULT::STEP_INDEX=$CODEX_ORCH_STEP_INDEX"
echo "RESULT::FAILED=$CODEX_ORCH_FAILED"
echo "RESULT::ACTION_TYPE=$ACTION_TYPE"
echo "RESULT::CALL_COUNT=$(cat "$CALL_COUNT_FILE")"
for f in "$WORKDIR"/captured-prompt-*.txt; do
  [ -f "$f" ] || continue
  echo "===PROMPT_START==="
  cat "$f"
  echo
  echo "===PROMPT_END==="
done
`;
  // Run via a temp FILE, not `bash -c "<string>"` — mirrors bashParses'
  // own workaround (see its comment above): a long harness string passed
  // as a single -c argument through execFileSync is unreliable on Windows
  // (argv gets mangled), even though the identical content parses/executes
  // fine from a file. CI runs on ubuntu-latest where this never surfaces.
  const harnessFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-exec-run-')), 'harness.sh');
  fs.writeFileSync(harnessFile, harness);
  const out = execFileSync('bash', [harnessFile]).toString();
  const stepIndex = Number(/RESULT::STEP_INDEX=(-?\d+)/.exec(out)?.[1]);
  const failed = /RESULT::FAILED=1/.test(out);
  const actionType = /RESULT::ACTION_TYPE=(\S*)/.exec(out)?.[1] ?? '';
  const callCount = Number(/RESULT::CALL_COUNT=(\d+)/.exec(out)?.[1]);
  const prompts = out.split('===PROMPT_START===\n').slice(1).map((chunk) => chunk.split('\n===PROMPT_END===')[0]);
  return { stepIndex, failed, actionType, callCount, prompts };
}

describe('generateRunScript — real bash-side chain execution (bug #155(b) follow-up)', () => {
  const threeStepAgent = baseAgent({ type: 'auto' }, {
    steps: [
      'collect the latest news with sources',
      "summarize the findings, don't editorialize",
      'post a digest to X',
    ],
  });

  it('emits exactly one CODEX_ORCH_INSTRUCTIONS array baking all N step instructions (a runtime loop, not N unrolled driver blocks)', () => {
    const s = generateRunScript(threeStepAgent);
    expect(s).toContain('CODEX_ORCH_INSTRUCTIONS=(');
    expect(s).toContain("'collect the latest news with sources'");
    // shellQuote escapes the embedded apostrophe as '\'' — assert the escaped form.
    expect(s).toContain("'summarize the findings, don'\\''t editorialize'");
    expect(s).toContain("'post a digest to X'");
    // Exactly one while-loop driving the chain (not 3 copies of the driver call).
    expect((s.match(/while \[ "\$CODEX_ORCH_STEP_INDEX" -lt/g) ?? []).length).toBe(1);
    bashParses(s);
  });

  it('actually invokes the driver N times for an N-step chain (not 1) — full success', () => {
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent));
    const result = runChain(snippet);
    expect(result.callCount).toBe(3);
    expect(result.stepIndex).toBe(3);
    expect(result.failed).toBe(false);
    // All 3 steps ran to completion (the true final step included) — the
    // configured action is NOT suppressed.
    expect(result.actionType).toBe('draft');
  });

  it("carries the previous step's result forward into the next step's prompt (buildStepPrompt shape)", () => {
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent));
    const result = runChain(snippet);
    expect(result.prompts).toHaveLength(3);
    // Step 1: no prior results yet.
    expect(result.prompts[0]).not.toContain('Results from previous steps');
    expect(result.prompts[0]).toContain('# This step');
    expect(result.prompts[0]).toContain('collect the latest news with sources');
    // Step 2: carries step 1's answer.
    expect(result.prompts[1]).toContain('# Results from previous steps');
    expect(result.prompts[1]).toContain('## Step 1');
    expect(result.prompts[1]).toContain('ANSWER-FOR-STEP-1');
    expect(result.prompts[1]).toContain("summarize the findings, don't editorialize");
    // Step 3: carries BOTH prior steps' answers.
    expect(result.prompts[2]).toContain('## Step 1');
    expect(result.prompts[2]).toContain('ANSWER-FOR-STEP-1');
    expect(result.prompts[2]).toContain('## Step 2');
    expect(result.prompts[2]).toContain('ANSWER-FOR-STEP-2');
    expect(result.prompts[2]).toContain('post a digest to X');
  });

  it('bounds a carried result to MAX_RESULT_CARRY_CHARS (buildStepPrompt\'s own budget, not a separately-hardcoded number)', () => {
    // A step-1 "answer" far longer than the carry budget, with irregular
    // whitespace so the whitespace-collapse behavior is also exercised.
    const longAnswer = 'A'.repeat(50) + '\n\n\n   ' + 'B'.repeat(3000) + '\t\t' + 'C'.repeat(50);
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent)).replace(
      /printf 'ANSWER-FOR-STEP-%s' "\$n" > "\$answer_file"/,
      `if [ "$n" = 1 ]; then printf '%s' ${JSON.stringify(longAnswer)} > "$answer_file"; else printf 'ANSWER-FOR-STEP-%s' "$n" > "$answer_file"; fi`,
    );
    const result = runChain(snippet);
    expect(result.callCount).toBe(3);
    // The carried entry for step 1 inside step 2's prompt: whitespace collapsed
    // to single spaces (tr -s), so the run of newlines/tabs above becomes single
    // spaces, and the WHOLE carried entry is capped at MAX_RESULT_CARRY_CHARS
    // bytes — it can never exceed that budget even though longAnswer is ~3100
    // chars raw.
    const step2Prompt = result.prompts[1];
    expect(step2Prompt).toContain('## Step 1');
    const carriedSection = step2Prompt.split('## Step 1\n')[1].split('\n\n---')[0];
    expect(carriedSection.length).toBeLessThanOrEqual(MAX_RESULT_CARRY_CHARS);
    // Whitespace was actually collapsed (no run of 2+ raw newlines/tabs survives).
    expect(carriedSection).not.toMatch(/\n\n/);
    expect(carriedSection).not.toMatch(/\t/);
  });

  it('stops the chain immediately on a failing step — no retry, no continuing (nextStepGate priorFailed mirror)', () => {
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent));
    const result = runChain(snippet, { failAtStep: 2 });
    // Step 3 never launched.
    expect(result.callCount).toBe(2);
    expect(result.stepIndex).toBe(2);
    expect(result.failed).toBe(true);
    expect(result.prompts).toHaveLength(2);
  });

  it('respects the resolved step-count cap (resolveBudget.maxSteps) even when more steps are authored', () => {
    const cappedAgent = baseAgent({ type: 'auto' }, {
      steps: ['step one', 'step two', 'step three'],
      maxSteps: 2,
    });
    const full = generateRunScript(cappedAgent);
    expect(full).toContain('CODEX_ORCH_MAX_STEPS=2');
    expect(full).toContain('CODEX_ORCH_STEP_TOTAL=3');
    // Only the first 2 authored steps are baked into the runnable array —
    // the 3rd is never sent to the driver either way.
    expect(full).toContain("'step one'");
    expect(full).toContain("'step two'");
    expect(full).not.toContain("'step three'");

    const snippet = extractChainSnippet(full);
    const result = runChain(snippet);
    expect(result.callCount).toBe(2);
    expect(result.stepIndex).toBe(2);
    expect(result.failed).toBe(false);
    // Budget stopped the chain before its TRUE final step (index 2 of 3) ran —
    // mirrors runAgentOrchestrated: the configured action must NOT fire on an
    // intermediate step's content.
    expect(result.actionType).toBe('__suppressed__');
  });

  it('never dispatches the configured action on a failed chain either (existing BACKEND_ERROR_FILE gate, unchanged)', () => {
    // Sanity check that the ACTION_TYPE override logic does not accidentally
    // UN-suppress a failed run — the existing "Check result" section already
    // refuses to call dispatch_agent_action at all when BACKEND_ERROR_FILE is
    // set (see the outer `if [ -s "$RESULT_CONTENT_FILE" ] ... [ ! -f
    // "$BACKEND_ERROR_FILE" ]` in generateRunScript's template), so this is a
    // defense-in-depth assertion, not a load-bearing one.
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent));
    const result = runChain(snippet, { failAtStep: 1 });
    expect(result.failed).toBe(true);
    expect(result.callCount).toBe(1);
  });
});

describe('generateRunScript — chain execution: residual-unsupported cases still fall back correctly', () => {
  it('a step carrying apiCall keeps the OLD single-shot codexDriverCommand path (no CODEX_ORCH_ tokens at all)', () => {
    const agentWithApiCall = baseAgent({ type: 'auto' }, {
      steps: [
        { instruction: 'call an API', apiCall: { host: 'api.perplexity.ai', method: 'POST', path: '/chat/completions', authRef: 'perplexity' } },
        'post the result',
      ],
    });
    const s = generateRunScript(agentWithApiCall);
    expect(s).not.toContain('CODEX_ORCH_');
    expect(s).toContain('DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
  });

  it('a step carrying its own tool pin keeps the OLD single-shot codexDriverCommand path (no CODEX_ORCH_ tokens at all)', () => {
    const agentWithToolPin = baseAgent({ type: 'auto' }, {
      steps: [
        'collect the news',
        { instruction: 'summarize locally', tool: { type: 'local' } },
      ],
    });
    const s = generateRunScript(agentWithToolPin);
    expect(s).not.toContain('CODEX_ORCH_');
  });
});

describe('generateRunScript — non-orchestrated agent: no capability/behavior regression', () => {
  const singleAgent = baseAgent({ type: 'auto' }, undefined);

  it('never emits any CODEX_ORCH_ token for a non-orchestrated agent', () => {
    const s = generateRunScript(singleAgent);
    expect(s).not.toContain('CODEX_ORCH_');
    expect(s).not.toContain('codex_orch_build_prompt');
    expect(s).not.toContain('codex_orch_collapse_and_truncate');
  });

  it('keeps the exact unmodified codexDriverCommand() invocation shape', () => {
    const s = generateRunScript(singleAgent);
    // These lines come verbatim from codexDriverCommand(), which this change
    // does not touch — their presence (byte-for-byte) is the regression guard.
    expect(s).toContain('DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
    expect(s).toContain('[ -d "$DRIVER_CWD" ] || DRIVER_CWD="$HOME"');
    expect(s).toContain("if node_usable && [ -f \"$HOME/.shelly-agent-driver.js\" ]; then\n  rm -f \"$RESULT_FILE.answer\"");
    expect(s).toContain('--approval-policy untrusted \\');
    expect(s).toContain('--prompt-file "$PROMPT_FILE" > "$RESULT_FILE" 2>&1');
    expect(s).toContain('rm -f "$PROMPT_FILE"');
  });

  it('produces byte-identical output whether orchestration is undefined or a single-step chain (both isOrchestrated===false, both must take the plain codexDriverCommand path)', () => {
    const withoutOrchestration = generateRunScript(baseAgent({ type: 'auto' }, undefined));
    const withOneStep = generateRunScript(baseAgent({ type: 'auto' }, { steps: ['only one step'] }));
    expect(withOneStep).toBe(withoutOrchestration);
  });

  it('bash -n parses the full generated script', () => {
    bashParses(generateRunScript(singleAgent));
  });

  // Security review finding (2026-07-16): codex_orch_collapse_and_truncate
  // whitespace-collapsed and truncated a step's raw driver answer before
  // carrying it into the NEXT step's prompt, but never redacted it — unlike
  // every other place a driver answer is carried in this file
  // (clean_answer_preview/result_preview both route through
  // redact_secrets_text first). A secret echoed in a non-final step's answer
  // (e.g. an accidentally-surfaced env var or file read) would flow
  // unredacted into the next step's prompt, which is sent off-device to the
  // codex backend.
  it('redacts a secret from a non-final step\'s answer before carrying it into the next step\'s prompt', () => {
    const threeStepAgent = baseAgent({ type: 'auto' }, {
      steps: ['collect the secret', 'use the carried result', 'final step'],
    });
    const snippet = extractChainSnippet(generateRunScript(threeStepAgent));
    const harness = `set -euo pipefail
WORKDIR=$(mktemp -d)
HOME="$WORKDIR/home"
TMP_DIR="$WORKDIR/tmp"
PROJECT_DIR="$WORKDIR/project"
LOG_DIR="$WORKDIR/log"
mkdir -p "$HOME/.shelly/tmp" "$TMP_DIR" "$PROJECT_DIR" "$LOG_DIR"
: > "$HOME/.shelly-agent-driver.js"
AGENT_ID="chain-agent"
RESULT_FILE="$WORKDIR/result.md"
TIMEOUT=600
START_TIME=$(date +%s)
AGENT_WORKSPACE_ROOT=""
BACKEND_ERROR_FILE="$RESULT_FILE.backend-error"
TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"
RESULT_CONTENT_FILE="$RESULT_FILE"
RESULT_CONTENT_IS_DRIVER_ANSWER=0
CODEX_RESULT_ACTIVE=0
ACTION_TYPE="draft"
node_usable() { return 0; }
mirror_driver_audit_to_app_private() { return 0; }
mirror_driver_audit_to_sdcard() { return 0; }
# Fake redact_secrets_text: proves codex_orch_collapse_and_truncate actually
# calls the real production hook (by name, on the right file) rather than
# skipping redaction — a real regex-based scan is exercised separately by
# redact_secrets_text's own dedicated tests elsewhere in this suite.
REDACT_CALL_LOG="$WORKDIR/redact-calls.txt"
: > "$REDACT_CALL_LOG"
redact_secrets_text() {
  echo "$1" >> "$REDACT_CALL_LOG"
  sed 's/SUPER-SECRET-TOKEN-XYZ/<redacted:test>/g' "$1"
}
CALL_COUNT_FILE="$TMP_DIR/call-count.txt"
echo 0 > "$CALL_COUNT_FILE"
shelly_timeout_app_binary() {
  shift; shift
  answer_file=""
  prompt_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --answer-file) answer_file="$2"; shift 2 ;;
      --prompt-file) prompt_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  n=$(( $(cat "$CALL_COUNT_FILE") + 1 ))
  echo "$n" > "$CALL_COUNT_FILE"
  cp "$prompt_file" "$WORKDIR/captured-prompt-$n.txt"
  if [ "$n" = "1" ]; then
    printf 'Here is the value: SUPER-SECRET-TOKEN-XYZ end.' > "$answer_file"
  else
    printf 'ANSWER-FOR-STEP-%s' "$n" > "$answer_file"
  fi
  return 0
}

${snippet}

for f in "$WORKDIR"/captured-prompt-*.txt; do
  [ -f "$f" ] || continue
  echo "===PROMPT_START==="
  cat "$f"
  echo
  echo "===PROMPT_END==="
done
echo "REDACT_CALLS:"
cat "$REDACT_CALL_LOG"
`;
    const harnessFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-exec-redact-')), 'harness.sh');
    fs.writeFileSync(harnessFile, harness);
    const out = execFileSync('bash', [harnessFile]).toString();
    const prompts = out.split('===PROMPT_START===\n').slice(1).map((chunk) => chunk.split('\n===PROMPT_END===')[0]);
    // Step 2's prompt carries step 1's (redacted) result forward.
    expect(prompts[1]).toContain('<redacted:test>');
    expect(prompts[1]).not.toContain('SUPER-SECRET-TOKEN-XYZ');
    // redact_secrets_text was genuinely invoked (not bypassed) — at least
    // once for the carry-forward path.
    expect(out).toMatch(/REDACT_CALLS:\n.*\S/s);
  });
});
