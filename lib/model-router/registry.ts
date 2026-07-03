// MODEL-001 model router — the shipped candidate registry.
//
// Descriptors for the concrete runnable backends. `isLocal` is the source of
// truth for the secret bar and is true ONLY for the on-device `local` model.
// `credentialClass` is authored to match lib/agent-credential-policy and is
// cross-checked by registry.test.ts so the two can never silently disagree.
// The meta `auto` and specialized `ab-article-eval` choices are intentionally
// excluded — they are not concrete selectable models.
//
// Cost/latency/preference are static hints; nothing consumes them at runtime
// while the router is dormant. `local` carries the highest preference so the
// on-device-first policy biases toward it on ties.

import { ModelCandidate } from './types';

export const MODEL_REGISTRY: readonly ModelCandidate[] = [
  {
    id: 'local-qwen',
    toolType: 'local',
    isLocal: true,
    credentialClass: 'local',
    capabilities: { web: false, taskKinds: ['code', 'research', 'prose', 'transform', 'general'] },
    cost: 'free',
    latency: 'slow',
    preference: 100,
  },
  {
    id: 'codex-cli',
    toolType: 'cli',
    isLocal: false,
    credentialClass: 'oauth',
    capabilities: { web: false, taskKinds: ['code', 'transform', 'general'] },
    cost: 'low',
    latency: 'fast',
    preference: 80,
  },
  {
    id: 'groq',
    toolType: 'groq',
    isLocal: false,
    credentialClass: 'api-key',
    capabilities: { web: false, taskKinds: ['code', 'prose', 'transform', 'general'] },
    cost: 'free',
    latency: 'instant',
    preference: 55,
  },
  {
    id: 'cerebras',
    toolType: 'cerebras',
    isLocal: false,
    credentialClass: 'api-key',
    capabilities: { web: false, taskKinds: ['code', 'prose', 'transform', 'general'] },
    cost: 'free',
    latency: 'instant',
    preference: 54,
  },
  {
    id: 'gemini-api',
    toolType: 'gemini-api',
    isLocal: false,
    credentialClass: 'api-key',
    capabilities: { web: false, taskKinds: ['code', 'research', 'prose', 'transform', 'general'] },
    cost: 'low',
    latency: 'fast',
    preference: 60,
  },
  {
    id: 'perplexity',
    toolType: 'perplexity',
    isLocal: false,
    credentialClass: 'api-key',
    capabilities: { web: true, taskKinds: ['research', 'general'] },
    cost: 'medium',
    latency: 'fast',
    preference: 50,
  },
];
