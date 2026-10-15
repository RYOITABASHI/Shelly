/**
 * 2026-10-15 on-device finding: an English agent prompt produced Japanese
 * summaries (Japanese memory/profile context prepended to the prompt decided
 * the language, and English tasks had no directive at all).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { detectTaskLanguage, outputLanguageDirective, taskTextForLanguage } from '@/lib/agent-output-language';
import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import type { Agent } from '@/store/types';

const JA_MEMORY = '# 記憶\n- ユーザーは日本語話者で、要約は短めが好み。';
const EN_TASK = 'Collect the latest AI research papers and summarize 3 notable ones. Write the summaries in English.';
const composite = `${JA_MEMORY}\n\n---\n\n${EN_TASK}`;

const agent = (prompt: string, over: Partial<Agent> = {}): Agent => ({
  id: 'lang',
  name: 'lang',
  description: '',
  prompt,
  schedule: '20 16 * * *',
  tool: { type: 'perplexity', model: 'sonar-deep-research' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

describe('output language is the TASK language, never the injected context', () => {
  it('taskTextForLanguage strips prepended memory/skill context', () => {
    expect(taskTextForLanguage(composite)).toBe(EN_TASK);
    expect(taskTextForLanguage(EN_TASK)).toBe(EN_TASK);
  });

  it('detects ja / en / other', () => {
    expect(detectTaskLanguage('最新論文を集めて')).toBe('ja');
    expect(detectTaskLanguage(EN_TASK)).toBe('en');
    expect(detectTaskLanguage('최신 논문을 모아줘')).toBe('other');
  });

  it('English task + Japanese memory → English directive that overrides context', () => {
    const d = outputLanguageDirective(composite);
    expect(d).toContain('Write the ENTIRE response in English');
    expect(d).toContain('overrides the language of any context, memory, profile notes');
    expect(d).not.toContain('日本語');
  });

  it('Japanese task keeps the Japanese directive; other languages mirror the task', () => {
    expect(outputLanguageDirective('最新のAI論文を集めて要約して')).toContain('日本語');
    expect(outputLanguageDirective('최신 논문을 모아줘')).toContain('same language as the Task text');
    expect(outputLanguageDirective('12345')).toBe('');
  });

  it('the scheduled .sh leads the prompt with the English directive (web and non-web tasks)', () => {
    const web = generateRunScript(agent(composite));
    expect(web).toContain('Write the ENTIRE response in English');
    expect(web).not.toContain('Write the ENTIRE response in Japanese');
    const plain = generateRunScript(agent('Say hello in one sentence.', { tool: { type: 'local' } }));
    expect(plain).toContain('Write the ENTIRE response in English');
  });

  it('the PlanSpec prompt (unattended executor) carries the same directive', () => {
    const spec = buildAgentPlanSpec(agent(composite));
    expect(spec.prompt.startsWith('OUTPUT LANGUAGE (REQUIRED): Write the ENTIRE response in English')).toBe(true);
  });

  it('the codex chain base prompt carries it too', () => {
    const s = generateRunScript(agent(composite, {
      tool: { type: 'cli', cli: 'codex' },
      orchestration: { steps: ['collect the latest AI papers', 'summarize them'] },
    }));
    expect(s).toMatch(/CODEX_ORCH_BASE_PROMPT='OUTPUT LANGUAGE \(REQUIRED\): Write the ENTIRE response in English/);
  });
});
