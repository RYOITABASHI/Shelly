/**
 * Review H1 (2026-10-15): in a codex-resolved orchestration chain the global
 * apiKeyEnvScrub unsets every provider key, so a step pinned to
 * Perplexity/Gemini failed "key is not set". The arm now reads ONLY its own key
 * from $ENV_FILE into an unexported variable scoped to that arm.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateRunScript,
  SHELLY_READ_ENV_KEY_FN,
  stepScopedKeyPostlude,
  stepScopedKeyPrelude,
} from '@/lib/agent-executor';
import type { Agent, ToolChoice } from '@/store/types';

const PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };

const chainAgent = (autonomous: boolean, stepTool: ToolChoice = PPLX): Agent => ({
  id: 'h1-chain',
  name: 'H1 chain',
  description: '',
  prompt: 'chain',
  schedule: '0 8 * * *',
  tool: { type: 'cli', cli: 'codex' },
  autonomous,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  orchestration: {
    steps: [
      { instruction: 'パープレで最新の量子計算ニュースを集めて', tool: stepTool },
      'Codexでまとめて保存して',
    ],
  },
});

describe('codex-chain step arm gets ONLY its own key after the global scrub', () => {
  it.each([
    ['autonomous + consent', true],
    ['non-autonomous scheduled', false],
  ])('%s: keeps the scrub, defines the reader, wraps the Perplexity arm', (_label, autonomous) => {
    const s = generateRunScript(chainAgent(autonomous as boolean), { autonomousCloudConsent: true });
    expect(s).toContain('unset PERPLEXITY_API_KEY GEMINI_API_KEY');
    expect(s).toContain(SHELLY_READ_ENV_KEY_FN);
    const armStart = s.indexOf(stepScopedKeyPrelude('PERPLEXITY_API_KEY'));
    expect(armStart).toBeGreaterThan(0);
    const arm = s.slice(armStart);
    const call = arm.indexOf('https://api.perplexity.ai/chat/completions');
    expect(call).toBeGreaterThan(0);
    expect(arm.indexOf(stepScopedKeyPostlude('PERPLEXITY_API_KEY'))).toBeGreaterThan(call);
  });

  it('a Gemini-pinned step arm reads GEMINI_API_KEY the same way', () => {
    const s = generateRunScript(chainAgent(false, { type: 'gemini-api' }));
    expect(s).toContain(stepScopedKeyPrelude('GEMINI_API_KEY'));
  });

  it('behavior: the arm sees its key after the scrub; a child process and other keys do not; gone afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-h1-'));
    try {
      const envFile = path.join(dir, '.env').replace(/\\/g, '/');
      fs.writeFileSync(envFile, 'export PERPLEXITY_API_KEY=pplx-test-123\nGEMINI_API_KEY=g-test\n');
      const script = [
        'set -euo pipefail',
        `ENV_FILE='${envFile}'`,
        '. "$ENV_FILE"',
        'unset PERPLEXITY_API_KEY GEMINI_API_KEY CEREBRAS_API_KEY GROQ_API_KEY OPENROUTER_API_KEY',
        SHELLY_READ_ENV_KEY_FN,
        stepScopedKeyPrelude('PERPLEXITY_API_KEY'),
        'echo "arm=${PERPLEXITY_API_KEY:-none}"',
        'bash -c \'echo "child=${PERPLEXITY_API_KEY:-none}"\'',
        'echo "gemini=${GEMINI_API_KEY:-none}"',
        stepScopedKeyPostlude('PERPLEXITY_API_KEY'),
        'echo "after=${PERPLEXITY_API_KEY:-none}"',
      ].join('\n');
      const file = path.join(dir, 's.sh');
      fs.writeFileSync(file, script);
      const out = execFileSync('bash', [file.replace(/\\/g, '/')], { encoding: 'utf8' });
      expect(out).toContain('arm=pplx-test-123');
      expect(out).toContain('child=none');
      expect(out).toContain('gemini=none');
      expect(out).toContain('after=none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
