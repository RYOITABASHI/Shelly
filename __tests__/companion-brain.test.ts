/**
 * lib/companion-brain.ts — Fable5 quality-floor Design C (2026-08-28).
 * Pure-function unit tests: no store, no network, no mocks needed.
 */
import { resolveCompanionBrain } from '@/lib/companion-brain';
import type { AppSettings } from '@/store/types';

function makeSettings(overrides: Partial<AppSettings>): AppSettings {
  return {
    companionBrainMode: 'auto',
    cerebrasApiKey: '',
    groqApiKey: '',
    geminiApiKey: '',
    openrouterApiKey: '',
    ...overrides,
  } as AppSettings;
}

describe('resolveCompanionBrain', () => {
  it('local-only mode always returns local, regardless of configured keys', () => {
    const settings = makeSettings({
      companionBrainMode: 'local-only',
      cerebrasApiKey: 'sk-cerebras',
      groqApiKey: 'sk-groq',
      geminiApiKey: 'sk-gemini',
      openrouterApiKey: 'sk-openrouter',
    });
    expect(resolveCompanionBrain(settings)).toBe('local');
  });

  it('auto mode with no keys configured returns local', () => {
    const settings = makeSettings({ companionBrainMode: 'auto' });
    expect(resolveCompanionBrain(settings)).toBe('local');
  });

  it('auto mode picks Cerebras first when all keys are configured', () => {
    const settings = makeSettings({
      companionBrainMode: 'auto',
      cerebrasApiKey: 'sk-cerebras',
      groqApiKey: 'sk-groq',
      geminiApiKey: 'sk-gemini',
      openrouterApiKey: 'sk-openrouter',
    });
    expect(resolveCompanionBrain(settings)).toBe('cerebras');
  });

  it('auto mode falls back to Groq when only Groq/Gemini/OpenRouter are configured', () => {
    const settings = makeSettings({
      companionBrainMode: 'auto',
      groqApiKey: 'sk-groq',
      geminiApiKey: 'sk-gemini',
      openrouterApiKey: 'sk-openrouter',
    });
    expect(resolveCompanionBrain(settings)).toBe('groq');
  });

  it('auto mode falls back to Gemini when only Gemini/OpenRouter are configured', () => {
    const settings = makeSettings({
      companionBrainMode: 'auto',
      geminiApiKey: 'sk-gemini',
      openrouterApiKey: 'sk-openrouter',
    });
    expect(resolveCompanionBrain(settings)).toBe('gemini');
  });

  it('auto mode falls back to OpenRouter when only OpenRouter is configured', () => {
    const settings = makeSettings({
      companionBrainMode: 'auto',
      openrouterApiKey: 'sk-openrouter',
    });
    expect(resolveCompanionBrain(settings)).toBe('openrouter');
  });

  it('auto mode skips an empty-string key and falls through to the next provider', () => {
    const settings = makeSettings({
      companionBrainMode: 'auto',
      cerebrasApiKey: '',
      groqApiKey: '   ',
      geminiApiKey: 'sk-gemini',
    });
    expect(resolveCompanionBrain(settings)).toBe('gemini');
  });

  it('undefined companionBrainMode (older persisted settings) behaves like auto', () => {
    const settings = makeSettings({ companionBrainMode: undefined, groqApiKey: 'sk-groq' });
    expect(resolveCompanionBrain(settings)).toBe('groq');
  });
});
