import type { UserProfile } from '@/lib/user-profile';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { Agent } from '@/store/types';

export interface AgentSuggestion {
  id: string;
  reason: 'command' | 'skill';
  signal: string;
  score: number;
  title: string;
  description: string;
  draft: ParsedAgentDraft;
}

export interface AgentSuggestionOptions {
  limit?: number;
}

const COMMAND_THRESHOLD = 6;
const SKILL_THRESHOLD = 3;

const COMMAND_DRAFTS: Record<string, { label: string; prompt: string }> = {
  git: {
    label: 'Git',
    prompt: 'Review the current repository status, recent diffs, and likely next git actions. Summarize risks and suggest the next safe command.',
  },
  docker: {
    label: 'Docker',
    prompt: 'Inspect Docker containers, images, and compose state. Summarize unhealthy services, stale resources, and suggested cleanup steps.',
  },
  kubectl: {
    label: 'Kubernetes',
    prompt: 'Inspect Kubernetes context, workloads, pods, and recent events. Summarize failing resources and likely remediation steps.',
  },
  npm: {
    label: 'Node.js',
    prompt: 'Inspect package scripts, dependency state, and recent Node.js project errors. Suggest the next build or test command.',
  },
  pnpm: {
    label: 'Node.js',
    prompt: 'Inspect package scripts, dependency state, and recent Node.js project errors. Suggest the next pnpm build or test command.',
  },
  python: {
    label: 'Python',
    prompt: 'Inspect the Python project, environment, and recent test or runtime errors. Suggest the next verification or fix step.',
  },
  python3: {
    label: 'Python',
    prompt: 'Inspect the Python project, environment, and recent test or runtime errors. Suggest the next verification or fix step.',
  },
  cargo: {
    label: 'Rust',
    prompt: 'Inspect the Rust project, cargo metadata, and recent compiler or test errors. Suggest the next focused fix.',
  },
};

const SKILL_DRAFTS: Record<string, { label: string; prompt: string }> = {
  Git: COMMAND_DRAFTS.git,
  Docker: COMMAND_DRAFTS.docker,
  Kubernetes: COMMAND_DRAFTS.kubectl,
  'Node.js': COMMAND_DRAFTS.pnpm,
  Python: COMMAND_DRAFTS.python,
  Rust: COMMAND_DRAFTS.cargo,
  Terraform: {
    label: 'Terraform',
    prompt: 'Inspect Terraform plans, state-related warnings, and module changes. Summarize drift risks and the safest next validation step.',
  },
  'HTTP/API': {
    label: 'API',
    prompt: 'Inspect recent API calls, curl usage, and response errors. Summarize failing endpoints and propose the next diagnostic request.',
  },
};

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+/#. -]/g, ' ');
}

function agentCoversSignal(agent: Agent, signal: string, label?: string): boolean {
  const haystack = normalized(`${agent.name} ${agent.description} ${agent.prompt}`);
  const needles = [signal, label].filter((v): v is string => !!v).map(normalized);
  return needles.some((needle) => needle.length > 0 && haystack.includes(needle));
}

function baseDraft(name: string, prompt: string): ParsedAgentDraft {
  return {
    name,
    prompt,
    schedule: null,
    scheduleConfident: false,
    scheduleLabel: 'Manual',
    action: { type: 'draft' },
    tool: { type: 'auto' },
    toolLabel: 'Auto',
    // Synthesized (not typed by the user), so there is no real utterance to
    // preserve — the suggestion's own description is the closest equivalent
    // for the confirm card / fallback editing this field exists to support.
    rawText: prompt,
  };
}

function commandSuggestion(cmd: string, count: number): AgentSuggestion | null {
  const template = COMMAND_DRAFTS[cmd];
  if (!template) return null;
  return {
    id: `cmd-${cmd}`,
    reason: 'command',
    signal: cmd,
    score: count,
    title: `${template.label} helper`,
    description: `You often run ${cmd}. Create a reusable helper for that workflow.`,
    draft: baseDraft(`${template.label} Helper`, template.prompt),
  };
}

function skillSuggestion(skill: string, score: number): AgentSuggestion | null {
  const template = SKILL_DRAFTS[skill];
  if (!template) return null;
  return {
    id: `skill-${normalized(skill).trim().replace(/\s+/g, '-')}`,
    reason: 'skill',
    signal: skill,
    score,
    title: `${template.label} helper`,
    description: `Shelly has seen repeated ${skill} work. Create a helper for that stack.`,
    draft: baseDraft(`${template.label} Helper`, template.prompt),
  };
}

export function suggestAgentsFromProfile(
  profile: UserProfile,
  agents: Agent[],
  options: AgentSuggestionOptions = {},
): AgentSuggestion[] {
  const suggestions: AgentSuggestion[] = [];

  for (const entry of profile.topCommands) {
    // Six uses is enough to show a repeated workflow while avoiding one-off command noise.
    if (entry.count < COMMAND_THRESHOLD) continue;
    const template = COMMAND_DRAFTS[entry.cmd];
    if (!template) continue;
    if (agents.some((agent) => agentCoversSignal(agent, entry.cmd, template.label))) continue;
    const suggestion = commandSuggestion(entry.cmd, entry.count);
    if (suggestion) suggestions.push(suggestion);
  }

  // Three detected skills means the profile has enough breadth to avoid reacting to a single tool probe.
  if (profile.detectedSkills.length >= SKILL_THRESHOLD) {
    for (const skill of profile.detectedSkills) {
      const template = SKILL_DRAFTS[skill];
      if (!template) continue;
      if (agents.some((agent) => agentCoversSignal(agent, skill, template.label))) continue;
      const suggestion = skillSuggestion(skill, profile.detectedSkills.length);
      if (suggestion) suggestions.push(suggestion);
    }
  }

  const seen = new Set<string>();
  return suggestions
    .filter((suggestion) => {
      if (seen.has(suggestion.id)) return false;
      seen.add(suggestion.id);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 3);
}
