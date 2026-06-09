/**
 * lib/arena-selector.ts — Arena Mode エージェント選択
 *
 * 利用可能なエージェントからランダムに2つ選択。
 */

import type { ChatAgent } from '@/store/chat-store';
import type { AppSettings } from '@/store/types';

const ARENA_ELIGIBLE: ChatAgent[] = ['codex', 'groq', 'cerebras', 'local', 'perplexity'];

/**
 * 設定済みのエージェントから2つランダム選択。
 * 2つ未満の場合は Codex + Local にfallback。
 */
export function selectArenaAgents(settings: AppSettings): [ChatAgent, ChatAgent] {
  const available: ChatAgent[] = [];

  // Codex: bundled CLI path.
  available.push('codex');

  if (settings.groqApiKey) available.push('groq');
  if (settings.cerebrasApiKey) available.push('cerebras');
  if (settings.localLlmEnabled) available.push('local');
  if (settings.perplexityApiKey) available.push('perplexity');

  if (available.length < 2) {
    return ['codex', 'local'];
  }

  // Shuffle and pick 2
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}
