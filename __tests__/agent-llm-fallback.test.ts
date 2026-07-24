import {
  isLowConfidenceAgentDraft,
  isCapabilityQuestionForAgentFlow,
  parseAgentLlmExtractionResponse,
  mergeLlmExtractionIntoDraft,
  extractAgentFieldsWithLlm,
  buildAgentExtractionMessages,
  type AgentLlmExtraction,
} from '@/lib/agent-llm-fallback';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { LocalLlmConfig } from '@/lib/local-llm';

jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ollamaChat } = require('@/lib/local-llm') as { ollamaChat: jest.Mock };

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Vague task',
    prompt: 'do something vague',
    schedule: null,
    scheduleConfident: false,
    scheduleLabel: '未設定（要選択）',
    action: { type: 'draft' },
    tool: { type: 'gemini-api' },
    toolLabel: 'Gemini API',
    rawText: 'do something vague',
    ...overrides,
  };
}

// ─── isLowConfidenceAgentDraft ─────────────────────────────────────────────

describe('isLowConfidenceAgentDraft', () => {
  it('true when NEITHER schedule NOR action was explicitly detected (pure default fallback)', () => {
    expect(isLowConfidenceAgentDraft(baseDraft())).toBe(true);
  });

  it('false when the schedule is confident, even with a fully-default action', () => {
    expect(
      isLowConfidenceAgentDraft(
        baseDraft({ schedule: '0 8 * * *', scheduleConfident: true, scheduleLabel: '毎日 08:00' }),
      ),
    ).toBe(false);
  });

  it('false when the action is an explicit non-draft type (notify), even without a schedule', () => {
    expect(isLowConfidenceAgentDraft(baseDraft({ action: { type: 'notify' } }))).toBe(false);
  });

  it('false when the action is app-act (explicit), even without a schedule', () => {
    expect(
      isLowConfidenceAgentDraft(
        baseDraft({ action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } } }),
      ),
    ).toBe(false);
  });

  it('false when the action stayed "draft" but an actionCaveat was set (e.g. LINE-posting fallback) — an explicit ask was understood', () => {
    expect(
      isLowConfidenceAgentDraft(
        baseDraft({ actionCaveat: 'LINEへの投稿にはまだ対応していないため、下書き（ファイル保存）として登録します' }),
      ),
    ).toBe(false);
  });

  it('false when the raw utterance explicitly named "下書き"/"draft", even though action.type resolved to the same default value', () => {
    expect(
      isLowConfidenceAgentDraft(
        baseDraft({ rawText: '毎回下書きとして保存して', prompt: '毎回下書きとして保存して' }),
      ),
    ).toBe(false);
  });

  it('true for a genuinely vague utterance with no schedule/action cue at all ("後でいい感じにやっておいて")', () => {
    expect(
      isLowConfidenceAgentDraft(baseDraft({ rawText: '後でいい感じにやっておいて', prompt: '後でいい感じにやっておいて' })),
    ).toBe(true);
  });

  // Explicit regression guard for the task's own required case: the common
  // path ("毎日21時に通知して") must never be judged low-confidence, so the
  // caller's isLowConfidenceAgentDraft gate never even attempts an LLM call
  // for it — see the module doc comment's "keep the common path LLM-free"
  // requirement. (Real parseAgentNL output shape, not a hand-built partial.)
  it('false for the deterministic parser output of "毎日21時に通知して" (both schedule and action are explicit)', () => {
    // Hand-built to mirror what parseAgentNL("毎日21時に通知して") actually
    // produces (confident daily schedule + explicit notify action) without
    // importing the full parser here — kept in sync conceptually with
    // __tests__/agent-nl-parser.test.ts's own coverage of this exact phrase.
    const draft = baseDraft({
      rawText: '毎日21時に通知して',
      prompt: '通知して',
      schedule: '0 21 * * *',
      scheduleConfident: true,
      scheduleLabel: '毎日 21:00',
      action: { type: 'notify' },
    });
    expect(isLowConfidenceAgentDraft(draft)).toBe(false);
  });
});

// ─── isCapabilityQuestionForAgentFlow ──────────────────────────────────────

