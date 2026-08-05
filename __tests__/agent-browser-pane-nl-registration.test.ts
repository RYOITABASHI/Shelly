/**
 * __tests__/agent-browser-pane-nl-registration.test.ts — NL registration path
 * for the `browser-pane` agent action type (2026-08-05).
 *
 * Covers the three layers the wiring touches, plus the safety invariants the
 * task hangs on:
 *
 *   1. Tier 1 (lib/agent-nl-parser.ts): deterministic detection of
 *      "open URL X and click / extract text from CSS selector Y" phrasings,
 *      including the no-hijack regressions (webhook/draft utterances keep
 *      their existing resolution byte-identical).
 *   2. Tier 2 (lib/agent-slot-fill.ts): the browserUrl / browserSelector
 *      follow-up questions for a detected-but-incomplete intent, and the
 *      give-up path that downgrades to a safe local draft with a visible
 *      caveat instead of ever registering a half-filled browser action.
 *   3. Tier 3 (lib/agent-conversational-registration.ts): the LLM may declare
 *      actionType "browser-pane", but the URL and the selector are EACH
 *      accepted only when they appear verbatim in the user's own transcript
 *      (requireVerbatimSubstringMatch) — the anti-hallucination security
 *      tests live here.
 *   4. Confirm-gating (lib/agent-plan-summary.ts): browser-pane is
 *      chat-confirm eligible but NEVER auto-register eligible, so the human
 *      Confirm reply is mandatory on every registration path, and the confirm
 *      bubble spells out the exact selector + URL being approved.
 */

// Same mock shape as __tests__/agent-plan-summary.test.ts: lib/i18n imports
// expo-localization (ESM-only), which the plain ts-jest unit project cannot
// parse. key|params-JSON output keeps assertions locale-blind while still
// verifying the exact interpolated values.
jest.mock('@/lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  tFor: (_locale: string, key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
// lib/agent-conversational-registration statically imports lib/local-llm —
// mocked exactly like __tests__/agent-conversational-registration.test.ts
// (none of the pure functions under test here ever call it).
jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));

import {
  parseAgentNL,
  detectBrowserPaneIntent,
  detectAction,
  normalizeBrowserPaneUrl,
  extractBrowserTargetUrl,
  type ParsedAgentDraft,
} from '@/lib/agent-nl-parser';
import { nextMissingSlot, applySlotAnswer } from '@/lib/agent-slot-fill';
import {
  shouldUseChatConfirm,
  isAutoRegisterEligibleOnChatConfirm,
  hasDraftAssumptions,
  shouldAutoRegisterDraft,
  summarizeAgentDraftAsText,
  draftToConfirmedAgentDraft,
} from '@/lib/agent-plan-summary';
import {
  buildRegistrationSystemPrompt,
  parseConversationalTurnResponse,
  mergeConversationalExtractionIntoDraft,
} from '@/lib/agent-conversational-registration';
import ja from '@/lib/i18n/locales/ja';
import en from '@/lib/i18n/locales/en';

const FENCE_TAG = '```shelly-agent-registration';

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

// ─── Tier 1: deterministic NL → browser-pane draft ──────────────────────────

describe('Tier 1 — parseAgentNL browser-pane detection (JP)', () => {
  it('example.comを開いてh1のテキストを取得して → extractText h1 on https://example.com/', () => {
    const d = parseAgentNL('example.comを開いてh1のテキストを取得して');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'h1' });
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });

  it('full https URL + .class selector: https://example.com/news を開いて.headlineの内容を抽出して', () => {
    const d = parseAgentNL('https://example.com/news を開いて.headlineの内容を抽出して');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'extractText', selector: '.headline' });
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://example.com/news']);
  });

  it('このページのタイトルをブラウザから取ってきて → extractText title, URL still missing', () => {
    const d = parseAgentNL('このページのタイトルをブラウザから取ってきて');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'title' });
    expect(d.action.browserPaneUrlAllowlist).toEqual([]);
  });

  it('example.comというページのボタンをクリックして → click, URL resolved, selector still missing (never guessed from the word ボタン)', () => {
    const d = parseAgentNL('example.comというページのボタンをクリックして');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'click', selector: '' });
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });

  it('quoted selector for click: example.comを開いて「#submit」をクリックして', () => {
    const d = parseAgentNL('example.comを開いて「#submit」をクリックして');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'click', selector: '#submit' });
  });

  it('composes with a schedule: 毎日9時にexample.comを開いてh1のテキストを取得して', () => {
    const d = parseAgentNL('毎日9時にexample.comを開いてh1のテキストを取得して');
    expect(d.schedule).toBe('0 9 * * *');
    expect(d.scheduleConfident).toBe(true);
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });
});

