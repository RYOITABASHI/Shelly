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
import {
  isRollbackEligibleRun,
  runWouldRequireApprovalTap,
  type ReversibilitySettings,
} from '@/lib/agent-action-reversibility';

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

/**
 * The SETTINGS end of the wire, added when the ConfigTUI / SettingsDropdown
 * toggle for AppSettings.agentOptimisticWorkspaceWrites landed (before it, the
 * setting had no UI at all and could not be turned on by a real user).
 *
 * These reproduce, without a store or a React render, the exact chain
 * lib/agent-manager.ts's runAgentNowInner runs:
 *   settings.agentOptimisticWorkspaceWrites
 *     → isRollbackEligibleRun + runWouldRequireApprovalTap
 *     → generateRunScript({ optimisticWorkspaceWrites })
 * so that "the toggle the user flips is the field the classifier reads" is
 * pinned, not assumed. The suite above pins the executor's own re-check; this
 * one pins that the settings field reaches it at all.
 */
describe('settings toggle → generated script', () => {
  const LOCAL_DRAFT_SETTINGS = (on: boolean): ReversibilitySettings => ({
    agentOptimisticWorkspaceWrites: on,
    agentOutputTarget: 'local',
    // The run must be one that would otherwise block on a tap, else switching
    // it to the rollback tier changes nothing — same precondition the manager
    // checks before it bothers taking a savepoint.
    defaultRequireActionApproval: true,
  });

  /** What runAgentNowInner passes down, minus the savepoint success it can't fake here. */
  function optimisticFlagFor(a: Agent, settings: ReversibilitySettings): boolean {
    return isRollbackEligibleRun(a, settings) && runWouldRequireApprovalTap(a, settings);
  }

  it('ON: a local draft run reaches generateRunScript as auto', () => {
    const a = agent({ type: 'draft' });
    const settings = LOCAL_DRAFT_SETTINGS(true);
    expect(optimisticFlagFor(a, settings)).toBe(true);
    const script = generateRunScript(a, { optimisticWorkspaceWrites: optimisticFlagFor(a, settings) });
    expect(bakedOverride(script)).toBe('auto');
  });

  it('OFF (the shipped default): byte-identical script, manual gate kept', () => {
    const a = agent({ type: 'draft' });
    const settings = LOCAL_DRAFT_SETTINGS(false);
    expect(optimisticFlagFor(a, settings)).toBe(false);
    const script = generateRunScript(a, { optimisticWorkspaceWrites: optimisticFlagFor(a, settings) });
    expect(bakedOverride(script)).toBe('manual');
    expect(script).toBe(generateRunScript(a, {}));
  });

  it('ON but output target is not local: still gated (the toggle cannot widen the destination)', () => {
    const a = agent({ type: 'draft' });
    for (const target of ['obsidian', 'custom'] as const) {
      const settings: ReversibilitySettings = { ...LOCAL_DRAFT_SETTINGS(true), agentOutputTarget: target };
      expect(optimisticFlagFor(a, settings)).toBe(false);
      expect(generateRunScript(a, { optimisticWorkspaceWrites: optimisticFlagFor(a, settings) })).toBe(
        generateRunScript(a, {})
      );
    }
  });

  it('ON but the action is irreversible: still gated at BOTH ends', () => {
    for (const type of IRREVERSIBLE) {
      const a = agent({ type } as AgentAction);
      const settings = LOCAL_DRAFT_SETTINGS(true);
      // end 1 — the classifier the manager consults
      expect(optimisticFlagFor(a, settings)).toBe(false);
      // end 2 — the executor's own re-check, even if end 1 were bypassed
      expect(bakedOverride(generateRunScript(a, { optimisticWorkspaceWrites: true }))).toBe('manual');
    }
  });
});
