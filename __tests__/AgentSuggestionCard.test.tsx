/**
 * components/suggestions/AgentSuggestionCard.tsx — the dismissible banner
 * that offers a profile-driven agent suggestion.
 *
 * Two properties pinned here, both from a 2026-08-06 Codex adversarial
 * review round on this feature:
 *  1. It must never show a suggestion before AppSettings has finished
 *     loading from AsyncStorage — profileLearningEnabled defaults to `true`
 *     in memory, so acting before isSettingsLoaded flips true would flash a
 *     suggestion to a user who had actually persisted the toggle to off.
 *  2. Tapping Accept only opens the chat-native confirm step; it must NOT
 *     mark the suggestion "seen" (permanently suppressed) until the user
 *     either dismisses it directly or Codex's finding stands: an Accept
 *     followed by a Cancel in the chat confirm bubble must leave the
 *     suggestion eligible to resurface later.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ colors: {} }),
}));

jest.mock('@/lib/theme-utils', () => ({
  withAlpha: (color: string) => color,
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockLoadUserProfile = jest.fn();
jest.mock('@/lib/user-profile', () => ({
  loadUserProfile: (...args: unknown[]) => mockLoadUserProfile(...args),
}));

const mockSuggestAgentsFromProfile = jest.fn();
jest.mock('@/lib/agent-suggestion-engine', () => ({
  suggestAgentsFromProfile: (...args: unknown[]) => mockSuggestAgentsFromProfile(...args),
}));

const mockShouldShowSuggestion = jest.fn();
const mockMarkSuggestionSeen = jest.fn();
jest.mock('@/lib/agent-suggestion-dismissals', () => ({
  shouldShowSuggestion: (...args: unknown[]) => mockShouldShowSuggestion(...args),
  markSuggestionSeen: (...args: unknown[]) => mockMarkSuggestionSeen(...args),
}));

jest.mock('@/lib/agent-plan-summary', () => ({
  hasDraftAssumptions: () => false,
  summarizeAgentDraftAsText: () => 'summary',
}));

let mockSettingsState = { isSettingsLoaded: false, settings: { profileLearningEnabled: true } };
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: (selector: (s: typeof mockSettingsState) => unknown) => selector(mockSettingsState),
}));

let mockAgentState = { agents: [] as unknown[] };
jest.mock('@/store/agent-store', () => ({
  useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}));

const mockAddMessage = jest.fn();
const mockSetPendingAgentSession = jest.fn();
jest.mock('@/store/ai-pane-store', () => ({
  useAIPaneStore: {
    getState: () => ({
      addMessage: mockAddMessage,
      setPendingAgentSession: mockSetPendingAgentSession,
    }),
  },
}));

const mockAddPane = jest.fn();
const mockFocusSlot = jest.fn();
jest.mock('@/hooks/use-multi-pane', () => ({
  useMultiPaneStore: {
    getState: () => ({
      slots: [{ id: 'slot-ai', tab: 'ai' }],
      focusSlot: mockFocusSlot,
      addPane: mockAddPane,
    }),
  },
}));

jest.mock('@/store/pane-store', () => ({
  usePaneStore: {
    getState: () => ({ setFocusedPane: jest.fn() }),
  },
}));

import { AgentSuggestionCard } from '@/components/suggestions/AgentSuggestionCard';

const CANDIDATE = {
  id: 'cmd-git',
  reason: 'command' as const,
  signal: 'git',
  score: 9,
  title: 'Git helper',
  description: 'You often run git.',
  draft: { name: 'Git Helper', prompt: 'help with git', schedule: null } as never,
};

describe('AgentSuggestionCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsState = { isSettingsLoaded: false, settings: { profileLearningEnabled: true } };
    mockAgentState = { agents: [] };
    mockLoadUserProfile.mockResolvedValue({});
    mockSuggestAgentsFromProfile.mockReturnValue([CANDIDATE]);
    mockShouldShowSuggestion.mockResolvedValue(true);
  });

  it('never shows a suggestion before settings have finished loading, even though profileLearningEnabled defaults to true in memory', async () => {
    mockSettingsState = { isSettingsLoaded: false, settings: { profileLearningEnabled: true } };
    const { queryByText } = render(<AgentSuggestionCard />);

    // Give any in-flight microtasks a chance to resolve.
    await waitFor(() => expect(mockLoadUserProfile).not.toHaveBeenCalled());
    expect(queryByText('suggestions.agent.title')).toBeNull();
  });

  it('shows a suggestion once settings have loaded and profileLearningEnabled is true', async () => {
    mockSettingsState = { isSettingsLoaded: true, settings: { profileLearningEnabled: true } };
    const { queryByText } = render(<AgentSuggestionCard />);

    await waitFor(() => expect(queryByText('suggestions.agent.title')).toBeTruthy());
  });

  it('does not mark the suggestion seen on Accept — only opening the chat confirm step, not registering anything', async () => {
    mockSettingsState = { isSettingsLoaded: true, settings: { profileLearningEnabled: true } };
    const { getByText, queryByText } = render(<AgentSuggestionCard />);

    await waitFor(() => expect(queryByText('suggestions.agent.title')).toBeTruthy());
    fireEvent.press(getByText('suggestions.agent.accept'));

    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockSetPendingAgentSession).toHaveBeenCalledTimes(1);
    // The load-bearing assertion: Accept alone must never permanently
    // suppress the suggestion — only Dismiss does.
    expect(mockMarkSuggestionSeen).not.toHaveBeenCalled();
  });

  it('marks the suggestion seen on Dismiss', async () => {
    mockSettingsState = { isSettingsLoaded: true, settings: { profileLearningEnabled: true } };
    const { getByText, queryByText, getByLabelText } = render(<AgentSuggestionCard />);

    await waitFor(() => expect(queryByText('suggestions.agent.title')).toBeTruthy());
    fireEvent.press(getByLabelText('suggestions.agent.dismiss'));

    expect(mockMarkSuggestionSeen).toHaveBeenCalledWith(CANDIDATE.id);
  });
});
