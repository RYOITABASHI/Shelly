/**
 * A made-up user config for the article pipeline tests. Shelly ships no real
 * series; this one exists only here.
 */
import {
  buildArticleDigestPipeline,
  buildArticlePipeline,
  type ArticleDigestConfig,
  type ArticlePipelineConfig,
  type PipelinePreset,
} from '@/lib/agent-pipeline-presets';

export type ExampleStream = 'example-a' | 'example-queue' | 'example-queue-en' | 'example-refill' | 'example-refill-en';

export const EXAMPLE_FOLDER = '/storage/example/Notes/Drafts';
const MARKER = '【本人の材料: 未記入】';

const JA_INSTRUCTIONS = {
  research: 'Webで検索し、テーマをひとつに絞って調査メモを作る。別々の資料を3件以上使い、資料ごとに具体的な数値と限界を書く。',
  write: `調査メモをもとに記事を書く。1行目は「# 」で始まる見出し。事実には Sources の番号 [n] を付ける。最後に「## 見解」の節を作り、本文は書かず ${MARKER} とだけ書く。`,
  review: `調査メモだけを根拠に、下書きの主張を一つずつ照合する。${MARKER} は指摘しない。`,
  revise: `査読の指摘をすべて反映し、修正後の記事全文だけを出力する。1行目の「# 」見出しは必ず残す。${MARKER} はそのまま残す。`,
};

const EN_INSTRUCTIONS = {
  research: 'Search the web for the one topic and write research notes from at least 3 separate sources, with concrete numbers and limits.',
  write: `Using the notes, write a post. The first line is a heading starting with "# ". Mark facts with their Sources number [n]. End with a "## My take" section holding only ${MARKER}.`,
  review: `The notes are the only evidence. Flag claims not in them. Ignore ${MARKER}.`,
  revise: `Apply every finding and output only the full revised post. Keep the "# " title line. Keep ${MARKER} as it is.`,
};

const JA_TOPICS = '連載の次のテーマを探す。Webで検索し、まだ書いていないテーマを最大5件挙げる。出力は次の形式だけ。各項目の1行目は「- [ ] テーマ名」、続けて2字下げで「要点: 」で始まる行を1〜4行。';
const EN_TOPICS = 'Find the next topics. List up to 5 topics not covered yet. Output only this format: each item starts with "- [ ] topic", then lines indented by two spaces, each starting "Points: ".';

const ENGINES: ArticlePipelineConfig['engines'] = {
  research: { type: 'gemini-api' },
  write: { type: 'gemini-api' },
  review: { type: 'cerebras' },
};

const base = (id: string, folder: string, lang: 'ja' | 'en'): ArticlePipelineConfig => ({
  id,
  name: lang === 'ja' ? 'サンプル連載 下書き' : 'Example series draft',
  prompt:
    lang === 'ja'
      ? 'サンプル連載の読み物シリーズ。読者は一般の人。日本語で書く。\n共通ルール:\n- 資料に書かれたことだけを書く。'
      : 'An example series for general readers. Write in plain English.\nRules for every step:\n- Write only what the sources say.',
  lang,
  schedule: '30 5 * * *',
  outputFolder: `${EXAMPLE_FOLDER}/${folder}/`,
  footer: lang === 'ja' ? '最終確認者: Example Author' : 'Final check: Example Author',
  instructions: lang === 'ja' ? JA_INSTRUCTIONS : EN_INSTRUCTIONS,
  engines: ENGINES,
  lintTerms: ['禁句'],
  nameLint: { canonical: 'Example Author', forms: ['author'] },
  quality: lang === 'ja' ? { minChars: 2500, minSources: 2 } : { minWords: 1000, minSources: 2 },
});

export const EXAMPLE_CONFIGS: Record<ExampleStream, ArticlePipelineConfig> = {
  'example-a': {
    ...base('example-a', 'SeriesA', 'ja'),
    // The research engine differs from the writer's, to exercise both sides.
    engines: { ...ENGINES, research: { type: 'perplexity', model: 'sonar-pro' }, agent: { type: 'gemini-api' } },
  },
  'example-queue': { ...base('example-queue', 'SeriesB', 'ja'), queue: true },
  'example-queue-en': { ...base('example-queue-en', 'SeriesBEn', 'en'), queue: true },
  'example-refill': { ...base('example-refill', 'SeriesC', 'ja'), queue: true, lintSources: true, instructions: { ...JA_INSTRUCTIONS, topics: JA_TOPICS } },
  'example-refill-en': { ...base('example-refill-en', 'SeriesCEn', 'en'), queue: true, lintSources: true, instructions: { ...EN_INSTRUCTIONS, topics: EN_TOPICS } },
};

export const EXAMPLE_DIGEST: ArticleDigestConfig = {
  name: 'サンプル ダイジェスト',
  prompt: '下書きの一覧',
  lang: 'ja',
  schedule: '0 9 * * *',
  outputFolder: `${EXAMPLE_FOLDER}/Digest/`,
  footer: 'このノートは自動で作られます。投稿はしません。',
  engine: { type: 'gemini-api' },
  streams: [
    { folder: 'SeriesA', label: 'シリーズA', intent: true },
    { folder: 'SeriesB', label: 'シリーズB（媒体甲）', intent: true },
    { folder: 'SeriesBEn', label: 'シリーズB EN', intent: true },
    { folder: 'SeriesC', label: 'シリーズC（媒体乙）' },
    { folder: 'SeriesCEn', label: 'シリーズC EN' },
  ],
};

export const examplePipeline = (stream: ExampleStream): PipelinePreset => buildArticlePipeline(EXAMPLE_CONFIGS[stream]);
export const exampleDigestPipeline = (): PipelinePreset => buildArticleDigestPipeline(EXAMPLE_DIGEST);