describe('Tier 1 — parseAgentNL browser-pane detection (EN)', () => {
  it('open example.com and extract the text from h1', () => {
    const d = parseAgentNL('open example.com and extract the text from h1');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'h1' });
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });

  it("click '#buy-now' on https://shop.example.com/item", () => {
    const d = parseAgentNL("open https://shop.example.com/item and click '#buy-now'");
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'click', selector: '#buy-now' });
    expect(d.action.browserPaneUrlAllowlist).toEqual(['https://shop.example.com/item']);
  });

  it('get the page title from the browser → title selector, URL missing', () => {
    const d = parseAgentNL('get the page title from the browser');
    expect(d.action.type).toBe('browser-pane');
    expect(d.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'title' });
    expect(d.action.browserPaneUrlAllowlist).toEqual([]);
  });
});

describe('Tier 1 — no-hijack regressions (existing action resolution stays byte-identical)', () => {
  it('a URL with a POST verb and no page-operation verb stays webhook', () => {
    const d = parseAgentNL('毎日8時にhttps://example.com/hookにPOSTして');
    expect(d.action.type).toBe('webhook');
    expect(d.action.webhookUrl).toBe('https://example.com/hook');
  });

  it('an ordinary summarize agent stays draft', () => {
    expect(parseAgentNL('毎日8時にニュースをまとめて').action.type).toBe('draft');
  });

  it('内容を取得 with no browser/page cue at all stays draft (no URL, no ブラウザ/ページ word)', () => {
    expect(parseAgentNL('毎朝ニュースの内容を取得してまとめて').action.type).toBe('draft');
  });

  it('a dotted filename is not a domain: package.jsonを開いて内容を取得して stays non-browser', () => {
    const d = parseAgentNL('package.jsonを開いて内容を取得して');
    expect(d.action.type).not.toBe('browser-pane');
  });

  it('notify keeps winning for plain notification asks', () => {
    expect(parseAgentNL('毎日20時30分に通知して').action.type).toBe('notify');
  });
});

