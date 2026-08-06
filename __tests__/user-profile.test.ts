/**
 * __tests__/user-profile.test.ts
 *
 * lib/user-profile.ts was a dead module (zero importers) until 2026-08-03:
 * README claimed "Shelly observes your command patterns" while nothing ever
 * called the learnFrom-family or formatProfileForPrompt. These tests cover the
 * module's learning + summary contract now that it is wired into terminal-store
 * (learnFromCommand) and use-ai-pane-dispatch (learnFromUserInput /
 * learnFromAgentUse producers, getUserProfileSummaryForPrompt consumer).
 *
 * Privacy invariant under test: everything round-trips through AsyncStorage
 * only (mocked here) — the module itself performs no network IO.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  formatProfileForPrompt,
  getUserProfileSummaryForPrompt,
  isProfileLearningEnabled,
  learnFromAgentUse,
  learnFromCommand,
  learnFromProject,
  learnFromUserInput,
  loadUserProfile,
  resetUserProfile,
} from '@/lib/user-profile';

beforeEach(async () => {
  await AsyncStorage.clear();
  // resetUserProfile clears BOTH the module-level in-memory cache and storage,
  // so each test starts from DEFAULT_PROFILE.
  await resetUserProfile();
});

describe('learnFromCommand', () => {
  it('accumulates command frequency and sorts by count', async () => {
    await learnFromCommand('git status');
    await learnFromCommand('git push');
    await learnFromCommand('ls -la');

    const profile = await loadUserProfile();
    expect(profile.topCommands[0]).toEqual({ cmd: 'git', count: 2 });
    expect(profile.topCommands.find((c) => c.cmd === 'ls')?.count).toBe(1);
  });

  it('detects tech skills from known command heads', async () => {
    await learnFromCommand('git log --oneline');
    await learnFromCommand('docker ps');

    const profile = await loadUserProfile();
    expect(profile.detectedSkills).toEqual(expect.arrayContaining(['Git', 'Docker']));
  });

  it('ignores comments and empty input', async () => {
    await learnFromCommand('# just a comment');
    await learnFromCommand('   ');

    const profile = await loadUserProfile();
    expect(profile.topCommands).toEqual([]);
  });

  it('persists through AsyncStorage so a fresh load survives cache reset', async () => {
    await learnFromCommand('git status');
    const raw = await AsyncStorage.getItem('shelly_user_profile');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).topCommands[0].cmd).toBe('git');
  });

  it('does not learn anything when profile learning is disabled in settings', async () => {
    await AsyncStorage.setItem('shelly_settings', JSON.stringify({ profileLearningEnabled: false }));

    expect(await isProfileLearningEnabled()).toBe(false);
    await learnFromCommand('git status');
    await learnFromAgentUse('codex');
    await learnFromProject('/repo/app', 'App');
    await learnFromUserInput('remember: I prefer concise output');

    const profile = await loadUserProfile();
    expect(profile.topCommands).toEqual([]);
    expect(profile.agentUsage).toEqual({});
    expect(profile.recentProjects).toEqual([]);
    expect(profile.facts).toEqual([]);
    expect(await getUserProfileSummaryForPrompt()).toBe('');
  });
});

describe('learnFromUserInput', () => {
  it('extracts an explicit "覚えて" fact', async () => {
    await learnFromUserInput('覚えておいて: 毎朝9時にニュース要約が欲しい');

    const profile = await loadUserProfile();
    expect(profile.facts.some((f) => f.includes('毎朝9時にニュース要約が欲しい'))).toBe(true);
  });

  it('detects the language tendency from the message', async () => {
    await learnFromUserInput('please summarize the logs');
    let profile = await loadUserProfile();
    expect(profile.style.language).toBe('en');

    await learnFromUserInput('ログを要約して');
    profile = await loadUserProfile();
    expect(profile.style.language).toBe('ja');
  });
});

describe('formatProfileForPrompt / getUserProfileSummaryForPrompt', () => {
  it('returns an empty string for a fresh (empty) profile', async () => {
    expect(formatProfileForPrompt(await loadUserProfile())).toBe('');
    expect(await getUserProfileSummaryForPrompt()).toBe('');
  });

  it('summarizes learned commands, agents, and projects', async () => {
    await learnFromCommand('git status');
    await learnFromAgentUse('local');
    await learnFromProject('/sdcard/repos/shelly', 'Shelly');

    const summary = await getUserProfileSummaryForPrompt();
    expect(summary).toContain('git');
    expect(summary).toContain('local');
    expect(summary).toContain('Shelly');
  });
});
