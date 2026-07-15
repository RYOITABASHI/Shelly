/**
 * Regression test for a real bug found by an adversarial review 2026-07-15:
 * lib/agent-executor.ts's entire generated shell script is ONE outer TS
 * template literal, so a regex source written as `\s`/`\b` inside a NEW
 * embedded `shelly_node -e '...'` block gets consumed by the OUTER template
 * literal's own escape-sequence parsing before the shell/node ever sees it —
 * `\s` silently drops its backslash (Annex B legacy behavior) and `\b`
 * becomes a literal backspace control character. A hand-copied "verification"
 * of the intended source (not the actual compiled output) missed this
 * entirely. This test extracts the REAL emitted script text via
 * generateRunScript() and executes the REAL embedded JS with a local node
 * child process, so it fails the same way production would if the escaping
 * regresses again.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

function agent(tool: ToolChoice): Agent {
  return {
    id: 'a',
    name: 'A',
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

function extractEmbeddedJs(script: string): string {
  // Anchor on the function name FIRST — this file has multiple unrelated
  // `shelly_node -e '...'` call sites (e.g. json_escape_text), so a bare
  // search for that generic marker can silently grab the wrong one.
  const fnMarker = 'is_low_quality_completion() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('is_low_quality_completion function not found in generated script');
  const marker = "shelly_node -e '";
  const start = script.indexOf(marker, fnStart);
  if (start === -1) throw new Error('is_low_quality_completion node block not found in generated script');
  const bodyStart = start + marker.length;
  const end = script.indexOf("\n' 2>/dev/null", bodyStart);
  if (end === -1) throw new Error('closing marker for the embedded JS block not found');
  return script.slice(bodyStart, end);
}

function extractCaseBlock(script: string, caseLabel: string): string {
  // Anchor on dispatch_agent_action() first — "notify)" (and similar labels)
  // can otherwise match unrelated text elsewhere in this giant generated script.
  const fnMarker = 'dispatch_agent_action() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('dispatch_agent_action function not found in generated script');
  const marker = `\n    ${caseLabel})`;
  const start = script.indexOf(marker, fnStart);
  if (start === -1) throw new Error(`case block "${caseLabel})" not found in dispatch_agent_action`);
  const bodyStart = start + marker.length;
  const end = script.indexOf('\n      ;;', bodyStart);
  if (end === -1) throw new Error(`closing ";;" for case block "${caseLabel})" not found`);
  return script.slice(bodyStart, end);
}

function extractFullFunction(script: string): string {
  const fnMarker = 'is_low_quality_completion() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('is_low_quality_completion function not found in generated script');
  const fnEnd = script.indexOf('\n}', fnStart);
  if (fnEnd === -1) throw new Error('closing brace for is_low_quality_completion not found');
  return script.slice(fnStart, fnEnd + 2);
}

/**
 * Runs the REAL, FULL bash function (not just its embedded JS) via a real
 * bash process — this is what exercises the shell-level empty/whitespace
 * trim check, which runs BEFORE node is ever invoked. node_usable/shelly_node
 * are stubbed to proxy to the real local `node` binary (the production
 * versions resolve an Android-bundled binary via shelly_run_app_binary,
 * unavailable on this dev machine) so the echo/refusal branch still executes
 * for real too, not just the early-return empty-check branch.
 */
