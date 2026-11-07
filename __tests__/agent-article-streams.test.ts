jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { normalizeSteps, REVIEW_OUTPUT_CONTRACT } from '@/lib/agent-orchestration';
import { ARTICLE_MATERIAL_MISSING_MARKER, buildArticleDigestPipeline, buildArticlePipeline, type ArticleStream, type PipelinePreset } from '@/lib/agent-pipeline-presets';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { draftToConfirmedAgentDraft, isAutoRegisterEligibleDraft, shouldUseChatConfirm, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { nextMissingSlot } from '@/lib/agent-slot-fill';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

// Article pipeline Inc 2-4: the five streams and the digest as data, their NL
// triggers and the plans they produce, plus the Dev JA queue seed.

const root = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(path.join(root, 'scripts', 'shelly-plan-executor.js'));

const ALL: ArticleStream[] = ['ai-steam', 'dev-ja', 'dev-en', 'vintage-ja', 'vintage-en'];
const QUEUED: ArticleStream[] = ['dev-ja', 'dev-en', 'vintage-ja', 'vintage-en'];
const VINTAGE: ArticleStream[] = ['vintage-ja', 'vintage-en'];
const ENGLISH: ArticleStream[] = ['dev-en', 'vintage-en'];

// Steps before research: queue-pop, and queue-refill before that on vintage.
const leadOf = (stream: ArticleStream) => (QUEUED.includes(stream) ? 1 : 0) + (VINTAGE.includes(stream) ? 1 : 0);
const stepsOf = (stream: ArticleStream) => buildArticlePipeline(stream).orchestration.steps as AgentOrchestrationStep[];
const assembleOf = (stream: ArticleStream): any => stepsOf(stream)[stepsOf(stream).length - 1].local;
const minutes = (cron: string) => {
  const [m, h] = cron.split(' ').map(Number);
  return h * 60 + m;
};

function agentFrom(preset: PipelinePreset): Agent {
  return {
    id: 'agent-article',
    name: preset.name,
    description: '',
    prompt: preset.prompt,
    schedule: preset.schedule,
    tool: preset.tool!,
    outputPath: preset.output!.outputPath,
    outputTemplate: preset.output!.outputTemplate,
    action: preset.action,
    orchestration: preset.orchestration,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
  };
}

describe.each(ALL)('stream %s', (stream) => {
  const preset = buildArticlePipeline(stream);
  const steps = stepsOf(stream);
  const offset = leadOf(stream);

  it('has the review loop, shifted past queue-pop on a queued stream', () => {
    expect(steps).toHaveLength(7 + offset);
    if (offset) expect(steps[offset - 1].local).toEqual({ kind: 'queue-pop' });
    if (offset === 2) expect(steps[0].local).toEqual({ kind: 'queue-refill' });
    const at = (k: number) => k + offset;
    expect(steps.map((s) => s.handoff?.of).slice(offset)).toEqual([undefined, undefined, [at(0), at(1)], [at(1), at(2)], [at(0), at(3)], [at(3), at(4)], undefined]);
    expect(assembleOf(stream).parts).toEqual([[at(1), at(3), at(5)]]);
  });

  it('every hand-off and part points before its own step', () => {
    steps.forEach((s, i) => (s.handoff?.of ?? []).forEach((k) => expect(k).toBeLessThan(i)));
    assembleOf(stream).parts.flat().forEach((k: number) => expect(k).toBeLessThan(steps.length - 1));
  });

  it('writer and reviewer are on different engines, all HTTP', () => {
    const write = steps[1 + offset];
    expect(steps[2 + offset].tool?.type).not.toBe(write.tool?.type);
    expect(steps[4 + offset].tool?.type).not.toBe(write.tool?.type);
    expect(steps[3 + offset].tool?.type).toBe(write.tool?.type);
    expect(steps[5 + offset].tool?.type).toBe(write.tool?.type);
    steps.filter((s) => !s.local).forEach((s, i) => {
      // Perplexity is for academic research only (owner decision 2026-11-06).
      const allowed = i === 0 && stream === 'ai-steam' ? ['perplexity'] : ['gemini-api', 'cerebras', 'groq'];
      expect(allowed).toContain(s.tool?.type);
      expect(s.toolPinned).toBe(true);
    });
  });

  it('survives normalization with the review contract whole', () => {
    steps.forEach((s) => expect(s.instruction.length).toBeLessThanOrEqual(500));
    const normalized = normalizeSteps(preset.orchestration);
    expect(normalized).toHaveLength(steps.length);
    expect(normalized[2 + offset].instruction.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true);
    expect(normalized[2 + offset].handoff).toEqual(steps[2 + offset].handoff);
    expect(normalized[normalized.length - 1].local).toEqual(assembleOf(stream));
    if (offset) expect(normalized[offset - 1].local).toEqual({ kind: 'queue-pop' });
    if (offset === 2) expect(normalized[0].local).toEqual({ kind: 'queue-refill' });
  });

  it('has no publish path and no shell', () => {
    expect(preset.action).toEqual({ type: 'draft' });
    expect(preset.autonomous).toBe(false);
    expect(preset.memoryOff).toBe(true);
    steps.forEach((s) => {
      expect(s.apiCall).toBeUndefined();
      expect(s.tool?.type).not.toBe('cli');
    });
    expect(JSON.stringify(preset)).not.toMatch(/social-post|webhook|publish|ghost|twitter|closepaw|\bbash\b/i);
  });

  it('saves under its own folder in the vault, with the stream in the file name', () => {
    expect(preset.output?.outputPath).toMatch(/^\/sdcard\/Documents\/ObsidianVault\/50_Drafts\/[A-Za-z]+\/$/);
    expect(preset.output?.outputTemplate).toBe(`{date}-${stream}.md`);
  });

  it('keeps the base prompt neutral', () => {
    expect(detectRouteSignals(preset.prompt).needsWeb).toBe(false);
  });

  it('only its research step is web research', () => {
    const flags = steps.map((s, i) =>
      i !== steps.length - 1 && s.local === undefined && s.handoff === undefined && executor.isResearchStep(s.instruction, s.tool?.type));
    expect(flags.indexOf(true)).toBe(offset);
    expect(flags.filter(Boolean)).toHaveLength(1);
  });

  it('the writer leaves the marker where the owner\'s material goes, and the reviser keeps it', () => {
    expect(steps[1 + offset].instruction).toContain(ARTICLE_MATERIAL_MISSING_MARKER);
    expect(steps[3 + offset].instruction).toContain(ARTICLE_MATERIAL_MISSING_MARKER);
  });

  it('the review text cannot read as a missing-data answer', () => {
    const line = steps[2 + offset].instruction.split('\n')[0];
    expect(executor.isLowQualityCompletion(`VERDICT: PASS\n${line}`)).toBe(false);
  });

  it('flags the claims ledger terms and the name forms', () => {
    const local = assembleOf(stream);
    expect(local.lintTerms).toContain('世界初');
    expect(local.lintTerms).toContain('built entirely on a phone');
    expect(local.nameLint.canonical).toBe('RYO ITABASHI');
  });

  it('passes the executor\'s own validation', () => {
    expect(executor.normalizeStepLocal(assembleOf(stream), steps.length - 1)).toEqual(assembleOf(stream));
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(preset))));
    expect(plan.steps.longform).toBe(true);
    expect(plan.steps.list).toHaveLength(steps.length);
    expect(plan.steps.budget.maxSteps).toBe(steps.length);
    expect(plan.steps.isolation).toBeUndefined();
    expect(plan.output.useGlobalOutput).toBe(false);
    expect(plan.action.type).toBe('draft');
    expect(plan.toolLadder.map((t: { type: string }) => t.type)).not.toContain('perplexity');
    expect(() => executor.validatePlan(plan)).not.toThrow();
  });
});