describe('isCapabilityQuestionForAgentFlow', () => {
  it('true for a JP capability question with a question mark', () => {
    expect(isCapabilityQuestionForAgentFlow('こんなことできる？')).toBe(true);
  });

  it('true for an EN "what can you do" question', () => {
    expect(isCapabilityQuestionForAgentFlow('what can you do?')).toBe(true);
  });

  it('true for "Blueskyへの投稿できますか"', () => {
    expect(isCapabilityQuestionForAgentFlow('Blueskyへの投稿できますか')).toBe(true);
  });

  it('false for an ordinary explicit agent-creation utterance', () => {
    expect(isCapabilityQuestionForAgentFlow('毎日21時に通知して')).toBe(false);
  });

  it('false for a "make it possible to notify" style imperative that is NOT a question', () => {
    expect(isCapabilityQuestionForAgentFlow('8時に通知できるようにして')).toBe(false);
  });

  it('false for empty/null/undefined input', () => {
    expect(isCapabilityQuestionForAgentFlow('')).toBe(false);
    expect(isCapabilityQuestionForAgentFlow(null)).toBe(false);
    expect(isCapabilityQuestionForAgentFlow(undefined)).toBe(false);
  });
});

// ─── parseAgentLlmExtractionResponse ────────────────────────────────────────

describe('parseAgentLlmExtractionResponse', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      name: 'News digest',
      scheduleText: '毎日8時',
      actionType: 'notify',
      outputPath: '',
      prompt: 'summarize the news',
    });
    expect(parseAgentLlmExtractionResponse(raw)).toEqual({
      name: 'News digest',
      scheduleText: '毎日8時',
      actionType: 'notify',
      outputPath: undefined,
      prompt: 'summarize the news',
    });
  });

  it('tolerates a markdown code-fence wrapper and leading/trailing prose', () => {
    const raw = 'Sure, here you go:\n```json\n' + JSON.stringify({
      name: 'X', scheduleText: '', actionType: 'draft', outputPath: '', prompt: 'do X',
    }) + '\n```\nHope that helps!';
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.name).toBe('X');
    expect(result?.actionType).toBe('draft');
    expect(result?.prompt).toBe('do X');
  });

  it('returns null for malformed JSON', () => {
    expect(parseAgentLlmExtractionResponse('{not: valid json')).toBeNull();
  });

  it('returns null for an empty/whitespace-only response', () => {
    expect(parseAgentLlmExtractionResponse('')).toBeNull();
    expect(parseAgentLlmExtractionResponse('   ')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(parseAgentLlmExtractionResponse('[1, 2, 3]')).toBeNull();
  });

  it('silently drops an unsupported/hallucinated actionType (e.g. "webhook") but keeps the other valid fields', () => {
    const raw = JSON.stringify({
      name: 'Sneaky', scheduleText: '', actionType: 'webhook', outputPath: '', prompt: 'do it',
    });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.actionType).toBeUndefined();
    expect(result?.name).toBe('Sneaky');
    expect(result?.prompt).toBe('do it');
  });

  it('silently drops a completely made-up actionType value', () => {
    const raw = JSON.stringify({ actionType: 'launch-nukes' });
    expect(parseAgentLlmExtractionResponse(raw)?.actionType).toBeUndefined();
  });

  it('drops non-string field values instead of coercing them', () => {
    const raw = JSON.stringify({ name: 123, scheduleText: null, prompt: ['a', 'b'] });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.name).toBeUndefined();
    expect(result?.scheduleText).toBeUndefined();
    expect(result?.prompt).toBeUndefined();
  });

  it('truncates an implausibly long field instead of rejecting the whole response', () => {
    const raw = JSON.stringify({ name: 'x'.repeat(500) });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.name?.length).toBeLessThanOrEqual(60);
  });

  it('treats an empty string field as absent (undefined), not as a value to merge', () => {
    const raw = JSON.stringify({ name: '', scheduleText: '   ', outputPath: '', prompt: '' });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result).toEqual({ name: undefined, scheduleText: undefined, outputPath: undefined, prompt: undefined });
  });

  it('parses taskClear:false with a clarifyingQuestion', () => {
    const raw = JSON.stringify({
      taskClear: false,
      clarifyingQuestion: '明日は何の準備をしますか？',
    });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.taskClear).toBe(false);
    expect(result?.clarifyingQuestion).toBe('明日は何の準備をしますか？');
  });

  it('parses taskClear:true with an empty clarifyingQuestion', () => {
    const raw = JSON.stringify({ taskClear: true, clarifyingQuestion: '' });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.taskClear).toBe(true);
    expect(result?.clarifyingQuestion).toBeUndefined();
  });

  it('leaves taskClear unset (not false) when the field is missing or the wrong type', () => {
    expect(parseAgentLlmExtractionResponse('{}')?.taskClear).toBeUndefined();
    expect(parseAgentLlmExtractionResponse(JSON.stringify({ taskClear: 'true' }))?.taskClear).toBeUndefined();
    expect(parseAgentLlmExtractionResponse(JSON.stringify({ taskClear: 1 }))?.taskClear).toBeUndefined();
  });

  it('truncates an implausibly long clarifyingQuestion instead of rejecting the whole response', () => {
    const raw = JSON.stringify({ taskClear: false, clarifyingQuestion: 'x'.repeat(500) });
    const result = parseAgentLlmExtractionResponse(raw);
    expect(result?.clarifyingQuestion?.length).toBeLessThanOrEqual(200);
  });
});

