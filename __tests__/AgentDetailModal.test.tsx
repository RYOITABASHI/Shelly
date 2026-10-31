import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { AgentDetailModal } from '@/components/layout/AgentDetailModal';

jest.mock('@expo/vector-icons/MaterialIcons', () => 'MaterialIcons');

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    colors: {
      surface: '#111111',
      surface2: '#222222',
      border: '#333333',
      foreground: '#ffffff',
      muted: '#999999',
      accent: '#00ff88',
      error: '#ff4444',
    },
  }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('AgentDetailModal action rows', () => {
  it('render as padded, themed, tappable buttons (static style, not a style callback)', () => {
    const onRun = jest.fn();
    const onClose = jest.fn();
    const utils = render(
      <AgentDetailModal
        data={{
          agentName: 'プロジェクト概要作成',
          sections: [{ key: 'contract', titleKey: 'agent_detail.contract', text: 'manual · draft · approval required' }],
          buttons: [
            { key: 'run', labelKey: 'sidebar.agent_run_now', onPress: onRun },
            { key: 'chat', labelKey: 'sidebar.agent_chat', onPress: jest.fn() },
          ],
        }}
        onClose={onClose}
      />,
    );
    const container = StyleSheet.flatten(utils.getByTestId('agent-detail-actions').props.style);
    expect(container.paddingHorizontal).toBeGreaterThan(0);
    const run = utils.getByTestId('agent-detail-action-run');
    expect(typeof run.props.style).not.toBe('function');
    const style = StyleSheet.flatten(run.props.style);
    expect(style.paddingHorizontal).toBeGreaterThan(0);
    expect(style.backgroundColor).toBe('#222222');
    expect(style.borderColor).toBe('#333333');
    expect(style.borderRadius).toBeGreaterThan(0);
    fireEvent.press(run);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
