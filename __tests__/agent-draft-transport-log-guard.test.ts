/**
 * Follow-up item 8 (2026-10-15, on-device): an Obsidian Substack draft
 * contained the Codex driver's raw JSON-RPC / audit log instead of an article.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import type { Agent, ToolChoice } from '@/store/types';

const agent = (tool: ToolChoice): Agent => ({
  id: 'draft-guard',
  name: 'Draft guard',
  description: '',
  prompt: 'Write an article draft',
  schedule: null,
  tool,
  outputPath: '~/projects/shelly-content-studio/drafts/substack',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

function extractFn(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf('\n}\n', start);
  return script.slice(start, end + 2);
}

describe('a transport/audit log is never saved as a draft', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const fn = extractFn(script, 'is_transport_log_file');

  const run = (content: string): boolean => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-tl-'));
    try {
      const f = path.join(dir, 'r.md').replace(/\\/g, '/');
      fs.writeFileSync(f, content);
      const s = path.join(dir, 's.sh');
      fs.writeFileSync(s, `${fn}\nif is_transport_log_file '${f}'; then echo LOG; else echo OK; fi\n`);
      return execFileSync('bash', [s.replace(/\\/g, '/')], { encoding: 'utf8' }).trim() === 'LOG';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('detects a JSON-RPC transport log and an audit jsonl', () => {
    expect(run('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n')).toBe(true);
    expect(run([
      '{"ts":1,"direction":"out","event":"turn/start","threadId":"t1"}',
      '{"ts":2,"direction":"in","event":"item/started","threadId":"t1"}',
      '{"ts":3,"direction":"in","event":"turn/completed","threadId":"t1"}',
      '',
    ].join('\n'))).toBe(true);
  });

  it('keeps real article content, even with a JSON code sample in it', () => {
    expect(run('# AI-era STEAM\n\nFoundational academic ability matters.\n\n```json\n{"method":"x"}\n```\n\nMore prose here.\n')).toBe(false);
    expect(run('Plain one-line draft.')).toBe(false);
  });

  it('the draft action and save_draft_result both refuse it with a clear error', () => {
    expect(script).toContain('TRANSPORT_LOG_DRAFT_ERROR="Refused to save the draft: the backend returned a raw agent transport/audit log (JSON-RPC), not content.');
    const save = extractFn(script, 'save_draft_result');
    expect(save.indexOf('if is_transport_log_file "$result_file"; then')).toBeGreaterThan(0);
    expect(script).toMatch(/""\|draft\)\n\s+if is_transport_log_file "\$result_file"; then\n\s+ACTION_DISPATCH_STATUS="error"/);
  });

  it('the A/B article path no longer copies the driver log into the article', () => {
    const ab = generateRunScript(agent({ type: 'ab-article-eval', localModel: 'Qwen3.5-2B-Q4_K_M', codexCmd: 'codex' }));
    expect(ab).not.toContain('cp "$RUN_DIR/codex.stderr.log" "$RUN_DIR/codex.md"');
    expect(ab).toContain('Codex driver produced no answer (exit $CODEX_EXIT). Driver log: $RUN_DIR/codex.stderr.log');
  });
});