describe('research depth and draft flags', () => {
  it.each(ALL)('%s asks for one topic, 3 sources and 4000-6000 characters of concrete notes', (stream) => {
    const offset = leadOf(stream);
    const research = stepsOf(stream)[offset].instruction;
    expect(research.length).toBeLessThanOrEqual(500);
    if (ENGLISH.includes(stream)) {
      expect(research).toMatch(/one topic/);
      expect(research).toMatch(/at least 3 separate sources/);
      expect(research).toMatch(/4000 to 6000 characters/);
      expect(research).toMatch(/concrete numbers, conclusions and limits/);
    } else {
      expect(research).toMatch(/ひとつ/);
      expect(research).toContain('別々の資料を3件以上');
      expect(research).toContain('4000〜6000字');
      expect(research).toContain('具体的な数値・結論・限界');
    }
  });

  it.each(ALL)('%s tells the writer and the reviser not to talk about their own work', (stream) => {
    const offset = leadOf(stream);
    const steps = stepsOf(stream);
    for (const i of [1 + offset, 3 + offset, 5 + offset]) {
      expect(steps[i].instruction.length).toBeLessThanOrEqual(500);
      expect(steps[i].instruction).toMatch(ENGLISH.includes(stream) ? /Never mention these rules, the search or the notes/ : /この指示・検索・調査メモのことは本文に書かない/);
      expect(steps[i].instruction).toMatch(ENGLISH.includes(stream) ? /if they say a figure is not public, say so/ : /資料が非公開と述べる数値だけ、文章でそう書く/);
    }
  });

  it.each(ALL)('%s has the reviewer check each citation number, and keeps the review contract whole', (stream) => {
    const offset = leadOf(stream);
    const raw = stepsOf(stream)[2 + offset].instruction;
    expect(raw.length).toBeLessThanOrEqual(500);
    expect(raw).toMatch(ENGLISH.includes(stream) ? /any \[n\] not pointing to the source/ : /各 \[n\] がその主張を実際に載せている資料/);
    expect(raw).toMatch(ENGLISH.includes(stream) ? /journal index page/ : /雑誌の目次ページ/);
    const normalized = normalizeSteps(buildArticlePipeline(stream).orchestration);
    expect(normalized[2 + offset].instruction.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true);
  });

  it.each(ALL)('%s prefers article pages over journal index pages in its research', (stream) => {
    const offset = leadOf(stream);
    expect(stepsOf(stream)[offset].instruction).toMatch(ENGLISH.includes(stream) ? /article pages over journal index pages/ : /雑誌の目次ページより/);
  });

  it('the AI×STEAM writer may not generalise from one case or close on a stock line', () => {
    const write = stepsOf('ai-steam')[1].instruction;
    expect(write).toContain('一つの事例から一般化しない');
    expect(write).toContain('「実証した」と書かない');
    expect(write).toContain('定型の結びは書かない');
  });

  it.each<[ArticleStream, object]>([
    ['ai-steam', { minChars: 2500, minSources: 2, selfTalk: true }],
    ['dev-ja', { minChars: 2500, minSources: 2, selfTalk: true }],
    ['vintage-ja', { minChars: 2500, minSources: 2, selfTalk: true }],
    ['dev-en', { minWords: 1000, minSources: 2, selfTalk: true }],
    ['vintage-en', { minWords: 600, minSources: 2, selfTalk: true }],
  ])('%s sets its minimums', (stream, quality) => {
    expect(assembleOf(stream).quality).toEqual(quality);
  });

  it('the digest shows a flag, so the owner sees it', () => {
    const item = { folder: 'Steam', path: 'a', title: '題', review: 'pass', reviewNote: '', material: 'ok', lint: ['sources: 1 or fewer', 'Sources に転送リンク（公開前に差し替え）'], savedAtMs: 0 };
    const text = executor.renderDraftDigest({ kind: 'list-drafts', streams: [{ folder: 'Steam', label: 'S' }] }, { items: [item], missing: [], truncated: false }, '2026-11-06');
    expect(text).toContain('sources: 1 or fewer');
    expect(text).toContain('転送リンク');
    expect(text).toContain('題【要確認】');
  });
});

