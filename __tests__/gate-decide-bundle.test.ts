import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { decideAutoAnswer, parseAutonomyPolicy, AutonomyPolicy } from '@/lib/agent-policy';
import { AutoAnswer } from '@/lib/agent-policy';

interface Case {
  name: string;
  command: string;
  policy: Partial<AutonomyPolicy> & { workspaceRoot: string };
  expectedAnswer: AutoAnswer;
}

const cases: Case[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gate-cases.json'), 'utf8'),
);
const HELPER = path.resolve(
  __dirname,
  '../modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js',
);

// The TS source of truth.
describe('gate decision — TS (decideAutoAnswer)', () => {
  for (const c of cases) {
    it(`${c.name}`, () => {
      const policy = parseAutonomyPolicy(c.policy, c.policy.workspaceRoot);
      expect(decideAutoAnswer(c.command, policy).answer).toBe(c.expectedAnswer);
    });
  }
});

// Drift guard: the bundled node helper MUST agree with the TS source on every
// fixture. If this fails, the bundle is stale — regenerate with `pnpm build:gate`.
describe('gate decision — bundled helper parity (run `pnpm build:gate` if stale)', () => {
  for (const c of cases) {
    it(`${c.name}`, () => {
      const out = execFileSync('node', [HELPER], {
        input: JSON.stringify({ command: c.command, policy: c.policy }),
        encoding: 'utf8',
      });
      expect(JSON.parse(out).answer).toBe(c.expectedAnswer);
    });
  }
});
