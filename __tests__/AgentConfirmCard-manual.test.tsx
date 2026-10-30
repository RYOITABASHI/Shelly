/**
 * Review fix 3 (2026-10-30): a manual-default draft (no schedule named) that
 * reaches AgentConfirmCard (webhook / cli / intent / dm-reply / api-call)
 * seeds the selector at 'once'. Left untouched, it must register as a MANUAL
 * agent (manualTrigger, schedule null) — never the run-once-and-delete
 * one-shot. Only an explicit pick of the 'once' chip means run-now.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import AgentConfirmCard from '@/components/panes/AgentConfirmCard';
import { parseAgentNL, type ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { useDmPairingStore } from '@/store/dm-pairing-store';
import { useSettingsStore } from '@/store/settings-store';

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
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
  tFor: (_locale: string, key: string) => key,
  t: (key: string) => key,
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getNotificationTriggerEnabled: jest.fn().mockReturnValue(new Promise(() => undefined)),
  },
}));

function manualWebhookDraft(): ParsedAgentDraft {
  // The reviewer's input; the action is forced to a card-only type.
  const d = parseAgentNL('https://example.com/feed を読んで、要約して');
  return { ...d, action: { type: 'webhook', webhookUrl: 'https://example.com/hook' } };
}

describe('AgentConfirmCard — manual-default draft', () => {
  beforeEach(() => {
    useDmPairingStore.setState({ pairings: [], isLoaded: true });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, autonomousCloudConsent: false },
    }));
    useSettingsStore.setState({ socialConnectors: [] } as any);
  });

  it('untouched selector registers as manual (schedule null, manualTrigger) — not run-now', () => {
    const draft = manualWebhookDraft();
    expect(draft.trigger).toBe('manual');
    const onConfirm = jest.fn();
    const { getByText, queryByText } = render(<AgentConfirmCard draft={draft} onConfirm={onConfirm} onCancel={jest.fn()} />);
    expect(queryByText('agentcard.run_now')).toBeNull();
    expect(getByText('agentplan.manual_trigger_note')).toBeTruthy();
    fireEvent.press(getByText('agentcard.confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].schedule).toBeNull();
    expect(onConfirm.mock.calls[0][0].manualTrigger).toBe(true);
  });

  it('explicitly picking the once chip means run-now (no manualTrigger)', () => {
    const onConfirm = jest.fn();
    const { getByText } = render(<AgentConfirmCard draft={manualWebhookDraft()} onConfirm={onConfirm} onCancel={jest.fn()} />);
    fireEvent.press(getByText('agentcard.freq_once'));
    fireEvent.press(getByText('agentcard.run_now'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].schedule).toBeNull();
    expect(onConfirm.mock.calls[0][0].manualTrigger).toBeUndefined();
  });
});
