/**
 * Follow-up item 1 (2026-10-15): agents registered before the named-tool fix
 * whose prompt names the tool are pinned on startup repair — idempotent, under
 * the confirm boundary's consent rules.
 */
import { migrateAgentToolPin } from '@/lib/agent-tool-router';
import type { Agent, ToolChoice } from '@/store/types';

const mk = (over: Partial<Agent>): Agent => ({
  id: 'mig',
  name: 'mig',
  description: '',
  prompt: 'パープレで最新のLLM論文をリサーチして要約して',
  schedule: '0 8 * * *',
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

const apply = (a: Agent, consent = false): Agent => {
  const m = migrateAgentToolPin(a, consent);
  return m ? { ...a, tool: m.tool } : a;
};

describe('migrateAgentToolPin', () => {
  it('pins a non-autonomous auto agent whose prompt names Perplexity, and is idempotent', () => {
    const a = mk({});
    const m = migrateAgentToolPin(a, false);
    expect(m?.tool.type).toBe('perplexity');
    expect(m?.from).toBe('Auto');
    const once = apply(a);
    expect(migrateAgentToolPin(once, false)).toBeNull();
    expect(apply(once)).toEqual(once);
  });

  it('autonomous Codex agent moves to Perplexity only when consent covers it', () => {
    const codex: ToolChoice = { type: 'cli', cli: 'codex' };
    const a = mk({ autonomous: true, tool: codex });
    expect(migrateAgentToolPin(a, false)).toBeNull();
    expect(migrateAgentToolPin(a, true)?.tool.type).toBe('perplexity');
    // Non-research Perplexity pin is outside the consent scope (review M1).
    expect(migrateAgentToolPin(mk({ autonomous: true, tool: codex, prompt: 'パープレでこの文章を要約して' }), true)).toBeNull();
  });

  it('leaves alone: no mention, topic mention, comparison, chains, manual RUN ON pin, an already concrete tool', () => {
    expect(migrateAgentToolPin(mk({ prompt: '今日のニュースをまとめて' }), false)).toBeNull();
    expect(migrateAgentToolPin(mk({ prompt: 'Codexでの評判を調べて' }), false)).toBeNull();
    expect(migrateAgentToolPin(mk({ prompt: 'compare Gemini with Codex' }), false)).toBeNull();
    expect(migrateAgentToolPin(mk({ orchestration: { steps: ['パープレで集めて', '要約して'] } }), false)).toBeNull();
    expect(migrateAgentToolPin(mk({ runOn: 'on-device' }), false)).toBeNull();
    expect(migrateAgentToolPin(mk({ tool: { type: 'gemini-api' } }), false)).toBeNull();
  });
});
