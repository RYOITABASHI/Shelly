const setNotificationCategoryAsync = jest.fn();
const scheduleNotificationAsync = jest.fn();

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync,
  scheduleNotificationAsync,
}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { saveUnattendedSkillWithNotification } from '@/lib/unattended-skill-save';
import { buildSkillWriteCommand, makeSkillRecipe, VAULT_SKILLS_DIR } from '@/lib/agent-skills';

const notificationText = {
  title: 'Skill saved',
  body: 'Saved automatically',
  deleteButton: 'Delete',
};

describe('unattended skill secret gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not persist a secret-bearing prompt and notifies the user', async () => {
    const runCommand = jest.fn().mockResolvedValue('');

    const result = await saveUnattendedSkillWithNotification(runCommand, {
      name: 'Sensitive recipe',
      prompt: 'Summarize this with api_key=abcdefghijklmnop123456',
      status: 'success',
      unattended: true,
    }, notificationText);

    expect(result).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(setNotificationCategoryAsync).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: expect.stringContaining('not saved automatically') }),
    }));
  });

  it('does not mirror a secret-bearing confirmed recipe into the external Vault', () => {
    const recipe = makeSkillRecipe({
      name: 'Sensitive recipe',
      trigger: 'sensitive report',
      prompt: 'Use token=abcdefghijklmnop123456 to fetch the report.',
      route: 'on-device',
      toolLabel: 'Local LLM',
    });

    const command = buildSkillWriteCommand(recipe);

    expect(command).toContain(`mkdir -p '/home/shelly-test/.shelly/agents/skills'`);
    expect(command).not.toContain('OBSIDIAN_VAULT_PATH');
    expect(command).not.toContain(VAULT_SKILLS_DIR);
  });
});
