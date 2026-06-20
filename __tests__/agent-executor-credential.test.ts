jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const agent = (tool: ToolChoice): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
  schedule: null,
  tool,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

const UNSET = 'unset PERPLEXITY_API_KEY GEMINI_API_KEY';

describe('generateRunScript credential isolation (Tier-1)', () => {
  it('scrubs API keys for OAuth/local tools', () => {
    expect(generateRunScript(agent({ type: 'cli', cli: 'codex' }))).toContain(UNSET);
    expect(generateRunScript(agent({ type: 'local' }))).toContain(UNSET);
    expect(generateRunScript(agent({ type: 'ab-article-eval' }))).toContain(UNSET);
  });

  it('keeps keys for key-bearing backends', () => {
    expect(generateRunScript(agent({ type: 'perplexity' }))).not.toContain(UNSET);
    expect(generateRunScript(agent({ type: 'gemini-api' }))).not.toContain(UNSET);
    expect(generateRunScript(agent({ type: 'auto' }))).not.toContain(UNSET);
  });

  it('forces secret-bearing task text to local and disables cloud fallback', () => {
    const s = generateRunScript({
      ...agent({ type: 'gemini-api' }),
      prompt: 'Summarize this config: api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    });

    expect(s).toContain(UNSET);
    expect(s).toContain('Secret guard matched task text');
    expect(s).toContain('"guard":"secret"');
    expect(s).toContain('"noCloudFallback":true');
    expect(s).toContain('Qwen3.5-0.8B-Q4_K_M');
    expect(s).not.toContain('generativelanguage.googleapis.com');
  });

  it('never unsets non-secret config', () => {
    const s = generateRunScript(agent({ type: 'cli', cli: 'codex' }));
    expect(s).not.toMatch(/unset[^\n]*LOCAL_LLM/);
    expect(s).not.toMatch(/unset[^\n]*OBSIDIAN/);
  });
});
