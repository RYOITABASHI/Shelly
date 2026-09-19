/**
 * lib/provider-connect-intent.ts — pure detector for "connect me to <AI
 * provider>" chat utterances (2026-09-20, "Grok Bot" conversational
 * onboarding).
 *
 * Today an API key can ONLY be set through Settings → API Keys
 * (components/config/ConfigTUI.tsx). This module is the trigger half of a
 * chat-native alternative: recognize a plain-language request to connect a
 * specific provider, so hooks/use-ai-pane-dispatch.ts can ask for the key
 * inline instead of sending the request to any LLM. Deliberately narrow —
 * a name match alone is not enough, the phrase must also contain a
 * connect/setup-shaped verb — so an ordinary question that happens to
 * mention "Gemini" ("what's Gemini good at?") does not trip this.
 *
 * Pure and IO-free, matching lib/agent-global-memory-intent.ts's own
 * reasoning for staying that way: the whole detector is unit-testable
 * offline, and it stays usable from both the AI Pane dispatch path and any
 * future caller (e.g. a per-agent thread proactively suggesting a connect)
 * without dragging in React/Zustand/expo-* imports.
 */
import type { ApiKeyName } from '@/lib/secure-store';

export type ConnectableProvider = 'geminiApiKey' | 'cerebrasApiKey' | 'groqApiKey' | 'perplexityApiKey' | 'openrouterApiKey';

// Compile-time check that every ConnectableProvider is a real ApiKeyName
// (secure-store.ts's fixed enum) without widening this module's own type.
type _AssertSubsetOfApiKeyName = ConnectableProvider extends ApiKeyName ? true : never;
const _assertSubset: _AssertSubsetOfApiKeyName = true;
void _assertSubset;

/** The five AI Pane providers this chat-native flow covers — Codex is
 *  intentionally excluded (OAuth/subscription-based, out of AI-Pane-chat
 *  scope per CLAUDE.md's explicit-provider rule), and local server URL is
 *  handled separately by the caller (not a secret, no key name here). */
export const CONNECTABLE_PROVIDERS: Record<ConnectableProvider, string[]> = {
  geminiApiKey: ['gemini'],
  cerebrasApiKey: ['cerebras'],
  groqApiKey: ['groq'],
  perplexityApiKey: ['perplexity'],
  openrouterApiKey: ['openrouter', 'open router'],
};

const CONNECT_VERB_EN = /\b(connect|set\s*up|setup|configure|hook\s*up|link)\b/i;
const CONNECT_VERB_JA = /(繋い|つなぎ|接続|設定して|使えるように)/;

/**
 * Returns the provider the user is asking to connect, or null if the
 * utterance doesn't look like a connect request. Case-insensitive,
 * EN+JA; the provider name and a connect-shaped verb must BOTH be present
 * (same "two required markers" shape as detectGlobalMemoryWrite) so a
 * plain question mentioning a provider's name never trips this.
 */
export function detectProviderConnectRequest(text: string): ConnectableProvider | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const hasConnectVerb = CONNECT_VERB_EN.test(trimmed) || CONNECT_VERB_JA.test(trimmed);
  if (!hasConnectVerb) return null;

  const lower = trimmed.toLowerCase();
  for (const [provider, names] of Object.entries(CONNECTABLE_PROVIDERS) as [ConnectableProvider, string[]][]) {
    if (names.some((name) => lower.includes(name))) return provider;
  }
  return null;
}

const PROVIDER_DISPLAY_NAME: Record<ConnectableProvider, string> = {
  geminiApiKey: 'Gemini',
  cerebrasApiKey: 'Cerebras',
  groqApiKey: 'Groq',
  perplexityApiKey: 'Perplexity',
  openrouterApiKey: 'OpenRouter',
};

export function providerDisplayName(provider: ConnectableProvider): string {
  return PROVIDER_DISPLAY_NAME[provider];
}
