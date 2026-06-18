jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const agent = (tool: ToolChoice, autonomous?: boolean): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
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
});

const UNSET = 'unset PERPLEXITY_API_KEY GEMINI_API_KEY';

describe('generateRunScript — autonomous tool resolution (Spec A §4/§5)', () => {
  it('resolves autonomous auto → codex (OAuth), key-free env', () => {
    const s = generateRunScript(agent({ type: 'auto' }, true));
    expect(s).toContain('.shelly-agent-driver.js'); // resolved to cli/codex via the approval driver
    expect(s).toContain('--prompt-file "$PROMPT_FILE"');
    expect(s).toContain(UNSET); // codex path → keys scrubbed
    expect(s).not.toContain('[REFUSED]');
  });

  it('refuses an autonomous api-key backend (perplexity), fail-closed', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, true));
    expect(s).toContain('[REFUSED]');
    expect(s).toContain('exit 1');
    expect(s).not.toContain('api.perplexity.ai'); // never builds the perplexity call
    // The refusal MUST carry the script-version line, or AgentRuntime rejects it
    // as "stale" (exit 126) and the [REFUSED] body never runs / never records.
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION');
  });

  it('refuses an autonomous gemini backend', () => {
    expect(generateRunScript(agent({ type: 'gemini-api' }, true))).toContain('[REFUSED]');
  });

  it('allows autonomous cli/local/ab-article-eval (oauth/local, no key) normally', () => {
    const cli = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    expect(cli).not.toContain('[REFUSED]');
    expect(cli).toContain('.shelly-agent-driver.js');
    expect(cli).toContain(UNSET); // oauth path → keys scrubbed
    expect(generateRunScript(agent({ type: 'local' }, true))).not.toContain('[REFUSED]');
    expect(generateRunScript(agent({ type: 'ab-article-eval' }, true))).not.toContain('[REFUSED]');
  });

  it('leaves NON-autonomous agents unchanged (perplexity still runs, keys kept)', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, false));
    expect(s).not.toContain('[REFUSED]');
    expect(s).not.toContain(UNSET); // key-bearing backend keeps its env
    const sDefault = generateRunScript(agent({ type: 'perplexity' })); // autonomous undefined
    expect(sDefault).not.toContain('[REFUSED]');
  });
});