describe('the stream set', () => {
  it('runs on crons 20 minutes apart, in order, each in its own folder', () => {
    const times = ALL.map((s) => minutes(buildArticlePipeline(s).schedule!));
    times.slice(1).forEach((t, i) => expect(t - times[i]).toBe(20));
    const folders = ALL.map((s) => buildArticlePipeline(s).output!.outputPath);
    expect(new Set(folders).size).toBe(ALL.length);
  });

  it('REGRESSION: the AI×STEAM stream keeps its chain', () => {
    const steps = stepsOf('ai-steam');
    expect(steps).toHaveLength(7);
    expect(assembleOf('ai-steam').parts).toEqual([[1, 3, 5]]);
    expect(assembleOf('ai-steam').lintSources).toBeUndefined();
    expect(buildArticlePipeline('ai-steam').output?.outputPath).toBe('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/');
    expect(executor.detectRecency([buildArticlePipeline('ai-steam').prompt, ...steps.map((s) => s.instruction)].join('\n'))).toBe('month');
  });

  it.each(QUEUED)('%s puts no recency limit on its research', (stream) => {
    const text = [buildArticlePipeline(stream).prompt, ...stepsOf(stream).map((s) => s.instruction)].join('\n');
    expect(executor.detectRecency(text)).toBeUndefined();
  });

  it('English streams use English instructions and an AI-use footer', () => {
    ENGLISH.forEach((stream) => {
      const steps = stepsOf(stream);
      const first = leadOf(stream);
      expect(steps[first].instruction).toMatch(/^Search the web/);
      expect(steps[first + 2].instruction).toContain('Output contract');
      expect(steps[first + 3].instruction).toMatch(/^Apply every finding/);
      expect(assembleOf(stream).footer).toContain('AI disclosure');
      expect(buildArticlePipeline(stream).prompt).toContain('not a translation');
    });
  });

  it('Dev EN forbids promotion and states the ledger\'s position line', () => {
    const { prompt } = buildArticlePipeline('dev-en');
    expect(prompt).toContain('No promotion in the body');
    expect(prompt).toContain('I don\'t write the code. I direct the AI — and nothing is called done until it works on real hardware.');
  });

  it('Dev JA follows the ledger', () => {
    const { prompt } = buildArticlePipeline('dev-ja');
    expect(prompt).toContain('コードは書かない。AI を率いて、実機で動くまで完了と呼ばない。');
    expect(prompt).toContain('取得日と対象ブランチ');
    expect(prompt).toContain('RYO ITABASHI');
  });
});

