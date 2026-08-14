import { renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as Notifications from 'expo-notifications';

const mockConsumeSkillImprovementProposal = jest.fn();
const mockRevertSkillImprovement = jest.fn(async () => undefined);
let notificationResponseListener: ((response: any) => void) | undefined;

jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn((listener) => {
    notificationResponseListener = listener;
    return { remove: jest.fn() };
  }),
}));
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'sidebar.skill_improve_title') return 'Improve this skill?';
      if (key === 'sidebar.skill_improve_body') {
        return `“${params?.name}” succeeded. Add this lesson?\n\n${params?.note}`;
      }
      return key;
    },
  }),
}));
jest.mock('@/lib/agent-skills', () => ({
  deleteSkillRecipe: jest.fn(async () => undefined),
  distillSkillFromRun: jest.fn(),
  writeSkillRecipe: jest.fn(async () => undefined),
}));
jest.mock('@/lib/unattended-skill-save', () => ({
  DELETE_SAVED_SKILL_ACTION: 'delete-saved-skill',
  saveUnattendedSkillWithNotification: jest.fn(async () => undefined),
}));
jest.mock('@/lib/skill-self-improve', () => ({
  REVERT_SKILL_IMPROVEMENT_ACTION: 'revert-skill-improvement',
  consumeSkillImprovementProposal: (...args: unknown[]) => mockConsumeSkillImprovementProposal(...args),
  persistSkillImprovement: jest.fn(async () => undefined),
  revertSkillImprovement: (...args: unknown[]) => mockRevertSkillImprovement(...args),
}));

import { useSkillSaveOffer } from '@/hooks/use-skill-save-offer';

describe('useSkillSaveOffer UI and notification wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notificationResponseListener = undefined;
  });

  it('shows the attended improvement agent name and proposed learning in the Alert message', () => {
    mockConsumeSkillImprovementProposal.mockReturnValue({
      kind: 'bump-with-learning',
      agentName: 'Morning researcher',
      improved: { name: 'Research skill' },
      learning: { at: '2026-08-14T00:00:00.000Z', note: 'Verify publication dates before summarizing.' },
    });
    const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));

    result.current.offerSkillImprovement('agent-1');

    expect(Alert.alert).toHaveBeenCalledWith(
      'Improve this skill?',
      expect.stringMatching(/Morning researcher[\s\S]*Verify publication dates before summarizing\./),
      expect.any(Array),
      { cancelable: true },
    );
    expect((Alert.alert as jest.Mock).mock.calls[0][1]).not.toHaveLength(0);
    unmount();
  });

  it('registers one native listener and processes one revert with multiple hook instances', async () => {
    const first = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));
    const second = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));

    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    notificationResponseListener?.({
      actionIdentifier: 'revert-skill-improvement',
      notification: { request: { content: { data: { skillId: 'skill-1', learningAt: 'learn-at' } } } },
    });
    await Promise.resolve();

    expect(mockRevertSkillImprovement).toHaveBeenCalledTimes(1);
    expect(mockRevertSkillImprovement).toHaveBeenCalledWith(expect.any(Function), 'skill-1', 'learn-at');
    first.unmount();
    second.unmount();
  });
});
