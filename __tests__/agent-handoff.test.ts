import {
  HANDOFF_SNIPPET_MAX_CHARS,
  HandoffNarrator,
  MAX_HANDOFF_LINES_PER_RUN,
  buildHandoffDigest,
  classifyStepRole,
  countListItems,
  deriveStepRoleLabels,
  snippetForHandoff,
  summarizeHandoffPayload,
} from '@/lib/agent-handoff';
import {
  __resetHandoffDedupeForTests,
  markAgentHandoffRunNarrated,
  postAgentHandoffDigest,
  postAgentHandoffLine,
} from '@/lib/agent-companion-notice';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { tFor } from '@/lib/i18n';
import { parseStepsFromText } from '@/lib/agent-orchestration';
import { lastPromptAnchorMessage } from '@/lib/chat-pending-anchor';
import type { AgentRunLog, AgentRunStep } from '@/store/types';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const trJa = (key: string, params?: Record<string, string | number>) => tFor('ja', key, params);
const trEn = (key: string, params?: Record<string, string | number>) => tFor('en', key, params);

function rec(index: number, outputPreview: string, status: AgentRunStep['status'] = 'success') {
  return { index, status, outputPreview };
}

describe('role labels', () => {
  it('classifies common verbs in English and Japanese', () => {
    expect(classifyStepRole('Collect today\'s AI news')).toBe('researcher');
    expect(classifyStepRole('最新ニュースを調査して')).toBe('researcher');
    expect(classifyStepRole('要約して')).toBe('summarizer');
    expect(classifyStepRole('Write an X post draft')).toBe('writer');
    expect(classifyStepRole('記事を執筆')).toBe('writer');
    expect(classifyStepRole('Post the draft to X')).toBe('publisher');
    expect(classifyStepRole('Xに投稿')).toBe('publisher');
    expect(classifyStepRole('do the thing')).toBeNull();
  });

  it('falls back to Step N and disambiguates duplicate roles', () => {
    const labels = deriveStepRoleLabels(
      [{ instruction: 'research A' }, { instruction: 'research B' }, { instruction: 'xyz' }],
      trJa,
    );
    expect(labels).toEqual(['調査役1', '調査役2', 'ステップ3']);
  });
});

describe('on-device test utterance (parser-verified)', () => {
  it('splits the documented utterance into 3 steps with distinct role labels', () => {
    const steps = parseStepsFromText('毎朝8時に、まずAIの最新ニュースを3件調べて、次に要約して、最後にXの投稿文を書いて');
    expect(steps).toEqual(['AIの最新ニュースを3件調べて', '要約して', 'Xの投稿文を書いて']);
    expect(deriveStepRoleLabels(steps.map((instruction) => ({ instruction })), trJa)).toEqual(['調査役', '要約役', '執筆役']);
  });
});

describe('summaries', () => {
  it('counts list items and builds the items summary', () => {
    const out = '- first candidate\n- second\n- third';
    expect(countListItems(out)).toBe(3);
    expect(summarizeHandoffPayload(out, trJa)).toBe('3件の項目を渡しました —「first candidate second third」');
  });

  it('truncates long output with an ellipsis', () => {
    const s = snippetForHandoff('x'.repeat(500));
    expect(s.length).toBe(HANDOFF_SNIPPET_MAX_CHARS);
    expect(s.endsWith('…')).toBe(true);
  });

  it('redacts secrets before truncating', () => {
    const key = `sk-${'a'.repeat(40)}`;
    const s = snippetForHandoff(`token ${key} done`, 200);
    expect(s).not.toContain(key);
    expect(s).toContain('<redacted');
  });

  it('uses the no-output text for empty output', () => {
    expect(summarizeHandoffPayload('   ', trEn)).toBe('(no output)');
  });
});

