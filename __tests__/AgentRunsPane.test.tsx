/**
 * __tests__/AgentRunsPane.test.tsx — the Agent Runs pane's rendering and its
 * three row-level actions.
 *
 * The grouping/formatting rules themselves are pinned in the plain-node
 * __tests__/agent-runs-view.test.ts; this suite covers what only a rendered
 * component can show: that ALL retained runs are listed (the gap this pane
 * exists to close — Sidebar.tsx's Alert only ever showed the last one), that
 * the detail view renders the full routeDecision/steps/actionResults, that
 * "Re-run" reaches lib/agent-manager's runAgentNow, and — the honesty
 * property — that "Undo" explains itself instead of silently doing nothing.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react-native';

const mockRunAgentNow = jest.fn();
const mockSync = jest.fn();
const mockOfferSkillSave = jest.fn();

jest.mock('@/lib/agent-manager', () => ({
  runAgentNow: (...args: unknown[]) => mockRunAgentNow(...args),
  syncAgentRunLogsFromDisk: (...args: unknown[]) => mockSync(...args),
}));

jest.mock('@/lib/agent-plan-spec', () => ({
  buildAgentPlanSpec: jest.fn(() => ({ version: 1, steps: [] })),
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

jest.mock('@/hooks/use-panel-background', () => ({
  usePanelBackground: (hex: string) => hex,
  usePaneContentBackground: (hex: string) => hex,
}));

jest.mock('@/lib/theme-engine', () => ({
  useTheme: () => ({
    colors: {
      background: '#000000',
      surface: '#111111',
      foreground: '#FFFFFF',
      muted: '#888888',
      accent: '#00FF00',
      border: '#333333',
      success: '#00FF00',
      warning: '#FFFF00',
      error: '#FF0000',
    },
  }),
}));

// use-skill-save-offer's module-scope imports reach the TerminalEmulator
// native module (via lib/agent-skills → lib/home-path), which does not exist
// under jest-expo. Stubbing those leaves the hook module itself loadable so
// jest.requireActual below can hand back its REAL pure gate.
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('@/lib/agent-skills', () => ({
  deleteSkillRecipe: jest.fn(),
  distillSkillFromRun: jest.fn(() => ({ id: 'skill-1' })),
  writeSkillRecipe: jest.fn(),
}));
jest.mock('@/lib/unattended-skill-save', () => ({
  DELETE_SAVED_SKILL_ACTION: 'delete-saved-skill',
  saveUnattendedSkillWithNotification: jest.fn(),
}));

// Keep the REAL skill-save gate (shouldOfferSkillSave) so the button's
// enabled/disabled state is exercised against production logic; only the
// Alert-driven hook is stubbed.
jest.mock('@/hooks/use-skill-save-offer', () => {
  const actual = jest.requireActual('@/hooks/use-skill-save-offer');
  return {
    ...actual,
    useSkillSaveOffer: () => ({ offerSkillSave: mockOfferSkillSave }),
  };
});

import AgentRunsPane from '@/components/panes/AgentRunsPane';
import { useAgentStore } from '@/store/agent-store';
import { selectRunAgent } from '@/lib/agent-runs-selection';
import type { Agent, AgentRunLog } from '@/store/types';

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Morning Digest',
  description: '',
  prompt: 'summarize my inbox',
  schedule: '0 7 * * *',
  tool: { type: 'auto' },
  outputPath: '~/notes',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
};

function log(partial: Partial<AgentRunLog> & { timestamp: number }): AgentRunLog {
  return {
    agentId: 'agent-1',
    status: 'success',
    outputPreview: 'ok',
    durationMs: 1_200,
    toolUsed: 'codex',
    ...partial,
  };
}

function seed(runs: AgentRunLog[], agents: Agent[] = [AGENT]): void {
  useAgentStore.setState({ agents, runHistory: runs.length ? { 'agent-1': runs } : {} });
}

/** Renders and flushes the mount-time syncAgentRunLogsFromDisk refresh, so the
 *  resulting setState lands inside act() instead of warning after the test. */
async function renderPane() {
  const utils = render(<AgentRunsPane />);
  await act(async () => {});
  return utils;
}

