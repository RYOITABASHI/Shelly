/**
 * __tests__/agent-nl-parser-delete-intent.test.ts
 *
 * Unit coverage for detectFreeTextAgentDeleteIntent (lib/agent-nl-parser.ts) —
 * the deterministic, non-LLM detector for a free-text agent-deletion request
 * typed into the default companion chat WITHOUT the exact
 * `@agent delete <name>` command (e.g. "delete the news agent" /
 * "このエージェントを削除して"). See docs/superpowers/DEFERRED.md's
 * "自由文でのagent削除依頼のパーサー対応" entry for the gap this closes.
 *
 * This is a PURE function test — no store/native mocking needed, matching
 * the existing convention in __tests__/agent-nl-parser.test.ts.
 */
import { detectFreeTextAgentDeleteIntent } from '@/lib/agent-nl-parser';
import type { Agent } from '@/store/types';

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2)}`,
    name: 'Untitled',
    description: '',
    prompt: 'do the thing',
    schedule: null,
    notificationTrigger: null,
    tool: { type: 'cli', cli: 'codex' },
    outputPath: '/tmp/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: Date.now(),
    version: 1,
    ...overrides,
  } as Agent;
}

describe('detectFreeTextAgentDeleteIntent', () => {
  it('matches a clear English free-text delete request against the named agent', () => {
    const newsAgent = makeAgent({ id: 'agent-news', name: 'Daily News Digest' });
    const otherAgent = makeAgent({ id: 'agent-other', name: 'Weather Reminder' });
    const result = detectFreeTextAgentDeleteIntent('please delete the news agent', [newsAgent, otherAgent]);
    expect(result).toEqual({ agent: newsAgent });
  });

  it('matches a clear Japanese free-text delete request via the "というエージェント" naming form', () => {
    const newsAgent = makeAgent({ id: 'agent-news-jp', name: 'ニュース速報' });
    const otherAgent = makeAgent({ id: 'agent-other-jp', name: 'ゴミ出しリマインダー' });
    const result = detectFreeTextAgentDeleteIntent(
      'ニュース速報というエージェントを削除して',
      [newsAgent, otherAgent],
    );
    expect(result).toEqual({ agent: newsAgent });
  });

  it('matches a Japanese demonstrative ("このエージェント") only when exactly one agent is registered', () => {
    const onlyAgent = makeAgent({ id: 'agent-solo', name: 'Morning Brief' });
    const result = detectFreeTextAgentDeleteIntent('このエージェントを削除して', [onlyAgent]);
    expect(result).toEqual({ agent: onlyAgent });
  });

  it('does not resolve a demonstrative delete request when zero agents are registered', () => {
    expect(detectFreeTextAgentDeleteIntent('delete this agent', [])).toBeNull();
    expect(detectFreeTextAgentDeleteIntent('このエージェントを削除して', [])).toBeNull();
  });

  it('does not resolve a demonstrative delete request when multiple agents are registered (cannot tell which)', () => {
    const a = makeAgent({ id: 'agent-a', name: 'Agent A' });
    const b = makeAgent({ id: 'agent-b', name: 'Agent B' });
    expect(detectFreeTextAgentDeleteIntent('delete this agent', [a, b])).toBeNull();
    expect(detectFreeTextAgentDeleteIntent('このエージェントを削除して', [a, b])).toBeNull();
  });

  it('returns null for an unrelated sentence with no deletion or agent content', () => {
    const agent = makeAgent({ id: 'agent-x', name: 'Weather Reminder' });
    expect(detectFreeTextAgentDeleteIntent('今日の天気を教えて', [agent])).toBeNull();
    expect(detectFreeTextAgentDeleteIntent('what is the weather like today', [agent])).toBeNull();
  });

  it('returns an ambiguous result when the free-text name candidate matches more than one agent', () => {
    const morningNews = makeAgent({ id: 'agent-morning-news', name: 'Morning News' });
    const morningNotes = makeAgent({ id: 'agent-morning-notes', name: 'Morning Notes' });
    const result = detectFreeTextAgentDeleteIntent('delete the morning agent', [morningNews, morningNotes]);
    expect(result).toEqual({ ambiguous: expect.arrayContaining([morningNews, morningNotes]) });
    expect((result as { ambiguous: Agent[] }).ambiguous).toHaveLength(2);
  });

  it('does NOT match a message that merely mentions "delete" with no agent context (English)', () => {
    const agent = makeAgent({ id: 'agent-y', name: 'File Cleanup' });
    expect(detectFreeTextAgentDeleteIntent('I deleted a file yesterday', [agent])).toBeNull();
  });

  it('does NOT match a message that merely mentions "削除" with no agent context (Japanese)', () => {
    const agent = makeAgent({ id: 'agent-z', name: 'ファイル整理' });
    expect(detectFreeTextAgentDeleteIntent('削除する予定です', [agent])).toBeNull();
  });

  it('does NOT match a negated English delete phrase ("don\'t delete the agent")', () => {
    const agent = makeAgent({ id: 'agent-neg-en', name: 'Solo Agent' });
    expect(detectFreeTextAgentDeleteIntent("please don't delete the agent", [agent])).toBeNull();
  });

  it('does NOT match a negated Japanese delete phrase ("削除しないでください")', () => {
    const agent = makeAgent({ id: 'agent-neg-jp', name: 'ソロエージェント' });
    expect(
      detectFreeTextAgentDeleteIntent('そのエージェントは削除しないでください', [agent]),
    ).toBeNull();
  });

  it('returns null for an empty/whitespace-only message', () => {
    const agent = makeAgent({ id: 'agent-empty', name: 'Solo Agent' });
    expect(detectFreeTextAgentDeleteIntent('   ', [agent])).toBeNull();
  });
});
