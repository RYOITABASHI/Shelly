/**
 * Sourced briefings (2026-10-09) — the GENERATED bash scripts
 * (lib/agent-executor.ts):
 *  1. extract_ai_content numbers the appended "## Sources" block in
 *     CITATIONS order (the order Perplexity's [n] markers use), with titles /
 *     dates from search_results by URL (v65);
 *  2. the attended-chain script options: model-free dispatch run
 *     (presetResultText), last-attempt sourced fallback, skipped intermediate
 *     draft save, per-run step-result nonce, PERPLEXITY_MODEL precedence;
 *  3. the Codex-driver bash chain (codexOrchestrationChainCommand) applies
 *     the same sourcing through the PlanSpec executor's --sourcing-op CLI:
 *     research directive, structured carry, text-only synthesis, final
 *     post-processing, no-sources / helper-missing fail closed.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chainSourcingFor, generateRunScript } from '@/lib/agent-executor';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { NO_SOURCES_MESSAGE, RESEARCH_REQUIREMENTS_MARKER, SOURCED_OUTPUT_UNVERIFIABLE_MESSAGE } from '@/lib/agent-sources';
import type { Agent, AgentOrchestrationConfig, ToolChoice } from '@/store/types';

const root = path.resolve(__dirname, '..');

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bashParses(script: string): void {
  const file = path.join(tmpdir('sourced-parse-'), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const agentOf = (tool: ToolChoice, orchestration?: AgentOrchestrationConfig, autonomous = true, prompt = 'Daily on-device AI news briefing'): Agent => ({
  id: 'sourced-agent',
  name: 'Sourced Agent',
  description: '',
  prompt,
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
  action: { type: 'draft' },
  orchestration,
});

describe('extract_ai_content — Sources block in citations order (v65)', () => {
  function extractProgram(): string {
    const s = generateRunScript(agentOf({ type: 'perplexity', model: 'sonar' }, undefined, false));
    const start = s.indexOf('extract_ai_content() {');
    const body = s.slice(start);
    const prog = body.split("<<'NODEEOF'\n")[1].split('\nNODEEOF')[0];
    expect(prog).toMatch(/citations order/i);
    return prog;
  }

  it('numbers by citations, enriches from search_results, keeps skipped slots, appends uncited results', () => {
    const dir = tmpdir('extract-');
    const progFile = path.join(dir, 'extract.js');
    fs.writeFileSync(progFile, extractProgram());
    const responseFile = path.join(dir, 'response.json');
    fs.writeFileSync(
      responseFile,
      JSON.stringify({
        choices: [{ message: { content: 'A [1]. B [3].' } }],
        citations: ['https://b.example/two', 'not-a-url', 'https://a.example/one'],
        search_results: [
          { title: 'Alpha', url: 'https://a.example/one', date: '2026-09-01' },
          { title: 'Bravo', url: 'https://b.example/two' },
          { title: 'Charlie', url: 'https://c.example/three', date: '2026-09-03' },
        ],
      }),
    );
    const out = execFileSync(process.execPath, [progFile, responseFile]).toString();
    expect(out).toContain('\n\n## Sources\n');
    const lines = out.split('## Sources\n')[1].split('\n');
    expect(lines).toEqual([
      '[1] Bravo — https://b.example/two',
      '[3] Alpha — https://a.example/one (2026-09-01)',
      '[4] Charlie — https://c.example/three (2026-09-03)',
    ]);
  });
});

describe('attended chain-step script options', () => {
  const base = agentOf({ type: 'local' }, undefined, false);

  it('presetResultText replaces the model call with the verified text (dispatch run)', () => {
    const s = generateRunScript(base, { presetResultText: '# Briefing\n\n1. **X** — y [1]\n\n## Sources\n\n- [1] [X](https://x.example)' });
    expect(s).toContain("cat > \"$RESULT_FILE\" <<'SHELLY_PRESET_RESULT_EOF'");
    expect(s).toContain('- [1] [X](https://x.example)');
    expect(s).not.toContain('ensure_local_llm_server "$LOCAL_URL"');
    bashParses(s);
  });

  it('sourcedFallbackText bakes the deterministic fallback; absent → byte-identical', () => {
    const plain = generateRunScript(base, { isOrchestratedStep: true });
    expect(plain).not.toContain('SHELLY_SOURCED_FALLBACK_EOF');
    const s = generateRunScript(base, { isOrchestratedStep: true, sourcedFallbackText: '# Briefing\n\n1. **X** [1]' });
    expect(s).toContain("cat > \"$RESULT_CONTENT_FILE\" <<'SHELLY_SOURCED_FALLBACK_EOF'");
    expect(s).toMatch(/is_low_quality_completion "\$SOURCED_FALLBACK_PREVIEW"/);
    bashParses(s);
  });

  it('skipSuppressedDraftSave and the per-run step-result nonce', () => {
    const s = generateRunScript(base, { suppressAction: true, isOrchestratedStep: true, skipSuppressedDraftSave: true, stepResultToken: 'abc123' });
    expect(s).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
    expect(s).toContain('"$TMP_DIR/agent-step-result-$AGENT_ID-abc123.md"');
    const bad = generateRunScript(base, { isOrchestratedStep: true, stepResultToken: '../x' });
    expect(bad).toContain('"$TMP_DIR/agent-step-result-$AGENT_ID.md"');
    expect(generateRunScript(base)).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=0');
  });

  it('a user PERPLEXITY_MODEL overrides the per-agent model (same precedence as the PlanSpec executor)', () => {
    const s = generateRunScript(agentOf({ type: 'perplexity', model: 'sonar' }, undefined, false));
    expect(s).toContain('MODEL="${PERPLEXITY_MODEL:-sonar}"');
  });
});

// ─── Codex-driver bash chain ──────────────────────────────────────────────────

const SOURCED_CHAIN: AgentOrchestrationConfig = {
  steps: ['search the web for the top 3 on-device AI news stories', 'summarize them', 'write a markdown briefing'],
};

describe('chainSourcingFor', () => {
  it('flags only explicit web research; local chains get no sourcing', () => {
    expect(chainSourcingFor('x', normalizeSteps(SOURCED_CHAIN))).toEqual({ research: [true, false, false], recency: 'month', count: 3 });
    expect(chainSourcingFor('x', normalizeSteps({ steps: ['collect the latest git commits', 'summarize', 'post'] }))).toBeUndefined();
  });
});

function extractChainSnippet(script: string): string {
  const start = script.indexOf('CODEX_ORCH_BASE_PROMPT=');
  expect(start).toBeGreaterThan(-1);
  const end = script.indexOf('\n\n# Check result', start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

const RESEARCH_ANSWER = [
  '1. **Google releases Gemma 3n for on-device AI** (2026-09-30) — Google released Gemma 3n, a mobile-first open model that runs on phones with 2GB of RAM. [1]',
  '2. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** (2026-09-24) — Qualcomm announced a faster Hexagon NPU for on-device generative AI. [2]',
  '',
  '## Sources',
  '[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/ (2026-09-30)',
  '[2] Snapdragon 8 Elite Gen 5 — https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5',
].join('\n');

function runSourcedChain(opts: { researchAnswer: string; localAnswers: string[]; withExecutor?: boolean }) {
  const snippet = extractChainSnippet(generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, SOURCED_CHAIN)));
  const dir = tmpdir('sourced-chain-');
  fs.writeFileSync(path.join(dir, 'research.txt'), opts.researchAnswer);
  opts.localAnswers.forEach((a, i) => fs.writeFileSync(path.join(dir, `local-${i + 1}.txt`), a));
  const exec = path.join(root, 'scripts', 'shelly-plan-executor.js').replace(/\\/g, '/');
  const harness = `set -euo pipefail
WORKDIR=${JSON.stringify(dir.replace(/\\/g, '/'))}
HOME="$WORKDIR/home"
TMP_DIR="$WORKDIR/tmp"
PROJECT_DIR="$WORKDIR/project"
LOG_DIR="$WORKDIR/log"
mkdir -p "$HOME/.shelly/tmp" "$TMP_DIR" "$PROJECT_DIR" "$LOG_DIR"
: > "$HOME/.shelly-agent-driver.js"
${opts.withExecutor === false ? '' : `cp ${JSON.stringify(exec)} "$HOME/.shelly-plan-executor.js"`}
AGENT_ID="sourced-agent"
RESULT_FILE="$WORKDIR/result.md"
TIMEOUT=600
START_TIME=$(date +%s)
AGENT_WORKSPACE_ROOT=""
BACKEND_ERROR_FILE="$RESULT_FILE.backend-error"
TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"
RESULT_CONTENT_FILE="$RESULT_FILE"
RESULT_CONTENT_IS_DRIVER_ANSWER=0
CODEX_RESULT_ACTIVE=0
ACTION_TYPE=draft
node_usable() { return 0; }
shelly_node() { ${JSON.stringify(process.execPath.replace(/\\/g, '/'))} "$@"; }
mirror_driver_audit_to_app_private() { return 0; }
mirror_driver_audit_to_sdcard() { return 0; }
DRIVER_CALLS=0
shelly_timeout_app_binary() {
  shift; shift
  answer_file=""; prompt_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --answer-file) answer_file="$2"; shift 2 ;;
      --prompt-file) prompt_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  DRIVER_CALLS=$((DRIVER_CALLS + 1))
  cp "$prompt_file" "$WORKDIR/driver-prompt-$DRIVER_CALLS.txt"
  cp "$WORKDIR/research.txt" "$answer_file"
  return 0
}
LOCAL_CALLS=0
json_string_file() { shelly_node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$1"; }
ensure_local_llm_server() { : > "$TMP_DIR/local-llm-start-$AGENT_ID.reason"; return 0; }
local_llm_start_activity_heartbeat() { :; }
local_llm_stop_activity_heartbeat() { :; }
local_context_fallback() { echo "fallback"; }
http_post_json() {
  LOCAL_CALLS=$((LOCAL_CALLS + 1))
  cp "$2" "$WORKDIR/local-request-$LOCAL_CALLS.json"
  if [ -f "$WORKDIR/local-$LOCAL_CALLS.txt" ]; then
    shelly_node -e 'process.stdout.write(JSON.stringify({choices:[{message:{content:require("fs").readFileSync(process.argv[1],"utf8")}}]}))' "$WORKDIR/local-$LOCAL_CALLS.txt" > "$3"
  else
    return 7
  fi
}
extract_ai_content() { shelly_node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.choices[0].message.content)' "$1"; }

${snippet}

echo "RESULT::FAILED=$CODEX_ORCH_FAILED"
echo "RESULT::DRIVER_CALLS=$DRIVER_CALLS"
echo "RESULT::LOCAL_CALLS=$LOCAL_CALLS"
echo "RESULT::CONTENT=$RESULT_CONTENT_FILE"
`;
  const harnessFile = path.join(dir, 'harness.sh');
  fs.writeFileSync(harnessFile, harness);
  let out: string;
  try {
    out = execFileSync('bash', [harnessFile], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e: any) {
    throw new Error(`harness failed: ${String(e.stderr || e.message).slice(-2000)}`);
  }
  const contentFile = /RESULT::CONTENT=(.*)/.exec(out)![1].trim();
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    failed: /RESULT::FAILED=1/.test(out),
    driverCalls: Number(/RESULT::DRIVER_CALLS=(\d+)/.exec(out)![1]),
    localCalls: Number(/RESULT::LOCAL_CALLS=(\d+)/.exec(out)![1]),
    content: read(contentFile.replace(/^\/([a-z])\//i, '$1:/')) || read(contentFile),
    driverPrompt: read(path.join(dir, 'driver-prompt-1.txt')),
    localRequests: [1, 2].map((n) => read(path.join(dir, `local-request-${n}.json`))),
  };
}

describe('codexOrchestrationChainCommand — sourced chain', () => {
  it('is only emitted for a sourced chain (ordinary chains unchanged) and parses', () => {
    const plain = generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, { steps: ['collect the meeting notes', 'summarize them', 'post'] }));
    expect(plain).not.toContain('CODEX_ORCH_SOURCING');
    const sourced = generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, SOURCED_CHAIN));
    expect(sourced).toContain('CODEX_ORCH_SOURCING=1');
    expect(sourced).toContain('CODEX_ORCH_RESEARCH=( 1 0 0 )');
    bashParses(sourced);
  });

  it('research on Codex, summarize/write text-only on the local LLM, final post-processed with Sources', () => {
    const r = runSourcedChain({
      researchAnswer: RESEARCH_ANSWER,
      localAnswers: [
        'On-device AI had an exciting month overall.',
        "# Briefing\n\n1. **Apple Unveils 'Apple Neural LLM'** — fake. [1]\n2. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]",
      ],
    });
    expect(r.failed).toBe(false);
    expect(r.driverCalls).toBe(1); // only the research step used the Codex driver
    expect(r.localCalls).toBe(2);
    expect(r.driverPrompt).toContain(RESEARCH_REQUIREMENTS_MARKER);
    const step2 = JSON.parse(r.localRequests[0]).messages[1].content as string;
    expect(step2).toContain('[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/');
    expect(step2).toContain('# Sourcing contract');
    expect(JSON.parse(r.localRequests[0]).temperature).toBe(0.2);
    // Step 2's uncited essay was replaced by the research template in the carry.
    const step3 = JSON.parse(r.localRequests[1]).messages[1].content as string;
    expect(step3).not.toContain('exciting month');
    expect(step3).toContain('Google releases Gemma 3n for on-device AI');
    expect(r.content).not.toContain('Neural LLM');
    expect(r.content).toContain('1. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]');
    expect(r.content).toContain('## Sources');
    expect(r.content).toContain('- [1] [Announcing Gemma 3n](https://blog.google/technology/developers/gemma-3n/) — 2026-09-30');
  });

  it('a failed summarize/write step falls back to the deterministic sourced briefing', () => {
    const r = runSourcedChain({ researchAnswer: RESEARCH_ANSWER, localAnswers: ['- **Google releases Gemma 3n for on-device AI** — model [1]'] });
    expect(r.failed).toBe(false);
    expect(r.content).toContain('**Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU**');
    expect(r.content).toContain('## Sources');
  });

  it('research without sources stops the chain with the no-sources message', () => {
    const r = runSourcedChain({ researchAnswer: '1. **Apple Neural LLM** — made up.', localAnswers: ['x', 'y'] });
    expect(r.failed).toBe(true);
    expect(r.localCalls).toBe(0);
    expect(r.content).toContain(NO_SOURCES_MESSAGE);
  });

  it('fails closed when the sourcing helper is unavailable', () => {
    const r = runSourcedChain({ researchAnswer: RESEARCH_ANSWER, localAnswers: ['x', 'y'], withExecutor: false });
    expect(r.failed).toBe(true);
    expect(r.content).toContain(SOURCED_OUTPUT_UNVERIFIABLE_MESSAGE);
  });
});
