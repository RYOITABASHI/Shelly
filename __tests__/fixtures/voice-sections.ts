/**
 * Made-up natural "author view" sections for the voice step's local check
 * (__tests__/plan-executor-voice.test.ts). Generic topic, no real person. The
 * check is strict on purpose; these measure how often ordinary opinion text
 * still passes.
 */
export const VOICE_FIXTURE_PROFILE = [
  '---',
  'reviewed: 2026-11-01',
  '---',
  '',
  '## Values',
  '- 学びは好奇心から始まると考えている。',
  '- Small tools that do one job well beat big platforms.',
  '',
  '## Tone',
  '- 短い文で、断定しすぎない。',
  '',
  '## Experience',
  '- サンプルの解析器を大きなログで試した。',
  '- I tested the sample parser on a large log file.',
  '',
  '## Allowed private facts',
  '- Works from a home office.',
  '',
  '## Private',
  '- Lives with a large family in a quiet suburb.',
  '- 長男は小学校で不登校気味だった。',
  '',
  '## Never say',
  '- That any tool is perfect.',
  '',
].join('\n');

export const VOICE_FIXTURE_SECTIONS_JA: string[] = [
  'この記事が示す方向は、学ぶ人の好奇心を大切にする点で良いと思う。道具は目的ではなく、問いを育てる手段だと考える。',
  '技術の進み方は速いが、私は使う人の目線を忘れないことが大切だと思う。記事で紹介された取り組みは、その点で参考になると感じる。',
  '研究で示されたように、遊びは学びにつながると考える。大事なのは、学ぶ人が自分で試せる環境だと思う。',
  '新しい仕組みが広がっても、好奇心が出発点であることは変わらないと思う。私は、小さく始める姿勢に期待している。',
  'この流れは今後も続くと考える。ただ、すべての学校に同じ答えが合うわけではないだろう。',
  '多くの人が見落としてきた点を、この記事はうまく取り上げていると感じる。現場ごとの違いを大切にしたいと思う。',
  '私は、道具の多さよりも使い方の工夫が学びを左右すると考える。一つの正解に絞る必要はないと思う。',
  '個人的には、良い流れだと思う。子ども一人ひとりの違いに目を向ける仕組みが増えることを期待する。',
  'そう言われてきたが、本当にそうだろうかと思う。私は、結果だけでなく過程にも目を向けるべきだと考える。',
  'テクノロジーは道具にすぎないと考える。私自身、問いを持つことが何より大切だと感じる。',
];

export const VOICE_FIXTURE_SECTIONS_EN: string[] = [
  'I think the study makes a fair point: tools should fit the task, not the other way round. In my view, curiosity is a better starting point than devices.',
  'I believe small tools that do one job well matter more than feature lists. I hope schools keep that in mind.',
  'In my view, the findings are encouraging, though the evidence is still early. I expect the debate to continue.',
  'I think the article is right to focus on how people learn rather than on the latest platform.',
  'I feel the strongest idea here is that play and learning are not opposites. I think teachers can build on that.',
  'I do not think every school needs the same answer. I believe local choices matter more than a single rule.',
  'I think the trend is promising, but it depends on how carefully it is introduced.',
  'In my opinion, the real test is whether students stay curious. I hope that stays at the center.',
  'I expect these ideas to spread slowly, and I think that is fine.',
  'I think the point about simple tools is the most useful part of the piece. I hope more projects keep their scope small.',
];

/** The made-up articles the sections answer: names and people come from here. */
export const VOICE_FIXTURE_ARTICLE_JA = [
  '# 遊びと学びの関係',
  '',
  '研究によると、子どもは遊びの中で多くを学ぶ。学校や教師の関わり方も変わりつつある。',
  '新しいテクノロジーやツールは道具にすぎないという指摘もある。',
].join('\n');
export const VOICE_FIXTURE_ARTICLE_EN = [
  '# Play and learning',
  '',
  'A study suggests that children learn a great deal through play. Schools and teachers are changing how they work with students.',
].join('\n');
