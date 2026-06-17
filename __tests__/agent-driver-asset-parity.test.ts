import * as fs from 'fs';
import * as path from 'path';

// The autonomous gate driver ships as an APK asset but is also kept in scripts/
// for host E2E. They MUST stay byte-identical — a drift would let CI test one
// version while the device ships the other (a fail-open hazard for a
// security-critical file). Single source via `pnpm`-less hand-edit, so guard here.
// If this fails: re-sync the two files (they are the same driver).
describe('shelly-agent-driver.js asset parity', () => {
  const root = path.resolve(__dirname, '..');
  const scriptCopy = path.join(root, 'scripts', 'shelly-agent-driver.js');
  const assetCopy = path.join(
    root,
    'modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js',
  );

  it('scripts/ copy and the APK asset are byte-identical', () => {
    const a = fs.readFileSync(scriptCopy, 'utf8');
    const b = fs.readFileSync(assetCopy, 'utf8');
    expect(b).toBe(a);
  });
});
