/**
 * 2026-07-27 on-device finding: "今日の天気を教えて" (a Japanese question) got
 * answered in English. buildSystemPrompt()'s getShellyIdentity() picked a
 * FIXED language instruction from the app's global UI locale setting
 * (getCurrentLocale()), not from what the user actually wrote in that
 * message — same bug shape lib/agent-slot-fill.ts's detectMessageLocale doc
 * comment already documents for a different code path. Fixed to instruct
 * per-message language matching instead of a fixed language either way.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

import { buildSystemPrompt } from '@/lib/shelly-system-prompt';
import { useI18n } from '@/lib/i18n';

describe('buildSystemPrompt — per-message language instruction (2026-07-27 regression)', () => {
  afterEach(() => {
    useI18n.setState({ locale: 'en' });
  });

  it('instructs per-message language matching when the app UI locale is English', () => {
    useI18n.setState({ locale: 'en' });
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('SAME language the user\'s most recent message is written in');
    expect(prompt).not.toMatch(/reply concisely in english\.?$/im);
  });

  it('instructs per-message language matching when the app UI locale is Japanese', () => {
    useI18n.setState({ locale: 'ja' });
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('ユーザーの直近のメッセージと同じ言語で');
    expect(prompt).not.toBe('日本語で簡潔に回答してください。');
  });
});
