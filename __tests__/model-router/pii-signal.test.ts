// MEMORY-001 Track C (see DEFERRED.md): the PII/taint signal reaching
// RunRequirements. Signal-only — no eligibility predicate consumes
// touchesPii yet, so this suite only asserts the field is populated
// correctly, not that it changes routing.

import { toRunRequirements, toRunRequirementsFromAgent } from '@/lib/model-router/wiring';
import { scanForSecrets } from '@/lib/secret-guard';
import { scanForPii } from '@/lib/memory/pii-guard';
import { Agent, ToolChoice } from '@/store/types';

const mkAgent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

describe('RunRequirements.touchesPii', () => {
  it('defaults to false when toRunRequirements is called without a pii result (back-compat)', () => {
    const reqs = toRunRequirements({
      taskKind: 'general',
      needsWeb: false,
      secret: scanForSecrets('ordinary task text'),
      unattended: false,
    });
    expect(reqs.touchesPii).toBe(false);
  });

  it('is true when the injected PiiGuardResult is flagged', () => {
    const reqs = toRunRequirements({
      taskKind: 'general',
      needsWeb: false,
      secret: scanForSecrets('ordinary task text'),
      pii: scanForPii('remember I was diagnosed with anxiety disorder'),
      unattended: false,
    });
    expect(reqs.touchesPii).toBe(true);
  });

  it('toRunRequirementsFromAgent computes touchesPii from the SAME field set scanForSecrets already re-scans (the recall chokepoint)', () => {
    const clean = toRunRequirementsFromAgent(mkAgent({ prompt: 'deploy the app to the device' }));
    expect(clean.touchesPii).toBe(false);

    // Simulates recalled memory content prepended to agent.prompt by
    // agent-manager's applyMemoryAndSkills before resolveAgentRoute runs.
    const withRecalledPii = toRunRequirementsFromAgent(
      mkAgent({
        prompt:
          '# Remembered context (on-device memory)\n' +
          '- [fact] my annual salary is $128,000\n' +
          '---\n' +
          'deploy the app to the device',
      })
    );
    expect(withRecalledPii.touchesPii).toBe(true);
  });

  it('touchesSecrets and touchesPii are independent — a run can trip one, both, or neither', () => {
    const secretOnly = toRunRequirementsFromAgent(
      mkAgent({ prompt: 'deploy with api_key=sk-abcdef0123456789ghjklmno' })
    );
    expect(secretOnly.touchesSecrets).toBe(true);
    expect(secretOnly.touchesPii).toBe(false);

    const piiOnly = toRunRequirementsFromAgent(
      mkAgent({ prompt: 'I got fired from my last job, keep that in mind' })
    );
    expect(piiOnly.touchesSecrets).toBe(false);
    expect(piiOnly.touchesPii).toBe(true);
  });
});