describe('vintage', () => {
  it.each(VINTAGE)('%s finds its own topics, under the stream\'s rules, in the queue format', (stream) => {
    const topic = stepsOf(stream)[0];
    expect(topic.local).toEqual({ kind: 'queue-refill' });
    expect(topic.instruction.length).toBeLessThanOrEqual(500);
    expect(topic.instruction).toContain('- [ ] ');
    expect(topic.instruction).toMatch(/本物か偽物かを書かない|authentic or fake/);
    expect(topic.instruction).toMatch(/出品へのリンク、URL、画像は書かない|No listing links, no URLs, no images/);
    // Its text is its prompt: a fix to the limit would otherwise cut the format.
    expect(normalizeSteps(buildArticlePipeline(stream).orchestration)[0].instruction).toBe(topic.instruction);
  });

  it.each(VINTAGE)('%s carries the disclaimer, lints images and listings, and marks no X intent', (stream) => {
    const local = assembleOf(stream);
    expect(local.footer).toMatch(/鑑定ではありません|not an appraisal/);
    expect(local.lintSources).toBe(true);
    for (const term of ['![', '<img', 'mercari', 'merc.li']) expect(local.lintTerms).toContain(term);
    const digest = buildArticleDigestPipeline().orchestration.steps[0] as AgentOrchestrationStep;
    const { streams } = digest.local as { streams: Array<{ folder: string; intent?: boolean }> };
    const folder = buildArticlePipeline(stream).output!.outputPath.split('/').filter(Boolean).pop();
    expect(streams.find((s) => s.folder === folder)?.intent).toBeUndefined();
  });

  it('the JA footer has the exact words, the EN one too', () => {
    expect(assembleOf('vintage-ja').footer).toContain('鑑定ではありません');
    expect(assembleOf('vintage-en').footer).toContain('not an appraisal');
  });

  it('the lint set does what it says on a real draft', () => {
    const body = '# 題\n\n![柄](https://x.example/a.png)\n\nhttps://jp.mercari.com/item/m1 は本物です。\n';
    const local = { ...assembleOf('vintage-ja'), parts: [[0]] };
    const out = executor.assembleArticle(local, { steps: [{}, {}], results: [body], skipped: [], sources: [], today: '2026-11-06', fallbackTitle: 'F' });
    const lint = JSON.parse(/^lint: (.*)$/m.exec(out)![1]);
    expect(lint).toEqual(expect.arrayContaining(['![', 'mercari', '本物です']));
  });

  it('asks for no listing links, no images and no verdict on authenticity', () => {
    expect(buildArticlePipeline('vintage-ja').prompt).toContain('真贋を断定しない');
    expect(buildArticlePipeline('vintage-ja').prompt).toContain('出品へのリンクを貼らない');
    expect(buildArticlePipeline('vintage-en').prompt).toContain('Never say an item is authentic or fake');
    expect(buildArticlePipeline('vintage-en').prompt).toContain('No links to listings');
  });

  it('does not reach a listing tool: no attended Mercari step exists in the chain', () => {
    VINTAGE.forEach((stream) => expect(stepsOf(stream).some((s) => s.tool?.type === 'cli')).toBe(false));
  });
});

