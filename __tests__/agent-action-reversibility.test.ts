/**
 * The safety boundary for optimistic (rollback-type) agent execution.
 *
 * The single most important property under test: an IRREVERSIBLE action can
 * never become rollback-eligible. Everything else in this suite is secondary.
 * If a change to lib/agent-action-reversibility.ts makes any of the
 * "irreversible" cases below pass as reversible, that is a security regression,
 * not a test that needs updating.
 */
import type { Agent, AgentAction, AgentActionType } from '@/store/types';
import {
  REVERSIBLE_ACTION_TYPES,
  classifyActionReversibility,
  classifyRunReversibility,
  isReversibleActionType,
  isRollbackEligibleRun,
  runWouldRequireApprovalTap,
  type ReversibilitySettings,
} from '@/lib/agent-action-reversibility';

jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/test' }));

/** Every member of AgentActionType. Kept as a literal so adding a member to the
 *  union without adding it here fails to compile (see the exhaustiveness test). */
const ALL_ACTION_TYPES: AgentActionType[] = [
  'draft',
  'notify',
  'webhook',
  'cli',
  'intent',
  'dm-reply',
  'app-act',
  'api-call',
  'social-post',
  'browser-pane',
];

/** Types that MUST be classified irreversible, with the reason each one is. */
const IRREVERSIBLE_TYPES: AgentActionType[] = [
  'notify', // already delivered to the user's notification shade
  'webhook', // HTTPS POST has left the device
  'cli', // arbitrary shell command — unprovable
  'intent', // launches another app / OS share sheet
  'dm-reply', // a sent message cannot be unsent
  'app-act', // drives another app's UI (e.g. publishes a post)
  'api-call', // outbound HTTP to an allowlisted host
  'social-post', // published publicly, with account credentials
  'browser-pane', // mutates a live web page's DOM/session state
];

const OPTIMISTIC_ON: ReversibilitySettings = {
  agentOptimisticWorkspaceWrites: true,
  agentOutputTarget: 'local',
  defaultRequireActionApproval: true,
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-test',
    name: 'test agent',
    prompt: 'collect the latest headlines',
    tool: { type: 'local' },
    outputPath: '/home/test/agent-output/out.md',
    outputTemplate: null,
    ...overrides,
  } as Agent;
}

describe('the irreversible boundary (the load-bearing property)', () => {
  it.each(IRREVERSIBLE_TYPES)('classifies "%s" as irreversible', (type) => {
    const verdict = classifyActionReversibility({ type } as AgentAction, OPTIMISTIC_ON);
    expect(verdict.reversible).toBe(false);
  });

  it.each(IRREVERSIBLE_TYPES)(
    'never makes a "%s" run rollback-eligible, even with the setting ON and a manual gate',
    (type) => {
      expect(isRollbackEligibleRun(agent({ action: { type } }), OPTIMISTIC_ON)).toBe(false);
    }
  );

  it.each(IRREVERSIBLE_TYPES)('rejects "%s" at the type level too', (type) => {
    expect(isReversibleActionType(type)).toBe(false);
  });

  it('poisons a multi-action fan-out when ANY sibling is irreversible', () => {
    const actions: AgentAction[] = [
      { type: 'draft' },
      { type: 'draft' },
      { type: 'social-post' }, // the poison
    ];
    expect(classifyRunReversibility(agent({ actions }), OPTIMISTIC_ON).reversible).toBe(false);
    expect(isRollbackEligibleRun(agent({ actions }), OPTIMISTIC_ON)).toBe(false);
  });

  it('poisons a fan-out even when the irreversible sibling is first', () => {
    const actions: AgentAction[] = [{ type: 'webhook' }, { type: 'draft' }];
    expect(isRollbackEligibleRun(agent({ actions }), OPTIMISTIC_ON)).toBe(false);
  });

  it('fails closed for an unrecognised (future) action type', () => {
    const verdict = classifyActionReversibility(
      { type: 'quantum-teleport' as AgentActionType },
      OPTIMISTIC_ON
    );
    expect(verdict.reversible).toBe(false);
    expect(verdict.reason).toBe('irreversible-unknown-action-type');
    expect(isReversibleActionType('quantum-teleport' as AgentActionType)).toBe(false);
  });

  it('keeps the reversible allowlist to exactly ["draft"]', () => {
    // A deliberate tripwire. Widening this list is a security decision that must
    // be made consciously — if you are here because this test failed, re-read
    // lib/agent-action-reversibility.ts's module doc comment first.
    expect([...REVERSIBLE_ACTION_TYPES]).toEqual(['draft']);
  });

  it('has an explicit ruling for every member of AgentActionType', () => {
    // Exhaustiveness: every type is either in the reversible allowlist or in the
    // irreversible list above — nothing may be silently unclassified.
    for (const type of ALL_ACTION_TYPES) {
      const inReversible = REVERSIBLE_ACTION_TYPES.includes(type);
      const inIrreversible = IRREVERSIBLE_TYPES.includes(type);
      expect(inReversible !== inIrreversible).toBe(true);
    }
    expect(ALL_ACTION_TYPES).toHaveLength(
      REVERSIBLE_ACTION_TYPES.length + IRREVERSIBLE_TYPES.length
    );
  });
});

