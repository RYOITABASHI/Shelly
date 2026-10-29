/**
 * Settings → Codex Login → "Sign out of Codex" (lib/codex-signout.ts).
 * The exec dependency is simulated by a tiny fake filesystem: one flag for
 * whether $CODEX_HOME/auth.json exists, and per-command behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CODEX_AUTH_DELETE_CMD,
  CODEX_AUTH_STATE_CMD,
  CODEX_LOGOUT_CMD,
  getCodexAuthState,
  remoteControlActive,
  signOutOfCodex,
  type CodexRemoteStatus,
  type CodexSignOutDeps,
} from '../lib/codex-signout';

type Opts = {
  authExists?: boolean;
  logout?: 'ok' | 'fail' | 'noop' | 'throw';
  rmWorks?: boolean;
  remote?: CodexRemoteStatus;
  remoteStopWorks?: boolean;
  /** remote-control processes the sweep reports as still alive. */
  orphansLeft?: number;
};

function makeDeps(opts: Opts = {}) {
  let authExists = opts.authExists ?? true;
  let remote: CodexRemoteStatus = opts.remote ?? { enabled: false, running: false };
  const commands: string[] = [];
  const events: string[] = [];
  const deps: CodexSignOutDeps = {
    exec: jest.fn(async (cmd: string) => {
      commands.push(cmd);
      if (cmd === CODEX_AUTH_STATE_CMD) {
        return { stdout: authExists ? 'signed_in\n' : 'signed_out\n', stderr: '', exitCode: 0 };
      }
      if (cmd === CODEX_LOGOUT_CMD) {
        events.push('logout');
        switch (opts.logout ?? 'ok') {
          case 'ok':
            authExists = false;
            return { stdout: 'Successfully logged out\n', stderr: '', exitCode: 0 };
          case 'noop':
            return { stdout: '', stderr: '', exitCode: 0 };
          case 'throw':
            throw new Error('exec timeout');
          default:
            return { stdout: '', stderr: 'codex shim not found', exitCode: 127 };
        }
      }
      if (cmd === CODEX_AUTH_DELETE_CMD) {
        events.push('rm');
        if (opts.rmWorks ?? true) {
          authExists = false;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'Permission denied', exitCode: 1 };
      }
      throw new Error('unexpected command ' + cmd);
    }),
    getRemoteStatus: jest.fn(async () => remote),
    disableRemote: jest.fn(async () => {
      events.push('disableRemote');
      if (opts.remoteStopWorks ?? true) remote = { enabled: false, running: false };
      const orphans = opts.orphansLeft ?? 0;
      return remote && { ...remote, remainingRemoteControlProcesses: orphans };
    }),
  };
  return { deps, commands, events, auth: () => authExists };
}

describe('commands', () => {
  it('honors CODEX_HOME and defaults to ~/.codex/auth.json', () => {
    expect(CODEX_AUTH_STATE_CMD).toContain('"${CODEX_HOME:-$HOME/.codex}/auth.json"');
    expect(CODEX_AUTH_DELETE_CMD).toBe('rm -f -- "${CODEX_HOME:-$HOME/.codex}/auth.json"');
  });

  it('runs `codex logout` by sourcing the no-shebang $HOME/bin/codex shim in a subshell', () => {
    expect(CODEX_LOGOUT_CMD).toContain('( set -- logout; . "$HOME/bin/codex" )');
    expect(CODEX_LOGOUT_CMD).toContain('exit 127');
  });
});

describe('getCodexAuthState', () => {
  it('maps exec output to a state, unknown on errors', async () => {
    expect(await getCodexAuthState(async () => ({ stdout: 'signed_in\n', stderr: '', exitCode: 0 }))).toBe('signed_in');
    expect(await getCodexAuthState(async () => ({ stdout: 'signed_out', stderr: '', exitCode: 0 }))).toBe('signed_out');
    expect(await getCodexAuthState(async () => ({ stdout: '', stderr: 'x', exitCode: 1 }))).toBe('unknown');
    expect(await getCodexAuthState(async () => { throw new Error('no'); })).toBe('unknown');
  });
});

describe('remoteControlActive', () => {
  it('is true when autostart is on or a host is running', () => {
    expect(remoteControlActive(null)).toBe(false);
    expect(remoteControlActive({ enabled: false, running: false })).toBe(false);
    expect(remoteControlActive({ enabled: true, running: false })).toBe(true);
    expect(remoteControlActive({ enabled: false, running: true })).toBe(true);
  });
});

