const setNotificationCategoryAsync = jest.fn();
const scheduleNotificationAsync = jest.fn();
const readSkillRecipes = jest.fn(async () => [] as Array<{ id: string }>);

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync,
  scheduleNotificationAsync,
}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('@/lib/agent-skills', () => {
  const actual = jest.requireActual('@/lib/agent-skills');
  return { ...actual, readSkillRecipes: (...args: unknown[]) => readSkillRecipes(...(args as [])) };
});

import { saveUnattendedSkillWithNotification } from '@/lib/unattended-skill-save';
import {
  buildSkillWriteCommand,
  deriveTrigger,
  makeSkillRecipe,
  skillRecipeId,
  VAULT_SKILLS_DIR,
} from '@/lib/agent-skills';

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

  it('auto-saves a plain, secret-free unattended run and notifies the user (positive control)', async () => {
    const runCommand = jest.fn().mockResolvedValue('');

    const result = await saveUnattendedSkillWithNotification(runCommand, {
      name: 'News roundup',
      prompt: 'Summarize the top local news headlines for today.',
      status: 'success',
      unattended: true,
    }, notificationText);

    expect(result).not.toBeNull();
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('.shelly/agents/skills'));
    expect(setNotificationCategoryAsync).toHaveBeenCalled();
    expect(scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ title: notificationText.title }),
    }));
  });

  // Idempotency regression: a recurring schedule's periodic log-sync poll
  // re-observes the SAME latest success on every cycle until the agent's
  // next run. Without a disk-existence check, saveUnattendedSkillWithNotification
  // would re-notify (and reset a curator-promoted recipe's successCount back
  // to 1, since distillSkillFromRun always mints successCount: 1) on every
  // single poll — see lib/unattended-skill-save.ts's readSkillRecipes() check.
  it('does not re-save or re-notify when a recipe with the same content-derived id already exists', async () => {
    const name = 'News roundup';
    const prompt = 'Summarize the top local news headlines for today.';
    const existingId = skillRecipeId(name, deriveTrigger(prompt));
    readSkillRecipes.mockResolvedValueOnce([{ id: existingId }]);
    const runCommand = jest.fn().mockResolvedValue('');

    const result = await saveUnattendedSkillWithNotification(runCommand, {
      name,
      prompt,
      status: 'success',
      unattended: true,
    }, notificationText);

    expect(result).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(setNotificationCategoryAsync).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
