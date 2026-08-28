/**
 * lib/companion-brain.ts — Fable5 quality-floor Design C (2026-08-28).
 *
 * Resolves WHICH backend generates a companion-thread (agent === 'local')
 * reply. Pure function, no I/O — every input is already-loaded settings, so
 * this is fully unit-testable without mocking any store or network call.
 *
 * This only ever governs response GENERATION for the companion thread.
 * It must NOT change:
 *  - the companion THREAD identity (`agent === 'local'` stays the marker
 *    every intercept in hooks/use-ai-pane-dispatch.ts keys off — see that
 *    file's companionMemoryIntent / implicitAgentIntent / history-truncation
 *    logic, all keyed on the thread, never on which backend answers it);
 *  - journal digestion (lib/companion-journal.ts's
 *    digestConversationForJournal), which stays on-device unconditionally —
 *    digestion happens too often for cascading it onto a paid API to have
 *    predictable cost/rate implications;
 *  - classification/routing that is local-only by design elsewhere in the
 *    app (e.g. lib/agent-router-scoring.ts).
 *
 * Cascade order when `companionBrainMode` is 'auto' (the default): Cerebras
 * → Groq → Gemini → OpenRouter → local. 'local-only' always returns 'local'
 * regardless of which keys are configured — the explicit opt-out to
 * byte-identical pre-Design-C behavior.
 */
import type { AppSettings } from '@/store/types';

export type CompanionBrainProvider = 'local' | 'cerebras' | 'groq' | 'gemini' | 'openrouter';

/** A configured key is present and non-empty after trimming whitespace. */
function hasKey(key: string | undefined | null): boolean {
  return typeof key === 'string' && key.trim().length > 0;
}

export function resolveCompanionBrain(settings: AppSettings): CompanionBrainProvider {
  if (settings.companionBrainMode === 'local-only') {
    return 'local';
  }

  // 'auto' (default, including when the field is absent on an older
  // persisted settings blob — see settings-store.ts's DEFAULT_SETTINGS).
  if (hasKey(settings.cerebrasApiKey)) return 'cerebras';
  if (hasKey(settings.groqApiKey)) return 'groq';
  if (hasKey(settings.geminiApiKey)) return 'gemini';
  if (hasKey(settings.openrouterApiKey)) return 'openrouter';
  return 'local';
}
