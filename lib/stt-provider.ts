/**
 * lib/stt-provider.ts — pick the speech-to-text route for turn-based voice
 * input (hooks/use-speech-input.ts, hooks/use-voice-chat.ts).
 *
 *   'groq'     — Groq Whisper (cloud, needs groqApiKey). Records m4a via expo-audio.
 *   'ondevice' — keyless, free, on-device SpeechRecognizer
 *                (SpeechRecognizerBridge.kt). No expo-audio recording at all:
 *                the platform recognition service owns the mic.
 *   'none'     — nothing usable; the caller shows sttUnavailableMessageKey().
 *
 * settings.sttProvider: 'auto' (default) prefers Groq when a key is present
 * (keeps existing users' behavior), otherwise falls back to on-device. A
 * forced choice never silently switches to the other route — in particular
 * forced 'ondevice' never uploads audio to Groq.
 *
 * Pure module (no native imports) so it is trivially unit-testable.
 */

export type SttProvider = 'groq' | 'ondevice' | 'none';
export type SttProviderSetting = 'auto' | 'groq' | 'ondevice';

export interface SttSettingsLike {
  sttProvider?: SttProviderSetting | string;
  groqApiKey?: string;
}

export interface SttAvailabilityLike {
  available: boolean;
}

/** Same threshold the Groq call sites have always used. */
export function hasUsableGroqKey(key: string | undefined | null): boolean {
  return typeof key === 'string' && key.trim().length >= 10;
}

export function normalizeSttSetting(value: unknown): SttProviderSetting {
  return value === 'groq' || value === 'ondevice' ? value : 'auto';
}

/**
 * True when resolving needs the (async, native) on-device availability check.
 * Lets callers skip the native round-trip on the Groq path.
 */
export function needsOnDeviceAvailability(settings: SttSettingsLike): boolean {
  const mode = normalizeSttSetting(settings.sttProvider);
  if (mode === 'groq') return false;
  if (mode === 'ondevice') return true;
  return !hasUsableGroqKey(settings.groqApiKey);
}

export function resolveSttProvider(
  settings: SttSettingsLike,
  availability: SttAvailabilityLike | null | undefined,
): SttProvider {
  const mode = normalizeSttSetting(settings.sttProvider);
  const groq = hasUsableGroqKey(settings.groqApiKey);
  const onDevice = !!availability?.available;
  switch (mode) {
    case 'groq':
      return groq ? 'groq' : 'none';
    case 'ondevice':
      return onDevice ? 'ondevice' : 'none';
    default:
      if (groq) return 'groq';
      return onDevice ? 'ondevice' : 'none';
  }
}

/** i18n key explaining why the resolved provider is 'none'. */
export function sttUnavailableMessageKey(settings: SttSettingsLike): string {
  const mode = normalizeSttSetting(settings.sttProvider);
  if (mode === 'groq') return 'speech.groq_key_required_forced';
  if (mode === 'ondevice') return 'speech.ondevice_unavailable';
  return 'speech.api_key_required';
}

/** BCP-47 tag for the on-device recognizer from the app UI locale. */
export function sttLanguageForLocale(locale: string | undefined | null): string {
  return locale === 'en' ? 'en-US' : 'ja-JP';
}
