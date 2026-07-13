import React from 'react';
import { render } from '@testing-library/react-native';
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
});
