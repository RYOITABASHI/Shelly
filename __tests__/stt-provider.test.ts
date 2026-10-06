import {
  hasUsableGroqKey,
  needsOnDeviceAvailability,
  normalizeSttSetting,
  resolveSttProvider,
  sttLanguageForLocale,
  sttUnavailableMessageKey,
} from '@/lib/stt-provider';

const KEY = 'gsk_0123456789abcdef';
const AVAILABLE = { available: true };
const UNAVAILABLE = { available: false };

describe('resolveSttProvider', () => {
  it('auto (default): Groq key wins, on-device is the keyless fallback, else none', () => {
    expect(resolveSttProvider({ groqApiKey: KEY }, AVAILABLE)).toBe('groq');
    expect(resolveSttProvider({ groqApiKey: KEY }, UNAVAILABLE)).toBe('groq');
    expect(resolveSttProvider({}, AVAILABLE)).toBe('ondevice');
    expect(resolveSttProvider({ groqApiKey: '   ' }, AVAILABLE)).toBe('ondevice');
    expect(resolveSttProvider({}, UNAVAILABLE)).toBe('none');
    expect(resolveSttProvider({}, null)).toBe('none');
    expect(resolveSttProvider({ sttProvider: 'auto' }, AVAILABLE)).toBe('ondevice');
  });

  it('forced groq never falls back to on-device', () => {
    expect(resolveSttProvider({ sttProvider: 'groq', groqApiKey: KEY }, AVAILABLE)).toBe('groq');
    expect(resolveSttProvider({ sttProvider: 'groq' }, AVAILABLE)).toBe('none');
  });

  it('forced ondevice never uploads to Groq even with a key', () => {
    expect(resolveSttProvider({ sttProvider: 'ondevice', groqApiKey: KEY }, AVAILABLE)).toBe('ondevice');
    expect(resolveSttProvider({ sttProvider: 'ondevice', groqApiKey: KEY }, UNAVAILABLE)).toBe('none');
  });

  it('treats unknown persisted values as auto', () => {
    expect(normalizeSttSetting('whisper')).toBe('auto');
    expect(normalizeSttSetting(undefined)).toBe('auto');
    expect(resolveSttProvider({ sttProvider: 'bogus' }, AVAILABLE)).toBe('ondevice');
  });
});

describe('helpers', () => {
  it('hasUsableGroqKey keeps the historical >=10 char threshold', () => {
    expect(hasUsableGroqKey('123456789')).toBe(false);
    expect(hasUsableGroqKey('1234567890')).toBe(true);
    expect(hasUsableGroqKey(undefined)).toBe(false);
  });

  it('needsOnDeviceAvailability skips the native check on the Groq path', () => {
    expect(needsOnDeviceAvailability({ groqApiKey: KEY })).toBe(false);
    expect(needsOnDeviceAvailability({ sttProvider: 'groq' })).toBe(false);
    expect(needsOnDeviceAvailability({})).toBe(true);
    expect(needsOnDeviceAvailability({ sttProvider: 'ondevice', groqApiKey: KEY })).toBe(true);
  });

  it('sttUnavailableMessageKey explains the configured mode', () => {
    expect(sttUnavailableMessageKey({})).toBe('speech.api_key_required');
    expect(sttUnavailableMessageKey({ sttProvider: 'groq' })).toBe('speech.groq_key_required_forced');
    expect(sttUnavailableMessageKey({ sttProvider: 'ondevice' })).toBe('speech.ondevice_unavailable');
  });

  it('sttLanguageForLocale maps the app locale to a BCP-47 tag', () => {
    expect(sttLanguageForLocale('ja')).toBe('ja-JP');
    expect(sttLanguageForLocale('en')).toBe('en-US');
    expect(sttLanguageForLocale(undefined)).toBe('ja-JP');
  });
});
