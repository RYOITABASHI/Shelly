/**
 * Regression test for bug #163 (docs/superpowers/DEFERRED.md): a run-log
 * JSON file was found on-device with a raw, un-escaped code-fence + embedded
 * newline sitting directly inside a JSON string value ("outputPreview"),
 * which made org.json.JSONObject (WidgetAgentRepository's 60s widget poll)
 * throw "Expected literal value at character 641" — the SAME exception,
 * forever, once per minute, for that one file.
 *
 * Root cause (lib/agent-executor.ts): json_escape_text() and
 * json_string_file() both ran their `shelly_node -e '...'` escaping attempt
 * directly against the function's own inherited stdout, inside
 * `if CMD; then return 0; fi`. If CMD fully wrote its correctly-escaped
 * output to stdout but still exited non-zero for a reason unrelated to the
 * write itself (plausible on-device: the child process gets reaped by the
 * OOM killer or similar AFTER its write() syscall already landed), the `if`
 * falls through to the plain-bash fallback below it — which prints a
 * SECOND, differently-escaped copy of the SAME text right after the first.
 * Two concatenated copies of the same content (the second with raw,
 * un-escaped newlines/quotes) is exactly the corrupt shape found on-device.
 *
 * Following this repo's 2026-07-15 convention (see
 * __tests__/agent-quality-gate-shell-emit.test.ts): extract the REAL
 * emitted function text from generateRunScript() and run it in REAL bash
 * with a `shelly_node` stand-in that reproduces the "wrote correct output,
 * then reported a non-zero exit for an unrelated reason" race directly, so
 * this test fails the same way production would if the double-print
 * regresses.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent } from '@/store/types';

function agent(): Agent {
  return {
    id: 'a',
    name: 'A',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool: { type: 'local' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  };
}

/**
 * Extract a top-level bash function's full text, correctly skipping over any
 * heredoc body so a brace-only line inside embedded JS is never mistaken for
 * the function's own closing brace. Mirrors
 * __tests__/agent-webhook-payload-shell-emit.test.ts's extractFunction.
 */
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

// The exact repro shape from the on-device logcat write-up: a code fence
// (triple backtick) plus an embedded raw newline inside otherwise normal
// preview text.
const REPRO_CONTENT =
  '2026年07月27日 14:43 JST ```text\nroot@docker:~# printf \'test\' > /sdcard/probe2.txt\n```';

function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-json-escape-race-'));
  const file = path.join(dir, 'input.txt');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function runHarness(harness: string, args: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-json-escape-race-run-'));
  const scriptPath = path.join(dir, 'harness.sh');
  fs.writeFileSync(scriptPath, harness, { mode: 0o755 });
  return execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8' });
}

describe('bug #163: json_escape_text / json_string_file no longer double-print on a node write-then-nonzero-exit race', () => {
  test('json_escape_text: real node writes correct output but reports non-zero exit -> exactly ONE copy, valid JSON', () => {
    const script = generateRunScript(agent());
    const jsonEscapeFn = extractFunction(script, 'json_escape_text');

    // Simulates the on-device race: the real node process actually runs
    // (writing fully correct, escaped output to stdout), but the wrapper
    // reports a non-zero exit regardless — e.g. the process was reaped
    // after its write() syscall already landed.
    const harness = `#!/bin/bash
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; return 1; }
${jsonEscapeFn}

json_escape_text "$1"
`;
    const out = runHarness(harness, [REPRO_CONTENT]);

    // The unique marker from the repro content must appear exactly ONCE.
    // Before the fix, the (correctly escaped) node write landed on stdout
    // AND the fallback's (differently escaped) copy was appended right
    // after it, so this marker would appear twice.
    const occurrences = out.split('probe2.txt').length - 1;
    expect(occurrences).toBe(1);

    // The escaped output must be usable as a single JSON string value with
    // no leftover raw control characters or stray quotes in the middle.
    const wrapped = `{"outputPreview":"${out}"}`;
    const parsed = JSON.parse(wrapped);
    expect(typeof parsed.outputPreview).toBe('string');
    expect(parsed.outputPreview).toContain('probe2.txt');
  });

  test('json_escape_text: real node succeeds cleanly (rc=0) -> still exactly one copy, properly \\n-escaped', () => {
    const script = generateRunScript(agent());
    const jsonEscapeFn = extractFunction(script, 'json_escape_text');

    const harness = `#!/bin/bash
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${jsonEscapeFn}

json_escape_text "$1"
`;
    const out = runHarness(harness, [REPRO_CONTENT]);
    const occurrences = out.split('probe2.txt').length - 1;
    expect(occurrences).toBe(1);
    // A real newline in the source must come back as an escaped \n
    // (two characters), never a raw newline byte, when node succeeds.
    expect(out).toContain('\\n');
    expect(out).not.toMatch(/[^\\]\n/);

    const parsed = JSON.parse(`{"outputPreview":"${out}"}`);
    expect(parsed.outputPreview).toBe(REPRO_CONTENT);
  });

  test('json_string_file: real node writes a correct quoted JSON string but reports non-zero exit -> exactly ONE string literal, valid JSON', () => {
    const script = generateRunScript(agent());
    const jsonEscapeFn = extractFunction(script, 'json_escape_text');
    const jsonStringFileFn = extractFunction(script, 'json_string_file');

    const harness = `#!/bin/bash
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; return 1; }
${jsonEscapeFn}
${jsonStringFileFn}

RESULT_JSON=$(json_string_file "$1")
printf '{"result":%s}' "$RESULT_JSON"
`;
    const inputFile = writeTempFile(REPRO_CONTENT);
    const out = runHarness(harness, [inputFile]);

    // Before the fix this would be two back-to-back quoted string literals
    // (invalid JSON: extra token after the first value) instead of one.
    const parsed = JSON.parse(out);
    expect(typeof parsed.result).toBe('string');
    expect(parsed.result).toContain('probe2.txt');
    const occurrences = out.split('probe2.txt').length - 1;
    expect(occurrences).toBe(1);
  });

  test('json_string_file: real node succeeds cleanly (rc=0) -> round-trips file content exactly', () => {
    const script = generateRunScript(agent());
    const jsonEscapeFn = extractFunction(script, 'json_escape_text');
    const jsonStringFileFn = extractFunction(script, 'json_string_file');

    const harness = `#!/bin/bash
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${jsonEscapeFn}
${jsonStringFileFn}

RESULT_JSON=$(json_string_file "$1")
printf '{"result":%s}' "$RESULT_JSON"
`;
    const inputFile = writeTempFile(REPRO_CONTENT);
    const out = runHarness(harness, [inputFile]);
    const parsed = JSON.parse(out);
    expect(parsed.result).toBe(REPRO_CONTENT);
  });
});