describe('signOutOfCodex', () => {
  it('uses codex logout and does not touch the file when logout works', async () => {
    const { deps, events, auth } = makeDeps();
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ ok: true, method: 'codex_logout', remoteStopped: false, remoteStillActive: false });
    expect(events).toEqual(['disableRemote', 'logout']);
    expect(auth()).toBe(false);
    // The orphan sweep always runs: orphans are what the status can't see.
    expect(deps.disableRemote).toHaveBeenCalledTimes(1);
  });

  it('falls back to deleting auth.json when codex logout is unavailable', async () => {
    const { deps, events, auth } = makeDeps({ logout: 'fail' });
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ ok: true, method: 'file_delete' });
    expect(r.ok && r.logoutError).toContain('exit 127');
    expect(events).toEqual(['disableRemote', 'logout', 'rm']);
    expect(auth()).toBe(false);
  });

  it('falls back when logout exits 0 but leaves the file, or throws', async () => {
    for (const logout of ['noop', 'throw'] as const) {
      const { deps, events } = makeDeps({ logout });
      const r = await signOutOfCodex(deps);
      expect(r).toMatchObject({ ok: true, method: 'file_delete' });
      expect(events).toEqual(['disableRemote', 'logout', 'rm']);
    }
  });

  it('reports failure honestly when the file survives both attempts', async () => {
    const { deps, auth } = makeDeps({ logout: 'fail', rmWorks: false });
    const r = await signOutOfCodex(deps);
    if (r.ok !== false) throw new Error('expected failure');
    expect(r.error).toMatch(/auth\.json is still present/);
    expect(r.error).toMatch(/Permission denied/);
    expect(auth()).toBe(true);
  });

  it('stops remote control before signing out when it is active', async () => {
    const { deps, events } = makeDeps({ remote: { enabled: true, running: true } });
    const r = await signOutOfCodex(deps);
    expect(events).toEqual(['disableRemote', 'logout']);
    expect(r).toMatchObject({ ok: true, remoteStopped: true, remoteStillActive: false });
  });

  it('still signs out but flags it when remote control could not be stopped', async () => {
    const { deps, auth } = makeDeps({ remote: { enabled: false, running: true }, remoteStopWorks: false });
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ ok: true, remoteStopped: false, remoteStillActive: true });
    expect(auth()).toBe(false);
  });

  it('sweeps an untracked host even when the status looks idle, and flags survivors', async () => {
    // status() only sees the tracked host; an orphan survives the sweep.
    const { deps } = makeDeps({ remote: { enabled: false, running: false }, orphansLeft: 1 });
    const r = await signOutOfCodex(deps);
    expect(deps.disableRemote).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, remoteStillActive: true });
  });

  it('does not count remote control as stopped without a sweep count', async () => {
    const { deps } = makeDeps({ remote: { enabled: true, running: false } });
    (deps.disableRemote as jest.Mock).mockResolvedValueOnce({ enabled: false, running: false });
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ remoteStopped: false, remoteStillActive: true });
  });

  it('flags remote control when the native disconnect is unavailable', async () => {
    const { deps, auth } = makeDeps({ remote: { enabled: true, running: true } });
    (deps.disableRemote as jest.Mock).mockRejectedValueOnce(new Error('not available in this build'));
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ ok: true, remoteStopped: false, remoteStillActive: true });
    expect(auth()).toBe(false);
  });

  it('is a no-op success when already signed out', async () => {
    const { deps, events } = makeDeps({ authExists: false });
    const r = await signOutOfCodex(deps);
    expect(r).toMatchObject({ ok: true, method: 'already_signed_out' });
    expect(events).toEqual(['disableRemote']);
  });
});

describe('native sign-out disconnect wiring', () => {
  const dir = path.resolve(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

  it('sweeps stragglers and reports the remaining remote-control processes', () => {
    const host = read('CodexRemoteHost.kt');
    const body = host.slice(host.indexOf('fun disconnectForSignOut('), host.indexOf('fun remoteControlProcessCount('));
    expect(body).toContain('sweepStragglers = true');
    expect(body).toContain('"remainingRemoteControlProcesses" to remaining');
    const count = host.slice(host.indexOf('fun remoteControlProcessCount('));
    expect(count).toContain('pid == Process.myPid()');
    expect(count).toContain('Process.myUid()');
    expect(count).toContain('isRemoteControlCmdline');
  });

  it('is exposed to RN through TerminalEmulatorModule', () => {
    const mod = read('TerminalEmulatorModule.kt');
    expect(mod).toContain('AsyncFunction("disconnectCodexRemoteForSignOut")');
    expect(mod).toContain('CodexRemoteHost.disconnectForSignOut(context)');
  });
});
