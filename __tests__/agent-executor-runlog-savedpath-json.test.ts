/**
 * Regression test for bug #164's actual root cause (2026-07-28 on-device
 * verified, agent-ms4aagxz): every draft-action run that saved a file wrote a
 * run-log whose savedPath key AND value were UNQUOTED —
 *
 *   ...,"routeDecision":{...},savedPath:/data/.../2026-07-28_テストメモ-保存.md}
 *
 * The generated bash's SAVED_PATH_FIELDS assignment was authored inside a TS
 * template literal as `\"savedPath\"`, which emits a PLAIN `"` into bash —
 * bash then consumes those quotes as word-quoting, so nothing survives into
 * the heredoc-expanded JSON. readAgentRunLogs() silently drops malformed
 * logs, so waitForAgentRunCompletion() never saw the (natively successful,
 * ~5-second) run and every attended draft one-shot "failed" with the
 * 5-minute ATTENDED timeout. Fixed in agent-executor.ts v41 by emitting
 * `\"` (TS `\\"`) so the JSON stays quoted.
 *
 * This test extracts the REAL emitted "# Log run result" block (plus the real
 * json_escape_text helper) from generateRunScript() and executes it with a
 * real bash + node, then JSON.parses the file it wrote — exactly what
 * lib/agent-manager.ts's readAgentRunLogs() does in production. It fails the
 * same way production failed if the quoting regresses.
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

function draftAgent(): Agent {
  return {
    id: 'runlog-savedpath-test',
    name: 'Runlog savedPath test',
    description: '',
    prompt: 'テストメモを保存して',
    schedule: null,
    tool: { type: 'local' },
    action: { type: 'draft' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  } as Agent;
}

/** The real json_escape_text() helper, complete (runs from its own definition
 *  to the next top-level function). Same marker-slicing convention as
 *  agent-executor-draft-redaction.test.ts's extractDraftSaveFunctions(). */
function extractJsonEscapeText(script: string): string {
  const start = script.indexOf('json_escape_text() {');
  if (start === -1) throw new Error('json_escape_text function not found in generated script');
  const end = script.indexOf('\nwrite_failure_log() {', start);
  if (end === -1) throw new Error('write_failure_log marker (end of json_escape_text) not found');
  return script.slice(start, end);
}

/** The real success-path run-log write: "# Log run result" through the heredoc,
 *  stopping before the prune/cleanup tail (which calls finish()). */
function extractRunLogWriteBlock(script: string): string {
  const start = script.indexOf('# Log run result');
  if (start === -1) throw new Error('"# Log run result" block not found in generated script');
  const end = script.indexOf('# Prune old logs', start);
  if (end === -1) throw new Error('"# Prune old logs" marker not found');
  return script.slice(start, end);
}

function runLogWrite(opts: { savedPath: string; savedPathMirror?: string }): Record<string, unknown> {
  const script = generateRunScript(draftAgent());
  const block = extractRunLogWriteBlock(script);
  const jsonEscape = extractJsonEscapeText(script);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-runlog-savedpath-'));
  const logDir = path.join(dir, 'logs').replace(/\\/g, '/');
  fs.mkdirSync(logDir, { recursive: true });
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const wrapper = `set -e
# Windows-host test quirk only (no-op on-device): Git Bash's MSYS layer
# path-converts env values that look like POSIX paths (e.g. SHELLY_JSON_TEXT=
# "/data/...") into "C:/Program Files/Git/data/..." when spawning the native
# node.exe json_escape_text uses — disable conversion so the fixture path
# round-trips byte-identically like it does on-device.
export MSYS_NO_PATHCONV=1
export MSYS2_ENV_CONV_EXCL='*'
HOME="${dir.replace(/\\/g, '/')}"
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${jsonEscape}
AGENT_ID=runlog-savedpath-test
LOG_DIR="${logDir}"
STATUS=success
PREVIEW='テストメモを保存して。'
DURATION=2000
TOOL_LABEL='Local LLM'
ERROR_MESSAGE=''
ROUTE_DECISION_JSON='{"route":"on-device","toolType":"local","toolLabel":"Local LLM","guard":"configured-tool","why":"Agent uses its configured tool."}'
ORCHESTRATION_COLLAPSED_NOTE=''
SAVED_PATH='${opts.savedPath}'
SAVED_PATH_MIRROR='${opts.savedPathMirror ?? ''}'
RESULT_FILE="$HOME/result"
BACKEND_ERROR_FILE="$HOME/backend-error"
${block}
`;
  const wrapperFile = path.join(dir, 'wrapper.sh');
  fs.writeFileSync(wrapperFile, wrapper, 'utf8');
  try {
    execFileSync('bash', [wrapperFile], { stdio: 'pipe' });
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
    // The production contract: readAgentRunLogs() JSON.parses this verbatim.
    // Pre-v41 this throw was exactly bug #164's silent drop.
    return JSON.parse(raw) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('run-log write — savedPath fields must survive as valid, quoted JSON (bug #164 root cause)', () => {
  it('reproduces the exact on-device shape: draft run with a saved path parses and carries savedPath', () => {
    const savedPath =
      '/data/user/0/dev.shelly.terminal/files/home/agent-output/2026-07-28/2026-07-28_テストメモ-保存.md';
    const log = runLogWrite({ savedPath });

    expect(log.agentId).toBe('runlog-savedpath-test');
    expect(typeof log.timestamp).toBe('number');
    expect(log.status).toBe('success');
    // The field pre-v41 came out as unquoted `,savedPath:/data/...` — the
    // parse above would already have thrown, but pin the value too.
    expect(log.savedPath).toBe(savedPath);
    expect(log.savedPathMirror).toBeUndefined();
  });

  it('also parses with an Obsidian mirror path (both savedPath fields present)', () => {
    const savedPath = '/data/user/0/dev.shelly.terminal/files/home/agent-output/2026-07-28/note.md';
    const mirror = '/sdcard/Documents/Obsidian/Shelly/note.md';
    const log = runLogWrite({ savedPath, savedPathMirror: mirror });

    expect(log.savedPath).toBe(savedPath);
    expect(log.savedPathMirror).toBe(mirror);
  });

  it('omits savedPath fields entirely when the run saved nothing, still valid JSON', () => {
    const log = runLogWrite({ savedPath: '' });

    expect(log.status).toBe('success');
    expect('savedPath' in log).toBe(false);
    expect('savedPathMirror' in log).toBe(false);
  });
});
