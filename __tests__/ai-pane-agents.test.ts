import {
  AI_PANE_AGENT_IDS,
  AI_PANE_AGENT_META,
  getAiPaneAgentMeta,
  getEnabledAiPaneAgents,
  isAiPaneAgent,
  pickDefaultAiPaneAgent,
  resolveAiPaneAgent,
} from '@/lib/ai-pane-agents';

describe('ai-pane agent registry', () => {
  it('contains only currently supported AI pane agents', () => {
    expect(AI_PANE_AGENT_IDS).toEqual(['gemini', 'cerebras', 'groq', 'perplexity', 'local']);
    expect(isAiPaneAgent('gemini')).toBe(true);
    expect(isAiPaneAgent('cerebras')).toBe(true);
    expect(isAiPaneAgent('claude')).toBe(false);
    expect(isAiPaneAgent(null)).toBe(false);
  });

  it('resolves unknown persisted agent ids to a safe fallback', () => {
    expect(resolveAiPaneAgent('perplexity')).toBe('perplexity');
    expect(resolveAiPaneAgent('gemini', 'groq')).toBe('gemini');
    expect(resolveAiPaneAgent('claude', 'groq')).toBe('groq');
    expect(resolveAiPaneAgent(undefined)).toBe('local');
  });

  it('keeps metadata in sync with the id list', () => {
    expect(Object.keys(AI_PANE_AGENT_META).sort()).toEqual([...AI_PANE_AGENT_IDS].sort());
    for (const id of AI_PANE_AGENT_IDS) {
      expect(getAiPaneAgentMeta(id)).toMatchObject({ id });
      expect(getAiPaneAgentMeta(id).label.length).toBeGreaterThan(0);
      expect(getAiPaneAgentMeta(id).color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('filters disabled team members and picks the best available default', () => {
    expect(getEnabledAiPaneAgents({ cerebras: false, groq: true })).toEqual([
      'gemini',
      'groq',
      'perplexity',
      'local',
    ]);

    expect(pickDefaultAiPaneAgent({
      cerebrasApiKey: 'cerebras-key',
      groqApiKey: 'groq-key',
      perplexityApiKey: 'pplx-key',
      teamMembers: {},
    } as any)).toBe('local');

    expect(pickDefaultAiPaneAgent({
      cerebrasApiKey: 'cerebras-key',
      groqApiKey: 'groq-key',
      perplexityApiKey: 'pplx-key',
      teamMembers: { cerebras: false },
    } as any)).toBe('local');

    expect(pickDefaultAiPaneAgent({
      cerebrasApiKey: 'cerebras-key',
      groqApiKey: 'groq-key',
      perplexityApiKey: 'pplx-key',
      teamMembers: { local: false, cerebras: false },
    } as any)).toBe('groq');

    expect(pickDefaultAiPaneAgent({
      teamMembers: { gemini: false, cerebras: false, groq: false, perplexity: false },
    } as any)).toBe('local');
  });
});