describe('Tier 1 — helpers', () => {
  it('normalizeBrowserPaneUrl defaults to https, and rejects non-http(s)/credentials/hash', () => {
    expect(normalizeBrowserPaneUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserPaneUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(normalizeBrowserPaneUrl('ftp://example.com')).toBeNull();
    expect(normalizeBrowserPaneUrl('https://user:pw@example.com/')).toBeNull();
    expect(normalizeBrowserPaneUrl('https://example.com/#frag')).toBeNull();
    expect(normalizeBrowserPaneUrl('')).toBeNull();
    expect(normalizeBrowserPaneUrl('not a url')).toBeNull();
  });

  it('extractBrowserTargetUrl accepts a bare-domain-only message (the slot-fill answer shape)', () => {
    expect(extractBrowserTargetUrl('example.com')).toBe('https://example.com/');
    expect(extractBrowserTargetUrl('https://example.com/news')).toBe('https://example.com/news');
    expect(extractBrowserTargetUrl('うーん、わからない')).toBeNull();
  });

  it('detectBrowserPaneIntent requires BOTH a page-operation verb and a browser cue', () => {
    expect(detectBrowserPaneIntent('h1のテキストを取得して')).toBeNull(); // verb, no cue
    expect(detectBrowserPaneIntent('example.comを開いて')).toBeNull(); // cue, no verb
    expect(detectBrowserPaneIntent('example.comを開いてh1のテキストを取得して')).toEqual({
      kind: 'extractText',
      url: 'https://example.com/',
      selector: 'h1',
    });
  });

  it('detectAction routes a browser-pane intent BEFORE the webhook URL branch', () => {
    const action = detectAction('https://example.com/newsを開いてh1のテキストを取得して');
    expect(action.type).toBe('browser-pane');
  });
});

// ─── Tier 2: slot-fill clarification for ambiguous input ────────────────────

describe('Tier 2 — browserUrl / browserSelector slot-fill', () => {
  const ctx = {}; // no vault/topic defaults configured

  it('asks for the URL first when a browser intent has no target page (JA question)', () => {
    const draft = parseAgentNL('このページのタイトルをブラウザから取ってきて');
    const slot = nextMissingSlot(draft, ctx);
    expect(slot).not.toBeNull();
    expect(slot!.field).toBe('browserUrl');
    expect(slot!.question).toBe(ja['slot_fill.question_browser_url']);
  });

  it('asks in English when the utterance was English', () => {
    const draft = parseAgentNL('get the page title from the browser');
    const slot = nextMissingSlot(draft, ctx);
    expect(slot!.field).toBe('browserUrl');
    expect(slot!.question).toBe(en['slot_fill.question_browser_url']);
  });

  it('asks for the selector once the URL is known', () => {
    const draft = parseAgentNL('example.comというページのボタンをクリックして');
    const slot = nextMissingSlot(draft, ctx);
    expect(slot!.field).toBe('browserSelector');
    expect(slot!.question).toBe(ja['slot_fill.question_browser_selector']);
  });

  it('asks nothing browser-related once both halves are present', () => {
    const draft = parseAgentNL('example.comを開いてh1のテキストを取得して');
    const slot = nextMissingSlot(draft, ctx);
    // The schedule slot may still be asked for other reasons; the point here
    // is that neither browser slot is.
    expect(slot?.field).not.toBe('browserUrl');
    expect(slot?.field).not.toBe('browserSelector');
  });

  it('applySlotAnswer(browserUrl) accepts a bare domain answer and normalizes it', () => {
    const draft = parseAgentNL('このページのタイトルをブラウザから取ってきて');
    const { draft: updated, resolved } = applySlotAnswer('browserUrl', draft, 'example.com', 0);
    expect(resolved).toBe(true);
    expect(updated.action.type).toBe('browser-pane');
    expect(updated.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });

  it('applySlotAnswer(browserUrl) re-asks once on an unusable answer, then downgrades to draft + caveat', () => {
    const draft = parseAgentNL('このページのタイトルをブラウザから取ってきて');
    const first = applySlotAnswer('browserUrl', draft, 'わからない', 0);
    expect(first.resolved).toBe(false);
    expect(first.draft.action.type).toBe('browser-pane'); // untouched, will re-ask

    const second = applySlotAnswer('browserUrl', draft, 'それでいいよ', 1);
    expect(second.resolved).toBe(true);
    expect(second.draft.action.type).toBe('draft');
    expect(second.draft.action.browserPaneAction).toBeUndefined();
    expect(second.draft.actionCaveat).toBe(ja['slot_fill.browser_pane_giveup_caveat']);
    // The caveat feeds hasDraftAssumptions, so even the downgraded draft can
    // never ride an auto-register fast path silently.
    expect(hasDraftAssumptions(second.draft)).toBe(true);
  });

  it('applySlotAnswer(browserSelector) takes the answer as the selector, stripping one quote layer', () => {
    const draft = parseAgentNL('example.comというページのボタンをクリックして');
    const { draft: updated, resolved } = applySlotAnswer('browserSelector', draft, '「#submit」', 0);
    expect(resolved).toBe(true);
    expect(updated.action.browserPaneAction).toEqual({ kind: 'click', selector: '#submit' });
    // URL from the original utterance is preserved.
    expect(updated.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });

  it('applySlotAnswer(browserSelector) gives up to draft + caveat after a second empty answer', () => {
    const draft = parseAgentNL('example.comというページのボタンをクリックして');
    const second = applySlotAnswer('browserSelector', draft, '   ', 1);
    expect(second.resolved).toBe(true);
    expect(second.draft.action.type).toBe('draft');
    expect(second.draft.actionCaveat).toBe(ja['slot_fill.browser_pane_giveup_caveat']);
  });

  it('treats a stale browser question as resolved when the action is no longer browser-pane', () => {
    const draft = baseDraft(); // action: draft
    const { resolved, draft: unchanged } = applySlotAnswer('browserUrl', draft, 'example.com', 0);
    expect(resolved).toBe(true);
    expect(unchanged.action.type).toBe('draft');
  });
});

// ─── Confirm gating: the human tap is never skipped ─────────────────────────

describe('Confirm gating — browser-pane never auto-registers', () => {
  const completeDraft = () => parseAgentNL('毎日9時にexample.comを開いてh1のテキストを取得して');

  it('routes through the chat-native confirm surface', () => {
    expect(shouldUseChatConfirm(completeDraft())).toBe(true);
  });

  it('is NOT eligible for the chat-confirm auto-register fast path (the widget no-confirm opt-in rides the same gate)', () => {
    expect(isAutoRegisterEligibleOnChatConfirm('browser-pane')).toBe(false);
  });

  it('even the card-path auto-register helper alone would not fire for an LLM-extracted browser draft', () => {
    const draft = { ...completeDraft(), llmExtracted: true };
    expect(shouldAutoRegisterDraft(draft, false)).toBe(false);
  });

  it('the confirm bubble spells out the EXACT selector and URL being approved', () => {
    const text = summarizeAgentDraftAsText(completeDraft());
    expect(text).toContain('agentplan.browserpane_line_extract');
    // The action line is nested inside the summary_action params, so the
    // mock's JSON-appended params appear escaped one level deep.
    expect(text).toContain('\\"selector\\":\\"h1\\"');
    expect(text).toContain('\\"url\\":\\"https://example.com/\\"');
  });

  it('a still-unfilled half renders an explicit (not set) marker, never a silent omission', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL('このページのタイトルをブラウザから取ってきて'));
    expect(text).toContain('agentplan.browserpane_line_extract');
    expect(text).toContain('agentplan.browserpane_unset_field');
  });

  it('draftToConfirmedAgentDraft passes the browser-pane action through verbatim', () => {
    const confirmed = draftToConfirmedAgentDraft(completeDraft());
    expect(confirmed.action.type).toBe('browser-pane');
    expect(confirmed.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'h1' });
    expect(confirmed.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
  });
});

// ─── Tier 3: LLM-led path — anti-hallucination security ─────────────────────

describe('Tier 3 — system prompt documents the browser-pane verbatim rule', () => {
  const ctx = { locale: 'ja' as const, deterministicHint: {}, connectors: [] };

  it('mentions browser-pane and the copy-verbatim requirement in JA', () => {
    const p = buildRegistrationSystemPrompt(ctx);
    expect(p).toContain('"browser-pane"');
    expect(p).toContain('browserUrl');
    expect(p).toContain('browserSelector');
    expect(p).toContain('一字一句そのままコピー');
  });

  it('mentions browser-pane and the copy-verbatim requirement in EN', () => {
    const p = buildRegistrationSystemPrompt({ ...ctx, locale: 'en' });
    expect(p).toContain('"browser-pane"');
    expect(p).toContain('browserUrl');
    expect(p).toContain('copied character for character');
  });

  it('keeps the Phase 0-3 draft/notify restriction line intact (additive, not substituted)', () => {
    const p = buildRegistrationSystemPrompt(ctx);
    expect(p).toContain('webhook, cli, social-post など');
  });
});

describe('Tier 3 — parseConversationalTurnResponse carries the browser fields through', () => {
  it('reads browserActionKind/browserUrl/browserSelector off a fenced proposal', () => {
    const turn = parseConversationalTurnResponse(
      `${FENCE_TAG}\n{"name":"ページ取得","actionType":"browser-pane","browserActionKind":"extractText","browserUrl":"example.com","browserSelector":"h1","prompt":"h1を取る"}\n\`\`\``,
    );
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') return;
    expect(turn.extraction.actionType).toBe('browser-pane');
    expect(turn.extraction.browserActionKind).toBe('extractText');
    expect(turn.extraction.browserUrl).toBe('example.com');
    expect(turn.extraction.browserSelector).toBe('h1');
  });
});

describe('Tier 3 — mergeConversationalExtractionIntoDraft browser-pane security gates', () => {
  // The user's ACTUAL words in the session — the only source a URL/selector
  // may be relayed from.
  const transcript = 'example.comを開いてh1のテキストを取得して\nはい、毎日9時で。';

  it('SECURITY: a URL the user never typed is rejected as hallucinated — the draft is returned untouched by reference', () => {
    const draft = baseDraft();
    const { draft: merged, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'https://evil.example/steal',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged).toBe(draft); // untouched, no llmExtracted, nothing applied
    expect(merged.action.type).toBe('draft');
  });

  it('SECURITY: a selector the user never typed is rejected even when the URL is genuine', () => {
    const draft = baseDraft();
    const { draft: merged, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'example.com',
        browserSelector: 'input[name="password"]',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toContain('browserSelector');
    expect(merged).toBe(draft);
  });

  it('SECURITY (adversarial): a URL merely INSPIRED by the transcript (user said the host, model appended a path) is rejected', () => {
    const draft = baseDraft();
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'https://example.com/admin/delete-account',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged).toBe(draft);
  });

  it('SECURITY: matching is case-sensitive — Example.com does not match example.com', () => {
    const draft = baseDraft();
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'Example.com',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged).toBe(draft);
  });

  it('SECURITY: an omitted transcript fails closed — nothing can ever match', () => {
    const draft = baseDraft();
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'example.com',
        browserSelector: 'h1',
      },
      { connectors: [] }, // no userTranscriptText at all
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged).toBe(draft);
  });

  it("SECURITY: 'fill' (and any unknown kind) is not NL-authorable — whole proposal dropped, no partial application", () => {
    const draft = baseDraft();
    for (const kind of ['fill', 'eval', 'submit', undefined]) {
      const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
        draft,
        {
          actionType: 'browser-pane',
          browserActionKind: kind,
          browserUrl: 'example.com',
          browserSelector: 'h1',
        },
        { connectors: [], userTranscriptText: transcript },
      );
      expect(rejectedFields).toContain('browserActionKind');
      expect(merged).toBe(draft);
    }
  });

  it('a bare actionType declaration with no payload is a silent no-op (conversation can continue), not a rejection', () => {
    const draft = baseDraft();
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      { actionType: 'browser-pane' },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toEqual([]);
    expect(merged).toBe(draft);
  });

  it('accepts the action when BOTH strings are verbatim from the transcript, normalizing the URL deterministically', () => {
    const draft = baseDraft();
    const { draft: merged, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'example.com',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toEqual([]);
    expect(merged).not.toBe(draft);
    expect(merged.action.type).toBe('browser-pane');
    expect(merged.action.browserPaneAction).toEqual({ kind: 'extractText', selector: 'h1' });
    expect(merged.action.browserPaneUrlAllowlist).toEqual(['https://example.com/']);
    // The LLM touched the draft → the mandatory human-confirm flag is stamped.
    expect(merged.llmExtracted).toBe(true);
    expect(hasDraftAssumptions(merged)).toBe(true);
    // And auto-register can never fire for it, even under no-confirm defaults.
    expect(shouldAutoRegisterDraft(merged, false)).toBe(false);
  });

  it('a verbatim string that is still not a valid http(s) URL is rejected (never a dead allowlist entry)', () => {
    const draft = baseDraft();
    const weirdTranscript = 'ftp://example.com のh1のテキストを取って';
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'ftp://example.com',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: weirdTranscript },
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged).toBe(draft);
  });

  it('never overwrites an action that already resolved to something richer than draft', () => {
    const draft = baseDraft({ action: { type: 'notify' } });
    const { rejectedFields, draft: merged } = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'example.com',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(rejectedFields).toContain('browserUrl');
    expect(merged.action.type).toBe('notify');
  });

  it('does not require the allowHighRiskActions opt-in (browser-pane is base-allowlisted; webhook stays gated)', () => {
    const draft = baseDraft();
    // browser-pane applies with NO flag...
    const bp = mergeConversationalExtractionIntoDraft(
      draft,
      {
        actionType: 'browser-pane',
        browserActionKind: 'extractText',
        browserUrl: 'example.com',
        browserSelector: 'h1',
      },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(bp.draft.action.type).toBe('browser-pane');
    // ...while webhook without the flag is still rejected outright, unchanged.
    const wh = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { actionType: 'webhook', webhookUrl: 'example.com' },
      { connectors: [], userTranscriptText: transcript },
    );
    expect(wh.rejectedFields).toContain('actionType');
    expect(wh.draft.action.type).toBe('draft');
  });
});
