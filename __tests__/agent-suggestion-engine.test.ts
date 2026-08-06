import { suggestAgentsFromProfile } from '@/lib/agent-suggestion-engine';
import type { UserProfile } from '@/lib/user-profile';
import type { Agent } from '@/store/types';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    facts: [],
    topCommands: [],
    agentUsage: {},
    recentProjects: [],
    detectedSkills: [],
    style: { language: 'en', verbosity: 'unknown', techLevel: 'unknown' },
    updatedAt: 0,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    name: 'Existing',
    description: '',
    prompt: '',
    schedule: null,
    tool: { type: 'auto' },
    outputPath: '$HOME/.shelly/agents/existing/output.md',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  };
}

describe('suggestAgentsFromProfile', () => {
  it('suggests a command-focused agent when one command has strong repeated use', () => {
    const suggestions = suggestAgentsFromProfile(
      profile({ topCommands: [{ cmd: 'git', count: 9 }] }),
      [],
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('cmd-git');
    expect(suggestions[0].draft.name).toContain('Git');
    expect(suggestions[0].draft.prompt).toContain('git');
    expect(suggestions[0].draft.schedule).toBeNull();
  });

  it('does not suggest a command agent already covered by an existing agent', () => {
    const suggestions = suggestAgentsFromProfile(
      profile({ topCommands: [{ cmd: 'git', count: 12 }] }),
      [agent({ name: 'Git Helper', prompt: 'Review git status and git diff' })],
    );

    expect(suggestions).toEqual([]);
  });

  it('suggests a skill-focused agent when repeated skills have no matching agent', () => {
    const suggestions = suggestAgentsFromProfile(
      profile({ detectedSkills: ['Docker', 'Kubernetes', 'Terraform'] }),
      [],
    );

    expect(suggestions.map((s) => s.id)).toContain('skill-docker');
    expect(suggestions[0].draft.prompt).toMatch(/Docker|Kubernetes|Terraform/);
  });

  it('limits suggestions and keeps the strongest signal first', () => {
    const suggestions = suggestAgentsFromProfile(
      profile({
        topCommands: [
          { cmd: 'git', count: 15 },
          { cmd: 'docker', count: 7 },
        ],
        detectedSkills: ['Docker', 'Kubernetes', 'Terraform', 'Python'],
      }),
      [],
      { limit: 2 },
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].id).toBe('cmd-git');
  });
});
