/**
 * v8.1.1 on-device (build 2593, 2026-10-16): "Every day at 09:45, research the
 * latest LLM papers with Perplexity and summarize 3 of them in English." became
 * a 2-step chain whose step 1 was just "at 09:45" (derivePrompt stripped
 * "Every day" but left the time, and the comma splitter made it a step). The
 * real task was then a per-step Perplexity pin, which marked the draft
 * high-risk (in-app approval only). A leading schedule clause must never become
 * a step; a single real clause naming a tool is a single-step agent with the
 * agent-level tool pinned.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  tFor: (locale: string, key: string) => `${locale}:${key}`,
}));
jest.mock('expo-notifications', () => ({ scheduleNotificationAsync: jest.fn() }));

import { parseAgentNL } from '@/lib/agent-nl-parser';
import { detectToolPinnedSteps, isScheduleOnlyClause } from '@/lib/agent-orchestration';
import { assessAgentDraftRisk } from '@/lib/agent-add-approval';

const EN = 'Every day at 09:45, research the latest LLM papers with Perplexity and summarize 3 of them in English.';
const JA = '毎日9時45分に、パープレで最新のLLM論文を調べて英語で3本要約して';

describe('leading schedule clause is never a step', () => {
  it.each([
    [EN, '45 9 * * *'],
    ['Daily at 9:45am, research the latest LLM papers with Perplexity and summarize 3 of them in English.', '45 9 * * *'],
    [JA, '45 9 * * *'],
    ['毎日9時45分に、パープレで最新のLLM論文を調べて、英語で3本要約して', '45 9 * * *'],
    ['毎日 9:45 に、Perplexityで最新のLLM論文を調べて英語で3本要約して', '45 9 * * *'],
  ])('%s -> single-step agent pinned to Perplexity, not high-risk', (utterance, cron) => {
    const d = parseAgentNL(utterance);
    expect(d.schedule).toBe(cron);
    const steps = d.orchestrationSteps ?? [];
    for (const s of steps) {
      const text = typeof s === 'string' ? s : s.instruction;
      expect(text).not.toMatch(/^(?:at\s+)?0?9:45|9時45分/i);
    }
    // Either no chain at all (agent-level pin) or, for the JA comma variant
    // with two real clauses, a chain whose FIRST step is the real research.
    if (steps.length === 0) {
      expect(d.tool?.type).toBe('perplexity');
      expect(d.prompt).not.toMatch(/^(?:at\s+)?0?9:45/i);
      expect(d.prompt).toMatch(/LLM/);
      expect(assessAgentDraftRisk(d as never)).not.toContain('step-tool');
    } else {
      const first = steps[0];
      expect(typeof first === 'string' ? first : first.instruction).toMatch(/LLM/);
    }
  });

  it('the exact on-device EN utterance is single-step with no high-risk reason', () => {
    const d = parseAgentNL(EN);
    expect(d.orchestrationSteps).toBeUndefined();
    expect(d.tool?.type).toBe('perplexity');
    expect(d.prompt.startsWith('research the latest LLM papers')).toBe(true);
    expect(assessAgentDraftRisk(d as never)).toEqual([]);
  });

  it('the exact on-device JA utterance is single-step with no high-risk reason', () => {
    const d = parseAgentNL(JA);
    expect(d.orchestrationSteps).toBeUndefined();
    expect(d.tool?.type).toBe('perplexity');
    expect(assessAgentDraftRisk(d as never)).toEqual([]);
  });

  it('detectToolPinnedSteps drops a leading EN schedule-only clause', () => {
    expect(detectToolPinnedSteps('at 09:45, research the latest LLM papers with Perplexity and summarize 3 of them')).toBeNull();
    expect(detectToolPinnedSteps('Every day at 09:45, research LLM papers with Perplexity')).toBeNull();
    const chain = detectToolPinnedSteps('Every Monday and Friday at 8am, collect papers with Perplexity, then summarize them with a local LLM');
    expect(chain?.map((s) => s.instruction)).toEqual(['collect papers with Perplexity', 'summarize them with a local LLM']);
  });

  it('isScheduleOnlyClause recognises EN schedule-only clauses and nothing else', () => {
    for (const c of ['at 09:45', 'Every day at 09:45', 'daily at 9am', 'every Monday and Friday at 8:00', 'on weekdays at 7 p.m.', 'Every day', '毎日9時45分に']) {
      expect(isScheduleOnlyClause(c)).toBe(true);
    }
    for (const c of ['research LLM papers', 'sunshine', 'at home', 'every paper', 'Monday report', '']) {
      expect(isScheduleOnlyClause(c)).toBe(false);
    }
  });
});
