/**
 * lib/pseudo-shell.ts — `shelly install <pack>` (Fable5 roadmap item #6).
 * Exercises the command dispatch against the REAL lib/optional-packs.ts
 * manifest (not a mock) so this suite also proves the production manifest's
 * `published: false` gate is honored end-to-end through the terminal
 * command surface — today `shelly install <any-real-pack-id>` must always
 * report the "not published yet" error, never attempt a live download.
 * Only the native TerminalEmulatorModule bridge and the other `shelly`
 * subcommand dependencies (workflow/settings/cosmetic/skill stores) are
 * mocked, following the existing convention used by other pseudo-shell-
 * adjacent unit tests (see __tests__/agent-rollback-offer-eligibility.test.ts).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

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
      updateSettings: jest.fn(),
      setPendingSkillApprovalName: jest.fn(),
    }),
  },
  DEFAULT_SETTINGS: {},
}));

jest.mock('@/store/cosmetic-store', () => ({
  useCosmeticStore: {
    getState: () => ({
      soundProfile: 'modern',
      fontFamily: 'default',
      setSoundProfile: jest.fn(),
      setFontFamily: jest.fn(),
    }),
  },
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

jest.mock('@/lib/skill-import', () => ({
  SKILL_NAME_RE: /^[a-z0-9-]+$/,
  importSkillToQuarantine: jest.fn(),
  listQuarantinedSkills: jest.fn(async () => []),
  listImportedSkills: jest.fn(async () => []),
  rejectQuarantinedSkill: jest.fn(),
  deleteImportedSkill: jest.fn(),
}));

const mockTerminalEmulator: Record<string, jest.Mock> = {
  enqueuePackDownload: jest.fn(async () => ({ downloadId: 1, path: '/fake/archive.tar.gz' })),
  getApkDownloadStatus: jest.fn(async () => ({ status: 'successful', reason: 0, downloadedBytes: 0, totalBytes: 0 })),
  removeApkDownload: jest.fn(async () => undefined),
  verifyPackArchive: jest.fn(async () => ({ ok: true, actualSha256: '', bytes: 0, error: null })),
  extractPackArchive: jest.fn(async () => ({ extractedPaths: [], libDir: '/fake/libDir/packs' })),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: mockTerminalEmulator,
}));

import { executeCommand } from '@/lib/pseudo-shell';
import { listOptionalPackIds } from '@/lib/optional-packs';

function state() {
  return { cwd: '/', env: {}, history: [] as string[] };
}

describe('shelly install — usage / listing', () => {
  it('shelly install (no args) lists every known pack id', async () => {
    const { lines } = await executeCommand('shelly install', state());
    const text = lines.map((l) => l.text).join('\n');
    for (const id of listOptionalPackIds()) {
      expect(text).toContain(id);
    }
    expect(text).toContain('not published yet');
  });

  it('shelly install list behaves the same as no args', async () => {
    const { lines } = await executeCommand('shelly install list', state());
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('Available packs');
  });
});

describe('shelly install <pack-id> — validation', () => {
  it('rejects an unknown pack id with a clean stderr line, no native calls', async () => {
    const { lines } = await executeCommand('shelly install not-a-real-pack', state());
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('stderr');
    expect(lines[0].text).toMatch(/unknown pack 'not-a-real-pack'/);
    expect(mockTerminalEmulator.enqueuePackDownload).not.toHaveBeenCalled();
  });

  it('accepts a known pack id and reaches the install path (refused as unpublished today)', async () => {
    const { lines } = await executeCommand('shelly install dev-tools', state());
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('stderr');
    expect(lines[0].text).toMatch(/install: Pack 'dev-tools' has no published release asset yet/);
    // The publication gate fires before any bridge call is made.
    expect(mockTerminalEmulator.enqueuePackDownload).not.toHaveBeenCalled();
  });

  it('reports a clear error when the installed build lacks native pack-download support', async () => {
    const { enqueuePackDownload, ...rest } = mockTerminalEmulator;
    delete mockTerminalEmulator.enqueuePackDownload;
    try {
      const { lines } = await executeCommand('shelly install editor-tools', state());
      expect(lines).toHaveLength(1);
      expect(lines[0].type).toBe('stderr');
      expect(lines[0].text).toMatch(/not supported by this build/);
    } finally {
      mockTerminalEmulator.enqueuePackDownload = enqueuePackDownload;
      Object.assign(mockTerminalEmulator, rest);
    }
  });
});

describe('shelly (bare / help) — mentions install', () => {
  it('lists shelly install in the top-level usage output', async () => {
    const { lines } = await executeCommand('shelly bogus-subcommand', state());
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('shelly install');
  });
});