describe('draft eligibility conditions', () => {
  it('is reversible for a plain local-output draft', () => {
    const verdict = classifyRunReversibility(agent({ action: { type: 'draft' } }), OPTIMISTIC_ON);
    expect(verdict.reversible).toBe(true);
    expect(verdict.reason).toBe('reversible-workspace-file-write');
  });

  it('treats an absent action as the implicit draft', () => {
    expect(classifyRunReversibility(agent(), OPTIMISTIC_ON).reversible).toBe(true);
  });

  it('refuses an obsidian output target (would git-init the user’s vault)', () => {
    const verdict = classifyRunReversibility(agent({ action: { type: 'draft' } }), {
      ...OPTIMISTIC_ON,
      agentOutputTarget: 'obsidian',
    });
    expect(verdict.reversible).toBe(false);
    expect(verdict.reason).toBe('destination-outside-rollback-workspace');
  });

  it('refuses a custom output target (arbitrary user path)', () => {
    expect(
      classifyRunReversibility(agent({ action: { type: 'draft' } }), {
        ...OPTIMISTIC_ON,
        agentOutputTarget: 'custom',
      }).reversible
    ).toBe(false);
  });

  it('refuses an orchestrated (multi-step) run', () => {
    const verdict = classifyRunReversibility(
      agent({
        action: { type: 'draft' },
        orchestration: { steps: ['collect the news', 'summarise it'] },
      }),
      OPTIMISTIC_ON
    );
    expect(verdict.reversible).toBe(false);
    expect(verdict.reason).toBe('orchestrated-run-not-eligible');
  });

  it('refuses a content-studio agent (writes outside the rollback workspace)', () => {
    const verdict = classifyRunReversibility(
      agent({
        action: { type: 'draft' },
        outputPath: '/home/test/projects/shelly-content-studio/drafts/x.md',
      }),
      OPTIMISTIC_ON
    );
    expect(verdict.reversible).toBe(false);
    expect(verdict.reason).toBe('studio-agent-writes-outside-workspace');
  });

  it('allows an all-draft fan-out', () => {
    const actions: AgentAction[] = [{ type: 'draft' }, { type: 'draft' }];
    expect(classifyRunReversibility(agent({ actions }), OPTIMISTIC_ON).reversible).toBe(true);
  });
});

describe('opt-in gating', () => {
  it('is never eligible while the setting is off (the default)', () => {
    expect(isRollbackEligibleRun(agent({ action: { type: 'draft' } }), {})).toBe(false);
    expect(
      isRollbackEligibleRun(agent({ action: { type: 'draft' } }), {
        ...OPTIMISTIC_ON,
        agentOptimisticWorkspaceWrites: false,
      })
    ).toBe(false);
  });

  it('is never eligible for a merely-truthy (non-true) setting value', () => {
    expect(
      isRollbackEligibleRun(agent({ action: { type: 'draft' } }), {
        agentOptimisticWorkspaceWrites: 1 as unknown as boolean,
      })
    ).toBe(false);
  });
});

describe('runWouldRequireApprovalTap', () => {
  it('follows the global default when the agent has no override', () => {
    expect(runWouldRequireApprovalTap({}, { defaultRequireActionApproval: true })).toBe(true);
    expect(runWouldRequireApprovalTap({}, { defaultRequireActionApproval: false })).toBe(false);
    // Fable5 review 2026-08-25: an absent setting must resolve the same way
    // as an explicit `true` now (fail-closed default), not the same as `false`.
    expect(runWouldRequireApprovalTap({}, {})).toBe(true);
  });

  it('lets the per-agent override win in both directions', () => {
    expect(
      runWouldRequireApprovalTap({ requireActionApproval: true }, { defaultRequireActionApproval: false })
    ).toBe(true);
    expect(
      runWouldRequireApprovalTap({ requireActionApproval: false }, { defaultRequireActionApproval: true })
    ).toBe(false);
  });
});
