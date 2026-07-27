/**
 * Regression test for a real, user-confirmed on-device data leak (2026-07-27):
 * registering `@agent 今すぐ、「API key: sk-test-...」という内容でメモを作成して`
 * (a `draft`-typed "create a note with this content" action) produced a saved
 * .md file with the raw, unredacted secret readable via `cat`, in BOTH the
 * file CONTENT and the FILE NAME (the auto-derived agent name flowed
 * unredacted into computeAgentSlug()'s slug).
 *
 * clean_result_preview()/clean_result_full() already redact before a result
 * reaches a webhook body, notification, or dm-reply text — save_draft_result()
 * was the one emission point that wrote $result_file straight to disk with no
 * redact_secrets_text pass at all. This extracts the REAL emitted
 * save_draft_result()/redact_secrets_text()/register_source_urls() shell
 * functions via generateRunScript() and executes them with a real bash + node
 * child process (same pattern as agent-quality-gate-shell-emit.test.ts and the
 * Gemini HTTP diagnostics test in the same file), so it fails the same way
 * production would if the redaction wiring regresses.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript, computeAgentSlug } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

// Built at runtime (not a literal template) so repository secret scanning
// does not flag this test fixture as a live credential — same convention
// __tests__/redact-secrets.test.ts already uses.
const FAKE_SECRET = ['sk-test-', '1234567890abcdef'].join('');

function agent(actionType: 'draft' | '__suppressed__' = 'draft', tool: ToolChoice = { type: 'local' }): Agent {
  return {
    id: 'draft-redaction-test',
    name: 'Draft redaction test',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool,
    action: { type: actionType },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  } as Agent;
}

/** Extracts every function definition from redact_secrets_text() through the
 *  end of save_draft_result() (i.e. right up to the next function,
 *  dispatch_agent_action()) — a contiguous run of complete function bodies,
 *  safe to source on their own. Mirrors extractFullFunction() /
 *  extractShellFunctionRange() in agent-quality-gate-shell-emit.test.ts. */
function extractDraftSaveFunctions(script: string): string {
  const start = script.indexOf('redact_secrets_text() {');
  if (start === -1) throw new Error('redact_secrets_text function not found in generated script');
  const end = script.indexOf('\ndispatch_agent_action() {', start);
  if (end === -1) throw new Error('dispatch_agent_action marker (end of save_draft_result) not found');
  return script.slice(start, end);
}

/** Runs save_draft_result() for real against a fixture result file containing
 *  a secret, and returns the raw content of whatever file it actually wrote
 *  plus the source-registry tsv content, so tests can assert on the real
 *  post-redaction bytes rather than a hand-copied expectation. */
