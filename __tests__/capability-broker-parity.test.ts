import * as fs from 'fs';
import * as path from 'path';
import { AUTH_REFS, DEFAULT_BUDGET, EGRESS_ALLOWLIST } from '@/lib/capability-envelope';

// The capability broker ships as an APK asset and is kept in scripts/ for host
// tests; they MUST stay byte-identical (a drift would let CI test one version
// while the device ships another — a fail-open hazard for a security-critical
// file). It also mirrors the classification CONSTANTS from
// lib/capability-envelope.ts by hand (the broker runs under node in the .sh and
// cannot import the TS). Guard both here.
describe('shelly-capability-broker.js parity', () => {
  const root = path.resolve(__dirname, '..');
  const scriptCopy = path.join(root, 'scripts', 'shelly-capability-broker.js');
  const assetCopy = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-capability-broker.js');
  const brokerSrc = fs.readFileSync(scriptCopy, 'utf8');

  it('scripts/ copy and the APK asset are byte-identical', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(brokerSrc);
  });

  it('the broker allowlist matches lib/capability-envelope.ts', () => {
    for (const host of EGRESS_ALLOWLIST) {
      expect(brokerSrc).toContain(`'${host}'`);
    }
  });

  it('the broker default budget matches lib/capability-envelope.ts', () => {
    const match = brokerSrc.match(/const DEFAULT_BUDGET = (\{[^;]+\});/);
    expect(match).not.toBeNull();

    const brokerBudget = Function(`return (${match?.[1]})`)() as typeof DEFAULT_BUDGET;
    expect(brokerBudget.maxCalls).toBe(DEFAULT_BUDGET.maxCalls);
    expect(brokerBudget.maxWallMs).toBe(DEFAULT_BUDGET.maxWallMs);
  });

  it('every auth_ref (name → envVar/header/host) matches the TS registry', () => {
    for (const [ref, spec] of Object.entries(AUTH_REFS)) {
      // The broker declares each ref as a key with the same envVar/header/host.
      const re = new RegExp(
        `${ref}:\\s*\\{[^}]*envVar:\\s*'${spec.envVar}'[^}]*header:\\s*'${spec.header}'[^}]*host:\\s*'${spec.host}'`,
      );
      expect(brokerSrc).toMatch(re);
    }
  });
});