describe('HandoffNarrator', () => {
  it('emits one pass line per serial boundary and a finish line', () => {
    const n = new HandoffNarrator(
      [{ instruction: 'research news' }, { instruction: 'write a post' }],
      trJa,
    );
    expect(n.stepStarting(0)).toEqual([]);
    expect(n.stepFinished(rec(0, '1. a\n2. b\n3. c'))).toEqual([
      '🔁 調査役 → 執筆役: 3件の項目を渡しました —「a b c」',
    ]);
    const done = n.stepFinished(rec(1, 'final post'));
    expect(done).toHaveLength(1);
    expect(done[0]).toBe('🏁 執筆役が完了（2ステップ）: final post');
  });

  it('coalesces a 3-branch fan-out into a single aggregated line', () => {
    const steps = [
      { instruction: 'research topic A', parallelGroup: 'g' },
      { instruction: 'research topic B', parallelGroup: 'g' },
      { instruction: 'research topic C', parallelGroup: 'g' },
      { instruction: 'summarize everything' },
    ];
    const n = new HandoffNarrator(steps, trEn);
    const start = n.stepStarting(0);
    expect(start).toEqual(['🔀 Split into 3 branches: Researcher1 / Researcher2 / Researcher3']);
    expect(n.stepStarting(1)).toEqual([]);
    expect(n.stepFinished(rec(0, 'A out'))).toEqual([]);
    expect(n.stepFinished(rec(1, 'B out'))).toEqual([]);
    const merged = n.stepFinished(rec(2, 'C out'));
    expect(merged).toHaveLength(1);
    expect(merged[0].split('\n')).toEqual([
      '🔗 Merged 3 branch results → Summarizer',
      '• Researcher1: A out',
      '• Researcher2: B out',
      '• Researcher3: C out',
    ]);
  });

  it('announces branches in the preceding step\'s hand-off line', () => {
    const n = new HandoffNarrator(
      [
        { instruction: 'gather sources' },
        { instruction: 'review source 1', parallelGroup: 'g' },
        { instruction: 'review source 2', parallelGroup: 'g' },
        { instruction: 'write the article' },
      ],
      trEn,
    );
    expect(n.stepFinished(rec(0, 'two sources'))).toEqual([
      '🔁 Researcher → 2 branches (Reviewer2 / Reviewer3): "two sources"',
    ]);
    expect(n.stepStarting(1)).toEqual([]);
  });

  it('emits a terminal stop line on failure and nothing afterwards', () => {
    const n = new HandoffNarrator([{ instruction: 'a' }, { instruction: 'b' }], trJa);
    expect(n.stepFinished(rec(0, 'boom', 'error'))).toEqual(['⚠️ ステップ1で停止: boom']);
    expect(n.stepFinished(rec(1, 'late'))).toEqual([]);
    expect(n.chainHalted()).toEqual([]);
  });

  it('caps non-terminal lines but always emits the terminal line', () => {
    const steps = Array.from({ length: MAX_HANDOFF_LINES_PER_RUN + 3 }, (_, i) => ({ instruction: `x${i}` }));
    const n = new HandoffNarrator(steps, trEn);
    const lines: string[] = [];
    steps.forEach((_, i) => lines.push(...n.stepFinished(rec(i, `out ${i}`))));
    expect(lines).toHaveLength(MAX_HANDOFF_LINES_PER_RUN + 1);
    expect(lines.at(-1)).toContain('🏁');
  });

  it('ignores out-of-range indices instead of throwing', () => {
    const n = new HandoffNarrator([{ instruction: 'a' }, { instruction: 'b' }], trEn);
    expect(n.stepFinished(rec(9, 'x'))).toEqual([]);
  });
});

describe('buildHandoffDigest', () => {
  it('returns null for single-step runs', () => {
    expect(buildHandoffDigest('A', [{ ...rec(0, 'x'), instruction: 'a' }], trEn)).toBeNull();
  });

  it('replays records (any completion order) into one digest', () => {
    const digest = buildHandoffDigest(
      'News Bot',
      [
        { ...rec(1, 'B'), instruction: 'research B', parallelGroup: 'g' },
        { ...rec(0, 'A'), instruction: 'research A', parallelGroup: 'g' },
        { ...rec(2, 'post body'), instruction: 'write post' },
      ],
      trJa,
    );
    expect(digest).not.toBeNull();
    const lines = digest!.split('\n');
    expect(lines[0]).toBe('📋 News Bot — バックグラウンド実行の引き継ぎ:');
    expect(lines[1]).toBe('🔀 2つに分岐: 調査役1 / 調査役2');
    expect(lines[2]).toBe('🔗 2件の分岐結果を集約 → 執筆役');
    expect(lines.at(-1)).toContain('🏁 執筆役が完了');
  });
});

