/**
 * __tests__/monitor-team-draft.test.ts — MONITOR MAP team → `@agent` draft
 * mapping (lib/monitor-team-draft.ts) and the register hand-off state
 * (lib/monitor-team-registration.ts).
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-notifications', () => ({ scheduleNotificationAsync: jest.fn(async () => 'id') }));
const mockEnsurePane =jest.fn((_tab: string) => true);
jest.mock('@/lib/pane-focus', () => ({ ensurePaneByTab: (tab: string) => mockEnsurePane(tab) }));
// The focused slot after ensurePaneByTab('ai') is the hand-off's target pane.
const mockMultiPane = { slots: [{ id: 'leaf-ai', tab: 'ai' }] as Array<{ id: string; tab: string } | null>, focusedSlot: 0 };
jest.mock('@/hooks/use-multi-pane', () => ({ useMultiPaneStore: { getState: () => mockMultiPane } }));

import { DEMO_TEAM } from '@/lib/monitor-demo';
import { teamToAgentDraft, canRegisterTeam } from '@/lib/monitor-team-draft';
import { normalizeStep, planParallelGroups } from '@/lib/agent-orchestration';
import {
  hasDraftAssumptions,
  hasFireableSchedule,
  shouldAutoRegisterDraft,
  shouldUseChatConfirm,
  summarizeAgentDraftAsText,
} from '@/lib/agent-plan-summary';
import { isManualTriggerDraft } from '@/lib/agent-nl-parser';
import { detectMessageLocale } from '@/lib/agent-slot-fill';
import { resolveRegistrationConfirmRequirement } from '@/lib/widget-agent-registration';
import { MAX_TEAM_FILE_CHARS, parseTeamFile, validate, type MonitorTeam } from '@/lib/monitor-team';
import {
  expireTeamDraft,
  markTeamDraftPosted,
  onTeamDraftCancelled,
  onTeamDraftConfirmed,
  reconcileTeamDraftSession,
  requestTeamRegistration,
  resetTeamRegistration,
  takePendingTeamDraft,
  TEAM_DRAFT_STALE_MS,
  useMonitorTeamRegistration,
} from '@/lib/monitor-team-registration';
import { useAIPaneStore } from '@/store/ai-pane-store';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

function build(team: MonitorTeam, locale: 'en' | 'ja' = 'en') {
  const res = teamToAgentDraft(team, locale);
  if ('errors' in res) throw new Error(`unexpected invalid team: ${res.errors[0].code}`);
  if (!res.ok) throw new Error('unreachable');
  return res.value;
}

describe('teamToAgentDraft', () => {
  it('maps columns to steps whose parallelGroup ids planParallelGroups accepts', () => {
    const { draft } = build(DEMO_TEAM);
    const steps = draft.orchestrationSteps!;
    expect(steps).toHaveLength(4);
    const plan = planParallelGroups(steps.map(normalizeStep));
    expect(plan.group[0]).toBe('p1');
    expect(plan.group[1]).toBe('p1');
    expect(plan.group[2]).toBeUndefined();
    expect(plan.group[3]).toBeUndefined();
  });

  it('pins each node provider and leaves Auto unpinned', () => {
    const team: MonitorTeam = {
      ...DEMO_TEAM,
      columns: DEMO_TEAM.columns.map((col, c) => col.map((n) => (c === 1 ? { ...n, provider: 'auto' as const } : n))),
    };
    const steps = build(team).draft.orchestrationSteps! as Array<{ tool?: unknown }>;
    expect(steps[0].tool).toEqual({ type: 'perplexity' });
    expect(steps[1].tool).toEqual({ type: 'gemini-api' });
    expect(steps[2].tool).toBeUndefined();
    expect(steps[3].tool).toEqual({ type: 'cli', cli: 'codex' });
  });

  it('folds a sub-agent role into its parent step', () => {
    const steps = build(DEMO_TEAM).draft.orchestrationSteps! as Array<{ instruction: string }>;
    expect(steps[2].instruction).toBe(`pick 3 and summarize; ${en['monitor.register.sub_then']} check every claim has a source`);
  });

  it('is manual-only, chat-confirmed, never auto-registered', () => {
    const { draft } = build(DEMO_TEAM);
    expect(draft.schedule).toBeNull();
    expect(isManualTriggerDraft(draft)).toBe(true);
    expect(hasFireableSchedule(draft)).toBe(true);
    expect(shouldUseChatConfirm(draft)).toBe(true);
    expect(hasDraftAssumptions(draft)).toBe(true);
    expect(shouldAutoRegisterDraft(draft, false)).toBe(false);
    const settings = { agentRegistrationRequireConfirm: false, widgetAgentRegistrationNoConfirm: true } as const;
    expect(resolveRegistrationConfirmRequirement(settings, 'monitor-team')).toBe(true);
  });

  it('saves to the team destination and collapses ask-before-writing to the agent', () => {
    const { draft, requireActionApproval } = build(DEMO_TEAM);
    expect(draft.action).toEqual({ type: 'draft' });
    // Shown, but labelled as not used yet (the draft action saves elsewhere),
    // and kept out of the prompt.
    expect(draft.outputPath).toBe(`OBSIDIAN: 20_Literature/AI_Papers/{date}/ ${en['monitor.register.dest_not_used']}`);
    expect(draft.prompt).not.toContain('OBSIDIAN');
    expect(requireActionApproval).toBe(true);
    // Carried on the draft → ConfirmedAgentDraft → createAgent.
    expect(draft.requireActionApproval).toBe(true);
    expect(draft.actionCaveat).toBe(en['monitor.register.ask_collapsed']);

    const noAsk: MonitorTeam = {
      ...DEMO_TEAM,
      destination: undefined,
      columns: DEMO_TEAM.columns.map((col) => col.map((n) => ({ ...n, askBeforeWrite: false }))),
    };
    const quiet = build(noAsk);
    expect(quiet.requireActionApproval).toBe(false);
    expect(quiet.draft.actionCaveat).toBeUndefined();
    expect(quiet.draft.outputPath).toBeUndefined();
    expect(quiet.draft.requireActionApproval).toBeUndefined();
  });

  it('summary shows the parallel pair and the manual note in the viewer language', () => {
    const enText = summarizeAgentDraftAsText(build(DEMO_TEAM, 'en').draft);
    // One line per column, same as the MAP: the parallel pair shares line 1.
    const lines = enText.split(/\r?\n/);
    const first = lines.find((l) => l.startsWith(`1. ${en['agentplan.parallel_group_label']} `));
    expect(first).toContain('collect new papers from arXiv');
    expect(first).toContain(en['agentplan.parallel_group_separator']);
    expect(first).toContain('collect new papers from Hugging Face');
    expect(lines.find((l) => l.startsWith('2. '))).toContain('pick 3 and summarize');
    expect(lines.find((l) => l.startsWith('3. '))).toContain('save to Obsidian');
    expect(enText).toContain(en['agentplan.manual_trigger_note']);

    const jaDraft = build(DEMO_TEAM, 'ja').draft;
    expect(detectMessageLocale(jaDraft.rawText)).toBe('ja');
    expect(summarizeAgentDraftAsText(jaDraft)).toContain(ja['agentplan.manual_trigger_note']);
  });

  it('a one-node team is a single-step agent with its provider as the tool', () => {
    const team: MonitorTeam = {
      title: 'Battery check',
      columns: [[{ id: 'n1', role: 'report battery level', provider: 'local', askBeforeWrite: false }]],
      subAgents: [],
    };
    const { draft } = build(team);
    expect(draft.orchestrationSteps).toBeUndefined();
    expect(draft.tool).toEqual({ type: 'local' });
    expect(draft.toolExplicit).toBe(true);
    expect(draft.prompt).toBe('report battery level');
  });

  it('refuses a team that breaks validate()', () => {
    const bad: MonitorTeam = {
      title: 'Bad',
      columns: [
        [{ id: 'a', role: 'one', provider: 'auto', askBeforeWrite: false }],
        [
          { id: 'b', role: 'two', provider: 'auto', askBeforeWrite: false },
          { id: 'c', role: 'three', provider: 'auto', askBeforeWrite: false },
        ],
      ],
      subAgents: [],
    };
    expect(canRegisterTeam(bad)).toBe(false);
    const res = teamToAgentDraft(bad, 'en');
    expect(res.ok).toBe(false);
    if ('errors' in res) expect(res.errors[0].code).toBe('final_parallel');
  });
});

describe('pasted team file limits', () => {
  it('refuses an over-long paste before parsing', () => {
    const res = parseTeamFile('# T\n- a\n' + 'x'.repeat(MAX_TEAM_FILE_CHARS));
    expect(res.ok).toBe(false);
    if ('error' in res) expect(res.error.code).toBe('too_long');
  });

  it('strips control characters', () => {
    const res = parseTeamFile('# T\u0007eam\n- fetch\u0000 news\u001b[31m\n- sum\u007fmarize');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.team.title).toBe('Team');
      expect(res.team.columns.map((c) => c[0].role)).toEqual(['fetch news[31m', 'summarize']);
    }
  });

  it('caps sub-agents per node and in total', () => {
    const three = '# T\n- a\n  - sub: one\n  - sub: two\n  - sub: three\n- b';
    const res = parseTeamFile(three);
    expect('error' in res && res.error.code).toBe('too_many_subs');
    const team: MonitorTeam = {
      title: 'T',
      columns: [
        [{ id: 'a', role: 'a', provider: 'auto', askBeforeWrite: false }],
        [{ id: 'b', role: 'b', provider: 'auto', askBeforeWrite: false }],
        [{ id: 'c', role: 'c', provider: 'auto', askBeforeWrite: false }],
      ],
      subAgents: ['a', 'a', 'b', 'b', 'c'].map((parentId, i) => ({
        id: `s${i}`, parentId, role: `check ${i}`, provider: 'auto' as const, askBeforeWrite: false,
      })),
    };
    expect(validate(team).map((e) => e.code)).toContain('too_many_subs');
    expect(validate({ ...team, subAgents: team.subAgents.slice(0, 4) })).toEqual([]);
  });
});

describe('monitor team registration hand-off', () => {
  beforeEach(() => {
    resetTeamRegistration();
    mockEnsurePane.mockReset().mockReturnValue(true);
    mockMultiPane.slots = [{ id: 'leaf-ai', tab: 'ai' }];
    useAIPaneStore.setState({ conversations: {} });
  });

  const token = () => useMonitorTeamRegistration.getState().token!;
  /** Simulate the draft sitting in a chat as the pending session. */
  const pendInChat = (tok: string | undefined) =>
    useAIPaneStore.setState({
      conversations: {
        c1: { paneId: 'c1', messages: [], activeAgent: null, isStreaming: false, terminalContext: null,
          pendingAgentSession: tok ? ({ draft: { monitorTeamToken: tok }, phase: 'await-confirm' } as never) : null },
      } as never,
    });

  it('queues a token-stamped draft for the focused AI pane only', () => {
    expect(requestTeamRegistration(DEMO_TEAM, 'en', 1000)).toBe('posted');
    expect(mockEnsurePane).toHaveBeenCalledWith('ai');
    const s = useMonitorTeamRegistration.getState();
    expect(s.status).toBe('awaiting-confirm');
    expect(s.pending?.targetPaneId).toBe('leaf-ai');
    expect(s.pending?.draft.monitorTeamToken).toBe(s.token);
    // Another AI pane cannot claim it; the target can, once.
    expect(takePendingTeamDraft('leaf-other', 1500)).toBeNull();
    expect(takePendingTeamDraft('leaf-ai', 1500)?.draft.name).toBe(DEMO_TEAM.title);
    expect(takePendingTeamDraft('leaf-ai', 1500)).toBeNull();
  });

  it('drops a stale hand-off', () => {
    requestTeamRegistration(DEMO_TEAM, 'en', 0);
    expect(takePendingTeamDraft('leaf-ai', TEAM_DRAFT_STALE_MS + 1)).toBeNull();
    expect(useMonitorTeamRegistration.getState().status).toBe('idle');
  });

  it('reports no_pane when no AI pane can be shown', () => {
    mockEnsurePane.mockReturnValue(false);
    expect(requestTeamRegistration(DEMO_TEAM, 'en')).toBe('no_pane');
    expect(useMonitorTeamRegistration.getState().pending).toBeNull();
  });

  it('confirm is matched by token; a foreign token is ignored', () => {
    requestTeamRegistration(DEMO_TEAM, 'en');
    takePendingTeamDraft('leaf-ai');
    markTeamDraftPosted();
    onTeamDraftConfirmed('mt-other', 'agent-x');
    expect(useMonitorTeamRegistration.getState().status).toBe('awaiting-confirm');
    onTeamDraftConfirmed(token(), 'agent-1');
    expect(useMonitorTeamRegistration.getState()).toMatchObject({ status: 'registered', agentId: 'agent-1' });
  });

  it('a confirm with no created agent (one-shot ran and was discarded, or failed) is terminal', () => {
    requestTeamRegistration(DEMO_TEAM, 'en');
    takePendingTeamDraft('leaf-ai');
    markTeamDraftPosted();
    onTeamDraftConfirmed(token(), null);
    expect(useMonitorTeamRegistration.getState()).toMatchObject({ status: 'idle', agentId: null });
  });

  it('cancel by token → cancelled', () => {
    requestTeamRegistration(DEMO_TEAM, 'en');
    takePendingTeamDraft('leaf-ai');
    markTeamDraftPosted();
    onTeamDraftCancelled(token());
    expect(useMonitorTeamRegistration.getState().status).toBe('cancelled');
  });

  it('a draft that leaves the chat (superseded / cleared) re-enables REGISTER; a late confirm still lands', () => {
    requestTeamRegistration(DEMO_TEAM, 'en');
    takePendingTeamDraft('leaf-ai');
    const tok = token();
    pendInChat(tok);
    markTeamDraftPosted();
    reconcileTeamDraftSession();
    expect(useMonitorTeamRegistration.getState().status).toBe('awaiting-confirm');
    pendInChat('mt-newer-draft'); // the store watcher reconciles on change
    expect(useMonitorTeamRegistration.getState().status).toBe('idle');
    // Tapping OK on the old bubble afterwards still reports by token.
    onTeamDraftConfirmed(tok, 'agent-late');
    expect(useMonitorTeamRegistration.getState()).toMatchObject({ status: 'registered', agentId: 'agent-late' });
  });

  it('an unanswered draft times out', () => {
    requestTeamRegistration(DEMO_TEAM, 'en');
    takePendingTeamDraft('leaf-ai');
    markTeamDraftPosted();
    expireTeamDraft();
    expect(useMonitorTeamRegistration.getState().status).toBe('idle');
  });
});
