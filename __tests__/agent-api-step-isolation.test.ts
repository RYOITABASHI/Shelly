/**
 * Review H-A (2026-10-15): in an AUTONOMOUS chain, an API-key step (a
 * consented Perplexity/Gemini pin) must never send device status,
 * notification context, memory recall or prior-step carry (which can hold
 * local files a Codex step read) to the cloud. It gets an isolated prompt
 * (task text + own instruction), or fails closed when it needs earlier output.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { isolatedApiStepPolicy, stepReferencesPriorOutput, type NormalizedStep } from '@/lib/agent-orchestration';
import type { Agent, ToolChoice } from '@/store/types';

const PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };
const MEMORY = '# Memory\n- private note: my bank is X';
const TASK = '毎朝、関連研究を調べてまとめて';

const chainAgent = (steps: Agent['orchestration'] extends infer O ? O extends { steps: infer S } ? S : never : never, over: Partial<Agent> = {}): Agent => ({
  id: 'iso',
  name: 'iso',
  description: '',
  prompt: `${MEMORY}\n\n---\n\n${TASK}`,
  schedule: '0 8 * * *',
  tool: { type: 'cli', cli: 'codex' },
  autonomous: true,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  orchestration: { steps },
  ...over,
});

describe('isolatedApiStepPolicy', () => {
  const s = (instruction: string, tool?: ToolChoice): NormalizedStep => (tool ? { instruction, tool } : { instruction });
  it('first step and a self-contained step: isolated, no carry', () => {
    expect(isolatedApiStepPolicy([s('パープレで量子計算の論文を調べて', PPLX)], 0)).toEqual({ carry: false });
    expect(isolatedApiStepPolicy([s('~/notes を読んで'), s('パープレで量子計算の論文を調べて', PPLX)], 1)).toEqual({ carry: false });
  });
  it('a step that needs earlier LOCAL output fails closed; earlier isolated API output may be carried', () => {
    expect(stepReferencesPriorOutput('その内容に関連する研究をパープレで調べて')).toBe(true);
    const blocked = isolatedApiStepPolicy([s('~/notes を読んで'), s('その内容に関連する研究をパープレで調べて', PPLX)], 1);
    expect('blocked' in blocked && blocked.blocked).toContain('may contain local data');
    expect(isolatedApiStepPolicy([s('パープレで論文を集めて', PPLX), s('その結果をGeminiで要約して', { type: 'gemini-api' })], 1)).toEqual({ carry: true });
  });
});

describe('codex-chain .sh (autonomous): the API-key arm writes its own prompt', () => {
  const script = generateRunScript(
    chainAgent([
      'Codexで ~/notes の最新メモを読んで',
      { instruction: 'パープレで量子計算の関連研究を調べて', tool: PPLX },
      { instruction: 'その内容に関連する研究をパープレで調べて', tool: PPLX },
    ]),
    { autonomousCloudConsent: true },
  );

  it('step 2 prompt = task text + own instruction, never device/notification context, memory or carry', () => {
    const arm = script.slice(script.indexOf('  1)\n'), script.indexOf('  2)\n'));
    expect(arm).toContain('> "$PROMPT_FILE"');
    expect(arm).toContain(TASK);
    expect(arm).toContain('パープレで量子計算の関連研究を調べて');
    expect(arm).not.toContain('DEVICE_STATUS_CONTEXT');
    expect(arm).not.toContain('NOTIFICATION_CONTEXT');
    expect(arm).not.toContain('CODEX_ORCH_CARRY_FILE');
    expect(arm).not.toContain('private note');
    expect(arm).toContain('https://api.perplexity.ai/chat/completions');
  });

  it('step 3 needs the earlier (local-derived) output → fails closed, no API call', () => {
    const arm = script.slice(script.indexOf('  2)\n'));
    const end = arm.indexOf(';;');
    expect(arm.slice(0, end)).toContain('may contain local data');
    expect(arm.slice(0, end)).toContain('touch "$BACKEND_ERROR_FILE"');
    expect(arm.slice(0, end)).not.toContain('api.perplexity.ai');
  });

  it('the isolated prompt block is valid bash and produces exactly task + instruction', () => {
    const arm = script.slice(script.indexOf('  1)\n') + 5);
    const block = arm.slice(arm.indexOf('    {'), arm.indexOf('} > "$PROMPT_FILE"') + '} > "$PROMPT_FILE"'.length);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-iso-'));
    try {
      const promptFile = path.join(dir, 'p.txt').replace(/\\/g, '/');
      const sh = path.join(dir, 's.sh');
      fs.writeFileSync(sh, `DEVICE_STATUS_CONTEXT=secret-device\nNOTIFICATION_CONTEXT=secret-notif\nPROMPT_FILE='${promptFile}'\n${block}\ncat "$PROMPT_FILE"\n`);
      const out = execFileSync('bash', [sh.replace(/\\/g, '/')], { encoding: 'utf8' });
      expect(out).toContain(TASK);
      expect(out).toContain('# This step\nパープレで量子計算の関連研究を調べて');
      expect(out).not.toContain('secret-');
      expect(out).not.toContain('private note');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-autonomous chains keep the ordinary composed prompt (attended user approves)', () => {
    const s = generateRunScript(chainAgent(['Codexで読む', { instruction: 'パープレで調べて', tool: PPLX }], { autonomous: false }));
    const arm = s.slice(s.indexOf('  1)\n'));
    expect(arm.slice(0, arm.indexOf(';;'))).not.toContain('> "$PROMPT_FILE"');
  });
});

describe('PlanSpec (unattended executor) carries the same isolation', () => {
  it('marks API-key steps isolated / blocked; non-API steps stay ordinary', () => {
    const spec = buildAgentPlanSpec(
      chainAgent(
        [
          'ローカルLLMでメモを整理して',
          { instruction: 'パープレで量子計算の関連研究を調べて', tool: PPLX },
          { instruction: 'その内容に関連する研究をパープレで調べて', tool: PPLX },
        ],
        { tool: { type: 'local' } },
      ),
      { autonomousCloudConsent: true },
    );
    const iso = spec.steps!.isolation!;
    expect(iso[0]).toBeNull();
    expect(iso[1]).toMatchObject({ carry: false });
    expect((iso[1] as { base: string }).base).toContain(TASK);
    expect((iso[1] as { base: string }).base).not.toContain('private note');
    expect(iso[2]).toMatchObject({ blocked: expect.stringContaining('may contain local data') });
  });

  it('the executor honours it (source parity, asset mirror identical)', () => {
    const root = path.resolve(__dirname, '..');
    const src = fs.readFileSync(path.join(root, 'scripts/shelly-plan-executor.js'), 'utf8');
    const asset = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'), 'utf8');
    expect(asset).toBe(src);
    expect(src).toContain("const isolation = Array.isArray(plan.steps.isolation) ? plan.steps.isolation[i] : null;");
    expect(src).toContain("buildStepPrompt(isolation.base, step.instruction, isolation.carry === true ? contextResults : []");
  });

  it('no isolation field for non-autonomous plans', () => {
    const spec = buildAgentPlanSpec(chainAgent(['a', { instruction: 'パープレで調べて', tool: PPLX }], { autonomous: false, tool: { type: 'local' } }));
    expect(spec.steps!.isolation).toBeUndefined();
  });
});
