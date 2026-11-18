/**
 * `shelly config set` can never turn the approval-skipping switches ON
 * (settings.approveAllWithoutAsking, settings.mcpSkipApproval) — only the
 * Settings UI can. Turning them OFF from here is fine.
 */
const mockUpdateSettings = jest.fn();

jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('@/lib/workflow-manager', () => ({
  saveWorkflow: jest.fn(),
  loadWorkflow: jest.fn(),
  listWorkflows: jest.fn(async () => []),
  deleteWorkflow: jest.fn(),
  substituteParams: jest.fn((cmds: string[]) => cmds),
}));
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {},
      setShowConfigTUI: jest.fn(),
      setShowVoiceMode: jest.fn(),
      updateSettings: mockUpdateSettings,
      setPendingSkillApprovalName: jest.fn(),
    }),
  },
  DEFAULT_SETTINGS: {},
}));
jest.mock('@/store/cosmetic-store', () => ({
  useCosmeticStore: {
    getState: () => ({ soundProfile: 'modern', fontFamily: 'default', setSoundProfile: jest.fn(), setFontFamily: jest.fn() }),
  },
}));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) }));
jest.mock('@/lib/skill-import', () => ({
  SKILL_NAME_RE: /^[a-z0-9-]+$/,
  importSkillToQuarantine: jest.fn(),
  listQuarantinedSkills: jest.fn(async () => []),
  listImportedSkills: jest.fn(async () => []),
  rejectQuarantinedSkill: jest.fn(),
  deleteImportedSkill: jest.fn(),
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));

import { executeCommand } from '@/lib/pseudo-shell';

const state = () => ({ cwd: '/', env: {}, history: [] as string[] });

beforeEach(() => mockUpdateSettings.mockClear());

describe('shelly config set — UI-only switches', () => {
  it.each([
    ['approveAllWithoutAsking', 'true'],
    ['approveAllWithoutAsking', 'on'],
    ['approveAllWithoutAsking', '1'],
    ['mcpSkipApproval', 'true'],
  ])('refuses %s %s', async (key, value) => {
    const { lines } = await executeCommand(`shelly config set ${key} ${value}`, state());
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('stderr');
    expect(lines[0].text).toMatch(/can only be turned on in Settings/);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('allows turning it off', async () => {
    const { lines } = await executeCommand('shelly config set approveAllWithoutAsking false', state());
    expect(lines[0].type).toBe('stdout');
    expect(mockUpdateSettings).toHaveBeenCalledWith({ approveAllWithoutAsking: false });
  });
});
