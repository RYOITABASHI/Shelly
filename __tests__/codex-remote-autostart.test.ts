/**
 * "Keep ChatGPT connected" (codex remote-control autostart): the setting's
 * default, the manifest receiver that survives `expo prebuild`, and the
 * native wiring invariants that are not unit-testable on the JVM here
 * (CodexRemotePolicy itself has src/test/.../CodexRemotePolicyTest.kt).
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
const read = (f: string) => fs.readFileSync(path.join(ktDir, f), 'utf8');


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

  it('has en/ja strings for the Settings row', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/locales/en.ts'), 'utf8');
    const ja = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/locales/ja.ts'), 'utf8');
    for (const key of [
      'codex_login.keep_connected',
      'codex_login.keep_connected_hint',
      'codex_login.keep_connected_on',
      'codex_login.keep_connected_off',
      'codex_login.keep_connected_not_paired',
      'codex_login.keep_connected_failed',
    ]) {
      expect(en).toContain(`'${key}':`);
      expect(ja).toContain(`'${key}':`);
    }
    expect(en).toContain("'codex_login.keep_connected': 'Keep ChatGPT connected'");
    // The toggle never marks the phone paired, so the subtitle must say how.
    expect(en).toMatch(/'codex_login\.keep_connected_hint': '[^\n]*shelly codex autostart on/);
    expect(ja).toMatch(/'codex_login\.keep_connected_hint': '[^\n]*shelly codex autostart on/);
  });

  it('the Settings toggle path never writes the paired marker', () => {
    const host = read('CodexRemoteHost.kt');
    const fn = host.slice(host.indexOf('fun setAutostart('), host.indexOf('fun disconnect('));
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain('PAIRED_FILE');
  });
});

describe('CodexRemoteAutostartReceiver manifest registration', () => {
  async function apply(manifest: any) {
    const cfg = withTerminalService({});
    return (await cfg.mods.android.manifest({ modResults: manifest })).modResults;
  }

  it('registers BOOT_COMPLETED + MY_PACKAGE_REPLACED, exported, no sender permission, idempotently', async () => {
    let m = await apply({ manifest: { application: [{}] } });
    m = await apply(m);
    const receivers = m.manifest.application[0].receiver.filter(
      (r: any) => r.$['android:name'] === 'expo.modules.terminalemulator.CodexRemoteAutostartReceiver',
    );
    expect(receivers).toHaveLength(1);
    expect(receivers[0].$['android:exported']).toBe('true');
    expect(receivers[0].$['android:permission']).toBeUndefined();
    const actions = receivers[0]['intent-filter'][0].action.map((a: any) => a.$['android:name']);
    expect(actions).toEqual(['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED']);
  });
});

describe('native wiring invariants', () => {
  const host = read('CodexRemoteHost.kt');
  const service = read('TerminalSessionService.kt');
  const receiver = read('CodexRemoteAutostartReceiver.kt');
  const module_ = read('TerminalEmulatorModule.kt');

  it('only reacts to the two protected system broadcasts', () => {
    expect(receiver).toContain('Intent.ACTION_BOOT_COMPLETED');
    expect(receiver).toContain('Intent.ACTION_MY_PACKAGE_REPLACED');
    expect(receiver).toContain('CodexRemoteHost.requestStartIfWanted');
  });

  it('runs the shim host through linker64 bash with the exec wrapper dropped and the STOP-ALL sentinel honored', () => {
    expect(host).toContain('"/system/bin/linker64"');
    expect(host).toContain('unset LD_PRELOAD');
    expect(host).toContain('__shelly_codex_remote __host');
    expect(host).toContain('.shelly/agents/.halted');
    expect(host).toContain('HomeInitializer.initialize(context)');
  });

  it('watches the default network and does not start while offline', () => {
    expect(host).toContain('registerDefaultNetworkCallback');
    expect(host).toMatch(/if \(!online\) return POLL_MS/);
    expect(host).toContain('CodexRemotePolicy.NETWORK_GRACE_MS');
    expect(host).toContain('CodexRemotePolicy.logShowsReconnect');
  });

  it('starts the supervisor with the service and warns in the notification with a Disconnect action', () => {
    expect(service).toContain('CodexRemoteHost.ensureWatching(applicationContext)');
    expect(service).toContain('ChatGPT can run commands on this phone');
    expect(service).toContain('ACTION_CODEX_REMOTE_DISCONNECT');
    expect(service).toContain('CodexRemoteHost.keepsServiceAlive(applicationContext)');
  });

  it('exposes get/set to JS and requests a start on app start', () => {
    expect(module_).toContain('AsyncFunction("getCodexRemoteAutostart")');
    expect(module_).toContain('AsyncFunction("setCodexRemoteAutostart")');
    expect(module_).toContain('CodexRemoteHost.requestStartIfWanted(context, "app start")');
  });
});