describe('the digest preset', () => {
  const preset = buildArticleDigestPipeline();
  const steps = preset.orchestration.steps as AgentOrchestrationStep[];

  it('is [list-drafts, assemble] with no model step', () => {
    expect(steps.map((s) => s.local?.kind)).toEqual(['list-drafts', 'assemble']);
    expect(steps.every((s) => s.tool === undefined)).toBe(true);
    expect(steps[1].local).toMatchObject({ plain: true, parts: [[0]] });
  });

  it('expects every stream, with intent on all but vintage', () => {
    const { streams } = steps[0].local as { streams: Array<{ folder: string; intent?: boolean }> };
    const folders = ALL.map((s) => buildArticlePipeline(s).output!.outputPath.split('/').filter(Boolean).pop());
    expect(streams.map((s) => s.folder)).toEqual(folders);
    expect(streams.map((s) => s.intent === true)).toEqual([true, true, true, false, false]);
  });

  it('runs after the last stream has had its full 30-minute budget', () => {
    expect(minutes(preset.schedule!)).toBeGreaterThanOrEqual(minutes(buildArticlePipeline('vintage-en').schedule!) + 30);
  });

  it('saves to 50_Drafts/Digest/{date}-digest.md, publishing nothing', () => {
    expect(preset.output?.outputPath).toBe('/sdcard/Documents/ObsidianVault/50_Drafts/Digest/');
    expect(preset.output?.outputTemplate).toBe('{date}-digest.md');
    expect(preset.action).toEqual({ type: 'draft' });
    expect(preset.autonomous).toBe(false);
    expect(JSON.stringify(preset)).not.toMatch(/social-post|webhook|publish|ghost|twitter/i);
  });

  it('its plan runs: two steps, longform, both configs valid', () => {
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(preset))));
    expect(plan.steps.longform).toBe(true);
    expect(plan.steps.list).toHaveLength(2);
    plan.steps.list.forEach((s: AgentOrchestrationStep, i: number) => expect(executor.normalizeStepLocal(s.local, i)).toEqual(s.local));
    expect(executor.isDigestPlan(plan)).toBe(true);
    expect(() => executor.validatePlan(plan)).not.toThrow();
  });

  it('a stream\'s plan is not a digest, so its draft stays quiet', () => {
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(buildArticlePipeline('dev-ja')))));
    expect(executor.isDigestPlan(plan)).toBe(false);
    expect(executor.quietDraftNotification(plan, 'draft')).toBe(true);
  });
});

