/**
 * Defense-in-depth: generateRunScript's own re-check of the reversible boundary.
 *
 * lib/agent-manager.ts is the authoritative decision point for optimistic
 * (rollback-type) execution, but a single mistake there must not be enough to
 * auto-approve an IRREVERSIBLE action. generateRunScript therefore re-derives
 * the action-type half of the boundary before it will bake
 * ACTION_APPROVAL_MODE_OVERRIDE='auto'. These tests pin that second gate.
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import type { Agent, AgentAction, AgentActionType } from '@/store/types';
import { generateRunScript } from '@/lib/agent-executor';

function agent(action: AgentAction | undefined, overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-opt',
    name: 'optimistic test',
    prompt: 'write a short note',
    tool: { type: 'local' },
    outputPath: '/home/test/agent-output/out.md',
    outputTemplate: null,
    // The agent itself demands the manual tap — the only thing that could turn
    // it into 'auto' is the optimistic override under test.
    requireActionApproval: true,
    action,
    ...overrides,
  } as Agent;
}

function bakedOverride(script: string): string {
  const m = script.match(/\nACTION_APPROVAL_MODE_OVERRIDE=('([^']*)'|"([^"]*)"|(\S*))/);
  if (!m) return '<absent>';
  return m[2] ?? m[3] ?? m[4] ?? '';
}

const IRREVERSIBLE: AgentActionType[] = [
  'notify',
  'webhook',
  'cli',
  'intent',
  'dm-reply',
  'app-act',
  'api-call',
  'social-post',
];

describe('generateRunScript — optimistic approval override', () => {
  it('bakes auto for a reversible draft when the flag is set', () => {
    const script = generateRunScript(agent({ type: 'draft' }), { optimisticWorkspaceWrites: true });
    expect(bakedOverride(script)).toBe('auto');
  });

  it('bakes auto for an implicit (absent) draft action', () => {
    const script = generateRunScript(agent(undefined), { optimisticWorkspaceWrites: true });
    expect(bakedOverride(script)).toBe('auto');
  });

  it.each(IRREVERSIBLE)(
    'IGNORES the flag for an irreversible "%s" action and keeps the manual gate',
    (type) => {
      const script = generateRunScript(agent({ type } as AgentAction), {
        optimisticWorkspaceWrites: true,
      });
      expect(bakedOverride(script)).toBe('manual');
    }
  );

  it('ignores the flag when ANY action in a fan-out is irreversible', () => {
    const actions: AgentAction[] = [{ type: 'draft' }, { type: 'draft' }, { type: 'webhook' }];
    const script = generateRunScript(agent({ type: 'draft' }, { actions }), {
      optimisticWorkspaceWrites: true,
    });
    expect(bakedOverride(script)).toBe('manual');
  });

  it('honours the flag for an all-draft fan-out', () => {
    const actions: AgentAction[] = [{ type: 'draft' }, { type: 'draft' }];
    const script = generateRunScript(agent({ type: 'draft' }, { actions }), {
      optimisticWorkspaceWrites: true,
    });
    expect(bakedOverride(script)).toBe('auto');
  });

  it('is byte-identical to the un-flagged script when the flag is absent', () => {
    // The whole feature is opt-in: with the flag off, nothing about the
    // generated script may change. This is the regression guard for every
    // existing on-device-verified agent.
    for (const type of ['draft', ...IRREVERSIBLE] as AgentActionType[]) {
      const a = agent({ type } as AgentAction);
      expect(generateRunScript(a, { optimisticWorkspaceWrites: false })).toBe(
        generateRunScript(a, {})
      );
    }
  });

  it('does not invent an override for an agent that had none', () => {
    // requireActionApproval undefined = inherit the global default at run time.
    // With the flag off it must stay empty (inherit), not become 'auto'.
    const a = agent({ type: 'draft' }, { requireActionApproval: undefined });
    expect(bakedOverride(generateRunScript(a, {}))).toBe('');
  });
});