function runSaveDraftResult(opts: {
  resultContent: string;
  slug?: string;
  useGlobalOutput?: boolean;
}): { savedFileContent: string; savedFilePath: string; sourceRegistryContent: string } {
  const script = generateRunScript(agent());
  const functions = extractDraftSaveFunctions(script);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-draft-redaction-'));
  const resultFile = path.join(dir, 'result');
  fs.writeFileSync(resultFile, opts.resultContent, 'utf8');
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const home = dir.replace(/\\/g, '/');
  const sourceRegistryFile = `${home}/sources/source-registry.tsv`;
  const wrapper = `set -e
HOME="${home}"
TMP_DIR="$HOME/tmp"
mkdir -p "$TMP_DIR"
AGENT_ID=draft-redaction-test
TOOL_LABEL=local
SOURCE_REGISTRY_FILE="${sourceRegistryFile}"
mkdir -p "$(dirname "$SOURCE_REGISTRY_FILE")"
touch "$SOURCE_REGISTRY_FILE"
SLUG="${(opts.slug ?? 'api-key-note').replace(/"/g, '\\"')}"
USE_GLOBAL_OUTPUT=${opts.useGlobalOutput === false ? '0' : '1'}
OUTPUT_DIR="$HOME/output"
OUTPUT_NAME_TEMPLATE='{date}_{slug}.md'
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${functions}
save_draft_result "${resultFile.replace(/\\/g, '/')}"
printf '%s' "$SAVED_FILE" > "$HOME/saved-file-path.txt"
`;
  const wrapperFile = path.join(dir, 'wrapper.sh');
  fs.writeFileSync(wrapperFile, wrapper, 'utf8');
  try {
    execFileSync('bash', [wrapperFile], { stdio: 'pipe' });
    const savedFilePath = fs.readFileSync(path.join(dir, 'saved-file-path.txt'), 'utf8').trim();
    return {
      savedFileContent: fs.readFileSync(savedFilePath, 'utf8'),
      savedFilePath,
      sourceRegistryContent: fs.readFileSync(sourceRegistryFile, 'utf8'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('save_draft_result — secret redaction on the actual disk write (2026-07-27 on-device finding)', () => {
  it('does NOT persist the raw secret in the saved file content; the redacted marker replaces it', () => {
    const content = `**キータイプ**: ${FAKE_SECRET}\n本文: これはメモです。`;
    const { savedFileContent } = runSaveDraftResult({ resultContent: content });

    expect(savedFileContent).not.toContain(FAKE_SECRET);
    expect(savedFileContent).toContain('<redacted>');
    expect(savedFileContent).toContain('これはメモです。');
  });

  it('reproduces the exact on-device repro shape: a draft note whose body is literally the pasted API key line', () => {
    const content = `# メモ\n\nAPI key: ${FAKE_SECRET}\n`;
    const { savedFileContent, savedFilePath } = runSaveDraftResult({ resultContent: content });

    expect(savedFileContent).not.toContain(FAKE_SECRET);
    // sanity: actually wrote a real file under the expected agent-output layout
    expect(savedFilePath).toContain('output');
  });

  it('still saves ordinary content unchanged when no secret-shaped substring is present', () => {
    const content = 'STEAM教育×AIの最新動向まとめ: 論文3件を要約しました。';
    const { savedFileContent } = runSaveDraftResult({ resultContent: content });

    expect(savedFileContent).toBe(content);
  });

  it('does not leak a secret embedded in a URL query parameter into the persisted source registry', () => {
    const content = `参照: https://example.com/api?key=${FAKE_SECRET} を見てください。`;
    const { sourceRegistryContent } = runSaveDraftResult({ resultContent: content });

    expect(sourceRegistryContent).not.toContain(FAKE_SECRET);
  });
});

describe('save_draft_result / dispatch_agent_action — wiring for the redaction fix (structural, both output branches)', () => {
  const script = generateRunScript(agent());

  it('writes the redacted temp file, not $result_file, in the USE_GLOBAL_OUTPUT branch', () => {
    const fnStart = script.indexOf('save_draft_result() {');
    const globalBranchEnd = script.indexOf('return 0', fnStart);
    const globalBranch = script.slice(fnStart, globalBranchEnd);

    expect(globalBranch).toContain('redact_secrets_text "$result_file" > "$redacted_result"');
    expect(globalBranch).toContain('cap_fs_write_file "$SAVED_FILE" "$redacted_result"');
    expect(globalBranch).not.toContain('cap_fs_write_file "$SAVED_FILE" "$result_file"');
    expect(globalBranch).toContain('register_source_urls "$redacted_result"');
  });

  it('writes the redacted temp file, not $result_file, in the content-studio branch too', () => {
    const fnStart = script.indexOf('save_draft_result() {');
    const fnEnd = script.indexOf('\ndispatch_agent_action() {', fnStart);
    const fnBody = script.slice(fnStart, fnEnd);

    expect(fnBody).toContain('cap_fs_write_file "$SAVED_FILE" "$redacted_result"');
    expect(fnBody).not.toContain('cap_fs_write_file "$SAVED_FILE" "$result_file"');
    // The Obsidian mirror copies the already-redacted on-disk $SAVED_FILE, not
    // the raw $result_file — correct as-is, asserted here so a future edit
    // that regresses it (re-pointing at $result_file) gets caught.
    expect(fnBody).toContain('cap_fs_write_file "$OBSIDIAN_DEST" "$SAVED_FILE"');
    // Final register_source_urls (content-studio branch's tail call) also
    // uses the redacted copy.
    const lastRegisterIdx = fnBody.lastIndexOf('register_source_urls');
    expect(fnBody.slice(lastRegisterIdx)).toContain('register_source_urls "$redacted_result"');
  });
});

describe('computeAgentSlug — defense-in-depth redaction (2026-07-27 on-device finding)', () => {
  it('does not carry a secret-shaped substring through into the slug even when given a raw secret-bearing name', () => {
    const slug = computeAgentSlug(`API key: ${FAKE_SECRET}`, 'fallback-id');
    expect(slug).not.toContain(FAKE_SECRET);
  });

  it('leaves ordinary names behaving exactly as before (no regression)', () => {
    expect(computeAgentSlug('まずニュース 集めて 保存', 'agent-x')).toBe('まずニュース-集めて-保存');
    expect(computeAgentSlug('My Weekly Report', 'id')).toBe('my-weekly-report');
    expect(computeAgentSlug('', 'agent-fallback')).toBe('agent-fallback');
  });
});
