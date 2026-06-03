import type { AppSettings } from '@/store/types';

export const AI_PANE_AGENT_IDS = [
  'gemini',
  'cerebras',
  'groq',
  'perplexity',
  'local',
] as const;

export type AiPaneAgentId = (typeof AI_PANE_AGENT_IDS)[number];

const AI_PANE_AGENT_SET = new Set<string>(AI_PANE_AGENT_IDS);

export type AiPaneAgentMeta = {
  id: AiPaneAgentId;
  label: string;
  color: string;
};

export const AI_PANE_AGENT_META: Record<AiPaneAgentId, AiPaneAgentMeta> = {
  gemini: { id: 'gemini', label: 'Gemini', color: '#60A5FA' },
  cerebras: { id: 'cerebras', label: 'Cerebras', color: '#FF6B35' },
  groq: { id: 'groq', label: 'Groq', color: '#F97316' },
  perplexity: { id: 'perplexity', label: 'Perplexity', color: '#38BDF8' },
  local: { id: 'local', label: 'Local', color: '#FFD700' },
};

export function isAiPaneAgent(agent: string | null | undefined): agent is AiPaneAgentId {
  return !!agent && AI_PANE_AGENT_SET.has(agent);
}

export function resolveAiPaneAgent(
  agent: string | null | undefined,
  fallback: AiPaneAgentId = 'local',
): AiPaneAgentId {
  return isAiPaneAgent(agent) ? agent : fallback;
}

export function getAiPaneAgentMeta(agent: AiPaneAgentId): AiPaneAgentMeta {
  return AI_PANE_AGENT_META[agent];
}

export function getEnabledAiPaneAgents(teamMembers?: Record<string, boolean>): AiPaneAgentId[] {
  return AI_PANE_AGENT_IDS.filter((agent) => teamMembers?.[agent] !== false);
}

export function pickDefaultAiPaneAgent(settings: AppSettings): AiPaneAgentId {
  const enabled = getEnabledAiPaneAgents(settings.teamMembers);

  const firstEnabled = (...agents: AiPaneAgentId[]): AiPaneAgentId | null => {
    for (const agent of agents) {
      if (enabled.includes(agent)) return agent;
    }
    return null;
  };

  return (
    firstEnabled('local') ??
    (settings.cerebrasApiKey ? firstEnabled('cerebras') : null) ??
    (settings.groqApiKey ? firstEnabled('groq') : null) ??
    (settings.geminiApiKey ? firstEnabled('gemini') : null) ??
    (settings.perplexityApiKey ? firstEnabled('perplexity') : null) ??
    firstEnabled('cerebras', 'groq', 'gemini', 'perplexity', 'local') ??
    'local'
  );
}
