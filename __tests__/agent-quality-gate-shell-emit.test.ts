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
