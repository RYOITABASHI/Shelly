import * as fs from 'fs';
import * as path from 'path';

// The interactive PTY child must hand bash a PWD spelled like $HOME, otherwise bash seeds $PWD
// from getcwd() (/data/data/...) while `cd ~` yields the /data/user/0/... spelling of $HOME and
// path-keyed tools see the same directory twice.
describe('shelly-pty.c initial PWD', () => {
  const c = fs.readFileSync(
    path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/jni/shelly-pty.c'),
    'utf8',
  );

  it('sets PWD to homePath only after a successful chdir(homePath), after clearenv()', () => {
    expect(c).toMatch(/if \(chdir\(homePath\) != 0\) \{[\s\S]*?\} else \{[\s\S]*?setenv\("PWD", homePath, 1\);/);
    expect(c.indexOf('clearenv();')).toBeLessThan(c.indexOf('setenv("PWD", homePath, 1);'));
  });
});