describe('NL triggers', () => {
  it.each<[string, ArticleStream, string]>([
    ['AI×STEAMの記事パイプラインを作って', 'ai-steam', '0 6 * * *'],
    ['開発記の記事パイプラインを作って', 'dev-ja', '20 6 * * *'],
    ['Zennの記事パイプラインを作って', 'dev-ja', '20 6 * * *'],
    ['英語の開発記の記事パイプラインを作って', 'dev-en', '40 6 * * *'],
    ['dev.toの記事パイプラインを作って', 'dev-en', '40 6 * * *'],
    ['Create a devlog article pipeline in English', 'dev-en', '40 6 * * *'],
    ['古着の記事パイプラインを作って', 'vintage-ja', '0 7 * * *'],
    ['はてなの記事パイプラインを作って', 'vintage-ja', '0 7 * * *'],
    ['英語の古着の記事パイプラインを作って', 'vintage-en', '20 7 * * *'],
    ['Substackの記事パイプラインを作って', 'vintage-en', '20 7 * * *'],
    ['Create a vintage article pipeline in English', 'vintage-en', '20 7 * * *'],
  ])('%s', (utterance, stream, cron) => {
    const d = parseAgentNL(utterance);
    expect(d.longform).toBe(true);
    expect(d.schedule).toBe(cron);
    expect(d.presetOutput?.outputTemplate).toBe(`{date}-${stream}.md`);
    expect(d.autonomous).toBe(false);
    expect(d.action).toEqual({ type: 'draft' });
  });

  it.each(['記事ダイジェストのパイプラインを作って', '下書きダイジェストのパイプラインを作って', 'Create an article digest pipeline'])('%s is the digest', (utterance) => {
    const d = parseAgentNL(utterance);
    expect(d.presetOutput?.outputTemplate).toBe('{date}-digest.md');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.orchestrationSteps).toHaveLength(2);
  });

  it('REGRESSION: other pipelines and a digest outside a pipeline request are untouched', () => {
    expect(parseAgentNL('量子コンピュータの記事パイプライン').longform).toBeUndefined();
    expect(parseAgentNL('STEAM×AIのパイプラインを作って').longform).toBeUndefined();
    expect(parseAgentNL('毎朝ニュース記事のダイジェストを通知して').longform).toBeUndefined();
    expect(parseAgentNL('古着を探して').longform).toBeUndefined();
    expect(parseAgentNL('開発記のパイプラインのエラーを直して').orchestrationSteps).toBeUndefined();
  });

  it('REGRESSION: asking to collect articles is the collection preset, not a stream', () => {
    const d = parseAgentNL('STEAMの記事を集めるパイプライン');
    expect(d.longform).toBeUndefined();
    expect(d.autonomous).toBe(true);
    expect(d.orchestrationSteps).toHaveLength(4);
  });

  it('asked to post, a stream stays a draft and says so', () => {
    const d = parseAgentNL('古着の記事パイプラインを作ってXに投稿して');
    expect(d.action).toEqual({ type: 'draft' });
    expect(d.actionCaveat).toContain('投稿しません');
  });
});

describe('the confirmation text', () => {
  const ja = { cloudConsent: false };

  it('says an article preset set the engine, not the owner', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL('AI×STEAMの記事パイプラインを作って'), undefined, false, ja);
    expect(text).not.toContain('named in your request');
    expect(text).not.toContain('リクエストで指定');
  });

  it('the digest names no engine: it calls no model', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL('記事ダイジェストのパイプラインを作って'), undefined, false, ja);
    expect(text).not.toContain('named in your request');
    expect(text).not.toContain('リクエストで指定');
    expect(text).not.toContain('このパイプラインの設定');
    expect(text).not.toContain('set by this pipeline');
  });

  it('has the same key in both languages', () => {
    const en = fs.readFileSync(path.join(root, 'lib/i18n/locales/en.ts'), 'utf8');
    const jaFile = fs.readFileSync(path.join(root, 'lib/i18n/locales/ja.ts'), 'utf8');
    expect(en).toContain("'agentplan.summary_tool_preset'");
    expect(jaFile).toContain("'agentplan.summary_tool_preset'");
  });

  it('REGRESSION: a tool the owner really named still says so', () => {
    const d = { ...parseAgentNL('毎朝パープレでニュースを集めて保存して'), longform: undefined };
    const text = summarizeAgentDraftAsText(d, undefined, false, ja);
    expect(text).toMatch(/named in your request|リクエストで指定/);
  });
});

describe('agent registration is confirmed in plain chat text', () => {
  const pane = fs.readFileSync(path.join(root, 'components/panes/AIPane.tsx'), 'utf8');

  it('renders no Confirm / Cancel row under a chat-native draft', () => {
    expect(pane).not.toContain('AgentChatConfirm');
    const branch = pane.slice(pane.indexOf('if (message.agentChatConfirm) {'), pane.indexOf('<AgentConfirmCard'));
    expect(branch).toContain('{message.content}');
    expect(branch).not.toMatch(/TouchableOpacity|Pressable|onConfirmAgentDraft|onCancelAgentDraft/);
  });

  it('the summary still tells the owner how to answer', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL('開発記の記事パイプラインを作って'), undefined, false, { cloudConsent: false });
    expect(text).toMatch(/OK|Say the word/);
  });

  it('no message sends the owner to a button that is gone', () => {
    for (const file of ['en', 'ja']) {
      const locale = fs.readFileSync(path.join(root, `lib/i18n/locales/${file}.ts`), 'utf8');
      const notices = locale.split('\n').filter((l) => l.includes("'agentplan.superseded_notice"));
      expect(notices).toHaveLength(2);
      notices.forEach((l) => expect(l).not.toMatch(/button|ボタン/));
    }
  });
});

