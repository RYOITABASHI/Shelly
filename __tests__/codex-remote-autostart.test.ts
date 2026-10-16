/**
 * "Keep ChatGPT connected" (codex remote-control autostart): the setting's
 * default, the manifest receiver that survives `expo prebuild`, and the
 * native security/wiring invariants that are not unit-testable on the JVM
 * here (the pure decisions have src/test/.../CodexRemotePolicyTest.kt).
 */
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const withTerminalService = require('../plugins/with-terminal-service.js');

const ktDir = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator',
);
const read = (f: string) => fs.readFileSync(path.join(ktDir, f), 'utf8').replace(/\r\n/g, '\n');
/** Body of `fun name(` up to the next top-level-in-object `fun ` (good enough for these files). */
function fnBody(src: string, name: string): string {
  const from = src.indexOf(`fun ${name}(`);
  if (from < 0) throw new Error(`fun ${name} not found`);
  const next = src.indexOf('\n    fun ', from + 1);
  const nextPrivate = src.indexOf('\n    private fun ', from + 1);
  const ends = [next, nextPrivate].filter((i) => i > 0);
  return src.slice(from, ends.length ? Math.min(...ends) : undefined);
}

const host = read('CodexRemoteHost.kt');
const store = read('CodexRemoteAutostart.kt');
const service = read('TerminalSessionService.kt');
const receiver = read('CodexRemoteAutostartReceiver.kt');
const module_ = read('TerminalEmulatorModule.kt');
const ktAll = fs
  .readdirSync(ktDir)
  .filter((f) => f.endsWith('.kt'))
  .map((f) => [f, read(f)] as const);