describe('AgentRunsPane', () => {
  beforeEach(() => {
    mockRunAgentNow.mockReset().mockResolvedValue(undefined);
    mockSync.mockReset().mockResolvedValue(undefined);
    mockOfferSkillSave.mockReset();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    act(() => selectRunAgent(null));
    seed([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    act(() => selectRunAgent(null));
  });

  it('shows the empty state when no agent has any retained runs', async () => {
    const { getByText } = await renderPane();
    expect(getByText('agent_runs.empty_title')).toBeTruthy();
  });

  it('lists EVERY retained run, not just the latest one', async () => {
    seed([
      log({ timestamp: 1_000 }),
      log({ timestamp: 2_000, status: 'error' }),
      log({ timestamp: 3_000, status: 'skipped' }),
    ]);
    const { getAllByLabelText, getByText } = await renderPane();
    expect(getAllByLabelText('agent_runs.toggle_detail_a11y')).toHaveLength(3);
    expect(getByText('Morning Digest')).toBeTruthy();
    expect(getByText('agent_runs.runs_count')).toBeTruthy();
  });

  it('renders the newest run first even when the store array is oldest-first', async () => {
    seed([
      log({ timestamp: 1_000, status: 'error', errorMessage: 'old' }),
      log({ timestamp: 9_000, status: 'success' }),
    ]);
    const { getAllByLabelText } = await renderPane();
    const rows = getAllByLabelText('agent_runs.toggle_detail_a11y');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('agent_runs.status_success')).toBeTruthy();
    expect(within(rows[1]).getByText('agent_runs.status_error')).toBeTruthy();
  });

  it('expands a row into the full route-decision audit detail', async () => {
    seed([
      log({
        timestamp: 5_000,
        routeDecision: {
          route: 'on-device',
          toolType: 'local',
          toolLabel: 'Qwen3.5-2B',
          guard: 'secret',
          why: 'prompt referenced a credential',
          keyword: 'password',
          secretKinds: ['api_key'],
          noCloudFallback: true,
        },
      }),
    ]);
    const { getByLabelText, getByText, queryByText } = await renderPane();
    expect(queryByText('agent_runs.section_route')).toBeNull();

    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));

    expect(getByText('agent_runs.section_route')).toBeTruthy();
    expect(getByText('agent_runs.route_keyword')).toBeTruthy();
    expect(getByText('agent_runs.route_secrets')).toBeTruthy();
    expect(getByText('agent_runs.route_no_cloud')).toBeTruthy();
    expect(getByText('agent_runs.value_yes')).toBeTruthy();
    // Absent optional field must not render a blank row.
    expect(queryByText('agent_runs.route_score')).toBeNull();
  });

  it('renders orchestration steps, multi-action results and the error message', async () => {
    seed([
      log({
        timestamp: 5_000,
        status: 'error',
        errorMessage: 'gemini 429',
        steps: [
          { index: 0, instruction: 'fetch feed', status: 'success', durationMs: 10, outputPreview: '' },
          { index: 1, instruction: 'summarize', status: 'error', durationMs: 20, outputPreview: '' },
        ],
        actionResults: [
          { index: 0, actionType: 'draft', status: 'success', message: 'saved' },
          { index: 1, actionType: 'notify', status: 'error', message: 'no channel' },
        ],
      }),
    ]);
    const { getByLabelText, getByText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));

    expect(getByText('agent_runs.section_error')).toBeTruthy();
    expect(getByText('gemini 429')).toBeTruthy();
    expect(getByText('agent_runs.section_steps')).toBeTruthy();
    expect(getByText(/fetch feed/)).toBeTruthy();
    expect(getByText('agent_runs.section_actions')).toBeTruthy();
    expect(getByText(/no channel/)).toBeTruthy();
  });

  it('offers "save as skill" for a successful run, with the run\'s own route decision', async () => {
    seed([log({ timestamp: 5_000, routeDecision: {
      route: 'cloud', toolType: 'gemini-api', toolLabel: 'Gemini', guard: 'default', why: 'default',
    } })]);
    const { getByLabelText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));
    fireEvent.press(getByLabelText('agent_runs.action_save_skill'));

    expect(mockOfferSkillSave).toHaveBeenCalledTimes(1);
    const params = mockOfferSkillSave.mock.calls[0][0];
    expect(params.name).toBe('Morning Digest');
    expect(params.status).toBe('success');
    expect(params.routeDecision.toolLabel).toBe('Gemini');
    expect(params.timestamp).toBe(5_000);
  });

  it('does not offer "save as skill" for a failed run', async () => {
    seed([log({ timestamp: 5_000, status: 'error', errorMessage: 'boom' })]);
    const { getByLabelText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));
    fireEvent.press(getByLabelText('agent_runs.action_save_skill'));

    expect(mockOfferSkillSave).not.toHaveBeenCalled();
  });

  it('"Re-run" reaches runAgentNow for that agent and re-syncs the log', async () => {
    seed([log({ timestamp: 5_000 })]);
    const { getByLabelText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));
    fireEvent.press(getByLabelText('agent_runs.action_rerun'));

    await waitFor(() => expect(mockRunAgentNow).toHaveBeenCalledTimes(1));
    expect(mockRunAgentNow.mock.calls[0][0]).toBe('agent-1');
    await waitFor(() => expect(mockSync).toHaveBeenCalledWith(expect.any(Function), 'agent-1'));
  });

  it('surfaces a failure alert when the re-run cannot start', async () => {
    mockRunAgentNow.mockRejectedValue(new Error('locked'));
    seed([log({ timestamp: 5_000 })]);
    const { getByLabelText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));
    fireEvent.press(getByLabelText('agent_runs.action_rerun'));

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'agent_runs.rerun_failed_title',
        'agent_runs.rerun_failed_body',
      ),
    );
  });

  it('"Undo" explains why it is unavailable instead of silently doing nothing', async () => {
    seed([log({ timestamp: 5_000 })]);
    const { getByLabelText } = await renderPane();
    fireEvent.press(getByLabelText('agent_runs.toggle_detail_a11y'));
    fireEvent.press(getByLabelText('agent_runs.undo_unavailable_hint'));

    expect(Alert.alert).toHaveBeenCalledWith(
      'agent_runs.action_undo',
      'agent_runs.undo_unavailable_hint',
      expect.any(Array),
    );
    expect(mockRunAgentNow).not.toHaveBeenCalled();
  });

  it('scopes to a single agent when the Sidebar selected one before mount', async () => {
    useAgentStore.setState({
      agents: [AGENT, { ...AGENT, id: 'agent-2', name: 'Repo Watcher' }],
      runHistory: {
        'agent-1': [log({ timestamp: 1_000 })],
        'agent-2': [log({ agentId: 'agent-2', timestamp: 2_000 })],
      },
    });
    selectRunAgent('agent-2');
    const { getByText, queryByText } = await renderPane();
    expect(getByText('Repo Watcher')).toBeTruthy();
    expect(queryByText('Morning Digest')).toBeNull();
  });

  it('still lists runs whose agent was deleted, keyed by the raw agent id', async () => {
    useAgentStore.setState({
      agents: [],
      runHistory: { 'agent-1': [log({ timestamp: 1_000 })] },
    });
    const { getByText } = await renderPane();
    expect(getByText('agent-1')).toBeTruthy();
  });
});
