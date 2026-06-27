jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { resolveAutonomousFinalTool, suggestTool } from '@/lib/agent-tool-router';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const gemini: ToolChoice = { type: 'gemini-api' };
const perplexity: ToolChoice = { type: 'perplexity' };
const local: ToolChoice = { type: 'local' };
const codex: ToolChoice = { type: 'cli', cli: 'codex' };

describe('resolveAutonomousFinalTool — single source of truth for the autonomous tool', () => {
  it('non-autonomous keeps the scored tool verbatim', () => {
    expect(resolveAutonomousFinalTool(false, gemini, false, false)).toEqual(gemini);
    expect(resolveAutonomousFinalTool(false, local, true, true)).toEqual(local);
  });

  it('autonomous + consent + needsWeb KEEPS a web backend (the P1 Gemini/Perplexity path)', () => {
    expect(resolveAutonomousFinalTool(true, gemini, true, true)).toEqual(gemini);
    expect(resolveAutonomousFinalTool(true, perplexity, true, true)).toEqual(perplexity);
  });

  it('autonomous web WITHOUT consent → Codex (runtime would refuse an api-key tool)', () => {
    expect(resolveAutonomousFinalTool(true, gemini, false, true)).toEqual(codex);
    expect(resolveAutonomousFinalTool(true, perplexity, false, true)).toEqual(codex);
  });

  it('autonomous web with consent but NOT needsWeb → Codex (defensive gate)', () => {
    expect(resolveAutonomousFinalTool(true, gemini, true, false)).toEqual(codex);
    expect(resolveAutonomousFinalTool(true, perplexity, true, false)).toEqual(codex);
  });

  it('autonomous LOCAL is preserved (on-device transform is a valid autonomous path)', () => {
    // Regression guard: the helper used to drop local → Codex, forcing an
    // autonomous "要約して" onto the Codex OAuth path instead of on-device.
    expect(resolveAutonomousFinalTool(true, local, true, true)).toEqual(local);
    expect(resolveAutonomousFinalTool(true, local, false, false)).toEqual(local);
  });
});

// The card AND the @agent submit handler both call resolveAutonomousFinalTool with
// the SAME inputs (suggestTool(prompt).tool + detectRouteSignals(prompt).needsWeb +
// consent). Drive it from real prompts and route the stored tool back through the
// runtime to prove no [REFUSED] and the expected engine, end to end.
describe('card/handler ↔ runtime parity (no refusal, right engine)', () => {
  const mkAgent = (over: Partial<Agent>): Agent => ({
    id: 't', name: 'T', description: '', prompt: 'hi', schedule: '0 9 * * *',
    tool: codex, autonomous: true, outputPath: '~/out', outputTemplate: null,
    enabled: true, lastRun: null, lastResult: null, createdAt: 0, version: 1, ...over,
  });

  const stored = (prompt: string, consent: boolean): ToolChoice =>
    resolveAutonomousFinalTool(true, suggestTool(prompt).tool, consent, detectRouteSignals(prompt).needsWeb);

  it('web-mandatory news prompt + consent → gemini, runtime keeps it (grounded, no refusal)', () => {
    const tool = stored('ニュースを集めて', true);
    expect(tool).toEqual(gemini);
    const s = generateRunScript(mkAgent({ prompt: 'ニュースを集めて', tool }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('google_search');
  });

  it('non-web general prompt + consent → Codex, no refusal (was the dead-end bug)', () => {
    const tool = stored('毎朝今日の予定を整理して教えて', true);
    expect(tool).toEqual(codex);
    const s = generateRunScript(mkAgent({ prompt: '毎朝今日の予定を整理して教えて', tool }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
  });

  it('transform prompt → local, runtime keeps it on-device (not forced to Codex)', () => {
    // suggestTool tags local with a model; assert the TYPE is preserved (the helper
    // returns the scored tool verbatim, model and all — it must not become Codex).
    const tool = stored('この文章を要約して', true);
    expect(tool.type).toBe('local');
    const s = generateRunScript(mkAgent({ prompt: 'この文章を要約して', tool, runOn: 'on-device' }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
  });
});
