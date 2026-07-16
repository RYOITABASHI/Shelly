import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import AgentConfirmCard, { type ConfirmedAgentDraft } from '@/components/panes/AgentConfirmCard';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { useDmPairingStore } from '@/store/dm-pairing-store';
import { useSettingsStore } from '@/store/settings-store';
import { AUTH_REFS, EGRESS_ALLOWLIST } from '@/lib/capability-envelope';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    colors: {
      accent: '#00ff00',
      background: '#000000',
      border: '#333333',
      foreground: '#ffffff',
      inactive: '#666666',
      muted: '#999999',
      success: '#00cc66',
      surface: '#111111',
      warning: '#ffcc00',
    },
  }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getNotificationTriggerEnabled: jest.fn().mockReturnValue(new Promise(() => undefined)),
  },
}));

const draft: ParsedAgentDraft = {
  name: 'Daily summary',
  prompt: 'Summarize today',
  schedule: '0 8 * * *',
  scheduleConfident: true,
  scheduleLabel: 'Daily at 08:00',
  action: { type: 'draft' },
  tool: { type: 'local' },
  toolLabel: 'Local LLM',
  rawText: 'Every day at 8 summarize today',
};

describe('AgentConfirmCard', () => {
  beforeEach(() => {
    useDmPairingStore.setState({ pairings: [], isLoaded: true });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, autonomousCloudConsent: false },
    }));
  });

  it('renders a valid agent draft without entering an infinite update loop', () => {
    expect(() =>
      render(<AgentConfirmCard draft={draft} onConfirm={jest.fn()} onCancel={jest.fn()} />),
    ).not.toThrow();
  });

  // api-call (v1) — Track D authoring UI.
  describe('api-call (v1)', () => {
    const singleStepDraft: ParsedAgentDraft = draft; // no orchestrationSteps
    const twoStepDraft: ParsedAgentDraft = {
      ...draft,
      orchestrationSteps: ['gather sources', 'post the digest'],
    };
    const threeStepDraft: ParsedAgentDraft = {
      ...draft,
      orchestrationSteps: ['gather sources', 'draft a summary', 'post the digest'],
    };

    it('the api-call action option is hidden for a single-step (< 2 orchestration steps) draft', () => {
      const { queryByText } = render(<AgentConfirmCard draft={singleStepDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />);
      expect(queryByText('agentcard.action_api-call')).toBeNull();
    });

    it('the api-call action option appears once the draft has >= 2 orchestration steps', () => {
      const { getByText } = render(<AgentConfirmCard draft={twoStepDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />);
      expect(getByText('agentcard.action_api-call')).toBeTruthy();
    });

    it('the per-step "add API call" toggle appears on NON-FINAL rows only', () => {
      const { getAllByText, queryByText } = render(
        <AgentConfirmCard draft={threeStepDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />,
      );
      // 3 steps -> exactly 2 non-final rows get the toggle (rows 0 and 1),
      // row 2 (the final row) never does.
      expect(getAllByText('agentcard.step_api_call_add')).toHaveLength(2);
      // Sanity: the "remove" label never appears before anything is toggled on.
      expect(queryByText('agentcard.step_api_call_remove')).toBeNull();
    });

    it('the host picker for the terminal action editor is limited to exactly the EGRESS_ALLOWLIST hosts', () => {
      const { getByText, getAllByText } = render(
        <AgentConfirmCard draft={twoStepDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />,
      );
      fireEvent.press(getByText('agentcard.action_api-call'));
      expect(EGRESS_ALLOWLIST.length).toBe(9);
      for (const host of EGRESS_ALLOWLIST) {
        expect(getAllByText(host).length).toBeGreaterThan(0);
      }
    });

    it('selecting an authRef locks/derives the host to that ref\'s bound host', () => {
      const { getByText, queryByText } = render(
        <AgentConfirmCard draft={twoStepDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />,
      );
      fireEvent.press(getByText('agentcard.action_api-call'));
      // Before selecting an authRef, the host Segmented control is shown
      // (selectable), not the locked read-only label.
      expect(queryByText('agentcard.apicall_host_locked')).toBeNull();
      fireEvent.press(getByText('perplexity'));
      // After selecting the 'perplexity' authRef, the host picker collapses
      // to a locked, read-only label (AUTH_REFS.perplexity.host).
      expect(getByText('agentcard.apicall_host_locked')).toBeTruthy();
      expect(AUTH_REFS.perplexity.host).toBe('api.perplexity.ai');
    });

    it('toggling a step to api-call clears any tool pin and confirming produces apiCall in that step, with tool cleared', () => {
      const onConfirm = jest.fn<void, [ConfirmedAgentDraft]>();
      const draftWithPinnedStep: ParsedAgentDraft = {
        ...draft,
        orchestrationSteps: [
          { instruction: 'draft a summary', tool: { type: 'local' } },
          'post the digest',
        ],
      };
      const { getByText, getAllByText } = render(
        <AgentConfirmCard draft={draftWithPinnedStep} onConfirm={onConfirm} onCancel={jest.fn()} />,
      );
      // Toggle the first (non-final) row to api-call.
      fireEvent.press(getAllByText('agentcard.step_api_call_add')[0]);
      expect(getByText('agentcard.step_api_call_remove')).toBeTruthy();

      fireEvent.press(getByText('agentcard.confirm'));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      const submitted = onConfirm.mock.calls[0][0];
      expect(submitted.orchestrationSteps).toBeDefined();
      const first = submitted.orchestrationSteps![0];
      expect(typeof first).not.toBe('string');
      if (typeof first !== 'string') {
        expect(first.apiCall).toBeDefined();
        expect(first.apiCall!.host).toBe(EGRESS_ALLOWLIST[0]);
        expect(first.tool).toBeUndefined();
      }
    });
  });
});
