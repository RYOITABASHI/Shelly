/**
 * Regression test for the 2026-07-15 P1 audit finding: lib/agent-manager.ts's
 * runAgentOrchestrated() carries priorResults between chain steps bounded by
 * lib/agent-orchestration.ts's buildStepPrompt (MAX_RESULT_CARRY_CHARS =
 * 1500), but every priorResults entry comes from a run log's outputPreview,
 * which is populated from lib/agent-executor.ts's clean_result_preview() —
 * which truncated to a SEPARATELY hardcoded 500 BYTES. So the 1500-char
 * budget was unreachable in practice: every step only ever saw <=500 bytes of
 * prior context, regardless of what buildStepPrompt allowed.
 *
 * The fix makes clean_result_preview()'s truncation import
 * MAX_RESULT_CARRY_CHARS from lib/agent-orchestration.ts instead of a second,
 * independently-hardcoded number, so the two budgets can't silently drift
 * apart again.
 *
 * Follows this repo's 2026-07-15 convention: extract the REAL emitted
 * clean_result_preview() text from generateRunScript() and execute it via a
 * real bash process, rather than asserting against a hand-typed assumption.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { MAX_RESULT_CARRY_CHARS } from '@/lib/agent-orchestration';
import { Agent, ToolChoice } from '@/store/types';

function agent(tool: ToolChoice): Agent {
  return {
    id: 'p',
    name: 'P',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  };
}

function extractFunction(script: string, fnName: string): string {
  const marker = `${fnName}() {`;
  const fnStart = script.indexOf(marker);
  if (fnStart === -1) throw new Error(`${fnName} not found in generated script`);
  const lines = script.slice(fnStart).split('\n');
  let heredocTerm: string | null = null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredocTerm !== null) {
      if (line === heredocTerm) heredocTerm = null;
      continue;
    }
    // No trailing $ anchor: a heredoc-start line may have trailing content
    // after the terminator word (e.g. `<<'NODEEOF' 2>/dev/null`).
    const heredocMatch = line.match(/<<-?\s*'?"?([A-Z_]+)'?"?/);
    if (heredocMatch) {
      heredocTerm = heredocMatch[1];
      continue;
    }
    if (line === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`closing brace for ${fnName} not found`);
  return lines.slice(0, end + 1).join('\n');
}

const nodeBin = process.execPath.replace(/\\/g, '/');

function runCleanResultPreview(script: string, content: string): string {
  const fns = ['json_escape_text', 'redact_secrets_text', 'clean_result_preview'].map((fn) => extractFunction(script, fn)).join('\n\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-preview-carry-'));
  const resultFile = path.join(dir, 'result.md');
  const scriptPath = path.join(dir, 'run.sh');
  fs.writeFileSync(resultFile, content, 'utf8');
  const wrapper = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${fns}
clean_result_preview ${JSON.stringify(resultFile)}
`;
  fs.writeFileSync(scriptPath, wrapper, 'utf8');
  try {
    return execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('clean_result_preview — truncation budget matches agent-orchestration.ts MAX_RESULT_CARRY_CHARS (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));

  it('the generated script embeds the SAME imported constant, not an independently hardcoded number', () => {
    // Cross-checked against the actual export, not a hardcoded literal — if
    // MAX_RESULT_CARRY_CHARS ever changes, this test still enforces they stay
    // in lockstep instead of independently asserting "1500" in two places.
    expect(script).toContain(`head -c ${MAX_RESULT_CARRY_CHARS} `);
    // The old, now-fixed hardcoded value must be gone from clean_result_preview.
    expect(script).not.toContain('head -c 500 "$redacted"');
  });

  it('a result between the OLD 500-byte cap and the NEW budget survives fully untruncated (direct regression case)', () => {
    // 600 ASCII bytes: > the old hardcoded 500, < the current 1500 budget.
    // Before the fix this would have come back cut to exactly 500 bytes.
    const content = 'x'.repeat(600);
    const out = runCleanResultPreview(script, content);
    expect(out.length).toBe(600);
    expect(out).toBe(content);
  });

  it('a result longer than the budget is still truncated, but AT the new budget, not the old one', () => {
    const content = 'y'.repeat(MAX_RESULT_CARRY_CHARS + 500);
    const out = runCleanResultPreview(script, content);
    expect(out.length).toBe(MAX_RESULT_CARRY_CHARS);
  });

  it('a short result is unaffected either way', () => {
    const content = 'STEAM教育×AIの最新動向まとめ。';
    const out = runCleanResultPreview(script, content);
    expect(out).toBe(content);
  });
});
