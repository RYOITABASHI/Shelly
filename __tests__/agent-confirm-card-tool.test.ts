jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { resolveAutonomousFinalTool } from '@/lib/agent-tool-router';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const gemini: ToolChoice = { type: 'gemini-api' };
const perplexity: ToolChoice = { type: 'perplexity' };
const local: ToolChoice = { type: 'local' };
const codex: ToolChoice = { type: 'cli', cli: 'codex' };

describe('resolveAutonomousFinalTool — N1/P1 card wiring', () => {
  it('non-autonomous keeps the scored tool verbatim (Gemini stays Gemini)', () => {
    expect(resolveAutonomousFinalTool(false, gemini, false, false)).toEqual(gemini);
    expect(resolveAutonomousFinalTool(false, gemini, true, true)).toEqual(gemini);
    expect(resolveAutonomousFinalTool(false, local, false, false)).toEqual(local);
  });

  it('autonomous + consent + needsWeb KEEPS a web backend (the P1 Gemini/Perplexity path)', () => {
    expect(resolveAutonomousFinalTool(true, gemini, true, true)).toEqual(gemini);
    expect(resolveAutonomousFinalTool(true, perplexity, true, true)).toEqual(perplexity);
  });

  it('autonomous WITHOUT consent falls back to the gated Codex driver', () => {
    expect(resolveAutonomousFinalTool(true, gemini, false, true)).toEqual(codex);
    expect(resolveAutonomousFinalTool(true, perplexity, false, true)).toEqual(codex);
  });

  it('autonomous + consent but NOT needsWeb → Codex, NEVER a web tool', () => {
    // The load-bearing gate: suggestTool defaults a general prompt to gemini-api, so
    // a non-web autonomous task with consent must still store Codex — otherwise the
    // runtime refuses the api-key backend and every scheduled fire dead-ends.
    expect(resolveAutonomousFinalTool(true, gemini, true, false)).toEqual(codex);
    expect(resolveAutonomousFinalTool(true, perplexity, true, false)).toEqual(codex);
  });

  it('autonomous non-web scored tool always uses Codex', () => {
    expect(resolveAutonomousFinalTool(true, local, true, true)).toEqual(codex);
  });
});

// Parity guard: the tool the card STORES must not be one generateRunScript then
// REFUSES. Route the stored tool back through the runtime and assert no refusal.
describe('card-stored tool ↔ generateRunScript parity (no runtime refusal)', () => {
  const mkAgent = (over: Partial<Agent>): Agent => ({
    id: 't', name: 'T', description: '', prompt: 'hi', schedule: '0 9 * * *',
    tool: codex, autonomous: true, outputPath: '~/out', outputTemplate: null,
    enabled: true, lastRun: null, lastResult: null, createdAt: 0, version: 1, ...over,
  });

  it('web-mandatory prompt: stores gemini AND the runtime keeps it (no refusal, grounded)', () => {
    const stored = resolveAutonomousFinalTool(true, gemini, true, true);
    expect(stored).toEqual(gemini);
    const s = generateRunScript(mkAgent({ prompt: 'ニュースを集めて', tool: stored }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('google_search');
  });

  it('non-web prompt with consent: stores Codex, runtime does NOT refuse', () => {
    // The bug this guards: storing gemini-api here produced a [REFUSED] script on
    // every fire. With the needsWeb gate the card stores Codex → no refusal.
    const stored = resolveAutonomousFinalTool(true, gemini, true, false);
    expect(stored).toEqual(codex);
    const s = generateRunScript(mkAgent({ prompt: '毎朝今日の予定を整理して教えて', tool: stored }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
  });
});