describe('the confirmation', () => {
  it.each(['開発記の記事パイプラインを作って', '記事ダイジェストのパイプラインを作って'])('%s needs the typed OK, in plain text', (utterance) => {
    const d = parseAgentNL(utterance);
    expect(shouldUseChatConfirm(d)).toBe(true);
    expect(isAutoRegisterEligibleDraft(d)).toBe(false);
    expect(nextMissingSlot(d, {} as any)).toBeNull();
    const text = summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false });
    expect(text).toContain('/sdcard/Documents/ObsidianVault/50_Drafts/');
    expect(text).not.toContain('Output contract');
  });

  it('hands queue-pop and the digest\'s local steps to registration', () => {
    const dev = draftToConfirmedAgentDraft(parseAgentNL('開発記の記事パイプラインを作って'));
    expect(dev.longform).toBe(true);
    expect((dev.orchestrationSteps![0] as AgentOrchestrationStep).local).toEqual({ kind: 'queue-pop' });
    const digest = draftToConfirmedAgentDraft(parseAgentNL('記事ダイジェストのパイプラインを作って'));
    expect((digest.orchestrationSteps![0] as AgentOrchestrationStep).local?.kind).toBe('list-drafts');
  });
});

// docs/promo is the owner's working folder and is not checked in, so CI has no copy.
const seedPath = path.join(root, 'docs/promo/articles/devlog/queue-seed.md');
const planV2Path = path.join(root, 'docs/promo/research/plan-v2.md');

(fs.existsSync(seedPath) ? describe : describe.skip)('the Dev JA queue seed', () => {
  const seed = fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : '';
  const tocPath = path.join(root, 'docs/promo/articles/devlog/toc.md');
  const toc = fs.existsSync(tocPath) ? fs.readFileSync(tocPath, 'utf8') : '';
  const open = seed.split('\n').filter((l) => /^- \[ \] /.test(l));

  it('has the first 10 topics, open, in order', () => {
    expect(open).toHaveLength(10);
    open.forEach((line, i) => expect(line).toContain(`第${i + 1}話`));
  });

  it('parses in the executor: the first block has its points and commits', () => {
    const block = executor.firstQueueBlock(seed);
    expect(block.line).toContain('第1話');
    expect(block.body).toContain('要点: Expo 54');
    expect(block.body).toContain('ae613a572');
    expect(block.body).not.toContain('第2話');
  });

  it('every block holds its points and material, and pops in turn', () => {
    let text = seed;
    for (let i = 0; i < 10; i += 1) {
      const block = executor.firstQueueBlock(text);
      expect(block.line).toContain(`第${i + 1}話`);
      expect(block.body).toContain('要点:');
      expect(block.body).toMatch(/材料: .*[0-9a-f]{9}/);
      text = executor.flipQueueText(text, block.line);
    }
    expect(executor.firstQueueBlock(text)).toBeNull();
  });

  it('uses only commit hashes the table of contents has', () => {
    const hashes = seed.match(/\b[0-9a-f]{9}\b/g)!;
    expect(hashes.length).toBeGreaterThan(30);
    hashes.forEach((hash) => expect(toc).toContain(hash));
  });

  it('fits the executor\'s caps', () => {
    expect(Buffer.byteLength(seed)).toBeLessThan(executor.QUEUE_MAX_BYTES);
  });

  it('does not repeat a claim the ledger rejects as its title', () => {
    expect(open[0]).not.toContain('一台');
  });
});

describe('the docs', () => {
  (fs.existsSync(planV2Path) ? it : it.skip)('plan-v2 no longer says the API output is capped at 2048 tokens', () => {
    const plan = fs.readFileSync(planV2Path, 'utf8');
    expect(plan).not.toContain('API 出力 2048 トークン上限');
    expect(plan).toContain('ローカル LLM だけ');
  });

  it('CLAUDE.md and DEFERRED.md record it as not verified on a device', () => {
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/記事の毎日下書き[^\n]*実機未検証/);
    const deferred = fs.readFileSync(path.join(root, 'docs/superpowers/DEFERRED.md'), 'utf8');
    expect(deferred).toContain('### 記事の毎日下書き（5 ストリーム＋ダイジェスト）');
  });
});
