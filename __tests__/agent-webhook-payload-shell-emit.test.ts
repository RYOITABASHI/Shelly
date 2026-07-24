/**
 * Regression test for the 2026-07-15 P1 audit finding: dispatch_agent_action's
 * webhook) case (lib/agent-executor.ts) built the outgoing webhook JSON body's
 * "result" field via a RAW read of $result_file (json_string_file), while the
 * "preview" field right next to it always went through clean_result_preview's
 * telemetry-strip + secret-redaction + is_low_quality_completion gate. That
 * meant an external Discord/Slack/Telegram endpoint could receive un-redacted
 * secrets and internal driver telemetry lines, AND the quality gate never
 * covered anything past $preview's truncation point.
 *
 * The fix adds clean_result_full() (same cleaning pipeline as
 * clean_result_preview, no length cap) and is_low_quality_completion_file()
 * (file-based twin of is_low_quality_completion), and wires both into the
 * webhook case BEFORE write_webhook_payload is called.
 *
 * Following this repo's 2026-07-15 convention (see
 * __tests__/agent-quality-gate-shell-emit.test.ts): extract the REAL emitted
 * script text from generateRunScript() and execute the REAL bash/node, not a
 * hand-copied assumption of what it says.
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
    id: 'wh',
    name: 'WH',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool,
    action: { type: 'webhook', webhookUrl: 'https://example.com/hook' },
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
 * heredoc body (`<<'NODEEOF' ... NODEEOF`, `<< PAYLOADEOF ... PAYLOADEOF`,
 * etc.) so a brace-only line INSIDE the heredoc's embedded JS is never
 * mistaken for the function's own closing brace.
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

function extractCaseBlock(script: string, caseLabel: string): string {
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

const nodeBin = process.execPath.replace(/\\/g, '/');

/** Bundles the real functions the webhook path needs into one runnable script. */
function buildWrapperScript(script: string, body: string): string {
  const fns = [
    'json_escape_text',
    'json_string_file',
    'redact_secrets_text',
    'clean_result_full',
    'is_low_quality_completion_file',
    'write_webhook_payload',
  ]
    .map((fn) => extractFunction(script, fn))
    .join('\n\n');
  return `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
AGENT_ID="wh-test"
TOOL_LABEL="Test Tool"
${fns}

${body}
`;
}

function runWrapper(wrapperScript: string): { stdout: string; status: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-clean-'));
  const scriptPath = path.join(dir, 'run.sh');
  fs.writeFileSync(scriptPath, wrapperScript, 'utf8');
  try {
    const stdout = execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8');
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer };
    return { stdout: e.stdout ? e.stdout.toString('utf8') : '', status: typeof e.status === 'number' ? e.status : 1 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('is_low_quality_completion_file — real emitted-script escaping (regression)', () => {
  // Mirrors __tests__/agent-quality-gate-shell-emit.test.ts's own regression
  // for is_low_quality_completion: the whole generated script is ONE outer TS
  // template literal, so a regex written as `\s`/`\b` inside this NEW
  // embedded heredoc gets consumed by the OUTER template literal's escape
  // parsing before node ever sees it (`\s` silently drops its backslash,
  // `\b` becomes a literal backspace byte) — this function shipped with
  // exactly that bug on first write (single backslashes, copy-pasted from
  // the intended source rather than the double-backslash convention) and
  // silently matched NOTHING at runtime. Assert directly on the actual
  // extracted text, not a hand-typed assumption of what it should say.
  const script = generateRunScript(agent({ type: 'local' }));
  const fn = extractFunction(script, 'is_low_quality_completion_file');

  it('the emitted regex source has real backslash escapes, not dropped/backspace chars', () => {
    expect(fn).toContain('#\\s*Results from previous steps');
    expect(fn).toContain('#\\s*This step\\b');
    expect(fn).toContain('\\bas an ai\\b');
    expect(fn.includes('\x08')).toBe(false); // literal backspace control char
  });
});

describe('enforce_char_limit_text — real emitted-script escaping (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const fn = extractFunction(script, 'enforce_char_limit_text');

  it('the emitted regex/string source has real backslash escapes, not a stripped/raw-newline mangled version', () => {
    expect(fn).toContain("'\\n'"); // terminator Set entry — must stay the 2-char escape, not an actual newline byte
    expect(fn).toContain('/\\s+$/');
    expect(fn.includes('\x08')).toBe(false);
  });
});

describe('dispatch_agent_action webhook) — case wiring (real emitted case block)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const webhookCase = extractCaseBlock(script, 'webhook');

  it('computes clean_result_full and gates on is_low_quality_completion_file BEFORE write_webhook_payload', () => {
    const cleanIdx = webhookCase.indexOf('clean_result_full "$result_file"');
    const gateIdx = webhookCase.indexOf('is_low_quality_completion_file "$webhook_clean_result"');
    // The actual CALL (with its real first argument), not the earlier comment
    // that also mentions the function name in prose — a plain
    // indexOf('write_webhook_payload ') would match that comment first.
    const writeIdx = webhookCase.indexOf('write_webhook_payload "$webhook_payload"');
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeLessThan(gateIdx);
    expect(gateIdx).toBeLessThan(writeIdx);
  });

  it('passes the CLEANED file (not the raw $result_file) into write_webhook_payload', () => {
    expect(webhookCase).toMatch(/write_webhook_payload "\$webhook_payload" "success" "\$preview" "\$webhook_clean_result"/);
    expect(webhookCase).not.toMatch(/write_webhook_payload "\$webhook_payload" "success" "\$preview" "\$result_file"/);
  });
});