describe('thread plumbing', () => {
  beforeEach(() => {
    __resetHandoffDedupeForTests();
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  function multiStepLog(agentId: string, timestamp: number): AgentRunLog {
    return {
      agentId,
      timestamp,
      status: 'success',
      outputPreview: 'done',
      durationMs: 10,
      toolUsed: 'test',
      steps: [
        { index: 0, instruction: 'research', status: 'success', durationMs: 1, outputPreview: '- a\n- b' },
        { index: 1, instruction: 'write', status: 'success', durationMs: 1, outputPreview: 'post' },
      ],
    };
  }

  it('posts live lines into the agent:<id> thread as system messages', () => {
    postAgentHandoffLine('agent-a', 'agent-a:live:1', 0, 'hello');
    const msgs = useAIPaneStore.getState().conversations[agentThreadKey('agent-a')].messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(expect.objectContaining({
      role: 'system',
      content: 'hello',
      handoff: { runId: 'agent-a:live:1', seq: 0 },
    }));
  });

  it('posts one digest per unattended run and dedupes repeats', () => {
    const log = multiStepLog('agent-b', 100);
    expect(postAgentHandoffDigest(log, 'Bot', trEn)).toBe(true);
    expect(postAgentHandoffDigest(log, 'Bot', trEn)).toBe(false);
    // Simulated restart: in-memory set cleared, persisted thread still dedupes.
    __resetHandoffDedupeForTests();
    expect(postAgentHandoffDigest(log, 'Bot', trEn)).toBe(false);
    expect(useAIPaneStore.getState().conversations[agentThreadKey('agent-b')].messages).toHaveLength(1);
  });

  it('skips runs the attended chain already narrated live', () => {
    const log = multiStepLog('agent-c', 200);
    markAgentHandoffRunNarrated(log);
    expect(postAgentHandoffDigest(log, 'Bot', trEn)).toBe(false);
    expect(useAIPaneStore.getState().conversations[agentThreadKey('agent-c')]).toBeUndefined();
  });

  it('skips single-step runs', () => {
    const log = { ...multiStepLog('agent-d', 300), steps: undefined };
    expect(postAgentHandoffDigest(log, 'Bot', trEn)).toBe(false);
  });
});

describe('i18n + wiring', () => {
  it('defines every handoff key in both en and ja', () => {
    const enKeys = Object.keys(en).filter((k) => k.startsWith('handoff.'));
    const jaKeys = Object.keys(ja).filter((k) => k.startsWith('handoff.'));
    expect(enKeys.length).toBeGreaterThan(10);
    expect(jaKeys.sort()).toEqual(enKeys.sort());
  });

  it('attended chain narrates at step boundaries and marks the aggregate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-manager.ts'), 'utf8');
    expect(src).toContain('narrate((n) => n.stepStarting(i))');
    // One plain call (the step threw) + one carrying the final step's saved
    // output path (the terminal line's inline Open link).
    expect(src.match(/narrate\(\(n\) => n\.stepFinished\(records\[records\.length - 1\]\)\)/g)).toHaveLength(1);
    expect(src).toContain('narrate((n) => n.stepFinished(records[records.length - 1]), finalOutput.savedPath)');
    expect(src).toContain('markAgentHandoffRunNarrated(aggregate)');
  });

  it('root log sync replays unattended runs as digests', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
    expect(src).toContain('postAgentHandoffDigest(log, agentName, t)');
  });
});

describe('lastPromptAnchorMessage', () => {
  const base = { content: '', timestamp: 1 };
  it('skips trailing system, hand-off and run-notice lines', () => {
    const ask = { ...base, id: 'ask', role: 'assistant' as const, pendingApiKeyProvider: 'geminiApiKey' as const };
    const anchor = lastPromptAnchorMessage([
      ask,
      { ...base, id: 'h', role: 'system' as const, handoff: { runId: 'r', seq: 0 } },
      { ...base, id: 'n', role: 'assistant' as const, agentRunLogId: 'a:1' },
      { ...base, id: 'agent-run-started-a-1', role: 'assistant' as const },
    ]);
    expect(anchor?.id).toBe('ask');
  });
  it('a real user reply is the anchor', () => {
    expect(lastPromptAnchorMessage([
      { ...base, id: 'ask', role: 'assistant' },
      { ...base, id: 'u', role: 'user' },
      { ...base, id: 's', role: 'system' },
    ])?.id).toBe('u');
    expect(lastPromptAnchorMessage([])).toBeUndefined();
  });
});

describe('older-run collapse', () => {
  beforeEach(() => {
    __resetHandoffDedupeForTests();
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });
  it('keeps only the terminal line of older runs when a new run starts', () => {
    postAgentHandoffLine('z', 'z:live:1', 0, 'r1 a');
    postAgentHandoffLine('z', 'z:live:1', 1, 'r1 end');
    useAIPaneStore.getState().addMessage(agentThreadKey('z'), { id: 'user-1', role: 'user', content: 'hi', timestamp: 2 });
    postAgentHandoffLine('z', 'z:live:2', 0, 'r2 a');
    postAgentHandoffLine('z', 'z:live:2', 1, 'r2 b');
    const contents = useAIPaneStore.getState().conversations[agentThreadKey('z')].messages.map((m) => m.content);
    expect(contents).toEqual(['r1 end', 'hi', 'r2 a', 'r2 b']);
  });
});
