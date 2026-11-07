/**
 * lib/managed-cli-update.ts: when the app calls scripts/shelly-cli-update.js.
 * The checks themselves are in shelly-cli-update.test.ts.
 */
const execCommand = jest.fn();
const isNetworkUnmetered = jest.fn();

jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...args: unknown[]) => execCommand(...args) }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logError: jest.fn() }));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { isNetworkUnmetered: () => isNetworkUnmetered() },
}));

import {
  isNewerVersion,
  managedCliAction,
  managedCliCommand,
  parseManagedCliStatuses,
  runManagedCliAutoUpdate,
  runManagedCliInstall,
  shouldRunManagedCliAutoUpdate,
  type ManagedCliStatus,
} from '@/lib/managed-cli-update';

const status = (over: Partial<ManagedCliStatus>): ManagedCliStatus => ({
  cli: 'claude',
  installed: true,
  managed: true,
  version: '2.1.319',
  previous: null,
  channel: 'latest',
  latest: '2.1.319',
  held: [],
  ...over,
});

beforeEach(() => {
  execCommand.mockReset();
  isNetworkUnmetered.mockReset();
  execCommand.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });
});

describe('managedCliAction', () => {
  it('offers install, update, retry or nothing', () => {
    expect(managedCliAction(status({ installed: false, managed: false, version: null }))).toBe('install');
    expect(managedCliAction(status({ latest: '2.1.320' }))).toBe('update');
    expect(managedCliAction(status({}))).toBe('none');
    expect(managedCliAction(status({ latest: null }))).toBe('none');
    expect(managedCliAction(status({ latest: '2.1.320', held: [{ version: '2.1.320', stage: 'trust' }] }))).toBe('held');
  });

  it('does not offer an update to something older', () => {
    expect(managedCliAction(status({ version: '2.1.319', latest: '2.1.311' }))).toBe('none');
  });

  it('a hand-staged copy, with no version record, can be taken over', () => {
    expect(managedCliAction(status({ managed: false, version: null }))).toBe('update');
  });

  it('compares versions as numbers', () => {
    expect(isNewerVersion('2.10.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('2.1.319', '2.1.319')).toBe(false);
  });
});

describe('the app-start pass', () => {
  it('needs the setting on and an unmetered network', () => {
    expect(shouldRunManagedCliAutoUpdate(undefined, true)).toBe(true);
    expect(shouldRunManagedCliAutoUpdate(true, true)).toBe(true);
    expect(shouldRunManagedCliAutoUpdate(false, true)).toBe(false);
    expect(shouldRunManagedCliAutoUpdate(true, false)).toBe(false);
  });

  it('runs nothing on a metered network', async () => {
    isNetworkUnmetered.mockResolvedValue(false);
    await runManagedCliAutoUpdate(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('runs nothing when switched off', async () => {
    isNetworkUnmetered.mockResolvedValue(true);
    await runManagedCliAutoUpdate(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('runs the auto pass on an unmetered network, and nothing else', async () => {
    isNetworkUnmetered.mockResolvedValue(true);
    await runManagedCliAutoUpdate(undefined);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(String(execCommand.mock.calls[0][0])).toMatch(/require\(p\);' auto$/);
  });
});

describe('commands', () => {
  it('go through the node -e bootstrap, with the CA bundle', () => {
    const command = managedCliCommand(['claude', 'install', '--agent']);
    expect(command).toContain('SHELLY_CLI_UPDATE_MAIN=1');
    expect(command).toContain('NODE_EXTRA_CA_CERTS="$HOME/.shelly-ssl/ca-certificates.crt"');
    expect(command).toContain('/system/bin/linker64 "$lib/node" -e ');
    expect(command).toMatch(/' claude install --agent$/);
  });

  it('an install failure carries the script\'s message', async () => {
    execCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '[shelly] signature did not verify\n' });
    await expect(runManagedCliInstall('claude')).rejects.toThrow('signature did not verify');
  });

  it('parses the last line and refuses anything else', () => {
    expect(parseManagedCliStatuses('noise\n{"claude":{"cli":"claude"},"agy":{"cli":"agy"}}\n')?.agy.cli).toBe('agy');
    expect(parseManagedCliStatuses('not json')).toBeNull();
    expect(parseManagedCliStatuses('{"claude":{}}')).toBeNull();
    expect(parseManagedCliStatuses('')).toBeNull();
  });
});