describe('write_webhook_payload — real execution against a raw agent result (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const rawContent =
    'AUDIT {"internal":"driver telemetry that must never leave the device"}\n' +
    'Here is your summary: sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 was used to fetch it.\n' +
    'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。\n';

  function writePayloadFor(rawFile: string): { payloadRaw: string; payload: { result: string; preview: string } } {
    // Written directly via fs (real newlines preserved) rather than a bash
    // `printf '%s' "<json-escaped>"` — printf's ARGUMENT does not interpret
    // backslash escapes (only its format string does), so a JSON.stringify'd
    // multi-line string embedded that way collapses to literal "\n" text
    // instead of real newlines, which would make clean_result_full's
    // line-anchored `sed '/^AUDIT /d'` behave completely differently than it
    // does on a real multi-line agent result.
    fs.writeFileSync(rawFile, rawContent, 'utf8');
    const wrapper = buildWrapperScript(
      script,
      `clean_result_full ${JSON.stringify(rawFile)} ${JSON.stringify(rawFile)}.clean
write_webhook_payload ${JSON.stringify(rawFile)}.payload.json "success" "a short preview" ${JSON.stringify(rawFile)}.clean
cat ${JSON.stringify(rawFile)}.payload.json`
    );
    const { stdout, status } = runWrapper(wrapper);
    expect(status).toBe(0);
    return { payloadRaw: stdout, payload: JSON.parse(stdout) };
  }

  it('sanity check: the synthetic content actually contains telemetry + a real secret pattern (proves the test is meaningful)', () => {
    expect(rawContent).toContain('AUDIT ');
    expect(rawContent).toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('the webhook "result" field is redacted and telemetry-stripped, matching what "preview" always got', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-result-'));
    const rawFile = path.join(dir, 'result.md');
    try {
      const { payload } = writePayloadFor(rawFile);
      expect(payload.result).not.toContain('AUDIT ');
      expect(payload.result).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(payload.result).toContain('<redacted>');
      expect(payload.result).toContain('STEAM教育×AIの最新動向まとめ');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('is_low_quality_completion_file — catches bad content beyond the preview truncation point', () => {
  const script = generateRunScript(agent({ type: 'local' }));

  it('flags a refusal that only appears AFTER clean_result_preview\'s own truncation window', () => {
    // Real content, well past ANY realistic preview truncation length, followed
    // by refusal boilerplate — the exact "short clean preview, bad full body"
    // shape the 2026-07-15 P1 audit described.
    const padding = 'STEAM教育×AIの最新動向まとめ。'.repeat(200); // ~3000+ chars
    const badTail = ' As an AI, I cannot generate a literal X post with a real URL.';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-fullcheck-'));
    const rawFile = path.join(dir, 'result.md');
    try {
      fs.writeFileSync(rawFile, padding + badTail, 'utf8');
      const wrapper = buildWrapperScript(
        script,
        `clean_result_full ${JSON.stringify(rawFile)} ${JSON.stringify(rawFile)}.clean
if is_low_quality_completion_file ${JSON.stringify(rawFile)}.clean; then
  echo BAD
else
  echo OK
fi`
      );
      const { stdout, status } = runWrapper(wrapper);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('BAD');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag clean real content of the same shape/length', () => {
    const padding = 'STEAM教育×AIの最新動向まとめ。'.repeat(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-fullcheck-ok-'));
    const rawFile = path.join(dir, 'result.md');
    try {
      fs.writeFileSync(rawFile, padding, 'utf8');
      const wrapper = buildWrapperScript(
        script,
        `clean_result_full ${JSON.stringify(rawFile)} ${JSON.stringify(rawFile)}.clean
if is_low_quality_completion_file ${JSON.stringify(rawFile)}.clean; then
  echo BAD
else
  echo OK
fi`
      );
      const { stdout, status } = runWrapper(wrapper);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('is_low_quality_completion_file — "honest failure to retrieve data" (2026-07-23 battery-notify finding)', () => {
  const script = generateRunScript(agent({ type: 'local' }));

  it('flags a short honest-failure completion (the real webhook-body shape for this finding)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-dataunavail-'));
    const rawFile = path.join(dir, 'result.md');
    try {
      fs.writeFileSync(rawFile, 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。', 'utf8');
      const wrapper = buildWrapperScript(
        script,
        `clean_result_full ${JSON.stringify(rawFile)} ${JSON.stringify(rawFile)}.clean
if is_low_quality_completion_file ${JSON.stringify(rawFile)}.clean; then
  echo BAD
else
  echo OK
fi`
      );
      const { stdout, status } = runWrapper(wrapper);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('BAD');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag a long body that merely mentions "取得できません" once in passing (explicit negative, unlike refusal which stays flagged at any length)', () => {
    const padding = 'STEAM教育×AIの最新動向まとめ。'.repeat(200); // ~3000+ chars
    const passingMention = padding + 'なお、この件については詳細情報が取得できませんでした。';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-webhook-dataunavail-negative-'));
    const rawFile = path.join(dir, 'result.md');
    try {
      fs.writeFileSync(rawFile, passingMention, 'utf8');
      const wrapper = buildWrapperScript(
        script,
        `clean_result_full ${JSON.stringify(rawFile)} ${JSON.stringify(rawFile)}.clean
if is_low_quality_completion_file ${JSON.stringify(rawFile)}.clean; then
  echo BAD
else
  echo OK
fi`
      );
      const { stdout, status } = runWrapper(wrapper);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
