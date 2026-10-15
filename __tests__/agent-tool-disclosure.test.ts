/**
 * Engine disclosure on every confirmation surface (2026-10-15): the named
 * (pinned) tool is shown (review L2), and an autonomous draft whose named
 * cloud backend will be stored as Codex says so explicitly (follow-up item 2).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { parseAgentNL } from '@/lib/agent-nl-parser';
import { summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { describeDraftTool } from '@/lib/agent-tool-router';
import { buildAgentAddSummary } from '@/lib/agent-add-approval';

const binding = {
  reqId: '1760500000000-abcdef12',
  riskReasons: [] as string[],
  approvable: true,
  expiresAt: 0,
  fireable: true,
  draftHash: 'a'.repeat(64),
};

describe('pinned engine is shown (review L2)', () => {
  it('chat summary names the pinned engine (ja / en)', () => {
    const ja = parseAgentNL('毎朝8時にパープレで最新のLLM論文をリサーチして要約して');
    expect(summarizeAgentDraftAsText(ja, undefined, false, { cloudConsent: false })).toContain('エンジン: Perplexity API');
    const en = parseAgentNL('Every day at 9am research the latest AI chip news with Perplexity');
    expect(summarizeAgentDraftAsText(en, undefined, false, { cloudConsent: false })).toContain('Engine: Perplexity API');
  });

  it('no engine line for a keyword-routed draft', () => {
    const d = parseAgentNL('毎日9時に今日のニュースをまとめて通知して');
    expect(summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false })).not.toContain('エンジン:');
  });

  it('`shelly agent add` summary carries the engine and the pin flag', () => {
    const d = parseAgentNL('毎朝8時にパープレで最新のLLM論文をリサーチして要約して');
    const t = describeDraftTool(d, false);
    const s = buildAgentAddSummary(binding, d, '毎日 8:00', 'parsed', { tool: { label: t.label, pinned: t.pinned, note: null } });
    expect(s.tool).toContain('Perplexity');
    expect(s.toolPinned).toBe(true);
    expect(s.toolNote).toBeNull();
  });

  it('defaults to Auto when the caller passes no engine', () => {
    const d = parseAgentNL('毎日9時に今日のニュースをまとめて通知して');
    const s = buildAgentAddSummary(binding, d, '毎日 9:00');
    expect(s.tool).toBe('Auto');
    expect(s.toolPinned).toBe(false);
  });
});
