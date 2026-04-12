/**
 * lib/arena-selector.ts — Arena Mode エージェント選択
 *
 * 利用可能なエージェントからランダムに2つ選択。
 */

import type { ChatAgent } from '@/store/chat-store';
import type { AppSettings } from '@/store/types';

const ARENA_ELIGIBLE: ChatAgent[] = ['claude', 'gemini', 'groq', 'cerebras', 'local', 'perplexity'];

/**
 * APIキーが設定済みのエージェントから2つランダム選択。
 * 2つ未満の場合はfallback (claude + gemini)。
 */
export function selectArenaAgents(settings: AppSettings): [ChatAgent, ChatAgent] {
  const available: ChatAgent[] = [];

  // Claude: 同梱claude cliが利用可能（API key不要）
  available.push('claude');

  // Gemini: 同梱gemini cliが利用可能（API key不要）
  available.push('gemini');

  if (settings.groqApiKey) available.push('groq');
  if (settings.cerebrasApiKey) available.push('cerebras');
  if (settings.localLlmEnabled) available.push('local');
  if (settings.perplexityApiKey) available.push('perplexity');

  if (available.length < 2) {
    return ['claude', 'gemini'];
  }

  // Shuffle and pick 2
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}
