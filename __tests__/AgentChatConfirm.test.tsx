import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import AgentChatConfirm from '@/components/panes/AgentChatConfirm';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

// Same mocking pattern as __tests__/AgentConfirmCard.test.tsx (this component
// shares the theme/i18n dependency surface, and that card had two real bugs
// in this exact area recently: c3f4ddd7a — infinite render loop from an
// unstable Zustand selector — and 387ca7135 which added its render-regression
// test in the first place). AgentChatConfirm has no store selector of its own,
// but it is rendered from the same MessageBubble list AgentConfirmCard is, so
// a render-time crash here would be just as disruptive.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000000',
      border: '#333333',
      foreground: '#ffffff',
      muted: '#999999',
      success: '#00cc66',
    },
  }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const scheduledDraft: ParsedAgentDraft = {
  name: 'X digest',
  prompt: 'Summarize today and post it',
  schedule: '0 8 * * *',
  scheduleConfident: true,
  scheduleLabel: 'Daily at 08:00',
  action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } },
  tool: { type: 'local' },
  toolLabel: 'Local LLM',
  rawText: 'Every day at 8, summarize today and post it to X',
};

const unfireableDraft: ParsedAgentDraft = {
  ...scheduledDraft,
  schedule: null,
  scheduleConfident: false,
  suggestedFrequency: 'daily',
};

describe('AgentChatConfirm', () => {
  it('renders without throwing for a draft with a fireable schedule', () => {
    expect(() =>
      render(<AgentChatConfirm draft={scheduledDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />),
    ).not.toThrow();
  });

  it('shows a Confirm affordance and calls onConfirm with the draft carried through verbatim', () => {
    const onConfirm = jest.fn();
    const { getByText } = render(
      <AgentChatConfirm draft={scheduledDraft} onConfirm={onConfirm} onCancel={jest.fn()} />,
    );
    fireEvent.press(getByText('agentcard.confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const confirmed = onConfirm.mock.calls[0][0];
    expect(confirmed.name).toBe(scheduledDraft.name);
    expect(confirmed.schedule).toBe(scheduledDraft.schedule);
    expect(confirmed.action).toEqual(scheduledDraft.action);
  });

  it('calls onCancel when Cancel is pressed', () => {
    const onCancel = jest.fn();
    const { getByText } = render(
      <AgentChatConfirm draft={scheduledDraft} onConfirm={jest.fn()} onCancel={onCancel} />,
    );
    fireEvent.press(getByText('agentcard.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // HARD REQUIREMENT parity with AgentConfirmCard: never register an agent that
  // will never fire. When the schedule still needs restating (a recurrence was
  // named but no confirmable time), Confirm must not be offered at all.
  it('withholds the Confirm affordance when the schedule still needs restating', () => {
    const { queryByText, getByText } = render(
      <AgentChatConfirm draft={unfireableDraft} onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(queryByText('agentcard.confirm')).toBeNull();
    expect(getByText('agentcard.cancel')).toBeTruthy();
  });
});