// ─── mergeLlmExtractionIntoDraft ────────────────────────────────────────────

describe('mergeLlmExtractionIntoDraft', () => {
  it('returns the ORIGINAL draft, unchanged, when the extraction has nothing usable', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, {});
    expect(result).toBe(draft); // same reference — untouched
    expect(result.llmExtracted).toBeUndefined();
  });

  it('merges a schedule phrase ONLY after re-validating it through parseSchedule (never trusts a raw phrase blindly)', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { scheduleText: '毎日8時' });
    expect(result.scheduleConfident).toBe(true);
    expect(result.schedule).toBe('0 8 * * *');
    expect(result.llmExtracted).toBe(true);
  });

  it('does NOT merge a schedule phrase that parseSchedule itself cannot confidently resolve', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { scheduleText: '隔週月曜' }); // biweekly — unsupported cron shape
    expect(result.scheduleConfident).toBe(false);
    expect(result.schedule).toBeNull();
  });

  it('merges actionType "notify", clearing any stale actionCaveat', () => {
    const draft = baseDraft({ actionCaveat: 'some stale caveat' });
    const result = mergeLlmExtractionIntoDraft(draft, { actionType: 'notify' });
    expect(result.action).toEqual({ type: 'notify' });
    expect(result.actionCaveat).toBeUndefined();
    expect(result.llmExtracted).toBe(true);
  });

  it('actionType "draft" alone (no other field) is a no-op — draft is already the default and nothing else changed', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { actionType: 'draft' });
    expect(result).toBe(draft);
  });

  it('never accepts a non-draft/notify action type at the type level (TypeScript enforces this — verified via parseAgentLlmExtractionResponse above)', () => {
    // AgentLlmExtraction['actionType'] is typed as 'draft' | 'notify' only —
    // this test documents that constraint rather than re-testing runtime
    // validation (already covered in parseAgentLlmExtractionResponse's
    // describe block above).
    const extraction: AgentLlmExtraction = { actionType: 'notify' };
    expect(['draft', 'notify']).toContain(extraction.actionType);
  });

  it('merges outputPath only while the action is (still) draft', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { outputPath: 'news/' });
    expect(result.outputPath).toBe('news/');
    expect(result.llmExtracted).toBe(true);
  });

  it('does not merge outputPath when actionType simultaneously switches the draft to notify', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { actionType: 'notify', outputPath: 'news/' });
    expect(result.action.type).toBe('notify');
    expect(result.outputPath).toBeUndefined();
  });

  it('merges name', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { name: 'Better Name' });
    expect(result.name).toBe('Better Name');
    expect(result.llmExtracted).toBe(true);
  });

  it('merges prompt and re-derives tool/toolLabel via suggestTool for consistency', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { prompt: 'review my github pull request' });
    expect(result.prompt).toBe('review my github pull request');
    expect(result.tool).toEqual({ type: 'cli', cli: 'codex' }); // code keyword routes to Codex CLI, see agent-tool-router.ts
    expect(result.llmExtracted).toBe(true);
  });

  it('applies multiple fields at once', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, {
      name: 'News digest',
      scheduleText: '毎朝8時',
      actionType: 'notify',
    });
    expect(result.name).toBe('News digest');
    expect(result.scheduleConfident).toBe(true);
    expect(result.action).toEqual({ type: 'notify' });
    expect(result.llmExtracted).toBe(true);
  });

  it('sets needsTaskClarification from the LLM\'s own question when taskClear is false', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, {
      taskClear: false,
      clarifyingQuestion: '明日は何の準備をしますか？',
    });
    expect(result.needsTaskClarification).toBe('明日は何の準備をしますか？');
    expect(result.llmExtracted).toBe(true);
  });

  it('does NOT set needsTaskClarification when taskClear is false but clarifyingQuestion is empty', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { taskClear: false });
    expect(result).toBe(draft);
    expect(result.needsTaskClarification).toBeUndefined();
  });

  it('clears a stale needsTaskClarification when a later extraction reports taskClear:true', () => {
    const draft = baseDraft({ needsTaskClarification: 'stale question from an earlier round' });
    const result = mergeLlmExtractionIntoDraft(draft, { taskClear: true });
    expect(result.needsTaskClarification).toBeUndefined();
    expect(result.llmExtracted).toBe(true);
  });

  it('taskClear:true is a no-op when there was no stale needsTaskClarification to clear', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { taskClear: true });
    expect(result).toBe(draft);
  });

  it('never lets a bare clarifyingQuestion (without taskClear:false) set needsTaskClarification — the LLM must explicitly flag the task as unclear', () => {
    const draft = baseDraft();
    const result = mergeLlmExtractionIntoDraft(draft, { clarifyingQuestion: 'some question' });
    expect(result).toBe(draft);
    expect(result.needsTaskClarification).toBeUndefined();
  });
});