function runFullFunctionCheck(fnText: string, text: string): number {
  const wrapperPath = path.join(os.tmpdir(), `shelly-quality-gate-wrapper-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const script = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${fnText}
is_low_quality_completion "$1"
`;
  fs.writeFileSync(wrapperPath, script, 'utf8');
  try {
    execFileSync('bash', [wrapperPath, text], { stdio: 'pipe' });
    return 0;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') return status;
    throw err;
  } finally {
    fs.unlinkSync(wrapperPath);
  }
}

function runEmbeddedCheck(js: string, text: string): number {
  const tmpFile = path.join(os.tmpdir(), `shelly-quality-gate-check-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, js, 'utf8');
  try {
    execFileSync(process.execPath, [tmpFile], {
      env: { ...process.env, SHELLY_QUALITY_CHECK_TEXT: text },
      stdio: 'pipe',
    });
    return 0;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') return status;
    throw err;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

describe('is_low_quality_completion — real emitted-script escaping (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const embeddedJs = extractEmbeddedJs(script);

  it('the emitted regex source has real backslash escapes, not dropped/backspace chars', () => {
    // A hand-copied "looks right" check missed this — assert directly on the
    // ACTUAL extracted text so a re-regression (outer-template escaping
    // eaten again) fails here instead of silently reaching production.
    expect(embeddedJs).toContain('\\s*Results from previous steps');
    expect(embeddedJs).toContain('\\s*This step\\b');
    expect(embeddedJs).toContain('\\bas an ai\\b');
    // Must NOT contain a literal backspace control character () where
    // \b was intended — the exact failure mode the reviewer caught.
    expect(embeddedJs.includes('')).toBe(false);
  });

  it('detects the real on-device echoed-prompt-plus-refusal text', () => {
    const echoed =
      '# Results from previous steps ## Step 1 パープレで検索して ## Step 2 保存する。 --- ' +
      '# This step X用に再要約して投稿して --- Note: As an AI, I cannot generate a literal X post with a';
    expect(runEmbeddedCheck(embeddedJs, echoed)).toBe(0);
  });

  it('detects a bare EN refusal with no prompt echo', () => {
    expect(runEmbeddedCheck(embeddedJs, 'As an AI, I cannot generate a literal social media post.')).toBe(0);
  });

  it('detects a bare JA refusal', () => {
    expect(runEmbeddedCheck(embeddedJs, '私はAIなので、実際の投稿はできません。')).toBe(0);
  });

  it('detects a genuine "I\'m unable to..." refusal', () => {
    expect(runEmbeddedCheck(embeddedJs, "I'm unable to publish this to X directly.")).toBe(0);
  });

  it('does not flag real content', () => {
    expect(runEmbeddedCheck(embeddedJs, 'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, 'This step forward for AI in education looks promising.')).toBe(1);
    // Regression: a hand-typed `.` wildcard in place of the escaped apostrophe
    // ('\bi.m ...' instead of '\bi\x27m ...') would wrongly match "IBM" here —
    // a real false positive an earlier draft of this fix actually shipped.
    expect(runEmbeddedCheck(embeddedJs, 'IBM unable to deliver chips after the outage.')).toBe(1);
  });
});

describe('is_low_quality_completion — empty/whitespace-only completion (real bash execution, regression)', () => {
  // 2026-07-15: the codex-driver path's clean_result_preview() strips every
  // line the driver ever prints (all 8 of its telemetry prefixes), so a
  // Codex-routed step that completes successfully can still yield a fully
  // empty $preview — which, before this fix, silently reached the confirm
  // card as a blank content box instead of failing loud (empty text matched
  // neither the echo nor the refusal patterns). This exercises the REAL
  // shell trim logic via a real bash process, not the embedded JS alone —
  // the empty check runs in plain shell, before node is ever invoked.
  const script = generateRunScript(agent({ type: 'local' }));
  const fnText = extractFullFunction(script);

  it('flags a fully empty completion', () => {
    expect(runFullFunctionCheck(fnText, '')).toBe(0);
  });

  it('flags a whitespace-only completion (spaces, tabs, newlines)', () => {
    expect(runFullFunctionCheck(fnText, '   \n\t  \n')).toBe(0);
  });

  it('still flags echo/refusal content through the full function (not just the embedded JS)', () => {
    expect(runFullFunctionCheck(fnText, 'As an AI, I cannot generate a literal social media post.')).toBe(0);
  });

  it('does not flag real content with surrounding whitespace', () => {
    expect(runFullFunctionCheck(fnText, '  STEAM教育×AIの最新動向まとめ。  ')).toBe(1);
  });
});

describe('dispatch_agent_action — quality gate wired into draft/notify (real emitted case blocks)', () => {
  const script = generateRunScript(agent({ type: 'local' }));

  it('gates the draft case ("|draft) before save_draft_result, regardless of the approval branch', () => {
    const draftCase = extractCaseBlock(script, '""|draft');
    const gateIdx = draftCase.indexOf('is_low_quality_completion "$preview"');
    const approvalIdx = draftCase.indexOf('request_and_wait_approval "draft"');
    const saveIdx = draftCase.indexOf('save_draft_result "$result_file"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    // The gate must run before BOTH the optional approval tap and the actual
    // file write, so an autonomous run (which skips the approval branch
    // entirely) still can't reach save_draft_result with bad content.
    expect(gateIdx).toBeLessThan(approvalIdx);
    expect(gateIdx).toBeLessThan(saveIdx);
    expect(draftCase).toContain('ACTION_DISPATCH_STATUS="error"');
    expect(draftCase).toContain('Draft content looks like a prompt echo or AI refusal');
  });

  it('gates the notify case before request_and_wait_approval / write_native_notification_request "success"', () => {
    const notifyCase = extractCaseBlock(script, 'notify');
    const gateIdx = notifyCase.indexOf('is_low_quality_completion "$preview"');
    const approvalIdx = notifyCase.indexOf('request_and_wait_approval "notify"');
    const successNotifyIdx = notifyCase.indexOf('write_native_notification_request "success" "$preview"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(successNotifyIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(approvalIdx);
    expect(gateIdx).toBeLessThan(successNotifyIdx);
    expect(notifyCase).toContain('ACTION_DISPATCH_STATUS="error"');
    expect(notifyCase).toContain('Notify content looks like a prompt echo or AI refusal');
  });

  it('the draft/notify gate calls the SAME is_low_quality_completion function already exercised above', () => {
    // Not a hand-copied duplicate check: the function under is_low_quality_completion()
    // is the single source of truth exercised by the earlier describe block's real
    // node child-process runs; this only asserts the draft/notify cases call it.
    const draftCase = extractCaseBlock(script, '""|draft');
    const notifyCase = extractCaseBlock(script, 'notify');
    expect(script).toContain('is_low_quality_completion() {');
    expect(draftCase).toMatch(/if is_low_quality_completion "\$preview"; then/);
    expect(notifyCase).toMatch(/if is_low_quality_completion "\$preview"; then/);
  });
});
