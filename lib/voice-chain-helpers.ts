/**
 * lib/voice-chain-helpers.ts — Helpers for VoiceChain (voice ↔ terminal)
 *
 * Summarizes long terminal output for natural speech reading.
 */

import { useSettingsStore } from '@/store/settings-store';

/**
 * Summarize terminal output for voice reading.
 * Short output (<= 200 chars) is returned as-is.
 * Long output is summarized via AI into 1-2 natural spoken sentences.
 */
export async function summarizeForSpeech(output: string): Promise<string> {
  if (!output.trim()) return 'Done.';
  if (output.length <= 200) return output.trim();

  const settings = useSettingsStore.getState().settings;

  // Try Groq first (fastest)
  const groqKey = settings.groqApiKey;
  if (groqKey && groqKey.trim().length >= 10) {
    try {
      const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('@/lib/groq');
      let result = '';
      const res = await groqChatStream(
        groqKey,
        `Summarize this terminal output for voice reading. Use natural spoken language. 2 sentences max. If it's in a Japanese context, respond in Japanese:\n\n${output.slice(0, 2000)}`,
        (chunk) => { result += chunk; },
        settings.groqModel || GROQ_DEFAULT_MODEL,
        [],
      );
      if (res.success && result) return result;
    } catch {}
  }

  // Last resort: first and last 2 lines
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length <= 4) return output.trim();
  return `${lines[0]}\n${lines[1]}\n... ${lines.length - 4} lines omitted ...\n${lines[lines.length - 2]}\n${lines[lines.length - 1]}`;
}
