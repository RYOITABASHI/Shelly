// Shared fixtures for the sourced-briefing tests (lib/agent-sources.ts + the
// scripts/shelly-plan-executor.js port). Shape follows the Perplexity chat
// completions response: citations (url[]) + search_results ({title,url,date}).
export const DEMO_UTTERANCE =
  'First, search the web with Perplexity for the top 3 on-device AI news stories. Then summarize them with the local LLM. Finally, write a markdown briefing.';

export const PERPLEXITY_RESPONSE = {
  id: 'x',
  model: 'sonar-pro',
  choices: [
    {
      message: {
        role: 'assistant',
        content: [
          '1. **Google releases Gemma 3n for on-device AI** (2026-09-30) — Google released Gemma 3n, a mobile-first open model that runs on phones with 2GB of RAM. [1]',
          '2. **Apple expands Foundation Models framework** (2026-09-15) — Apple opened its on-device Foundation Models framework to third-party developers in iOS 26. [2][3]',
          '3. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** (2026-09-24) — Qualcomm announced the Snapdragon 8 Elite Gen 5 with a faster Hexagon NPU for on-device generative AI. [4]',
        ].join('\n'),
      },
    },
  ],
  citations: [
    'https://blog.google/technology/developers/gemma-3n/',
    'https://www.apple.com/newsroom/2026/09/foundation-models/',
    'https://developer.apple.com/documentation/foundationmodels',
    'https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5',
  ],
  search_results: [
    { title: 'Announcing Gemma 3n', url: 'https://blog.google/technology/developers/gemma-3n/', date: '2026-09-30' },
    { title: 'Apple Foundation Models framework', url: 'https://www.apple.com/newsroom/2026/09/foundation-models/', date: '2026-09-15' },
    { title: 'Foundation Models | Apple Developer', url: 'https://developer.apple.com/documentation/foundationmodels', last_updated: '2026-09-16' },
    { title: 'Snapdragon 8 Elite Gen 5', url: 'https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5', date: '2026-09-24' },
    { title: 'Extra result', url: 'https://example.org/extra', date: '2026-09-01' },
  ],
};