describe('codex remote autostart setting', () => {
  it('defaults to OFF', () => {
    // settings-store pulls in react-native, which this node project cannot
    // load; check the DEFAULT_SETTINGS literal instead.
    const src = fs.readFileSync(path.resolve(__dirname, '../store/settings-store.ts'), 'utf8');
    const defaults = src.slice(src.indexOf('export const DEFAULT_SETTINGS'));
    expect(defaults.slice(0, defaults.indexOf('\n};'))).toMatch(/\r?\n {2}codexRemoteAutostart: false,\r?\n/);
    const types = fs.readFileSync(path.resolve(__dirname, '../store/types.ts'), 'utf8');
    expect(types).toContain('codexRemoteAutostart?: boolean;');
  });

  it('has en/ja strings for the Settings row, the confirmation and the ChatGPT-app note', () => {
    const en = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/locales/en.ts'), 'utf8');
    const ja = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/locales/ja.ts'), 'utf8');
    for (const key of [
      'codex_login.keep_connected',
      'codex_login.keep_connected_hint',
      'codex_login.keep_connected_on',
      'codex_login.keep_connected_off',
      'codex_login.keep_connected_failed',
      'codex_login.keep_connected_confirm_title',
      'codex_login.keep_connected_confirm_body',
      'codex_login.keep_connected_confirm_ok',
      'codex_login.keep_connected_halted',
      'codex_login.keep_connected_no_notifications',
      'codex_login.keep_connected_off_note',
    ]) {
      expect(en).toContain(`'${key}':`);
      expect(ja).toContain(`'${key}':`);
    }
    expect(en).toContain("'codex_login.keep_connected': 'Keep ChatGPT connected'");
    // No UI text may tell users to enable it from a shell any more.
    expect(en).not.toContain('autostart on');
    expect(ja).not.toContain('autostart on');
    expect(en).toMatch(/'codex_login\.keep_connected_confirm_body': '[^\n]*run commands on this phone/);
    expect(en).toMatch(/'codex_login\.keep_connected_off_note': '[^\n]*remove this device in the ChatGPT app/);
  });

  it('the Settings toggle asks for confirmation before turning it on (existing Alert dialog)', () => {
    const ui = fs.readFileSync(path.resolve(__dirname, '../components/layout/SettingsDropdown.tsx'), 'utf8');
    const toggle = ui.slice(ui.indexOf('const toggleKeepConnected'), ui.indexOf('const toggleKeepConnected') + 700);
    expect(toggle).toContain("t('codex_login.keep_connected_confirm_title')");
    expect(toggle).toContain('onPress: () => void applyKeepConnected(true)');
  });
});

describe('H1: the ON switch is native, Keystore-HMACed and app-only', () => {
  it('stores ON in prefs with an HMAC from an AndroidKeyStore key and rotates the key on OFF', () => {
    expect(store).toContain('"AndroidKeyStore"');
    expect(store).toContain('KeyProperties.KEY_ALGORITHM_HMAC_SHA256');
    expect(store).toContain('MessageDigest.isEqual');
    expect(fnBody(store, 'setOff')).toContain('deleteEntry(KEY_ALIAS)');
    expect(fnBody(store, 'setOn')).toContain('newKey()');
  });

  it('only the RN Settings path calls setOn', () => {
    const callers = ktAll.filter(([f, src]) => f !== 'CodexRemoteAutostart.kt' && src.includes('CodexRemoteAutostart.setOn('));
    expect(callers.map(([f]) => f)).toEqual(['CodexRemoteHost.kt']);
    expect(host.match(/CodexRemoteAutostart\.setOn\(/g)).toHaveLength(1);
    expect(fnBody(host, 'setAutostartFromApp')).toContain('CodexRemoteAutostart.setOn(context)');
    const appCallers = ktAll.filter(([f, src]) => f !== 'CodexRemoteHost.kt' && src.includes('setAutostartFromApp('));
    expect(appCallers.map(([f]) => f)).toEqual(['TerminalEmulatorModule.kt']);
  });

  it('the supervisor reads ON only from the verified store, never from a file', () => {
    expect(fnBody(host, 'readInputs')).toContain('autostartOn = CodexRemoteAutostart.isOn(context)');
    // The mirror file is written, never read.
    expect(host).not.toMatch(/AUTOSTART_MIRROR_FILE\)\.read/);
    expect(host).not.toContain('codex-remote-paired');
  });
});

describe('M1: STOP-ALL latches and turns the switch off', () => {
  it('reconcile latches, turns off and sweeps remote-control processes', () => {
    const body = fnBody(host, 'reconcile');
    expect(body).toContain('haltLatched = CodexRemotePolicy.latchHalt(haltLatched, true)');
    expect(body).toContain('turnOff(context, "STOP-ALL", sweepStragglers = true)');
    expect(fnBody(host, 'readInputs')).toContain('halted = haltLatched ||');
  });

  it('only the in-app toggle clears the latch, and not while STOP-ALL is still active', () => {
    const body = fnBody(host, 'setAutostartFromApp');
    expect(body.indexOf('haltSentinelPresent(context)')).toBeLessThan(body.indexOf('haltLatched = false'));
    expect(host.match(/\n\s+haltLatched = false/g)).toHaveLength(1);
  });

  it('disconnect sweeps same-uid remote-control processes, never itself', () => {
    expect(fnBody(host, 'disconnect')).toContain('sweepStragglers = true');
    const sweep = fnBody(host, 'killRemoteControlStragglers');
    expect(sweep).toContain('pid == Process.myPid()');
    expect(sweep).toContain('Process.myUid()');
    expect(sweep).toContain('isRemoteControlCmdline');
  });
});

describe('M2/M3/L1/L5 native gating', () => {
  it('M2: may only run with a foreground service and notifications enabled', () => {
    const inputs = fnBody(host, 'readInputs');
    expect(inputs).toContain('serviceForeground = TerminalSessionService.instance?.isForegroundNow == true');
    expect(inputs).toContain('notificationsEnabled = notificationsEnabled(context)');
    expect(host).toContain('areNotificationsEnabled()');
    expect(fnBody(host, 'reconcile')).toContain('if (!CodexRemotePolicy.mayRun(inputs))');
    expect(service).toContain('isForegroundNow = true');
    expect(service).not.toMatch(/[^d]stopForeground\(STOP_FOREGROUND_REMOVE\)\n(?![\s\S]{0,40}CodexRemoteHost\.wake)/);
  });

  it('M2: a blocked foreground-service notification channel also stops it', () => {
    const body = fnBody(host, 'notificationsEnabled');
    expect(body).toContain('getNotificationChannel(TerminalSessionService.CHANNEL_ID)');
    expect(body).toContain('NotificationManager.IMPORTANCE_NONE');
  });

  it('STOP-ALL present at start turns the switch off and latches', () => {
    const body = fnBody(host, 'requestStartIfWanted');
    expect(body).toContain('CodexRemoteAutostart.setOff(app, "STOP-ALL at start")');
    expect(body.indexOf('haltSentinelPresent(app)')).toBeLessThan(body.indexOf('readInputs(app)'));
  });

  it('STOP-ALL / resume wake the native supervisor immediately', () => {
    expect(module_).toContain('AsyncFunction("wakeCodexRemoteHost")');
    const mgr = fs.readFileSync(path.resolve(__dirname, '../lib/agent-manager.ts'), 'utf8');
    const halt = mgr.slice(mgr.indexOf('export async function haltAllAgents'), mgr.indexOf('export async function resumeAllAgents'));
    expect(halt).toContain('await wakeCodexRemoteHost();');
    expect(halt.indexOf('writeFileCommand(haltSentinelPath()')).toBeLessThan(halt.indexOf('await wakeCodexRemoteHost();'));
  });

  it('M3: both pid paths reject <= 1 and self', () => {
    const body = fnBody(host, 'pidOf');
    expect(body).toContain('it > 1 && it != Process.myPid()');
    expect(body.match(/valid\(/g)!.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('Log.w(TAG, "could not read the host pid');
  });

  it('documents the same-uid code execution boundary', () => {
    expect(store).toContain('app_process');
    expect(store).toContain('outside it');
  });

  it('M2: the notification is updated on spawn and stop, not only on poll', () => {
    expect(host).toMatch(/publishActive\(pid != null && start != null\)/);
    expect(fnBody(host, 'stopHost')).toContain('publishActive(false)');
  });

  it('M3: verifies (pid, starttime) before signalling and prefers the spawned pid', () => {
    expect(fnBody(host, 'signalVerified')).toContain('CodexRemotePolicy.signalable(');
    expect(fnBody(host, 'signalVerified')).toContain('Process.myPid()');
    const tracked = fnBody(host, 'trackedHost');
    expect(tracked.indexOf('hostPid')).toBeLessThan(tracked.indexOf('STATE_FILE'));
  });

  it('L1: the stop marker is cleared only on a user app launch', () => {
    expect(fnBody(host, 'ensureWatching')).not.toContain('STOPPED_FILE');
    expect(fnBody(host, 'onUserAppLaunch')).toContain('STOPPED_FILE).delete()');
    expect(module_).toContain('CodexRemoteHost.onUserAppLaunch(context)');
    expect(receiver).not.toContain('onUserAppLaunch');
  });

  it('L5: the host is a ProcessBuilder child watched with waitFor, output to a file', () => {
    expect(host).toContain('ProcessBuilder("/system/bin/linker64", bashPath, "-c", HOST_COMMAND)');
    expect(host).toContain('proc.waitFor()');
    expect(host).toContain('exec >\\"\\$HOME/$SUPERVISOR_LOG_FILE\\" 2>&1');
    expect(host).not.toContain('ShellyJNI.execSubprocess');
  });

  it('watches the default network and does not start while offline', () => {
    expect(host).toContain('registerDefaultNetworkCallback');
    expect(host).toMatch(/if \(!online\) return POLL_MS/);
    expect(host).toContain('CodexRemotePolicy.networkVerdict');
    expect(host).toContain('CodexRemotePolicy.interestingLines');
  });

  it('runs the shim host with the exec wrapper dropped and honors STOP-ALL', () => {
    expect(host).toContain('unset LD_PRELOAD');
    expect(host).toContain('__shelly_codex_remote __host');
    expect(host).toContain('.shelly/agents/.halted');
    expect(host).toContain('HomeInitializer.initialize(context)');
  });
});

describe('CodexRemoteAutostartReceiver', () => {
  async function apply(manifest: any) {
    const cfg = withTerminalService({});
    return (await cfg.mods.android.manifest({ modResults: manifest })).modResults;
  }

  it('L4: registers BOOT_COMPLETED + MY_PACKAGE_REPLACED, exported=false, idempotently', async () => {
    let m = await apply({ manifest: { application: [{}] } });
    m = await apply(m);
    const receivers = m.manifest.application[0].receiver.filter(
      (r: any) => r.$['android:name'] === 'expo.modules.terminalemulator.CodexRemoteAutostartReceiver',
    );
    expect(receivers).toHaveLength(1);
    expect(receivers[0].$['android:exported']).toBe('false');
    const actions = receivers[0]['intent-filter'][0].action.map((a: any) => a.$['android:name']);
    expect(actions).toEqual(['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED']);
  });

  it('only reacts to the two protected system broadcasts', () => {
    expect(receiver).toContain('Intent.ACTION_BOOT_COMPLETED');
    expect(receiver).toContain('Intent.ACTION_MY_PACKAGE_REPLACED');
    expect(receiver).toContain('CodexRemoteHost.requestStartIfWanted');
  });

  it('the service exposes Disconnect and the warning text', () => {
    expect(service).toContain('CodexRemoteHost.ensureWatching(applicationContext)');
    expect(service).toContain('ChatGPT can run commands on this phone');
    expect(service).toContain('ACTION_CODEX_REMOTE_DISCONNECT');
    expect(module_).toContain('AsyncFunction("getCodexRemoteAutostart")');
    expect(module_).toContain('AsyncFunction("setCodexRemoteAutostart")');
  });
});
