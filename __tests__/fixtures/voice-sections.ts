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
  '- 週末は古い自転車の修理をしている。',
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

/**
 * The owner's style (v40): polite endings, short sentences, one twist, a light
 * trailing "…", sometimes a short numbered list as a joke. Made up, on a
 * neutral made-up topic (old mugs and how they were made); they answer
 * VOICE_FIXTURE_ARTICLE_POLITE_JA / _EN.
 */
export const VOICE_FIXTURE_POLITE_JA: string[] = [
  '理由を並べてみました。\n①古いから\n②手間がかかっていたから\n③偽物も多いから\nそして③のせいで、①と②を素直に信じられないのが悩ましいところです…',
  '工場の都合で選ばれた方式が、後の世代ではプレミアの根拠になる時代になりました。合理化は、だいたい後世の価値を生むものなんですよね。',
  '古い製法の品に値段が付くのは、少し不思議な気がします。当時はただのコスト削減だったはずなんですよね…',
  '手間がかかる方式ほど、後から見ると味になります。効率の良さと愛着は、別の物差しなのかもしれません。',
  '偽物が多いのは、それだけ人気がある証拠です。とはいえ、買う側の悩みは尽きません…',
  '本物の見分け方は、だいたい細部に出ます。持ち手の形、底の印、釉薬のむら。どれも地味ですが、そこが面白いところです。',
  '昔の工場は、早く大量に作ることを優先していました。その結果が、今の希少さにつながっているのが皮肉です。',
  '「古いから価値がある」とは限らないのが、この世界の面白さです。手間のかかる品は、新しくても大事にされます。',
  '値段だけを見ると、昔の品は高く感じます。でも作りを知ると、少し納得できる気もします…',
  'まとめると、こうなります。\n①古い\n②手間がかかる\n③偽物が多い\n全部そろうと、なぜか欲しくなるのが不思議です。',
  '合理化で生まれた形が、今では「らしさ」として好まれています。狙いのない魅力ほど、長持ちするのかもしれません。',
  '本物かどうかを気にしすぎると、楽しさが減ってしまいます。ほどほどに付き合うのが、ちょうどいい距離なんでしょうね。',
  '私は、こういう遠回りな歴史が好きです。効率の話が、いつの間にか愛着の話になっているのが面白いんですよね。',
  '値札の数字より、作られた事情のほうが気になります。理由を知ると、同じ品でも少し違って見えるものです…',
];

export const VOICE_FIXTURE_POLITE_EN: string[] = [
  'The reasons, in short:\n1. They are old\n2. They took real effort\n3. Fakes are common\nAnd the last one is why the others are hard to trust…',
  'A method picked to save money ended up as the reason people pay more. Efficiency, it turns out, tends to create value for later generations.',
  'I find the whole thing a little funny. Fakes exist because the real ones are loved, and that is a strange kind of compliment.',
  'Old mugs were never meant to be special. Yet the shortcuts became the charm…',
  'The price tag says rare, but the story says ordinary. I like that gap more than the mugs themselves.',
  'Collectors argue about tiny details, and honestly, the arguing is most of the fun.',
];

export const VOICE_FIXTURE_ARTICLE_POLITE_JA = [
  '# 古いマグカップの製法と人気',
  '',
  '昔のマグカップは、工場の都合で選ばれた方式で作られていた。手作業の工程が多く、手間がかかっていた。',
  '今では古い製法の品にプレミアが付くこともあり、偽物も多い。どの特徴が本物の印なのかは、よく議論になる。',
].join('\n');
export const VOICE_FIXTURE_ARTICLE_POLITE_EN = [
  '# Old mugs and how they were made',
  '',
  'Old mugs were made with a method that factories picked to save money and time. Efficiency mattered more than looks, and the process still needed a lot of handwork.',
  'Today, mugs made the old way often sell at a premium, and fakes are common. Collectors argue about which details mark the real thing.',
].join('\n');

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
