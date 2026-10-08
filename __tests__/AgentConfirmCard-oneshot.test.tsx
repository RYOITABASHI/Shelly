/**
 * AgentConfirmCard with a timed one-shot draft (lib/agent-oneshot.ts): the
 * sentinel round-trips verbatim, and a chat patch that changes the draft's
 * schedule while the card is mounted re-seeds the selector — the card must
 * never emit schedule:null (= run now and discard) from the one-shot branch.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import AgentConfirmCard from '@/components/panes/AgentConfirmCard';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
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

const oneShotDraft: ParsedAgentDraft = {
  name: 'Briefing',
  prompt: 'write a briefing',
  schedule: '@in 300000',
  scheduleConfident: true,
  scheduleLabel: 'Once',
  action: { type: 'webhook', webhookUrl: 'https://example.com/hook' },
  tool: { type: 'local' },
  toolLabel: 'Local LLM',
  rawText: 'In 5 minutes, write a briefing and send it to https://example.com/hook',
};

describe('AgentConfirmCard — timed one-shot', () => {
  beforeEach(() => {
    useDmPairingStore.setState({ pairings: [], isLoaded: true });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, autonomousCloudConsent: false },
    }));
    useSettingsStore.setState({ socialConnectors: [] } as any);
  });

  it('confirms the one-shot sentinel verbatim (resolved later, at confirmAgentDraft)', () => {
    const onConfirm = jest.fn();
    const { getByText } = render(<AgentConfirmCard draft={oneShotDraft} onConfirm={onConfirm} onCancel={jest.fn()} />);
    fireEvent.press(getByText('agentcard.confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].schedule).toBe('@in 300000');
  });

  it('M2: a patch to a recurring schedule while mounted re-seeds the selector — never schedule:null', () => {
    const onConfirm = jest.fn();
    const { getByText, rerender } = render(
      <AgentConfirmCard draft={oneShotDraft} onConfirm={onConfirm} onCancel={jest.fn()} />,
    );
    rerender(
      <AgentConfirmCard
        draft={{ ...oneShotDraft, schedule: '0 9 * * *', suggestedTime: { hour: 9, minute: 0 } }}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );
    fireEvent.press(getByText('agentcard.confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].schedule).toBe('0 9 * * *');
  });
});
