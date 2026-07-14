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

// G4 Phase 2b follow-up: suggestTool (legacy/initial-suggestion path) used to keep
// its own local keyword arrays (CODE_KEYWORDS/ACADEMIC_KEYWORDS/TRANSFORM_KEYWORDS)
// that had drifted out of sync with the Layer-2 scorer's CODE_KW/ACADEMIC_WEB_KW/
// TRANSFORM_KW (DEFERRED.md P2 "キーワード集合の重複"). suggestTool now imports the
// scorer's arrays + word-boundary-safe matching directly, so both paths agree.
//
// ACADEMIC_KEYWORDS specifically aliases the scorer's NARROW ACADEMIC_WEB_KW, not
// the broad RESEARCH_KW — an earlier version of this fix used RESEARCH_KW and
// reproduced the exact "出典/調べ routes to paid Perplexity" bug ACADEMIC_WEB_KW
// exists to prevent (review finding), reachable via the ungated cloudFallbackTool
// path for a runOn:'cloud'-pinned agent. '調べ'/'出典'/'evidence' are therefore
// intentionally NOT academic triggers for suggestTool either.
describe('suggestTool keyword-set integration (drift fix)', () => {
  it('research synonyms only present in the scorer set now route to Perplexity too', () => {
    // '文献' was in ACADEMIC_WEB_KW but NOT in suggestTool's old local
    // ACADEMIC_KEYWORDS — before the fix this prompt fell through every category
    // and defaulted to Gemini API instead of Perplexity.
    const suggestion = suggestTool('この文献について教えて');
    expect(suggestion.tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    expect(suggestion.keyword).toBe('文献');
  });

  it('generic citation words (調べ/出典/evidence) do NOT trigger Academic — narrow set only', () => {
    // These are deliberately excluded from ACADEMIC_WEB_KW (see
    // agent-router-scoring.ts): a plain "collect news with sources" task must
    // stay on the general/Gemini route, not the paid Perplexity deep-research
    // tier. Verifies suggestTool inherited the NARROW set, not the broad
    // RESEARCH_KW (which does include these words for the scorer's needsSearch
    // signal — a different, unrelated job).
    expect(suggestTool('これについて調べて').tool.type).not.toBe('perplexity');
    expect(suggestTool('出典付きでニュースを集めて').tool.type).not.toBe('perplexity');
  });

  it('JP code synonyms only present in the scorer set now route to Codex CLI too', () => {
    // suggestTool's old local CODE_KEYWORDS had no Japanese synonyms at all
    // ('バグ'/'デプロイ'/'コード'/'リポジトリ'); this prompt used to default to
    // Gemini API instead of the Codex CLI path.
    const suggestion = suggestTool('システムバグ修正をお願い');
    expect(suggestion.tool).toEqual(codex);
    expect(suggestion.keyword).toBe('バグ');
  });

  it('short Latin keywords match on a word boundary, not as a bare substring', () => {
    // Regression guard mirrored from agent-router-scoring.test.ts: suggestTool used
    // to do a naive `lower.includes(kw)`, so 'pr' inside "previous" and 'repo'
    // inside "report" both misfired into the Codex/code branch.
    expect(suggestTool('use results from previous steps').tool.type).not.toBe('cli');
    expect(suggestTool('write a weather report').tool.type).not.toBe('cli');
    // A real standalone "pr" still correctly routes to Codex.
    expect(suggestTool('please review this pr').tool.type).toBe('cli');
  });

  it('katakana code synonyms (プルリク etc.) now route to Codex CLI too (DEFERRED.md P3)', () => {
    const suggestion = suggestTool('プルリクを直して');
    expect(suggestion.tool).toEqual(codex);
    expect(suggestion.keyword).toBe('プルリク');
  });

  it('CJK keywords keep matching as a substring (no word-boundary requirement)', () => {
    // Unlike Latin keywords, CJK keywords are unbounded substring matches both
    // before and after the fix — this must not regress. 'バグ' matches even
    // embedded inside a larger compound word with no surrounding whitespace.
    const suggestion = suggestTool('本番相当の環境でリポジトリのバグを直して');
    expect(suggestion.tool).toEqual(codex);
  });
});