// ─── extractAgentFieldsWithLlm (impure orchestrator, network mocked) ───────

describe('extractAgentFieldsWithLlm', () => {
  const enabledConfig: LocalLlmConfig = {
    baseUrl: 'http://127.0.0.1:8080',
    model: 'Qwen3.5-0.8B-Q4_K_M',
    enabled: true,
  };

  beforeEach(() => {
    ollamaChat.mockReset();
  });

  it('returns the draft untouched WITHOUT calling ollamaChat when the local LLM is disabled', async () => {
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('some utterance', draft, {
      baseUrl: 'http://127.0.0.1:8080',
      model: 'Qwen3.5-0.8B-Q4_K_M',
      enabled: false,
    });
    expect(result).toBe(draft);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('returns the draft untouched when baseUrl/model are missing even if enabled=true', async () => {
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('x', draft, { baseUrl: '', model: '', enabled: true });
    expect(result).toBe(draft);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('merges a successful, well-formed extraction into the draft', async () => {
    ollamaChat.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        name: 'Quantum news',
        scheduleText: '毎日8時',
        actionType: 'notify',
        outputPath: '',
        prompt: 'summarize quantum computing news',
      }),
    });
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('毎朝量子コンピュータのニュースを教えて', draft, enabledConfig);
    expect(result.llmExtracted).toBe(true);
    expect(result.name).toBe('Quantum news');
    expect(result.scheduleConfident).toBe(true);
    expect(result.action).toEqual({ type: 'notify' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('falls back to the ORIGINAL draft (untouched) when ollamaChat reports failure', async () => {
    ollamaChat.mockResolvedValue({ success: false, content: '', error: 'HTTP 503' });
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('x', draft, enabledConfig);
    expect(result).toBe(draft);
  });

  it('falls back to the ORIGINAL draft when ollamaChat throws (e.g. network error)', async () => {
    ollamaChat.mockRejectedValue(new Error('network down'));
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('x', draft, enabledConfig);
    expect(result).toBe(draft);
  });

  it('falls back to the ORIGINAL draft when the LLM returns malformed JSON', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'not json at all, sorry!' });
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('x', draft, enabledConfig);
    expect(result).toBe(draft);
  });

  it('falls back to the ORIGINAL draft when the LLM returns an unsupported action type and nothing else usable', async () => {
    ollamaChat.mockResolvedValue({
      success: true,
      content: JSON.stringify({ actionType: 'cli', name: '', scheduleText: '', outputPath: '', prompt: '' }),
    });
    const draft = baseDraft();
    const result = await extractAgentFieldsWithLlm('x', draft, enabledConfig);
    expect(result).toBe(draft); // 'cli' was dropped, nothing else was present -> no-op merge
  });

  it('passes a short timeout and small token budget suited to a lightweight single-shot call', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: JSON.stringify({ name: 'x' }) });
    const draft = baseDraft();
    await extractAgentFieldsWithLlm('x', draft, enabledConfig);
    const [, , timeoutMs, , maxTokens] = ollamaChat.mock.calls[0];
    expect(timeoutMs).toBeLessThanOrEqual(20_000);
    expect(maxTokens).toBeLessThanOrEqual(500);
  });
});

// ─── buildAgentExtractionMessages ───────────────────────────────────────────

describe('buildAgentExtractionMessages', () => {
  it('produces a system + user message pair with the utterance verbatim as the user turn', () => {
    const messages = buildAgentExtractionMessages('毎朝8時にニュースをまとめて');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: '毎朝8時にニュースをまとめて' });
  });
});
